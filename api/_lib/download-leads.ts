import { createHmac } from "node:crypto";
import type { PoolClient } from "pg";
import {
  consumeRateLimit,
  type RateLimitResult,
} from "./rate-limit.js";
import { withPostgresTransaction } from "./postgres.js";
import {
  PAID_ACQUISITION_CONTROL_COHORT,
  PAID_ACQUISITION_EXPERIMENT_ID,
  PAID_ACQUISITION_PAID_COHORT,
} from "./paid-acquisition.js";

const DOWNLOAD_LEADS_TABLE = "public.sidestream_download_leads";
const IDEMPOTENCY_TABLE = "public.sidestream_download_lead_idempotency";
const REPLAY_RECEIPTS_TABLE = "public.sidestream_download_lead_replay_receipts";
const LEAD_HASH_SECRET_ENV = "SIDESTREAM_LEAD_HASH_SECRET";
const RATE_LIMIT_HASH_SECRET_ENV = "SIDESTREAM_RATE_LIMIT_HASH_SECRET";
const DEVELOPMENT_HASH_SECRET =
  "sidestream-download-lead-development-only-secret";

export const DEFAULT_DOWNLOAD_LEADS_PREFIX = "sidestream/download-leads";
export const MAX_DOWNLOAD_LEAD_BODY_BYTES = 8 * 1024;
export const MAX_REPLAY_BLOB_BYTES = 16 * 1024;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
export const DOWNLOAD_LEAD_RATE_LIMIT_WINDOW_SECONDS = 10 * 60;
export const DOWNLOAD_LEAD_RATE_LIMIT_PER_EMAIL = 5;
export const DOWNLOAD_LEAD_RATE_LIMIT_PER_IP = 20;

const MAX_EMAIL_LENGTH = 320;
const MAX_SOURCE_PAGE_LENGTH = 240;
const MAX_CTA_SOURCE_LENGTH = 100;
const MAX_REFERRER_LENGTH = 500;
const MAX_CAMPAIGN_FIELD_LENGTH = 100;
const DEFAULT_CTA_SOURCE = "download-email-gate";
const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_CAMPAIGN_PATTERN = /^[a-z0-9][a-z0-9._~-]*$/;
const SAFE_CTA_SOURCE_PATTERN = /^[a-z0-9][a-z0-9._:/-]*$/;

type Environment = Readonly<Record<string, string | undefined>>;
type QueryRunner = Pick<PoolClient, "query">;

export type DownloadLeadExperimentAssignment = Readonly<{
  experimentId: string;
  cohort: string;
  assignmentIdHash: string;
}>;

export type DownloadLeadContext = Readonly<{
  source: "download_email_gate";
  schemaVersion: 2;
  experimentId?: string;
  cohort?: string;
  assignmentIdHash?: string;
}>;

export type DownloadLeadPayload = Readonly<{
  email?: unknown;
  page?: unknown;
  source?: unknown;
  utmSource?: unknown;
  utmMedium?: unknown;
  utmCampaign?: unknown;
  utmContent?: unknown;
  utm_source?: unknown;
  utm_medium?: unknown;
  utm_campaign?: unknown;
  utm_content?: unknown;
}>;

export type CanonicalDownloadLead = Readonly<{
  leadKey: string;
  email: string;
  emailHash: string;
  capturedAt: string;
  firstCapturedAt: string;
  lastCapturedAt: string;
  sourcePage: string | null;
  ctaSource: string;
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  context: DownloadLeadContext;
  idempotencyKeyHash: string | null;
  submissionCount: number;
}>;

export type DownloadLeadUpsertResult = Readonly<{
  outcome: "inserted" | "updated" | "idempotent";
}>;

export type DownloadLeadCaptureResult = Readonly<{
  rateLimit: RateLimitResult;
  upsert: DownloadLeadUpsertResult | null;
}>;

export type ReplayBlobPathKind =
  | "canonical-v2"
  | "legacy-date-uuid"
  | "legacy-date-uuid-suffix"
  | "unmapped";

export class DownloadLeadValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DownloadLeadValidationError";
    this.code = code;
  }
}

export class DownloadLeadConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadLeadConfigurationError";
  }
}

export class DownloadLeadIdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key was already used for a different lead identity");
    this.name = "DownloadLeadIdempotencyConflictError";
  }
}

export function buildCanonicalDownloadLead(
  payload: DownloadLeadPayload,
  options: {
    capturedAt?: Date;
    firstCapturedAt?: Date;
    lastCapturedAt?: Date;
    referrer?: unknown;
    idempotencyKey?: string | null;
    secret?: string;
    submissionCount?: number;
    experimentAssignment?: DownloadLeadExperimentAssignment | null;
  } = {},
): CanonicalDownloadLead {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new DownloadLeadValidationError("invalid_payload", "Payload must be an object");
  }

  const email = normalizeEmail(payload.email);
  const ctaSource = normalizeCtaSource(payload.source);
  const capturedAt = options.capturedAt || new Date();
  if (!Number.isFinite(capturedAt.getTime())) {
    throw new DownloadLeadValidationError("invalid_captured_at", "Capture time is invalid");
  }
  const firstCapturedAt = options.firstCapturedAt || capturedAt;
  const lastCapturedAt = options.lastCapturedAt || capturedAt;
  if (
    !Number.isFinite(firstCapturedAt.getTime()) ||
    !Number.isFinite(lastCapturedAt.getTime()) ||
    firstCapturedAt.getTime() > lastCapturedAt.getTime()
  ) {
    throw new DownloadLeadValidationError(
      "invalid_capture_range",
      "Capture range is invalid",
    );
  }
  const secret = options.secret || getDownloadLeadHashSecret();
  const idempotencyKey = options.idempotencyKey || null;
  const submissionCount = requireBoundedSubmissionCount(options.submissionCount ?? 1);

  return Object.freeze({
    leadKey: createStableLeadKey(email, ctaSource, secret),
    email,
    emailHash: hmacDigest(secret, "email-v1", [email]),
    capturedAt: capturedAt.toISOString(),
    firstCapturedAt: firstCapturedAt.toISOString(),
    lastCapturedAt: lastCapturedAt.toISOString(),
    sourcePage: normalizeSourcePage(payload.page),
    ctaSource,
    referrer: normalizeReferrer(options.referrer),
    utmSource: normalizeCampaignField(
      readAliasedField(payload, "utmSource", "utm_source"),
      "utmSource",
    ),
    utmMedium: normalizeCampaignField(
      readAliasedField(payload, "utmMedium", "utm_medium"),
      "utmMedium",
    ),
    utmCampaign: normalizeCampaignField(
      readAliasedField(payload, "utmCampaign", "utm_campaign"),
      "utmCampaign",
    ),
    utmContent: normalizeCampaignField(
      readAliasedField(payload, "utmContent", "utm_content"),
      "utmContent",
    ),
    context: buildDownloadLeadContext(options.experimentAssignment),
    idempotencyKeyHash: idempotencyKey
      ? createIdempotencyKeyHash(idempotencyKey, secret)
      : null,
    submissionCount,
  });
}

export function normalizeEmail(value: unknown) {
  if (typeof value !== "string") {
    throw new DownloadLeadValidationError("invalid_email", "Email must be a string");
  }
  if (value.length > MAX_EMAIL_LENGTH) {
    throw new DownloadLeadValidationError("email_too_long", "Email is too long");
  }
  const email = value.trim().normalize("NFKC").toLowerCase();
  if (
    !email ||
    email.length > MAX_EMAIL_LENGTH ||
    hasControlCharacters(email) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new DownloadLeadValidationError("invalid_email", "Email is invalid");
  }
  return email;
}

export function normalizeCtaSource(value: unknown) {
  if (value === undefined || value === null || value === "") return DEFAULT_CTA_SOURCE;
  if (typeof value !== "string") {
    throw new DownloadLeadValidationError("invalid_source", "Source must be a string");
  }
  if (value.length > MAX_CTA_SOURCE_LENGTH) {
    throw new DownloadLeadValidationError("source_too_long", "Source is too long");
  }
  const source = value.trim().normalize("NFKC").toLowerCase();
  if (
    !source ||
    source.length > MAX_CTA_SOURCE_LENGTH ||
    !SAFE_CTA_SOURCE_PATTERN.test(source)
  ) {
    throw new DownloadLeadValidationError("invalid_source", "Source is invalid");
  }
  return source;
}

export function parseIdempotencyKey(value: string | string[] | undefined) {
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    throw new DownloadLeadValidationError(
      "invalid_idempotency_key",
      "Idempotency-Key must be supplied once",
    );
  }
  if (
    value.length < 1 ||
    value.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw new DownloadLeadValidationError(
      "invalid_idempotency_key",
      "Idempotency-Key is invalid",
    );
  }
  return value;
}

export function createStableLeadKey(email: string, ctaSource: string, secret: string) {
  return `lead_v1_${hmacDigest(secret, "identity-v1", [email, ctaSource])}`;
}

export function createIdempotencyKeyHash(idempotencyKey: string, secret: string) {
  return hmacDigest(secret, "idempotency-v1", [idempotencyKey]);
}

export function createReplayReceiptHash(pathname: string, secret: string) {
  const normalized = pathname.trim();
  if (!normalized || normalized.length > 1_024) {
    throw new DownloadLeadValidationError("invalid_blob_pathname", "Blob pathname is invalid");
  }
  return hmacDigest(secret, "replay-pathname-v1", [normalized]);
}

export function getDownloadLeadHashSecret(environment: Environment = process.env) {
  const configured = environment[LEAD_HASH_SECRET_ENV]?.trim() ||
    environment[RATE_LIMIT_HASH_SECRET_ENV]?.trim() || "";
  if (configured.length >= 32) return configured;
  if (configured) {
    throw new DownloadLeadConfigurationError(
      `${LEAD_HASH_SECRET_ENV} must contain at least 32 characters`,
    );
  }
  if (
    environment.NODE_ENV === "test" ||
    environment.VERCEL_ENV === "development"
  ) {
    return DEVELOPMENT_HASH_SECRET;
  }
  throw new DownloadLeadConfigurationError(
    `Missing ${LEAD_HASH_SECRET_ENV}; expected at least 32 characters`,
  );
}

export function getDownloadLeadBlobPrefix(environment: Environment = process.env) {
  const prefix = environment.SIDESTREAM_DOWNLOAD_LEADS_BLOB_PREFIX?.trim()
    .replace(/^\/+|\/+$/g, "") || DEFAULT_DOWNLOAD_LEADS_PREFIX;
  if (!prefix || prefix.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(prefix)) {
    throw new DownloadLeadConfigurationError("Download-lead Blob prefix is invalid");
  }
  return prefix;
}

export function getDeterministicLeadBlobPathname(
  leadKey: string,
  prefix = getDownloadLeadBlobPrefix(),
) {
  const digest = leadKey.startsWith("lead_v1_") ? leadKey.slice("lead_v1_".length) : "";
  if (!HEX_DIGEST_PATTERN.test(digest)) {
    throw new DownloadLeadValidationError("invalid_lead_key", "Lead key is invalid");
  }
  return `${prefix}/fallback-v2/${digest.slice(0, 2)}/${digest}.json`;
}

export function serializeFallbackLead(lead: CanonicalDownloadLead) {
  return JSON.stringify({
    schemaVersion: 2,
    leadKey: lead.leadKey,
    email: lead.email,
    emailHash: lead.emailHash,
    capturedAt: lead.capturedAt,
    firstCapturedAt: lead.firstCapturedAt,
    lastCapturedAt: lead.lastCapturedAt,
    sourcePage: lead.sourcePage,
    ctaSource: lead.ctaSource,
    referrer: lead.referrer,
    utmSource: lead.utmSource,
    utmMedium: lead.utmMedium,
    utmCampaign: lead.utmCampaign,
    utmContent: lead.utmContent,
    context: lead.context,
    idempotencyKeyHash: lead.idempotencyKeyHash,
    submissionCount: lead.submissionCount,
  });
}

export function mergeFallbackLeads(
  existing: CanonicalDownloadLead,
  incoming: CanonicalDownloadLead,
): CanonicalDownloadLead {
  if (existing.leadKey !== incoming.leadKey) {
    throw new DownloadLeadValidationError(
      "blob_identity_mismatch",
      "Fallback Blob identity is inconsistent",
    );
  }
  if (
    incoming.idempotencyKeyHash &&
    incoming.idempotencyKeyHash === existing.idempotencyKeyHash
  ) {
    return existing;
  }

  const firstCapturedAt = new Date(
    Math.min(
      Date.parse(existing.firstCapturedAt),
      Date.parse(incoming.firstCapturedAt),
    ),
  ).toISOString();
  const lastCapturedAt = new Date(
    Math.max(
      Date.parse(existing.lastCapturedAt),
      Date.parse(incoming.lastCapturedAt),
    ),
  ).toISOString();
  const latest = incoming.lastCapturedAt >= existing.lastCapturedAt
    ? incoming
    : existing;
  const earliest = incoming.firstCapturedAt < existing.firstCapturedAt
    ? incoming
    : existing;
  const later = earliest === existing ? incoming : existing;
  const submissionCount = existing.submissionCount + incoming.submissionCount;
  if (!Number.isSafeInteger(submissionCount) || submissionCount > 1_000_000) {
    throw new DownloadLeadValidationError(
      "invalid_submission_count",
      "Fallback submission count is invalid",
    );
  }
  return Object.freeze({
    ...latest,
    capturedAt: lastCapturedAt,
    firstCapturedAt,
    lastCapturedAt,
    utmSource: earliest.utmSource ?? later.utmSource,
    utmMedium: earliest.utmMedium ?? later.utmMedium,
    utmCampaign: earliest.utmCampaign ?? later.utmCampaign,
    utmContent: earliest.utmContent ?? later.utmContent,
    context: mergeDownloadLeadContexts(earliest.context, later.context),
    submissionCount,
  });
}

export function classifyLeadBlobPathname(
  pathname: string,
  prefix = getDownloadLeadBlobPrefix(),
): ReplayBlobPathKind {
  const prefixWithSlash = `${prefix.replace(/^\/+|\/+$/g, "")}/`;
  if (!pathname.startsWith(prefixWithSlash)) return "unmapped";
  const relative = pathname.slice(prefixWithSlash.length);
  if (/^fallback-v2\/[0-9a-f]{2}\/[0-9a-f]{64}\.json$/.test(relative)) {
    return "canonical-v2";
  }
  if (
    /^\d{4}-\d{2}-\d{2}\/\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i.test(relative)
  ) {
    return "legacy-date-uuid";
  }
  if (
    /^\d{4}-\d{2}-\d{2}\/\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[A-Za-z0-9_-]{6,}\.json$/i.test(relative)
  ) {
    return "legacy-date-uuid-suffix";
  }
  return "unmapped";
}

export function parseReplayBlob(
  text: string,
  options: { uploadedAt: Date; secret?: string },
): CanonicalDownloadLead {
  if (Buffer.byteLength(text, "utf8") > MAX_REPLAY_BLOB_BYTES) {
    throw new DownloadLeadValidationError("blob_too_large", "Replay Blob is too large");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DownloadLeadValidationError("invalid_blob_json", "Replay Blob is not JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DownloadLeadValidationError("invalid_blob_payload", "Replay Blob is invalid");
  }
  const record = raw as Record<string, unknown>;
  const capturedAt = parseCapturedAt(record.capturedAt, options.uploadedAt);
  const firstCapturedAt = parseCapturedAt(record.firstCapturedAt, capturedAt);
  const lastCapturedAt = parseCapturedAt(record.lastCapturedAt, capturedAt);
  const payload: DownloadLeadPayload = {
    email: record.email,
    page: record.sourcePage ?? record.page,
    source: record.ctaSource ?? record.source,
    utmSource: record.utmSource,
    utmMedium: record.utmMedium,
    utmCampaign: record.utmCampaign,
    utmContent: record.utmContent,
  };
  const lead = buildCanonicalDownloadLead(payload, {
    capturedAt,
    firstCapturedAt,
    lastCapturedAt,
    referrer: record.referrer,
    secret: options.secret,
    submissionCount: parseSubmissionCount(record.submissionCount),
    experimentAssignment: parseDownloadLeadExperimentAssignment(record.context),
  });
  const idempotencyKeyHash = typeof record.idempotencyKeyHash === "string" &&
      HEX_DIGEST_PATTERN.test(record.idempotencyKeyHash)
    ? record.idempotencyKeyHash
    : null;
  return Object.freeze({ ...lead, idempotencyKeyHash });
}

export async function captureDownloadLeadInPostgres(
  lead: CanonicalDownloadLead,
  options: {
    ipAddress: string;
    now?: Date;
    transaction?: typeof withPostgresTransaction;
    consume?: typeof consumeRateLimit;
  },
): Promise<DownloadLeadCaptureResult> {
  const transaction = options.transaction || withPostgresTransaction;
  const consume = options.consume || consumeRateLimit;
  const now = options.now || new Date(lead.capturedAt);
  return transaction(async (client) => {
    const rateLimit = await consume({
      scope: "download-lead",
      dimensions: [
        { name: "email", value: lead.email, limit: DOWNLOAD_LEAD_RATE_LIMIT_PER_EMAIL },
        {
          name: "ip",
          value: options.ipAddress || "unknown",
          limit: DOWNLOAD_LEAD_RATE_LIMIT_PER_IP,
        },
      ],
      windowSeconds: DOWNLOAD_LEAD_RATE_LIMIT_WINDOW_SECONDS,
      now,
      runner: client,
    });
    if (!rateLimit.allowed) return { rateLimit, upsert: null };
    const upsert = await upsertCanonicalDownloadLead(client, lead);
    return { rateLimit, upsert };
  });
}

export async function upsertCanonicalDownloadLead(
  runner: QueryRunner,
  lead: CanonicalDownloadLead,
  options: {
    replayReceiptHash?: string | null;
    migratedBlobPathname?: string | null;
  } = {},
): Promise<DownloadLeadUpsertResult> {
  if (options.replayReceiptHash) {
    const previouslyMigrated = options.migratedBlobPathname
      ? await hasPreviouslyMigratedBlob(runner, options.migratedBlobPathname)
      : false;
    const claimed = await claimReceipt(
      runner,
      "replay",
      options.replayReceiptHash,
      lead.leadKey,
    );
    if (!claimed || previouslyMigrated) return { outcome: "idempotent" };
  }

  if (lead.idempotencyKeyHash) {
    const claimed = await claimReceipt(
      runner,
      "idempotency",
      lead.idempotencyKeyHash,
      lead.leadKey,
    );
    if (!claimed) return { outcome: "idempotent" };
  }

  const result = await runner.query<{ inserted: boolean }>(
    `
      insert into ${DOWNLOAD_LEADS_TABLE} as lead (
        lead_key,
        email,
        email_hash,
        captured_at,
        first_captured_at,
        last_captured_at,
        submission_count,
        source_page,
        cta_source,
        referrer,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_content,
        context,
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4::timestamptz, $4::timestamptz, $5::timestamptz, $6,
        $7, $8, $9, $10, $11, $12, $13, $14::jsonb, now(), now()
      )
      on conflict (email, cta_source) do update set
        email_hash = excluded.email_hash,
        captured_at = least(lead.captured_at, excluded.captured_at),
        first_captured_at = least(lead.first_captured_at, excluded.first_captured_at),
        last_captured_at = greatest(lead.last_captured_at, excluded.last_captured_at),
        submission_count = lead.submission_count + excluded.submission_count,
        source_page = case
          when excluded.last_captured_at >= lead.last_captured_at
            then coalesce(excluded.source_page, lead.source_page)
          else lead.source_page
        end,
        referrer = case
          when excluded.last_captured_at >= lead.last_captured_at
            then coalesce(excluded.referrer, lead.referrer)
          else lead.referrer
        end,
        utm_source = case
          when excluded.utm_source is null then lead.utm_source
          when lead.utm_source is null then excluded.utm_source
          when excluded.first_captured_at < lead.first_captured_at
            then excluded.utm_source
          else lead.utm_source
        end,
        utm_medium = case
          when excluded.utm_medium is null then lead.utm_medium
          when lead.utm_medium is null then excluded.utm_medium
          when excluded.first_captured_at < lead.first_captured_at
            then excluded.utm_medium
          else lead.utm_medium
        end,
        utm_campaign = case
          when excluded.utm_campaign is null then lead.utm_campaign
          when lead.utm_campaign is null then excluded.utm_campaign
          when excluded.first_captured_at < lead.first_captured_at
            then excluded.utm_campaign
          else lead.utm_campaign
        end,
        utm_content = case
          when excluded.utm_content is null then lead.utm_content
          when lead.utm_content is null then excluded.utm_content
          when excluded.first_captured_at < lead.first_captured_at
            then excluded.utm_content
          else lead.utm_content
        end,
        context = case
          when lead.context ?& array['experimentId', 'cohort', 'assignmentIdHash']
            and (
              not excluded.context ?& array['experimentId', 'cohort', 'assignmentIdHash']
              or lead.first_captured_at <= excluded.first_captured_at
            )
            then excluded.context || lead.context
          else lead.context || excluded.context
        end,
        updated_at = now()
      returning (xmax = 0) as inserted
    `,
    [
      lead.leadKey,
      lead.email,
      lead.emailHash,
      lead.firstCapturedAt,
      lead.lastCapturedAt,
      lead.submissionCount,
      lead.sourcePage,
      lead.ctaSource,
      lead.referrer,
      lead.utmSource,
      lead.utmMedium,
      lead.utmCampaign,
      lead.utmContent,
      JSON.stringify(lead.context),
    ],
  );
  if (result.rows.length !== 1) {
    throw new Error("Download lead upsert did not return a canonical row");
  }
  return { outcome: result.rows[0].inserted ? "inserted" : "updated" };
}

async function hasPreviouslyMigratedBlob(
  runner: QueryRunner,
  pathname: string,
) {
  if (!pathname || pathname.length > 1_024) {
    throw new DownloadLeadValidationError("invalid_blob_pathname", "Blob pathname is invalid");
  }
  const existing = await runner.query<{ migrated: boolean }>(
    `
      select exists (
        select 1
        from ${DOWNLOAD_LEADS_TABLE}
        where migrated_from_blob_pathname = $1
      ) as migrated
    `,
    [pathname],
  );
  if (existing.rows.length !== 1) {
    throw new Error("Download lead migration state could not be resolved");
  }
  return existing.rows[0].migrated;
}

async function claimReceipt(
  runner: QueryRunner,
  kind: "idempotency" | "replay",
  receiptHash: string,
  leadIdentityHash: string,
) {
  if (!HEX_DIGEST_PATTERN.test(receiptHash)) {
    throw new DownloadLeadValidationError("invalid_receipt_hash", "Receipt hash is invalid");
  }
  const table = kind === "idempotency" ? IDEMPOTENCY_TABLE : REPLAY_RECEIPTS_TABLE;
  const column = kind === "idempotency" ? "idempotency_key_hash" : "blob_pathname_hash";
  const inserted = await runner.query<{ lead_identity_hash: string }>(
    `
      insert into ${table} (${column}, lead_identity_hash, created_at)
      values ($1, $2, now())
      on conflict (${column}) do nothing
      returning lead_identity_hash
    `,
    [receiptHash, leadIdentityHash],
  );
  if (inserted.rows.length === 1) return true;

  const existing = await runner.query<{ lead_identity_hash: string }>(
    `select lead_identity_hash from ${table} where ${column} = $1`,
    [receiptHash],
  );
  if (existing.rows.length !== 1) {
    throw new Error("Download lead receipt could not be resolved");
  }
  if (existing.rows[0].lead_identity_hash !== leadIdentityHash) {
    throw new DownloadLeadIdempotencyConflictError();
  }
  return false;
}

function normalizeSourcePage(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new DownloadLeadValidationError("invalid_page", "Page must be a string");
  }
  if (value.length > MAX_SOURCE_PAGE_LENGTH) {
    throw new DownloadLeadValidationError("page_too_long", "Page is too long");
  }
  if (hasControlCharacters(value)) {
    throw new DownloadLeadValidationError("invalid_page", "Page is invalid");
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed, "https://sidestream.invalid");
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("unsupported protocol");
    const pathname = parsed.pathname || "/";
    if (pathname.length > MAX_SOURCE_PAGE_LENGTH) throw new Error("pathname too long");
    return pathname;
  } catch {
    throw new DownloadLeadValidationError("invalid_page", "Page is invalid");
  }
}

function normalizeReferrer(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || hasControlCharacters(value)) return null;
  try {
    const parsed = new URL(value.trim());
    if (!/^https?:$/.test(parsed.protocol)) return null;
    const normalized = `${parsed.origin}${parsed.pathname}`;
    return normalized.length <= MAX_REFERRER_LENGTH ? normalized : null;
  } catch {
    return null;
  }
}

function normalizeCampaignField(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new DownloadLeadValidationError(
      "invalid_campaign_field",
      `${label} must be a string`,
    );
  }
  if (value.length > MAX_CAMPAIGN_FIELD_LENGTH) {
    throw new DownloadLeadValidationError(
      "campaign_field_too_long",
      `${label} is too long`,
    );
  }
  const normalized = value.trim().normalize("NFKC").toLowerCase();
  if (!normalized) return null;
  if (!SAFE_CAMPAIGN_PATTERN.test(normalized)) {
    throw new DownloadLeadValidationError(
      "invalid_campaign_field",
      `${label} is invalid`,
    );
  }
  return normalized;
}

function readAliasedField(
  payload: DownloadLeadPayload,
  camelCase: keyof DownloadLeadPayload,
  snakeCase: keyof DownloadLeadPayload,
) {
  const first = payload[camelCase];
  const second = payload[snakeCase];
  if (first !== undefined && second !== undefined && first !== second) {
    throw new DownloadLeadValidationError(
      "ambiguous_campaign_field",
      `${String(camelCase)} was supplied more than once`,
    );
  }
  return first ?? second;
}

function parseCapturedAt(value: unknown, fallback: Date) {
  if (!Number.isFinite(fallback.getTime())) {
    throw new DownloadLeadValidationError("invalid_uploaded_at", "Blob upload time is invalid");
  }
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || value.length > 40) {
    throw new DownloadLeadValidationError("invalid_captured_at", "Capture time is invalid");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new DownloadLeadValidationError("invalid_captured_at", "Capture time is invalid");
  }
  return new Date(timestamp);
}

function parseSubmissionCount(value: unknown) {
  if (value === undefined || value === null) return 1;
  return requireBoundedSubmissionCount(value);
}

function buildDownloadLeadContext(
  experimentAssignment: DownloadLeadExperimentAssignment | null | undefined,
): DownloadLeadContext {
  const assignment = parseDownloadLeadExperimentAssignment(experimentAssignment);
  return Object.freeze({
    source: "download_email_gate",
    schemaVersion: 2,
    ...(assignment || {}),
  });
}

function mergeDownloadLeadContexts(
  earliest: DownloadLeadContext,
  later: DownloadLeadContext,
) {
  return buildDownloadLeadContext(
    parseDownloadLeadExperimentAssignment(earliest) ??
      parseDownloadLeadExperimentAssignment(later),
  );
}

function parseDownloadLeadExperimentAssignment(
  value: unknown,
): DownloadLeadExperimentAssignment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.experimentId !== PAID_ACQUISITION_EXPERIMENT_ID ||
    (
      record.cohort !== PAID_ACQUISITION_CONTROL_COHORT &&
      record.cohort !== PAID_ACQUISITION_PAID_COHORT
    ) ||
    typeof record.assignmentIdHash !== "string" ||
    !HEX_DIGEST_PATTERN.test(record.assignmentIdHash)
  ) {
    return null;
  }
  return Object.freeze({
    experimentId: record.experimentId,
    cohort: record.cohort,
    assignmentIdHash: record.assignmentIdHash,
  });
}

function requireBoundedSubmissionCount(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1_000_000) {
    throw new DownloadLeadValidationError(
      "invalid_submission_count",
      "Submission count is invalid",
    );
  }
  return Number(value);
}

function hmacDigest(secret: string, domain: string, values: readonly string[]) {
  if (secret.length < 32) {
    throw new DownloadLeadConfigurationError("Download-lead HMAC secret is too short");
  }
  const hmac = createHmac("sha256", secret).update(`sidestream-download-lead:${domain}\0`);
  for (const value of values) hmac.update(value).update("\0");
  return hmac.digest("hex");
}

function hasControlCharacters(value: string) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

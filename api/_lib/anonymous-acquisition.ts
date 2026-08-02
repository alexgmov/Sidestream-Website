/** Private, server-only anonymous browser acquisition primitives. */

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { PoolClient } from "pg";

export const ANONYMOUS_ACQUISITION_ASSIGNMENT_VERSION = 1;
export const ANONYMOUS_ACQUISITION_COHORTS = ["paid", "freemium"] as const;
export const ANONYMOUS_ACQUISITION_PLATFORMS = ["macos", "windows"] as const;
export const ANONYMOUS_ACQUISITION_DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;
export const ANONYMOUS_ACQUISITION_DEFAULT_RETENTION_SECONDS = 90 * 24 * 60 * 60;

type Namespace = "production" | "test";
type Cohort = (typeof ANONYMOUS_ACQUISITION_COHORTS)[number];
type Platform = (typeof ANONYMOUS_ACQUISITION_PLATFORMS)[number];
type AttributionConfidence = "direct" | "utm" | "signed_freemium" | "signed_paid";
type ClaimState = "unclaimed" | "claimed" | "quarantined" | "expired";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOWER_UTM = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MIXED_UTM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ASSIGNMENT_CONTEXT = "sidestream-anonymous-acquisition-assignment-v1";
const CONFLICT_CONTEXT = "sidestream-anonymous-acquisition-conflict-v1";
const MAX_ASSIGNMENT_AGE_SECONDS = 30 * 24 * 60 * 60;

export class AnonymousAcquisitionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AnonymousAcquisitionError";
    this.code = code;
  }
}

export type AnonymousAcquisitionAttribution = Readonly<{
  source: string;
  medium: string | null;
  campaign: string | null;
  content: string | null;
}>;

export type AnonymousAcquisitionAssignment = Readonly<{
  experimentId: string;
  cohort: Cohort;
  issuedAt: number;
  expiresAt: number;
  signatureHash: string;
}>;

export type AnonymousAcquisitionSession = Readonly<{
  id: string;
  licenseNamespace: Namespace;
  tokenHash: string;
  firstTouch: AnonymousAcquisitionAttribution;
  experiment: Readonly<{
    experimentId: string;
    cohort: Cohort;
    signatureHash: string;
  }> | null;
  attributionConfidence: AttributionConfidence;
  firstSeenAt: string;
  firstInstallerRequestedAt: string | null;
  firstInstallerPlatform: Platform | null;
  claimState: ClaimState;
  claimedProfileId: string | null;
  claimedAt: string | null;
  quarantinedAt: string | null;
  expiresAt: string;
  retainedUntil: string;
}>;

type StoredSession = Readonly<{
  id: string;
  license_namespace: Namespace;
  token_hash: string;
  first_touch_source: string;
  first_touch_medium: string | null;
  first_touch_campaign: string | null;
  first_touch_content: string | null;
  experiment_id: string | null;
  experiment_cohort: Cohort | null;
  experiment_signature_hash: string | null;
  attribution_confidence: AttributionConfidence;
  first_seen_at: Date | string;
  first_installer_requested_at: Date | string | null;
  first_installer_platform: Platform | null;
  claim_state: ClaimState;
  claimed_profile_id: string | null;
  claimed_at: Date | string | null;
  quarantined_at: Date | string | null;
  expires_at: Date | string;
  retained_until: Date | string;
}>;

type Transaction = <T>(callback: (client: PoolClient) => Promise<T>) => Promise<T>;
type Dependencies = Readonly<{
  transaction?: Transaction;
  namespace?: Namespace;
}>;

export function generateAnonymousAcquisitionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashAnonymousAcquisitionToken(token: unknown): string {
  if (typeof token !== "string" || !TOKEN.test(token)) {
    fail("invalid_token", "Anonymous acquisition token must be 256-bit base64url.");
  }
  return sha256(token);
}

/**
 * Accepts a deliberately narrow UTM representation. Missing source is direct;
 * a source, medium, campaign, or content outside the 64-character taxonomy is
 * rejected instead of being truncated or stored approximately.
 */
export function normalizeAnonymousAcquisitionAttribution(
  input: unknown = {},
): AnonymousAcquisitionAttribution {
  assertPlainObject(input, "invalid_attribution");
  assertOnlyKeys(input, new Set(["source", "medium", "campaign", "content"]), "invalid_attribution");
  const source = optionalBounded(input.source, LOWER_UTM, "source") ?? "direct";
  const medium = optionalBounded(input.medium, LOWER_UTM, "medium");
  const campaign = optionalBounded(input.campaign, MIXED_UTM, "campaign");
  const content = optionalBounded(input.content, MIXED_UTM, "content");
  return Object.freeze({ source, medium, campaign, content });
}

export function createAnonymousAcquisitionAssignment(input: Readonly<{
  experimentId: string;
  cohort: Cohort;
  issuedAt: number | Date;
  expiresAt: number | Date;
  secret: string | Uint8Array;
}>): string {
  const experimentId = boundedExperimentId(input.experimentId);
  const cohort = assertCohort(input.cohort);
  const issuedAt = epochSeconds(input.issuedAt, "issuedAt");
  const expiresAt = epochSeconds(input.expiresAt, "expiresAt");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_ASSIGNMENT_AGE_SECONDS) {
    fail("invalid_assignment", "Experiment assignment lifetime is invalid.");
  }
  const payload = Buffer.from(JSON.stringify({
    v: ANONYMOUS_ACQUISITION_ASSIGNMENT_VERSION,
    experimentId,
    cohort,
    issuedAt,
    expiresAt,
  }), "utf8").toString("base64url");
  const signature = createHmac("sha256", secretBuffer(input.secret))
    .update(`${ASSIGNMENT_CONTEXT}:${payload}`, "utf8")
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyAnonymousAcquisitionAssignment(
  value: unknown,
  options: Readonly<{
    secret: string | Uint8Array;
    now?: number | Date;
  }>,
): AnonymousAcquisitionAssignment {
  if (typeof value !== "string" || value.length > 512) {
    fail("invalid_assignment", "Experiment assignment is invalid.");
  }
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra || !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
    fail("invalid_assignment", "Experiment assignment is invalid.");
  }
  const expected = createHmac("sha256", secretBuffer(options.secret))
    .update(`${ASSIGNMENT_CONTEXT}:${payload}`, "utf8")
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "base64url");
  } catch {
    fail("invalid_assignment", "Experiment assignment is invalid.");
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    fail("invalid_assignment", "Experiment assignment signature is invalid.");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    fail("invalid_assignment", "Experiment assignment payload is invalid.");
  }
  assertPlainObject(decoded, "invalid_assignment");
  assertOnlyKeys(
    decoded,
    new Set(["v", "experimentId", "cohort", "issuedAt", "expiresAt"]),
    "invalid_assignment",
  );
  if (decoded.v !== ANONYMOUS_ACQUISITION_ASSIGNMENT_VERSION) {
    fail("invalid_assignment", "Experiment assignment version is invalid.");
  }
  const experimentId = boundedExperimentId(decoded.experimentId);
  const cohort = assertCohort(decoded.cohort);
  const issuedAt = epochSeconds(decoded.issuedAt, "issuedAt");
  const expiresAt = epochSeconds(decoded.expiresAt, "expiresAt");
  const now = epochSeconds(options.now ?? Math.floor(Date.now() / 1000), "now");
  if (
    issuedAt > now || expiresAt <= now || expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_ASSIGNMENT_AGE_SECONDS
  ) {
    fail("invalid_assignment", "Experiment assignment is expired or not yet valid.");
  }
  return Object.freeze({
    experimentId,
    cohort,
    issuedAt,
    expiresAt,
    signatureHash: sha256(`anonymous-acquisition-signature:${signature}`),
  });
}

export async function createAnonymousAcquisitionSession(
  input: Readonly<{
    token: string;
    attribution?: unknown;
    assignment?: string | null;
    assignmentSecret?: string | Uint8Array;
    firstSeenAt?: Date | string;
    expiresAt?: Date | string;
    retainedUntil?: Date | string;
  }>,
  dependencies: Dependencies = {},
): Promise<AnonymousAcquisitionSession> {
  assertPlainObject(input);
  const tokenHash = hashAnonymousAcquisitionToken(input.token);
  const firstTouch = normalizeAnonymousAcquisitionAttribution(input.attribution ?? {});
  const firstSeenAt = timestamp(input.firstSeenAt ?? new Date(), "firstSeenAt");
  const assignment = input.assignment == null
    ? null
    : verifyAnonymousAcquisitionAssignment(input.assignment, {
        secret: input.assignmentSecret ?? "",
        now: firstSeenAt,
      });
  if (input.assignment == null && input.assignmentSecret !== undefined) {
    fail("invalid_assignment", "Assignment secret was supplied without an assignment.");
  }
  const expiresAt = timestamp(
    input.expiresAt ?? new Date(firstSeenAt.getTime() + ANONYMOUS_ACQUISITION_DEFAULT_TTL_SECONDS * 1000),
    "expiresAt",
  );
  const retainedUntil = timestamp(
    input.retainedUntil ?? new Date(firstSeenAt.getTime() + ANONYMOUS_ACQUISITION_DEFAULT_RETENTION_SECONDS * 1000),
    "retainedUntil",
  );
  if (
    expiresAt <= firstSeenAt || retainedUntil < expiresAt ||
    retainedUntil.getTime() - firstSeenAt.getTime() > 180 * 24 * 60 * 60 * 1000
  ) {
    fail("invalid_retention", "Anonymous acquisition expiration or retention is invalid.");
  }

  return withTransaction(dependencies, async (client, namespace) => {
    await advisoryLock(client, namespace, tokenHash);
    let existing = await selectSession(client, namespace, tokenHash);
    if (!existing) {
      const inserted = await client.query<StoredSession>(`${SESSION_COLUMNS}
        insert into public.sidestream_anonymous_acquisition_sessions (
          license_namespace, token_hash, first_touch_source, first_touch_medium,
          first_touch_campaign, first_touch_content, experiment_id,
          experiment_cohort, experiment_signature_hash, attribution_confidence,
          first_seen_at, expires_at, retained_until
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        returning *
      `, [
        namespace, tokenHash, firstTouch.source, firstTouch.medium,
        firstTouch.campaign, firstTouch.content, assignment?.experimentId ?? null,
        assignment?.cohort ?? null, assignment?.signatureHash ?? null,
        confidence(firstTouch, assignment), firstSeenAt, expiresAt, retainedUntil,
      ]);
      return mapSession(requiredRow(inserted.rows[0]));
    }

    const conflicts = sessionConflicts(existing, firstTouch, assignment);
    if (conflicts.length > 0) {
      for (const conflictType of conflicts) {
        await quarantine(client, existing, conflictType, conflictEvidence({ firstTouch, assignment }));
      }
      existing = requiredRow(await selectSession(client, namespace, tokenHash));
      return mapSession(existing);
    }

    const updated = await client.query<StoredSession>(`
      update public.sidestream_anonymous_acquisition_sessions
      set first_touch_medium = coalesce(first_touch_medium, $3),
        first_touch_campaign = coalesce(first_touch_campaign, $4),
        first_touch_content = coalesce(first_touch_content, $5),
        experiment_id = coalesce(experiment_id, $6),
        experiment_cohort = coalesce(experiment_cohort, $7),
        experiment_signature_hash = coalesce(experiment_signature_hash, $8),
        attribution_confidence = case
          when experiment_id is null and $6 is not null then $9
          else attribution_confidence
        end,
        updated_at = transaction_timestamp()
      where license_namespace = $1 and token_hash = $2
      returning *
    `, [
      namespace, tokenHash, firstTouch.medium, firstTouch.campaign, firstTouch.content,
      assignment?.experimentId ?? null, assignment?.cohort ?? null,
      assignment?.signatureHash ?? null, confidence(firstTouch, assignment),
    ]);
    return mapSession(requiredRow(updated.rows[0]));
  });
}

export async function recordAnonymousAcquisitionInstallerRequest(
  input: Readonly<{ token: string; platform: Platform; requestedAt?: Date | string }>,
  dependencies: Dependencies = {},
): Promise<AnonymousAcquisitionSession> {
  assertPlainObject(input);
  const tokenHash = hashAnonymousAcquisitionToken(input.token);
  const platform = assertPlatform(input.platform);
  const requestedAt = timestamp(input.requestedAt ?? new Date(), "requestedAt");
  return withTransaction(dependencies, async (client, namespace) => {
    await advisoryLock(client, namespace, tokenHash);
    const existing = await selectSession(client, namespace, tokenHash);
    if (!existing) fail("session_not_found", "Anonymous acquisition session was not found.");
    if (existing.claim_state === "quarantined") return mapSession(existing);
    if (requestedAt < timestamp(existing.first_seen_at, "firstSeenAt")) {
      fail("invalid_request_time", "Installer request predates the acquisition session.");
    }
    if (requestedAt >= timestamp(existing.expires_at, "expiresAt")) {
      fail("session_expired", "Anonymous acquisition session has expired.");
    }
    const result = await client.query<StoredSession>(`
      update public.sidestream_anonymous_acquisition_sessions
      set first_installer_requested_at = coalesce(first_installer_requested_at, $3),
        first_installer_platform = coalesce(first_installer_platform, $4),
        updated_at = transaction_timestamp()
      where license_namespace = $1 and token_hash = $2
      returning *
    `, [namespace, tokenHash, requestedAt, platform]);
    return mapSession(requiredRow(result.rows[0]));
  });
}

export async function claimAnonymousAcquisitionSession(
  input: Readonly<{ token: string; profileId: string; claimedAt?: Date | string }>,
  dependencies: Dependencies = {},
): Promise<AnonymousAcquisitionSession> {
  assertPlainObject(input);
  const tokenHash = hashAnonymousAcquisitionToken(input.token);
  const profileId = assertUuid(input.profileId, "profileId");
  const claimedAt = timestamp(input.claimedAt ?? new Date(), "claimedAt");
  return withTransaction(dependencies, async (client, namespace) => {
    await advisoryLock(client, namespace, tokenHash);
    const existing = await selectSession(client, namespace, tokenHash);
    if (!existing) fail("session_not_found", "Anonymous acquisition session was not found.");
    if (existing.claimed_profile_id && existing.claimed_profile_id !== profileId) {
      await quarantine(client, existing, "profile_claim", conflictEvidence({ profileId }));
      return mapSession(requiredRow(await selectSession(client, namespace, tokenHash)));
    }
    if (existing.claim_state === "quarantined" || existing.claimed_profile_id === profileId) {
      return mapSession(existing);
    }
    if (claimedAt < timestamp(existing.first_seen_at, "firstSeenAt")) {
      fail("invalid_claim_time", "Claim predates the acquisition session.");
    }
    if (claimedAt >= timestamp(existing.expires_at, "expiresAt")) {
      fail("session_expired", "Anonymous acquisition session has expired.");
    }
    const profile = await client.query<{ id: string; merged_into: string | null }>(`
      select id, merged_into
      from public.sidestream_customer_profiles
      where license_namespace = $1 and id = $2
      for share
    `, [namespace, profileId]);
    if (!profile.rows[0] || profile.rows[0].merged_into !== null) {
      fail("profile_not_found", "A live profile was not found in the trusted namespace.");
    }
    const result = await client.query<StoredSession>(`
      update public.sidestream_anonymous_acquisition_sessions
      set claim_state = 'claimed', claimed_profile_id = $3, claimed_at = $4,
        updated_at = transaction_timestamp()
      where license_namespace = $1 and token_hash = $2
      returning *
    `, [namespace, tokenHash, profileId, claimedAt]);
    return mapSession(requiredRow(result.rows[0]));
  });
}

const SESSION_COLUMNS = "";

async function selectSession(
  client: PoolClient,
  namespace: Namespace,
  tokenHash: string,
): Promise<StoredSession | null> {
  const result = await client.query<StoredSession>(`
    select * from public.sidestream_anonymous_acquisition_sessions
    where license_namespace = $1 and token_hash = $2
    for update
  `, [namespace, tokenHash]);
  return result.rows[0] ?? null;
}

function sessionConflicts(
  row: StoredSession,
  firstTouch: AnonymousAcquisitionAttribution,
  assignment: AnonymousAcquisitionAssignment | null,
): Array<"first_touch" | "experiment_assignment"> {
  const conflicts: Array<"first_touch" | "experiment_assignment"> = [];
  if (
    row.first_touch_source !== firstTouch.source ||
    differs(row.first_touch_medium, firstTouch.medium) ||
    differs(row.first_touch_campaign, firstTouch.campaign) ||
    differs(row.first_touch_content, firstTouch.content)
  ) conflicts.push("first_touch");
  if (assignment && row.experiment_id !== null && (
    row.experiment_id !== assignment.experimentId ||
    row.experiment_cohort !== assignment.cohort
  )) conflicts.push("experiment_assignment");
  return conflicts;
}

function differs(existing: string | null, incoming: string | null): boolean {
  return existing !== null && incoming !== null && existing !== incoming;
}

async function quarantine(
  client: PoolClient,
  session: StoredSession,
  conflictType: "first_touch" | "experiment_assignment" | "profile_claim",
  evidenceHash: string,
): Promise<void> {
  await client.query(`
    insert into public.sidestream_anonymous_acquisition_conflicts (
      session_id, license_namespace, conflict_type, evidence_hash
    ) values ($1, $2, $3, $4)
    on conflict (session_id, conflict_type, evidence_hash) do nothing
  `, [session.id, session.license_namespace, conflictType, evidenceHash]);
  await client.query(`
    update public.sidestream_anonymous_acquisition_sessions
    set claim_state = 'quarantined',
      quarantined_at = coalesce(quarantined_at, transaction_timestamp()),
      updated_at = transaction_timestamp()
    where id = $1 and license_namespace = $2
  `, [session.id, session.license_namespace]);
}

function conflictEvidence(value: unknown): string {
  return sha256(`${CONFLICT_CONTEXT}:${stableJson(value)}`);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function confidence(
  attribution: AnonymousAcquisitionAttribution,
  assignment: AnonymousAcquisitionAssignment | null,
): AttributionConfidence {
  if (assignment?.cohort === "paid") return "signed_paid";
  if (assignment?.cohort === "freemium") return "signed_freemium";
  return attribution.source === "direct" && attribution.medium === null &&
    attribution.campaign === null && attribution.content === null ? "direct" : "utm";
}

function mapSession(row: StoredSession): AnonymousAcquisitionSession {
  const experiment = row.experiment_id === null ? null : Object.freeze({
    experimentId: row.experiment_id,
    cohort: row.experiment_cohort as Cohort,
    signatureHash: row.experiment_signature_hash as string,
  });
  return Object.freeze({
    id: row.id,
    licenseNamespace: row.license_namespace,
    tokenHash: row.token_hash,
    firstTouch: Object.freeze({
      source: row.first_touch_source,
      medium: row.first_touch_medium,
      campaign: row.first_touch_campaign,
      content: row.first_touch_content,
    }),
    experiment,
    attributionConfidence: row.attribution_confidence,
    firstSeenAt: iso(row.first_seen_at),
    firstInstallerRequestedAt: nullableIso(row.first_installer_requested_at),
    firstInstallerPlatform: row.first_installer_platform,
    claimState: row.claim_state,
    claimedProfileId: row.claimed_profile_id,
    claimedAt: nullableIso(row.claimed_at),
    quarantinedAt: nullableIso(row.quarantined_at),
    expiresAt: iso(row.expires_at),
    retainedUntil: iso(row.retained_until),
  });
}

async function advisoryLock(client: PoolClient, namespace: Namespace, tokenHash: string) {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `sidestream_anonymous_acquisition:${namespace}:${tokenHash}`,
  ]);
}

async function withTransaction<T>(
  dependencies: Dependencies,
  callback: (client: PoolClient, namespace: Namespace) => Promise<T>,
): Promise<T> {
  if (dependencies.transaction || dependencies.namespace) {
    if (!dependencies.transaction || !isNamespace(dependencies.namespace)) {
      throw new Error("Anonymous acquisition test dependencies require transaction and namespace together");
    }
    return dependencies.transaction((client) => callback(client, dependencies.namespace as Namespace));
  }
  const { resolveLicenseEnvironment } = await import("./license-environment.js");
  const environment = resolveLicenseEnvironment({ serverEnv: process.env });
  if (!environment) throw new Error("Anonymous acquisition requires a trusted server-resolved license environment");
  const { getPostgresPool } = await import("./postgres.js");
  const pool = getPostgresPool({
    connectionString: environment.database.connectionString,
    environmentVariable: environment.database.environmentVariable,
    pooled: true,
  });
  const client = await pool.connect();
  try {
    await client.query("begin isolation level read committed");
    try {
      const result = await callback(client, environment.namespace);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  } finally {
    client.release();
  }
}

function assertPlainObject(value: unknown, code = "invalid_request"): asserts value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code, "Expected a plain object.");
  }
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: Set<string>, code: string) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(code, `Unexpected field: ${key}.`);
}

function optionalBounded(value: unknown, pattern: RegExp, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !pattern.test(value)) fail("invalid_attribution", `Invalid ${field}.`);
  return value;
}

function boundedExperimentId(value: unknown): string {
  if (typeof value !== "string" || !LOWER_UTM.test(value)) fail("invalid_assignment", "Experiment id is invalid.");
  return value;
}

function assertCohort(value: unknown): Cohort {
  if (value !== "paid" && value !== "freemium") fail("invalid_assignment", "Experiment cohort is invalid.");
  return value;
}

function assertPlatform(value: unknown): Platform {
  if (value !== "macos" && value !== "windows") fail("invalid_platform", "Installer platform is invalid.");
  return value;
}

function assertUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) fail("invalid_claim", `${field} must be a UUID.`);
  return value;
}

function secretBuffer(value: string | Uint8Array): Buffer {
  const secret = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value ?? []);
  if (secret.length < 32) fail("assignment_unavailable", "Experiment assignment signing is unavailable.");
  return secret;
}

function epochSeconds(value: unknown, field: string): number {
  const result = value instanceof Date ? Math.floor(value.getTime() / 1000) : value;
  if (!Number.isSafeInteger(result) || (result as number) < 0) fail("invalid_assignment", `${field} is invalid.`);
  return result as number;
}

function timestamp(value: unknown, field: string): Date {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value as string);
  if (!Number.isFinite(result.getTime())) fail("invalid_timestamp", `${field} is invalid.`);
  return result;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function isNamespace(value: unknown): value is Namespace {
  return value === "production" || value === "test";
}

function requiredRow<T>(value: T | null | undefined): T {
  if (!value) throw new Error("Anonymous acquisition database row was not returned");
  return value;
}

function fail(code: string, message: string): never {
  throw new AnonymousAcquisitionError(code, message);
}

export const ANONYMOUS_ACQUISITION_PRIVACY_EXCLUSIONS = Object.freeze([
  "ip", "userAgent", "email", "installIdHash", "installerReceiptHash",
  "telemetryPayload", "browserToken",
]);

export function isAnonymousAcquisitionDigest(value: unknown): value is string {
  return typeof value === "string" && LOWER_HEX_64.test(value);
}

/** Private, server-only canonical acquisition root and stage-ledger primitives. */

import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

export const ACQUISITION_STAGES = Object.freeze([
  "landing_observed",
  "email_handoff_created",
  "installer_requested",
  "installation_claimed",
  "authentication_completed",
  "checkout_started",
  "checkout_completed",
  "payment_settled",
  "refunded",
  "disputed",
] as const);

export const ACQUISITION_STAGE_COUNTING_GRAINS = Object.freeze({
  landing_observed: "acquisition",
  email_handoff_created: "delivery_handoff",
  installer_requested: "installer_request",
  installation_claimed: "installation",
  authentication_completed: "authentication",
  checkout_started: "checkout_intent",
  checkout_completed: "checkout_session",
  payment_settled: "payment",
  refunded: "refund",
  disputed: "dispute",
} as const);

export const ACQUISITION_TRUSTED_DELIVERY_EVIDENCE = Object.freeze([
  "website_entry",
  "signed_email_handoff",
  "secure_share_handoff",
  "installer_redirect",
  "authenticated_account",
  "checkout_intent",
  "stripe_checkout_session",
  "verified_installation_claim",
] as const);

export const ACQUISITION_PRIVACY_EXCLUSIONS = Object.freeze([
  "ip",
  "userAgent",
  "cookie",
  "email",
  "stripePayload",
  "telemetryPayload",
  "installHash",
  "receiptHash",
]);

type Namespace = "production" | "test";
export type AcquisitionStage = (typeof ACQUISITION_STAGES)[number];
export type AcquisitionCountingGrain =
  (typeof ACQUISITION_STAGE_COUNTING_GRAINS)[AcquisitionStage];
type CountingGrain = AcquisitionCountingGrain;
type TrustedDeliveryEvidence = (typeof ACQUISITION_TRUSTED_DELIVERY_EVIDENCE)[number];
type EntryChannel =
  | "website"
  | "manychat_email"
  | "facebook_lead_form"
  | "installer"
  | "account"
  | "checkout";
type ExternalReferrerCategory =
  | "search" | "social" | "messaging" | "video" | "community" | "publisher" | "other_external";
type AttributionConfidence =
  | "exact_sidestream_entry" | "exact_trusted_delivery"
  | "missing_internal_linkage" | "historical_unlinked";
type IntegrityState = "intact" | "missing_internal_linkage" | "historical_unlinked" | "quarantined";

type Transaction = <T>(callback: (client: PoolClient) => Promise<T>) => Promise<T>;
type Dependencies = Readonly<{ transaction?: Transaction; namespace?: Namespace }>;

type StoredAcquisition = Readonly<{
  id: string;
  license_namespace: Namespace;
  first_observed_source: string;
  first_observed_medium: string | null;
  first_observed_campaign: string | null;
  first_observed_content_creative: string | null;
  entry_channel: EntryChannel;
  first_observed_at: Date | string;
  external_referrer_category: ExternalReferrerCategory | null;
  experiment_id: string | null;
  experiment_cohort: string | null;
  attribution_confidence: AttributionConfidence;
  integrity_state: IntegrityState;
  trusted_delivery_evidence: TrustedDeliveryEvidence[];
}>;

type StoredStage = Readonly<{
  id: string;
  acquisition_id: string;
  license_namespace: Namespace;
  stage: AcquisitionStage;
  counting_grain: CountingGrain;
  deduplication_key: string;
  occurred_at: Date | string;
  recorded_at: Date | string;
}>;

export type CanonicalAcquisition = Readonly<{
  id: string;
  licenseNamespace: Namespace;
  firstObserved: Readonly<{
    source: string;
    medium: string | null;
    campaign: string | null;
    contentCreative: string | null;
    at: string;
    externalReferrerCategory: ExternalReferrerCategory | null;
  }>;
  entryChannel: EntryChannel;
  experiment: Readonly<{ id: string; cohort: string }> | null;
  attributionConfidence: AttributionConfidence;
  integrityState: IntegrityState;
  trustedDeliveryEvidence: readonly TrustedDeliveryEvidence[];
}>;

export type AcquisitionStageRecord = Readonly<{
  id: string;
  acquisitionId: string;
  licenseNamespace: Namespace;
  stage: AcquisitionStage;
  countingGrain: CountingGrain;
  deduplicationKey: string;
  occurredAt: string;
  recordedAt: string;
  ownerConflict: boolean;
}>;

export type AcquisitionStageSummary = Readonly<{
  timestamps: Readonly<Record<AcquisitionStage, string | null>>;
  counts: Readonly<Record<AcquisitionStage, string>>;
  missingStages: readonly AcquisitionStage[];
  conflictingStages: readonly string[];
}>;

/** Builds the privacy-safe operator projection without exposing dedupe keys. */
export function summarizeAcquisitionStages(
  stages: readonly Readonly<{
    stage: AcquisitionStage;
    occurredAt: Date | string;
  }>[],
  conflictTypes: readonly string[] = [],
): AcquisitionStageSummary {
  const timestamps = Object.fromEntries(
    ACQUISITION_STAGES.map((stage) => [stage, null]),
  ) as Record<AcquisitionStage, string | null>;
  const counts = Object.fromEntries(
    ACQUISITION_STAGES.map((stage) => [stage, "0"]),
  ) as Record<AcquisitionStage, string>;

  for (const record of stages) {
    const stage = assertStage(record.stage);
    const occurredAt = iso(timestamp(record.occurredAt, "occurredAt"));
    const current = timestamps[stage];
    if (current === null || occurredAt < current) timestamps[stage] = occurredAt;
    counts[stage] = (BigInt(counts[stage]) + 1n).toString();
  }

  return Object.freeze({
    timestamps: Object.freeze(timestamps),
    counts: Object.freeze(counts),
    missingStages: Object.freeze(
      ACQUISITION_STAGES.filter((stage) => timestamps[stage] === null),
    ),
    conflictingStages: Object.freeze([...new Set(conflictTypes.map((type) =>
      type === "stage_deduplication_owner" ? "stage_owner_conflict" : type
    ))].sort()),
  });
}

export class AcquisitionIntegrityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AcquisitionIntegrityError";
    this.code = code;
  }
}

const LOWER_DIMENSION = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MIXED_DIMENSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONFLICT_CONTEXT = "sidestream-acquisition-integrity-conflict-v1";
const DEDUPLICATION_CONTEXT = "sidestream-acquisition-stage-v1";

export function generateAcquisitionId(): string {
  return randomUUID();
}

export function deriveAcquisitionStageDeduplicationKey(input: Readonly<{
  licenseNamespace: Namespace;
  stage: AcquisitionStage;
  stableServerReference: string;
}>): string {
  const namespace = assertNamespace(input.licenseNamespace);
  const stage = assertStage(input.stage);
  const reference = stableServerReference(input.stableServerReference);
  return sha256(`${DEDUPLICATION_CONTEXT}:${namespace}:${stage}:${reference}`);
}

export async function createCanonicalAcquisitionRoot(input: Readonly<{
  acquisitionId?: string;
  firstObservedAt: Date | string;
  landingDeduplicationReference: string;
  source?: string;
  medium?: string | null;
  campaign?: string | null;
  contentCreative?: string | null;
  entryChannel?: EntryChannel;
  externalReferrerCategory?: ExternalReferrerCategory | null;
  experiment?: Readonly<{ id: string; cohort: string }> | null;
  attributionConfidence?: AttributionConfidence;
  integrityState?: Exclude<IntegrityState, "quarantined">;
  trustedDeliveryEvidence?: readonly TrustedDeliveryEvidence[];
  recordLandingObserved?: boolean;
}>, dependencies: Dependencies = {}): Promise<CanonicalAcquisition> {
  assertPlainObject(input);
  assertOnlyKeys(input, new Set([
    "acquisitionId", "firstObservedAt", "landingDeduplicationReference",
    "source", "medium", "campaign", "contentCreative", "entryChannel",
    "externalReferrerCategory", "experiment", "attributionConfidence",
    "integrityState", "trustedDeliveryEvidence", "recordLandingObserved",
  ]));
  const acquisitionId = input.acquisitionId === undefined
    ? generateAcquisitionId()
    : assertUuid(input.acquisitionId, "acquisitionId");
  const firstObservedAt = timestamp(input.firstObservedAt, "firstObservedAt");
  const source = bounded(input.source ?? "website_direct_or_unknown", LOWER_DIMENSION, "source");
  const medium = optionalBounded(input.medium, LOWER_DIMENSION, "medium");
  const campaign = optionalBounded(input.campaign, MIXED_DIMENSION, "campaign");
  const contentCreative = optionalBounded(input.contentCreative, MIXED_DIMENSION, "contentCreative");
  const entryChannel = assertEntryChannel(input.entryChannel ?? "website");
  const externalReferrerCategory = assertExternalReferrerCategory(
    input.externalReferrerCategory ?? null,
  );
  const experiment = normalizeExperiment(input.experiment ?? null);
  const attributionConfidence = assertAttributionConfidence(
    input.attributionConfidence ?? "exact_sidestream_entry",
  );
  const integrityState = assertInitialIntegrityState(input.integrityState ?? "intact");
  const trustedDeliveryEvidence = normalizeDeliveryEvidence(
    input.trustedDeliveryEvidence ?? ["website_entry"],
  );
  const recordLandingObserved = input.recordLandingObserved ?? true;
  if (typeof recordLandingObserved !== "boolean") {
    fail("invalid_request", "recordLandingObserved must be boolean.");
  }
  stableServerReference(input.landingDeduplicationReference);

  if (source === "website_direct_or_unknown" && (
    entryChannel !== "website" || externalReferrerCategory !== null ||
    attributionConfidence !== "exact_sidestream_entry" || integrityState !== "intact"
  )) {
    fail("invalid_first_touch", "Unknown external origin must remain a truthful exact Sidestream website entry.");
  }
  if (
    (attributionConfidence === "missing_internal_linkage" && integrityState !== "missing_internal_linkage") ||
    (attributionConfidence === "historical_unlinked" && integrityState !== "historical_unlinked")
  ) {
    fail("invalid_integrity", "Missing and historical linkage classifications must be explicit and aligned.");
  }

  return withTransaction(dependencies, async (client, namespace) => {
    await advisoryLock(client, `root:${acquisitionId}`);
    await client.query(`
      insert into public.sidestream_acquisitions (
        id, license_namespace, first_observed_source, first_observed_medium,
        first_observed_campaign, first_observed_content_creative, entry_channel,
        first_observed_at, external_referrer_category, experiment_id,
        experiment_cohort, attribution_confidence, integrity_state,
        trusted_delivery_evidence
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      on conflict (id) do nothing
    `, [
      acquisitionId, namespace, source, medium, campaign, contentCreative,
      entryChannel, firstObservedAt, externalReferrerCategory,
      experiment?.id ?? null, experiment?.cohort ?? null,
      attributionConfidence, integrityState, trustedDeliveryEvidence,
    ]);
    let stored = await selectAcquisitionById(client, acquisitionId);
    if (!stored) fail("acquisition_not_found", "Canonical acquisition was not returned.");
    if (stored.license_namespace !== namespace) {
      fail("namespace_conflict", "Acquisition IDs cannot cross trusted license namespaces.");
    }

    const incoming = {
      source, medium, campaign, contentCreative, entryChannel,
      firstObservedAt: firstObservedAt.toISOString(), externalReferrerCategory,
      experiment, attributionConfidence, integrityState,
    };
    if (!sameFirstTouch(stored, incoming)) {
      await quarantine(client, stored, "root_first_touch", conflictEvidence(incoming));
      stored = requiredRow(await selectAcquisitionById(client, acquisitionId));
    }

    if (recordLandingObserved) {
      await recordStageWithClient(client, namespace, {
        acquisitionId,
        stage: "landing_observed",
        stableServerReference: input.landingDeduplicationReference,
        occurredAt: firstObservedAt,
      });
    }
    return mapAcquisition(stored);
  });
}

export async function addTrustedDeliveryEvidence(input: Readonly<{
  acquisitionId: string;
  evidence: TrustedDeliveryEvidence;
}>, dependencies: Dependencies = {}): Promise<CanonicalAcquisition> {
  assertPlainObject(input);
  assertOnlyKeys(input, new Set(["acquisitionId", "evidence"]));
  const acquisitionId = assertUuid(input.acquisitionId, "acquisitionId");
  const evidence = assertDeliveryEvidence(input.evidence);
  return withTransaction(dependencies, async (client, namespace) => {
    await advisoryLock(client, `root:${acquisitionId}`);
    const result = await client.query<StoredAcquisition>(`
      update public.sidestream_acquisitions
      set trusted_delivery_evidence = case
          when $3 = any(trusted_delivery_evidence) then trusted_delivery_evidence
          else array_append(trusted_delivery_evidence, $3)
        end,
        updated_at = case
          when $3 = any(trusted_delivery_evidence) then updated_at
          else transaction_timestamp()
        end
      where id = $1 and license_namespace = $2
      returning *
    `, [acquisitionId, namespace, evidence]);
    return mapAcquisition(requiredRow(result.rows[0]));
  });
}

export async function findCanonicalAcquisition(
  acquisitionId: string,
  dependencies: Dependencies = {},
): Promise<CanonicalAcquisition | null> {
  const normalizedId = assertUuid(acquisitionId, "acquisitionId");
  return withTransaction(dependencies, async (client, namespace) => {
    const result = await client.query<StoredAcquisition>(`
      select * from public.sidestream_acquisitions
      where id = $1 and license_namespace = $2
      for share
    `, [normalizedId, namespace]);
    return result.rows[0] ? mapAcquisition(result.rows[0]) : null;
  });
}

export async function requireCanonicalAcquisition(
  acquisitionId: string,
  dependencies: Dependencies = {},
): Promise<CanonicalAcquisition> {
  const acquisition = await findCanonicalAcquisition(acquisitionId, dependencies);
  if (!acquisition) {
    fail(
      "acquisition_not_found",
      "Canonical acquisition was not found in the trusted namespace.",
    );
  }
  return acquisition;
}

export async function recordAcquisitionStage(input: Readonly<{
  acquisitionId: string;
  stage: AcquisitionStage;
  stableServerReference: string;
  occurredAt: Date | string;
}>, dependencies: Dependencies = {}): Promise<AcquisitionStageRecord> {
  assertPlainObject(input);
  assertOnlyKeys(input, new Set([
    "acquisitionId", "stage", "stableServerReference", "occurredAt",
  ]));
  const normalized = {
    acquisitionId: assertUuid(input.acquisitionId, "acquisitionId"),
    stage: assertStage(input.stage),
    stableServerReference: stableServerReference(input.stableServerReference),
    occurredAt: timestamp(input.occurredAt, "occurredAt"),
  };
  return withTransaction(dependencies, (client, namespace) =>
    recordStageWithClient(client, namespace, normalized));
}

async function recordStageWithClient(
  client: PoolClient,
  namespace: Namespace,
  input: Readonly<{
    acquisitionId: string;
    stage: AcquisitionStage;
    stableServerReference: string;
    occurredAt: Date;
  }>,
): Promise<AcquisitionStageRecord> {
  const deduplicationKey = deriveAcquisitionStageDeduplicationKey({
    licenseNamespace: namespace,
    stage: input.stage,
    stableServerReference: input.stableServerReference,
  });
  // Every acquisition write locks its root before any child stage. Keeping one
  // hierarchy prevents a landing observation and an authenticated Checkout
  // replay from waiting on each other's row and advisory locks.
  await advisoryLock(client, `root:${input.acquisitionId}`);
  await advisoryLock(client, `stage:${namespace}:${input.stage}:${deduplicationKey}`);
  const root = await client.query<StoredAcquisition>(`
    select * from public.sidestream_acquisitions
    where id = $1 and license_namespace = $2
    for share
  `, [input.acquisitionId, namespace]);
  if (!root.rows[0]) fail("acquisition_not_found", "Canonical acquisition was not found in the trusted namespace.");
  if (input.occurredAt < timestamp(root.rows[0].first_observed_at, "firstObservedAt")) {
    fail("invalid_stage_time", "Acquisition stage cannot predate first observation.");
  }
  const countingGrain = ACQUISITION_STAGE_COUNTING_GRAINS[input.stage];
  await client.query(`
    insert into public.sidestream_acquisition_stages (
      acquisition_id, license_namespace, stage, counting_grain,
      deduplication_key, occurred_at
    ) values ($1,$2,$3,$4,$5,$6)
    on conflict (license_namespace, stage, deduplication_key) do nothing
  `, [
    input.acquisitionId, namespace, input.stage, countingGrain,
    deduplicationKey, input.occurredAt,
  ]);
  const result = await client.query<StoredStage>(`
    select * from public.sidestream_acquisition_stages
    where license_namespace = $1 and stage = $2 and deduplication_key = $3
    for update
  `, [namespace, input.stage, deduplicationKey]);
  const stored = requiredRow(result.rows[0]);
  const ownerConflict = stored.acquisition_id !== input.acquisitionId;
  if (ownerConflict) {
    const evidenceHash = conflictEvidence({
      stage: input.stage,
      deduplicationKey,
      existingAcquisitionId: stored.acquisition_id,
      incomingAcquisitionId: input.acquisitionId,
    });
    const roots = await client.query<StoredAcquisition>(`
      select * from public.sidestream_acquisitions
      where license_namespace = $1 and id = any($2::uuid[])
      for update
    `, [namespace, [stored.acquisition_id, input.acquisitionId]]);
    for (const acquisition of roots.rows) {
      await quarantine(client, acquisition, "stage_deduplication_owner", evidenceHash);
    }
  }
  return mapStage(stored, ownerConflict);
}

async function quarantine(
  client: PoolClient,
  acquisition: StoredAcquisition,
  conflictType: "root_first_touch" | "stage_deduplication_owner",
  evidenceHash: string,
): Promise<void> {
  await client.query(`
    insert into public.sidestream_acquisition_conflicts (
      acquisition_id, license_namespace, conflict_type, evidence_hash
    ) values ($1,$2,$3,$4)
    on conflict (acquisition_id, conflict_type, evidence_hash) do nothing
  `, [acquisition.id, acquisition.license_namespace, conflictType, evidenceHash]);
  await client.query(`
    update public.sidestream_acquisitions
    set integrity_state = 'quarantined', updated_at = transaction_timestamp()
    where id = $1 and license_namespace = $2
  `, [acquisition.id, acquisition.license_namespace]);
}

async function selectAcquisitionById(client: PoolClient, acquisitionId: string) {
  const result = await client.query<StoredAcquisition>(`
    select * from public.sidestream_acquisitions where id = $1 for update
  `, [acquisitionId]);
  return result.rows[0] ?? null;
}

function sameFirstTouch(row: StoredAcquisition, input: Record<string, unknown>): boolean {
  return row.first_observed_source === input.source &&
    row.first_observed_medium === input.medium &&
    row.first_observed_campaign === input.campaign &&
    row.first_observed_content_creative === input.contentCreative &&
    row.entry_channel === input.entryChannel &&
    iso(row.first_observed_at) === input.firstObservedAt &&
    row.external_referrer_category === input.externalReferrerCategory &&
    row.experiment_id === ((input.experiment as { id: string } | null)?.id ?? null) &&
    row.experiment_cohort === ((input.experiment as { cohort: string } | null)?.cohort ?? null) &&
    row.attribution_confidence === input.attributionConfidence &&
    row.integrity_state === input.integrityState;
}

function mapAcquisition(row: StoredAcquisition): CanonicalAcquisition {
  return Object.freeze({
    id: row.id,
    licenseNamespace: row.license_namespace,
    firstObserved: Object.freeze({
      source: row.first_observed_source,
      medium: row.first_observed_medium,
      campaign: row.first_observed_campaign,
      contentCreative: row.first_observed_content_creative,
      at: iso(row.first_observed_at),
      externalReferrerCategory: row.external_referrer_category,
    }),
    entryChannel: row.entry_channel,
    experiment: row.experiment_id === null ? null : Object.freeze({
      id: row.experiment_id,
      cohort: row.experiment_cohort as string,
    }),
    attributionConfidence: row.attribution_confidence,
    integrityState: row.integrity_state,
    trustedDeliveryEvidence: Object.freeze([...row.trusted_delivery_evidence]),
  });
}

function mapStage(row: StoredStage, ownerConflict: boolean): AcquisitionStageRecord {
  return Object.freeze({
    id: row.id,
    acquisitionId: row.acquisition_id,
    licenseNamespace: row.license_namespace,
    stage: row.stage,
    countingGrain: row.counting_grain,
    deduplicationKey: row.deduplication_key,
    occurredAt: iso(row.occurred_at),
    recordedAt: iso(row.recorded_at),
    ownerConflict,
  });
}

async function advisoryLock(client: PoolClient, identity: string): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `sidestream_acquisition_integrity:${identity}`,
  ]);
}

async function withTransaction<T>(
  dependencies: Dependencies,
  callback: (client: PoolClient, namespace: Namespace) => Promise<T>,
): Promise<T> {
  if (dependencies.transaction || dependencies.namespace) {
    if (!dependencies.transaction || !isNamespace(dependencies.namespace)) {
      throw new Error("Acquisition integrity test dependencies require transaction and namespace together");
    }
    return dependencies.transaction((client) => callback(client, dependencies.namespace as Namespace));
  }
  const { resolveLicenseEnvironment } = await import("./license-environment.js");
  const environment = resolveLicenseEnvironment({ serverEnv: process.env });
  if (!environment) throw new Error("Acquisition integrity requires a trusted server-resolved license environment");
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

function normalizeExperiment(value: unknown): Readonly<{ id: string; cohort: string }> | null {
  if (value === null) return null;
  assertPlainObject(value);
  assertOnlyKeys(value, new Set(["id", "cohort"]));
  return Object.freeze({
    id: bounded(value.id, LOWER_DIMENSION, "experiment.id"),
    cohort: bounded(value.cohort, LOWER_DIMENSION, "experiment.cohort"),
  });
}

function normalizeDeliveryEvidence(value: readonly unknown[]): TrustedDeliveryEvidence[] {
  if (!Array.isArray(value)) fail("invalid_delivery_evidence", "Delivery evidence must be an array.");
  const result = [...new Set(value.map(assertDeliveryEvidence))];
  if (result.length < 1 || result.length > 8) {
    fail("invalid_delivery_evidence", "Delivery evidence must contain 1 to 8 allowlisted facts.");
  }
  return result;
}

function assertDeliveryEvidence(value: unknown): TrustedDeliveryEvidence {
  if (!(ACQUISITION_TRUSTED_DELIVERY_EVIDENCE as readonly unknown[]).includes(value)) {
    fail("invalid_delivery_evidence", "Delivery evidence is not allowlisted.");
  }
  return value as TrustedDeliveryEvidence;
}

function assertStage(value: unknown): AcquisitionStage {
  if (!(ACQUISITION_STAGES as readonly unknown[]).includes(value)) {
    fail("invalid_stage", "Acquisition stage is invalid.");
  }
  return value as AcquisitionStage;
}

function assertEntryChannel(value: unknown): EntryChannel {
  if (![
    "website",
    "manychat_email",
    "facebook_lead_form",
    "installer",
    "account",
    "checkout",
  ].includes(value as string)) {
    fail("invalid_entry_channel", "Acquisition entry channel is invalid.");
  }
  return value as EntryChannel;
}

function assertExternalReferrerCategory(value: unknown): ExternalReferrerCategory | null {
  if (value === null) return null;
  if (!["search", "social", "messaging", "video", "community", "publisher", "other_external"].includes(value as string)) {
    fail("invalid_referrer_category", "External referrer category is invalid.");
  }
  return value as ExternalReferrerCategory;
}

function assertAttributionConfidence(value: unknown): AttributionConfidence {
  if (!["exact_sidestream_entry", "exact_trusted_delivery", "missing_internal_linkage", "historical_unlinked"].includes(value as string)) {
    fail("invalid_confidence", "Attribution confidence is invalid.");
  }
  return value as AttributionConfidence;
}

function assertInitialIntegrityState(value: unknown): Exclude<IntegrityState, "quarantined"> {
  if (!["intact", "missing_internal_linkage", "historical_unlinked"].includes(value as string)) {
    fail("invalid_integrity", "Initial acquisition integrity state is invalid.");
  }
  return value as Exclude<IntegrityState, "quarantined">;
}

function stableServerReference(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail("invalid_deduplication_reference", "Stable server reference is invalid.");
  }
  return value;
}

function bounded(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail("invalid_first_touch", `${field} is invalid.`);
  }
  return value;
}

function optionalBounded(value: unknown, pattern: RegExp, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return bounded(value, pattern, field);
}

function assertNamespace(value: unknown): Namespace {
  if (!isNamespace(value)) fail("invalid_namespace", "License namespace is invalid.");
  return value;
}

function assertUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) fail("invalid_acquisition", `${field} must be a UUID.`);
  return value;
}

function timestamp(value: unknown, field: string): Date {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value as string);
  if (!Number.isFinite(result.getTime())) fail("invalid_timestamp", `${field} is invalid.`);
  return result;
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function isNamespace(value: unknown): value is Namespace {
  return value === "production" || value === "test";
}

function assertPlainObject(value: unknown): asserts value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("invalid_request", "Expected a plain object.");
  }
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("invalid_request", `Unexpected field: ${key}.`);
  }
}

function requiredRow<T>(value: T | null | undefined): T {
  if (!value) throw new Error("Acquisition integrity database row was not returned");
  return value;
}

function fail(code: string, message: string): never {
  throw new AcquisitionIntegrityError(code, message);
}

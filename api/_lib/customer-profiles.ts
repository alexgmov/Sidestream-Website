/** Shared, server-only Customer 360 identity and merge contract. */

import type { PoolClient } from "pg";
import type { ResolvedLicenseEnvironment } from "./license-environment.js";

export const CUSTOMER_LICENSE_NAMESPACES = ["production", "test"] as const;
export type CustomerLicenseNamespace =
  (typeof CUSTOMER_LICENSE_NAMESPACES)[number];

export const CUSTOMER_IDENTITY_LINK_TYPES = [
  "account_identity",
  "stripe_customer",
  "stripe_checkout_session",
  "stripe_payment_intent",
  "stripe_subscription",
  "activation_record",
  "install_identity_hash",
  "support_code",
  "installer_receipt_hash",
] as const;
export type CustomerIdentityLinkType =
  (typeof CUSTOMER_IDENTITY_LINK_TYPES)[number];

export const CUSTOMER_HASH_IDENTITY_LINK_TYPES = [
  "install_identity_hash",
  "installer_receipt_hash",
] as const;
export type CustomerHashIdentityLinkType =
  (typeof CUSTOMER_HASH_IDENTITY_LINK_TYPES)[number];
export type CustomerPlainIdentityLinkType = Exclude<
  CustomerIdentityLinkType,
  CustomerHashIdentityLinkType
>;

declare const lowercaseHex64Brand: unique symbol;
/** A runtime-validated lowercase SHA/HMAC-256 representation. */
export type LowercaseHex64 = string & {
  readonly [lowercaseHex64Brand]: "LowercaseHex64";
};

export const FORBIDDEN_MERGE_SIGNALS = [
  "ip",
  "user_agent",
  "display_name",
  "unverified_email",
  "time_proximity",
  "gmail_campaign_hmac",
  "installer_request_hmac",
] as const;
export type ForbiddenMergeSignal = (typeof FORBIDDEN_MERGE_SIGNALS)[number];

export const MERGE_INITIATORS = ["system", "support", "backfill"] as const;
export type MergeInitiator = (typeof MERGE_INITIATORS)[number];

export type CustomerProfileRow = Readonly<{
  id: string;
  licenseNamespace: CustomerLicenseNamespace;
  mergedInto: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
  contactEmail: string | null;
  displayName: string | null;
  platformSummary: string | null;
  appVersionSummary: string | null;
  firstSeenAt: string | null;
  lastActivityAt: string | null;
  downloadSuccessCount: number | null;
  downloadFailureCount: number | null;
  entitlementStatus: string | null;
  commerceSyncedAt: string | null;
}>;

type CustomerIdentityLinkRowBase = Readonly<{
  id: string;
  profileId: string;
  licenseNamespace: CustomerLicenseNamespace;
  createdAt: string;
}>;

export type CustomerIdentityLinkRow =
  | (CustomerIdentityLinkRowBase & Readonly<{
      linkType: CustomerHashIdentityLinkType;
      linkValue: LowercaseHex64;
    }>)
  | (CustomerIdentityLinkRowBase & Readonly<{
      linkType: CustomerPlainIdentityLinkType;
      linkValue: string;
    }>);

export type CustomerInstallRow = Readonly<{
  id: string;
  profileId: string;
  licenseNamespace: CustomerLicenseNamespace;
  installIdHash: LowercaseHex64;
  platform: "macos" | "windows" | "unknown" | null;
  appVersion: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}>;

export type CustomerProfileMergeRow = Readonly<{
  id: string;
  licenseNamespace: CustomerLicenseNamespace;
  sourceProfileId: string;
  targetProfileId: string;
  mergeEvidenceType: CustomerIdentityLinkType;
  mergeEvidenceValueHash: LowercaseHex64;
  initiatedBy: MergeInitiator;
  mergedAt: string;
}>;

export function isCustomerLicenseNamespace(
  value: unknown,
): value is CustomerLicenseNamespace {
  return value === "production" || value === "test";
}

export function isCustomerIdentityLinkType(
  value: unknown,
): value is CustomerIdentityLinkType {
  return (
    typeof value === "string" &&
    (CUSTOMER_IDENTITY_LINK_TYPES as readonly string[]).includes(value)
  );
}

export function assertDeterministicIdentityLinkType(
  value: unknown,
): CustomerIdentityLinkType {
  if (!isCustomerIdentityLinkType(value)) {
    throw new Error(
      `Refusing non-deterministic identity evidence: ${String(value)}`,
    );
  }
  return value;
}

/**
 * Validates the persisted representation for an identity type. Hash-backed
 * types return a branded value, so raw install or receipt identifiers cannot be
 * assigned to their TypeScript row shapes without crossing this runtime guard.
 */
export function assertCustomerIdentityLinkValue(
  linkType: CustomerHashIdentityLinkType,
  value: unknown,
): LowercaseHex64;
export function assertCustomerIdentityLinkValue(
  linkType: CustomerPlainIdentityLinkType,
  value: unknown,
): string;
export function assertCustomerIdentityLinkValue(
  linkType: CustomerIdentityLinkType,
  value: unknown,
): string;
export function assertCustomerIdentityLinkValue(
  linkType: CustomerIdentityLinkType,
  value: unknown,
): string {
  assertDeterministicIdentityLinkType(linkType);
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    value.trim() !== value
  ) {
    throw new TypeError("Customer identity link values must contain 1-200 exact characters");
  }
  if (
    (CUSTOMER_HASH_IDENTITY_LINK_TYPES as readonly string[]).includes(linkType) &&
    !isLowercaseHex64(value)
  ) {
    throw new TypeError(`${linkType} must be a lowercase hex64 digest`);
  }
  return value;
}

export function resolveProfileRoot(
  profileId: string,
  mergedInto: ReadonlyMap<string, string | null>,
): string {
  const visited = new Set<string>();
  let current = profileId;
  const maxSteps = mergedInto.size + 1;
  for (let step = 0; step <= maxSteps; step += 1) {
    if (visited.has(current)) {
      throw new Error(`Merge cycle detected at profile ${current}`);
    }
    visited.add(current);
    const next = mergedInto.get(current);
    if (next === undefined || next === null) return current;
    current = next;
  }
  throw new Error(`Merge chain exceeded bound at profile ${profileId}`);
}

export type MergeCandidate = Readonly<{
  id: string;
  licenseNamespace: CustomerLicenseNamespace;
  createdAt: string;
}>;

export type ProfileMergePlan =
  | Readonly<{ merge: false; reason: "same_profile" }>
  | Readonly<{
      merge: true;
      licenseNamespace: CustomerLicenseNamespace;
      survivorId: string;
      tombstoneId: string;
      evidenceType: CustomerIdentityLinkType;
    }>;

export function planProfileMerge(
  left: MergeCandidate,
  right: MergeCandidate,
  evidence: { linkType: unknown },
): ProfileMergePlan {
  if (left.licenseNamespace !== right.licenseNamespace) {
    throw new Error(
      "Refusing cross-namespace profile merge; Production and Test never merge",
    );
  }
  const evidenceType = assertDeterministicIdentityLinkType(evidence.linkType);
  if (left.id === right.id) {
    return { merge: false, reason: "same_profile" };
  }

  const survivor = compareMergeOrder(left, right) <= 0 ? left : right;
  const tombstone = survivor.id === left.id ? right : left;
  return {
    merge: true,
    licenseNamespace: survivor.licenseNamespace,
    survivorId: survivor.id,
    tombstoneId: tombstone.id,
    evidenceType,
  };
}

export type MergeCustomerProfilesInput = Readonly<{
  leftProfileId: string;
  rightProfileId: string;
  evidenceType: CustomerIdentityLinkType;
  evidenceValueHash: LowercaseHex64;
  initiatedBy: MergeInitiator;
}>;

export type MergeCustomerProfilesResult = Readonly<{
  merged: boolean;
  licenseNamespace: CustomerLicenseNamespace;
  survivorId: string;
  tombstoneId: string | null;
  auditId: string | null;
  mergedAt: string | null;
}>;

type LockedProfileRow = Readonly<{
  id: string;
  license_namespace: CustomerLicenseNamespace;
  merged_into: string | null;
  created_at: string;
}>;

type MergeAuditRecord = Readonly<{
  id: string;
  target_profile_id: string;
  merge_evidence_type: CustomerIdentityLinkType;
  merge_evidence_value_hash: string;
  initiated_by: MergeInitiator;
  merged_at: Date | string;
}>;

const PROFILE_MERGE_LOCK_PREFIX = "sidestream_customer_profile_merge";

/**
 * Transactionally merges two current profile roots. Namespace and database are
 * resolved exclusively from trusted server deployment state; callers cannot
 * supply either through request data. A namespace-wide advisory lock serializes
 * root changes, while profile rows are locked in UUID order before roots are
 * re-resolved. This makes retries and concurrent reverse-order requests converge.
 */
export async function mergeCustomerProfiles(
  input: MergeCustomerProfilesInput,
): Promise<MergeCustomerProfilesResult> {
  assertUuid(input.leftProfileId, "leftProfileId");
  assertUuid(input.rightProfileId, "rightProfileId");
  const evidenceType = assertDeterministicIdentityLinkType(input.evidenceType);
  const evidenceValueHash = assertLowercaseHex64(
    input.evidenceValueHash,
    "evidenceValueHash",
  );
  if (!(MERGE_INITIATORS as readonly string[]).includes(input.initiatedBy)) {
    throw new TypeError("Unknown Customer 360 merge initiator");
  }

  const environment = await requireCustomerProfileEnvironment();
  return withCustomerProfileTransaction(environment, async (client) => {
    const namespace = environment.namespace;
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `${PROFILE_MERGE_LOCK_PREFIX}:${namespace}`,
    ]);

    const rows = await lockProfileChains(
      client,
      namespace,
      [input.leftProfileId, input.rightProfileId],
    );
    const mergedInto = new Map(
      [...rows.values()].map((row) => [row.id, row.merged_into] as const),
    );
    const leftRootId = resolveProfileRoot(input.leftProfileId, mergedInto);
    const rightRootId = resolveProfileRoot(input.rightProfileId, mergedInto);

    if (leftRootId === rightRootId) {
      return {
        merged: false,
        licenseNamespace: namespace,
        survivorId: leftRootId,
        tombstoneId: null,
        auditId: null,
        mergedAt: null,
      };
    }

    const leftRoot = rows.get(leftRootId);
    const rightRoot = rows.get(rightRootId);
    if (!leftRoot || !rightRoot) {
      throw new Error("Customer profile roots changed while locked");
    }
    const plan = planProfileMerge(
      mergeCandidate(leftRoot),
      mergeCandidate(rightRoot),
      { linkType: evidenceType },
    );
    if (!plan.merge) {
      throw new Error("Distinct locked roots unexpectedly produced a no-op merge");
    }

    await client.query(
      `
        lock table public.sidestream_customer_identity_links,
          public.sidestream_customer_installs
        in share row exclusive mode
      `,
    );
    await reassignIdentityLinks(client, namespace, plan.tombstoneId, plan.survivorId);
    await reassignInstallMembership(client, namespace, plan.tombstoneId, plan.survivorId);

    const timestamp = await client.query<{ merged_at: Date | string }>(
      "select transaction_timestamp() as merged_at",
    );
    const mergedAt = timestamp.rows[0]?.merged_at;
    if (!mergedAt) throw new Error("Postgres did not return a merge timestamp");

    const tombstone = await client.query(
      `
        update public.sidestream_customer_profiles
        set merged_into = $3, merged_at = $4, updated_at = $4
        where license_namespace = $1 and id = $2 and merged_into is null
      `,
      [namespace, plan.tombstoneId, plan.survivorId, mergedAt],
    );
    if (tombstone.rowCount !== 1) {
      throw new Error("Customer profile root changed before tombstoning");
    }

    const audit = await insertOrVerifyMergeAudit(client, {
      namespace,
      sourceProfileId: plan.tombstoneId,
      targetProfileId: plan.survivorId,
      evidenceType,
      evidenceValueHash,
      initiatedBy: input.initiatedBy,
      mergedAt,
    });
    return {
      merged: true,
      licenseNamespace: namespace,
      survivorId: plan.survivorId,
      tombstoneId: plan.tombstoneId,
      auditId: audit.id,
      mergedAt: toIsoString(audit.merged_at),
    };
  });
}

async function withCustomerProfileTransaction<T>(
  environment: ResolvedLicenseEnvironment,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
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
      const result = await callback(client);
      await client.query("commit");
      return result;
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // Preserve the operation's original error.
      }
      throw error;
    }
  } finally {
    client.release();
  }
}

async function lockProfileChains(
  client: PoolClient,
  namespace: CustomerLicenseNamespace,
  profileIds: readonly string[],
): Promise<Map<string, LockedProfileRow>> {
  const locked = new Map<string, LockedProfileRow>();
  let pending = [...new Set(profileIds)].sort();

  while (pending.length > 0) {
    const result = await client.query<LockedProfileRow>(
      `
        select id, license_namespace, merged_into,
          to_char(
            created_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US'
          ) as created_at
        from public.sidestream_customer_profiles
        where license_namespace = $1 and id = any($2::uuid[])
        order by id
        for update
      `,
      [namespace, pending],
    );
    const found = new Set(result.rows.map((row) => row.id));
    const missing = pending.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new Error("Customer profiles do not exist in the trusted license namespace");
    }
    for (const row of result.rows) locked.set(row.id, row);
    pending = [...new Set(
      result.rows
        .map((row) => row.merged_into)
        .filter((id): id is string => id !== null && !locked.has(id)),
    )].sort();
  }
  return locked;
}

async function reassignIdentityLinks(
  client: PoolClient,
  namespace: CustomerLicenseNamespace,
  sourceProfileId: string,
  targetProfileId: string,
): Promise<void> {
  await client.query(
    `
      delete from public.sidestream_customer_identity_links source
      using public.sidestream_customer_identity_links target
      where source.license_namespace = $1
        and source.profile_id = $2
        and target.license_namespace = source.license_namespace
        and target.profile_id = $3
        and target.link_type = source.link_type
        and target.link_value = source.link_value
    `,
    [namespace, sourceProfileId, targetProfileId],
  );
  await client.query(
    `
      update public.sidestream_customer_identity_links
      set profile_id = $3
      where license_namespace = $1 and profile_id = $2
    `,
    [namespace, sourceProfileId, targetProfileId],
  );
}

async function reassignInstallMembership(
  client: PoolClient,
  namespace: CustomerLicenseNamespace,
  sourceProfileId: string,
  targetProfileId: string,
): Promise<void> {
  await client.query(
    `
      delete from public.sidestream_customer_installs source
      using public.sidestream_customer_installs target
      where source.license_namespace = $1
        and source.profile_id = $2
        and target.license_namespace = source.license_namespace
        and target.profile_id = $3
        and target.install_id_hash = source.install_id_hash
    `,
    [namespace, sourceProfileId, targetProfileId],
  );
  await client.query(
    `
      update public.sidestream_customer_installs
      set profile_id = $3
      where license_namespace = $1 and profile_id = $2
    `,
    [namespace, sourceProfileId, targetProfileId],
  );
}

async function insertOrVerifyMergeAudit(
  client: PoolClient,
  input: Readonly<{
    namespace: CustomerLicenseNamespace;
    sourceProfileId: string;
    targetProfileId: string;
    evidenceType: CustomerIdentityLinkType;
    evidenceValueHash: LowercaseHex64;
    initiatedBy: MergeInitiator;
    mergedAt: Date | string;
  }>,
): Promise<MergeAuditRecord> {
  const inserted = await client.query<MergeAuditRecord>(
    `
      insert into public.sidestream_customer_profile_merges (
        license_namespace,
        source_profile_id,
        target_profile_id,
        merge_evidence_type,
        merge_evidence_value_hash,
        initiated_by,
        merged_at
      ) values ($1, $2, $3, $4, $5, $6, $7)
      on conflict (license_namespace, source_profile_id) do nothing
      returning id, target_profile_id, merge_evidence_type,
        merge_evidence_value_hash, initiated_by, merged_at
    `,
    [
      input.namespace,
      input.sourceProfileId,
      input.targetProfileId,
      input.evidenceType,
      input.evidenceValueHash,
      input.initiatedBy,
      input.mergedAt,
    ],
  );
  const audit = inserted.rows[0] || (await client.query<MergeAuditRecord>(
    `
      select id, target_profile_id, merge_evidence_type,
        merge_evidence_value_hash, initiated_by, merged_at
      from public.sidestream_customer_profile_merges
      where license_namespace = $1 and source_profile_id = $2
    `,
    [input.namespace, input.sourceProfileId],
  )).rows[0];
  if (
    !audit ||
    audit.target_profile_id !== input.targetProfileId ||
    audit.merge_evidence_type !== input.evidenceType ||
    audit.merge_evidence_value_hash !== input.evidenceValueHash ||
    audit.initiated_by !== input.initiatedBy
  ) {
    throw new Error("Existing Customer 360 merge audit does not match this merge");
  }
  return audit;
}

async function requireCustomerProfileEnvironment(): Promise<ResolvedLicenseEnvironment> {
  const { resolveLicenseEnvironment } = await import("./license-environment.js");
  const environment = resolveLicenseEnvironment({ serverEnv: process.env });
  if (!environment) {
    throw new Error(
      "Customer 360 requires a trusted server-resolved license environment",
    );
  }
  return environment;
}

function mergeCandidate(row: LockedProfileRow): MergeCandidate {
  return {
    id: row.id,
    licenseNamespace: row.license_namespace,
    createdAt: row.created_at,
  };
}

function compareMergeOrder(left: MergeCandidate, right: MergeCandidate): number {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  const preciseTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
  if (
    preciseTimestamp.test(left.createdAt) &&
    preciseTimestamp.test(right.createdAt) &&
    left.createdAt !== right.createdAt
  ) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function assertLowercaseHex64(value: unknown, fieldName: string): LowercaseHex64 {
  if (typeof value !== "string" || !isLowercaseHex64(value)) {
    throw new TypeError(`${fieldName} must be a lowercase hex64 digest`);
  }
  return value as LowercaseHex64;
}

function isLowercaseHex64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function assertUuid(value: string, fieldName: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${fieldName} must be a UUID`);
  }
}

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid Postgres timestamp");
  return date.toISOString();
}

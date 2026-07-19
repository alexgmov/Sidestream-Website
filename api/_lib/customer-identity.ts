/** Transaction-scoped Customer 360 identity attachment. */

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { ResolvedLicenseEnvironment } from "./license-environment.js";

export const CUSTOMER_INSTALL_ID_HASH_PATTERN = /^[0-9a-f]{64}$/;
export const CUSTOMER_SUPPORT_CODE_PATTERN =
  /^SIDE-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export type CustomerIdentityInput = Readonly<{
  installIdHash?: string;
  supportCode?: string;
  installerReceiptIdHash?: string;
}>;

export type CustomerIdentityAttachmentSource =
  | "activation_start"
  | "activation_status"
  | "activation_claim"
  | "license_verify"
  | "license_refresh";

type CustomerIdentityLinkType =
  | "account_identity"
  | "stripe_customer"
  | "stripe_checkout_session"
  | "stripe_payment_intent"
  | "stripe_subscription"
  | "activation_record"
  | "install_identity_hash"
  | "support_code"
  | "installer_receipt_hash";

type IdentityEvidence = Readonly<{
  linkType: CustomerIdentityLinkType;
  linkValue: string;
  verified: boolean;
}>;

type VerifiedAccountRow = Readonly<{
  account_id: string;
  email: string;
  display_name: string | null;
  account_stripe_customer_id: string | null;
  license_stripe_customer_id: string | null;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_subscription_id: string | null;
}>;

type VerifiedAccountEvidence = Readonly<{
  contactEmail: string;
  displayName: string | null;
  evidence: readonly IdentityEvidence[];
}>;

export class CustomerIdentityInputError extends TypeError {
  constructor(fieldName: keyof CustomerIdentityInput) {
    super(`Invalid Customer 360 identity field: ${fieldName}`);
    this.name = "CustomerIdentityInputError";
  }
}

/**
 * Accepts only already-hashed install/receipt identifiers and the canonical
 * support-code spelling. Empty optional values are treated as omitted so old
 * clients and clients that serialize blank optionals remain compatible.
 */
export function normalizeCustomerIdentityInput(
  input: unknown,
): CustomerIdentityInput {
  const value = isRecord(input) ? input : {};
  const installIdHash = optionalExactIdentity(
    value.installIdHash,
    "installIdHash",
    CUSTOMER_INSTALL_ID_HASH_PATTERN,
  );
  const supportCode = optionalExactIdentity(
    value.supportCode,
    "supportCode",
    CUSTOMER_SUPPORT_CODE_PATTERN,
  );
  const installerReceiptIdHash = optionalExactIdentity(
    value.installerReceiptIdHash,
    "installerReceiptIdHash",
    CUSTOMER_INSTALL_ID_HASH_PATTERN,
  );
  return Object.freeze({
    ...(installIdHash ? { installIdHash } : {}),
    ...(supportCode ? { supportCode } : {}),
    ...(installerReceiptIdHash ? { installerReceiptIdHash } : {}),
  });
}

export type AttachCustomerIdentityOptions = Readonly<{
  environment: ResolvedLicenseEnvironment;
  identity?: unknown;
  activationId?: string | null;
  accountId?: string | null;
  platform?: unknown;
  appVersion?: unknown;
  source: CustomerIdentityAttachmentSource;
}>;

export type AttachCustomerIdentityResult = Readonly<{
  profileId: string | null;
  attached: boolean;
  reviewRequired: boolean;
}>;

/**
 * Resolves an anonymous profile before consulting account/Stripe truth, then
 * attaches verified evidence to that UUID inside the caller's transaction.
 * Client identity values are association keys only. This module never reads or
 * mutates device bindings, credentials, transfer history, entitlement, or
 * policy configuration.
 */
export async function attachCustomerIdentity(
  client: PoolClient,
  options: AttachCustomerIdentityOptions,
): Promise<AttachCustomerIdentityResult> {
  const namespace = options.environment.namespace;
  if (namespace !== "production" && namespace !== "test") {
    throw new Error("Customer identity requires a trusted license namespace");
  }
  if (!ATTACHMENT_SOURCES.has(options.source)) {
    throw new TypeError("Unknown Customer 360 attachment source");
  }

  const identity = normalizeCustomerIdentityInput(options.identity);
  const activationId = optionalServerUuid(options.activationId, "activationId");
  const accountId = optionalServerUuid(options.accountId, "accountId");
  const anonymousEvidence = buildAnonymousEvidence(identity, activationId);

  // An account never selects a profile. Without an activation or anonymous
  // install association there is no safe existing UUID to attach it to.
  if (anonymousEvidence.length === 0) {
    return { profileId: null, attached: false, reviewRequired: false };
  }

  // Customer 360 is additive to the account and license path. Older deployed
  // databases intentionally do not have its schema yet, so identity attachment
  // must stay dormant until the complete core table set is present.
  if (!await hasCustomerIdentitySchema(client)) {
    return { profileId: null, attached: false, reviewRequired: false };
  }

  // Coordinate with the core merge primitive so every link we inspect or add
  // points at a live root for the entire attachment transaction.
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `sidestream_customer_profile_merge:${namespace}`,
  ]);
  await lockEvidence(client, namespace, anonymousEvidence);

  const owners = await findEvidenceOwners(client, namespace, anonymousEvidence);
  const profileId = firstEvidenceOwner(anonymousEvidence, owners) ||
    await createAnonymousProfile(client, namespace);

  let reviewRequired = false;
  for (const evidence of anonymousEvidence) {
    const result = await attachEvidence(client, {
      namespace,
      profileId,
      evidence,
      source: options.source,
    });
    reviewRequired ||= result.reviewRequired;
  }

  if (identity.installIdHash) {
    const install = await attachInstallMembership(client, {
      namespace,
      profileId,
      installIdHash: identity.installIdHash,
      platform: normalizePlatform(options.platform),
      appVersion: normalizeAppVersion(options.appVersion),
      source: options.source,
    });
    reviewRequired ||= install.reviewRequired;
  }

  if (accountId) {
    // Read account and purchase identifiers from the selected server database;
    // request email, name, IP, timing, behavior, and campaign HMACs are absent.
    const verified = await attachVerifiedAccount(client, {
      namespace,
      profileId,
      accountId,
      source: options.source,
    });
    reviewRequired ||= verified.reviewRequired;
  }

  return { profileId, attached: true, reviewRequired };
}

async function hasCustomerIdentitySchema(client: PoolClient): Promise<boolean> {
  const result = await client.query<{
    profiles: string | null;
    links: string | null;
    installs: string | null;
    reviews: string | null;
  }>(
    `
      select
        to_regclass('public.sidestream_customer_profiles')::text as profiles,
        to_regclass('public.sidestream_customer_identity_links')::text as links,
        to_regclass('public.sidestream_customer_installs')::text as installs,
        to_regclass('public.sidestream_customer_identity_reviews')::text as reviews
    `,
  );
  const schema = result.rows[0];

  return Boolean(
    schema?.profiles &&
    schema.links &&
    schema.installs &&
    schema.reviews
  );
}

const ATTACHMENT_SOURCES = new Set<CustomerIdentityAttachmentSource>([
  "activation_start",
  "activation_status",
  "activation_claim",
  "license_verify",
  "license_refresh",
]);

function buildAnonymousEvidence(
  identity: CustomerIdentityInput,
  activationId: string | null,
): IdentityEvidence[] {
  return [
    activationId
      ? { linkType: "activation_record", linkValue: activationId, verified: true }
      : null,
    identity.installIdHash
      ? {
          linkType: "install_identity_hash",
          linkValue: identity.installIdHash,
          verified: false,
        }
      : null,
    identity.installerReceiptIdHash
      ? {
          linkType: "installer_receipt_hash",
          linkValue: identity.installerReceiptIdHash,
          verified: false,
        }
      : null,
    identity.supportCode
      ? { linkType: "support_code", linkValue: identity.supportCode, verified: false }
      : null,
  ].filter((evidence): evidence is IdentityEvidence => evidence !== null);
}

async function loadVerifiedAccountEvidence(
  client: PoolClient,
  accountId: string,
): Promise<VerifiedAccountEvidence> {
  const result = await client.query<VerifiedAccountRow>(
    `
      select
        a.id as account_id,
        a.email,
        a.display_name,
        a.stripe_customer_id as account_stripe_customer_id,
        l.stripe_customer_id as license_stripe_customer_id,
        l.stripe_checkout_session_id,
        l.stripe_payment_intent_id,
        l.stripe_subscription_id
      from public.sidestream_accounts a
      left join public.sidestream_licenses l on l.account_id = a.id
      where a.id = $1
      order by l.created_at asc nulls last, l.id asc nulls last
    `,
    [accountId],
  );
  if (result.rows.length === 0) {
    throw new Error("Verified Customer 360 account no longer exists");
  }

  const account = result.rows[0];
  const evidence = new Map<string, IdentityEvidence>();
  addVerifiedEvidence(evidence, "account_identity", accountId);
  for (const row of result.rows) {
    if (row.account_id !== accountId) {
      throw new Error("Verified Customer 360 account query crossed an account boundary");
    }
    addVerifiedEvidence(
      evidence,
      "stripe_customer",
      row.account_stripe_customer_id,
    );
    addVerifiedEvidence(
      evidence,
      "stripe_customer",
      row.license_stripe_customer_id,
    );
    addVerifiedEvidence(
      evidence,
      "stripe_checkout_session",
      row.stripe_checkout_session_id,
    );
    addVerifiedEvidence(
      evidence,
      "stripe_payment_intent",
      row.stripe_payment_intent_id,
    );
    addVerifiedEvidence(
      evidence,
      "stripe_subscription",
      row.stripe_subscription_id,
    );
  }
  return {
    contactEmail: verifiedContactEmail(account.email),
    displayName: verifiedDisplayName(account.display_name),
    evidence: [...evidence.values()],
  };
}

async function attachVerifiedAccount(
  client: PoolClient,
  options: Readonly<{
    namespace: string;
    profileId: string;
    accountId: string;
    source: CustomerIdentityAttachmentSource;
  }>,
): Promise<{ reviewRequired: boolean }> {
  const verified = await loadVerifiedAccountEvidence(client, options.accountId);
  await lockEvidence(client, options.namespace, verified.evidence);

  const owners = await findEvidenceOwners(
    client,
    options.namespace,
    verified.evidence,
  );
  const ownerConflicts = verified.evidence.flatMap((evidence) => {
    const existingProfileId = owners.get(evidenceKey(evidence));
    return existingProfileId && existingProfileId !== options.profileId
      ? [{ evidence, existingProfileId }]
      : [];
  });
  const existingAccountId = await findProfileAccountIdentity(
    client,
    options.namespace,
    options.profileId,
  );
  const accountConflict = existingAccountId &&
    existingAccountId !== options.accountId;

  if (ownerConflicts.length > 0 || accountConflict) {
    for (const conflict of ownerConflicts) {
      await recordIdentityReview(client, {
        namespace: options.namespace,
        candidateProfileId: options.profileId,
        existingProfileId: conflict.existingProfileId,
        evidence: conflict.evidence,
        source: options.source,
      });
    }
    if (accountConflict) {
      await recordIdentityReview(client, {
        namespace: options.namespace,
        candidateProfileId: options.profileId,
        existingProfileId: options.profileId,
        evidence: {
          linkType: "account_identity",
          linkValue: options.accountId,
          verified: true,
        },
        source: options.source,
      });
    }
    return { reviewRequired: true };
  }

  // Keep the verified set all-or-nothing even if a writer that does not honor
  // the advisory locks races this transaction. Conflicts survive as review
  // rows, but no partial account or purchase evidence survives the savepoint.
  await client.query("savepoint sidestream_customer_verified_attachment");
  let savepointActive = true;
  try {
    const conflicts: Array<Readonly<{
      evidence: IdentityEvidence;
      existingProfileId: string;
    }>> = [];
    for (const evidence of verified.evidence) {
      const result = await attachEvidence(client, {
        namespace: options.namespace,
        profileId: options.profileId,
        evidence,
        source: options.source,
        recordReview: false,
      });
      if (result.reviewRequired) {
        conflicts.push({
          evidence,
          existingProfileId: result.existingProfileId,
        });
      }
    }

    if (conflicts.length > 0) {
      await client.query("rollback to savepoint sidestream_customer_verified_attachment");
      await client.query("release savepoint sidestream_customer_verified_attachment");
      savepointActive = false;
      for (const conflict of conflicts) {
        await recordIdentityReview(client, {
          namespace: options.namespace,
          candidateProfileId: options.profileId,
          existingProfileId: conflict.existingProfileId,
          evidence: conflict.evidence,
          source: options.source,
        });
      }
      return { reviewRequired: true };
    }

    await materializeVerifiedContact(client, {
      namespace: options.namespace,
      profileId: options.profileId,
      contactEmail: verified.contactEmail,
      displayName: verified.displayName,
    });
    await client.query("release savepoint sidestream_customer_verified_attachment");
    savepointActive = false;
    return { reviewRequired: false };
  } catch (error) {
    if (savepointActive) {
      await client.query("rollback to savepoint sidestream_customer_verified_attachment");
      await client.query("release savepoint sidestream_customer_verified_attachment");
    }
    throw error;
  }
}

async function findProfileAccountIdentity(
  client: PoolClient,
  namespace: string,
  profileId: string,
): Promise<string | null> {
  const result = await client.query<{ link_value: string }>(
    `
      select link_value
      from public.sidestream_customer_identity_links
      where license_namespace = $1
        and profile_id = $2
        and link_type = 'account_identity'
      order by created_at asc, id asc
      limit 2
    `,
    [namespace, profileId],
  );
  if (result.rows.length > 1) {
    throw new Error("Customer 360 profile has conflicting account identities");
  }
  return result.rows[0]?.link_value || null;
}

async function materializeVerifiedContact(
  client: PoolClient,
  options: Readonly<{
    namespace: string;
    profileId: string;
    contactEmail: string;
    displayName: string | null;
  }>,
): Promise<void> {
  const updated = await client.query<{ id: string }>(
    `
      update public.sidestream_customer_profiles
      set contact_email = $3,
          display_name = $4,
          updated_at = now()
      where id = $1
        and license_namespace = $2
        and merged_into is null
      returning id
    `,
    [
      options.profileId,
      options.namespace,
      options.contactEmail,
      options.displayName,
    ],
  );
  if (updated.rows[0]?.id !== options.profileId) {
    throw new Error("Verified Customer 360 contact lost its live profile root");
  }
}

function verifiedContactEmail(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 320 ||
    value !== value.trim().toLowerCase() ||
    !value.includes("@")
  ) {
    throw new Error("Invalid verified Customer 360 contact email");
  }
  return value;
}

function verifiedDisplayName(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    value.trim() !== value
  ) {
    throw new Error("Invalid verified Customer 360 display name");
  }
  return value;
}

function addVerifiedEvidence(
  evidence: Map<string, IdentityEvidence>,
  linkType: IdentityEvidence["linkType"],
  rawValue: string | null,
): void {
  if (rawValue === null) return;
  if (
    typeof rawValue !== "string" ||
    rawValue.length < 1 ||
    rawValue.length > 200 ||
    rawValue.trim() !== rawValue
  ) {
    throw new Error(`Invalid verified Customer 360 ${linkType} evidence`);
  }
  evidence.set(`${linkType}:${rawValue}`, {
    linkType,
    linkValue: rawValue,
    verified: true,
  });
}

async function lockEvidence(
  client: PoolClient,
  namespace: string,
  evidence: readonly IdentityEvidence[],
): Promise<void> {
  const lockKeys = [...new Set(evidence.map((item) =>
    `sidestream_customer_identity:${namespace}:${item.linkType}:${hashEvidence(item)}`
  ))].sort();
  for (const lockKey of lockKeys) {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [lockKey]);
  }
}

async function findEvidenceOwners(
  client: PoolClient,
  namespace: string,
  evidence: readonly IdentityEvidence[],
): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (const item of evidence) {
    const result = await client.query<{ profile_id: string }>(
      `
        select link.profile_id
        from public.sidestream_customer_identity_links link
        join public.sidestream_customer_profiles profile
          on profile.id = link.profile_id
          and profile.license_namespace = link.license_namespace
          and profile.merged_into is null
        where link.license_namespace = $1
          and link.link_type = $2
          and link.link_value = $3
        limit 1
      `,
      [namespace, item.linkType, item.linkValue],
    );
    const owner = result.rows[0]?.profile_id;
    if (owner) owners.set(evidenceKey(item), owner);
  }
  return owners;
}

function firstEvidenceOwner(
  evidence: readonly IdentityEvidence[],
  owners: ReadonlyMap<string, string>,
): string | null {
  for (const item of evidence) {
    const owner = owners.get(evidenceKey(item));
    if (owner) return owner;
  }
  return null;
}

async function createAnonymousProfile(
  client: PoolClient,
  namespace: string,
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `
      insert into public.sidestream_customer_profiles (
        license_namespace, created_at, updated_at
      ) values ($1, now(), now())
      returning id
    `,
    [namespace],
  );
  const profileId = inserted.rows[0]?.id;
  if (!profileId) throw new Error("Customer 360 profile insert did not return an ID");
  return profileId;
}

async function attachEvidence(
  client: PoolClient,
  options: Readonly<{
    namespace: string;
    profileId: string;
    evidence: IdentityEvidence;
    source: CustomerIdentityAttachmentSource;
    recordReview?: boolean;
  }>,
): Promise<
  | { reviewRequired: false }
  | { reviewRequired: true; existingProfileId: string }
> {
  const inserted = await client.query<{ profile_id: string }>(
    `
      insert into public.sidestream_customer_identity_links (
        profile_id, license_namespace, link_type, link_value, created_at
      ) values ($1, $2, $3, $4, now())
      on conflict do nothing
      returning profile_id
    `,
    [
      options.profileId,
      options.namespace,
      options.evidence.linkType,
      options.evidence.linkValue,
    ],
  );
  if (inserted.rows[0]?.profile_id === options.profileId) {
    return { reviewRequired: false };
  }

  const existing = await client.query<{ profile_id: string }>(
    `
      select profile_id
      from public.sidestream_customer_identity_links
      where license_namespace = $1 and link_type = $2 and link_value = $3
      limit 1
    `,
    [options.namespace, options.evidence.linkType, options.evidence.linkValue],
  );
  let existingProfileId = existing.rows[0]?.profile_id;
  if (!existingProfileId && options.evidence.linkType === "account_identity") {
    const existingAccount = await client.query<{ profile_id: string }>(
      `
        select profile_id
        from public.sidestream_customer_identity_links
        where license_namespace = $1
          and profile_id = $2
          and link_type = 'account_identity'
        limit 1
      `,
      [options.namespace, options.profileId],
    );
    existingProfileId = existingAccount.rows[0]?.profile_id;
  }
  if (!existingProfileId) {
    throw new Error("Customer 360 identity conflict lost its winning evidence row");
  }
  if (
    existingProfileId === options.profileId &&
    existing.rows[0]?.profile_id === options.profileId
  ) {
    return { reviewRequired: false };
  }

  if (options.recordReview !== false) {
    await recordIdentityReview(client, {
      namespace: options.namespace,
      candidateProfileId: options.profileId,
      existingProfileId,
      evidence: options.evidence,
      source: options.source,
    });
  }
  return { reviewRequired: true, existingProfileId };
}

async function attachInstallMembership(
  client: PoolClient,
  options: Readonly<{
    namespace: string;
    profileId: string;
    installIdHash: string;
    platform: "macos" | "windows" | "unknown" | null;
    appVersion: string | null;
    source: CustomerIdentityAttachmentSource;
  }>,
): Promise<{ reviewRequired: boolean }> {
  const inserted = await client.query<{ profile_id: string }>(
    `
      insert into public.sidestream_customer_installs (
        profile_id, license_namespace, install_id_hash, platform, app_version,
        first_seen_at, last_seen_at
      ) values ($1, $2, $3, $4, $5, now(), now())
      on conflict (license_namespace, install_id_hash) do nothing
      returning profile_id
    `,
    [
      options.profileId,
      options.namespace,
      options.installIdHash,
      options.platform,
      options.appVersion,
    ],
  );
  if (inserted.rows[0]?.profile_id === options.profileId) {
    return { reviewRequired: false };
  }

  const existing = await client.query<{ profile_id: string }>(
    `
      select profile_id
      from public.sidestream_customer_installs
      where license_namespace = $1 and install_id_hash = $2
      limit 1
    `,
    [options.namespace, options.installIdHash],
  );
  const existingProfileId = existing.rows[0]?.profile_id;
  if (!existingProfileId) {
    throw new Error("Customer 360 install conflict lost its winning membership row");
  }
  if (existingProfileId !== options.profileId) {
    await recordIdentityReview(client, {
      namespace: options.namespace,
      candidateProfileId: options.profileId,
      existingProfileId,
      evidence: {
        linkType: "install_identity_hash",
        linkValue: options.installIdHash,
        verified: false,
      },
      source: options.source,
    });
    return { reviewRequired: true };
  }

  await client.query(
    `
      update public.sidestream_customer_installs
      set platform = coalesce($3, platform),
          app_version = coalesce($4, app_version),
          last_seen_at = greatest(last_seen_at, now())
      where license_namespace = $1 and install_id_hash = $2 and profile_id = $5
    `,
    [
      options.namespace,
      options.installIdHash,
      options.platform,
      options.appVersion,
      options.profileId,
    ],
  );
  return { reviewRequired: false };
}

async function recordIdentityReview(
  client: PoolClient,
  options: Readonly<{
    namespace: string;
    candidateProfileId: string;
    existingProfileId: string;
    evidence: IdentityEvidence;
    source: CustomerIdentityAttachmentSource;
  }>,
): Promise<void> {
  await client.query(
    `
      insert into public.sidestream_customer_identity_reviews (
        license_namespace,
        candidate_profile_id,
        existing_profile_id,
        evidence_type,
        evidence_value_hash,
        evidence_trust,
        attachment_source,
        review_state,
        created_at
      ) values ($1, $2, $3, $4, $5, $6, $7, 'pending_review', now())
      on conflict (
        license_namespace,
        candidate_profile_id,
        existing_profile_id,
        evidence_type,
        evidence_value_hash
      ) do nothing
    `,
    [
      options.namespace,
      options.candidateProfileId,
      options.existingProfileId,
      options.evidence.linkType,
      hashEvidence(options.evidence),
      options.evidence.verified ? "verified_server" : "client_association",
      options.source,
    ],
  );
}

function optionalExactIdentity(
  value: unknown,
  fieldName: keyof CustomerIdentityInput,
  pattern: RegExp,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new CustomerIdentityInputError(fieldName);
  }
  return value;
}

function optionalServerUuid(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new TypeError(`Invalid server-owned Customer 360 ${fieldName}`);
  }
  return value;
}

function normalizePlatform(
  value: unknown,
): "macos" | "windows" | "unknown" | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized = value.trim().toLowerCase();
  if (["mac", "macos", "darwin", "osx"].includes(normalized)) return "macos";
  if (["win", "win32", "windows"].includes(normalized)) return "windows";
  return "unknown";
}

function normalizeAppVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(normalized)
    ? normalized
    : null;
}

function hashEvidence(evidence: IdentityEvidence): string {
  return createHash("sha256")
    .update(`${evidence.linkType}:${evidence.linkValue}`)
    .digest("hex");
}

function evidenceKey(evidence: IdentityEvidence): string {
  return `${evidence.linkType}:${evidence.linkValue}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

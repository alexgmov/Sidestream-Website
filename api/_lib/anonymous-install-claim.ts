/** Optional, server-owned browser acquisition to installation continuity. */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { PoolClient } from "pg";
import type { ResolvedLicenseEnvironment } from "./license-environment.js";

export const ANONYMOUS_INSTALL_CLAIM_TTL_SECONDS = 15 * 60;
export const ANONYMOUS_INSTALL_CLAIM_SECRET_NAME =
  "SIDESTREAM_ANONYMOUS_ACQUISITION_SECRET";

const VERSION = "1";
const ENCRYPTION_CONTEXT = "sidestream-anonymous-install-claim-encryption-v1";
const SIGNATURE_CONTEXT = "sidestream-anonymous-install-claim-signature-v1";
const CONFLICT_CONTEXT = "sidestream-anonymous-install-claim-conflict-v1";
const CLAIM_MARKER_MEDIUM = "installation_claim";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

type Namespace = "production" | "test";
type Transaction = <T>(callback: (client: PoolClient) => Promise<T>) => Promise<T>;

type Dependencies = Readonly<{
  transaction?: Transaction;
  environment?: ResolvedLicenseEnvironment;
  namespace?: Namespace;
  secret?: string;
  now?: number | Date;
  randomBytes?: (size: number) => Uint8Array;
}>;

type ClaimIdentity = Readonly<{
  installIdHash: string;
  installerReceiptIdHash: string;
}>;

type ClaimEnvelope = ClaimIdentity & Readonly<{
  claimToken: string;
  namespace: Namespace;
  issuedAt: number;
  expiresAt: number;
}>;

type AcquisitionRow = Readonly<{
  id: string;
  token_hash: string;
  first_touch_source: string;
  first_touch_medium: string | null;
  first_touch_campaign: string | null;
  first_seen_at: Date | string;
  first_installer_requested_at: Date | string | null;
  claim_state: "unclaimed" | "claimed" | "quarantined" | "expired";
  claimed_profile_id: string | null;
  expires_at: Date | string;
}>;

export type AnonymousInstallationClaim = Readonly<{
  nonce: string;
  expiresAt: string;
}>;

export type AnonymousInstallationClaimCompletion = Readonly<{
  outcome: "connected" | "unknown" | "expired" | "conflict";
  profileId: string | null;
  idempotent: boolean;
}>;

export class AnonymousInstallationClaimError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AnonymousInstallationClaimError";
    this.code = code;
  }
}

/**
 * The plugin may call this only after its local installer-receipt verification
 * passed. The server deliberately accepts no device, account, license, payment,
 * or entitlement fields, and treats both hashes only as Customer 360 evidence.
 */
export function normalizeAnonymousInstallationClaimIdentity(
  input: unknown,
): ClaimIdentity {
  if (!isPlainObject(input)) fail("invalid_request", "Claim body must be an object.");
  if (
    Object.keys(input).length !== 2 ||
    !Object.hasOwn(input, "installIdHash") ||
    !Object.hasOwn(input, "installerReceiptIdHash")
  ) {
    fail("invalid_request", "Claim body contains unsupported fields.");
  }
  if (typeof input.installIdHash !== "string" || !LOWER_HEX_64.test(input.installIdHash)) {
    fail("invalid_customer_identity", "Install identity is invalid.");
  }
  if (
    typeof input.installerReceiptIdHash !== "string" ||
    !LOWER_HEX_64.test(input.installerReceiptIdHash)
  ) {
    fail("invalid_customer_identity", "Installer receipt identity is invalid.");
  }
  return Object.freeze({
    installIdHash: input.installIdHash,
    installerReceiptIdHash: input.installerReceiptIdHash,
  });
}

export function createAnonymousInstallationClaimNonce(
  input: ClaimIdentity & Readonly<{ namespace: Namespace }>,
  options: Readonly<{
    secret: string;
    now?: number | Date;
    randomBytes?: (size: number) => Uint8Array;
  }>,
): ClaimEnvelope & Readonly<{ nonce: string }> {
  const identity = normalizeAnonymousInstallationClaimIdentity({
    installIdHash: input.installIdHash,
    installerReceiptIdHash: input.installerReceiptIdHash,
  });
  const namespace = assertNamespace(input.namespace);
  const secret = validSecret(options.secret);
  const now = epochSeconds(options.now ?? Date.now());
  const expiresAt = now + ANONYMOUS_INSTALL_CLAIM_TTL_SECONDS;
  const randomBytes = options.randomBytes || nodeRandomBytes;
  const claimEntropy = Buffer.from(randomBytes(32));
  const iv = Buffer.from(randomBytes(12));
  const claimToken = claimEntropy.toString("base64url");
  if (claimEntropy.length !== 32 || !TOKEN.test(claimToken) || iv.length !== 12) {
    fail("claim_unavailable", "Installation claim entropy is invalid.");
  }
  const plaintext = Buffer.from(JSON.stringify({
    v: 1,
    claimToken,
    namespace,
    ...identity,
    issuedAt: now,
    expiresAt,
  }), "utf8");
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  cipher.setAAD(Buffer.from(ENCRYPTION_CONTEXT, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const unsigned = [
    VERSION,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
  const nonce = `${unsigned}.${sign(unsigned, secret)}`;
  if (nonce.length > 1024) fail("claim_unavailable", "Installation claim is too large.");
  return Object.freeze({
    nonce,
    claimToken,
    namespace,
    ...identity,
    issuedAt: now,
    expiresAt,
  });
}

export function verifyAnonymousInstallationClaimNonce(
  nonce: unknown,
  options: Readonly<{
    secret: string;
    namespace: Namespace;
    now?: number | Date;
  }>,
): ClaimEnvelope {
  const secret = validSecret(options.secret);
  const namespace = assertNamespace(options.namespace);
  const now = epochSeconds(options.now ?? Date.now());
  if (typeof nonce !== "string" || nonce.length > 1024 || !/^[A-Za-z0-9_.-]+$/.test(nonce)) {
    fail("invalid_claim", "Installation claim is invalid.");
  }
  const parts = nonce.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION || parts.slice(1).some((part) => !BASE64URL.test(part))) {
    fail("invalid_claim", "Installation claim is invalid.");
  }
  const [version, ivValue, ciphertextValue, tagValue, signatureValue] = parts;
  const unsigned = [version, ivValue, ciphertextValue, tagValue].join(".");
  const expected = Buffer.from(sign(unsigned, secret), "base64url");
  let supplied: Buffer;
  try {
    supplied = decodeCanonicalBase64Url(signatureValue);
  } catch {
    fail("invalid_claim", "Installation claim signature is invalid.");
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    fail("invalid_claim", "Installation claim signature is invalid.");
  }

  let decoded: unknown;
  try {
    const iv = decodeCanonicalBase64Url(ivValue);
    const tag = decodeCanonicalBase64Url(tagValue);
    if (iv.length !== 12 || tag.length !== 16) throw new Error("invalid envelope");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), iv);
    decipher.setAAD(Buffer.from(ENCRYPTION_CONTEXT, "utf8"));
    decipher.setAuthTag(tag);
    decoded = JSON.parse(Buffer.concat([
      decipher.update(decodeCanonicalBase64Url(ciphertextValue)),
      decipher.final(),
    ]).toString("utf8"));
  } catch {
    fail("invalid_claim", "Installation claim payload is invalid.");
  }
  if (!isPlainObject(decoded) || !hasExactKeys(decoded, [
    "v", "claimToken", "namespace", "installIdHash", "installerReceiptIdHash",
    "issuedAt", "expiresAt",
  ])) {
    fail("invalid_claim", "Installation claim payload is invalid.");
  }
  const identity = normalizeAnonymousInstallationClaimIdentity({
    installIdHash: decoded.installIdHash,
    installerReceiptIdHash: decoded.installerReceiptIdHash,
  });
  const issuedAt = epochSeconds(decoded.issuedAt);
  const expiresAt = epochSeconds(decoded.expiresAt);
  if (
    decoded.v !== 1 || decoded.namespace !== namespace ||
    typeof decoded.claimToken !== "string" || !TOKEN.test(decoded.claimToken) ||
    issuedAt > now || expiresAt <= issuedAt ||
    expiresAt - issuedAt !== ANONYMOUS_INSTALL_CLAIM_TTL_SECONDS
  ) {
    fail("invalid_claim", "Installation claim payload is invalid.");
  }
  if (expiresAt <= now) fail("claim_expired", "Installation claim has expired.");
  return Object.freeze({
    claimToken: decoded.claimToken,
    namespace,
    ...identity,
    issuedAt,
    expiresAt,
  });
}

export function buildAnonymousInstallationClaimUrl(origin: string, nonce: string): string {
  if (typeof nonce !== "string" || nonce.length > 1024 || !/^[A-Za-z0-9_.-]+$/.test(nonce)) {
    fail("invalid_claim", "Installation claim is invalid.");
  }
  const base = new URL(origin);
  const localHttp = base.protocol === "http:" &&
    (base.hostname === "localhost" || base.hostname === "127.0.0.1");
  if (
    (base.protocol !== "https:" && !localHttp) || base.username || base.password ||
    base.pathname !== "/" || base.search || base.hash
  ) {
    fail("invalid_origin", "Installation claim origin is invalid.");
  }
  const url = new URL("/api/installation/claim-complete", base);
  url.searchParams.set("nonce", nonce);
  return url.toString();
}

export async function createAnonymousInstallationClaim(
  input: unknown,
  dependencies: Dependencies = {},
): Promise<AnonymousInstallationClaim> {
  const identity = normalizeAnonymousInstallationClaimIdentity(input);
  const now = new Date(epochSeconds(dependencies.now ?? Date.now()) * 1000);
  return withTransaction(dependencies, async (client, namespace, secret) => {
    const envelope = createAnonymousInstallationClaimNonce({ ...identity, namespace }, {
      secret,
      now,
      randomBytes: dependencies.randomBytes,
    });
    const tokenHash = sha256(envelope.claimToken);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `sidestream_anonymous_install_claim:${namespace}:${tokenHash}`,
    ]);
    const result = await client.query<{ id: string }>(
      `
        insert into public.sidestream_anonymous_acquisition_sessions (
          license_namespace, token_hash, first_touch_source, first_touch_medium,
          first_touch_campaign, attribution_confidence, first_seen_at,
          expires_at, retained_until
        ) values ($1, $2, 'direct', $3, 'server_claim_v1', 'direct', $4, $5, $6)
        on conflict (license_namespace, token_hash) do nothing
        returning id
      `,
      [
        namespace,
        tokenHash,
        CLAIM_MARKER_MEDIUM,
        now,
        new Date(envelope.expiresAt * 1000),
        new Date(envelope.expiresAt * 1000 + 24 * 60 * 60 * 1000),
      ],
    );
    if (!result.rows[0]) fail("claim_unavailable", "Installation claim could not be created.");
    return Object.freeze({
      nonce: envelope.nonce,
      expiresAt: new Date(envelope.expiresAt * 1000).toISOString(),
    });
  });
}

export async function completeAnonymousInstallationClaim(
  input: Readonly<{ nonce: string; acquisitionToken: string }>,
  dependencies: Dependencies = {},
): Promise<AnonymousInstallationClaimCompletion> {
  if (!isPlainObject(input) || !hasExactKeys(input, ["nonce", "acquisitionToken"])) {
    fail("invalid_request", "Installation claim completion is invalid.");
  }
  if (typeof input.acquisitionToken !== "string" || !TOKEN.test(input.acquisitionToken)) {
    return completion("unknown");
  }
  const now = new Date(epochSeconds(dependencies.now ?? Date.now()) * 1000);
  return withTransaction(dependencies, async (client, namespace, secret) => {
    const envelope = verifyAnonymousInstallationClaimNonce(input.nonce, {
      secret,
      namespace,
      now,
    });
    const claimTokenHash = sha256(envelope.claimToken);
    const acquisitionTokenHash = sha256(input.acquisitionToken);
    for (const lockKey of [
      `sidestream_anonymous_acquisition:${namespace}:${acquisitionTokenHash}`,
      `sidestream_anonymous_install_claim:${namespace}:${claimTokenHash}`,
    ].sort()) {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [lockKey]);
    }

    const rows = await client.query<AcquisitionRow>(
      `
        select id, token_hash, first_touch_source, first_touch_medium,
          first_touch_campaign, first_seen_at,
          first_installer_requested_at, claim_state, claimed_profile_id,
          expires_at
        from public.sidestream_anonymous_acquisition_sessions
        where license_namespace = $1 and token_hash = any($2::text[])
        order by token_hash
        for update
      `,
      [namespace, [claimTokenHash, acquisitionTokenHash]],
    );
    const claim = rows.rows.find((row) => row.token_hash === claimTokenHash);
    const acquisition = rows.rows.find((row) => row.token_hash === acquisitionTokenHash);
    if (!claim || !isClaimMarker(claim)) return completion("unknown");
    if (new Date(claim.expires_at).getTime() <= now.getTime()) return completion("expired");
    if (!acquisition || isClaimMarker(acquisition)) return completion("unknown");
    if (
      new Date(acquisition.expires_at).getTime() <= now.getTime() ||
      acquisition.claim_state === "expired"
    ) return completion("unknown");
    if (claim.claim_state === "quarantined" || acquisition.claim_state === "quarantined") {
      return completion("conflict");
    }

    await lockIdentityEvidence(client, namespace, envelope);
    const ownerIds = await findIdentityOwners(client, namespace, envelope);
    if (ownerIds.size > 1) {
      await quarantineSessions(client, namespace, [claim, acquisition], "identity_owner_conflict");
      return completion("conflict");
    }
    const existingOwner = [...ownerIds][0] || null;

    if (claim.claimed_profile_id) {
      const exactReplay = Boolean(
        acquisition.claimed_profile_id === claim.claimed_profile_id &&
        (!existingOwner || existingOwner === claim.claimed_profile_id),
      );
      if (exactReplay) {
        return completion("connected", claim.claimed_profile_id, true);
      }
      await recordSessionConflict(client, namespace, claim, "nonce_reuse");
      if (!acquisition.claimed_profile_id) {
        await quarantineSessions(client, namespace, [acquisition], "nonce_reuse");
      }
      return completion("conflict");
    }
    if (claim.claim_state !== "unclaimed") return completion("conflict");
    if (acquisition.claimed_profile_id && existingOwner !== acquisition.claimed_profile_id) {
      await quarantineSessions(client, namespace, [claim, acquisition], "profile_owner_conflict");
      return completion("conflict");
    }

    await client.query("savepoint sidestream_anonymous_install_claim_identity");
    let profileId = existingOwner || acquisition.claimed_profile_id;
    try {
      if (!profileId) {
        const inserted = await client.query<{ id: string }>(
          `
            insert into public.sidestream_customer_profiles (
              license_namespace, created_at, updated_at
            ) values ($1, transaction_timestamp(), transaction_timestamp())
            returning id
          `,
          [namespace],
        );
        profileId = inserted.rows[0]?.id || null;
      }
      if (!profileId) throw new Error("Customer profile insert did not return an ID");
      await attachIdentityEvidence(client, namespace, profileId, envelope);
      const attachedOwners = await findIdentityOwners(client, namespace, envelope);
      if (attachedOwners.size !== 1 || !attachedOwners.has(profileId)) {
        throw new ClaimOwnershipConflict();
      }
      await client.query("release savepoint sidestream_anonymous_install_claim_identity");
    } catch (error) {
      await client.query("rollback to savepoint sidestream_anonymous_install_claim_identity");
      await client.query("release savepoint sidestream_anonymous_install_claim_identity");
      if (error instanceof ClaimOwnershipConflict || isUniqueConflict(error)) {
        await quarantineSessions(client, namespace, [claim, acquisition], "identity_attach_conflict");
        return completion("conflict");
      }
      throw error;
    }

    const claimedAt = (await client.query<{ claimed_at: Date | string }>(
      "select transaction_timestamp() as claimed_at",
    )).rows[0]?.claimed_at;
    if (!claimedAt || !profileId) throw new Error("Installation claim timestamp was unavailable");
    const claimUpdate = await client.query(
      `
        update public.sidestream_anonymous_acquisition_sessions
        set claim_state = 'claimed', claimed_profile_id = $3, claimed_at = $4,
          updated_at = $4
        where license_namespace = $1 and id = $2
          and claim_state = 'unclaimed' and claimed_profile_id is null
          and expires_at > $4
      `,
      [namespace, claim.id, profileId, claimedAt],
    );
    const acquisitionUpdate = acquisition.claimed_profile_id === profileId
      ? { rowCount: 1 }
      : await client.query(
          `
            update public.sidestream_anonymous_acquisition_sessions
            set claim_state = 'claimed', claimed_profile_id = $3, claimed_at = $4,
              updated_at = $4
            where license_namespace = $1 and id = $2
              and claim_state = 'unclaimed' and claimed_profile_id is null
              and expires_at > $4
          `,
          [namespace, acquisition.id, profileId, claimedAt],
        );
    if (claimUpdate.rowCount !== 1 || acquisitionUpdate.rowCount !== 1) {
      throw new Error("Installation claim state changed while locked");
    }
    return completion("connected", profileId, false);
  });
}

function completion(
  outcome: AnonymousInstallationClaimCompletion["outcome"],
  profileId: string | null = null,
  idempotent = false,
): AnonymousInstallationClaimCompletion {
  return Object.freeze({ outcome, profileId, idempotent });
}

function isClaimMarker(row: AcquisitionRow): boolean {
  return row.first_touch_source === "direct" &&
    row.first_touch_medium === CLAIM_MARKER_MEDIUM &&
    row.first_touch_campaign === "server_claim_v1" &&
    new Date(row.expires_at).getTime() - new Date(row.first_seen_at).getTime() ===
      ANONYMOUS_INSTALL_CLAIM_TTL_SECONDS * 1000 &&
    row.first_installer_requested_at === null;
}

async function lockIdentityEvidence(
  client: PoolClient,
  namespace: Namespace,
  identity: ClaimIdentity,
): Promise<void> {
  const evidence = [
    ["install_identity_hash", identity.installIdHash],
    ["installer_receipt_hash", identity.installerReceiptIdHash],
  ] as const;
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `sidestream_customer_profile_merge:${namespace}`,
  ]);
  for (const [type, value] of evidence) {
    const evidenceHash = sha256(`${type}:${value}`);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `sidestream_customer_identity:${namespace}:${type}:${evidenceHash}`,
    ]);
  }
}

async function findIdentityOwners(
  client: PoolClient,
  namespace: Namespace,
  identity: ClaimIdentity,
): Promise<Set<string>> {
  const result = await client.query<{ profile_id: string }>(
    `
      select distinct owner.profile_id
      from (
        select link.profile_id
        from public.sidestream_customer_identity_links link
        join public.sidestream_customer_profiles profile
          on profile.id = link.profile_id
          and profile.license_namespace = link.license_namespace
          and profile.merged_into is null
        where link.license_namespace = $1
          and (
            (link.link_type = 'install_identity_hash' and link.link_value = $2)
            or (link.link_type = 'installer_receipt_hash' and link.link_value = $3)
          )
        union all
        select install.profile_id
        from public.sidestream_customer_installs install
        join public.sidestream_customer_profiles profile
          on profile.id = install.profile_id
          and profile.license_namespace = install.license_namespace
          and profile.merged_into is null
        where install.license_namespace = $1 and install.install_id_hash = $2
      ) owner
    `,
    [namespace, identity.installIdHash, identity.installerReceiptIdHash],
  );
  return new Set(result.rows.map((row) => row.profile_id));
}

async function attachIdentityEvidence(
  client: PoolClient,
  namespace: Namespace,
  profileId: string,
  identity: ClaimIdentity,
): Promise<void> {
  await client.query(
    `
      insert into public.sidestream_customer_identity_links (
        profile_id, license_namespace, link_type, link_value, created_at
      ) values
        ($1, $2, 'install_identity_hash', $3, transaction_timestamp()),
        ($1, $2, 'installer_receipt_hash', $4, transaction_timestamp())
      on conflict do nothing
    `,
    [profileId, namespace, identity.installIdHash, identity.installerReceiptIdHash],
  );
  await client.query(
    `
      insert into public.sidestream_customer_installs (
        profile_id, license_namespace, install_id_hash,
        first_seen_at, last_seen_at
      ) values ($1, $2, $3, transaction_timestamp(), transaction_timestamp())
      on conflict (license_namespace, install_id_hash) do nothing
    `,
    [profileId, namespace, identity.installIdHash],
  );
}

async function quarantineSessions(
  client: PoolClient,
  namespace: Namespace,
  sessions: readonly AcquisitionRow[],
  reason: string,
): Promise<void> {
  for (const session of sessions) {
    await recordSessionConflict(client, namespace, session, reason);
    if (session.claim_state !== "claimed") {
      await client.query(
        `
          update public.sidestream_anonymous_acquisition_sessions
          set claim_state = 'quarantined',
            quarantined_at = coalesce(quarantined_at, transaction_timestamp()),
            updated_at = transaction_timestamp()
          where license_namespace = $1 and id = $2
        `,
        [namespace, session.id],
      );
    }
  }
}

async function recordSessionConflict(
  client: PoolClient,
  namespace: Namespace,
  session: AcquisitionRow,
  reason: string,
): Promise<void> {
  await client.query(
    `
      insert into public.sidestream_anonymous_acquisition_conflicts (
        session_id, license_namespace, conflict_type, evidence_hash
      ) values ($1, $2, 'profile_claim', $3)
      on conflict (session_id, conflict_type, evidence_hash) do nothing
    `,
    [
      session.id,
      namespace,
      sha256(`${CONFLICT_CONTEXT}:${reason}:${session.token_hash}`),
    ],
  );
}

async function withTransaction<T>(
  dependencies: Dependencies,
  callback: (client: PoolClient, namespace: Namespace, secret: string) => Promise<T>,
): Promise<T> {
  const secret = validSecret(
    dependencies.secret ?? process.env[ANONYMOUS_INSTALL_CLAIM_SECRET_NAME] ?? "",
  ).toString("utf8");
  if (dependencies.transaction || dependencies.namespace) {
    if (!dependencies.transaction || !dependencies.namespace) {
      throw new Error("Installation claim test dependencies require transaction and namespace together");
    }
    const namespace = assertNamespace(dependencies.namespace);
    return dependencies.transaction((client) => callback(client, namespace, secret));
  }
  const environment = dependencies.environment || (await import("./license-environment.js"))
    .resolveLicenseEnvironment({ serverEnv: process.env });
  if (!environment) fail("claim_unavailable", "Installation claim environment is unavailable.");
  const namespace = assertNamespace(environment.namespace);
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
      const result = await callback(client, namespace, secret);
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

function encryptionKey(secret: Buffer): Buffer {
  return createHash("sha256").update(ENCRYPTION_CONTEXT, "utf8").update(secret).digest();
}

function sign(unsigned: string, secret: Buffer): string {
  return createHmac("sha256", secret)
    .update(`${SIGNATURE_CONTEXT}:${unsigned}`, "utf8")
    .digest("base64url");
}

function decodeCanonicalBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error("noncanonical base64url");
  return decoded;
}

function validSecret(value: unknown): Buffer {
  if (typeof value !== "string") fail("claim_unavailable", "Installation claim secret is missing.");
  const secret = Buffer.from(value, "utf8");
  if (secret.length < 32 || secret.length > 512) {
    fail("claim_unavailable", "Installation claim secret is invalid.");
  }
  return secret;
}

function epochSeconds(value: unknown): number {
  const result = value instanceof Date
    ? Math.floor(value.getTime() / 1000)
    : typeof value === "number" && value > 10_000_000_000
      ? Math.floor(value / 1000)
      : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) {
    fail("invalid_claim", "Installation claim timestamp is invalid.");
  }
  return result;
}

function assertNamespace(value: unknown): Namespace {
  if (value !== "production" && value !== "test") {
    fail("claim_unavailable", "Installation claim namespace is unavailable.");
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function isUniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

class ClaimOwnershipConflict extends Error {}

function fail(code: string, message: string): never {
  throw new AnonymousInstallationClaimError(code, message);
}

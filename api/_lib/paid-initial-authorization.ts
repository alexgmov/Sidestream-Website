import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import type { PoolClient } from "pg";
import { parsePaidReleaseManifest } from "./paid-release-manifest.js";

export const INITIAL_SCOPE = "sidestream-paid-initial-production-1";
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
export type InitialTarget = { id: string; sha256: string; manifestSha256: string; version: string };
export type InitialEnvelope = { payload: string; signature: string };
export type InitialRequest = {
  lineage: string; target: InitialTarget; receiptBytes: string; installIdHash: string;
};
export const initialHash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function object(value: unknown, fields: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) throw new Error("invalid_initial_request");
}
function base64(value: unknown, max: number, length?: number) {
  if (typeof value !== "string" || value.length > max * 2) throw new Error("invalid_initial_encoding");
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > max || bytes.toString("base64") !== value ||
      (length !== undefined && bytes.length !== length)) throw new Error("invalid_initial_encoding");
  return bytes;
}
function target(value: unknown): asserts value is InitialTarget {
  object(value, ["id", "sha256", "manifestSha256", "version"]);
  if (![value.id, value.sha256, value.manifestSha256, value.version].every(v => typeof v === "string") ||
      !ID.test(value.id) || !HASH.test(value.sha256) || !HASH.test(value.manifestSha256) ||
      value.version.length > 80 || !VERSION.test(value.version)) throw new Error("invalid_initial_target");
}
function publicPin(value: string) {
  return createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), base64(value, 32, 32)]), format: "der", type: "spki" });
}
function rawKey(key: KeyObject) { return key.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"); }
function signedJSON(envelope: unknown, key: KeyObject) {
  object(envelope, ["payload", "signature"]);
  const payload = base64(envelope.payload, 65536), signature = base64(envelope.signature, 64, 64);
  if (!verify(null, payload, key, signature)) throw new Error("invalid_initial_signature");
  return JSON.parse(payload.toString("utf8"));
}

// This independent offline-signed allowlist is the only source of initial targets.
// Merely putting a target in a request or in the updater catalog never authorizes issuance.
export function loadInitialAuthority(env: NodeJS.ProcessEnv) {
  if (env.SIDESTREAM_PAID_INITIAL_ENABLED !== "qualification") throw new Error("initial_authority_disabled");
  const release = publicPin(env.SIDESTREAM_PAID_INITIAL_RELEASE_KEY || "");
  const key = createPrivateKey(env.SIDESTREAM_PAID_INITIAL_PRIVATE_KEY || "");
  if (key.asymmetricKeyType !== "ed25519") throw new Error("invalid_initial_key");
  const pin = rawKey(createPublicKey(key));
  const pins = [pin, rawKey(release), env.SIDESTREAM_PAID_INITIAL_POLICY_KEY, env.SIDESTREAM_PAID_INITIAL_CONTINUATION_KEY];
  pins.forEach(value => publicPin(value || ""));
  if (new Set(pins).size !== 4) throw new Error("initial_key_role_conflict");
  const catalog = signedJSON(JSON.parse(env.SIDESTREAM_PAID_INITIAL_CATALOG || "null"), release);
  object(catalog, ["schema", "scope", "initialKey", "targets"]);
  if (catalog.schema !== "sidestream.paid-initial-catalog.v1" || catalog.scope !== INITIAL_SCOPE ||
      catalog.initialKey !== pin || !Array.isArray(catalog.targets) || !catalog.targets.length || catalog.targets.length > 32) throw new Error("invalid_initial_catalog");
  const lineages = new Set();
  for (const entry of catalog.targets) {
    object(entry, ["lineage", "target"]); target(entry.target);
    if (typeof entry.lineage !== "string" || !ID.test(entry.lineage) || lineages.has(entry.lineage)) throw new Error("invalid_initial_lineage");
    lineages.add(entry.lineage);
  }
  // Qualification remains restricted to explicitly selected existing purchases.
  const accounts = (env.SIDESTREAM_PAID_INITIAL_QUALIFICATION_ACCOUNTS || "").split(",");
  if (!accounts.length || accounts.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) throw new Error("initial_qualification_required");
  return { key, pin, targets: catalog.targets as {lineage: string; target: InitialTarget}[], accounts };
}
export type InitialAuthority = ReturnType<typeof loadInitialAuthority>;

export function qualificationInitialArtifact(env: NodeJS.ProcessEnv, accountId: string) {
  const authority = loadInitialAuthority(env);
  if (!authority.accounts.includes(accountId)) throw new Error("initial_not_authorized");
  const value = signedJSON(JSON.parse(env.SIDESTREAM_PAID_INITIAL_ARTIFACT || "null"), publicPin(env.SIDESTREAM_PAID_INITIAL_RELEASE_KEY || ""));
  object(value, ["schema", "scope", "lineage", "manifest"]);
  const manifest = parsePaidReleaseManifest(value.manifest, "macos-universal");
  if (value.schema !== "sidestream.paid-initial-artifact.v1" || value.scope !== INITIAL_SCOPE ||
      !authority.targets.some(entry => entry.lineage === value.lineage && entry.target.version === manifest.version) ||
      !manifest.artifactPathname.startsWith("sidestream/qualification/")) throw new Error("initial_artifact_not_authorized");
  return manifest;
}

export function prepareInitialAuthorization(input: unknown, authority: InitialAuthority) {
  object(input, ["lineage", "target", "receiptBytes", "installIdHash"]); target(input.target);
  if (typeof input.installIdHash !== "string" || !HASH.test(input.installIdHash) ||
      !authority.targets.some(entry => entry.lineage === input.lineage &&
        ["id", "sha256", "manifestSha256", "version"].every(k => entry.target[k as keyof InitialTarget] === input.target[k]))) throw new Error("initial_target_not_authorized");
  const receiptBytes = base64(input.receiptBytes, 65536), receipt = JSON.parse(receiptBytes.toString("utf8"));
  if (!receipt || receipt.schemaVersion !== "sidestream_installer_receipt_v2" || receipt.receiptCommitMode !== "atomic_replace" ||
      receipt.osPlatform !== "darwin" || receipt.buildChannel !== "production" || receipt.onboardingChannel !== "paid-onboarding" ||
      receipt.receiptIssuer !== "macos_installer_package" || receipt.packageIdentifier !== "com.sidestream.downloader.pkg" ||
      receipt.installMethod !== "mac_native_pkg" || typeof receipt.installerReceiptIdHash !== "string" || !HASH.test(receipt.installerReceiptIdHash) ||
      receipt.packageVersion !== input.target.version || receipt.verification?.status !== "passed" ||
      receipt.verification.expectedVersion !== receipt.packageVersion || receipt.verification.installedVersion !== receipt.packageVersion) throw new Error("invalid_initial_receipt");
  const acquisition = { receiptSha256: initialHash(receiptBytes), installIdHash: input.installIdHash, version: receipt.packageVersion,
    platform: "darwin", buildChannel: "production", onboardingChannel: "paid-onboarding", bundleId: "com.sidestream.downloader",
    extensionId: "com.sidestream.downloader.panel", packageIdentifier: receipt.packageIdentifier, receiptIssuer: receipt.receiptIssuer,
    installMethod: receipt.installMethod, receiptSource: "mac_system_application_support" };
  const proof = { schema: "sidestream.paid-initial.v1", scope: INITIAL_SCOPE, lineage: input.lineage, acquisition, target: input.target };
  const payload = Buffer.from(JSON.stringify(proof));
  return { proof, receiptIdHash: receipt.installerReceiptIdHash as string, payload, requestHash: initialHash(payload) };
}

// Caller owns the transaction. No certificate is returned until COMMIT succeeds.
// The normal device lock and locked payment/license rows serialize revocation and issuance.
export async function issueInitialAuthorization(client: Pick<PoolClient, "query">, input: unknown,
  authority: InitialAuthority, credential: { tokenHash: string; deviceIdHash: string }) {
  const prepared = prepareInitialAuthorization(input, authority);
  const lookup = await client.query<{account_id: string}>("select account_id from public.sidestream_license_tokens where token_hash = $1", [credential.tokenHash]);
  if (lookup.rows.length !== 1 || !authority.accounts.includes(lookup.rows[0].account_id)) throw new Error("initial_not_authorized");
  const accountId = lookup.rows[0].account_id;
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [`sidestream:device-support:${accountId}:production`]);
  const selected = await client.query<{activation_id: string; account_id: string; license_id: string; checkout_id: string}>(`
    select t.activation_session_id as activation_id, t.account_id, t.license_id, p.id as checkout_id
    from public.sidestream_license_tokens t
    join public.sidestream_licenses l on l.id = t.license_id and l.account_id = t.account_id
    join public.sidestream_activation_sessions a on a.id = t.activation_session_id and a.account_id = t.account_id and a.license_id = l.id
    join public.sidestream_paid_activation_installation_identity i on i.activation_id = a.id and i.license_namespace = 'production'
    join public.sidestream_paid_acquisition_checkouts p on p.environment = 'production'
      and p.verified_checkout_session_ref = l.stripe_checkout_session_id
      and (l.stripe_payment_intent_id is null or l.stripe_payment_intent_id = p.canonical_payment_ref)
    join public.sidestream_paid_acquisition_claims c on c.checkout_id = p.id and c.environment = 'production'
      and c.account_ref = t.account_id and c.entitlement_ref = l.id
    join public.sidestream_account_devices d on d.account_id = t.account_id and d.license_namespace = 'production'
      and d.device_id_hash = t.device_id_hash and d.revoked_at is null and d.active_slot = 1
    where t.token_hash = $1 and t.account_id = $2 and t.device_id_hash = $3 and t.revoked_at is null and t.expires_at > now()
      and i.install_id_hash = $4 and i.installer_receipt_id_hash = $5
      and a.device_id_hash = t.device_id_hash and a.app_version = $6
      and a.completed_at is not null and a.source = 'paid-acquisition-mc-v1' and a.build_channel = 'production'
      and l.entitlement_status = 'active' and l.status = 'active' and l.plan_key in ('sidestream_pro', 'sidestream_unlimited')
      and p.payment_state = 'active' and p.claim_state = 'claimed' and c.claim_state = 'claimed'
      and p.verified_checkout_session_ref is not null and p.canonical_payment_ref = c.canonical_payment_ref
      and p.verified_quantity = 1 and p.verified_product_ref is not null and p.verified_price_ref is not null
    for update of t, l, a, p, c, d`,
    [credential.tokenHash, accountId, credential.deviceIdHash, prepared.proof.acquisition.installIdHash, prepared.receiptIdHash, prepared.proof.target.version]);
  if (selected.rows.length !== 1) throw new Error("initial_not_authorized");
  const owner = selected.rows[0];
  const envelope = { payload: prepared.payload.toString("base64"), signature: sign(null, prepared.payload, authority.key).toString("base64") };
  const stored = await client.query<{request_sha256: string; envelope: InitialEnvelope; account_id: string}>(`
    insert into public.sidestream_paid_initial_authorizations
      (activation_id, account_id, license_id, checkout_id, install_id_hash, installer_receipt_id_hash, receipt_sha256,
       lineage, target_sha256, target_manifest_sha256, request_sha256, key_sha256, envelope)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
    on conflict (install_id_hash, installer_receipt_id_hash, lineage) do nothing
    returning request_sha256, envelope, account_id`,
    [owner.activation_id, owner.account_id, owner.license_id, owner.checkout_id, prepared.proof.acquisition.installIdHash,
      prepared.receiptIdHash, prepared.proof.acquisition.receiptSha256, prepared.proof.lineage, prepared.proof.target.sha256,
      prepared.proof.target.manifestSha256, prepared.requestHash, initialHash(Buffer.from(authority.pin, "base64")), JSON.stringify(envelope)]);
  const replay = stored.rows.length ? stored : await client.query<{request_sha256: string; envelope: InitialEnvelope; account_id: string}>(`
    select request_sha256, envelope, account_id from public.sidestream_paid_initial_authorizations
    where install_id_hash = $1 and installer_receipt_id_hash = $2 and lineage = $3`,
    [prepared.proof.acquisition.installIdHash, prepared.receiptIdHash, prepared.proof.lineage]);
  if (replay.rows.length !== 1 || replay.rows[0].account_id !== accountId || replay.rows[0].request_sha256 !== prepared.requestHash ||
      JSON.stringify(signedJSON(replay.rows[0].envelope, createPublicKey(authority.key))) !== JSON.stringify(prepared.proof)) throw new Error("initial_issuance_conflict");
  return replay.rows[0].envelope;
}

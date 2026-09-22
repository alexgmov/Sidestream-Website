import { createHash, createPrivateKey, createPublicKey, sign, verify, X509Certificate } from "node:crypto";

export type Scope = { channel: "test" | "production"; platform: "darwin" | "win32"; arch: "arm64" | "x64"; flavor: "standard" | "paid-onboarding" };
export type Reference = { releaseId: string; sha256: string };
export type Target = Reference & { percent: number };
export type Activation = Target & { rollbackFrom: Reference | null; healthRollbackTo: Reference | null };
export type Envelope = { schema: "sidestream.signed.v1"; kind: "policy" | "release"; keyId: string; payload: string; signature: string };
export type Keys = Record<string, { certificate: string; roles: ("policy" | "release")[] }>;
export type Release = { schema: "sidestream.release.v1"; releaseId: string; version: string; scope: Scope;
  artifact: { sha256: string; sizeBytes: number; unpackedBytes: number; manifestSha256: string; filename: string };
  compatibility: { minOsVersion: string; helperProtocol: 1; engineProtocol: 1; hosts: { PPRO: { minMajor: 14; maxMajor: 99 } } } };
export type Policy = { schema: "sidestream.policy.v1"; scope: Scope; revision: number; issuedAt: number; expiresAt: number;
  hold: boolean; download: Target | null; activation: Activation | null; releases: Envelope[]; revoked: Reference[];
  audit: { operator: string; reason: string } };
export type Highwater = { revision: number; digest: string; lastTime: number; issuedAt: number };
export const POLICY_TTL = 900;

function assert(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}
export function exact(value: unknown, fields: string): asserts value is Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_object");
  assert(Object.keys(value).sort().join(" ") === fields.split(" ").sort().join(" "), "invalid_fields");
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  }
  const result = JSON.stringify(value);
  assert(result !== undefined, "invalid_json");
  // Match Python ensure_ascii for signed cross-platform wire bytes.
  return result.replace(/[\u007f-\uffff]/g, character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
}
export function sha256(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
function integer(value: unknown, min: number, max: number) { assert(Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max, "invalid_integer"); }
export function hash(value: unknown): asserts value is string { assert(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), "invalid_hash"); }
export function releaseId(value: unknown): asserts value is string { assert(typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value), "invalid_release_id"); }
function version(value: unknown) { assert(typeof value === "string" && /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(value), "invalid_version"); }
export function parseScope(value: unknown): Scope {
  exact(value, "channel platform arch flavor");
  assert(Object.values(value).every(item => typeof item === "string") &&
    ["test", "production"].includes(String(value.channel)) && ["darwin", "win32"].includes(String(value.platform)) &&
    ["arm64", "x64"].includes(String(value.arch)) && ["standard", "paid-onboarding"].includes(String(value.flavor)) &&
    !(value.platform === "win32" && value.arch !== "x64"), "invalid_scope");
  return value as Scope;
}
export function scopeKey(scope: Scope) { return [scope.channel, scope.platform, scope.arch, scope.flavor].join("/"); }
export function artifactPath(release: Release) { return `staged-updates/${scopeKey(release.scope)}/${release.artifact.filename}`; }
function decoded(value: unknown, limit: number): Buffer {
  assert(typeof value === "string" && value.length <= Math.ceil(limit / 3) * 4, "invalid_encoding");
  const data = Buffer.from(value, "base64");
  assert(data.length <= limit && data.toString("base64") === value, "invalid_encoding");
  return data;
}
export function openEnvelope(envelope: unknown, kind: Envelope["kind"], keys: Keys): unknown {
  exact(envelope, "schema kind keyId payload signature");
  assert(envelope.schema === "sidestream.signed.v1" && envelope.kind === kind && typeof envelope.keyId === "string", "signature_domain");
  const key = keys[envelope.keyId];
  assert(key && key.roles.includes(kind), "untrusted_publisher");
  const publicKey = new X509Certificate(key.certificate).publicKey;
  assert(publicKey.asymmetricKeyType === "rsa" && (publicKey.asymmetricKeyDetails?.modulusLength || 0) >= 3072, "weak_key");
  const payload = decoded(envelope.payload, 262144);
  assert(verify("RSA-SHA256", payload, publicKey, decoded(envelope.signature, 512)), "bad_signature");
  const value: unknown = JSON.parse(payload.toString("utf8"));
  assert(canonical(value) === payload.toString("utf8"), "noncanonical_payload");
  return value;
}
export function signEnvelope(value: unknown, kind: Envelope["kind"], keyId: string, privatePem: string, keys: Keys): Envelope {
  const key = keys[keyId];
  assert(key && key.roles.includes(kind), "untrusted_publisher");
  const privateKey = createPrivateKey(privatePem);
  const expected = new X509Certificate(key.certificate).publicKey.export({ type: "spki", format: "der" });
  assert(createPublicKey(privateKey).export({ type: "spki", format: "der" }).equals(expected), "signer_mismatch");
  const payload = Buffer.from(canonical(value));
  const envelope: Envelope = { schema: "sidestream.signed.v1", kind, keyId, payload: payload.toString("base64"), signature: sign("RSA-SHA256", payload, privateKey).toString("base64") };
  openEnvelope(envelope, kind, keys);
  return envelope;
}
export function parseRelease(value: unknown, expected: Scope): Release {
  exact(value, "schema releaseId version scope artifact compatibility");
  assert(value.schema === "sidestream.release.v1" && scopeKey(parseScope(value.scope)) === scopeKey(expected), "release_scope");
  releaseId(value.releaseId); version(value.version);
  const artifact = value.artifact;
  exact(artifact, "sha256 sizeBytes unpackedBytes manifestSha256 filename");
  hash(artifact.sha256); hash(artifact.manifestSha256);
  integer(artifact.sizeBytes, 1, 512 * 1024 * 1024); integer(artifact.unpackedBytes, 1, 1536 * 1024 * 1024);
  assert(artifact.filename === value.releaseId + "-" + artifact.sha256 + ".zip", "mutable_artifact_name");
  const compatibility = value.compatibility;
  exact(compatibility, "minOsVersion helperProtocol engineProtocol hosts"); version(compatibility.minOsVersion);
  assert(compatibility.helperProtocol === 1 && compatibility.engineProtocol === 1 && canonical(compatibility.hosts) === canonical({ PPRO: { minMajor: 14, maxMajor: 99 } }), "incompatible_protocol");
  return value as Release;
}
function reference(value: unknown) { exact(value, "releaseId sha256"); releaseId(value.releaseId); hash(value.sha256); }
function target(value: unknown, activation: boolean) {
  if (value === null) return;
  exact(value, activation ? "releaseId sha256 percent rollbackFrom healthRollbackTo" : "releaseId sha256 percent");
  releaseId(value.releaseId); hash(value.sha256); integer(value.percent, 0, 100);
  if (activation) for (const field of ["rollbackFrom", "healthRollbackTo"]) if (value[field] !== null) reference(value[field]);
}
export function policyDigest(policy: Policy) {
  const { issuedAt: _issued, expiresAt: _expires, ...control } = policy;
  return sha256(canonical(control));
}
export function parsePolicy(value: unknown, keys: Keys, expected: Scope, now?: number, previous?: Highwater) {
  exact(value, "schema scope revision issuedAt expiresAt hold download activation releases revoked audit");
  assert(value.schema === "sidestream.policy.v1" && scopeKey(parseScope(value.scope)) === scopeKey(expected), "policy_scope");
  integer(value.revision, 1, Number.MAX_SAFE_INTEGER); integer(value.issuedAt, 1, Number.MAX_SAFE_INTEGER);
  integer(value.expiresAt, Number(value.issuedAt) + 1, Number(value.issuedAt) + POLICY_TTL);
  if (now !== undefined) assert(Number(value.issuedAt) <= now && now < Number(value.expiresAt), "policy_expired_or_future");
  assert(typeof value.hold === "boolean" && Array.isArray(value.releases) && value.releases.length <= 4, "invalid_policy");
  assert(Array.isArray(value.revoked) && value.revoked.length <= 100, "invalid_revocations");
  value.revoked.forEach(reference);
  exact(value.audit, "operator reason");
  for (const item of Object.values(value.audit)) assert(typeof item === "string" && /^[\x20-\x7e]{1,160}$/.test(item), "invalid_audit");
  const releases = new Map<string, Release>();
  for (const signed of value.releases) {
    const release = parseRelease(openEnvelope(signed, "release", keys), expected);
    assert(!releases.has(release.releaseId), "duplicate_release"); releases.set(release.releaseId, release);
  }
  target(value.download, false); target(value.activation, true);
  for (const candidate of [value.download, value.activation]) {
    if (candidate) { const t = candidate as Target; assert(releases.get(t.releaseId)?.artifact.sha256 === t.sha256, "target_hash_mismatch"); }
  }
  const policy = value as Policy, digest = policyDigest(policy);
  if (previous) {
    assert(now !== undefined && now >= previous.lastTime && policy.revision >= previous.revision && policy.issuedAt >= previous.issuedAt, "policy_replay_or_clock_rollback");
    assert(policy.revision !== previous.revision || digest === previous.digest, "policy_equivocation");
  }
  return { policy, releases, highwater: { revision: policy.revision, digest, lastTime: now ?? policy.issuedAt, issuedAt: policy.issuedAt } };
}
export function cohort(installation: string, scope: Scope, purpose: "download" | "activation", percent: number) {
  integer(percent, 0, 100);
  const data = createHash("sha256").update(canonical(["sidestream.cohort.v1", scope, purpose, installation])).digest();
  return data.readUInt32BE(0) % 10000 < percent * 100;
}
export function renewPolicy(envelope: Envelope, keys: Keys, scope: Scope, now: number, keyId: string, privateKey: string): Envelope {
  // The operator revision binds immutable control content. The online signer may
  // renew its short freshness lease, but cannot obtain new control from requests.
  const { policy } = parsePolicy(openEnvelope(envelope, "policy", keys), keys, scope);
  assert(now >= policy.issuedAt, "clock_rollback");
  return signEnvelope({ ...policy, issuedAt: now, expiresAt: now + POLICY_TTL }, "policy", keyId, privateKey, keys);
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { compileApiFixture } from "./helpers/compile-api-fixture.mjs";
import { operate } from "../scripts/manage-staged-updates.mjs";

let temporary, contract, handlers, privatePem, keys, release, policy;
const now = Math.floor(Date.now() / 1000);
const scope = { channel: "test", platform: "darwin", arch: "arm64", flavor: "standard" };
const scopeQuery = new URLSearchParams(scope).toString();
before(async () => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sidestream-staged-policy-"));
  fs.mkdirSync("node_modules/.tmp", { recursive: true });
  const compiled = path.resolve("node_modules/.tmp/staged-update-tests");
  compileApiFixture(["api/_lib/staged-updates.ts", "api/_lib/staged-update-handler.ts"], compiled);
  contract = await import(pathToFileURL(path.join(compiled, "api/_lib/staged-updates.js")));
  handlers = await import(pathToFileURL(path.join(compiled, "api/_lib/staged-update-handler.js")));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "1", "-subj", "/CN=Staged Policy Test Only", "-keyout", path.join(temporary, "private.pem"), "-out", path.join(temporary, "cert.pem")], { stdio: "ignore" });
  fs.chmodSync(path.join(temporary, "private.pem"), 0o600);
  privatePem = fs.readFileSync(path.join(temporary, "private.pem"), "utf8");
  keys = { fixture: { certificate: fs.readFileSync(path.join(temporary, "cert.pem"), "utf8"), roles: ["policy", "release"] } };
  const artifact = Buffer.from("fixture bytes, not a signed installer");
  const digest = contract.sha256(artifact);
  release = { schema: "sidestream.release.v1", releaseId: "release-b", version: "1.0.23", scope,
    artifact: { sha256: digest, sizeBytes: artifact.length, unpackedBytes: 100, manifestSha256: "a".repeat(64), filename: `release-b-${digest}.zip` },
    compatibility: { minOsVersion: "13.0.0", helperProtocol: 1, engineProtocol: 1, hosts: { PPRO: { minMajor: 14, maxMajor: 99 } } } };
  fs.writeFileSync(path.join(temporary, release.artifact.filename), artifact);
  const target = { releaseId: release.releaseId, sha256: digest, percent: 100 };
  policy = { schema: "sidestream.policy.v1", scope, revision: 1, issuedAt: now, expiresAt: now + 900,
    hold: true, download: target, activation: { ...target, percent: 0, rollbackFrom: null, healthRollbackTo: null },
    releases: [contract.signEnvelope(release, "release", "fixture", privatePem, keys)], revoked: [], audit: { operator: "test", reason: "automated fixture" } };
});
after(() => { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); });
function signed(value = policy) { return contract.signEnvelope(value, "policy", "fixture", privatePem, keys); }
function parse(value = policy, previous, at = now) { return contract.parsePolicy(value, keys, scope, at, previous); }
function response() {
  return { statusCode: 0, headers: {}, body: "", setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = value || ""; } };
}
function handler(mode, value = policy, extra = {}) {
  return handlers.createStagedUpdateHandler(mode, { enabled: () => true, now: () => now,
    catalog: () => ({ schema: "sidestream.staged-catalog.v1", keys, policies: { [contract.scopeKey(scope)]: signed(value) } }),
    signer: () => ({ keyId: "fixture", privateKey: privatePem }), artifactUrl: async () => "https://fixture.example/file.zip", ...extra });
}

test("publisher signature, key roles and exact schema are enforced", () => {
  assert.deepEqual(contract.openEnvelope(signed(), "policy", keys), policy);
  assert.throws(() => contract.openEnvelope({ ...signed(), signature: "AA==" }, "policy", keys), /bad_signature/);
  assert.throws(() => contract.openEnvelope(signed(), "release", keys), /signature_domain/);
  assert.throws(() => contract.openEnvelope(signed(), "policy", { fixture: { ...keys.fixture, roles: ["release"] } }), /untrusted_publisher/);
  assert.throws(() => parse({ ...policy, command: "run arbitrary executable" }), /invalid_fields/);
});
test("download and activation targets are independent and bound to immutable hashes", () => {
  const result = parse(); assert.equal(result.policy.download.percent, 100); assert.equal(result.policy.activation.percent, 0);
  assert.throws(() => parse({ ...policy, activation: { ...policy.activation, sha256: "0".repeat(64) } }), /target_hash_mismatch/);
  assert.throws(() => contract.parseRelease({ ...release, artifact: { ...release.artifact, filename: "latest.zip" } }, scope), /mutable_artifact_name/);
});
test("scope prevents cross-platform, Production and paid-flavor confusion", () => {
  for (const [field, value] of [["arch", "x64"], ["channel", "production"], ["flavor", "paid-onboarding"]]) {
    assert.throws(() => contract.parseRelease(release, { ...scope, [field]: value }), /release_scope/);
  }
  assert.throws(() => contract.parseScope({ ...scope, platform: "win32" }), /invalid_scope/);
});
test("expiry, future policy, replay, clock rollback and revision equivocation fail closed", () => {
  const { highwater } = parse();
  assert.throws(() => parse(policy, undefined, now + 900), /policy_expired_or_future/);
  assert.throws(() => parse(policy, undefined, now - 1), /policy_expired_or_future/);
  assert.throws(() => parse({ ...policy, hold: false }, highwater), /policy_equivocation/);
  assert.throws(() => parse(policy, { ...highwater, revision: 2 }), /policy_replay/);
  assert.throws(() => parse(policy, { ...highwater, lastTime: now + 1 }), /clock_rollback/);
});
test("renewal changes only freshness and retains the signed operator control digest", () => {
  const lease = contract.renewPolicy(signed(), keys, scope, now + 1200, "fixture", privatePem);
  const value = contract.openEnvelope(lease, "policy", keys);
  assert.equal(value.revision, 1); assert.equal(value.issuedAt, now + 1200); assert.equal(value.expiresAt, now + 2100);
  assert.equal(contract.policyDigest(value), contract.policyDigest(policy));
  parse(value, parse().highwater, now + 1200);
});
test("cohorts are stable, independent and grow without reshuffling", () => {
  const population = Array.from({ length: 1000 }, (_, index) => String(index));
  const download = population.filter(id => contract.cohort(id, scope, "download", 25));
  assert.notDeepEqual(download, population.filter(id => contract.cohort(id, scope, "activation", 25)));
  assert.ok(download.every(id => contract.cohort(id, scope, "download", 50)));
  assert.ok(population.every(id => !contract.cohort(id, scope, "download", 0) && contract.cohort(id, scope, "download", 100)));
});
test("HTTP stays disabled by default and cannot enable Production through the Test flag", async () => {
  let out = response(); await handler("policy", policy, { enabled: () => false })({ method: "GET", url: "/?" + scopeQuery }, out); assert.equal(out.statusCode, 503);
  out = response(); await handler("policy")({ method: "GET", url: "/?" + new URLSearchParams({ ...scope, channel: "production" }) }, out); assert.equal(out.statusCode, 404);
  out = response(); await handler("policy")({ method: "POST", url: "/?" + scopeQuery }, out); assert.equal(out.statusCode, 405);
});
test("HTTP serves only signed no-store policy and rejects duplicate/missing selectors", async () => {
  let out = response(); await handler("policy")({ method: "GET", url: "/?" + scopeQuery }, out);
  assert.equal(out.statusCode, 200); assert.equal(out.headers["Cache-Control"], "no-store");
  assert.equal(contract.openEnvelope(JSON.parse(out.body), "policy", keys).revision, 1);
  for (const query of [scopeQuery + "&arch=x64", scopeQuery + "&command=install", "channel=test"]) {
    out = response(); await handler("policy")({ method: "GET", url: "/?" + query }, out); assert.equal(out.statusCode, 400);
  }
});
test("held activation permits staging; revocation and zero download percentage refuse artifact URLs", async () => {
  const query = "/?" + scopeQuery + "&releaseId=" + release.releaseId + "&sha256=" + release.artifact.sha256;
  let out = response(); await handler("artifact")({ method: "GET", url: query }, out); assert.equal(out.statusCode, 307);
  for (const value of [{ ...policy, revoked: [{ releaseId: release.releaseId, sha256: release.artifact.sha256 }] }, { ...policy, download: { ...policy.download, percent: 0 } }]) {
    out = response(); await handler("artifact", value)({ method: "GET", url: query }, out); assert.equal(out.statusCode, 403);
  }
});
test("operator dry run is read-only; apply requires the signing key and exact release/hash confirmations", async () => {
  const catalog = path.join(temporary, "catalog.json"), input = path.join(temporary, "policy.json"), publicKeys = path.join(temporary, "keys.json");
  fs.writeFileSync(catalog, JSON.stringify({ schema: "sidestream.staged-catalog.v1", keys: {}, policies: {} }));
  fs.writeFileSync(input, JSON.stringify(policy)); fs.writeFileSync(publicKeys, JSON.stringify(keys));
  const options = { catalog, policy: input, keys: publicKeys, artifacts: temporary, "expected-revision": "0" };
  const before = fs.readFileSync(catalog);
  const dry = await operate(options); assert.equal(dry.apply, false); assert.deepEqual(fs.readFileSync(catalog), before);
  await assert.rejects(operate({ ...options, apply: true }), /confirmation_required/);
  const confirm = release.releaseId + ":" + release.artifact.sha256;
  await operate({ ...options, apply: true, "key-id": "fixture", "private-key": path.join(temporary, "private.pem"), "confirm-download": confirm, "confirm-activation": confirm });
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(catalog)).policies).length, 1);
  await assert.rejects(operate(options), /revision_conflict/);
});
test("Node-signed policy and cohort vectors verify in the real native-backed Python client", { skip: !process.env.SIDESTREAM_UPDATE_CORE }, () => {
  const fixture = { envelope: signed(), certificate: keys.fixture.certificate, expectedCohorts: ["one", "two", "three"].map(id => contract.cohort(id, scope, "activation", 50)) };
  const input = path.join(temporary, "cross.json"); fs.writeFileSync(input, JSON.stringify(fixture));
  const python = "import json,sys,pathlib,hashlib,subprocess;sys.path.insert(0,sys.argv[1]);from policy import Trust,check_policy,in_cohort;f=json.load(open(sys.argv[2]));p=pathlib.Path(sys.argv[2]).parent;p.joinpath('cross.pem').write_text(f['certificate']);subprocess.run(['openssl','x509','-in',str(p/'cross.pem'),'-outform','DER','-out',str(p/'cross.der')],check=True);t=Trust(sys.argv[3],{'fixture':{'certificate':str(p/'cross.der'),'sha256':hashlib.sha256((p/'cross.der').read_bytes()).hexdigest(),'roles':['policy','release']}},p);v,_,_=check_policy(f['envelope'],t,json.loads(sys.argv[4]),int(sys.argv[5]));assert [in_cohort(i,v['scope'],'activation',50) for i in ['one','two','three']]==f['expectedCohorts']";
  execFileSync("python3", ["-c", python, process.env.SIDESTREAM_UPDATE_CORE, input, process.env.SIDESTREAM_UPDATE_NATIVE, JSON.stringify(scope), String(now)], { stdio: "pipe" });
});
test("operator refuses release ID rebinding and cannot commit without its durable audit", async () => {
  const catalog = path.join(temporary, "audit-catalog.json"), input = path.join(temporary, "audit-policy.json");
  fs.writeFileSync(catalog, JSON.stringify({ schema: "sidestream.staged-catalog.v1", keys, identities: {
    [contract.scopeKey(scope) + "/" + release.releaseId]: "0".repeat(64)
  }, policies: {} }));
  fs.writeFileSync(input, JSON.stringify(policy));
  const options = { catalog, policy: input, artifacts: temporary, "expected-revision": "0" };
  await assert.rejects(operate(options), /release_identity_changed/);
  fs.writeFileSync(catalog, JSON.stringify({ schema: "sidestream.staged-catalog.v1", keys, policies: {} }));
  const before = fs.readFileSync(catalog); fs.writeFileSync(catalog + ".audit", "blocked audit destination");
  const confirmation = release.releaseId + ":" + release.artifact.sha256;
  await assert.rejects(operate({ ...options, apply: true, "key-id": "fixture", "private-key": path.join(temporary, "private.pem"),
    "confirm-download": confirmation, "confirm-activation": confirmation }), /EEXIST/);
  assert.deepEqual(fs.readFileSync(catalog), before);
  assert.equal(fs.existsSync(catalog + ".lock"), false);
});
test("artifact publication dry run validates exact bytes and refuses corrupt or mutable files", () => {
  const publicKeys = path.join(temporary, "publication-keys.json"), envelope = path.join(temporary, "publication-release.json");
  fs.writeFileSync(publicKeys, JSON.stringify(keys)); fs.writeFileSync(envelope, JSON.stringify(contract.signEnvelope(release, "release", "fixture", privatePem, keys)));
  const args = ["--experimental-strip-types", "scripts/publish-staged-update-artifact.mjs", "--keys", publicKeys, "--release", envelope, "--artifact", path.join(temporary, release.artifact.filename)];
  const output = JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" }));
  assert.equal(output.published, false); assert.equal(output.activationChanged, false);
  assert.equal(output.pathname, contract.artifactPath(release));
  const original = fs.readFileSync(args.at(-1));
  try {
    fs.writeFileSync(args.at(-1), Buffer.alloc(original.length));
    assert.throws(() => execFileSync(process.execPath, args, { stdio: "pipe" }), /artifact_hash/);
  } finally { fs.writeFileSync(args.at(-1), original); }
  assert.throws(() => execFileSync(process.execPath, [...args.slice(0, -1), path.join(temporary, "latest.zip")], { stdio: "pipe" }));
});

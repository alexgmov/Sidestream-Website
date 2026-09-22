#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { canonical, openEnvelope, parsePolicy, parseScope, scopeKey, signEnvelope } from "../api/_lib/staged-updates.ts";

function args(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--apply") parsed.apply = true;
    else if (["--catalog", "--policy", "--keys", "--key-id", "--private-key", "--artifacts", "--expected-revision", "--confirm-download", "--confirm-activation", "--confirm-rollback"].includes(key) && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      if (parsed[key.slice(2)] !== undefined) throw new Error("duplicate_argument");
      parsed[key.slice(2)] = argv[++i];
    } else throw new Error("unknown_or_missing_argument");
  }
  return parsed;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function syncDirectory(directory) {
  if (process.platform === "win32") throw new Error("operator_requires_posix_durable_storage");
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function privateKey(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (process.platform !== "win32" && (info.mode & 0o077))) throw new Error("private_key_permissions");
  return fs.readFileSync(file, "utf8");
}
export async function operate(options) {
  const catalogPath = path.resolve(options.catalog || "data/staged-update-catalog.json");
  const old = readJson(catalogPath);
  if (old.schema !== "sidestream.staged-catalog.v1") throw new Error("catalog_schema");
  const keys = options.keys ? readJson(options.keys) : old.keys;
  if (Object.keys(old.policies).length && canonical(keys) !== canonical(old.keys)) throw new Error("key_rotation_requires_enrollment_review");
  const input = readJson(options.policy);
  const scope = parseScope(input.scope);
  if (scope.channel !== "test") throw new Error("production_not_enabled");
  const key = scopeKey(scope), existing = old.policies[key];
  const previous = existing ? parsePolicy(openEnvelope(existing, "policy", keys), keys, scope).policy : null;
  const expected = Number(options["expected-revision"]);
  if (!Number.isSafeInteger(expected) || expected !== (previous?.revision || 0) || input.revision !== expected + 1) throw new Error("revision_conflict");
  const { policy, releases } = parsePolicy(input, keys, scope, Math.floor(Date.now() / 1000));
  const identities = { ...(old.identities || {}) };
  for (const envelope of Object.values(old.policies)) {
    const oldValue = openEnvelope(envelope, "policy", old.keys);
    const oldScope = parseScope(oldValue.scope);
    const parsed = parsePolicy(oldValue, old.keys, oldScope);
    for (const release of parsed.releases.values()) {
      const identity = scopeKey(oldScope) + "/" + release.releaseId;
      if (identities[identity] && identities[identity] !== release.artifact.sha256) throw new Error("release_identity_changed");
      identities[identity] = release.artifact.sha256;
    }
  }
  for (const release of releases.values()) {
    const identity = key + "/" + release.releaseId;
    if (identities[identity] && identities[identity] !== release.artifact.sha256) throw new Error("release_identity_changed");
    identities[identity] = release.artifact.sha256;
    const file = path.join(path.resolve(options.artifacts), release.artifact.filename);
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== release.artifact.sizeBytes) throw new Error("artifact_identity");
    const digest = createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
    const after = fs.statSync(file);
    if (digest.digest("hex") !== release.artifact.sha256 || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error("artifact_changed_or_corrupt");
  }
  const summary = { apply: Boolean(options.apply), scope, revision: policy.revision, hold: policy.hold,
    download: policy.download, activation: policy.activation, artifactCount: releases.size,
    audit: policy.audit, publicInstallerPointersChanged: false, productionEnabled: false };
  if (!options.apply) return summary;
  for (const purpose of ["download", "activation"]) {
    const target = policy[purpose];
    if (target && options["confirm-" + purpose] !== target.releaseId + ":" + target.sha256) throw new Error("exact_" + purpose + "_confirmation_required");
  }
  const rollback = policy.activation?.rollbackFrom;
  if (rollback && options["confirm-rollback"] !== rollback.releaseId + ":" + rollback.sha256 + ">" + policy.activation.releaseId + ":" + policy.activation.sha256) throw new Error("exact_rollback_confirmation_required");
  const signed = signEnvelope(policy, "policy", options["key-id"], privateKey(options["private-key"]), keys);
  const lock = catalogPath + ".lock";
  const fd = fs.openSync(lock, "wx", 0o600);
  const temporary = catalogPath + "." + process.pid + ".tmp";
  try {
    if (canonical(readJson(catalogPath)) !== canonical(old)) throw new Error("revision_conflict");
    const next = { schema: old.schema, keys, identities, policies: { ...old.policies, [key]: signed } };
    const output = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(output, canonical(next)); fs.fsyncSync(output); } finally { fs.closeSync(output); }
    // The signed control contains its operator, reason, exact bytes and revision;
    // archive each immutable signed revision as the local audit record.
    const audit = catalogPath + ".audit";
    fs.mkdirSync(audit, { recursive: true, mode: 0o700 });
    const auditPath = path.join(audit, key.replaceAll("/", "-") + "-" + policy.revision + ".json");
    // A durable approval record precedes the active pointer. If interrupted,
    // retrying the identical signed operation is safe; conflicting reuse fails.
    if (fs.existsSync(auditPath)) {
      if (fs.readFileSync(auditPath, "utf8") !== canonical(signed)) throw new Error("audit_revision_conflict");
    } else {
      const auditFd = fs.openSync(auditPath, "wx", 0o600);
      try { fs.writeFileSync(auditFd, canonical(signed)); fs.fsyncSync(auditFd); } finally { fs.closeSync(auditFd); }
    }
    syncDirectory(audit);
    fs.renameSync(temporary, catalogPath);
    syncDirectory(path.dirname(catalogPath));
  } finally {
    fs.rmSync(temporary, { force: true }); fs.closeSync(fd); fs.unlinkSync(lock);
  }
  return summary;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await operate(args(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error("Staged update operation refused:", error.message); process.exitCode = 1; }
}

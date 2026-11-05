import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { compileApiFixture } from "./helpers/compile-api-fixture.mjs";
import { issueUpdaterBetaDownloads, writePrivateBetaDownloads } from "../scripts/issue-updater-beta-downloads.mjs";

const NOW = Date.parse("2026-11-05T20:00:00Z");
const SECRET = "beta-test-only-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
const bytes = { install: Buffer.from("install fixture"), restore: Buffer.from("restore fixture") };
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const configured = { schemaVersion: 1, enabled: true, candidate: {
  id: "unissued-test-candidate", version: "9.8.7", sourceSha: "a".repeat(40), seedSha256: "b".repeat(64),
  ...Object.fromEntries(Object.entries(bytes).map(([action, data]) => [action, { sha256: hash(data), sizeBytes: data.length }])),
} };
let temporary, artifactRoot, disabled, enabled, malformed, betaModule, beta;
async function load(root, module) { return import(pathToFileURL(path.join(root, "api/_lib", module + ".js")).href); }
before(async () => {
  temporary = fs.mkdtempSync(path.join(process.cwd(), "node_modules/.tmp/updater-beta-"));
  const original = path.join(temporary, "disabled");
  compileApiFixture(["api/_lib/installer-delivery.ts"], original);
  betaModule = await load(original, "updater-beta-installers");
  disabled = await load(original, "installer-delivery");
  for (const [name, value] of [["enabled", configured], ["malformed", { ...configured, candidate: null }]]) {
    const copy = path.join(temporary, name);
    fs.cpSync(original, copy, { recursive: true });
    fs.writeFileSync(path.join(copy, "data/updater-beta-installers.json"), JSON.stringify(value));
  }
  enabled = await load(path.join(temporary, "enabled"), "installer-delivery");
  malformed = await load(path.join(temporary, "malformed"), "installer-delivery");
  beta = betaModule.parseUpdaterBetaInstallers(configured);
  artifactRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sidestream-beta-artifacts-")));
  for (const artifact of beta.artifacts) {
    const file = path.join(artifactRoot, artifact.pathname);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes[artifact.action], { mode: 0o444 });
  }
});
after(() => {
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  if (artifactRoot) fs.rmSync(artifactRoot, { recursive: true, force: true });
});

test("checked-in beta is disabled with no candidate; malformed beta cannot affect current customer artifacts", () => {
  assert.equal(betaModule.readUpdaterBetaInstallers(), null);
  const baseline = disabled.listManifestInstallerArtifacts();
  assert.ok(baseline.length >= 4);
  assert.ok(baseline.every(item => !item.pathname.startsWith("sidestream/updater-beta/")));
  assert.deepEqual(malformed.listManifestInstallerArtifacts(), baseline);
  assert.deepEqual(enabled.listManifestInstallerArtifacts().filter(item => !item.pathname.startsWith("sidestream/updater-beta/")), baseline);
  for (const artifact of beta.artifacts) {
    assert.throws(() => disabled.createHetznerSignedDownloadUrl(artifact.pathname, { nowMs: NOW, signingSecret: SECRET }));
    assert.throws(() => malformed.createHetznerSignedDownloadUrl(artifact.pathname, { nowMs: NOW, signingSecret: SECRET }));
  }
});

test("enabled beta admits exactly the bound Install and Restore PKGs with correct MIME", () => {
  const added = enabled.listManifestInstallerArtifacts().filter(item => item.pathname.startsWith("sidestream/updater-beta/"));
  assert.deepEqual(added, beta.artifacts);
  assert.equal(added.length, 2);
  assert.ok(added.every(item => item.contentType === "application/octet-stream" && item.platform === "macos"));
  assert.deepEqual(added.map(item => item.filename), ["Sidestream-9.8.7-Mac-Install.pkg", "Sidestream-9.8.7-Mac-Restore.pkg"]);
});

test("candidate metadata rejects partial pairs, paths, extra fields and invalid bounds", () => {
  for (const edit of [
    x => { x.enabled = false; },
    x => { delete x.candidate.restore; },
    x => { x.candidate.id = "../escape"; },
    x => { x.candidate.version = "01.2.3"; },
    x => { x.candidate.sourceSha = "not-a-commit"; },
    x => { x.candidate.seedSha256 = "bad"; },
    x => { x.candidate.install.pathname = "sidestream/other.pkg"; },
    x => { x.candidate.install.sizeBytes = 0; },
    x => { x.candidate.install.sizeBytes = 2_000_000_001; },
    x => { x.candidate.install.sizeBytes = 1.5; },
    x => { x.candidate.restore.sha256 = x.candidate.install.sha256; },
  ]) {
    const value = structuredClone(configured); edit(value);
    assert.throws(() => betaModule.parseUpdaterBetaInstallers(value));
  }
});

const issue = (nowMs = NOW) => issueUpdaterBetaDownloads({ beta, delivery: enabled, artifactRoot, signingSecret: SECRET, nowMs, rootOwned: false });
const authorize = (url, nowMs = NOW, delivery = enabled) => {
  const value = new URL(url);
  return delivery.authorizeHetznerInstallerDownload({ method: "GET", rawUrl: value.pathname + value.search,
    nowMs, signingSecret: SECRET, artifactRoot });
};
test("operator verifies both packages and renews only through fresh five-minute signed links", async () => {
  const first = await issue();
  assert.equal(first.expiresAt, new Date(NOW + 300_000).toISOString());
  assert.equal(first.artifacts.length, 2);
  for (const artifact of first.artifacts) {
    const url = new URL(artifact.url);
    assert.deepEqual([...url.searchParams.keys()], ["expires", "signature"]);
    assert.equal((await authorize(artifact.url)).artifact.sha256, artifact.sha256);
    await assert.rejects(authorize(artifact.url, NOW + 300_000));
    await assert.rejects(authorize(artifact.url, NOW, disabled));
    url.pathname = url.pathname.replace("-Install.pkg", "-Restore.pkg").replace("unissued-test-candidate", "other-candidate");
    await assert.rejects(authorize(url));
  }
  const renewed = await issue(NOW + 300_000);
  assert.notEqual(first.artifacts[0].url, renewed.artifacts[0].url);
  for (const artifact of renewed.artifacts) await authorize(artifact.url, NOW + 300_000);
  await assert.rejects(issueUpdaterBetaDownloads({ beta: null, delivery: enabled, artifactRoot, signingSecret: SECRET }));
});

test("operator refuses same-size modified bytes and symlinked package", async () => {
  const artifact = beta.artifacts[0], file = path.join(artifactRoot, artifact.pathname);
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, Buffer.alloc(artifact.sizeBytes, 120));
  fs.chmodSync(file, 0o444);
  await assert.rejects(issue(), /verification failed/);
  fs.chmodSync(file, 0o644); fs.writeFileSync(file, bytes.install); fs.chmodSync(file, 0o444);
  const saved = file + ".saved"; fs.renameSync(file, saved); fs.symlinkSync(saved, file);
  await assert.rejects(issue());
  fs.unlinkSync(file); fs.renameSync(saved, file);
});

test("bearer URLs are stored only in a new owner-private file; existing outputs are never overwritten", async () => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sidestream-beta-links-")));
  try {
    fs.chmodSync(parent, 0o700);
    const result = await issue(), file = path.join(parent, "links.json");
    writePrivateBetaDownloads(file, result);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), result);
    assert.throws(() => writePrivateBetaDownloads(file, result));
    fs.chmodSync(parent, 0o755);
    assert.throws(() => writePrivateBetaDownloads(path.join(parent, "other.json"), result));
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

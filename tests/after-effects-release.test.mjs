import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { compileApiFixture } from "./helpers/compile-api-fixture.mjs";

let temporary;
let createHandler;
let delivery;
let manifests;
const oldOverride = process.env.SIDESTREAM_AFTER_EFFECTS_RELEASE_MANIFEST_PATH;
const manifest = {
  schemaVersion: 1, product: "sidestream", channel: "after-effects-download-release",
  platform: "macos", version: "1.0.22", minSupportedVersion: "1.0.22", critical: false,
  rolloutPercent: 0, publishedAt: "2026-10-21T18:00:00.000Z", releaseNotesUrl: "https://sidestream.tv/",
  artifact: { type: "dmg", url: "https://sidestream.tv/api/download-after-effects",
    pathname: "sidestream/after-effects/1.0.22/Sidestream-1.0.22-Mac-AfterEffects-Installer.dmg",
    sha256: "a".repeat(64), sizeBytes: 1234 }
};

before(async () => {
  mkdirSync("node_modules/.tmp", { recursive: true });
  temporary = mkdtempSync(path.resolve("node_modules/.tmp/ae-release-"));
  compileApiFixture(["api/download-after-effects.ts"], temporary);
  ({ createAfterEffectsDownloadHandler: createHandler } = await import(pathToFileURL(path.join(temporary, "api/download-after-effects.js"))));
  delivery = await import(pathToFileURL(path.join(temporary, "api/_lib/installer-delivery.js")));
  manifests = await import(pathToFileURL(path.join(temporary, "api/_lib/release-manifest.js")));
  process.env.SIDESTREAM_AFTER_EFFECTS_RELEASE_MANIFEST_PATH = path.join(temporary, "cohort.json");
  saveManifest(manifest);
});
after(() => {
  if (oldOverride === undefined) delete process.env.SIDESTREAM_AFTER_EFFECTS_RELEASE_MANIFEST_PATH;
  else process.env.SIDESTREAM_AFTER_EFFECTS_RELEASE_MANIFEST_PATH = oldOverride;
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});
function saveManifest(value) { writeFileSync(process.env.SIDESTREAM_AFTER_EFFECTS_RELEASE_MANIFEST_PATH, JSON.stringify(value)); }
function handler(overrides = {}) {
  return createHandler({
    headInstaller: async (pathname) => {
      assert.equal(pathname, manifest.artifact.pathname);
      return { size: 1234, sha256: "a".repeat(64), etag: "ae-test" };
    },
    createSignedUrl: async () => "https://downloads.sidestream.tv/v1/ae-test?signature=test",
    recordAcquisition: async () => { throw new Error("AE must not write Production acquisition"); },
    recordReferral: async () => { throw new Error("AE must not write Production referral"); },
    getAcquisitionSecret: () => { throw new Error("AE must not read Production attribution"); },
    logManifestError() {}, logTrackingError(error) { throw error; },
    scheduleBackground() { throw new Error("AE must not schedule Production tracking"); },
    ...overrides
  });
}
async function invoke(route, { method = "GET", query = "", headers = {} } = {}) {
  const server = http.createServer((req, res) => Promise.resolve(route(req, res)).catch((error) => { res.statusCode = 500; res.end(error.message); }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/download-after-effects${query}`, { method, headers, redirect: "manual" });
    return { status: response.status, headers: response.headers, body: await response.text() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("AE GET and HEAD reuse validated delivery without Production attribution", async () => {
  const get = await invoke(handler(), { query: "?utm_source=gmail&utm_medium=email" });
  assert.equal(get.status, 302);
  assert.match(get.headers.get("location"), /^https:\/\/downloads.sidestream.tv\//);
  assert.equal(get.headers.get("set-cookie"), null);
  assert.equal(get.headers.get("cache-control"), "no-store");
  const head = await invoke(handler(), { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("x-sidestream-release-category"), manifest.channel);
  assert.equal(head.headers.get("x-sidestream-version"), "1.0.22");
  assert.equal(head.headers.get("x-sidestream-sha256"), manifest.artifact.sha256);
  assert.match(head.headers.get("content-disposition"), /AfterEffects-Installer.dmg/);
  assert.equal(head.body, "");
});
test("unsupported platforms, disabled releases and metadata mismatches never deliver", async () => {
  assert.equal((await invoke(handler(), { query: "?platform=win32-x64" })).status, 404);
  assert.equal((await invoke(handler(), { method: "POST" })).status, 405);
  assert.equal((await invoke(handler({ headInstaller: async () => ({ size: 999 }) }))).status, 503);
  saveManifest({ enabled: false });
  assert.equal((await invoke(handler())).status, 404);
  assert.ok(delivery.listManifestInstallerArtifacts().every((row) => row.pathname !== manifest.artifact.pathname));
  saveManifest(manifest);
});
test("cohort is independently allowlisted; canonical stable manifest cannot select it", () => {
  assert.equal(delivery.findManifestInstallerArtifact(manifest.artifact.pathname).sha256, manifest.artifact.sha256);
  assert.notEqual(manifests.readReleaseManifest().artifact.pathname, manifest.artifact.pathname);
  assert.throws(() => manifests.parseReleaseManifest(manifest, "macos"), /unsupported release channel/);
  for (const invalid of [
    { ...manifest, channel: "stable" },
    { ...manifest, artifact: { ...manifest.artifact, pathname: "sidestream/../escape.dmg" } },
    { ...manifest, artifact: { ...manifest.artifact, url: "https://sidestream.tv/api/download" } },
    { ...manifest, artifact: { ...manifest.artifact, sha256: "wrong" } }
  ]) {
    saveManifest(invalid);
    assert.throws(() => manifests.readAfterEffectsReleaseManifest());
    assert.ok(delivery.listManifestInstallerArtifacts().length >= 4, "malformed AE metadata must not break existing customer delivery");
    assert.throws(() => delivery.findManifestInstallerArtifact(manifest.artifact.pathname));
  }
  saveManifest(manifest);
});

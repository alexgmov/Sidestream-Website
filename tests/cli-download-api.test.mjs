import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { before, after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { compileApiFixture } from "./helpers/compile-api-fixture.mjs";

const registry = JSON.parse(readFileSync(new URL("../data/cli-downloads.json", import.meta.url)));
const release = "1.0.21-86876e22b6c162af";
const artifact = registry.releases[release];
let temporary, createHandler, parseRegistry;
before(async () => {
  mkdirSync("node_modules/.tmp", { recursive: true });
  temporary = mkdtempSync(path.resolve("node_modules/.tmp/cli-download-"));
  compileApiFixture(["api/download-cli.ts"], temporary);
  const route = await import(pathToFileURL(path.join(temporary, "api/download-cli.js")));
  createHandler = route.createCliDownloadHandler;
  parseRegistry = route.parseCliDownloads;
});
after(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });
function handler(overrides = {}) {
  return createHandler({
    readRegistry: () => registry,
    headArtifact: async pathname => { assert.equal(pathname, artifact.pathname); return { pathname, size: artifact.sizeBytes }; },
    createSignedUrl: async pathname => { assert.equal(pathname, artifact.pathname); return "https://example.private.blob.vercel-storage.com/cli?signature=scoped"; },
    ...overrides,
  });
}
async function invoke(route, query = `?release=${release}`, method = "GET") {
  const server = http.createServer((req, res) => Promise.resolve(route(req, res)).catch(error => { res.statusCode = 500; res.end(error.message); }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/download-cli${query}`, { method, redirect: "manual" });
    return { status: response.status, headers: response.headers, body: await response.text() };
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test("the first published CLI registry entry stays immutable when latest advances", () => {
  assert.deepEqual(artifact, {
    version: "1.0.21",
    filename: "Sidestream-CLI-1.0.21-darwin-universal-86876e22b6c162af.tar.gz",
    pathname: "sidestream/cli/1.0.21-86876e22b6c162af/Sidestream-CLI-1.0.21-darwin-universal-86876e22b6c162af.tar.gz",
    sizeBytes: 222415181,
    sha256: "60a9166d1a3c53d563a9fa313952f6658a745ecb2016da4ca3c1e39e9f8b686f",
  });
});
test("GET validates the pinned object then redirects without proxying or caching a signed URL", async () => {
  const response = await invoke(handler());
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location"), /^https:\/\/example\.private\.blob\.vercel-storage\.com\//);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.body, "");
});
test("HEAD returns pinned metadata without signing, reading Blob or downloading bytes", async () => {
  const response = await invoke(handler({
    headArtifact: async () => { throw new Error("HEAD must not call Blob"); },
    createSignedUrl: async () => { throw new Error("HEAD must not sign"); },
  }), undefined, "HEAD");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), String(artifact.sizeBytes));
  assert.equal(response.headers.get("content-type"), "application/gzip");
  assert.equal(response.headers.get("x-sidestream-sha256"), artifact.sha256);
  assert.equal(response.headers.get("etag"), `"sha256-${artifact.sha256}"`);
  assert.equal(response.body, "");
});
test("arbitrary paths, duplicate or extra parameters and unknown releases never sign", async () => {
  const route = handler({
    headArtifact: async () => { throw new Error("must not read Blob"); },
    createSignedUrl: async () => { throw new Error("must not sign"); },
  });
  for (const query of ["", "?release=unknown", "?release=__proto__", "?release=constructor", `?release=${release}&release=${release}`, `?release=${release}&pathname=sidestream/paid/installer.dmg`, "?pathname=sidestream/installer.dmg", "?release=..%2Fpaid", "?release=%00", `?release=${release}&signature=attacker`]) {
    assert.equal((await invoke(route, query)).status, 404, query);
  }
  const post = await invoke(route, undefined, "POST");
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
});
test("metadata drift and provider failures fail safely without secret or URL disclosure", async () => {
  for (const overrides of [
    { headArtifact: async () => ({ pathname: artifact.pathname, size: 1 }) },
    { headArtifact: async () => ({ pathname: "sidestream/paid/other.dmg", size: artifact.sizeBytes }) },
    { createSignedUrl: async () => { throw new Error("secret-token private-url"); } },
    { readRegistry: () => ({ schemaVersion: 7 }) },
  ]) {
    const response = await invoke(handler(overrides));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "60");
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.body, "CLI download is temporarily unavailable");
  }
});
test("registry validation rejects filesystem escape, wrong types and malformed integrity metadata", () => {
  for (const patch of [
    { pathname: "sidestream/../secret" }, { filename: "../../secret.tar.gz" },
    { sha256: "bad" }, { sizeBytes: -1 }, { sizeBytes: "222415181" }, { version: "\r\nInjected: yes" },
  ]) {
    assert.throws(() => parseRegistry({ schemaVersion: 1, releases: { [release]: { ...artifact, ...patch } } }));
  }
});

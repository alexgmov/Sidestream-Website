import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const manifest = JSON.parse(await readFile(new URL("../data/cli-release.json", import.meta.url), "utf8"));
const registry = JSON.parse(await readFile(new URL("../data/cli-downloads.json", import.meta.url), "utf8"));
const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
const nginx = await readFile(new URL("../ops/nginx/downloads.sidestream.tv.conf", import.meta.url), "utf8");
const cliLocations = new Map(
  [...nginx.matchAll(/^    location = (\/cli\/[^\s]+) \{([\s\S]*?)^    \}/gm)]
    .map((match) => [match[1], match[2]]),
);

function assertReadOnlyLocation(block) {
  assert.match(block, /if \(\$request_method !~ \^\(GET\|HEAD\)\$\) \{ return 405; \}/);
  assert.match(block, /add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;/);
  assert.match(block, /add_header X-Content-Type-Options "nosniff" always;/);
  assert.match(block, /add_header Referrer-Policy "no-referrer" always;/);
}

test("CLI metadata pins one immutable archive and its shared-source digest", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.releaseId, /^[A-Za-z0-9][A-Za-z0-9._-]+$/);
  assert.match(manifest.sourceDigest, /^[a-f0-9]{64}$/);
  assert.match(manifest.archive.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(manifest.archive.sizeBytes) && manifest.archive.sizeBytes > 0);
  assert.match(manifest.archive.filename, /^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$/);
  assert.equal(manifest.archive.pathname, `sidestream/cli/${manifest.releaseId}/${manifest.archive.filename}`);
  assert.equal(manifest.archive.url, `https://downloads.sidestream.tv/cli/${manifest.archive.filename}`);
  assert.equal(manifest.manifestPathname, `sidestream/cli/${manifest.releaseId}/release.json`);
});

test("latest and latest.json select the same immutable release without caching the pointer", () => {
  const redirect = cliLocations.get("/cli/latest");
  const metadata = cliLocations.get("/cli/latest.json");
  assert.ok(redirect && metadata);
  assertReadOnlyLocation(redirect);
  assertReadOnlyLocation(metadata);
  assert.ok(redirect.includes(`return 302 ${manifest.archive.url};`));
  assert.ok(metadata.includes(`alias /srv/sidestream/artifacts/${manifest.manifestPathname};`));
  for (const block of [redirect, metadata]) {
    assert.match(block, /add_header Cache-Control "no-store" always;/);
  }
  assert.match(metadata, /default_type application\/json;/);
  assert.match(metadata, /disable_symlinks on from=\/srv\/sidestream\/artifacts;/);
});

test("public CLI bytes use an exact-release CDN redirect, retaining the private installer boundary", () => {
  const archive = cliLocations.get(new URL(manifest.archive.url).pathname);
  assert.ok(archive);
  assertReadOnlyLocation(archive);
  assert.ok(archive.includes(`return 302 https://sidestream.tv/api/download-cli?release=${manifest.releaseId};`));
  assert.match(archive, /add_header Cache-Control "no-store" always;/);
  assert.doesNotMatch(archive, /alias|proxy_pass/);
  assert.deepEqual(registry.releases[manifest.releaseId], {
    version: manifest.version,
    filename: manifest.archive.filename,
    pathname: manifest.archive.pathname,
    sizeBytes: manifest.archive.sizeBytes,
    sha256: manifest.archive.sha256,
  });
  assert.equal(vercel.functions["api/download-cli.ts"].includeFiles, "data/cli-downloads.json");
  assert.doesNotMatch(nginx, /location\s+(?:\^~\s+|~\*?\s+)?\/cli\//);

  // New public aliases must never expose the parent directory or installer files.
  for (const match of nginx.matchAll(/^    location ([^\n]+) \{([\s\S]*?)^    \}/gm)) {
    const [, location, block] = match;
    if (!block.includes("alias /srv/sidestream/artifacts/")) continue;
    if (location === "^~ /__sidestream_artifacts/") {
      assert.match(block, /\binternal;/);
    } else {
      assert.match(location, /^= \/cli\/[^/\s]+$/);
      assert.match(block, /alias \/srv\/sidestream\/artifacts\/sidestream\/cli\/[^/\s]+\/[^/\s]+;/);
      assert.doesNotMatch(block, /alias [^;]*\$/);
    }
  }
  const signedInstaller = nginx.match(/^    location \^~ \/v1\/ \{([\s\S]*?)^    \}/m)?.[1];
  assert.match(signedInstaller || "", /proxy_pass http:\/\/127\.0\.0\.1:3101;/);
  assert.doesNotMatch(signedInstaller || "", /alias|root\s/);
});

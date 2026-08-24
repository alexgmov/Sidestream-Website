import assert from "node:assert/strict";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  truncateSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { compileApiFixture } from "./helpers/compile-api-fixture.mjs";

const NOW_MS = Date.parse("2026-08-24T12:00:00.000Z");
const SECRET = "installer-delivery-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
let artifactRoot;
let compiledDirectory;
let delivery;

before(async () => {
  mkdirSync(path.join(process.cwd(), "node_modules", ".tmp"), { recursive: true });
  compiledDirectory = mkdtempSync(
    path.join(process.cwd(), "node_modules", ".tmp", "installer-delivery-test-"),
  );
  compileApiFixture(["api/_lib/installer-delivery.ts"], compiledDirectory);
  delivery = await import(
    pathToFileURL(
      path.join(compiledDirectory, "api", "_lib", "installer-delivery.js"),
    ).href
  );
  artifactRoot = mkdtempSync(path.join(os.tmpdir(), "sidestream-artifacts-"));
  for (const artifact of delivery.listManifestInstallerArtifacts()) {
    const filePath = path.join(artifactRoot, ...artifact.pathname.split("/"));
    mkdirSync(path.dirname(filePath), { recursive: true });
    closeSync(openSync(filePath, "wx"));
    truncateSync(filePath, artifact.sizeBytes);
  }
});

after(() => {
  if (artifactRoot) rmSync(artifactRoot, { recursive: true, force: true });
  if (compiledDirectory) rmSync(compiledDirectory, { recursive: true, force: true });
});

test("installer provider defaults to Blob and rejects unknown values", () => {
  assert.equal(delivery.resolveInstallerProvider(undefined), "blob");
  assert.equal(delivery.resolveInstallerProvider(" HETZNER "), "hetzner");
  assert.throws(
    () => delivery.resolveInstallerProvider("filesystem"),
    delivery.InstallerDeliveryConfigurationError,
  );
});

test("Hetzner links carry only the immutable path, five-minute expiry, and signature", () => {
  const artifact = delivery.listManifestInstallerArtifacts()[0];
  const signed = new URL(delivery.createHetznerSignedDownloadUrl(artifact.pathname, {
    nowMs: NOW_MS,
    signingSecret: SECRET,
  }));
  assert.equal(signed.origin, delivery.HETZNER_DOWNLOAD_ORIGIN);
  assert.equal(signed.pathname, `/v1/${artifact.pathname}`);
  assert.deepEqual([...signed.searchParams.keys()].sort(), ["expires", "signature"]);
  assert.equal(Number(signed.searchParams.get("expires")), Math.floor(NOW_MS / 1000) + 300);
  assert.match(signed.searchParams.get("signature"), /^[0-9A-Za-z_-]{43}$/);
  assert.doesNotMatch(signed.toString(), /email|license|receipt|user/i);
});

test("valid signed links authorize only current manifest artifacts", async () => {
  for (const artifact of delivery.listManifestInstallerArtifacts()) {
    const signed = new URL(delivery.createHetznerSignedDownloadUrl(artifact.pathname, {
      nowMs: NOW_MS,
      signingSecret: SECRET,
    }));
    const authorized = await delivery.authorizeHetznerInstallerDownload({
      method: "GET",
      rawUrl: `${signed.pathname}${signed.search}`,
      nowMs: NOW_MS,
      signingSecret: SECRET,
      artifactRoot,
    });
    assert.equal(authorized.artifact.pathname, artifact.pathname);
    assert.equal(
      authorized.internalPath,
      `${delivery.HETZNER_INTERNAL_PATH_PREFIX}${artifact.pathname}`,
    );
    assert.equal(authorized.etag, `"sha256-${artifact.sha256}"`);
  }
});

test("unsigned, altered, expired, duplicated, and traversal-shaped links fail closed", async () => {
  const artifacts = delivery.listManifestInstallerArtifacts();
  const signed = new URL(delivery.createHetznerSignedDownloadUrl(artifacts[0].pathname, {
    nowMs: NOW_MS,
    signingSecret: SECRET,
  }));
  const validQuery = signed.search;
  const badUrls = [
    signed.pathname,
    `${signed.pathname}?expires=${signed.searchParams.get("expires")}&signature=x${signed.searchParams.get("signature").slice(1)}`,
    `${signed.pathname}${validQuery}&signature=${signed.searchParams.get("signature")}`,
    `/v1/${artifacts[1].pathname}${validQuery}`,
    `/v1/sidestream/%2e%2e/secret${validQuery}`,
    `/v1//${artifacts[0].pathname}${validQuery}`,
  ];
  for (const rawUrl of badUrls) {
    await assert.rejects(
      delivery.authorizeHetznerInstallerDownload({
        rawUrl,
        nowMs: NOW_MS,
        signingSecret: SECRET,
        artifactRoot,
      }),
      delivery.InstallerAuthorizationError,
    );
  }

  await assert.rejects(
    delivery.authorizeHetznerInstallerDownload({
      rawUrl: `${signed.pathname}${signed.search}`,
      nowMs: NOW_MS + 301_000,
      signingSecret: SECRET,
      artifactRoot,
    }),
    delivery.InstallerAuthorizationError,
  );
});

test("authorization refuses a local artifact whose size no longer matches its manifest", async () => {
  const artifact = delivery.listManifestInstallerArtifacts()[0];
  const filePath = path.join(artifactRoot, ...artifact.pathname.split("/"));
  const signed = new URL(delivery.createHetznerSignedDownloadUrl(artifact.pathname, {
    nowMs: NOW_MS,
    signingSecret: SECRET,
  }));
  truncateSync(filePath, artifact.sizeBytes - 1);
  try {
    await assert.rejects(
      delivery.authorizeHetznerInstallerDownload({
        rawUrl: `${signed.pathname}${signed.search}`,
        nowMs: NOW_MS,
        signingSecret: SECRET,
        artifactRoot,
      }),
      delivery.InstallerArtifactMismatchError,
    );
  } finally {
    truncateSync(filePath, artifact.sizeBytes);
  }
});

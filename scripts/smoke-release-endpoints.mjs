#!/usr/bin/env node

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const PLATFORM_CASES = [
  {
    artifactType: "dmg",
    extension: ".dmg",
    name: "macOS",
    platform: "macos",
    query: "",
  },
  {
    artifactType: "exe",
    extension: ".exe",
    name: "Windows",
    platform: "win32-x64",
    query: "?platform=win32-x64",
  },
];

export async function runSmoke(
  baseUrl,
  { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {},
) {
  const base = normalizeBaseUrl(baseUrl);
  const results = [];

  for (const platformCase of PLATFORM_CASES) {
    const releaseUrl = new URL(
      `/api/releases/latest${platformCase.query}`,
      base,
    );
    const releaseResponse = await request(fetchImpl, releaseUrl, {
      method: "GET",
      timeoutMs,
    });
    requireStatus(releaseResponse, 200, `${platformCase.name} release metadata`);
    const releaseBody = await readBoundedText(
      releaseResponse,
      MAX_RESPONSE_BYTES,
    );
    const manifest = parseJson(releaseBody, `${platformCase.name} release metadata`);
    validatePublicManifest(manifest, platformCase);

    const downloadUrl = new URL(`/api/download${platformCase.query}`, base);
    const downloadResponse = await request(fetchImpl, downloadUrl, {
      method: "HEAD",
      timeoutMs,
    });
    requireStatus(downloadResponse, 200, `${platformCase.name} download HEAD`);
    validateDownloadHead(downloadResponse, manifest, platformCase);

    results.push({
      filename: manifest.artifact.filename,
      platform: platformCase.platform,
      sizeBytes: manifest.artifact.sizeBytes,
      version: manifest.version,
    });
  }

  for (const pathname of ["/api/releases/latest", "/api/download"]) {
    const url = new URL(`${pathname}?platform=linux-x64`, base);
    const method = pathname.endsWith("/download") ? "HEAD" : "GET";
    const response = await request(fetchImpl, url, { method, timeoutMs });
    requireStatus(response, 404, `${pathname} unknown-platform check`);
    if (method === "GET") {
      await readBoundedText(response, MAX_RESPONSE_BYTES);
    }
  }

  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  if (args.selfTest) {
    await runSelfTest();
    return;
  }

  if (!args.baseUrl) {
    throw new Error("Missing --base-url.");
  }

  const results = await runSmoke(args.baseUrl);
  for (const result of results) {
    console.log(
      `${result.platform}: ${result.filename} (${result.sizeBytes} bytes, version ${result.version})`,
    );
  }
  console.log("Release endpoint smoke passed without downloading installer bytes.");
}

function validatePublicManifest(manifest, platformCase) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${platformCase.name} release metadata is not an object`);
  }
  if (!manifest.artifact || typeof manifest.artifact !== "object") {
    throw new Error(`${platformCase.name} release metadata has no artifact`);
  }
  if (manifest.platform !== platformCase.platform) {
    throw new Error(
      `${platformCase.name} release metadata returned platform ${manifest.platform}`,
    );
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version || "")) {
    throw new Error(`${platformCase.name} release metadata has an invalid version`);
  }
  if (!isCanonicalIsoTimestamp(manifest.publishedAt)) {
    throw new Error(`${platformCase.name} release metadata has an invalid published time`);
  }
  if (manifest.artifact.type !== platformCase.artifactType) {
    throw new Error(
      `${platformCase.name} release metadata returned ${manifest.artifact.type}`,
    );
  }
  if (
    typeof manifest.artifact.filename !== "string" ||
    !manifest.artifact.filename.toLowerCase().endsWith(platformCase.extension)
  ) {
    throw new Error(
      `${platformCase.name} release metadata returned an invalid filename`,
    );
  }
  if (
    !Number.isSafeInteger(manifest.artifact.sizeBytes) ||
    manifest.artifact.sizeBytes <= 0
  ) {
    throw new Error(`${platformCase.name} release metadata has an invalid size`);
  }
  if (!/^[a-f0-9]{64}$/i.test(manifest.artifact.sha256 || "")) {
    throw new Error(`${platformCase.name} release metadata has an invalid checksum`);
  }
  if (!isExpectedArtifactUrl(manifest.artifact.url, platformCase.platform)) {
    throw new Error(`${platformCase.name} release metadata has the wrong download URL`);
  }

  const serialized = JSON.stringify(manifest);
  if (/pathname|signed.?token|validUntil|BLOB_/i.test(serialized)) {
    throw new Error(`${platformCase.name} release metadata exposes private fields`);
  }
  if (
    platformCase.platform === "win32-x64" &&
    /\.dmg(?:["'?]|$)/i.test(serialized)
  ) {
    throw new Error("Windows release metadata resolved to a DMG");
  }
}

function validateDownloadHead(response, manifest, platformCase) {
  const disposition = response.headers.get("content-disposition") || "";
  const contentLength = Number(response.headers.get("content-length"));
  const responsePlatform = response.headers.get("x-sidestream-platform");
  const responseChecksum = response.headers.get("x-sidestream-sha256");
  const responseVersion = response.headers.get("x-sidestream-version");

  if (
    platformCase.platform === "win32-x64" &&
    /\.dmg(?:["';]|$)/i.test(disposition)
  ) {
    throw new Error("Windows download HEAD resolved to a DMG");
  }
  if (!disposition.includes(`filename="${manifest.artifact.filename}"`)) {
    throw new Error(`${platformCase.name} download HEAD returned the wrong filename`);
  }
  if (contentLength !== manifest.artifact.sizeBytes) {
    throw new Error(`${platformCase.name} download HEAD returned the wrong size`);
  }
  if (responsePlatform !== platformCase.platform) {
    throw new Error(`${platformCase.name} download HEAD returned the wrong platform`);
  }
  if (responseChecksum !== manifest.artifact.sha256) {
    throw new Error(`${platformCase.name} download HEAD returned the wrong checksum`);
  }
  if (responseVersion !== manifest.version) {
    throw new Error(`${platformCase.name} download HEAD returned the wrong version`);
  }
  if (response.headers.has("location")) {
    throw new Error(`${platformCase.name} download HEAD unexpectedly returned a signed URL`);
  }
}

async function request(fetchImpl, url, { method, timeoutMs }) {
  return fetchImpl(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "sidestream-release-smoke/1",
    },
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function readBoundedText(response, maximumBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new Error(`Response exceeded ${maximumBytes} bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new Error(`Response exceeded ${maximumBytes} bytes`);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
}

function requireStatus(response, expectedStatus, label) {
  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned HTTP ${response.status}; expected ${expectedStatus}`);
  }
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid --base-url: ${value}`);
  }

  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("--base-url must be an HTTP(S) origin without credentials");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function isExpectedArtifactUrl(value, platform) {
  try {
    const url = new URL(value);
    const parameters = [...url.searchParams.entries()];
    if (
      url.origin !== "https://sidestream.tv" ||
      url.pathname !== "/api/download" ||
      url.hash
    ) {
      return false;
    }
    if (platform === "macos") return parameters.length === 0;
    return parameters.length === 1 &&
      parameters[0][0] === "platform" &&
      parameters[0][1] === "win32-x64";
  } catch {
    return false;
  }
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function parseArgs(argv) {
  const args = { baseUrl: "", help: false, selfTest: false };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--self-test") {
      args.selfTest = true;
      continue;
    }
    if (token === "--base-url") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--base-url requires a value");
      }
      args.baseUrl = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (args.selfTest && args.baseUrl) {
    throw new Error("Use --self-test or --base-url, not both");
  }
  return args;
}

async function runSelfTest() {
  const requests = [];
  const goodFetch = createSelfTestFetch(requests, false);
  const results = await runSmoke("https://self-test.invalid", {
    fetchImpl: goodFetch,
    timeoutMs: 1_000,
  });

  assert.equal(results.length, 2);
  assert.equal(
    requests
      .filter((request) => request.url.pathname === "/api/download")
      .every((request) => request.method === "HEAD"),
    true,
  );
  assert.equal(
    requests
      .filter((request) => request.url.pathname === "/api/releases/latest")
      .every((request) => request.method === "GET"),
    true,
  );

  await assert.rejects(
    runSmoke("https://self-test.invalid", {
      fetchImpl: createSelfTestFetch([], "download"),
      timeoutMs: 1_000,
    }),
    /Windows download HEAD resolved to a DMG/i,
  );
  console.log("Release endpoint smoke self-test passed.");
}

function createSelfTestFetch(requests, corruptWindows) {
  return async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method || "GET";
    requests.push({ method, url });
    const requestedPlatform = url.searchParams.get("platform");

    if (requestedPlatform === "linux-x64") {
      return new Response('{"error":"not found"}', {
        headers: { "Content-Type": "application/json" },
        status: 404,
      });
    }

    const platformName = requestedPlatform === "win32-x64"
      ? "windows"
      : "macos";
    const fixture = selfTestManifest(
      platformName,
      corruptWindows === "release",
    );

    if (url.pathname === "/api/releases/latest") {
      assert.equal(method, "GET");
      return new Response(JSON.stringify(fixture), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    }

    if (url.pathname === "/api/download") {
      assert.equal(method, "HEAD", "smoke must never fetch installer bytes");
      const downloadFilename =
        platformName === "windows" && corruptWindows === "download"
          ? "Sidestream-1.0.13-Mac-Installer.dmg"
          : fixture.artifact.filename;
      return new Response(null, {
        headers: {
          "Content-Disposition": `attachment; filename="${downloadFilename}"`,
          "Content-Length": String(fixture.artifact.sizeBytes),
          "Content-Type": platformName === "windows"
            ? "application/vnd.microsoft.portable-executable"
            : "application/x-apple-diskimage",
          "X-Sidestream-Platform": fixture.platform,
          "X-Sidestream-Sha256": fixture.artifact.sha256,
          "X-Sidestream-Version": fixture.version,
        },
        status: 200,
      });
    }

    return new Response("not found", { status: 404 });
  };
}

function selfTestManifest(platformName, corruptWindows) {
  const windows = platformName === "windows";
  const incorrectWindowsArtifact = windows && corruptWindows;
  const version = windows ? "1.0.13" : "1.0.12";
  const filename = incorrectWindowsArtifact
    ? "Sidestream-1.0.13-Mac-Installer.dmg"
    : windows
      ? "Sidestream-1.0.13-Windows-Beta-Installer.exe"
      : "Sidestream-1.0.12-Mac-Installer.dmg";

  return {
    schemaVersion: 1,
    product: "sidestream",
    channel: "stable",
    platform: windows ? "win32-x64" : "macos",
    version,
    minSupportedVersion: "1.0.0",
    critical: false,
    rolloutPercent: 100,
    publishedAt: "2026-07-14T00:00:00.000Z",
    releaseNotesUrl: "https://sidestream.tv/",
    artifact: {
      type: incorrectWindowsArtifact ? "dmg" : windows ? "exe" : "dmg",
      url: windows
        ? "https://sidestream.tv/api/download?platform=win32-x64"
        : "https://sidestream.tv/api/download",
      filename,
      sha256: windows ? "b".repeat(64) : "a".repeat(64),
      sizeBytes: windows ? 61_653_939 : 226_402_945,
    },
  };
}

function printUsage() {
  console.log([
    "Usage:",
    "  node scripts/smoke-release-endpoints.mjs --base-url <https://deployment.example>",
    "  node scripts/smoke-release-endpoints.mjs --self-test",
    "",
    "The smoke uses bounded manifest GETs and installer HEADs only.",
  ].join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Release endpoint smoke failed: ${error.message}`);
    process.exitCode = 1;
  });
}

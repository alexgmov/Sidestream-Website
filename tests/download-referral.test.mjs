import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { compileApiFixture } from "./helpers/compile-api-fixture.mjs";

const repoRoot = process.cwd();
const installerSizes = {
  macos: readManifestSize("release-manifest.json"),
  windows: readManifestSize("release-manifest.windows.json"),
};
let compiledDirectory;
let createDownloadHandler;
let buildInstallerReferralEvent;
let isLikelyScanner;
let parseGmailReferral;
const originalHashSecret = process.env.SIDESTREAM_INSTALLER_ANALYTICS_HASH_SECRET;

before(async () => {
  process.env.SIDESTREAM_INSTALLER_ANALYTICS_HASH_SECRET = "download-referral-test-secret-that-is-long-enough";
  mkdirSync(path.join(repoRoot, "node_modules", ".tmp"), { recursive: true });
  compiledDirectory = mkdtempSync(
    path.join(repoRoot, "node_modules", ".tmp", "download-referral-test-"),
  );
  compileApiFixture(["api/download.ts"], compiledDirectory, repoRoot);

  ({ createDownloadHandler } = await import(
    pathToFileURL(path.join(compiledDirectory, "api", "download.js")).href
  ));
  ({ buildInstallerReferralEvent, isLikelyScanner, parseGmailReferral } = await import(
    pathToFileURL(
      path.join(compiledDirectory, "api", "_lib", "installer-referral.js"),
    ).href
  ));
});

after(() => {
  if (compiledDirectory) rmSync(compiledDirectory, { recursive: true, force: true });
  if (originalHashSecret === undefined) {
    delete process.env.SIDESTREAM_INSTALLER_ANALYTICS_HASH_SECRET;
  } else {
    process.env.SIDESTREAM_INSTALLER_ANALYTICS_HASH_SECRET = originalHashSecret;
  }
});

test("tagged Windows GET redirects before recording a normalized referral", async () => {
  const recorded = [];
  const handler = downloadHandler({
    headInstaller: async () => ({
      contentType: "application/vnd.microsoft.portable-executable",
      etag: "windows-etag",
      size: installerSizes.windows,
    }),
    createSignedUrl: async () => "https://blob.example/signed-installer.exe",
    recordReferral: async (event) => {
      recorded.push(event);
    },
    logTrackingError: () => assert.fail("tracking should not fail"),
  });
  const result = await invoke(handler, {
    path: "/api/download?platform=win32-x64&utm_source=Gmail&utm_medium=email&utm_campaign=Windows_Beta_1_0_13&utm_content=Pilot&ignored=value",
    headers: {
      "user-agent": "Mozilla/5.0 Chrome/140.0",
      "x-forwarded-for": "203.0.113.7",
    },
  });

  assert.equal(result.response.status, 302);
  assert.equal(result.response.headers.get("location"), "https://blob.example/signed-installer.exe");
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.equal(result.response.headers.get("x-content-type-options"), "nosniff");
  await result.handlerDone;
  await flushBackground(handler);
  assert.equal(recorded.length, 1);
  assert.deepEqual(
    {
      platform: recorded[0].platform,
      source: recorded[0].utmSource,
      medium: recorded[0].utmMedium,
      campaign: recorded[0].utmCampaign,
      content: recorded[0].utmContent,
      likelyScanner: recorded[0].likelyScanner,
    },
    {
      platform: "win32-x64",
      source: "gmail",
      medium: "email",
      campaign: "windows_beta_1_0_13",
      content: "pilot",
      likelyScanner: false,
    },
  );
  assert.match(recorded[0].requestHash, /^[0-9a-f]{64}$/);
  assert.equal("ipAddress" in recorded[0], false);
  assert.equal("userAgent" in recorded[0], false);
});

test("tracking rejection cannot change a successful redirect", async () => {
  const errors = [];
  const handler = downloadHandler({
    recordReferral: async () => {
      throw new Error("database unavailable");
    },
    logTrackingError: (error) => errors.push(error),
  });
  const result = await invoke(handler, { path: taggedPath() });

  assert.equal(result.response.status, 302);
  assert.equal(result.response.headers.get("location"), "https://blob.example/signed");
  await result.handlerDone;
  await flushBackground(handler);
  assert.equal(errors.length, 1);
});

test("background scheduling failure cannot change a successful redirect", async () => {
  const errors = [];
  const handler = downloadHandler({
    scheduleBackground: () => {
      throw new Error("background lifecycle unavailable");
    },
    logTrackingError: (error) => errors.push(error),
  });
  const result = await invoke(handler, { path: taggedPath() });

  assert.equal(result.response.status, 302);
  assert.equal(result.response.headers.get("location"), "https://blob.example/signed");
  await result.handlerDone;
  assert.equal(errors.length, 1);
});

test("a hung writer is bounded without delaying the client response", async () => {
  const errors = [];
  const handler = downloadHandler({
    recordReferral: () => new Promise(() => {}),
    trackingTimeoutMs: 30,
    logTrackingError: (error) => errors.push(error),
  });
  const result = await invoke(handler, { path: taggedPath() });

  assert.equal(result.response.status, 302);
  await result.handlerDone;
  assert.equal(errors.length, 0, "handler should return before background timeout");
  await flushBackground(handler);
  assert.equal(errors.length, 1);
});

test("HEAD, untagged GET, and matching ETag never record referrals", async () => {
  for (const request of [
    { method: "HEAD", path: taggedPath() },
    { method: "GET", path: "/api/download?platform=win32-x64" },
    { method: "GET", path: taggedPath(), headers: { "if-none-match": "test-etag" } },
  ]) {
    let records = 0;
    let signedUrls = 0;
    const handler = downloadHandler({
      createSignedUrl: async () => {
        signedUrls += 1;
        return "https://blob.example/signed";
      },
      recordReferral: async () => {
        records += 1;
      },
    });
    const result = await invoke(handler, request);
    await result.handlerDone;
    await flushBackground(handler);

    assert.equal(records, 0);
    assert.equal(handler.backgroundTasks.length, 0);
    assert.equal(signedUrls, request.method === "HEAD" || request.headers ? 0 : 1);
    assert.equal(
      result.response.status,
      request.method === "HEAD" ? 200 : request.headers ? 304 : 302,
    );
  }
});

test("invalid platform and fulfillment failures never record referrals", async () => {
  let records = 0;
  let metadataReads = 0;
  const unknown = downloadHandler({
    headInstaller: async () => {
      metadataReads += 1;
      return {};
    },
    recordReferral: async () => {
      records += 1;
    },
  });
  const unknownResult = await invoke(unknown, {
    path: "/api/download?platform=linux&utm_source=gmail&utm_medium=email&utm_campaign=launch",
  });
  await unknownResult.handlerDone;
  assert.equal(unknownResult.response.status, 404);
  assert.equal(metadataReads, 0);
  assert.equal(records, 0);

  const failed = downloadHandler({
    createSignedUrl: async () => {
      throw new Error("signing failed");
    },
    recordReferral: async () => {
      records += 1;
    },
  });
  const failedResult = await invoke(failed, { path: taggedPath() });
  await assert.rejects(failedResult.handlerDone, /signing failed/);
  assert.equal(records, 0);
});

test("scanner signals are flagged but remain eligible for persistence", () => {
  const userAgents = [
    "GoogleImageProxy",
    "Proofpoint URL Defense",
    "Mimecast Security Agent",
    "Barracuda Link Protect",
    "Microsoft Office Existence Discovery",
  ];

  for (const userAgent of userAgents) {
    assert.equal(isLikelyScanner(fakeRequest({ "user-agent": userAgent })), true);
  }
  assert.equal(isLikelyScanner(fakeRequest({ purpose: "prefetch" })), true);
  assert.equal(isLikelyScanner(fakeRequest({ "sec-purpose": "prefetch;prerender" })), true);
  assert.equal(
    isLikelyScanner(fakeRequest({ "user-agent": "Mozilla/5.0 Chrome/140.0" })),
    false,
  );
});

test("anonymous hashes are deterministic, scoped, and contain no raw identity", () => {
  const request = fakeRequest({
    "user-agent": "Mozilla/5.0 Chrome/140.0",
    "x-forwarded-for": "203.0.113.9",
  });
  const url = new URL(`https://sidestream.tv${taggedPath()}`);
  const options = { now: new Date("2026-07-14T12:00:00.000Z"), secret: "secret-a" };
  const first = buildInstallerReferralEvent(request, url, "windows", options);
  const second = buildInstallerReferralEvent(request, url, "windows", options);
  const differentSecret = buildInstallerReferralEvent(request, url, "windows", {
    ...options,
    secret: "secret-b",
  });
  const differentDay = buildInstallerReferralEvent(request, url, "windows", {
    ...options,
    now: new Date("2026-07-15T12:00:00.000Z"),
  });

  assert.equal(first.requestHash, second.requestHash);
  assert.notEqual(first.requestHash, differentSecret.requestHash);
  assert.notEqual(first.requestHash, differentDay.requestHash);
  assert.equal(JSON.stringify(first).includes("203.0.113.9"), false);
  assert.equal(JSON.stringify(first).includes("Chrome/140.0"), false);
});

test("Gmail UTM parsing rejects malformed, oversized, and unrelated tags", () => {
  assert.deepEqual(
    parseGmailReferral(new URLSearchParams(
      "utm_source=gmail&utm_medium=email&utm_campaign=windows_beta_1_0_13&utm_content=main&email=person%40example.com",
    )),
    {
      utmSource: "gmail",
      utmMedium: "email",
      utmCampaign: "windows_beta_1_0_13",
      utmContent: "main",
    },
  );
  assert.equal(parseGmailReferral(new URLSearchParams("utm_source=twitter&utm_medium=email&utm_campaign=launch")), null);
  assert.equal(parseGmailReferral(new URLSearchParams("utm_source=gmail&utm_medium=email&utm_campaign=bad%0Avalue")), null);
  assert.equal(
    parseGmailReferral(new URLSearchParams(`utm_source=gmail&utm_medium=email&utm_campaign=${"a".repeat(101)}`)),
    null,
  );
  assert.equal(parseGmailReferral(new URLSearchParams("utm_source=gmail&utm_medium=email&utm_campaign=launch&utm_content=%7B%7Bbatch%7D%7D")), null);
});

function downloadHandler(overrides = {}) {
  const backgroundTasks = [];
  const handler = createDownloadHandler({
    headInstaller: async (pathname) => ({
      contentType: "application/octet-stream",
      etag: "test-etag",
      size: pathname.endsWith(".exe")
        ? installerSizes.windows
        : installerSizes.macos,
    }),
    createSignedUrl: async () => "https://blob.example/signed",
    recordReferral: async () => {},
    logTrackingError: () => {},
    scheduleBackground: (operation) => {
      backgroundTasks.push(operation);
    },
    ...overrides,
  });
  handler.backgroundTasks = backgroundTasks;
  return handler;
}

async function flushBackground(handler) {
  await Promise.all(handler.backgroundTasks || []);
}

function readManifestSize(filename) {
  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, "data", filename), "utf8"),
  );
  return manifest.artifact.sizeBytes;
}

function taggedPath() {
  return "/api/download?platform=win32-x64&utm_source=gmail&utm_medium=email&utm_campaign=windows_beta_1_0_13&utm_content=pilot";
}

function fakeRequest(headers = {}) {
  return {
    headers,
    socket: { remoteAddress: "127.0.0.1" },
  };
}

async function invoke(handler, options = {}) {
  let resolveHandler;
  let rejectHandler;
  const handlerDone = new Promise((resolve, reject) => {
    resolveHandler = resolve;
    rejectHandler = reject;
  });
  handlerDone.catch(() => {});
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).then(resolveHandler, (error) => {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.end("handler failure");
      } else if (!response.writableEnded) {
        response.end();
      }
      rejectHandler(error);
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const requestHeaders = options.headers || {};
  if (!("user-agent" in requestHeaders)) {
    requestHeaders["user-agent"] = "Mozilla/5.0 Chrome/140.0";
  }
  if (!("x-forwarded-for" in requestHeaders)) {
    requestHeaders["x-forwarded-for"] = "203.0.113.10";
  }

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${options.path || "/api/download"}`, {
      method: options.method || "GET",
      headers: requestHeaders,
      redirect: "manual",
    });
    await response.arrayBuffer();
    return { response, handlerDone };
  } finally {
    server.close();
  }
}

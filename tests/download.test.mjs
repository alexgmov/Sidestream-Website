import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { compileApiFixture } from "./helpers/compile-api-fixture.mjs";

import {
  ACQUISITION_COOKIE_NAME,
  createBrowserAcquisitionCookie,
} from "../api/_lib/acquisition-cookie.ts";

const SECRET = "download-anonymous-acquisition-test-secret-0123456789";
const NOW = new Date("2026-07-31T18:00:00.000Z");
const manifests = {
  macos: readManifest("release-manifest.json"),
  windows: readManifest("release-manifest.windows.json"),
};
let compiledDirectory;
let createDownloadHandler;
let macRollout;
let deliveryModule;

before(async () => {
  mkdirSync(path.join(process.cwd(), "node_modules", ".tmp"), { recursive: true });
  compiledDirectory = mkdtempSync(
    path.join(process.cwd(), "node_modules", ".tmp", "anonymous-download-test-"),
  );
  compileApiFixture(["api/download.ts"], compiledDirectory);
  ({ createDownloadHandler } = await import(
    pathToFileURL(path.join(compiledDirectory, "api", "download.js")).href
  ));
  macRollout = await import(pathToFileURL(path.join(compiledDirectory, "api/_lib/mac-download-rollout.js")));
  const { parseReleaseManifest } = await import(pathToFileURL(path.join(compiledDirectory, "api/_lib/release-manifest.js")));
  for (const platform of ["macos", "windows"]) manifests[platform] = parseReleaseManifest(manifests[platform], platform);
  deliveryModule = await import(pathToFileURL(path.join(compiledDirectory, "api/_lib/installer-delivery.js")));
});

after(() => {
  if (compiledDirectory) rmSync(compiledDirectory, { recursive: true, force: true });
});

test("successful human GET preserves the static Blob redirect and records signed first touch", async () => {
  const cookie = createBrowserAcquisitionCookie({
    attribution: { source: "reddit", medium: "social", campaign: "launch", content: "hero" },
  }, { secret: SECRET, now: NOW, randomBytes: () => new Uint8Array(32).fill(7) });
  const recorded = [];
  const handler = downloadHandler({
    recordAcquisition: async (event) => recorded.push(event),
  });
  const result = await invoke(handler, {
    path: "/api/download?platform=win32-x64&utm_source=google&utm_campaign=overwrite",
    headers: { cookie: `${ACQUISITION_COOKIE_NAME}=${cookie.value}` },
  });
  assert.equal(result.response.status, 302);
  assert.equal(result.response.headers.get("location"), "https://blob.example/private-static-installer");
  assert.equal(result.response.headers.get("set-cookie"), null);
  assert.equal((await result.response.arrayBuffer()).byteLength, 0);
  await result.handlerDone;
  await flushBackground(handler);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].platform, "windows");
  assert.deepEqual(recorded[0].cookie.attribution, {
    source: "reddit",
    medium: "social",
    campaign: "launch",
    content: "hero",
  });
});

test("cookie absence creates direct first touch without blocking installer fulfillment", async () => {
  const recorded = [];
  const handler = downloadHandler({
    recordAcquisition: async (event) => recorded.push(event),
  });
  const result = await invoke(handler);
  assert.equal(result.response.status, 302);
  const setCookie = result.response.headers.get("set-cookie");
  assert.match(setCookie, new RegExp(`^${ACQUISITION_COOKIE_NAME}=`));
  assert.match(setCookie, /Secure; HttpOnly; SameSite=Lax/);
  await result.response.arrayBuffer();
  await result.handlerDone;
  await flushBackground(handler);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].cookie.attribution.source, "direct");
  assert.match(recorded[0].cookie.token, /^[A-Za-z0-9_-]{43}$/);
});

test("forged state fails closed to the current bounded source", async () => {
  const recorded = [];
  const handler = downloadHandler({
    recordAcquisition: async (event) => recorded.push(event),
  });
  const result = await invoke(handler, {
    path: "/api/download?utm_source=linkedin&utm_medium=social&utm_campaign=launch",
    headers: { cookie: `${ACQUISITION_COOKIE_NAME}=forged.value` },
  });
  assert.equal(result.response.status, 302);
  assert.ok(result.response.headers.get("set-cookie"));
  await result.response.arrayBuffer();
  await result.handlerDone;
  await flushBackground(handler);
  assert.equal(recorded[0].cookie.attribution.source, "linkedin");
});

test("HEAD, 304, scanners, invalid platform, and failed signing never record acquisition", async () => {
  const cases = [
    { options: { method: "HEAD" }, expectedStatus: 200 },
    { options: { headers: { "if-none-match": "test-etag" } }, expectedStatus: 304 },
    {
      options: { headers: { "x-sidestream-origin-if-none-match": "test-etag" } },
      expectedStatus: 304,
    },
    { options: { headers: { "user-agent": "GoogleImageProxy" } }, expectedStatus: 302 },
    { options: { path: "/api/download?platform=linux" }, expectedStatus: 404 },
  ];
  for (const entry of cases) {
    const recorded = [];
    const handler = downloadHandler({
      recordAcquisition: async (event) => recorded.push(event),
    });
    const result = await invoke(handler, entry.options);
    assert.equal(result.response.status, entry.expectedStatus);
    await result.response.arrayBuffer();
    await result.handlerDone;
    await flushBackground(handler);
    assert.equal(recorded.length, 0);
  }

  const recorded = [];
  const handler = downloadHandler({
    createSignedUrl: async () => {
      throw new Error("signing failed");
    },
    recordAcquisition: async (event) => recorded.push(event),
  });
  const result = await invoke(handler);
  await result.response.arrayBuffer();
  await assert.rejects(result.handlerDone, /signing failed/);
  assert.equal(recorded.length, 0);
});

test("Mac and Windows fulfillment select the manifest artifact without wrapping or exposing Blob paths", async () => {
  for (const [platform, requestPath] of [
    ["macos", "/api/download"],
    ["windows", "/api/download?platform=win32-x64"],
  ]) {
    const selected = [];
    const handler = downloadHandler({
      headInstaller: async (pathname) => {
        selected.push(pathname);
        return {
          contentType: "application/octet-stream",
          etag: "artifact-etag",
          size: manifests[platform].artifact.sizeBytes,
        };
      },
      createSignedUrl: async (pathname) => {
        assert.equal(pathname, manifests[platform].artifact.pathname);
        return "https://blob.example/private-static-installer";
      },
    });
    const result = await invoke(handler, { path: requestPath });
    assert.equal(result.response.status, 302);
    assert.equal(result.response.headers.get("location"), "https://blob.example/private-static-installer");
    assert.equal((await result.response.arrayBuffer()).byteLength, 0);
    await result.handlerDone;
    assert.deepEqual(selected, [manifests[platform].artifact.pathname]);
    assert.match(manifests[platform].artifact.sha256, /^[0-9a-f]{64}$/);
  }
});

function downloadHandler(overrides = {}) {
  const backgroundTasks = [];
  const handler = createDownloadHandler({
    readMacRollout: () => null,
    logDownloadSelection: () => {},
    headInstaller: async (pathname) => ({
      contentType: "application/octet-stream",
      etag: "test-etag",
      size: pathname === manifests.windows.artifact.pathname
        ? manifests.windows.artifact.sizeBytes
        : manifests.macos.artifact.sizeBytes,
    }),
    createSignedUrl: async () => "https://blob.example/private-static-installer",
    recordReferral: async () => {},
    recordAcquisition: async () => {},
    getAcquisitionSecret: () => SECRET,
    now: () => new Date(NOW),
    logTrackingError: () => {},
    logManifestError: () => {},
    scheduleBackground: (operation) => backgroundTasks.push(operation),
    ...overrides,
  });
  handler.backgroundTasks = backgroundTasks;
  return handler;
}

async function flushBackground(handler) {
  await Promise.all(handler.backgroundTasks || []);
}

function readManifest(filename) {
  return JSON.parse(readFileSync(path.join(process.cwd(), "data", filename), "utf8"));
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
  const headers = { "user-agent": "Mozilla/5.0 Chrome/140.0", ...(options.headers || {}) };
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${options.path || "/api/download"}`, {
      method: options.method || "GET",
      headers,
      redirect: "manual",
    });
    return { response, handlerDone };
  } finally {
    server.close();
  }
}


function pilotConfig(percent = 1) {
  return macRollout.parseMacDownloadRollout({ ...readManifest("mac-download-rollout.json"), percent });
}

function pilotCookie(wanted) {
  const config = pilotConfig();
  for (let n = 1; n < 10000; n += 1) {
    const cookie = createBrowserAcquisitionCookie({ acquisitionId: `12345678-1234-4234-8234-${n.toString(16).padStart(12, "0")}` }, { secret: SECRET, now: NOW });
    if ((macRollout.selectMacDownloadManifest(manifests.macos, config, cookie.token, SECRET) === config.candidate) === wanted) return cookie;
  }
  throw new Error("Deterministic cohort fixture missing");
}

function pilotHandler(overrides = {}) {
  const candidate = pilotConfig().candidate;
  return downloadHandler({
    readMacRollout: () => pilotConfig(),
    headInstaller: async (pathname) => {
      const artifact = [manifests.macos, manifests.windows, candidate].find((x) => x.artifact.pathname === pathname)?.artifact;
      assert.ok(artifact);
      return { size: artifact.sizeBytes, sha256: artifact.sha256, etag: artifact.sha256 };
    },
    createSignedUrl: async (pathname) => `https://downloads.example/${pathname}`,
    ...overrides,
  });
}

test("Mac download pilot is independently bound, disabled at zero, and never an update notice", () => {
  const source = readManifest("mac-download-rollout.json");
  const config = pilotConfig();
  assert.equal(config.percent, 1);
  assert.equal(config.candidate.version, "1.0.57");
  assert.equal(config.candidate.rolloutPercent, 0);
  assert.equal(manifests.macos.version, "1.0.21");
  assert.equal(macRollout.parseMacDownloadRollout({ ...source, enabled: false }), null);
  assert.equal(macRollout.parseMacDownloadRollout({ ...source, percent: 0 }), null);
  for (const percent of [-1, 101, 1.5, "1"]) assert.throws(() => macRollout.parseMacDownloadRollout({ ...source, percent }));
  assert.throws(() => macRollout.parseMacDownloadRollout({ ...source, candidate: { ...source.candidate, channel: "stable" } }));
  assert.throws(() => macRollout.parseMacDownloadRollout({ ...source, candidate: { ...source.candidate, critical: true } }));
  assert.ok(deliveryModule.listManifestInstallerArtifacts().some((x) => x.pathname === config.candidate.artifact.pathname));
});

test("one percent assignment is stable, statistically bounded, and rejects unbound inputs", () => {
  const config = pilotConfig();
  let selected = 0;
  for (let n = 0; n < 10000; n += 1) {
    const bytes = Buffer.alloc(32); bytes.writeUInt32BE(n);
    const token = bytes.toString("base64url");
    const first = macRollout.selectMacDownloadManifest(manifests.macos, config, token, SECRET);
    assert.equal(macRollout.selectMacDownloadManifest(manifests.macos, config, token, SECRET), first);
    if (first === config.candidate) selected += 1;
  }
  assert.ok(selected >= 65 && selected <= 135, `1 percent of 10000 identities: ${selected}`);
  const cookie = pilotCookie(true);
  for (const [stable, rollout, token, secret] of [
    [manifests.windows, config, cookie.token, SECRET],
    [manifests.macos, null, cookie.token, SECRET],
    [manifests.macos, config, undefined, SECRET],
    [manifests.macos, config, cookie.token, "short"],
    [{ ...manifests.macos, version: "1.0.58" }, config, cookie.token, SECRET],
    [{ ...manifests.macos, artifact: { ...manifests.macos.artifact, sha256: "0".repeat(64) } }, config, cookie.token, SECRET],
  ]) assert.equal(macRollout.selectMacDownloadManifest(stable, rollout, token, secret), stable);
});

test("pilot GET and cookie-bearing HEAD return the same verified artifact without identity headers", async () => {
  const cookie = pilotCookie(true);
  const headers = { cookie: `${ACQUISITION_COOKIE_NAME}=${cookie.value}` };
  const recorded = [];
  const selections = [];
  const handler = pilotHandler({ recordAcquisition: async (x) => recorded.push(x), logDownloadSelection: (x) => selections.push(x) });
  for (const method of ["HEAD", "GET", "GET"]) {
    const result = await invoke(handler, { method, headers });
    assert.equal(result.response.status, method === "HEAD" ? 200 : 302);
    assert.equal(result.response.headers.get("x-sidestream-version"), "1.0.57");
    assert.equal(result.response.headers.get("x-sidestream-download-cohort"), "pilot");
    assert.equal(result.response.headers.get("x-sidestream-sha256"), pilotConfig().candidate.artifact.sha256);
    assert.equal(result.response.headers.get("vary"), "Cookie");
    if (method === "HEAD") assert.equal(result.response.headers.get("content-length"), "227078245");
    else assert.match(result.response.headers.get("location"), /manual-beta\/1\.0\.57/);
    assert.ok(!JSON.stringify([...result.response.headers]).includes(cookie.token));
    await result.response.arrayBuffer(); await result.handlerDone; await flushBackground(handler);
  }
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].cookie.value, cookie.value);
  assert.equal(selections.length, 2);
  assert.deepEqual(Object.keys(selections[0]).sort(), ["cohort", "rolloutId", "version"]);
});

test("control, stable recovery, unauthenticated HEAD and Windows never become pilot downloads", async () => {
  for (const entry of [
    { path: "/api/download?release=pilot&rollout=100", cookie: pilotCookie(false).value, version: "1.0.21" },
    { path: "/api/download?release=stable", cookie: pilotCookie(true).value, version: "1.0.21" },
    { method: "HEAD", version: "1.0.21" },
    { method: "HEAD", cookie: "forged.value", version: "1.0.21" },
    { method: "HEAD", cookie: createBrowserAcquisitionCookie({}, { secret: SECRET, now: new Date("2026-01-01T00:00:00Z") }).value, version: "1.0.21" },
    { path: "/api/download?platform=win32-x64", cookie: pilotCookie(true).value, version: manifests.windows.version },
  ]) {
    const handler = pilotHandler();
    const result = await invoke(handler, { path: entry.path, method: entry.method, headers: entry.cookie ? { cookie: `${ACQUISITION_COOKIE_NAME}=${entry.cookie}` } : {} });
    assert.equal(result.response.status, entry.method === "HEAD" ? 200 : 302);
    assert.equal(result.response.headers.get("x-sidestream-version"), entry.version);
    assert.notEqual(result.response.headers.get("x-sidestream-download-cohort"), "pilot");
    await result.response.arrayBuffer(); await result.handlerDone; await flushBackground(handler);
  }
});

test("first successful GET persists its server-issued assignment without affecting failed or HEAD requests", async () => {
  const handler = pilotHandler({ readMacRollout: () => pilotConfig(100) });
  const first = await invoke(handler);
  assert.equal(first.response.headers.get("x-sidestream-version"), "1.0.57");
  const cookie = first.response.headers.get("set-cookie").split(";")[0];
  assert.match(cookie, /^__Host-sidestream-acquisition-v2=/);
  await first.response.arrayBuffer(); await first.handlerDone; await flushBackground(handler);
  const retry = await invoke(handler, { headers: { cookie } });
  assert.equal(retry.response.headers.get("x-sidestream-version"), "1.0.57");
  assert.equal(retry.response.headers.get("set-cookie"), null);
  await retry.response.arrayBuffer(); await retry.handlerDone; await flushBackground(handler);
});

test("candidate missing, hash mismatch and signing errors fall back to validated stable bytes", async () => {
  const candidate = pilotConfig().candidate;
  const cookie = `${ACQUISITION_COOKIE_NAME}=${pilotCookie(true).value}`;
  for (const failure of ["missing", "hash", "sign", "config", "disabled"]) {
    const handler = pilotHandler({
      readMacRollout: () => { if (failure === "config") throw new Error("bad config"); return failure === "disabled" ? null : pilotConfig(); },
      headInstaller: async (pathname) => {
        if (pathname === candidate.artifact.pathname && failure === "missing") throw new Error("missing");
        const artifact = pathname === candidate.artifact.pathname ? candidate.artifact : manifests.macos.artifact;
        return { size: artifact.sizeBytes, sha256: pathname === candidate.artifact.pathname && failure === "hash" ? "0".repeat(64) : artifact.sha256, etag: artifact.sha256 };
      },
      createSignedUrl: async (pathname) => { if (pathname === candidate.artifact.pathname && failure === "sign") throw new Error("sign error"); return `https://downloads.example/${pathname}`; },
    });
    const result = await invoke(handler, { headers: { cookie } });
    assert.equal(result.response.status, 302);
    assert.equal(result.response.headers.get("x-sidestream-version"), "1.0.21");
    assert.equal(result.response.headers.get("x-sidestream-download-cohort"), "stable");
    assert.match(result.response.headers.get("location"), /1\.0\.21/);
    await result.response.arrayBuffer(); await result.handlerDone; await flushBackground(handler);
  }
});

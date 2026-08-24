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

before(async () => {
  mkdirSync(path.join(process.cwd(), "node_modules", ".tmp"), { recursive: true });
  compiledDirectory = mkdtempSync(
    path.join(process.cwd(), "node_modules", ".tmp", "anonymous-download-test-"),
  );
  compileApiFixture(["api/download.ts"], compiledDirectory);
  ({ createDownloadHandler } = await import(
    pathToFileURL(path.join(compiledDirectory, "api", "download.js")).href
  ));
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

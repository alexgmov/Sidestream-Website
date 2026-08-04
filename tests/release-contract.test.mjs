import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { compileApiFixture } from "./helpers/compile-api-fixture.mjs";

const repoRoot = process.cwd();
const manifestFixtures = {
  macos: loadManifestFixture("macos"),
  windows: loadManifestFixture("windows"),
};

let compiledDirectory;
let createDownloadHandler;
let createReleaseHandler;
let parseReleaseManifest;
const originalManifestPaths = {
  macos: process.env.SIDESTREAM_RELEASE_MANIFEST_PATH,
  windows: process.env.SIDESTREAM_WINDOWS_RELEASE_MANIFEST_PATH,
};

before(async () => {
  mkdirSync(path.join(repoRoot, "node_modules", ".tmp"), { recursive: true });
  compiledDirectory = mkdtempSync(
    path.join(repoRoot, "node_modules", ".tmp", "release-contract-test-"),
  );
  compileApiFixture(
    ["api/download.ts", "api/releases/latest.ts"],
    compiledDirectory,
    repoRoot,
  );

  ({ createDownloadHandler } = await import(
    pathToFileURL(path.join(compiledDirectory, "api", "download.js")).href
  ));
  ({ createReleaseHandler } = await import(
    pathToFileURL(
      path.join(compiledDirectory, "api", "releases", "latest.js"),
    ).href
  ));
  ({ parseReleaseManifest } = await import(
    pathToFileURL(
      path.join(compiledDirectory, "api", "_lib", "release-manifest.js"),
    ).href
  ));
});

after(() => {
  restoreEnvironment(
    "SIDESTREAM_RELEASE_MANIFEST_PATH",
    originalManifestPaths.macos,
  );
  restoreEnvironment(
    "SIDESTREAM_WINDOWS_RELEASE_MANIFEST_PATH",
    originalManifestPaths.windows,
  );
  if (compiledDirectory) {
    rmSync(compiledDirectory, { recursive: true, force: true });
  }
});

test("download and release handlers share the complete platform alias matrix", async () => {
  const cases = [
    { platform: "macos", query: "" },
    { platform: "macos", query: "?platform=darwin-arm64" },
    { platform: "macos", query: "?platform=darwin-x64" },
    { platform: "macos", query: "?platform=macos" },
    { platform: "macos", query: "?platform=macos-arm64" },
    { platform: "macos", query: "?platform=macos-x64" },
    { platform: "windows", query: "?platform=win32-x64" },
    { platform: "windows", query: "?platform=windows" },
    { platform: "windows", query: "?platform=windows-x64" },
  ];

  for (const entry of cases) {
    const fixture = manifestFixtures[entry.platform];
    const state = createDownloadState();
    const download = await invoke(state.handler, {
      method: "HEAD",
      path: `/api/download${entry.query}`,
    });
    await download.handlerDone;

    assert.equal(download.response.status, 200, entry.query || "bare download");
    assert.equal(
      download.response.headers.get("content-disposition"),
      `attachment; filename="${fixture.filename}"`,
    );
    assert.equal(
      download.response.headers.get("content-length"),
      String(fixture.size),
    );
    assert.equal(
      download.response.headers.get("x-sidestream-platform"),
      fixture.platform,
    );
    assert.equal(
      download.response.headers.get("x-sidestream-sha256"),
      fixture.sha256,
    );
    assert.deepEqual(state.headPathnames, [fixture.pathname]);
    assert.deepEqual(state.signedPathnames, []);

    const release = await invoke(releaseHandler(), {
      path: `/api/releases/latest${entry.query}`,
    });
    await release.handlerDone;
    const body = await release.response.json();

    assert.equal(release.response.status, 200, entry.query || "bare release");
    assert.equal(body.platform, fixture.platform);
    assert.equal(body.artifact.type, fixture.type);
    assert.equal(body.artifact.filename, fixture.filename);
    assert.equal(body.artifact.sizeBytes, fixture.size);
    assert.equal(body.artifact.sha256, fixture.sha256);
    assert.equal("pathname" in body.artifact, false);
  }
});

test("Linux, unknown, and explicitly empty platforms fail closed on both routes", async () => {
  const values = ["linux", "linux-x64", "freebsd", "unknown", ""];

  for (const value of values) {
    const query = `?platform=${encodeURIComponent(value)}`;
    const state = createDownloadState();
    const download = await invoke(state.handler, {
      path: `/api/download${query}`,
    });
    await download.handlerDone;

    assert.equal(download.response.status, 404);
    assert.deepEqual(state.headPathnames, []);
    assert.deepEqual(state.signedPathnames, []);
    assert.equal(state.backgroundTasks.length, 0);

    const release = await invoke(releaseHandler(), {
      path: `/api/releases/latest${query}`,
    });
    await release.handlerDone;
    assert.equal(release.response.status, 404);
  }
});

test("HEAD validates and returns public metadata without signing or response bytes", async () => {
  const state = createDownloadState({
    createSignedUrl: async () => assert.fail("HEAD must not sign a Blob URL"),
  });
  const download = await invoke(state.handler, {
    method: "HEAD",
    path: "/api/download?platform=win32-x64&utm_source=gmail&utm_medium=email&utm_campaign=head_test",
  });
  await download.handlerDone;

  assert.equal(download.response.status, 200);
  assert.equal((await download.response.arrayBuffer()).byteLength, 0);
  assert.equal(
    download.response.headers.get("x-sidestream-version"),
    manifestFixtures.windows.version,
  );
  assert.equal(state.backgroundTasks.length, 0);

  const release = await invoke(releaseHandler(), {
    method: "HEAD",
    path: "/api/releases/latest?platform=win32-x64",
  });
  await release.handlerDone;

  assert.equal(release.response.status, 200);
  assert.equal((await release.response.arrayBuffer()).byteLength, 0);
  assert.equal(release.response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.ok(Number(release.response.headers.get("content-length")) > 0);
  assert.equal(release.response.headers.get("x-sidestream-platform"), "win32-x64");
  assert.equal(
    release.response.headers.get("x-sidestream-version"),
    manifestFixtures.windows.version,
  );
});

test("GET downloads return only temporary redirects after metadata validation", async () => {
  for (const entry of [
    { path: "/api/download", platform: "macos" },
    { path: "/api/download?platform=win32-x64", platform: "windows" },
  ]) {
    const state = createDownloadState({
      createSignedUrl: async (pathname) => {
        state.signedPathnames.push(pathname);
        return "https://blob.example/short-lived-signed-download";
      },
    });
    const result = await invoke(state.handler, { path: entry.path });
    await result.handlerDone;

    assert.equal(result.response.status, 302);
    assert.equal(
      result.response.headers.get("location"),
      "https://blob.example/short-lived-signed-download",
    );
    assert.equal((await result.response.arrayBuffer()).byteLength, 0);
    assert.deepEqual(state.signedPathnames, [
      manifestFixtures[entry.platform].pathname,
    ]);
  }
});

test("the parser rejects malformed version, filename, size, checksum, time, and platform", () => {
  const source = readManifestFixture("windows");
  const malformed = [
    ["version", (manifest) => { manifest.version = "1.0"; }],
    ["filename", (manifest) => {
      manifest.artifact.pathname = manifest.artifact.pathname.replace(
        /\.exe$/i,
        ".dmg",
      );
    }],
    ["size", (manifest) => { manifest.artifact.sizeBytes = 0; }],
    ["checksum", (manifest) => { manifest.artifact.sha256 = "not-a-checksum"; }],
    ["published time", (manifest) => { manifest.publishedAt = "not-a-time"; }],
    ["platform", (manifest) => { manifest.platform = "macos"; }],
  ];

  for (const [label, mutate] of malformed) {
    const candidate = structuredClone(source);
    mutate(candidate);
    assert.throws(
      () => parseReleaseManifest(candidate, "windows"),
      undefined,
      label,
    );
  }
});

test("malformed manifests fail both handlers before Blob metadata or signing", async () => {
  const malformed = readManifestFixture("windows");
  malformed.platform = "macos";
  const manifestPath = path.join(compiledDirectory, "malformed-windows.json");
  writeFileSync(manifestPath, `${JSON.stringify(malformed)}\n`, "utf8");
  process.env.SIDESTREAM_WINDOWS_RELEASE_MANIFEST_PATH = manifestPath;

  try {
    const state = createDownloadState();
    const download = await invoke(state.handler, {
      path: "/api/download?platform=win32-x64",
    });
    await download.handlerDone;
    const downloadBody = await download.response.text();

    assert.equal(download.response.status, 503);
    assert.equal(downloadBody, "Release manifest is not available");
    assert.equal(downloadBody.includes(manifestFixtures.windows.pathname), false);
    assert.doesNotMatch(downloadBody, /pathname/i);
    assert.deepEqual(state.headPathnames, []);
    assert.deepEqual(state.signedPathnames, []);

    const release = await invoke(releaseHandler(), {
      path: "/api/releases/latest?platform=win32-x64",
    });
    await release.handlerDone;
    const releaseBody = await release.response.text();

    assert.equal(release.response.status, 503);
    assert.equal(releaseBody.includes(manifestFixtures.windows.pathname), false);
    assert.doesNotMatch(releaseBody, /pathname/i);
  } finally {
    restoreEnvironment(
      "SIDESTREAM_WINDOWS_RELEASE_MANIFEST_PATH",
      originalManifestPaths.windows,
    );
  }
});

test("Blob size drift fails closed and never signs or schedules tracking", async () => {
  const state = createDownloadState({
    headInstaller: async () => ({
      contentType: "application/vnd.microsoft.portable-executable",
      etag: "wrong-size",
      size: manifestFixtures.windows.size - 1,
    }),
  });
  const result = await invoke(state.handler, {
    path: "/api/download?platform=win32-x64&utm_source=gmail&utm_medium=email&utm_campaign=size_drift",
  });
  await result.handlerDone;

  assert.equal(result.response.status, 503);
  assert.deepEqual(state.signedPathnames, []);
  assert.equal(state.backgroundTasks.length, 0);
});

test("public release metadata redacts Blob pathnames and signing inputs", async () => {
  const result = await invoke(releaseHandler(), {
    path: "/api/releases/latest?platform=win32-x64",
  });
  await result.handlerDone;
  const body = await result.response.text();
  const manifest = JSON.parse(body);

  assert.equal(result.response.status, 200);
  assert.deepEqual(Object.keys(manifest.artifact).sort(), [
    "filename",
    "sha256",
    "sizeBytes",
    "type",
    "url",
  ]);
  assert.doesNotMatch(body, /pathname|signed.?token|validUntil|BLOB_/i);
  assert.equal(body.includes(manifestFixtures.windows.pathname), false);
});

function createDownloadState(overrides = {}) {
  const state = {
    backgroundTasks: [],
    headPathnames: [],
    signedPathnames: [],
  };
  const defaultHeadInstaller = async (pathname) => {
    state.headPathnames.push(pathname);
    const fixture = pathname.endsWith(".exe")
      ? manifestFixtures.windows
      : manifestFixtures.macos;
    return {
      contentType: fixture.type === "exe"
        ? "application/vnd.microsoft.portable-executable"
        : "application/x-apple-diskimage",
      etag: `${fixture.platform}-etag`,
      size: fixture.size,
    };
  };

  state.handler = createDownloadHandler({
    headInstaller: overrides.headInstaller || defaultHeadInstaller,
    createSignedUrl: overrides.createSignedUrl || (async (pathname) => {
      state.signedPathnames.push(pathname);
      return "https://blob.example/short-lived-signed-download";
    }),
    recordReferral: async () => {},
    logManifestError: () => {},
    logTrackingError: () => {},
    scheduleBackground: (operation) => {
      state.backgroundTasks.push(operation);
    },
  });
  return state;
}

function releaseHandler() {
  return createReleaseHandler({ logManifestError: () => {} });
}

function loadManifestFixture(platformName) {
  const manifest = readManifestFixture(platformName);
  return {
    filename: path.posix.basename(manifest.artifact.pathname),
    pathname: manifest.artifact.pathname,
    platform: platformName === "windows" ? "win32-x64" : "macos",
    sha256: manifest.artifact.sha256,
    size: manifest.artifact.sizeBytes,
    type: manifest.artifact.type,
    version: manifest.version,
  };
}

function readManifestFixture(platformName) {
  const filename = platformName === "windows"
    ? "release-manifest.windows.json"
    : "release-manifest.json";
  return JSON.parse(readFileSync(path.join(repoRoot, "data", filename), "utf8"));
}

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
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

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}${options.path || "/"}`,
      {
        method: options.method || "GET",
        headers: options.headers,
        redirect: "manual",
      },
    );
    return { response, handlerDone };
  } finally {
    server.close();
  }
}

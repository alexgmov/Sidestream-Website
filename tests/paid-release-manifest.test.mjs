import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const fixtureSources = {
  "macos-universal": readFixture("macos-universal"),
  "windows-x64": readFixture("windows-x64"),
};
const originalManifestPaths = {
  "macos-universal": process.env.SIDESTREAM_RELEASE_MANIFEST_PATH,
  "windows-x64": process.env.SIDESTREAM_WINDOWS_RELEASE_MANIFEST_PATH,
};

let compiledDirectory;
let createPaidDownloadHandler;
let createPaidReleaseHandler;
let getPaidArtifactPathname;
let readPaidReleaseManifest;
let resolvePaidReleasePlatform;
let selectPaidReleasePlatform;
let toPaidReleaseManifest;
let toPublicPaidReleaseManifest;

before(async () => {
  compiledDirectory = mkdtempSync(
    path.join(os.tmpdir(), "sidestream-paid-release-test-"),
  );
  copyTypeScriptModule(
    "api/_lib/release-manifest.ts",
    "api/_lib/release-manifest.ts",
  );
  copyTypeScriptModule(
    "api/_lib/paid-release-manifest.ts",
    "api/_lib/paid-release-manifest.ts",
  );
  copyTypeScriptModule(
    "api/_lib/paid-download.ts",
    "api/_lib/paid-download.ts",
  );
  copyTypeScriptModule(
    "api/releases/paid-latest.ts",
    "api/releases/paid-latest.ts",
  );

  ({
    getPaidArtifactPathname,
    readPaidReleaseManifest,
    resolvePaidReleasePlatform,
    selectPaidReleasePlatform,
    toPaidReleaseManifest,
    toPublicPaidReleaseManifest,
  } = await import(
    pathToFileURL(
      path.join(compiledDirectory, "api", "_lib", "paid-release-manifest.ts"),
    ).href
  ));
  ({ createPaidDownloadHandler } = await import(
    pathToFileURL(
      path.join(compiledDirectory, "api", "_lib", "paid-download.ts"),
    ).href
  ));
  ({ createPaidReleaseHandler } = await import(
    pathToFileURL(
      path.join(compiledDirectory, "api", "releases", "paid-latest.ts"),
    ).href
  ));
});

after(() => {
  restoreEnvironment(
    "SIDESTREAM_RELEASE_MANIFEST_PATH",
    originalManifestPaths["macos-universal"],
  );
  restoreEnvironment(
    "SIDESTREAM_WINDOWS_RELEASE_MANIFEST_PATH",
    originalManifestPaths["windows-x64"],
  );
  if (compiledDirectory) {
    rmSync(compiledDirectory, { recursive: true, force: true });
  }
});

test("paid manifests expose exactly the bounded public contract", () => {
  for (const platform of ["macos-universal", "windows-x64"]) {
    const manifest = readPaidReleaseManifest(platform);
    const publicManifest = toPublicPaidReleaseManifest(manifest);

    assert.equal(manifest.platform, platform);
    assert.match(manifest.artifactPathname, /^sidestream\/[0-9.]+\//);
    assert.deepEqual(Object.keys(publicManifest), [
      "schemaVersion",
      "platform",
      "version",
      "filename",
      "sizeBytes",
      "sha256",
    ]);
    assert.equal(
      JSON.stringify(publicManifest).includes(manifest.artifactPathname),
      false,
    );
    assert.equal("pathname" in publicManifest, false);
    assert.equal("artifactPathname" in publicManifest, false);
    assert.match(
      getPaidArtifactPathname(manifest),
      /^sidestream\/[0-9.]+\//,
    );
  }
});

test("platform selection is exact, singular, and has no default or aliases", () => {
  for (const platform of ["macos-universal", "windows-x64"]) {
    assert.equal(resolvePaidReleasePlatform(platform), platform);
    assert.equal(
      selectPaidReleasePlatform(new URLSearchParams(`platform=${platform}`)),
      platform,
    );
  }

  for (const value of [
    undefined,
    null,
    "",
    "macos",
    "win32-x64",
    "MACOS-UNIVERSAL",
    " macos-universal",
    "windows-x64 ",
    "linux-x64",
  ]) {
    assert.equal(resolvePaidReleasePlatform(value), null);
  }

  for (const query of [
    "",
    "platform=",
    "platform=macos",
    "platform=macos-universal&platform=windows-x64",
    "platform=macos-universal&receipt=fixture",
  ]) {
    assert.equal(selectPaidReleasePlatform(new URLSearchParams(query)), null);
  }
});

test("paid manifests are exact projections of the canonical stable releases", () => {
  for (const platform of ["macos-universal", "windows-x64"]) {
    const manifest = readPaidReleaseManifest(platform);
    const canonical = readCanonicalFixture(platform);

    assert.equal(manifest.version, canonical.version);
    assert.equal(manifest.filename, path.basename(canonical.artifact.pathname));
    assert.equal(manifest.sizeBytes, canonical.artifact.sizeBytes);
    assert.equal(manifest.sha256, canonical.artifact.sha256);
    assert.equal(manifest.artifactPathname, canonical.artifact.pathname);
  }

  assert.throws(
    () => toPaidReleaseManifest(
      readPaidReleaseManifest("windows-x64"),
      "macos-universal",
    ),
    /platform mismatch/,
  );
});

test("paid latest GET and HEAD return no-store public metadata only", async () => {
  for (const platform of ["macos-universal", "windows-x64"]) {
    const getResult = await invoke(releaseHandler(), {
      path: `/api/releases/paid-latest?platform=${platform}`,
    });
    await getResult.handlerDone;
    const body = await getResult.response.text();
    const manifest = JSON.parse(body);

    assert.equal(getResult.response.status, 200);
    assert.equal(getResult.response.headers.get("cache-control"), "no-store");
    assert.deepEqual(Object.keys(manifest), [
      "schemaVersion",
      "platform",
      "version",
      "filename",
      "sizeBytes",
      "sha256",
    ]);
    assert.equal(body.includes(fixtureSources[platform].artifactPathname), false);
    assert.doesNotMatch(body, /pathname|BLOB_|signed.?token/i);

    const headResult = await invoke(releaseHandler(), {
      method: "HEAD",
      path: `/api/releases/paid-latest?platform=${platform}`,
    });
    await headResult.handlerDone;

    assert.equal(headResult.response.status, 200);
    assert.equal(headResult.response.headers.get("cache-control"), "no-store");
    assert.equal((await headResult.response.arrayBuffer()).byteLength, 0);
    assert.equal(
      headResult.response.headers.get("content-length"),
      String(Buffer.byteLength(body)),
    );
  }
});

test("paid metadata and the internal download helper reject inexact platform queries", async () => {
  for (const route of [
    { handler: releaseHandler(), path: "/api/releases/paid-latest" },
    { handler: downloadState().handler, path: "/api/paid-download" },
  ]) {
    const methodResult = await invoke(route.handler, {
      method: "POST",
      path: `${route.path}?platform=macos-universal`,
    });
    await methodResult.handlerDone;
    assert.equal(methodResult.response.status, 405);
    assert.equal(methodResult.response.headers.get("allow"), "GET, HEAD");
    assert.equal(methodResult.response.headers.get("cache-control"), "no-store");
  }

  for (const query of [
    "",
    "?platform=macos",
    "?platform=MACOS-UNIVERSAL",
    "?platform=macos-universal&platform=windows-x64",
    "?platform=windows-x64&ignored=1",
  ]) {
    const state = downloadState();
    const downloadResult = await invoke(state.handler, {
      path: `/api/paid-download${query}`,
    });
    await downloadResult.handlerDone;
    assert.equal(downloadResult.response.status, 404, query);
    assert.deepEqual(state.headPathnames, []);
    assert.deepEqual(state.signedPathnames, []);

    const releaseResult = await invoke(releaseHandler(), {
      path: `/api/releases/paid-latest${query}`,
    });
    await releaseResult.handlerDone;
    assert.equal(releaseResult.response.status, 404, query);
  }
});

test("the internal paid download helper validates HEAD metadata without signing", async () => {
  const state = downloadState({
    createSignedUrl: async () => assert.fail("HEAD must not sign"),
  });
  const result = await invoke(state.handler, {
    method: "HEAD",
    path: "/api/paid-download?platform=windows-x64",
  });
  await result.handlerDone;

  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.equal((await result.response.arrayBuffer()).byteLength, 0);
  assert.equal(
    result.response.headers.get("content-disposition"),
    `attachment; filename="${fixtureSources["windows-x64"].filename}"`,
  );
  assert.equal(
    result.response.headers.get("x-sidestream-paid-platform"),
    "windows-x64",
  );
  assert.deepEqual(state.headPathnames, [
    expectedPathname("windows-x64"),
  ]);
  assert.deepEqual(state.signedPathnames, []);
});

test("the receipt route's paid download helper signs only after metadata validation", async () => {
  const state = downloadState();
  const result = await invoke(state.handler, {
    path: "/api/paid-download?platform=macos-universal",
  });
  await result.handlerDone;

  assert.equal(result.response.status, 302);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.equal(
    result.response.headers.get("location"),
    "https://blob.example/short-lived-paid-artifact",
  );
  assert.equal((await result.response.arrayBuffer()).byteLength, 0);
  assert.deepEqual(state.headPathnames, [
    expectedPathname("macos-universal"),
  ]);
  assert.deepEqual(state.signedPathnames, [
    expectedPathname("macos-universal"),
  ]);
});

test("absent, size-drifted, and invalid artifacts fail closed without signing", async () => {
  for (const headArtifact of [
    async () => null,
    async () => ({ size: fixtureSources["windows-x64"].sizeBytes - 1 }),
  ]) {
    const state = downloadState({ headArtifact });
    const result = await invoke(state.handler, {
      path: "/api/paid-download?platform=windows-x64",
    });
    await result.handlerDone;
    const body = await result.response.text();

    assert.equal(result.response.status, 404);
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.deepEqual(JSON.parse(body), { error: "artifact_not_found" });
    assert.equal(
      body.includes(fixtureSources["windows-x64"].artifactPathname),
      false,
    );
    assert.doesNotMatch(body, /pathname|sidestream\/paid-onboarding/i);
    assert.deepEqual(state.signedPathnames, []);
  }

  const invalidUrlState = downloadState({
    createSignedUrl: async () => "http://blob.example/not-secure",
  });
  const invalidUrlResult = await invoke(invalidUrlState.handler, {
    path: "/api/paid-download?platform=windows-x64",
  });
  await invalidUrlResult.handlerDone;
  assert.equal(invalidUrlResult.response.status, 404);
});

test("invalid manifest source fails both routes before artifact access", async () => {
  const malformed = readCanonicalFixture("windows-x64");
  malformed.artifact.pathname = "../private/blob/path.exe";
  const manifestPath = path.join(compiledDirectory, "invalid-windows.json");
  writeFileSync(manifestPath, `${JSON.stringify(malformed)}\n`, "utf8");
  process.env.SIDESTREAM_WINDOWS_RELEASE_MANIFEST_PATH = manifestPath;

  try {
    const state = downloadState();
    const downloadResult = await invoke(state.handler, {
      path: "/api/paid-download?platform=windows-x64",
    });
    await downloadResult.handlerDone;
    const downloadBody = await downloadResult.response.text();

    assert.equal(downloadResult.response.status, 404);
    assert.deepEqual(state.headPathnames, []);
    assert.deepEqual(state.signedPathnames, []);
    assert.equal(downloadBody.includes(malformed.artifact.pathname), false);

    const releaseResult = await invoke(releaseHandler(), {
      path: "/api/releases/paid-latest?platform=windows-x64",
    });
    await releaseResult.handlerDone;
    const releaseBody = await releaseResult.response.text();

    assert.equal(releaseResult.response.status, 404);
    assert.equal(releaseBody.includes(malformed.artifact.pathname), false);
  } finally {
    restoreEnvironment(
      "SIDESTREAM_WINDOWS_RELEASE_MANIFEST_PATH",
      originalManifestPaths["windows-x64"],
    );
  }
});

function downloadState(overrides = {}) {
  const state = {
    headPathnames: [],
    signedPathnames: [],
  };
  state.handler = createPaidDownloadHandler({
    headArtifact: overrides.headArtifact || (async (pathname) => {
      state.headPathnames.push(pathname);
      const platform = pathname.endsWith(".exe")
        ? "windows-x64"
        : "macos-universal";
      return {
        contentType: platform === "windows-x64"
          ? "application/vnd.microsoft.portable-executable"
          : "application/x-apple-diskimage",
        etag: `${platform}-fixture-etag`,
        size: fixtureSources[platform].sizeBytes,
      };
    }),
    createSignedUrl: overrides.createSignedUrl || (async (pathname) => {
      state.signedPathnames.push(pathname);
      return "https://blob.example/short-lived-paid-artifact";
    }),
    logArtifactError: () => {},
  });
  return state;
}

function releaseHandler() {
  return createPaidReleaseHandler({ logManifestError: () => {} });
}

function expectedPathname(platform) {
  return fixtureSources[platform].artifactPathname;
}

function readFixture(platform) {
  const canonical = readCanonicalFixture(platform);
  return {
    schemaVersion: 1,
    platform,
    version: canonical.version,
    filename: path.basename(canonical.artifact.pathname),
    sizeBytes: canonical.artifact.sizeBytes,
    sha256: canonical.artifact.sha256,
    artifactPathname: canonical.artifact.pathname,
  };
}

function readCanonicalFixture(platform) {
  const filename = platform === "windows-x64"
    ? "release-manifest.windows.json"
    : "release-manifest.json";
  return JSON.parse(readFileSync(path.join(repoRoot, "data", filename), "utf8"));
}

function copyTypeScriptModule(sourceRelativePath, targetRelativePath) {
  const targetPath = path.join(compiledDirectory, targetRelativePath);
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const source = readFileSync(
    path.join(repoRoot, sourceRelativePath),
    "utf8",
  ).replace(
    /paid-release-manifest\.js/g,
    "paid-release-manifest.ts",
  ).replace(
    /(["'])\.\/release-manifest\.js\1/g,
    "$1./release-manifest.ts$1",
  );
  writeFileSync(targetPath, source, "utf8");
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
        redirect: "manual",
      },
    );
    return { response, handlerDone };
  } finally {
    server.close();
  }
}

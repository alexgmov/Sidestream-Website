import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ANONYMOUS_INSTALL_CLAIM_TTL_SECONDS,
  AnonymousInstallationClaimError,
  buildAnonymousInstallationClaimUrl,
  createAnonymousInstallationClaimNonce,
  normalizeAnonymousInstallationClaimIdentity,
  verifyAnonymousInstallationClaimNonce,
} from "../../api/_lib/anonymous-install-claim.ts";
import { loadInjectedHandler } from "../helpers/handler-loader.mjs";

const SECRET = "anonymous-install-claim-test-secret-at-least-32-bytes";
const NOW = Date.UTC(2026, 6, 31, 19, 0, 0);
const INSTALL = "a".repeat(64);
const RECEIPT = "b".repeat(64);
const ENVIRONMENT = Object.freeze({ namespace: "test" });

test("claim identity accepts only body-only install and locally verified receipt hashes", () => {
  assert.deepEqual(normalizeAnonymousInstallationClaimIdentity({
    installIdHash: INSTALL,
    installerReceiptIdHash: RECEIPT,
  }), {
    installIdHash: INSTALL,
    installerReceiptIdHash: RECEIPT,
  });
  for (const value of [
    {},
    { installIdHash: INSTALL },
    { installIdHash: INSTALL, installerReceiptIdHash: RECEIPT, deviceId: "forbidden" },
    { installIdHash: INSTALL.toUpperCase(), installerReceiptIdHash: RECEIPT },
    { installIdHash: INSTALL, installerReceiptIdHash: "receipt" },
  ]) {
    assert.throws(
      () => normalizeAnonymousInstallationClaimIdentity(value),
      AnonymousInstallationClaimError,
    );
  }
});

test("opaque nonce is canonical, namespaced, private, and expires after exactly 15 minutes", () => {
  const nonce = createAnonymousInstallationClaimNonce({
    namespace: "test",
    installIdHash: INSTALL,
    installerReceiptIdHash: RECEIPT,
  }, {
    secret: SECRET,
    now: NOW,
    randomBytes: deterministicBytes,
  });
  assert.equal(nonce.expiresAt - nonce.issuedAt, ANONYMOUS_INSTALL_CLAIM_TTL_SECONDS);
  assert.doesNotMatch(nonce.nonce, new RegExp(INSTALL));
  assert.doesNotMatch(nonce.nonce, new RegExp(RECEIPT));
  assert.deepEqual(
    verifyAnonymousInstallationClaimNonce(nonce.nonce, {
      secret: SECRET,
      namespace: "test",
      now: NOW,
    }),
    {
      claimToken: nonce.claimToken,
      namespace: "test",
      installIdHash: INSTALL,
      installerReceiptIdHash: RECEIPT,
      issuedAt: Math.floor(NOW / 1000),
      expiresAt: Math.floor(NOW / 1000) + ANONYMOUS_INSTALL_CLAIM_TTL_SECONDS,
    },
  );
  assert.throws(
    () => verifyAnonymousInstallationClaimNonce(nonce.nonce, {
      secret: SECRET,
      namespace: "production",
      now: NOW,
    }),
    (error) => error?.code === "invalid_claim",
  );
  assert.throws(
    () => verifyAnonymousInstallationClaimNonce(nonce.nonce, {
      secret: SECRET,
      namespace: "test",
      now: NOW + ANONYMOUS_INSTALL_CLAIM_TTL_SECONDS * 1000,
    }),
    (error) => error?.code === "claim_expired",
  );
  const forged = `${nonce.nonce.slice(0, -1)}${nonce.nonce.endsWith("A") ? "B" : "A"}`;
  assert.throws(
    () => verifyAnonymousInstallationClaimNonce(forged, {
      secret: SECRET,
      namespace: "test",
      now: NOW,
    }),
    AnonymousInstallationClaimError,
  );
});

test("browser URL contains only the opaque nonce", () => {
  const created = createAnonymousInstallationClaimNonce({
    namespace: "test",
    installIdHash: INSTALL,
    installerReceiptIdHash: RECEIPT,
  }, { secret: SECRET, now: NOW, randomBytes: deterministicBytes });
  const browserUrl = buildAnonymousInstallationClaimUrl(
    "https://sidestream.tv/",
    created.nonce,
  );
  const parsed = new URL(browserUrl);
  assert.equal(parsed.pathname, "/api/installation/claim-complete");
  assert.deepEqual([...parsed.searchParams.keys()], ["nonce"]);
  assert.equal(parsed.searchParams.get("nonce"), created.nonce);
  for (const forbidden of [INSTALL, RECEIPT, "installIdHash", "installerReceiptIdHash", "email", "device"] ) {
    assert.equal(browserUrl.includes(forbidden), false, forbidden);
  }
});

test("plugin POST returns only the private browser URL and expiry", async (t) => {
  const previousSecret = process.env.SIDESTREAM_ANONYMOUS_ACQUISITION_SECRET;
  process.env.SIDESTREAM_ANONYMOUS_ACQUISITION_SECRET = SECRET;
  t.after(() => restoreEnvironment(
    "SIDESTREAM_ANONYMOUS_ACQUISITION_SECRET",
    previousSecret,
  ));
  let receivedPayload;
  const handler = await loadInjectedHandler(
    new URL("../../api/installation/claim.ts", import.meta.url),
    {
      "../_lib/account.js": accountBindings({
        readJsonBody: async (request) => request.body,
      }),
      "../_lib/anonymous-install-claim.js": {
        ANONYMOUS_INSTALL_CLAIM_SECRET_NAME: "SIDESTREAM_ANONYMOUS_ACQUISITION_SECRET",
        AnonymousInstallationClaimError,
        buildAnonymousInstallationClaimUrl,
        createAnonymousInstallationClaim: async (payload) => {
          receivedPayload = payload;
          return { nonce: "opaque_nonce", expiresAt: "2026-07-31T19:15:00.000Z" };
        },
      },
    },
  );
  const response = responseRecorder();
  await handler({
    method: "POST",
    url: "/api/installation/claim",
    headers: {},
    body: { installIdHash: INSTALL, installerReceiptIdHash: RECEIPT },
  }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(receivedPayload, {
    installIdHash: INSTALL,
    installerReceiptIdHash: RECEIPT,
  });
  const body = JSON.parse(response.body);
  assert.deepEqual(Object.keys(body).sort(), ["browserUrl", "expiresAt"]);
  assert.equal(new URL(body.browserUrl).searchParams.get("nonce"), "opaque_nonce");
  assert.equal(body.browserUrl.includes(INSTALL), false);
  assert.equal(body.browserUrl.includes(RECEIPT), false);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("browser GET treats missing cookie as safe unknown and always uses hardened minimal HTML", async (t) => {
  const previousSecret = process.env.SIDESTREAM_ANONYMOUS_ACQUISITION_SECRET;
  process.env.SIDESTREAM_ANONYMOUS_ACQUISITION_SECRET = SECRET;
  t.after(() => restoreEnvironment(
    "SIDESTREAM_ANONYMOUS_ACQUISITION_SECRET",
    previousSecret,
  ));
  let completions = 0;
  const handler = await loadInjectedHandler(
    new URL("../../api/installation/claim-complete.ts", import.meta.url),
    {
      "../_lib/account.js": accountBindings(),
      "../_lib/acquisition-cookie.js": {
        readBrowserAcquisitionCookie: () => "",
        verifyBrowserAcquisitionCookie: () => {
          throw new Error("missing");
        },
      },
      "../_lib/anonymous-install-claim.js": {
        ANONYMOUS_INSTALL_CLAIM_SECRET_NAME: "SIDESTREAM_ANONYMOUS_ACQUISITION_SECRET",
        AnonymousInstallationClaimError,
        completeAnonymousInstallationClaim: async () => {
          completions += 1;
          return { outcome: "connected" };
        },
      },
    },
  );
  const response = responseRecorder();
  await handler({
    method: "GET",
    url: "/api/installation/claim-complete?nonce=opaque_nonce",
    headers: {},
  }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(completions, 0);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(
    response.headers.get("content-security-policy"),
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  assert.match(response.body, /Sidestream connected\./);
  assert.match(response.body, /Return to Premiere Pro\./);
  for (const forbidden of [INSTALL, RECEIPT, "nonce=", "profile", "email"]) {
    assert.equal(response.body.includes(forbidden), false, forbidden);
  }
});

test("owned activation and license routes retain body-only continuity fields", async () => {
  const routes = [
    "../../api/activation/start.ts",
    "../../api/activation/status.ts",
    "../../api/license/verify.ts",
    "../../api/license/refresh.ts",
  ];
  for (const route of routes) {
    const source = await readFile(new URL(route, import.meta.url), "utf8");
    assert.match(source, /installIdHash/);
    assert.match(source, /installerReceiptIdHash/);
    assert.doesNotMatch(source, /searchParams\.get\(["']installIdHash/);
    assert.doesNotMatch(source, /searchParams\.get\(["']installerReceiptIdHash/);
  }
});

function deterministicBytes(size) {
  return Uint8Array.from({ length: size }, (_, index) => (index + size + 1) % 256);
}

function accountBindings(overrides = {}) {
  return {
    getBaseUrl: () => "https://sidestream.tv",
    methodNotAllowed: (response, allow) => {
      response.statusCode = 405;
      response.setHeader("Allow", allow);
      response.end("");
    },
    readJsonBody: async () => ({}),
    resolveRequestLicenseEnvironment: () => ENVIRONMENT,
    sendJson: (response, statusCode, body) => {
      response.statusCode = statusCode;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(body));
    },
    ...overrides,
  };
}

function responseRecorder() {
  const headers = new Map();
  return {
    statusCode: 0,
    headers,
    body: "",
    setHeader(name, value) {
      headers.set(name.toLowerCase(), String(value));
    },
    end(value = "") {
      this.body += String(value);
    },
  };
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

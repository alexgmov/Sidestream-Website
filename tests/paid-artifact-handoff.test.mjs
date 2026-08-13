import assert from "node:assert/strict";
import test from "node:test";

import { loadInjectedHandler } from "./helpers/handler-loader.mjs";
import { invokeHandler } from "./helpers/http.mjs";

const RECEIPT = "r".repeat(43);
const RECEIPT_SECRET = "paid-handoff-test-secret-at-least-32-bytes";
const RECEIPT_COOKIE = "__Host-sidestream-paid-acquisition-receipt";

test("verified paid receipt cookie mints one Unlimited computer handoff", async () => {
  await withReceiptSecret(async () => {
    const handler = await loadArtifactHandler();
    const result = await invokeHandler(handler, {
      method: "POST",
      url: "/api/paid-acquisition/artifact",
      headers: {
        "content-type": "application/json",
        cookie: `${RECEIPT_COOKIE}=signed-paid-receipt`,
      },
      body: { handoffOnly: true },
    });

    assert.equal(result.response.statusCode, 200);
    assert.equal(result.response.getHeader("cache-control"), "no-store");
    assert.equal(result.response.json.ok, true);
    const handoff = new URL(result.response.json.handoffUrl);
    assert.equal(handoff.origin, "https://sidestream.test");
    assert.equal(handoff.pathname, "/api/paid-acquisition/artifact");
    assert.deepEqual([...handoff.searchParams.keys()], ["handoff"]);
    assert.equal(handoff.searchParams.get("handoff"), RECEIPT);
    assert.equal(result.response.json.handoffUrl.includes("email"), false);
  });
});

test("paid handoff POST rejects extra fields and missing receipt proof", async () => {
  await withReceiptSecret(async () => {
    const handler = await loadArtifactHandler();
    const extraField = await invokeHandler(handler, {
      method: "POST",
      url: "/api/paid-acquisition/artifact",
      headers: {
        "content-type": "application/json",
        cookie: `${RECEIPT_COOKIE}=signed-paid-receipt`,
      },
      body: { handoffOnly: true, email: "private@example.com" },
    });
    assert.equal(extraField.response.statusCode, 400);
    assert.equal(extraField.response.json.code, "invalid_request");

    const missingCookie = await invokeHandler(handler, {
      method: "POST",
      url: "/api/paid-acquisition/artifact",
      headers: { "content-type": "application/json" },
      body: { handoffOnly: true },
    });
    assert.equal(missingCookie.response.statusCode, 403);
    assert.equal(missingCookie.response.json.code, "payment_inactive");
  });
});

test("computer handoff selects Windows or Mac before receipt-gated delivery", async () => {
  const handler = await loadArtifactHandler();
  const windows = await invokeHandler(handler, {
    method: "GET",
    url: `/api/paid-acquisition/artifact?handoff=${RECEIPT}`,
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    },
  });
  assert.equal(windows.response.statusCode, 302);
  assert.equal(
    windows.response.getHeader("location"),
    `/api/paid-acquisition/artifact?receipt=${RECEIPT}&platform=windows-x64`,
  );

  const mac = await invokeHandler(handler, {
    method: "GET",
    url: `/api/paid-acquisition/artifact?handoff=${RECEIPT}`,
    headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X)" },
  });
  assert.equal(mac.response.statusCode, 302);
  assert.equal(
    mac.response.getHeader("location"),
    `/api/paid-acquisition/artifact?receipt=${RECEIPT}&platform=macos-universal`,
  );

  const malformed = await invokeHandler(handler, {
    method: "GET",
    url: "/api/paid-acquisition/artifact?handoff=not-a-receipt",
  });
  assert.equal(malformed.response.statusCode, 404);
});

async function loadArtifactHandler() {
  class PaidAcquisitionError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }
  return loadInjectedHandler(
    new URL("../api/paid-acquisition/artifact.ts", import.meta.url),
    {
      "@vercel/functions": { waitUntil() {} },
      "../_lib/account.js": {
        async fulfillCheckoutSession() {
          return { fulfilled: true };
        },
        getBaseUrl() {
          return "https://sidestream.test";
        },
        getClientIp() {
          return "127.0.0.1";
        },
        methodNotAllowed(response, allowed) {
          response.statusCode = 405;
          response.setHeader("Allow", allowed);
          response.end();
        },
        resolveRequestLicenseEnvironment() {
          return { namespace: "test" };
        },
      },
      "../_lib/paid-acquisition.js": {
        PAID_ACQUISITION_RECEIPT_COOKIE: RECEIPT_COOKIE,
        PaidAcquisitionError,
        async getPaidAcquisitionReceiptState() {
          return {
            id: "checkout-id",
            acquisition_id: "acquisition-id",
            verified_checkout_session_ref: "cs_verified",
            receipt_expires_at: "2027-01-01T00:00:00.000Z",
            payment_state: "active",
            entitlement_status: "active",
          };
        },
        async recordPaidAcquisitionInstallerRequest() {},
        serializePaidAcquisitionReceiptCookie() {
          return `${RECEIPT_COOKIE}=signed-paid-receipt; Path=/; HttpOnly`;
        },
        validatePaidAcquisitionReceiptCookie({ cookieValue }) {
          if (cookieValue !== "signed-paid-receipt") {
            throw new PaidAcquisitionError("invalid_request");
          }
          return RECEIPT;
        },
      },
      "../_lib/paid-release-manifest.js": {
        getPaidArtifactPathname() {
          return "sidestream/test/Sidestream.dmg";
        },
        readPaidReleaseManifest() {
          return { sizeBytes: 1 };
        },
        resolvePaidReleasePlatform(value) {
          return value === "macos-universal" || value === "windows-x64"
            ? value
            : null;
        },
      },
      "../_lib/rate-limit.js": {
        applyRateLimitHeaders() {},
        async consumeRateLimit() {
          return { allowed: true, retryAfterSeconds: 0 };
        },
      },
      "../_lib/paid-download.js": {
        async createSignedPaidDownloadUrl() {
          return "https://blob.example/Sidestream.dmg";
        },
      },
    },
  );
}

async function withReceiptSecret(operation) {
  const previous = process.env.SIDESTREAM_PAID_ACQUISITION_RECEIPT_SECRET;
  process.env.SIDESTREAM_PAID_ACQUISITION_RECEIPT_SECRET = RECEIPT_SECRET;
  try {
    await operation();
  } finally {
    if (previous === undefined) {
      delete process.env.SIDESTREAM_PAID_ACQUISITION_RECEIPT_SECRET;
    } else {
      process.env.SIDESTREAM_PAID_ACQUISITION_RECEIPT_SECRET = previous;
    }
  }
}

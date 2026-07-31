import assert from "node:assert/strict";
import test from "node:test";

import {
  createBrowserAcquisitionCookie,
} from "../../api/_lib/acquisition-cookie.ts";
import {
  buildAcquisitionHandoffUrl,
  createAcquisitionHandoff,
} from "../../api/_lib/acquisition-handoff.ts";
import {
  ANONYMOUS_INSTALL_CLAIM_TTL_SECONDS,
  buildAnonymousInstallationClaimUrl,
  createAnonymousInstallationClaimNonce,
  normalizeAnonymousInstallationClaimIdentity,
} from "../../api/_lib/anonymous-install-claim.ts";
import {
  authorizeCustomerAdminRequest,
  loadCustomerAdminSecret,
} from "../../api/_lib/customer-admin.ts";
import {
  readReleaseManifest,
  resolveReleasePlatform,
  toPublicReleaseManifest,
} from "../../api/_lib/release-manifest.ts";
import { createRequest, createResponse } from "../helpers/http.mjs";

const SECRET = "anonymous-acquisition-privacy-contract-secret-2026";
const NOW = Date.UTC(2026, 6, 31, 18, 0, 0);
const INSTALL = "1".repeat(64);
const RECEIPT = "2".repeat(64);

test("browser handoff and installation claim URLs expose only opaque envelopes", () => {
  const cookie = createBrowserAcquisitionCookie({
    attribution: {
      source: "reddit",
      medium: "social",
      campaign: "privacy-contract",
      content: "hero",
    },
  }, {
    secret: SECRET,
    now: NOW,
    randomBytes: deterministicBytes,
  });
  const handoffUrl = new URL(buildAcquisitionHandoffUrl(createAcquisitionHandoff({
    acquisitionCookieValue: cookie.value,
    platform: "macos",
  }, {
    secret: SECRET,
    now: NOW,
    randomBytes: deterministicBytes,
  })));
  assert.deepEqual([...handoffUrl.searchParams.keys()], ["handoff"]);

  const claim = createAnonymousInstallationClaimNonce({
    namespace: "test",
    installIdHash: INSTALL,
    installerReceiptIdHash: RECEIPT,
  }, {
    secret: SECRET,
    now: NOW,
    randomBytes: deterministicBytes,
  });
  assert.equal(claim.expiresAt - claim.issuedAt, ANONYMOUS_INSTALL_CLAIM_TTL_SECONDS);
  const claimUrl = new URL(buildAnonymousInstallationClaimUrl(
    "https://sidestream.tv/",
    claim.nonce,
  ));
  assert.deepEqual([...claimUrl.searchParams.keys()], ["nonce"]);

  const serializedUrls = `${handoffUrl.href}\n${claimUrl.href}`.toLowerCase();
  for (const forbidden of [
    "reddit", "social", "privacy-contract", "utm_", "source=", "email",
    "installidhash", "installerreceiptidhash", INSTALL, RECEIPT,
  ]) {
    assert.equal(serializedUrls.includes(forbidden.toLowerCase()), false, forbidden);
  }
});

test("plugin claim JSON cannot supply attribution, account, payment, entitlement, or device truth", () => {
  const canonical = {
    installIdHash: INSTALL,
    installerReceiptIdHash: RECEIPT,
  };
  assert.deepEqual(normalizeAnonymousInstallationClaimIdentity(canonical), canonical);

  for (const forbidden of [
    ["source", "reddit"],
    ["utmSource", "reddit"],
    ["attribution", { source: "reddit" }],
    ["email", "person@example.com"],
    ["accountId", "00000000-0000-4000-8000-000000000001"],
    ["paymentStatus", "paid"],
    ["entitlementStatus", "active"],
    ["deviceIdHash", "3".repeat(64)],
  ]) {
    assert.throws(
      () => normalizeAnonymousInstallationClaimIdentity({
        ...canonical,
        [forbidden[0]]: forbidden[1],
      }),
      (error) => error?.code === "invalid_request",
      forbidden[0],
    );
  }
});

test("all acquisition sources resolve to the same platform package bytes", () => {
  for (const [platform, platformQuery] of [
    ["macos", ""],
    ["windows", "platform=win32-x64"],
  ]) {
    const expected = packageIdentity(readReleaseManifest(platform));
    for (const source of ["direct", "instagram", "facebook", "linkedin", "reddit"]) {
      const query = [platformQuery, source === "direct" ? "" : `utm_source=${source}`]
        .filter(Boolean)
        .join("&");
      const requestUrl = new URL(`https://sidestream.tv/api/download${query ? `?${query}` : ""}`);
      const selectedPlatform = resolveReleasePlatform(
        requestUrl.searchParams.get("platform"),
      );
      assert.equal(selectedPlatform, platform);
      assert.deepEqual(packageIdentity(readReleaseManifest(selectedPlatform)), expected);
    }

    const publicManifest = toPublicReleaseManifest(readReleaseManifest(platform));
    assert.deepEqual(Object.keys(publicManifest.artifact).sort(), [
      "filename", "sha256", "sizeBytes", "type", "url",
    ]);
    assert.doesNotMatch(
      JSON.stringify(publicManifest),
      /(?:utm_|source|email|install_id|receipt|pathname)/i,
    );
  }
});

test("Customer 360 remains unavailable before its admin secret is configured", () => {
  assert.throws(
    () => loadCustomerAdminSecret({}),
    /SIDESTREAM_CRM_ADMIN_SECRET is not configured/,
  );
  const request = createRequest({
    method: "POST",
    url: "/api/internal/customers",
    headers: { authorization: "Bearer attacker-selected" },
    body: { licenseNamespace: "test" },
  });
  const response = createResponse();
  const authorized = authorizeCustomerAdminRequest(
    request,
    response,
    () => loadCustomerAdminSecret({}),
  );
  assert.equal(authorized, null);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json, {
    error: "Customer administration is not configured",
    code: "customer_admin_unavailable",
  });
  assert.equal(response.getHeader("cache-control"), "no-store, max-age=0");
});

function packageIdentity(manifest) {
  return {
    pathname: manifest.artifact.pathname,
    sha256: manifest.artifact.sha256,
    sizeBytes: manifest.artifact.sizeBytes,
  };
}

function deterministicBytes(size) {
  return Uint8Array.from({ length: size }, (_, index) => (index + size + 1) % 256);
}

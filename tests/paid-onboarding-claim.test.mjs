import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createClaimCsrfToken,
  sanitizeAccountNextPath,
  validateActivationClaimPost,
  validateClaimCsrfToken,
} from "../api/_lib/entitlement.ts";
import { decideDeviceActivation } from "../api/_lib/device-policy.ts";
import {
  renderMissingPaidEntitlementPage,
} from "../api/_lib/paid-onboarding-claim-page.ts";

const SOURCE = "paid-acquisition-mc-v1";
const SECRET = "paid-onboarding-claim-test-secret-32-bytes";
const accountSource = await readFile(
  new URL("../api/_lib/account.ts", import.meta.url),
  "utf8",
);
const claimSource = await readFile(
  new URL("../api/activation/claim.ts", import.meta.url),
  "utf8",
);
const dedicatedRouteSource = await readFile(
  new URL("../api/activation/paid-claim.ts", import.meta.url),
  "utf8",
);
const paidAcquisitionSource = await readFile(
  new URL("../api/_lib/paid-acquisition.ts", import.meta.url),
  "utf8",
);

test("activation start selects the dedicated URL only for the exact raw source", () => {
  assert.match(
    accountSource,
    /typeof payload\.source === "string" &&\s*payload\.source === PAID_ACQUISITION_SOURCE/,
  );
  assert.match(
    accountSource,
    /paidOnboardingSource\s*\?\s*"\/api\/activation\/paid-claim"\s*:\s*"\/api\/activation\/claim"/,
  );
  assert.match(
    accountSource,
    /requestedSource === PAID_ACQUISITION_SOURCE\s*\?\s*"plugin"/,
  );
  assert.doesNotMatch(
    accountSource,
    /cleanString\(payload\.source,\s*120\) === PAID_ACQUISITION_SOURCE/,
  );
});

test("the dedicated route constrains server-side source and changes only inactive UX", () => {
  assert.match(
    dedicatedRouteSource,
    /claimPath:\s*"\/api\/activation\/paid-claim"/,
  );
  assert.match(
    dedicatedRouteSource,
    /requiredActivationSource:\s*PAID_ACQUISITION_SOURCE/,
  );
  assert.match(
    dedicatedRouteSource,
    /inactiveEntitlementMode:\s*"support_only"/,
  );
  assert.match(
    dedicatedRouteSource,
    /googlePrompt:\s*"select_account"/,
  );
  assert.match(
    claimSource,
    /and \(\$4::text is null or a\.source = \$4\)/,
  );
  assert.match(
    claimSource,
    /const claimPath = options\.claimPath \|\| "\/api\/activation\/claim"/,
  );
  assert.match(
    claimSource,
    /const inactiveEntitlementMode = options\.inactiveEntitlementMode \|\| "checkout"/,
  );
  assert.match(
    claimSource,
    /signIn\.searchParams\.set\("prompt", options\.googlePrompt\)/,
  );
});

test("paid install attribution uses the signed browser receipt after authenticated confirmation", () => {
  assert.match(
    dedicatedRouteSource,
    /validatePaidAcquisitionReceiptCookie/,
  );
  assert.match(
    dedicatedRouteSource,
    /paidAcquisitionReceipt/,
  );
  assert.match(
    claimSource,
    /await finalizePaidAcquisitionLinkage\([\s\S]*?receipt: options\.paidAcquisitionReceipt/,
  );
  assert.match(
    paidAcquisitionSource,
    /paid\.installer_receipt_hash = \$2/,
  );
  assert.match(
    paidAcquisitionSource,
    /activation\.activation_key = \$3/,
  );
  assert.match(
    paidAcquisitionSource,
    /activation\.source = \$4 as activation_source_matches/,
  );
  assert.match(
    paidAcquisitionSource,
    /stage: "installation_claimed"[\s\S]*?evidence: "verified_installation_claim"/,
  );
  assert.doesNotMatch(
    accountSource,
    /installerReceiptIdHash:[\s\S]{0,200}associatePaidAcquisitionActivation/,
  );
});

test("paid POST linkage records only bounded outcomes and ordinary claims stay quiet", () => {
  assert.match(
    claimSource,
    /options\.requiredActivationSource === PAID_ACQUISITION_SOURCE/,
  );
  assert.match(
    claimSource,
    /if \(!options\.expectedPaidAcquisition\) return;[\s\S]*?if \(!options\.receipt\) \{[\s\S]*?"missing_browser_paid_receipt"/,
  );
  assert.match(
    claimSource,
    /console\.info\("\[sidestream paid activation\] attribution linkage", \{ outcome \}\)/,
  );
  assert.doesNotMatch(
    claimSource,
    /console\.(?:info|warn|error)\([^\n]*(?:activationKey|receipt|email|token|stripe|customer)/i,
  );
  for (const outcome of [
    "receipt_activation_no_match",
    "activation_source_mismatch",
    "claim_binding_conflict",
    "installation_identity_not_unique_or_missing",
    "acquisition_ownership_conflict",
    "installation_claimed_recorded",
  ]) {
    assert.match(paidAcquisitionSource, new RegExp(`"${outcome}"`));
  }
});

test("signed-out OAuth accepts only the exact dedicated same-origin return shape", () => {
  assert.equal(
    sanitizeAccountNextPath(
      "/api/activation/paid-claim?activation=opaque-activation",
    ),
    "/api/activation/paid-claim?activation=opaque-activation",
  );
  for (const unsafe of [
    "/api/activation/paid-claim",
    "/api/activation/paid-claim?activation=a&source=paid-acquisition-mc-v1",
    "https://attacker.example/api/activation/paid-claim?activation=a",
    "//attacker.example/api/activation/paid-claim?activation=a",
  ]) {
    assert.equal(sanitizeAccountNextPath(unsafe), "/account.html");
  }
});

test("the no-entitlement page is noindex, support-only, escaped, and has exact copy", () => {
  const html = renderMissingPaidEntitlementPage(
    "buyer+test@example.com<script>",
  );
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(html, /<title>We’re not seeing your purchase\.<\/title>/);
  assert.match(html, /<h1>We’re not seeing your purchase\.<\/h1>/);
  assert.match(
    html,
    /If you already upgraded, contact Sidestream support\./,
  );
  assert.match(
    html,
    /Signed in as buyer\+test@example\.com&lt;script&gt;/,
  );
  assert.match(html, /href="mailto:alex@alexg\.mov"/);
  assert.equal((html.match(/href=/g) || []).length, 1);
  assert.doesNotMatch(html, /<form|<button|\/api\/checkout|data-purchase/i);
  assert.doesNotMatch(html, />\s*(?:Upgrade|Buy|Checkout)\s*</i);
});

test("GET remains read-only and POST stays on the existing CSRF-bound claim engine", () => {
  const postParsing = claimSource.indexOf(
    "const form = new URLSearchParams(await readRequestBody(request));",
  );
  const firstClaimMutation = claimSource.indexOf(
    "const claimed = await claimActivationToAccount",
  );
  assert.ok(postParsing > 0);
  assert.ok(firstClaimMutation > postParsing);
  assert.match(
    claimSource,
    /validateActivationPost\(request, activationKey, session\.accountId, csrfToken\)/,
  );
  assert.match(
    claimSource,
    /action="\$\{escapeHtml\(options\.claimPath\)\}"/,
  );
  assert.match(
    claimSource,
    /new URL\("\/thank-you\.html", baseUrl\)/,
  );
});

test("same-origin and CSRF checks bind the one-time POST to activation and account", () => {
  assert.equal(
    validateActivationClaimPost({
      requestOrigin: "https://sidestream.tv",
      expectedOrigin: "https://sidestream.tv",
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    }),
    true,
  );
  assert.equal(
    validateActivationClaimPost({
      requestOrigin: "https://attacker.example",
      expectedOrigin: "https://sidestream.tv",
      contentType: "application/x-www-form-urlencoded",
    }),
    false,
  );

  const nowSeconds = 1_785_139_200;
  const token = createClaimCsrfToken({
    activationKey: "activation-one",
    accountId: "account-one",
    expiresAtSeconds: nowSeconds + 60,
    secret: SECRET,
  });
  assert.equal(
    validateClaimCsrfToken({
      token,
      activationKey: "activation-one",
      accountId: "account-one",
      nowSeconds,
      secret: SECRET,
    }),
    true,
  );
  for (const changed of [
    { activationKey: "activation-two", accountId: "account-one", nowSeconds },
    { activationKey: "activation-one", accountId: "account-two", nowSeconds },
    {
      activationKey: "activation-one",
      accountId: "account-one",
      nowSeconds: nowSeconds + 61,
    },
  ]) {
    assert.equal(
      validateClaimCsrfToken({ token, secret: SECRET, ...changed }),
      false,
    );
  }
});

test("the shared device policy preserves connect, reconnect, and explicit transfer", () => {
  assert.equal(
    decideDeviceActivation({
      namespace: "production",
      requestedDeviceIdHash: "device-new",
      activeDevice: null,
    }).decision,
    "activate",
  );
  assert.equal(
    decideDeviceActivation({
      namespace: "production",
      requestedDeviceIdHash: "device-same",
      activeDevice: {
        namespace: "production",
        deviceIdHash: "device-same",
        revokedAt: null,
      },
    }).decision,
    "same_device",
  );
  assert.equal(
    decideDeviceActivation({
      namespace: "production",
      requestedDeviceIdHash: "device-new",
      activeDevice: {
        namespace: "production",
        deviceIdHash: "device-old",
        revokedAt: null,
      },
      activeDeviceCount: 1,
    }).decision,
    "activate",
  );
  assert.equal(
    decideDeviceActivation({
      namespace: "production",
      requestedDeviceIdHash: "device-new",
      activeDevice: {
        namespace: "production",
        deviceIdHash: "device-old",
        revokedAt: null,
      },
      activeDeviceCount: 2,
    }).decision,
    "transfer_required",
  );
  assert.match(
    claimSource,
    /name="transfer_confirmation" value="deactivate_previous_device" required/,
  );
  assert.match(
    claimSource,
    /confirmAccountDeviceTransfer\(\{/,
  );
});

test("source remains UX selection and cannot bypass entitlement or device policy", () => {
  assert.match(
    claimSource,
    /if \(!session\.license\.active\) \{\s*if \(inactiveEntitlementMode === "support_only"\)/,
  );
  assert.match(claimSource, /const decision = getDeviceDecision\(/);
  assert.doesNotMatch(
    dedicatedRouteSource,
    /claimActivationToAccount|confirmAccountDeviceTransfer|entitlement_status|license\.active\s*=/,
  );
  assert.equal(SOURCE, "paid-acquisition-mc-v1");
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  isZeroTotalCheckoutWithoutPaymentIntent,
} from "../api/_lib/entitlement.ts";
import {
  DEFAULT_DEVICE_POLICY_MODE,
  MAX_ACTIVE_DEVICES,
  decideDeviceActivation,
  resolveDevicePolicyMode,
} from "../api/_lib/device-policy.ts";
import { verifyCheckoutContract } from "../scripts/verify-production-source.mjs";

test("Unlimited Upgrade remains Google authentication followed by shared Stripe Checkout", async () => {
  assert.deepEqual(await verifyCheckoutContract(), {
    checkoutRoute: "direct",
    zeroTotalStatuses: 2,
    rootHtmlPages: 5,
  });

  const checkoutStart = await source("api/checkout/start.ts");
  assert.match(checkoutStart, /getSession/);
  assert.match(checkoutStart, /\/api\/auth\/google\/start/);
  assert.match(checkoutStart, /createCheckoutIntent/);
  assert.match(checkoutStart, /createOrReuseCheckoutSession/);
  assert.match(checkoutStart, /resolveRequiredCheckoutAcquisition/);
  assert.match(checkoutStart, /recordAuthenticatedAccountAcquisition/);
  assert.doesNotMatch(checkoutStart, /anonymous-acquisition|installation\/claim/);
});

test("OAuth, locked intents, Stripe metadata, and fulfillment share one acquisition UUID", async () => {
  const [accountSource, authStart, authCallback] = await Promise.all([
    source("api/_lib/account.ts"),
    source("api/auth/google/start.ts"),
    source("api/auth/google/callback.ts"),
  ]);
  assert.match(authStart, /acquisitionCookieValue/);
  assert.match(authCallback, /completeGoogleAuthenticationAcquisition/);
  assert.match(accountSource, /stage:\s*"authentication_completed"/);
  assert.match(
    accountSource,
    /google-account:\$\{acquisitionId\}:\$\{accountId\}/,
  );
  assert.match(accountSource, /id, acquisition_id, intent_kind/);
  assert.match(accountSource, /sidestream_acquisition_id:\s*row\.acquisition_id/);
  assert.match(accountSource, /invoice_data:\s*\{ metadata \}/);
  assert.match(accountSource, /payment_intent_data:\s*\{ metadata \}/);
  assert.match(accountSource, /reason:\s*"acquisition_mismatch"/);
  for (const stage of ["checkout_started", "checkout_completed", "payment_settled"] ) {
    assert.match(accountSource, new RegExp(`stage:\\s*"${stage}"`));
  }
});

test("paid Checkout stays on the shared server-owned Checkout worker", async () => {
  const paidCheckout = await source("api/paid-acquisition/checkout.ts");
  for (const marker of [
    "createCheckoutIntentConfirmation",
    "createOrReuseCheckoutSession",
    "getTrustedCheckoutCountry",
    "paidAcquisition: true",
  ]) {
    assert.match(paidCheckout, new RegExp(escapeRegExp(marker)), marker);
  }
  assert.match(
    paidCheckout,
    /keys\.join\(","\) === "entryToken,idempotencyKey,schemaVersion"/,
  );
  assert.doesNotMatch(paidCheckout, /installIdHash|installerReceiptIdHash/);
});

test("entitlement keeps both exact zero-total Stripe settlement statuses", () => {
  const exact = {
    status: "complete",
    amount_total: 0,
    currency: "usd",
    payment_intent: null,
  };
  assert.equal(isZeroTotalCheckoutWithoutPaymentIntent({
    ...exact,
    payment_status: "paid",
  }), true);
  assert.equal(isZeroTotalCheckoutWithoutPaymentIntent({
    ...exact,
    payment_status: "no_payment_required",
  }), true);
  assert.equal(isZeroTotalCheckoutWithoutPaymentIntent({
    ...exact,
    payment_status: "unpaid",
  }), false);
  assert.equal(isZeroTotalCheckoutWithoutPaymentIntent({
    ...exact,
    payment_status: "paid",
    amount_total: 1,
  }), false);
});

test("anonymous acquisition cannot mutate payment, entitlement, or device state", async () => {
  const anonymousSources = await Promise.all([
    source("api/_lib/anonymous-acquisition.ts"),
    source("api/_lib/anonymous-install-claim.ts"),
    source("api/installation/claim.ts"),
    source("api/installation/claim-complete.ts"),
  ]);
  const protectedMutation = /\b(?:insert\s+into|update|delete\s+from)\s+public\.sidestream_(?:checkout_intents|paid_acquisition_[a-z_]+|licenses|account_devices|license_tokens|device_transfers)\b/i;
  for (const anonymousSource of anonymousSources) {
    assert.doesNotMatch(anonymousSource, protectedMutation);
  }

  assert.equal(DEFAULT_DEVICE_POLICY_MODE, "observe");
  assert.equal(MAX_ACTIVE_DEVICES, 2);
  assert.equal(resolveDevicePolicyMode("browser-selected-value"), "observe");
  assert.deepEqual(decideDeviceActivation({
    namespace: "test",
    requestedDeviceIdHash: "new-device",
    activeDevice: {
      namespace: "test",
      deviceIdHash: "existing-device",
      revokedAt: null,
    },
    activeDeviceCount: 2,
  }), {
    decision: "transfer_required",
    errorCode: "transfer_required",
  });
});

async function source(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

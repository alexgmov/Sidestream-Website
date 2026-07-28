import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildCheckoutCompletionUrl,
  canBindActivationAccount,
  createClaimCsrfToken,
  deriveActivationTokenPair,
  deriveRefreshRotationTokens,
  getActivationCheckoutIdempotencyKey,
  getCheckoutParametersFingerprint,
  getCheckoutSessionIdempotencyKey,
  getStripeCheckoutWindow,
  hasSameOrigin,
  isLegacyVercelHost,
  isActivationClaimReplay,
  isActivationTokenReplayAllowed,
  isValidDiscountedCheckoutPayment,
  isZeroTotalCheckoutWithoutPaymentIntent,
  matchesDeviceHash,
  needsLegacyLicenseCompatibility,
  sanitizeAccountNextPath,
  validateActivationClaimPost,
  validateClaimCsrfToken,
  verifyPaidCheckoutSession,
} from "../api/_lib/entitlement.ts";

const validCheckout = {
  id: "cs_test_paid",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  metadata: {
    sidestream_plan: "sidestream_pro",
    sidestream_price_id: "price_pro",
    sidestream_activation_key: "activation-1",
  },
  line_items: {
    data: [{ quantity: 1, price: { id: "price_pro", product: { id: "prod_pro" } } }],
    has_more: false,
  },
};

const checkoutExpectation = {
  sessionId: "cs_test_paid",
  activationKey: "activation-1",
  priceId: "price_pro",
  productId: "prod_pro",
  paidPlanKeys: ["sidestream_pro", "sidestream_unlimited"],
};

test("Checkout completion URL keeps Stripe's placeholder unencoded", () => {
  const url = buildCheckoutCompletionUrl("https://sidestream.tv", "activation + one");
  assert.match(url, /session_id=\{CHECKOUT_SESSION_ID\}/);
  assert.doesNotMatch(url, /%7BCHECKOUT_SESSION_ID%7D/i);
  assert.match(url, /activation=activation\+%2B\+one/);
});

test("activation Checkout idempotency is stable without exposing the key", () => {
  const first = getActivationCheckoutIdempotencyKey("secret-activation");
  assert.equal(first, getActivationCheckoutIdempotencyKey("secret-activation"));
  assert.notEqual(first, getActivationCheckoutIdempotencyKey("another-activation"));
  assert.doesNotMatch(first, /secret-activation/);
});

test("Checkout idempotency rotates when any Stripe request parameter changes", () => {
  const parameters = {
    mode: "payment",
    line_items: [{ price: "price_current", quantity: 1 }],
    metadata: { plan: "sidestream_pro", activation: "activation-secret" },
  };
  const reordered = {
    metadata: { activation: "activation-secret", plan: "sidestream_pro" },
    line_items: [{ quantity: 1, price: "price_current" }],
    mode: "payment",
  };
  const fingerprint = getCheckoutParametersFingerprint(parameters);
  assert.equal(fingerprint, getCheckoutParametersFingerprint(reordered));

  const key = getCheckoutSessionIdempotencyKey({
    kind: "activation",
    intentId: "intent-current",
    activationKey: "activation-secret",
    attempt: 0,
    parametersFingerprint: fingerprint,
  });
  const repricedKey = getCheckoutSessionIdempotencyKey({
    kind: "activation",
    intentId: "intent-current",
    activationKey: "activation-secret",
    attempt: 0,
    parametersFingerprint: getCheckoutParametersFingerprint({
      ...parameters,
      line_items: [{ price: "price_replacement", quantity: 1 }],
    }),
  });
  assert.notEqual(key, repricedKey);
  assert.ok(key.length <= 255);
  assert.doesNotMatch(key, /activation-secret/);
});

test("Checkout expiry and paid-completion grace stay inside activation expiry at millisecond boundaries", () => {
  const activationExpiresAtMs = 86_400_999;
  const window = getStripeCheckoutWindow(activationExpiresAtMs, 600);
  assert.equal(new Date(window.claimGraceUntil).getTime() - window.checkoutExpiresAt * 1000, 600_000);
  assert.ok(new Date(window.claimGraceUntil).getTime() <= activationExpiresAtMs);
});

test("only the exact attached paid Session, Price, Product, and quantity verifies", () => {
  assert.deepEqual(verifyPaidCheckoutSession(validCheckout, checkoutExpectation), { ok: true });
  assert.deepEqual(
    verifyPaidCheckoutSession(
      { ...validCheckout, payment_status: "no_payment_required" },
      checkoutExpectation,
    ),
    { ok: true },
  );

  const rejected = [
    [{ ...validCheckout, id: "cs_attacker" }, "session_id_mismatch"],
    [{ ...validCheckout, mode: "subscription" }, "invalid_checkout_mode"],
    [{ ...validCheckout, status: "open" }, "checkout_incomplete"],
    [{ ...validCheckout, payment_status: "unpaid" }, "payment_incomplete"],
    [{ ...validCheckout, metadata: null }, "invalid_plan"],
    [{
      ...validCheckout,
      metadata: { ...validCheckout.metadata, sidestream_plan: "attacker_plan" },
    }, "invalid_plan"],
    [{
      ...validCheckout,
      metadata: { ...validCheckout.metadata, sidestream_price_id: "price_attacker" },
    }, "metadata_price_mismatch"],
    [{
      ...validCheckout,
      metadata: { ...validCheckout.metadata, sidestream_activation_key: "attacker" },
    }, "activation_mismatch"],
    [{ ...validCheckout, line_items: { data: [], has_more: false } }, "invalid_line_items"],
    [{ ...validCheckout, line_items: { ...validCheckout.line_items, has_more: true } }, "invalid_line_items"],
    [{
      ...validCheckout,
      line_items: { data: [{ quantity: 2, price: { id: "price_pro", product: "prod_pro" } }] },
    }, "invalid_quantity"],
    [{
      ...validCheckout,
      line_items: { data: [{ quantity: 1, price: { id: "price_attacker", product: "prod_pro" } }] },
    }, "line_item_price_mismatch"],
    [{
      ...validCheckout,
      line_items: { data: [{ quantity: 1, price: { id: "price_pro", product: "prod_attacker" } }] },
    }, "line_item_product_mismatch"],
  ];
  for (const [session, reason] of rejected) {
    assert.equal(verifyPaidCheckoutSession(session, checkoutExpectation).reason, reason);
  }
});

test("zero-total Checkout accepts Stripe's current and legacy settled statuses", () => {
  const zeroTotalCheckout = {
    payment_intent: null,
    payment_status: "paid",
    amount_total: 0,
    currency: "USD",
  };
  assert.equal(isZeroTotalCheckoutWithoutPaymentIntent(zeroTotalCheckout), true);
  assert.equal(
    isZeroTotalCheckoutWithoutPaymentIntent({
      ...zeroTotalCheckout,
      payment_status: "no_payment_required",
    }),
    true,
  );

  const rejected = [
    { ...zeroTotalCheckout, payment_status: "unpaid" },
    { ...zeroTotalCheckout, amount_total: 1 },
    { ...zeroTotalCheckout, currency: "" },
    { ...zeroTotalCheckout, payment_intent: "pi_unexpected" },
  ];
  for (const checkout of rejected) {
    assert.equal(isZeroTotalCheckoutWithoutPaymentIntent(checkout), false);
  }
});

test("paid acquisition accepts Stripe-verified discount totals and rejects mismatches", () => {
  const discountedCheckout = {
    payment_status: "paid",
    amount_subtotal: 1499,
    amount_total: 1199,
    currency: "usd",
    total_details: {
      amount_discount: 300,
      amount_shipping: 0,
      amount_tax: 0,
    },
  };
  const expectation = { amountSubtotal: 1499, currency: "usd" };
  assert.equal(
    isValidDiscountedCheckoutPayment(
      discountedCheckout,
      { amountPaid: 1199, currency: "usd" },
      expectation,
    ),
    true,
  );
  assert.equal(
    isValidDiscountedCheckoutPayment(
      {
        ...discountedCheckout,
        amount_total: 999,
        total_details: {
          ...discountedCheckout.total_details,
          amount_discount: 500,
          amount_shipping: null,
        },
      },
      { amountPaid: 999, currency: "usd" },
      expectation,
    ),
    true,
  );

  const rejected = [
    [{ ...discountedCheckout, payment_status: "unpaid" }, { amountPaid: 1199, currency: "usd" }],
    [{ ...discountedCheckout, amount_subtotal: 999 }, { amountPaid: 1199, currency: "usd" }],
    [{ ...discountedCheckout, amount_total: 0, total_details: { ...discountedCheckout.total_details, amount_discount: 1499 } }, null],
    [{ ...discountedCheckout, total_details: { ...discountedCheckout.total_details, amount_discount: 299 } }, { amountPaid: 1199, currency: "usd" }],
    [{ ...discountedCheckout, total_details: { ...discountedCheckout.total_details, amount_tax: 1 } }, { amountPaid: 1199, currency: "usd" }],
    [discountedCheckout, { amountPaid: 1200, currency: "usd" }],
    [discountedCheckout, { amountPaid: 1199, currency: "eur" }],
  ];
  for (const [session, payment] of rejected) {
    assert.equal(
      isValidDiscountedCheckoutPayment(session, payment, expectation),
      false,
    );
  }
});

test("wrong devices and account overwrites fail closed", () => {
  assert.equal(matchesDeviceHash("a".repeat(64), "a".repeat(64)), true);
  assert.equal(matchesDeviceHash("a".repeat(64), "b".repeat(64)), false);
  assert.equal(matchesDeviceHash(null, "a".repeat(64)), false);
  assert.equal(canBindActivationAccount(null, "account-a"), true);
  assert.equal(canBindActivationAccount("account-a", "account-a"), true);
  assert.equal(canBindActivationAccount("account-a", "account-b"), false);
});

test("same-account activation claim retries are idempotent only after a valid bind", () => {
  for (const status of ["restored", "paid", "linked"]) {
    assert.equal(isActivationClaimReplay({
      existingAccountId: "account-a",
      requestedAccountId: "account-a",
      status,
      expired: false,
    }), true);
  }

  assert.equal(isActivationClaimReplay({
    existingAccountId: "account-a",
    requestedAccountId: "account-b",
    status: "restored",
    expired: false,
  }), false);
  assert.equal(isActivationClaimReplay({
    existingAccountId: "account-a",
    requestedAccountId: "account-a",
    status: "pending",
    expired: false,
  }), false);
  assert.equal(isActivationClaimReplay({
    existingAccountId: "account-a",
    requestedAccountId: "account-a",
    status: "linked",
    expired: true,
  }), false);
});

test("restore confirmation has one account-bound HMAC check after origin and form validation", () => {
  const token = createClaimCsrfToken({
    activationKey: "activation-1",
    accountId: "account-a",
    expiresAtSeconds: 1_100,
    secret: "test-secret",
  });
  assert.equal(validateClaimCsrfToken({
    token,
    activationKey: "activation-1",
    accountId: "account-a",
    nowSeconds: 1_000,
    secret: "test-secret",
  }), true);
  assert.equal(validateClaimCsrfToken({
    token,
    activationKey: "activation-1",
    accountId: "account-b",
    nowSeconds: 1_000,
    secret: "test-secret",
  }), false);
  assert.equal(validateClaimCsrfToken({
    token,
    activationKey: "activation-1",
    accountId: "account-a",
    nowSeconds: 1_101,
    secret: "test-secret",
  }), false);
  assert.equal(validateClaimCsrfToken({
    token: "malformed",
    activationKey: "activation-1",
    accountId: "account-a",
    nowSeconds: 1_000,
    secret: "test-secret",
  }), false);
  assert.equal(validateClaimCsrfToken({
    token: `${token}.extra`,
    activationKey: "activation-1",
    accountId: "account-a",
    nowSeconds: 1_000,
    secret: "test-secret",
  }), false);
  assert.equal(validateActivationClaimPost({
    requestOrigin: "https://evil.example",
    expectedOrigin: "https://sidestream.tv",
    contentType: "application/x-www-form-urlencoded",
  }), false);
  assert.equal(validateActivationClaimPost({
    requestOrigin: "https://sidestream.tv",
    expectedOrigin: "https://sidestream.tv",
    contentType: "application/json",
  }), false);
  assert.equal(validateActivationClaimPost({
    requestOrigin: "https://sidestream.tv",
    expectedOrigin: "https://sidestream.tv",
    contentType: "application/x-www-form-urlencoded.attacker",
  }), false);
  assert.equal(validateActivationClaimPost({
    requestOrigin: "https://sidestream.tv",
    expectedOrigin: "https://sidestream.tv",
    contentType: "application/x-www-form-urlencoded; charset=UTF-8",
  }), true);
});

test("OAuth next paths allow account, Checkout, and activation claim routes", () => {
  assert.equal(sanitizeAccountNextPath("/account.html?restore=1"), "/account.html?restore=1");
  assert.equal(
    sanitizeAccountNextPath("/api/activation/claim?activation=abc"),
    "/api/activation/claim?activation=abc",
  );
  assert.equal(sanitizeAccountNextPath("/\\evil.example/path"), "/account.html");
  assert.equal(sanitizeAccountNextPath("/%5c%5cevil.example/path"), "/account.html");
  assert.equal(sanitizeAccountNextPath("//evil.example/path"), "/account.html");
  assert.equal(sanitizeAccountNextPath("/api/checkout/start"), "/api/checkout/start");
  assert.equal(
    sanitizeAccountNextPath("/api/checkout/start?activation=abc"),
    "/api/checkout/start?activation=abc",
  );
  assert.equal(
    sanitizeAccountNextPath("/api/checkout/start?checkout=cancelled"),
    "/account.html",
  );
});

test("OAuth redirect origins must match the browser-facing start origin", () => {
  assert.equal(
    hasSameOrigin(
      "https://sidestream.tv/api/auth/google/callback",
      "https://sidestream.tv/api/auth/google/start",
    ),
    true,
  );
  assert.equal(
    hasSameOrigin(
      "https://sidestream-xi.vercel.app/api/auth/google/callback",
      "https://sidestream.tv/api/auth/google/start",
    ),
    false,
  );
  assert.equal(hasSameOrigin("not a URL", "https://sidestream.tv"), false);
});

test("activation issuance and refresh lost-response replay derive one stable token family", () => {
  const activationPair = deriveActivationTokenPair("activation-1", "device-1", "secret");
  assert.deepEqual(
    activationPair,
    deriveActivationTokenPair("activation-1", "device-1", "secret"),
  );
  assert.notDeepEqual(
    activationPair,
    deriveActivationTokenPair("activation-1", "device-2", "secret"),
  );

  const rotation = deriveRefreshRotationTokens("refresh-1", "secret");
  assert.deepEqual(rotation, deriveRefreshRotationTokens("refresh-1", "secret"));
  assert.notDeepEqual(rotation, deriveRefreshRotationTokens(rotation.refreshToken, "secret"));
});

test("activation credential replay is accepted at the boundary and terminal immediately after", () => {
  assert.equal(isActivationTokenReplayAllowed(null, 10_000, 600), true);
  assert.equal(isActivationTokenReplayAllowed(10_000, 610_000, 600), true);
  assert.equal(isActivationTokenReplayAllowed(10_000, 610_001, 600), false);
});

test("legacy clients through 1.0.13 receive compatibility replay and rolling access", () => {
  assert.equal(needsLegacyLicenseCompatibility("1.0.12"), true);
  assert.equal(needsLegacyLicenseCompatibility("1.0.12-beta.1"), true);
  assert.equal(needsLegacyLicenseCompatibility("1.0.11"), true);
  assert.equal(needsLegacyLicenseCompatibility("1.0.13"), true);
  assert.equal(needsLegacyLicenseCompatibility("1.0.14"), false);
  assert.equal(needsLegacyLicenseCompatibility("unknown"), false);
});

test("legacy-host Checkout redirects to the canonical authenticated route", async () => {
  assert.equal(isLegacyVercelHost("sidestream-xi.vercel.app"), true);
  assert.equal(isLegacyVercelHost("sidestream-xi.vercel.app:443"), true);
  assert.equal(isLegacyVercelHost("sidestream.tv"), false);

  const checkoutSource = await readFile(new URL("../api/checkout/start.ts", import.meta.url), "utf8");
  const guardIndex = checkoutSource.indexOf("isLegacyVercelHost(request.headers.host)");
  const sessionIndex = checkoutSource.indexOf("const session = await getSession(request)");
  assert.ok(guardIndex >= 0 && sessionIndex > guardIndex);
  assert.match(checkoutSource, /canonicalCheckout/);
  assert.match(checkoutSource, /\/api\/auth\/google\/start/);
  assert.doesNotMatch(checkoutSource, /text\/html|<form|<button/);
});

test("unlinked paid buyers receive a no-second-charge recovery path", async () => {
  const thankYouSource = await readFile(new URL("../thank-you.html", import.meta.url), "utf8");
  assert.match(thankYouSource, /same Google email used at Checkout/);
  assert.match(thankYouSource, /Upgrade or Restore Purchase/);
  assert.match(thankYouSource, /instead of charging you again/);
});

test("paid completion grace is database-bounded and unpaid Sessions fail verification", async () => {
  const migration = await readFile(new URL(
    "../db/migrations/20260713180000_add_activation_checkout_and_refresh_rotation.sql",
    import.meta.url,
  ), "utf8");
  assert.match(migration, /checkout_claim_grace_until <= stripe_checkout_expires_at \+ interval '10 minutes'/);
  assert.match(migration, /checkout_claim_grace_until <= expires_at/);
  assert.equal(verifyPaidCheckoutSession(
    { ...validCheckout, payment_status: "unpaid" },
    checkoutExpectation,
  ).ok, false);
});

test("Checkout attaches the activation only inside the locked intent worker", async () => {
  const [route, account] = await Promise.all([
    readFile(new URL("../api/checkout/start.ts", import.meta.url), "utf8"),
    readFile(new URL("../api/_lib/account.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(route, /bindActivationToAccount/);
  assert.match(route, /createOrReuseCheckoutSession/);
  assert.match(route, /license\.active/);
  assert.match(route, /\/api\/activation\/claim/);
  assert.match(account, /attachCheckoutSessionToActivation/);
  assert.match(account, /getCheckoutSessionIdempotencyKey/);
  assert.match(account, /allow_promotion_codes:\s*true/);
  assert.doesNotMatch(account, /allow_promotion_codes:\s*!options\.paidAcquisition/);
});

test("account implementation bounds status replay and uses locked refresh/fulfillment CAS", async () => {
  const source = await readFile(new URL("../api/_lib/account.ts", import.meta.url), "utf8");
  const claimStart = source.indexOf("export async function claimActivationToAccount");
  const claimReplay = source.indexOf("isActivationClaimReplay({", claimStart);
  const terminalRejection = source.indexOf(
    "row.expired || row.completed_at || row.status !== \"pending\"",
    claimStart,
  );
  assert.match(source, /ACTIVATION_TOKEN_REPLAY_SECONDS/);
  assert.match(source, /LEGACY_LICENSE_TOKEN_TTL_DAYS/);
  assert.match(source, /needsLegacyLicenseCompatibility\(row\.app_version\)/);
  assert.match(source, /needsLegacyLicenseCompatibility\(row\.activation_app_version\)/);
  assert.match(source, /row\.completed_at/);
  assert.match(source, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
  assert.match(source, /previous_refresh_token_hash/);
  assert.match(source, /for update of t/i);
  assert.match(source, /\(account_id is null or account_id = \$3\)/);
  assert.match(source, /checkout_claim_grace_until >= now\(\)/);
  assert.ok(claimStart >= 0 && claimReplay > claimStart && terminalRejection > claimReplay);
  assert.match(source, /code: "device_mismatch"/);
  assert.match(source, /code: "revoked"/);
  assert.match(source, /code: "invalid_token"/);
  assert.match(source, /code: "license_inactive"/);
});

test("legacy 1.0.12 account API POSTs are not caught by the old-host redirect", async () => {
  const config = JSON.parse(
    await readFile(new URL("../vercel.json", import.meta.url), "utf8"),
  );
  const oldHostRedirects = config.redirects.filter((rule) =>
    rule.has?.some((condition) =>
      condition.type === "host" && condition.value === "sidestream-xi.vercel.app"
    )
  );

  assert.ok(oldHostRedirects.some((rule) => rule.source === "/"));
  assert.equal(
    oldHostRedirects.some((rule) => rule.source === "/:path*"),
    false,
    "a broad old-host redirect would return 308 to installed CEP POST requests",
  );
  assert.ok(
    oldHostRedirects.some((rule) => rule.source === "/:path((?!api/).*)"),
    "non-API old-host pages should still canonicalize without intercepting /api/*",
  );
});

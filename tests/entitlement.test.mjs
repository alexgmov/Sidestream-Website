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
  getStripeCheckoutWindow,
  hasSameOrigin,
  isLegacyVercelHost,
  isActivationClaimReplay,
  isActivationTokenReplayAllowed,
  matchesDeviceHash,
  needsLegacyLicenseCompatibility,
  sanitizeAccountNextPath,
  validateActivationClaimPost,
  validateClaimCsrfToken,
  verifyPaidCheckoutSession,
} from "../api/_lib/entitlement.ts";
import { createApiContractHarness } from "./helpers/api-contract-harness.mjs";

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

test("missing PaymentIntent is accepted only for canonical zero-dollar Checkout truth", async () => {
  const cases = [
    {
      label: "paid-zero",
      session: { paymentIntent: null, amountTotal: 0, currency: "usd" },
      expected: { fulfilled: true, activationBound: true },
    },
    {
      label: "legacy-no-payment-required",
      session: {
        paymentIntent: null,
        amountTotal: 0,
        currency: "usd",
        paymentStatus: "no_payment_required",
      },
      expected: { fulfilled: true, activationBound: true },
    },
    {
      label: "unpaid-zero",
      session: {
        paymentIntent: null,
        amountTotal: 0,
        currency: "usd",
        paymentStatus: "unpaid",
      },
      expected: { fulfilled: false, reason: "payment_incomplete" },
    },
    {
      label: "nonzero",
      session: { paymentIntent: null, amountTotal: 999, currency: "usd" },
      expected: { fulfilled: false, reason: "missing_payment_intent" },
    },
    {
      label: "uppercase-currency",
      session: { paymentIntent: null, amountTotal: 0, currency: "USD" },
      expected: { fulfilled: false, reason: "missing_payment_intent" },
    },
    {
      label: "incomplete",
      session: {
        paymentIntent: null,
        amountTotal: 0,
        currency: "usd",
        status: "open",
      },
      expected: { fulfilled: false, reason: "checkout_incomplete" },
    },
  ];

  for (const scenario of cases) {
    const harness = createApiContractHarness();
    const seeded = harness.seedPaidActivation({
      activationKey: `activation-${scenario.label}`,
      sessionId: `cs_${scenario.label}`,
      session: scenario.session,
    });
    assert.deepEqual(
      await harness.dependencies.fulfillCheckoutSession(
        seeded.session.id,
        seeded.activation.activationKey,
      ),
      scenario.expected,
      scenario.label,
    );
  }

  const source = await readFile(new URL("../api/_lib/account.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function retrieveCanonicalCheckoutPayment");
  const end = source.indexOf("async function retrieveCanonicalPaymentFacts", start);
  const canonicalPaymentSource = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(canonicalPaymentSource, /payment_status !== "paid"/);
  assert.match(canonicalPaymentSource, /payment_status !== "no_payment_required"/);
  assert.match(canonicalPaymentSource, /amount_total !== 0/);
  assert.match(canonicalPaymentSource, /!\/\^\[a-z\]\{3\}\$\/\.test\(currency\)/);
  assert.match(canonicalPaymentSource, /reason: "missing_payment_intent"/);
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

test("OAuth next paths allow only account and restore confirmation routes", () => {
  assert.equal(sanitizeAccountNextPath("/account.html?restore=1"), "/account.html?restore=1");
  assert.equal(
    sanitizeAccountNextPath("/api/activation/claim?activation=abc"),
    "/api/activation/claim?activation=abc",
  );
  assert.equal(sanitizeAccountNextPath("/\\evil.example/path"), "/account.html");
  assert.equal(sanitizeAccountNextPath("/%5c%5cevil.example/path"), "/account.html");
  assert.equal(sanitizeAccountNextPath("//evil.example/path"), "/account.html");
  assert.equal(sanitizeAccountNextPath("/api/checkout/start"), "/account.html");
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

test("legacy-host bare Checkout fails safe before Stripe", async () => {
  assert.equal(isLegacyVercelHost("sidestream-xi.vercel.app"), true);
  assert.equal(isLegacyVercelHost("sidestream-xi.vercel.app:443"), true);
  assert.equal(isLegacyVercelHost("sidestream.tv"), false);

  const checkoutSource = await readFile(new URL("../api/checkout/start.ts", import.meta.url), "utf8");
  const upgradeSource = await readFile(new URL("../upgrade.html", import.meta.url), "utf8");
  const guardIndex = checkoutSource.indexOf("isLegacyVercelHost(request.headers.host)");
  assert.ok(guardIndex >= 0);
  assert.doesNotMatch(checkoutSource, /getStripe\(\)/);
  assert.doesNotMatch(checkoutSource, /createOrReuseCheckoutSession\(/);
  assert.match(checkoutSource, /checkout.*activation_required/s);
  assert.match(upgradeSource, /checkoutState === "activation_required"/);
  assert.match(upgradeSource, /checkoutLink\.hidden = true/);
  assert.match(upgradeSource, /You have not been charged/);
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

test("Checkout start mints capabilities while authenticated handlers own the worker", async () => {
  const [start, create, authStart, callback, account] = await Promise.all([
    readFile(new URL("../api/checkout/start.ts", import.meta.url), "utf8"),
    readFile(new URL("../api/checkout/create.ts", import.meta.url), "utf8"),
    readFile(new URL("../api/auth/google/start.ts", import.meta.url), "utf8"),
    readFile(new URL("../api/auth/google/callback.ts", import.meta.url), "utf8"),
    readFile(new URL("../api/_lib/account.ts", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(start, /bindActivationToAccount/);
  assert.doesNotMatch(start, /attachCheckoutSessionToActivation/);
  assert.doesNotMatch(start, /createOrReuseCheckoutSession\(/);
  assert.match(start, /createCheckoutIntentConfirmation/);
  assert.match(start, /\/api\/auth\/google\/start/);
  assert.match(start, /confirmation\.activationKey/);
  assert.match(start, /Confirm Sidestream Pro purchase/);
  assert.match(start, /\/api\/activation\/claim/);

  assert.doesNotMatch(create, /bindActivationToAccount/);
  assert.match(create, /createOrReuseCheckoutSession/);
  assert.match(create, /license\.active/);

  for (const authenticatedRoute of [authStart, callback]) {
    const rateLimit = authenticatedRoute.indexOf("await consumeRateLimit");
    const worker = authenticatedRoute.indexOf(
      "await createOrReuseCheckoutSession",
      rateLimit,
    );
    assert.ok(rateLimit >= 0 && worker > rateLimit);
    assert.match(authenticatedRoute, /\/api\/activation\/claim/);
    assert.match(authenticatedRoute, /active_license/);
  }
  assert.match(callback, /returnedState !== expectedState/);
  assert.match(callback, /getAccountSessionById/);
  assert.match(callback, /deferAccountBindingCheck: true/);
  assert.match(account, /sidestream_oauth_checkout_intent/);
  assert.match(account, /sidestream_oauth_checkout_rotate/);
  assert.match(account, /deferAccountBindingCheck/);
});

test("account implementation bounds status replay and uses locked refresh/fulfillment CAS", async () => {
  const source = await readFile(new URL("../api/_lib/account.ts", import.meta.url), "utf8");
  const claimStart = source.indexOf("export async function claimActivationToAccount");
  const claimReplay = source.indexOf("isActivationClaimReplay({", claimStart);
  const replayTelemetryAttach = source.indexOf(
    "await attachActivationTelemetryIdentityAccount(client, {",
    claimReplay,
  );
  const terminalRejection = source.indexOf(
    "row.expired || row.completed_at || row.status !== \"pending\"",
    claimStart,
  );
  const claimUpdate = source.indexOf(
    "update public.sidestream_activation_sessions",
    terminalRejection,
  );
  const claimedTelemetryAttach = source.indexOf(
    "await attachActivationTelemetryIdentityAccount(client, {",
    replayTelemetryAttach + 1,
  );
  const fulfillmentStart = source.indexOf("export async function fulfillCheckoutSession");
  const activationBound = source.indexOf("activationBound = Boolean(bound.rows[0])", fulfillmentStart);
  const checkoutTelemetryAttach = source.indexOf(
    "await attachActivationTelemetryIdentityAccount(client, {",
    activationBound,
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
  assert.ok(replayTelemetryAttach > claimReplay && replayTelemetryAttach < terminalRejection);
  assert.ok(claimedTelemetryAttach > claimUpdate);
  assert.ok(checkoutTelemetryAttach > activationBound);
  assert.match(source, /set telemetry_identity_link_id = \$2::uuid/);
  assert.doesNotMatch(
    source.match(/insert into public\.sidestream_activation_sessions[\s\S]*?returning id/)?.[0] || "",
    /install_id_hash/i,
  );
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

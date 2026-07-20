import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildCheckoutCompletionUrl,
  canBindActivationAccount,
  createClaimCsrfToken,
  createPluginUpgradeIntentToken,
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
  shouldUseDirectPluginUpgradeHandoff,
  validateActivationClaimPost,
  validateClaimCsrfToken,
  validatePluginUpgradeIntentToken,
  verifyPaidCheckoutSession,
} from "../api/_lib/entitlement.ts";
import { loadInjectedHandler } from "./helpers/handler-loader.mjs";
import { invokeHandler } from "./helpers/http.mjs";

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

test("only a current plugin activation receives a direct OAuth Checkout handoff", () => {
  assert.equal(shouldUseDirectPluginUpgradeHandoff({
    source: "plugin",
    appVersion: "1.0.14",
  }), true);
  assert.equal(shouldUseDirectPluginUpgradeHandoff({
    source: "plugin",
    appVersion: "1.0.13",
  }), false);
  assert.equal(shouldUseDirectPluginUpgradeHandoff({
    source: "plugin",
    appVersion: "unknown",
  }), false);
  assert.equal(shouldUseDirectPluginUpgradeHandoff({
    source: "plugin",
    appVersion: "",
  }), false);
  for (const source of ["", "website", "restore", "PLUGIN"]) {
    assert.equal(shouldUseDirectPluginUpgradeHandoff({
      source,
      appVersion: "1.0.14",
    }), false);
  }
});

test("plugin Upgrade intent tokens bind the exact activation and fail closed", () => {
  const secret = "plugin-upgrade-test-secret";
  const activationKey = "activation_plugin_123";
  const token = createPluginUpgradeIntentToken({
    activationKey,
    expiresAtSeconds: 1_600,
    secret,
  });
  assert.equal(validatePluginUpgradeIntentToken({
    token,
    nowSeconds: 1_000,
    secret,
  }), activationKey);
  assert.equal(validatePluginUpgradeIntentToken({
    token: "",
    nowSeconds: 1_000,
    secret,
  }), "");
  assert.equal(validatePluginUpgradeIntentToken({
    token,
    nowSeconds: 1_601,
    secret,
  }), "");
  assert.equal(validatePluginUpgradeIntentToken({
    token,
    nowSeconds: 1_000,
    secret: `${secret}-attacker`,
  }), "");
  assert.equal(validatePluginUpgradeIntentToken({
    token: token.replace("plugin_upgrade", "account"),
    nowSeconds: 1_000,
    secret,
  }), "");
  assert.equal(validatePluginUpgradeIntentToken({
    token: token.replace(activationKey, "activation_attacker_1"),
    nowSeconds: 1_000,
    secret,
  }), "");
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

test("OAuth start accepts only signed Upgrade and Checkout capabilities", async () => {
  let storedCookies = null;
  let session = null;
  const handler = await loadInjectedHandler(
    new URL("../api/auth/google/start.ts", import.meta.url),
    {
      "../../_lib/account.js": {
        cleanString(value, maxLength = 240) {
          return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
        },
        getBaseUrl: () => "https://sidestream.test",
        getGoogleAuthUrl: () => "https://accounts.google.test/oauth",
        getSession: async () => session,
        methodNotAllowed(response) {
          response.statusCode = 405;
          response.end();
        },
        randomToken: () => "oauth-state",
        readPluginUpgradeIntentToken(value) {
          return value === "valid-plugin-intent"
            ? { token: value, activationKey: "activation_plugin_123" }
            : { token: String(value || ""), activationKey: "" };
        },
        async resumeCheckoutIntentConfirmation(options) {
          assert.equal(options.deferAccountBindingCheck, true);
          return options.browserToken === "checkout-browser-token"
            ? { browserToken: options.browserToken }
            : null;
        },
        redirect(response, location, statusCode = 303) {
          response.statusCode = statusCode;
          response.setHeader("Location", location);
          response.end();
        },
        sanitizeNextPath: sanitizeAccountNextPath,
        sendGoogleSignInError(response, statusCode) {
          response.statusCode = statusCode;
          response.end("invalid");
        },
        setOAuthCookies(_request, _response, options) {
          storedCookies = options;
        },
      },
    },
  );

  const accepted = await invokeHandler(handler, {
    method: "GET",
    url: "/api/auth/google/start?plugin_upgrade=valid-plugin-intent",
  });
  assert.equal(accepted.response.statusCode, 302);
  assert.equal(
    accepted.response.getHeader("location"),
    "https://accounts.google.test/oauth",
  );
  assert.deepEqual(storedCookies, {
    state: "oauth-state",
    nextPath: "/account.html",
    pluginUpgradeToken: "valid-plugin-intent",
    checkoutIntentToken: undefined,
    rotateCancelledCheckout: false,
  });

  const checkout = await invokeHandler(handler, {
    method: "GET",
    url: "/api/auth/google/start?checkout_intent=checkout-browser-token&checkout=cancelled",
  });
  assert.equal(checkout.response.statusCode, 302);
  assert.deepEqual(storedCookies, {
    state: "oauth-state",
    nextPath: "/account.html",
    pluginUpgradeToken: "",
    checkoutIntentToken: "checkout-browser-token",
    rotateCancelledCheckout: true,
  });

  const conflict = await invokeHandler(handler, {
    method: "GET",
    url: "/api/auth/google/start?plugin_upgrade=valid-plugin-intent&checkout_intent=checkout-browser-token",
  });
  assert.equal(conflict.response.statusCode, 400);

  session = { license: { active: false } };
  const resumed = await invokeHandler(handler, {
    method: "GET",
    url: "/api/auth/google/start?plugin_upgrade=valid-plugin-intent",
  });
  assert.equal(resumed.response.statusCode, 303);
  assert.equal(
    resumed.response.getHeader("location"),
    "https://sidestream.test/api/checkout/start?activation=activation_plugin_123",
  );

  const rejected = await invokeHandler(handler, {
    method: "GET",
    url: "/api/auth/google/start?plugin_upgrade=attacker",
  });
  assert.equal(rejected.response.statusCode, 400);

  const arbitraryNext = await invokeHandler(handler, {
    method: "GET",
    url: "/api/auth/google/start?next=%2Fapi%2Fcheckout%2Fstart%3Factivation%3Dattacker",
  });
  assert.equal(arbitraryNext.response.statusCode, 303);
  assert.equal(arbitraryNext.response.getHeader("location"), "/account.html");
});

test("state-verified OAuth callback hands a plugin activation to the locked Checkout worker", async () => {
  let pluginUpgrade = {
    requested: true,
    activationKey: "activation_plugin_123",
  };
  let oauthCheckout = {
    requested: false,
    browserToken: "",
    rotateCancelledSession: false,
  };
  let activeLicense = false;
  let rateAllowed = true;
  let exchangeCalls = 0;
  let confirmationCalls = 0;
  let resumeCalls = 0;
  let checkoutCalls = 0;
  const observedRotations = [];
  let observedRateLimit = null;
  const session = () => ({
    accountId: "11111111-1111-4111-8111-111111111111",
    email: "buyer@example.com",
    name: "Buyer",
    avatarUrl: "",
    stripeCustomerId: "",
    license: { active: activeLicense },
  });
  const handler = await loadInjectedHandler(
    new URL("../api/auth/google/callback.ts", import.meta.url),
    {
      "../../_lib/account.js": {
        clearOAuthCookies() {},
        async createCheckoutIntentConfirmation(options) {
          confirmationCalls += 1;
          assert.equal(options.activationKey, "activation_plugin_123");
          assert.equal(options.session.accountId, session().accountId);
          return {
            intentId: "22222222-2222-4222-8222-222222222222",
            browserToken: "browser-token",
          };
        },
        async createOrReuseCheckoutSession(options) {
          checkoutCalls += 1;
          observedRotations.push(options.rotateCancelledSession);
          assert.equal(options.intentId, "22222222-2222-4222-8222-222222222222");
          assert.equal(options.browserToken, "browser-token");
          assert.equal(options.session.accountId, session().accountId);
          return {
            ok: true,
            url: "https://checkout.stripe.test/session",
            reused: checkoutCalls > 1,
          };
        },
        async createWebSession() {},
        async exchangeGoogleCode() {
          exchangeCalls += 1;
          return { subject: "google-subject", email: "buyer@example.com" };
        },
        async getAccountSessionById() {
          return session();
        },
        getBaseUrl: () => "https://sidestream.test",
        getClientIp: () => "127.0.0.1",
        getOAuthNextPath: () => "/account.html",
        getOAuthCheckoutIntent: () => oauthCheckout,
        getOAuthPluginUpgradeIntent: () => pluginUpgrade,
        getOAuthState: () => "oauth-state",
        methodNotAllowed(response) {
          response.statusCode = 405;
          response.end();
        },
        redirect(response, location, statusCode = 303) {
          response.statusCode = statusCode;
          response.setHeader("Location", location);
          response.end();
        },
        sendGoogleSignInError(response, statusCode) {
          response.statusCode = statusCode;
          response.end("failed");
        },
        async resumeCheckoutIntentConfirmation(options) {
          resumeCalls += 1;
          assert.equal(options.browserToken, "checkout-browser-token");
          assert.equal(options.session.accountId, session().accountId);
          return {
            intentId: "22222222-2222-4222-8222-222222222222",
            browserToken: "browser-token",
          };
        },
        async upsertGoogleAccount() {
          return session().accountId;
        },
      },
      "../../_lib/rate-limit.js": {
        applyRateLimitHeaders() {},
        async consumeRateLimit(options) {
          observedRateLimit = options;
          return rateAllowed
            ? { allowed: true, limit: 8, remaining: 7, resetAt: new Date() }
            : { allowed: false, limit: 8, remaining: 0, retryAfterSeconds: 30 };
        },
        sendRateLimitExceeded(response) {
          response.statusCode = 429;
          response.end("limited");
        },
      },
    },
  );

  const callbackRequest = {
    method: "GET",
    url: "/api/auth/google/callback?code=google-code&state=oauth-state",
  };
  const direct = await invokeHandler(handler, callbackRequest);
  assert.equal(direct.response.statusCode, 303);
  assert.equal(
    direct.response.getHeader("location"),
    "https://checkout.stripe.test/session",
  );
  assert.equal(confirmationCalls, 1);
  assert.equal(checkoutCalls, 1);
  assert.deepEqual(observedRotations, [false]);
  assert.deepEqual(observedRateLimit.dimensions, [
    { name: "intent", value: "22222222-2222-4222-8222-222222222222", limit: 8 },
    { name: "ip", value: "127.0.0.1", limit: 20 },
  ]);

  pluginUpgrade = { requested: false, activationKey: "" };
  const generic = await invokeHandler(handler, callbackRequest);
  assert.equal(generic.response.statusCode, 303);
  assert.equal(generic.response.getHeader("location"), "/account.html");
  assert.equal(checkoutCalls, 1);

  oauthCheckout = {
    requested: true,
    browserToken: "checkout-browser-token",
    rotateCancelledSession: true,
  };
  const checkout = await invokeHandler(handler, callbackRequest);
  assert.equal(checkout.response.statusCode, 303);
  assert.equal(
    checkout.response.getHeader("location"),
    "https://checkout.stripe.test/session",
  );
  assert.equal(resumeCalls, 1);
  assert.equal(checkoutCalls, 2);
  assert.deepEqual(observedRotations, [false, true]);

  oauthCheckout = {
    requested: false,
    browserToken: "",
    rotateCancelledSession: false,
  };

  pluginUpgrade = { requested: true, activationKey: "" };
  const exchangeCallsBeforeInvalid = exchangeCalls;
  const invalid = await invokeHandler(handler, callbackRequest);
  assert.equal(invalid.response.statusCode, 400);
  assert.equal(exchangeCalls, exchangeCallsBeforeInvalid);
  assert.equal(checkoutCalls, 2);

  pluginUpgrade = {
    requested: true,
    activationKey: "activation_plugin_123",
  };
  rateAllowed = false;
  const limited = await invokeHandler(handler, callbackRequest);
  assert.equal(limited.response.statusCode, 429);
  assert.equal(checkoutCalls, 2);

  rateAllowed = true;
  activeLicense = true;
  const owner = await invokeHandler(handler, callbackRequest);
  assert.equal(owner.response.statusCode, 303);
  assert.equal(
    owner.response.getHeader("location"),
    "https://sidestream.test/api/activation/claim?activation=activation_plugin_123",
  );
  assert.equal(checkoutCalls, 2);
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
  const stripeIndex = checkoutSource.indexOf("const stripe = getStripe()");
  assert.ok(guardIndex >= 0 && guardIndex < stripeIndex);
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

test("both Checkout routes attach instead of pre-binding attacker activation links", async () => {
  for (const route of ["../api/checkout/start.ts", "../api/checkout/create.ts"]) {
    const source = await readFile(new URL(route, import.meta.url), "utf8");
    assert.doesNotMatch(source, /bindActivationToAccount/);
    assert.match(source, /attachCheckoutSessionToActivation/);
    assert.match(source, /getActivationCheckoutIdempotencyKey/);
    assert.match(source, /license\.active/);
    assert.match(source, /\/api\/activation\/claim/);
  }
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

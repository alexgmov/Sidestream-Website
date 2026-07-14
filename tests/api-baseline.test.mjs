import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlledClock,
  DeterministicRandom,
  createApiContractHarness,
  createPaidCheckoutSession,
} from "./helpers/api-contract-harness.mjs";
import { loadInjectedHandler } from "./helpers/handler-loader.mjs";
import { invokeHandler } from "./helpers/http.mjs";
import { findRuntimeDdl } from "../scripts/assert-no-runtime-ddl.mjs";

const JSON_HEADERS = { "content-type": "application/json" };
const FORM_HEADERS = {
  "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
  origin: "https://sidestream.test",
};

test("the contract harness controls time and random values", () => {
  const clock = new ControlledClock("2026-07-14T00:00:00.000Z");
  const random = new DeterministicRandom(["first", "second"]);

  assert.equal(clock.now(), Date.parse("2026-07-14T00:00:00.000Z"));
  clock.advance(1_250);
  assert.equal(clock.date().toISOString(), "2026-07-14T00:00:01.250Z");
  assert.equal(random.next("ignored"), "first");
  assert.equal(random.next("ignored"), "second");
  assert.equal(random.next("fallback"), "fallback-0003");
});

test("the runtime-DDL guard recognizes schema mutations without flagging product prose", () => {
  const violations = findRuntimeDdl(`
    await query(\`create table public.runtime_table (id text)\`);
    await query(\`alter policy private_rows on public.runtime_table using (false)\`);
  `, "api/example.ts");
  assert.deepEqual(
    violations.map((violation) => violation.rule),
    ["schema-object DDL", "schema-object DDL"],
  );
  assert.deepEqual(findRuntimeDdl("This action will revoke its Pro access."), []);
});

test("start, status, verify, and refresh handlers require a device ID", async () => {
  const harness = createApiContractHarness();
  const [start, status, verify, refresh] = await Promise.all([
    loadAccountHandler("../api/activation/start.ts", harness),
    loadAccountHandler("../api/activation/status.ts", harness),
    loadAccountHandler("../api/license/verify.ts", harness),
    loadAccountHandler("../api/license/refresh.ts", harness),
  ]);

  const startMissing = await invokeHandler(start, {
    method: "POST",
    url: "/api/activation/start",
    headers: JSON_HEADERS,
    body: {},
  });
  assert.equal(startMissing.response.statusCode, 400);
  assert.equal(startMissing.response.json.code, "invalid_request");
  assert.equal(harness.store.activations.size, 0);

  const statusMissing = await invokeHandler(status, {
    method: "POST",
    url: "/api/activation/status",
    headers: JSON_HEADERS,
    body: { activationKey: "activation-one" },
  });
  assert.equal(statusMissing.response.statusCode, 400);
  assert.equal(statusMissing.response.json.code, "invalid_request");

  const verifyMissing = await invokeHandler(verify, {
    method: "POST",
    url: "/api/license/verify",
    headers: JSON_HEADERS,
    body: { licenseToken: "license-one" },
  });
  assert.equal(verifyMissing.response.statusCode, 400);
  assert.equal(verifyMissing.response.json.code, "invalid_request");

  const refreshMissing = await invokeHandler(refresh, {
    method: "POST",
    url: "/api/license/refresh",
    headers: JSON_HEADERS,
    body: { refreshToken: "refresh-one" },
  });
  assert.equal(refreshMissing.response.statusCode, 400);
  assert.equal(refreshMissing.response.json.code, "invalid_request");

  const started = await invokeHandler(start, {
    method: "POST",
    url: "/api/activation/start",
    headers: JSON_HEADERS,
    body: { deviceId: "device-owner", appVersion: "1.0.14" },
  });
  assert.equal(started.response.statusCode, 200);
  assert.equal(started.response.json.activationKey, "activation-deterministic");
  assert.equal(harness.store.activations.size, 1);
});

test("restore GET is read-only and POST requires an origin/account/activation-bound expiring HMAC", async () => {
  const harness = createApiContractHarness();
  const claim = await loadAccountHandler("../api/activation/claim.ts", harness);
  const victimSession = harness.activeSession("account-victim");

  const attackerActivation = harness.store.seedActivation({
    activationKey: "activation-attacker",
    deviceId: "device-attacker",
    accountId: "account-attacker",
  });
  const attackerLink = await invokeHandler(claim, {
    method: "GET",
    url: "/api/activation/claim?activation=activation-attacker",
    session: victimSession,
  });
  assert.equal(attackerLink.response.statusCode, 409);
  assert.equal(attackerActivation.accountId, "account-attacker");
  assert.equal(harness.store.claimCasWinners, 0);

  const activation = harness.store.seedActivation({
    activationKey: "activation-restore",
    deviceId: "device-victim",
  });
  const confirmation = await invokeHandler(claim, {
    method: "GET",
    url: "/api/activation/claim?activation=activation-restore",
    session: victimSession,
  });
  assert.equal(confirmation.response.statusCode, 200);
  assert.equal(confirmation.response.getHeader("cache-control"), "no-store");
  assert.equal(activation.accountId, null, "GET must not bind the signed-in account");
  assert.equal(harness.store.claimCasWinners, 0);
  const csrfToken = extractCsrfToken(confirmation.response.body);

  const crossSite = await invokeHandler(claim, {
    method: "POST",
    url: "/api/activation/claim",
    headers: { ...FORM_HEADERS, origin: "https://attacker.example" },
    session: victimSession,
    body: restoreForm("activation-restore", csrfToken),
  });
  assert.equal(crossSite.response.statusCode, 403);
  assert.equal(crossSite.response.json.code, "csrf_rejected");
  assert.equal(activation.accountId, null);

  const wrongContentType = await invokeHandler(claim, {
    method: "POST",
    url: "/api/activation/claim",
    headers: { "content-type": "text/plain", origin: "https://sidestream.test" },
    session: victimSession,
    body: restoreForm("activation-restore", csrfToken),
  });
  assert.equal(wrongContentType.response.statusCode, 403);
  assert.equal(wrongContentType.response.json.code, "csrf_rejected");
  assert.equal(activation.accountId, null);

  const wrongAccount = await invokeHandler(claim, {
    method: "POST",
    url: "/api/activation/claim",
    headers: FORM_HEADERS,
    session: harness.activeSession("account-other"),
    body: restoreForm("activation-restore", csrfToken),
  });
  assert.equal(wrongAccount.response.statusCode, 403);
  assert.equal(activation.accountId, null);

  harness.store.seedActivation({
    activationKey: "activation-other",
    deviceId: "device-other",
  });
  const wrongActivation = await invokeHandler(claim, {
    method: "POST",
    url: "/api/activation/claim",
    headers: FORM_HEADERS,
    session: victimSession,
    body: restoreForm("activation-other", csrfToken),
  });
  assert.equal(wrongActivation.response.statusCode, 403);
  assert.equal(harness.store.getActivation("activation-other").accountId, null);

  harness.clock.advance(10 * 60 * 1000 + 1_000);
  const expired = await invokeHandler(claim, {
    method: "POST",
    url: "/api/activation/claim",
    headers: FORM_HEADERS,
    session: victimSession,
    body: restoreForm("activation-restore", csrfToken),
  });
  assert.equal(expired.response.statusCode, 403);
  assert.equal(activation.accountId, null);

  const refreshedConfirmation = await invokeHandler(claim, {
    method: "GET",
    url: "/api/activation/claim?activation=activation-restore",
    session: victimSession,
  });
  const freshToken = extractCsrfToken(refreshedConfirmation.response.body);
  const restored = await invokeHandler(claim, {
    method: "POST",
    url: "/api/activation/claim",
    headers: FORM_HEADERS,
    session: victimSession,
    body: restoreForm("activation-restore", freshToken),
  });
  assert.equal(restored.response.statusCode, 303);
  assert.match(restored.response.getHeader("location"), /connection=restored/);
  assert.equal(activation.accountId, "account-victim");
  assert.equal(activation.status, "restored");
  assert.equal(harness.store.claimCasWinners, 1);
});

test("concurrent restore claims expose one compare-and-set winner", async () => {
  const harness = createApiContractHarness();
  const activation = harness.store.seedActivation({
    activationKey: "activation-concurrent-restore",
    deviceId: "device-owner",
  });
  const claim = await loadAccountHandler("../api/activation/claim.ts", harness);
  const session = harness.activeSession("account-owner");
  const confirmation = await invokeHandler(claim, {
    method: "GET",
    url: "/api/activation/claim?activation=activation-concurrent-restore",
    session,
  });
  const csrfToken = extractCsrfToken(confirmation.response.body);
  const request = {
    method: "POST",
    url: "/api/activation/claim",
    headers: FORM_HEADERS,
    session,
    body: restoreForm("activation-concurrent-restore", csrfToken),
  };

  const [first, second] = await Promise.all([
    invokeHandler(claim, request),
    invokeHandler(claim, request),
  ]);

  assert.equal(first.response.statusCode, 303);
  assert.equal(second.response.statusCode, 303);
  assert.equal(harness.store.claimCasWinners, 1);
  assert.equal(activation.accountId, "account-owner");
  assert.equal(activation.status, "restored");
});

test("a wrong device cannot reconcile Checkout or mint/rotate credentials", async () => {
  const harness = createApiContractHarness();
  const { activation } = harness.seedPaidActivation({
    activationKey: "activation-device-bound",
    deviceId: "device-owner",
  });
  const [status, verify, refresh] = await Promise.all([
    loadAccountHandler("../api/activation/status.ts", harness),
    loadAccountHandler("../api/license/verify.ts", harness),
    loadAccountHandler("../api/license/refresh.ts", harness),
  ]);

  const wrongStatus = await invokeHandler(status, {
    method: "POST",
    url: "/api/activation/status",
    headers: JSON_HEADERS,
    body: { activationKey: activation.activationKey, deviceId: "device-attacker" },
  });
  assert.equal(wrongStatus.response.statusCode, 200);
  assert.equal(wrongStatus.response.json.status, "device_mismatch");
  assert.equal(harness.stripe.calls.length, 0, "device validation must precede Stripe retrieval");
  assert.equal(activation.accountId, null);
  assert.equal(harness.store.credentialsByAccessToken.size, 0);

  const ownerStatus = await invokeHandler(status, {
    method: "POST",
    url: "/api/activation/status",
    headers: JSON_HEADERS,
    body: { activationKey: activation.activationKey, deviceId: "device-owner" },
  });
  assert.equal(ownerStatus.response.statusCode, 200);
  assert.equal(ownerStatus.response.json.status, "active");
  assert.equal(harness.stripe.calls.length, 1);
  assert.equal(activation.accountId, "account-owner");
  assert.equal(harness.store.credentialsByAccessToken.size, 1);

  const wrongVerify = await invokeHandler(verify, {
    method: "POST",
    url: "/api/license/verify",
    headers: JSON_HEADERS,
    body: {
      licenseToken: ownerStatus.response.json.licenseToken,
      deviceId: "device-attacker",
    },
  });
  assert.equal(wrongVerify.response.statusCode, 401);
  assert.equal(wrongVerify.response.json.code, "device_mismatch");

  const wrongRefresh = await invokeHandler(refresh, {
    method: "POST",
    url: "/api/license/refresh",
    headers: JSON_HEADERS,
    body: {
      refreshToken: ownerStatus.response.json.refreshToken,
      deviceId: "device-attacker",
    },
  });
  assert.equal(wrongRefresh.response.statusCode, 401);
  assert.equal(wrongRefresh.response.json.code, "device_mismatch");
  assert.equal(harness.store.credentialsByAccessToken.size, 1);
});

test("Checkout completion validates attachment, Stripe truth, metadata, and persisted time windows", async (t) => {
  const invalidSessions = [
    ["payment mode", { mode: "subscription" }, "invalid_checkout_mode"],
    ["completion status", { status: "open" }, "checkout_incomplete"],
    ["payment status", { paymentStatus: "unpaid" }, "payment_incomplete"],
    ["metadata Price", { metadata: { sidestream_price_id: "price-attacker" } }, "metadata_price_mismatch"],
    ["line-item Price", { lineItemPriceId: "price-attacker" }, "line_item_price_mismatch"],
    ["line-item Product", { lineItemProductId: "prod-attacker" }, "line_item_product_mismatch"],
    ["quantity", { quantity: 2 }, "invalid_quantity"],
  ];

  for (const [label, sessionPatch, expectedReason] of invalidSessions) {
    await t.test(`rejects invalid ${label}`, async () => {
      const harness = createApiContractHarness();
      const seeded = harness.seedPaidActivation({ session: sessionPatch });
      const complete = await loadAccountHandler("../api/checkout/complete.ts", harness);
      const result = await invokeCheckoutComplete(complete, seeded.session.id, seeded.activation.activationKey);
      assert.equal(result.response.statusCode, 409);
      assert.equal(result.response.json.code, expectedReason);
      assert.equal(seeded.activation.accountId, null);
    });
  }

  await t.test("rejects activation metadata that does not match the callback", async () => {
    const harness = createApiContractHarness();
    const seeded = harness.seedPaidActivation({
      session: { metadata: { sidestream_activation_key: "activation-attacker" } },
    });
    const complete = await loadAccountHandler("../api/checkout/complete.ts", harness);
    const result = await invokeCheckoutComplete(complete, seeded.session.id, seeded.activation.activationKey);
    assert.equal(result.response.statusCode, 409);
    assert.equal(result.response.json.code, "activation_mismatch");
    assert.equal(seeded.activation.accountId, null);
  });

  await t.test("rejects a paid Session that was never attached", async () => {
    const harness = createApiContractHarness();
    const seeded = harness.seedPaidActivation({ sessionId: "cs-attached" });
    const unattached = createPaidCheckoutSession({
      sessionId: "cs-unattached",
      activationKey: seeded.activation.activationKey,
      expiresAt: seeded.activation.checkout.stripeExpiresAt,
    });
    harness.stripe.setSession(unattached);
    const complete = await loadAccountHandler("../api/checkout/complete.ts", harness);
    const result = await invokeCheckoutComplete(complete, unattached.id, seeded.activation.activationKey);
    assert.equal(result.response.statusCode, 409);
    assert.equal(result.response.json.code, "unattached_session");
  });

  await t.test("rejects Stripe expiry drift from the persisted attachment", async () => {
    const harness = createApiContractHarness();
    const seeded = harness.seedPaidActivation({
      session: { expiresAt: harness.clock.now() + 31 * 60 * 1000 },
    });
    const complete = await loadAccountHandler("../api/checkout/complete.ts", harness);
    const result = await invokeCheckoutComplete(complete, seeded.session.id, seeded.activation.activationKey);
    assert.equal(result.response.statusCode, 409);
    assert.equal(result.response.json.code, "checkout_expiry_mismatch");
  });

  await t.test("allows completion grace, then rejects immediately after it", async () => {
    const withinGrace = createApiContractHarness();
    const accepted = withinGrace.seedPaidActivation();
    withinGrace.clock.set(accepted.activation.checkout.graceUntil);
    const acceptedHandler = await loadAccountHandler("../api/checkout/complete.ts", withinGrace);
    const acceptedResult = await invokeCheckoutComplete(
      acceptedHandler,
      accepted.session.id,
      accepted.activation.activationKey,
    );
    assert.equal(acceptedResult.response.statusCode, 303);

    const afterGrace = createApiContractHarness();
    const rejected = afterGrace.seedPaidActivation();
    afterGrace.clock.set(rejected.activation.checkout.graceUntil + 1);
    const rejectedHandler = await loadAccountHandler("../api/checkout/complete.ts", afterGrace);
    const rejectedResult = await invokeCheckoutComplete(
      rejectedHandler,
      rejected.session.id,
      rejected.activation.activationKey,
    );
    assert.equal(rejectedResult.response.statusCode, 409);
    assert.equal(rejectedResult.response.json.code, "checkout_claim_expired");
  });

  await t.test("rejects an attachment window extending past activation expiry", async () => {
    const harness = createApiContractHarness();
    const seeded = harness.seedPaidActivation({
      activationExpiresAt: harness.clock.now() + 35 * 60 * 1000,
    });
    const complete = await loadAccountHandler("../api/checkout/complete.ts", harness);
    const result = await invokeCheckoutComplete(complete, seeded.session.id, seeded.activation.activationKey);
    assert.equal(result.response.statusCode, 409);
    assert.equal(result.response.json.code, "invalid_checkout_window");
  });
});

test("valid Checkout completion runs one compare-and-set winner under concurrent handlers", async () => {
  const harness = createApiContractHarness();
  const seeded = harness.seedPaidActivation({
    activationKey: "activation-concurrent",
    sessionId: "cs-concurrent",
  });
  const complete = await loadAccountHandler("../api/checkout/complete.ts", harness);

  const [first, second] = await Promise.all([
    invokeCheckoutComplete(complete, seeded.session.id, seeded.activation.activationKey),
    invokeCheckoutComplete(complete, seeded.session.id, seeded.activation.activationKey),
  ]);

  assert.equal(first.response.statusCode, 303);
  assert.equal(second.response.statusCode, 303);
  assert.equal(harness.stripe.calls.length, 2);
  assert.equal(harness.store.fulfillmentCasWinners, 1);
  assert.equal(seeded.activation.accountId, "account-owner");
  assert.equal(seeded.activation.licenseActive, true);
  assert.equal(seeded.activation.status, "paid");
});

test("OAuth start and callback collapse every unsafe next path to the account route", async (t) => {
  const harness = createApiContractHarness();
  const start = await loadAccountHandler("../api/auth/google/start.ts", harness);
  const callback = await loadAccountHandler("../api/auth/google/callback.ts", harness);
  const rejected = [
    ["absolute URL", "https://attacker.example/path"],
    ["scheme-relative URL", "//attacker.example/path"],
    ["raw backslash", "/\\attacker.example/path"],
    ["encoded backslash", "/%5Cattacker.example/path"],
    ["CRLF", "/account.html%0D%0AX-Injected:yes"],
    ["double encoding", "%2F%2Fattacker.example/path"],
    ["unrelated route", "/api/checkout/start"],
  ];

  for (const [label, nextPath] of rejected) {
    await t.test(`rejects ${label}`, async () => {
      const startResult = await invokeHandler(start, {
        method: "GET",
        url: `/api/auth/google/start?next=${encodeURIComponent(nextPath)}`,
      });
      assert.equal(startResult.response.statusCode, 302);
      assert.equal(harness.oauth.nextPath, "/account.html");

      const callbackResult = await invokeHandler(callback, {
        method: "GET",
        url: `/api/auth/google/callback?state=${encodeURIComponent(harness.oauth.state)}&code=valid`,
      });
      assert.equal(callbackResult.response.statusCode, 303);
      assert.equal(callbackResult.response.getHeader("location"), "/account.html");
    });
  }

  const allowedPath = "/api/activation/claim?activation=activation-safe";
  await invokeHandler(start, {
    method: "GET",
    url: `/api/auth/google/start?next=${encodeURIComponent(allowedPath)}`,
  });
  assert.equal(harness.oauth.nextPath, allowedPath);
  const allowedCallback = await invokeHandler(callback, {
    method: "GET",
    url: `/api/auth/google/callback?state=${encodeURIComponent(harness.oauth.state)}&code=valid`,
  });
  assert.equal(allowedCallback.response.getHeader("location"), allowedPath);
});

async function loadAccountHandler(relativePath, harness) {
  return loadInjectedHandler(new URL(relativePath, import.meta.url), {
    "../_lib/account.js": harness.dependencies,
    "../../_lib/account.js": harness.dependencies,
  });
}

async function invokeCheckoutComplete(handler, sessionId, activationKey) {
  const params = new URLSearchParams({ session_id: sessionId, activation: activationKey });
  return invokeHandler(handler, {
    method: "GET",
    url: `/api/checkout/complete?${params.toString()}`,
  });
}

function restoreForm(activationKey, csrfToken) {
  return new URLSearchParams({
    activation: activationKey,
    csrf: csrfToken,
    intent: "restore",
  }).toString();
}

function extractCsrfToken(html) {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  assert.ok(match, "restore GET should render an HMAC CSRF token");
  return match[1];
}

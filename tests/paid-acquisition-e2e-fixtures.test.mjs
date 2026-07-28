import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  PAID_ACQUISITION_CONTROL_COHORT,
  PAID_ACQUISITION_COOKIE_NAME,
  PAID_ACQUISITION_PAID_COHORT,
  PaidAcquisitionError,
  bindPaidAcquisitionCheckoutIntent,
  createPaidAcquisitionEntryContext,
  createPaidAcquisitionReceipt,
  normalizePaidAcquisitionVerifiedEmail,
  resolvePaidAcquisitionCheckoutCompletion,
  resolvePaidAcquisitionCheckoutStart,
  validatePaidAcquisitionAssignmentCookie,
  validatePaidAcquisitionCheckoutEntry,
} from "../api/_lib/paid-acquisition.ts";
import {
  planOneTimeEntitlementTransition,
  shouldApplyStripeEventWatermark,
  verifyPaidCheckoutSession,
} from "../api/_lib/entitlement.ts";
import {
  PaidInstallerEmailDeliveryError,
  createPaidInstallerEmailJob,
  sendPaidInstallerEmail,
} from "../api/_lib/paid-installer-email.ts";
import {
  getPaidArtifactPathname,
  readPaidReleaseManifest,
  resolvePaidReleasePlatform,
} from "../api/_lib/paid-release-manifest.ts";

const REPO_ROOT = process.cwd();
const SECRET = "fixture-only-secret-with-at-least-thirty-two-bytes";
const NOW_SECONDS = 1_785_139_200;
const NOW_MS = NOW_SECONDS * 1_000;
const ENTRY_TOKEN_BYTES = Buffer.alloc(32, 9);
const CHECKOUT_INTENT_REF = "10000000-0000-4000-8000-000000000001";
const IDEMPOTENCY_KEY = "20000000-0000-4000-8000-000000000002";
const CHECKOUT_SESSION_REF = "cs_test_paid_acquisition_e2e";
const PAYMENT_REF = "pi_test_paid_acquisition_e2e";
const CHECKOUT_EMAIL = "buyer+mc@example.com";
const RECEIPT = createPaidAcquisitionReceipt({
  environment: "test",
  verifiedCheckoutSessionRef: CHECKOUT_SESSION_REF,
  secret: SECRET,
});
const CONTROL_DESTINATION =
  "https://sidestream.tv/?utm_source=manychat";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/138.0 Safari/537.36";

let fixtureDirectory;
let middleware;
let checkoutHandler;
let checkoutAccountStub;
let checkoutPaidStub;
let claimHandler;
let claimAccountStub;
let claimPaidStub;
let databasePaidAcquisition;
let databaseStub;

before(async () => {
  fixtureDirectory = await mkdtemp(
    path.join(os.tmpdir(), "sidestream-paid-acquisition-e2e-"),
  );
  await writeFile(
    path.join(fixtureDirectory, "package.json"),
    '{"type":"module"}\n',
    "utf8",
  );
  middleware = await loadMiddleware();
  await buildHandlerFixtures();
  ({ default: checkoutHandler } = await import(
    pathToFileURL(path.join(fixtureDirectory, "checkout.ts")).href
  ));
  checkoutAccountStub = await import(
    pathToFileURL(
      path.join(fixtureDirectory, "checkout-account-stub.mjs"),
    ).href
  );
  checkoutPaidStub = await import(
    pathToFileURL(
      path.join(fixtureDirectory, "checkout-paid-stub.mjs"),
    ).href
  );
  ({ default: claimHandler } = await import(
    pathToFileURL(path.join(fixtureDirectory, "claim.ts")).href
  ));
  claimAccountStub = await import(
    pathToFileURL(
      path.join(fixtureDirectory, "claim-account-stub.mjs"),
    ).href
  );
  claimPaidStub = await import(
    pathToFileURL(path.join(fixtureDirectory, "claim-paid-stub.mjs")).href
  );
  databasePaidAcquisition = await import(
    pathToFileURL(path.join(fixtureDirectory, "paid-acquisition.ts")).href
  );
  databaseStub = await import(
    pathToFileURL(path.join(fixtureDirectory, "postgres.js")).href
  );
});

after(async () => {
  delete process.env.SIDESTREAM_PAID_ACQUISITION_RECEIPT_SECRET;
  delete process.env.SIDESTREAM_PAID_ACQUISITION_EMAIL_ENABLED;
  delete process.env.SIDESTREAM_TEST_POSTGRES_URL;
  if (fixtureDirectory) {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test("fixture router covers exact sticky mobile assignment and every safe fallback", async () => {
  const controlNonce = nonceForCohort(PAID_ACQUISITION_CONTROL_COHORT);
  const paidNonce = nonceForCohort(PAID_ACQUISITION_PAID_COHORT);

  assert.equal(middleware.cohortForBucket(0), PAID_ACQUISITION_CONTROL_COHORT);
  assert.equal(
    middleware.cohortForBucket(4_999),
    PAID_ACQUISITION_CONTROL_COHORT,
  );
  assert.equal(
    middleware.cohortForBucket(5_000),
    PAID_ACQUISITION_PAID_COHORT,
  );
  assert.equal(
    middleware.cohortForBucket(9_999),
    PAID_ACQUISITION_PAID_COHORT,
  );

  const control = await route(request("/mc"), { nonceBytes: controlNonce });
  assert.equal(control.status, 307);
  assert.equal(control.headers.get("location"), CONTROL_DESTINATION);
  const controlCookie = cookiePair(control);
  assert.ok(controlCookie);

  const stickyControl = await route(
    request("/mc?utm_campaign=changed", { cookie: controlCookie }),
    { nonceBytes: paidNonce },
  );
  assert.equal(stickyControl.status, 307);
  assert.match(
    stickyControl.headers.get("location"),
    /^https:\/\/sidestream\.tv\/\?utm_source=manychat/,
  );
  assert.equal(stickyControl.headers.has("set-cookie"), false);

  const paid = await route(request("/mc"), { nonceBytes: paidNonce });
  assert.equal(paid.status, 200);
  assert.match(
    paid.headers.get("x-test-rewrite"),
    /mobile-paid-prototype\.html\?utm_source=manychat$/,
  );
  const paidCookie = cookiePair(paid);
  assert.ok(paidCookie);

  const stickyPaid = await route(
    request("/mc?utm_medium=dm", { cookie: paidCookie }),
    { nonceBytes: controlNonce },
  );
  assert.equal(stickyPaid.status, 200);
  assert.match(
    stickyPaid.headers.get("x-test-rewrite"),
    /utm_source=manychat&utm_medium=dm$/,
  );
  assert.equal(stickyPaid.headers.has("set-cookie"), false);

  const invalidCookie = await route(
    request("/mc", {
      cookie: `${PAID_ACQUISITION_COOKIE_NAME}=forged.invalid.cookie`,
    }),
    { nonceBytes: paidNonce },
  );
  assert.equal(invalidCookie.status, 200);
  assert.ok(invalidCookie.headers.has("set-cookie"));

  const ineligible = [
    ["desktop", { userAgent: DESKTOP_UA }],
    ["bot", { userAgent: `${IPHONE_UA} Googlebot` }],
    ["scanner", { userAgent: `${IPHONE_UA} facebookexternalhit` }],
    ["prefetch", { headers: { purpose: "prefetch" } }],
    ["missing navigation evidence", { fetchDest: null }],
  ];
  for (const [label, options] of ineligible) {
    const response = await route(request("/mc", options), {
      nonceBytes: paidNonce,
    });
    assert.equal(response.status, 307, label);
    assert.equal(response.headers.get("location"), CONTROL_DESTINATION, label);
    assert.equal(response.headers.has("set-cookie"), false, label);
  }

  const head = await route(request("/mc", { method: "HEAD" }), {
    nonceBytes: paidNonce,
  });
  assert.equal(head.status, 307);
  assert.equal(head.headers.get("location"), CONTROL_DESTINATION);
  assert.equal(head.headers.has("set-cookie"), false);

  const missingSecret = await route(request("/mc"), {
    nonceBytes: paidNonce,
    secret: "",
  });
  assert.equal(missingSecret.status, 307);
  assert.equal(missingSecret.headers.get("location"), CONTROL_DESTINATION);
  assert.equal(missingSecret.headers.has("set-cookie"), false);

  const vercel = JSON.parse(
    await readFile(path.join(REPO_ROOT, "vercel.json"), "utf8"),
  );
  assert.deepEqual(
    vercel.redirects.find((redirect) => redirect.source === "/m"),
    {
      source: "/m",
      destination: CONTROL_DESTINATION,
      permanent: false,
    },
  );
  const preservedM = await route(request("/m"), { nonceBytes: paidNonce });
  assert.equal(preservedM.headers.get("x-test-next"), "1");
  assert.equal(preservedM.headers.has("set-cookie"), false);
});

test("fixture purchase connects sticky paid entry to idempotent verified $24.99 fulfillment", async () => {
  const paidResponse = await route(request("/mc?utm_medium=dm"), {
    nonceBytes: nonceForCohort(PAID_ACQUISITION_PAID_COHORT),
  });
  const assignmentCookieValue = cookiePair(paidResponse)
    .slice(PAID_ACQUISITION_COOKIE_NAME.length + 1);
  const assignment = validatePaidAcquisitionAssignmentCookie(
    assignmentCookieValue,
    { secret: SECRET, now: NOW_SECONDS },
  );
  assert.equal(assignment.cohort, PAID_ACQUISITION_PAID_COHORT);

  const issuedEntry = createPaidAcquisitionEntryContext({
    assignmentCookieValue,
    assignmentSecret: SECRET,
    environment: "test",
    attribution: { utmMedium: "dm" },
    now: NOW_SECONDS,
    randomBytes: () => ENTRY_TOKEN_BYTES,
  });
  const validatedEntry = validatePaidAcquisitionCheckoutEntry({
    entryToken: issuedEntry.entryToken,
    persistedContext: issuedEntry.context,
    assignmentCookieValue,
    assignmentSecret: SECRET,
    trustedEnvironment: "test",
    now: NOW_SECONDS + 30,
  });
  const intent = bindPaidAcquisitionCheckoutIntent({
    validatedEntry,
    checkoutIntentRef: CHECKOUT_INTENT_REF,
    idempotencyKey: IDEMPOTENCY_KEY,
    createdAt: NOW_SECONDS + 31,
  });
  const firstStart = resolvePaidAcquisitionCheckoutStart({
    existingIntent: null,
    proposedIntent: intent,
  });
  assert.deepEqual(
    { action: firstStart.action, reused: firstStart.reused },
    { action: "create", reused: false },
  );
  const replay = resolvePaidAcquisitionCheckoutStart({
    existingIntent: firstStart.intent,
    proposedIntent: bindPaidAcquisitionCheckoutIntent({
      validatedEntry,
      checkoutIntentRef: "30000000-0000-4000-8000-000000000003",
      idempotencyKey: IDEMPOTENCY_KEY,
      createdAt: NOW_SECONDS + 90,
    }),
  });
  assert.deepEqual(
    { action: replay.action, reused: replay.reused },
    { action: "reuse", reused: true },
  );

  const serverRetrievedCheckout = checkoutSessionFixture();
  assert.deepEqual(
    verifyPaidCheckoutSession(serverRetrievedCheckout, {
      sessionId: CHECKOUT_SESSION_REF,
      priceId: "price_test_sidestream_pro_2499",
      productId: "prod_test_sidestream_pro",
      paidPlanKeys: ["sidestream_pro"],
    }),
    { ok: true },
  );
  assert.equal(serverRetrievedCheckout.amount_total, 2499);
  assert.equal(serverRetrievedCheckout.currency, "usd");
  assert.equal(serverRetrievedCheckout.payment_status, "paid");
  assert.equal(serverRetrievedCheckout.payment_intent, PAYMENT_REF);

  const completion = resolvePaidAcquisitionCheckoutCompletion({
    intent,
    verifiedCheckoutSessionRef: serverRetrievedCheckout.id,
    canonicalPaymentRef: serverRetrievedCheckout.payment_intent,
    verifiedCheckoutEmail: serverRetrievedCheckout.customer_details.email,
    completedAt: NOW_SECONDS + 120,
  });
  assert.equal(completion.completion.checkoutEmailNormalized, CHECKOUT_EMAIL);
  assert.equal(
    resolvePaidAcquisitionCheckoutCompletion({
      intent,
      verifiedCheckoutSessionRef: CHECKOUT_SESSION_REF,
      canonicalPaymentRef: PAYMENT_REF,
      verifiedCheckoutEmail: CHECKOUT_EMAIL,
      existingCompletion: completion.completion,
      completedAt: NOW_SECONDS + 300,
    }).reused,
    true,
  );

  databaseStub.reset({
    checkoutRows: [checkoutDatabaseRow(intent)],
  });
  process.env.SIDESTREAM_PAID_ACQUISITION_RECEIPT_SECRET = SECRET;
  process.env.SIDESTREAM_PAID_ACQUISITION_EMAIL_ENABLED = "0";
  process.env.SIDESTREAM_TEST_POSTGRES_URL =
    "postgresql://fixture.invalid/sidestream_fixture";
  const fulfilled = await databasePaidAcquisition
    .completePaidAcquisitionCheckout({
      environment: "test",
      verifiedCheckoutSessionRef: CHECKOUT_SESSION_REF,
      canonicalPaymentRef: PAYMENT_REF,
      verifiedCheckoutEmail: CHECKOUT_EMAIL,
      verifiedProductRef: "prod_test_sidestream_pro",
      verifiedPriceRef: "price_test_sidestream_pro_2499",
      verifiedQuantity: 1,
      verifiedOriginalAmountMinor: 2499,
      verifiedDiscountAmountMinor: 2499,
      verifiedAmountMinor: 0,
      verifiedCurrency: "usd",
    });
  assert.equal(fulfilled.matched, true);
  assert.match(fulfilled.receipt, /^[A-Za-z0-9_-]{43}$/);

  await assert.rejects(
    databasePaidAcquisition.completePaidAcquisitionCheckout({
      environment: "test",
      verifiedCheckoutSessionRef: CHECKOUT_SESSION_REF,
      canonicalPaymentRef: PAYMENT_REF,
      verifiedCheckoutEmail: CHECKOUT_EMAIL,
      verifiedProductRef: "prod_test_sidestream_pro",
      verifiedPriceRef: "price_test_sidestream_pro_2499",
      verifiedQuantity: 1,
      verifiedOriginalAmountMinor: 2499,
      verifiedDiscountAmountMinor: 500,
      verifiedAmountMinor: 998,
      verifiedCurrency: "usd",
    }),
    (error) =>
      error instanceof databasePaidAcquisition.PaidAcquisitionError &&
      error.code === "checkout_conflict",
  );

  const emailJob = createPaidInstallerEmailJob({
    checkout: {
      environment: "test",
      verifiedCheckoutSessionId: CHECKOUT_SESSION_REF,
      verifiedCheckoutEmail: completion.completion.checkoutEmailNormalized,
      paymentStatus: "paid",
    },
    onboardingReceipt: fulfilled.receipt,
  });
  assert.deepEqual(emailJob.message.to, [CHECKOUT_EMAIL]);
  assert.match(emailJob.message.html, /same Google email used at Checkout/i);
  assert.match(emailJob.message.text, /platform=macos-universal/);
  assert.match(emailJob.message.text, /platform=windows-x64/);

  for (const platform of ["macos-universal", "windows-x64"]) {
    assert.equal(resolvePaidReleasePlatform(platform), platform);
    const manifest = readPaidReleaseManifest(platform);
    assert.equal(manifest.platform, platform);
    assert.match(
      getPaidArtifactPathname(manifest),
      new RegExp(
        `^sidestream/.+\\.${
          platform === "windows-x64" ? "exe" : "dmg"
        }$`,
      ),
    );
  }
  assert.equal(resolvePaidReleasePlatform("macos"), null);

  assert.equal(
    normalizePaidAcquisitionVerifiedEmail(" Buyer+MC@EXAMPLE.com "),
    completion.completion.checkoutEmailNormalized,
  );
  assert.notEqual(
    normalizePaidAcquisitionVerifiedEmail("other@example.com"),
    completion.completion.checkoutEmailNormalized,
  );
});

test("fixture handlers cover pending, delayed webhook replay, identity, lifecycle, expiry, and failures", async () => {
  claimAccountStub.reset();
  claimPaidStub.reset();

  let response = await invokeClaim();
  assertOutcome(response, 409, "payment_pending");

  claimPaidStub.state.receiptState = activeReceiptState();
  claimAccountStub.state.fulfillment = {
    fulfilled: false,
    reason: "checkout_incomplete",
  };
  response = await invokeClaim();
  assertOutcome(response, 409, "payment_pending");

  claimAccountStub.state.fulfillment = { fulfilled: true };
  claimAccountStub.state.activation = { claimed: true };
  claimPaidStub.state.claimOutcome = "claimed";
  response = await invokeClaim();
  assertOutcome(response, 200, "claimed");
  const replay = await invokeClaim();
  assertOutcome(replay, 200, "claimed");

  claimAccountStub.state.session = {
    accountId: "account-fixture",
    email: "different@example.com",
  };
  const claimCallsBeforeMismatch = claimPaidStub.state.claimCalls;
  response = await invokeClaim();
  assertOutcome(response, 409, "email_mismatch");
  assert.equal(
    claimPaidStub.state.claimCalls,
    claimCallsBeforeMismatch + 1,
  );

  claimAccountStub.state.session = {
    accountId: "other-account-fixture",
    email: CHECKOUT_EMAIL,
  };
  claimAccountStub.state.activation = {
    claimed: false,
    reason: "account_conflict",
  };
  response = await invokeClaim();
  assertOutcome(response, 409, "already_claimed");

  claimAccountStub.state.activation = { claimed: true };
  claimPaidStub.state.receiptState = {
    ...activeReceiptState(),
    payment_state: "refunded",
  };
  response = await invokeClaim();
  assertOutcome(response, 403, "refunded");

  claimPaidStub.state.receiptState = {
    ...activeReceiptState(),
    payment_state: "disputed",
  };
  response = await invokeClaim();
  assertOutcome(response, 403, "disputed");

  claimPaidStub.state.receiptState = {
    ...activeReceiptState(),
    receipt_expires_at: "2000-01-01T00:00:00.000Z",
  };
  response = await invokeClaim();
  assertOutcome(response, 410, "activation_expired");

  claimPaidStub.state.receiptState = activeReceiptState();
  claimAccountStub.state.fulfillmentError = new Error("provider unavailable");
  response = await invokeClaim();
  assertOutcome(response, 503, "temporarily_unavailable");

  claimAccountStub.state.fulfillmentError = null;
  claimPaidStub.state.databaseError = new Error("database unavailable");
  response = await invokeClaim();
  assertOutcome(response, 503, "temporarily_unavailable");

  checkoutAccountStub.reset();
  checkoutPaidStub.reset({ loadError: new Error("database unavailable") });
  response = await invokeCheckout();
  assertJsonOutcome(response, 503, "temporarily_unavailable");

  checkoutPaidStub.reset();
  checkoutAccountStub.reset({
    checkout: { ok: false, code: "provider_unavailable" },
  });
  response = await invokeCheckout();
  assertJsonOutcome(response, 503, "temporarily_unavailable");

  const stored = storedEntitlementState();
  const paidFacts = paymentFacts();
  const refund = planOneTimeEntitlementTransition({
    stored,
    facts: { ...paidFacts, amountRefunded: 2499 },
    event: { createdAtMs: 200, eventId: "evt_refund" },
  });
  assert.deepEqual(
    {
      entitlementStatus: refund.entitlementStatus,
      statusReason: refund.statusReason,
      revokeCredentials: refund.revokeCredentials,
    },
    {
      entitlementStatus: "revoked",
      statusReason: "full_refund",
      revokeCredentials: true,
    },
  );

  const dispute = planOneTimeEntitlementTransition({
    stored,
    facts: { ...paidFacts, disputeStatus: "needs_response" },
    event: { createdAtMs: 201, eventId: "evt_dispute" },
  });
  assert.equal(dispute.entitlementStatus, "suspended");
  assert.equal(dispute.statusReason, "dispute_open");
  assert.equal(dispute.revokeCredentials, true);
  assert.equal(
    shouldApplyStripeEventWatermark(
      { createdAtMs: 201, eventId: "evt_dispute" },
      { createdAtMs: 200, eventId: "evt_stale" },
    ),
    false,
  );
});

test("fixture email provider failures stay retryable and never contact a provider", async () => {
  const job = createPaidInstallerEmailJob({
    checkout: {
      environment: "test",
      verifiedCheckoutSessionId: CHECKOUT_SESSION_REF,
      verifiedCheckoutEmail: CHECKOUT_EMAIL,
      paymentStatus: "paid",
    },
    onboardingReceipt: RECEIPT,
  });
  let fixtureFetchCalls = 0;
  await assert.rejects(
    sendPaidInstallerEmail({
      job,
      environment: { RESEND_API_KEY: "fixture-not-a-live-key" },
      fetchImpl: async () => {
        fixtureFetchCalls += 1;
        throw new Error("fixture provider unavailable");
      },
    }),
    (error) => {
      assert.ok(error instanceof PaidInstallerEmailDeliveryError);
      assert.equal(error.retryable, true);
      assert.equal(error.providerStatus, null);
      assert.doesNotMatch(error.message, new RegExp(CHECKOUT_EMAIL));
      return true;
    },
  );
  assert.equal(fixtureFetchCalls, 1);
});

async function loadMiddleware() {
  const source = await readFile(path.join(REPO_ROOT, "middleware.ts"), "utf8");
  const helperSource = `
    export function next() {
      return new Response(null, { headers: { "x-test-next": "1" } });
    }
    export function rewrite(url, init = {}) {
      const response = new Response(null, {
        headers: { "x-test-rewrite": String(url) },
      });
      for (const [name, value] of init.request?.headers || []) {
        response.headers.set("x-rewrite-" + name, value);
      }
      return response;
    }
  `;
  const helperUrl =
    `data:text/javascript;base64,${Buffer.from(helperSource).toString("base64")}`;
  const importable = source.replace(
    'from "@vercel/functions"',
    `from "${helperUrl}"`,
  );
  return import(
    `data:text/javascript;base64,${Buffer.from(importable).toString("base64")}`
  );
}

async function buildHandlerFixtures() {
  const paidModuleUrl = pathToFileURL(
    path.join(REPO_ROOT, "api", "_lib", "paid-acquisition.ts"),
  ).href;
  const checkoutSource = (
    await readFile(
      path.join(REPO_ROOT, "api", "paid-acquisition", "checkout.ts"),
      "utf8",
    )
  )
    .replace("../_lib/account.js", "./checkout-account-stub.mjs")
    .replace("../_lib/paid-acquisition.js", "./checkout-paid-stub.mjs")
    .replace("../_lib/rate-limit.js", "./rate-limit-stub.mjs");
  const claimSource = (
    await readFile(
      path.join(REPO_ROOT, "api", "paid-acquisition", "claim.ts"),
      "utf8",
    )
  )
    .replace("../_lib/account.js", "./claim-account-stub.mjs")
    .replace("../_lib/paid-acquisition.js", "./claim-paid-stub.mjs");
  const paidAcquisitionSource = await readFile(
    path.join(REPO_ROOT, "api", "_lib", "paid-acquisition.ts"),
    "utf8",
  );

  await Promise.all([
    writeFile(
      path.join(fixtureDirectory, "checkout.ts"),
      checkoutSource,
      "utf8",
    ),
    writeFile(path.join(fixtureDirectory, "claim.ts"), claimSource, "utf8"),
    writeFile(
      path.join(fixtureDirectory, "paid-acquisition.ts"),
      paidAcquisitionSource,
      "utf8",
    ),
    writeFile(
      path.join(fixtureDirectory, "checkout-account-stub.mjs"),
      checkoutAccountStubSource(),
      "utf8",
    ),
    writeFile(
      path.join(fixtureDirectory, "checkout-paid-stub.mjs"),
      checkoutPaidStubSource(),
      "utf8",
    ),
    writeFile(
      path.join(fixtureDirectory, "claim-account-stub.mjs"),
      claimAccountStubSource(),
      "utf8",
    ),
    writeFile(
      path.join(fixtureDirectory, "claim-paid-stub.mjs"),
      claimPaidStubSource(paidModuleUrl),
      "utf8",
    ),
    writeFile(
      path.join(fixtureDirectory, "rate-limit-stub.mjs"),
      `
        export async function consumeRateLimit() {
          return { allowed: true, remaining: 1, resetAt: 0 };
        }
        export function applyRateLimitHeaders() {}
      `,
      "utf8",
    ),
    writeFile(
      path.join(fixtureDirectory, "postgres.js"),
      postgresStubSource(),
      "utf8",
    ),
  ]);
}

function checkoutAccountStubSource() {
  return `
    const defaults = {
      body: JSON.stringify({
        schemaVersion: 1,
        entryToken: "${"a".repeat(43)}",
        idempotencyKey: "${IDEMPOTENCY_KEY}",
      }),
      environment: { namespace: "test" },
      confirmation: {
        intentId: "${CHECKOUT_INTENT_REF}",
        browserToken: "fixture-browser-token",
        intentExpiresAt: "2099-01-01T00:00:00.000Z",
      },
      checkout: {
        ok: true,
        url: "https://checkout.stripe.test/session",
        reused: false,
      },
    };
    export const state = { ...defaults };
    export function reset(overrides = {}) {
      Object.assign(state, defaults, overrides);
    }
    export async function createCheckoutIntentConfirmation() {
      return state.confirmation;
    }
    export async function createOrReuseCheckoutSession() {
      if (state.providerError) throw state.providerError;
      return state.checkout;
    }
    export function getBaseUrl() { return "https://sidestream.tv"; }
    export function getClientIp() { return "fixture-client"; }
    export function methodNotAllowed(response, allow) {
      response.statusCode = 405;
      response.setHeader("Allow", allow);
      response.end();
    }
    export async function readRequestBody() { return state.body; }
    export function resolveRequestLicenseEnvironment() {
      return state.environment;
    }
    export function validateSameOriginJsonMutation() { return true; }
  `;
}

function checkoutPaidStubSource() {
  return `
    export const PAID_ACQUISITION_COOKIE_NAME =
      "${PAID_ACQUISITION_COOKIE_NAME}";
    export class PaidAcquisitionError extends Error {
      constructor(code) {
        super(code);
        this.code = code;
      }
    }
    const defaults = {
      loadError: null,
      replay: null,
      entry: { entryTokenHash: "${"b".repeat(64)}" },
    };
    export const state = { ...defaults };
    export function reset(overrides = {}) {
      Object.assign(state, defaults, overrides);
    }
    export async function loadPaidAcquisitionEntry() {
      if (state.loadError) throw state.loadError;
      return { id: "entry-fixture", context: {} };
    }
    export function validatePaidAcquisitionCheckoutEntry() {
      return state.entry;
    }
    export function bindPaidAcquisitionCheckoutIntent(options) {
      return {
        checkoutIntentRef: options.checkoutIntentRef,
        idempotencyKey: options.idempotencyKey,
      };
    }
    export async function findPaidAcquisitionCheckoutReplay() {
      return state.replay;
    }
    export async function persistPaidAcquisitionCheckoutIntent() {
      if (state.persistError) throw state.persistError;
    }
    export async function attachPaidAcquisitionCheckoutSession() {
      if (state.attachError) throw state.attachError;
    }
  `;
}

function claimAccountStubSource() {
  return `
    const defaults = {
      session: {
        accountId: "account-fixture",
        email: "${CHECKOUT_EMAIL}",
      },
      fulfillment: { fulfilled: true },
      fulfillmentError: null,
      activation: { claimed: true },
    };
    export const state = { ...defaults };
    export function reset(overrides = {}) {
      Object.assign(state, defaults, overrides);
    }
    export async function claimActivationToAccount() {
      return state.activation;
    }
    export function cleanString(value, maximum) {
      return typeof value === "string" ? value.slice(0, maximum) : "";
    }
    export async function fulfillCheckoutSession() {
      if (state.fulfillmentError) throw state.fulfillmentError;
      return state.fulfillment;
    }
    export function getBaseUrl() { return "https://sidestream.tv"; }
    export async function getSession() { return state.session; }
    export function methodNotAllowed(response, allow) {
      response.statusCode = 405;
      response.setHeader("Allow", allow);
      response.end();
    }
    export function redirect(response, location, statusCode) {
      response.statusCode = statusCode;
      response.setHeader("Location", location);
      response.end();
    }
    export function resolveRequestLicenseEnvironment() {
      return { namespace: "test" };
    }
  `;
}

function claimPaidStubSource(paidModuleUrl) {
  return `
    import {
      PaidAcquisitionError,
      normalizePaidAcquisitionVerifiedEmail,
    } from ${JSON.stringify(paidModuleUrl)};
    export { PaidAcquisitionError, normalizePaidAcquisitionVerifiedEmail };
    export const PAID_ACQUISITION_RECEIPT_COOKIE =
      "__Host-sidestream-paid-acquisition-receipt";
    const defaults = {
      receiptState: null,
      databaseError: null,
      claimOutcome: "claimed",
      claimCalls: 0,
    };
    export const state = { ...defaults };
    export function reset(overrides = {}) {
      Object.assign(state, defaults, overrides);
    }
    export function validatePaidAcquisitionReceiptCookie() {
      return "${RECEIPT}";
    }
    export async function getPaidAcquisitionReceiptState() {
      if (state.databaseError) throw state.databaseError;
      return state.receiptState;
    }
    export async function claimPaidAcquisitionActivation() {
      state.claimCalls += 1;
      return { outcome: state.claimOutcome };
    }
  `;
}

function postgresStubSource() {
  return `
    const defaults = {
      checkoutRows: [],
      claimRows: [],
      receiptRows: [],
      activationOutcomeRows: [],
      throwOnQuery: null,
    };
    export const state = { ...defaults };
    export function reset(overrides = {}) {
      Object.assign(state, defaults, overrides);
    }
    async function query(text) {
      if (state.throwOnQuery && !/^(begin|rollback)$/i.test(text.trim())) {
        throw state.throwOnQuery;
      }
      const sql = text.replace(/\\s+/g, " ").trim().toLowerCase();
      if (sql.includes("select paid.*, core.id as core_intent_id")) {
        return { rows: state.checkoutRows };
      }
      if (sql.includes("select claim.id, claim.account_ref")) {
        return { rows: state.claimRows };
      }
      if (sql.includes("select paid.id, paid.verified_checkout_session_ref")) {
        return { rows: state.receiptRows };
      }
      if (sql.includes("select claim.claim_state, paid.payment_state")) {
        return { rows: state.activationOutcomeRows };
      }
      if (
        sql.startsWith("update public.sidestream_paid_acquisition_checkouts") &&
        sql.includes("returning id")
      ) {
        return { rows: [{ id: "checkout-fixture" }] };
      }
      return { rows: [] };
    }
    const client = {
      query,
      release() {},
    };
    const pool = {
      query,
      async connect() { return client; },
    };
    export function getPostgresPool() { return pool; }
  `;
}

function request(pathname = "/mc", options = {}) {
  const headers = new Headers(options.headers);
  if (options.userAgent !== null) {
    headers.set("user-agent", options.userAgent ?? IPHONE_UA);
  }
  if (options.fetchDest !== null) {
    headers.set("sec-fetch-dest", options.fetchDest ?? "document");
  }
  if (options.cookie) headers.set("cookie", options.cookie);
  return new Request(`https://sidestream.tv${pathname}`, {
    method: options.method ?? "GET",
    headers,
  });
}

function route(input, options = {}) {
  return middleware.routePaidExperimentForTest(input, {
    secret: Object.hasOwn(options, "secret") ? options.secret : SECRET,
    nowMs: NOW_MS,
    nonceBytes: options.nonceBytes,
  });
}

function cookiePair(response) {
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

function nonceForCohort(cohort) {
  for (let value = 0; value < 10_000; value += 1) {
    const nonceBytes = new Uint8Array(16);
    new DataView(nonceBytes.buffer).setUint32(12, value);
    const nonce = Buffer.from(nonceBytes).toString("base64url");
    const digest = createHmac("sha256", SECRET)
      .update(`mc-mobile-paid-v1:${nonce}`)
      .digest();
    const bucket = Number(digest.readBigUInt64BE(0) % 10_000n);
    if (
      (cohort === PAID_ACQUISITION_CONTROL_COHORT && bucket < 5_000) ||
      (cohort === PAID_ACQUISITION_PAID_COHORT && bucket >= 5_000)
    ) {
      return nonceBytes;
    }
  }
  throw new Error(`No deterministic nonce for ${cohort}`);
}

function checkoutSessionFixture() {
  return {
    id: CHECKOUT_SESSION_REF,
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    payment_intent: PAYMENT_REF,
    amount_subtotal: 2499,
    amount_total: 2499,
    currency: "usd",
    total_details: {
      amount_discount: 0,
      amount_shipping: 0,
      amount_tax: 0,
    },
    customer_details: { email: " Buyer+MC@EXAMPLE.com " },
    metadata: {
      sidestream_plan: "sidestream_pro",
      sidestream_price_id: "price_test_sidestream_pro_2499",
      sidestream_paid_acquisition: "mc-mobile-paid-v1",
    },
    line_items: {
      has_more: false,
      data: [
        {
          quantity: 1,
          price: {
            id: "price_test_sidestream_pro_2499",
            product: "prod_test_sidestream_pro",
          },
        },
      ],
    },
  };
}

function checkoutDatabaseRow(intent) {
  return {
    id: "checkout-fixture",
    contract_version: intent.contractVersion,
    environment: intent.environment,
    experiment_id: intent.experimentId,
    cohort: intent.cohort,
    assignment_id_hash: intent.assignmentIdHash,
    entry_token_hash: intent.entryTokenHash,
    attribution_hash: intent.attributionHash,
    checkout_intent_ref: intent.checkoutIntentRef,
    idempotency_key: intent.idempotencyKey,
    request_fingerprint: intent.requestFingerprint,
    created_at: new Date(intent.createdAt * 1_000).toISOString(),
    utm_medium: intent.attribution.utmMedium,
    utm_campaign: intent.attribution.utmCampaign,
    utm_content: intent.attribution.utmContent,
    utm_id: intent.attribution.utmId,
    canonical_payment_ref: null,
  };
}

function activeReceiptState() {
  return {
    verified_checkout_session_ref: CHECKOUT_SESSION_REF,
    receipt_expires_at: "2099-01-01T00:00:00.000Z",
    payment_state: "active",
    entitlement_status: "active",
    checkout_email_normalized: CHECKOUT_EMAIL,
  };
}

function storedEntitlementState() {
  return {
    paymentIntentId: PAYMENT_REF,
    chargeId: "ch_test_paid_acquisition_e2e",
    customerId: "cus_test_paid_acquisition_e2e",
    entitlementStatus: "active",
    statusReason: "payment_paid",
    stripeEventCreatedAtMs: 100,
    stripeEventId: "evt_paid",
  };
}

function paymentFacts() {
  return {
    paymentIntentId: PAYMENT_REF,
    chargeId: "ch_test_paid_acquisition_e2e",
    customerId: "cus_test_paid_acquisition_e2e",
    amountPaid: 2499,
    amountRefunded: 0,
    currency: "usd",
    paymentProven: true,
    disputeStatus: "none",
  };
}

async function invokeCheckout() {
  const response = new FixtureResponse();
  await checkoutHandler(
    {
      method: "POST",
      url: "/api/paid-acquisition/checkout",
      headers: {
        cookie: `${PAID_ACQUISITION_COOKIE_NAME}=fixture-cookie`,
      },
    },
    response,
  );
  return response;
}

async function invokeClaim() {
  const response = new FixtureResponse();
  await claimHandler(
    {
      method: "GET",
      url: "/api/paid-acquisition/claim?activation=activation-fixture",
      headers: {
        cookie:
          "__Host-sidestream-paid-acquisition-receipt=fixture-signed-cookie",
      },
    },
    response,
  );
  return response;
}

function assertOutcome(response, statusCode, code) {
  assert.equal(response.statusCode, statusCode);
  assert.match(response.body, new RegExp(`data-code="${code}"`));
  assert.doesNotMatch(response.body, /buyer\+mc@example\.com|cs_test_/);
}

function assertJsonOutcome(response, statusCode, code) {
  assert.equal(response.statusCode, statusCode);
  assert.deepEqual(JSON.parse(response.body), { error: code, code });
}

class FixtureResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = new Map();
    this.body = "";
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), String(value));
  }

  end(body = "") {
    this.body = String(body);
  }
}

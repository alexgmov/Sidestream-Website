import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getCheckoutParametersFingerprint,
  isLegacyVercelHost,
  isZeroTotalCheckoutWithoutPaymentIntent,
  needsLegacyLicenseCompatibility,
  planUpgradePricingSubscriptionTransition,
  shouldApplyStripeEventWatermark,
} from "../api/_lib/entitlement.ts";
import {
  decideUpgradePricing,
  upgradePricingBucket,
} from "../api/_lib/upgrade-pricing-experiment.ts";
import { loadInjectedModule } from "./helpers/handler-loader.mjs";

const SECRET = "upgrade-pricing-integration-secret-000000000000000000";
const REPORT_SECRET = "upgrade-pricing-integration-report-secret";

const reportModule = await loadInjectedModule(
  new URL("../api/_lib/upgrade-pricing-report.ts", import.meta.url),
  { "./postgres.js": { withPostgresTransaction: async () => ({ rows: [] }) } },
);

test("the deterministic fixture is exactly balanced and account assignments stay sticky", () => {
  const fixture = [];
  const wantedPerVariant = 64;
  const counts = { control_one_time: 0, annual_same_price: 0 };
  for (let index = 0; counts.control_one_time < wantedPerVariant ||
    counts.annual_same_price < wantedPerVariant; index += 1) {
    const accountId = fixtureAccountId(index);
    const expectedVariant = upgradePricingBucket({ accountId, secret: SECRET }) < 5_000
      ? "annual_same_price"
      : "control_one_time";
    if (counts[expectedVariant] >= wantedPerVariant) continue;
    fixture.push({ accountId, expectedVariant });
    counts[expectedVariant] += 1;
  }

  const decisions = fixture.map(({ accountId, expectedVariant }) => {
    const decision = decideUpgradePricing({
      accountId,
      currency: "usd",
      oneTimeAmountMinor: 1999,
      enabled: true,
      rolloutBasisPoints: 5_000,
      secret: SECRET,
    });
    assert.equal(decision.variant, expectedVariant);
    return decision;
  });
  assert.deepEqual(countVariants(decisions), counts);
  assert.equal(fixture.length, 128);

  const annual = decisions.find((decision) => decision.variant === "annual_same_price");
  const persisted = {
    assignmentId: "20000000-0000-4000-8000-000000000001",
    assignmentVersion: 2,
    experimentId: "upgrade-pricing-v2",
    accountId: annual.accountId,
    variant: annual.variant,
    billingModel: annual.billingModel,
    bucket: annual.bucket,
    rolloutBasisPoints: annual.rolloutBasisPoints,
    assignedAt: "2026-08-22T00:00:00.000Z",
  };
  const retry = decideUpgradePricing({
    accountId: annual.accountId,
    currency: "usd",
    oneTimeAmountMinor: 1999,
    enabled: false,
    rolloutBasisPoints: 0,
    secret: SECRET,
    existingAssignment: persisted,
  });
  assert.equal(retry.variant, "annual_same_price");
  assert.equal(retry.assignmentId, persisted.assignmentId);
  assert.equal(retry.recurringAmountMinor, 1999);
  assert.equal(retry.usedExistingAssignment, true);
  assert.equal(retry.shouldPersistAssignment, false);
});

test("control fallback is observable but isolated from eligible annual assignment", () => {
  const accountId = fixtureAccountId(9_999);
  for (const [overrides, reason] of [
    [{ enabled: false, rolloutBasisPoints: 10_000, secret: SECRET }, "kill_switch"],
    [{ enabled: true, rolloutBasisPoints: 10_000, secret: "short" }, "assignment_unavailable"],
    [{ enabled: true, rolloutBasisPoints: 10_000, secret: SECRET, currency: "eur" }, "unsupported_currency"],
  ]) {
    const decision = decideUpgradePricing({
      accountId,
      currency: "usd",
      oneTimeAmountMinor: 1999,
      ...overrides,
    });
    assert.deepEqual({
      variant: decision.variant,
      billingModel: decision.billingModel,
      assignedVariant: decision.assignedVariant,
      recurringCohortEligible: decision.recurringCohortEligible,
      reason: decision.reason,
    }, {
      variant: "control_one_time",
      billingModel: "one_time",
      assignedVariant: null,
      recurringCohortEligible: false,
      reason,
    });
  }
});

test("Upgrade routing preserves auth, acquisition, restore, device, mobile, and legacy clients", async () => {
  const sources = await readSources([
    "api/checkout/start.ts",
    "api/_lib/account.ts",
    "api/auth/google/start.ts",
    "api/auth/google/callback.ts",
    "api/activation/claim.ts",
    "api/account/device.ts",
    "api/download.ts",
    "api/send-download-links.ts",
    "middleware.ts",
  ]);
  const checkout = sources["api/checkout/start.ts"];
  assert.ok(checkout.indexOf("resolveRequiredCheckoutAcquisition") < checkout.indexOf("getSession(request)"));
  assert.ok(checkout.indexOf("getSession(request)") < checkout.indexOf("createCheckoutIntent({"));
  assert.match(checkout, /\/api\/auth\/google\/start/);
  assert.match(checkout, /\/api\/activation\/claim/);
  assert.match(checkout, /isLegacyVercelHost\(request\.headers\.host\)/);
  assert.doesNotMatch(checkout, /searchParams\.get\("(?:variant|billing|amount|currency|price|product)/i);

  assert.match(sources["api/auth/google/start.ts"], /acquisitionCookieValue/);
  assert.match(sources["api/auth/google/callback.ts"], /completeGoogleAuthenticationAcquisition/);
  assert.match(sources["api/_lib/account.ts"], /stage:\s*"authentication_completed"/);
  assert.match(sources["api/_lib/account.ts"], /hasCanonicalActivePaidLicense/);
  assert.match(sources["api/activation/claim.ts"], /validateActivationClaimRequest/);
  assert.match(sources["api/account/device.ts"], /getAccountDeviceStatus/);
  assert.doesNotMatch(sources["api/download.ts"], /upgrade_pricing|monthly_half/);
  assert.doesNotMatch(sources["api/send-download-links.ts"], /upgrade_pricing|monthly_half/);
  assert.match(sources["middleware.ts"], /routeMetaAdLinkForTest/);
  assert.match(sources["middleware.ts"], /routePaidExperimentForTest/);

  assert.equal(isLegacyVercelHost("sidestream-xi.vercel.app"), true);
  assert.equal(needsLegacyLicenseCompatibility("1.0.11"), true);
  assert.equal(needsLegacyLicenseCompatibility("1.0.14"), false);
});

test("one-time and zero-total Checkout behavior is unchanged and snapshots affect idempotency", () => {
  const zeroTotal = {
    status: "complete",
    amount_total: 0,
    currency: "usd",
    payment_intent: null,
  };
  assert.equal(isZeroTotalCheckoutWithoutPaymentIntent({ ...zeroTotal, payment_status: "paid" }), true);
  assert.equal(isZeroTotalCheckoutWithoutPaymentIntent({
    ...zeroTotal,
    payment_status: "no_payment_required",
  }), true);
  assert.equal(isZeroTotalCheckoutWithoutPaymentIntent({ ...zeroTotal, payment_status: "unpaid" }), false);

  const base = {
    line_items: [{ price: "price_global_once", quantity: 1 }],
    metadata: {
      sidestream_acquisition_id: "30000000-0000-4000-8000-000000000001",
      sidestream_checkout_intent_id: "40000000-0000-4000-8000-000000000001",
    },
  };
  const control = getCheckoutParametersFingerprint({ ...base, mode: "payment" });
  const replay = getCheckoutParametersFingerprint({ mode: "payment", ...base });
  const monthly = getCheckoutParametersFingerprint({
    ...base,
    mode: "subscription",
    line_items: [{ price: "price_global_monthly", quantity: 1 }],
    metadata: { ...base.metadata, sidestream_upgrade_variant: "monthly_half" },
  });
  assert.equal(control, replay);
  assert.notEqual(control, monthly);
});

test("subscription fulfillment is duplicate-safe, reorder-safe, and preserves paid-through state", () => {
  const current = { createdAtMs: 5_000, eventId: "evt_current" };
  assert.equal(shouldApplyStripeEventWatermark(current, current), false);
  assert.equal(shouldApplyStripeEventWatermark(current, {
    createdAtMs: 4_999,
    eventId: "evt_old",
  }), false);
  assert.equal(shouldApplyStripeEventWatermark(current, {
    createdAtMs: 5_000,
    eventId: "evt_z",
  }), true);

  const canceling = planUpgradePricingSubscriptionTransition({
    status: "active",
    currentPeriodEndMs: 20_000,
    cancelAtPeriodEnd: true,
    invoicePaid: true,
    eventType: "customer.subscription.updated",
    eventCreatedAtMs: 10_000,
  });
  assert.deepEqual(canceling, {
    entitlementStatus: "active",
    statusReason: "subscription_cancel_at_period_end",
    revokeCredentials: false,
    graceUntilMs: 20_000,
  });
  const failed = planUpgradePricingSubscriptionTransition({
    status: "past_due",
    currentPeriodEndMs: 20_000,
    cancelAtPeriodEnd: false,
    invoicePaid: false,
    eventType: "invoice.payment_failed",
    eventCreatedAtMs: 10_000,
  });
  assert.equal(failed.entitlementStatus, "suspended");
  assert.equal(failed.revokeCredentials, true);
});

test("report metrics retain exact windows, denominators, currency, version, and privacy", () => {
  const cohort = [
    reportRow("control-paid", "account-control", "control_one_time", "usd", {
      oneTimePaidAt: "2026-08-01T00:05:00Z",
      oneTimeGrossMinor: 1999,
      entitlementActivated: true,
      activationCompletedAt: "2026-08-01T01:00:00Z",
      activationClientVersion: "1.0.11",
    }),
    reportRow("annual-paid", "account-annual", "annual_same_price", "usd", {
      subscriptionStatus: "active",
      subscriptionEntitlementStatus: "active",
      entitlementActivated: true,
    }),
    reportRow("annual-pending", "account-pending", "annual_same_price", "inr", {
      amountMinor: 25000,
      exposedAt: "2026-08-10T00:00:00Z",
      intentCreatedAt: "2026-08-10T00:00:00Z",
    }),
  ];
  const events = [
    invoiceEvent("evt-two", "annual-paid", "invoice-two", "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z"),
    invoiceEvent("evt-one", "annual-paid", "invoice-one", "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z"),
    invoiceEvent("evt-one", "annual-paid", "invoice-one", "2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z"),
  ];
  const report = reportModule.buildUpgradePricingReport(cohort, events, {
    namespace: "production",
    from: "2026-05-01T00:00:00Z",
    through: "2026-08-12T00:00:00Z",
    asOf: "2026-08-12T00:00:00Z",
    pageSize: 100,
    cursor: null,
    modeledLtv: null,
  }, REPORT_SECRET);
  const annualUsd = report.segments.find((row) =>
    row.variant === "annual_same_price" && row.currency === "usd");
  const annualInr = report.segments.find((row) => row.currency === "inr");
  assert.deepEqual(annualUsd.retention.paymentTwo, { numerator: 1, denominator: 1, rate: 1 });
  assert.equal(annualUsd.realizedMoney.grossMinor, "1998");
  assert.equal(annualInr.counts.mature24HourNonConverters, 1);
  assert.equal(annualInr.counts.mature7DayNonConverters, 0);
  assert.equal(report.currencyTotals.some((row) => row.currency === "all"), false);
  assert.deepEqual(report.clientVersionSegments, [{
    variant: "control_one_time",
    clientVersion: "1.0.11",
    exactLineageActivations: 1,
  }]);
  assert.doesNotMatch(JSON.stringify(report), /account-control|annual-paid|evt-one|invoice-one/i);
});

function fixtureAccountId(index) {
  return `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function countVariants(decisions) {
  return decisions.reduce((counts, decision) => {
    counts[decision.variant] += 1;
    return counts;
  }, { control_one_time: 0, annual_same_price: 0 });
}

async function readSources(paths) {
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [
    path,
    await readFile(new URL(`../${path}`, import.meta.url), "utf8"),
  ])));
}

function reportRow(intentId, accountId, variant, currency, overrides = {}) {
  const annual = variant === "annual_same_price";
  return {
    intentId,
    assignmentId: `assignment-${accountId}`,
    accountId,
    acquisitionId: `acquisition-${accountId}`,
    variant,
    billingModel: annual ? "subscription" : "one_time",
    country: currency === "inr" ? "IN" : "US",
    currency,
    amountMinor: annual ? 999 : 1999,
    assignedAt: "2026-06-01T00:00:00Z",
    intentCreatedAt: "2026-06-01T00:00:00Z",
    exposedAt: "2026-06-01T00:00:00Z",
    sessionStarted: true,
    sessionAttempt: 0,
    intentState: "open",
    oneTimePaidAt: null,
    oneTimeGrossMinor: 0,
    oneTimeRefundedMinor: 0,
    subscriptionStatus: null,
    subscriptionEntitlementStatus: null,
    cancelAtPeriodEnd: false,
    activationCompletedAt: null,
    activationClientVersion: null,
    entitlementActivated: false,
    assignmentSnapshotDefect: false,
    exposureLineageDefect: false,
    acquisitionLineageDefect: false,
    activationLineageDefect: false,
    ...overrides,
  };
}

function invoiceEvent(eventKey, intentId, objectKey, occurredAt, periodEnd) {
  return {
    eventKey,
    intentId,
    objectKey,
    eventType: "invoice.paid",
    occurredAt,
    amountMinor: 999,
    currency: "usd",
    status: "paid",
    billingReason: "subscription_cycle",
    periodEnd,
    cancelAtPeriodEnd: false,
  };
}

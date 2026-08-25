import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  buildLocalReportUrl,
  fetchCompleteUpgradePricingReport,
  parseUpgradePricingReportArguments,
} from "../scripts/report-upgrade-pricing-experiment.mjs";
import { loadInjectedModule } from "./helpers/handler-loader.mjs";

const reportModule = await loadInjectedModule(
  new URL("../api/_lib/upgrade-pricing-report.ts", import.meta.url),
  { "./postgres.js": { withPostgresTransaction: async () => ({ rows: [] }) } },
);
const customerAdminModule = await loadInjectedModule(
  new URL("../api/_lib/customer-admin.ts", import.meta.url),
  {},
);
const routeModule = await loadInjectedModule(
  new URL("../api/internal/upgrade-pricing-report.ts", import.meta.url),
  {
    "../_lib/customer-admin.js": customerAdminModule,
    "../_lib/upgrade-pricing-report.js": reportModule,
  },
);
const {
  buildUpgradePricingReport,
  parseUpgradePricingReportRequest,
  UpgradePricingReportValidationError,
} = reportModule;
const { createUpgradePricingReportHandler } = routeModule;

const SECRET = "upgrade-pricing-report-test-secret";
const WINDOW = Object.freeze({
  namespace: "production",
  from: "2026-07-01T00:00:00.000Z",
  through: "2026-08-12T00:00:00.000Z",
  asOf: "2026-08-12T00:00:00.000Z",
  pageSize: 100,
  cursor: null,
  modeledLtv: null,
});

test("request validation binds namespace, mature observation time, pagination, and explicit LTV assumptions", () => {
  const request = parseUpgradePricingReportRequest({
    namespace: "test",
    from: "2026-07-01T00:00:00Z",
    through: "2026-08-01T00:00:00Z",
    asOf: "2026-08-02T00:00:00Z",
    pageSize: 7,
    modeledLtv: {
      horizonMonths: 12,
      monthlyChurnRate: 0.05,
      feeRate: 0.029,
      refundRate: 0.03,
      fixedFeeMinorByCurrency: { usd: 30, inr: 200 },
    },
  }, new Date("2026-08-12T00:00:00Z"));
  assert.equal(request.experimentId, "upgrade-pricing-v2");
  assert.equal(request.namespace, "test");
  assert.equal(request.pageSize, 7);
  assert.equal(request.modeledLtv.monthlyChurnRate, 0.05);
  assert.equal(parseUpgradePricingReportRequest({
    experimentId: "upgrade-pricing-v1",
    namespace: "test",
  }, new Date("2026-08-12T00:00:00Z")).experimentId, "upgrade-pricing-v1");
  assert.match(
    reportModule.UPGRADE_PRICING_COHORT_SQL,
    /\$5 <> 'upgrade-pricing-v2' or intent\.upgrade_pricing_assignment_id is not null/,
  );
  assert.match(
    reportModule.UPGRADE_PRICING_EVENTS_SQL,
    /\$5 <> 'upgrade-pricing-v2' or intent\.upgrade_pricing_assignment_id is not null/,
  );
  assert.throws(
    () => parseUpgradePricingReportRequest({
      experimentId: "upgrade-pricing-v3",
      namespace: "test",
    }),
    (error) => error instanceof UpgradePricingReportValidationError &&
      error.code === "invalid_experiment",
  );
  assert.throws(
    () => parseUpgradePricingReportRequest({ namespace: "preview" }),
    (error) => error instanceof UpgradePricingReportValidationError &&
      error.code === "invalid_namespace",
  );
  assert.throws(
    () => parseUpgradePricingReportRequest({
      namespace: "test",
      modeledLtv: {
        horizonMonths: 12,
        monthlyChurnRate: 0.05,
        feeRate: 0.029,
        refundRate: 0.03,
      },
    }),
    /fixedFeeMinorByCurrency/,
  );
});

test("observed report dedupes event order, matures non-converters, isolates currency, and preserves exact denominators", () => {
  const report = buildUpgradePricingReport(cohort(), events(), WINDOW, SECRET);
  const controlUsd = segment(report, "control_one_time", "US", "usd");
  const monthlyUsd = segment(report, "annual_same_price", "US", "usd");
  const monthlyInr = segment(report, "annual_same_price", "IN", "inr");

  assert.deepEqual(controlUsd.activation, { numerator: 1, denominator: 2, rate: 0.5 });
  assert.equal(controlUsd.counts.uniqueEligibleAssigned, 2);
  assert.equal(controlUsd.counts.uniqueExposed, 2);
  assert.equal(controlUsd.counts.completedOneTimePurchases, 1);
  assert.equal(controlUsd.counts.pending, 1);
  assert.equal(controlUsd.counts.mature24HourNonConverters, 1);
  assert.equal(controlUsd.counts.mature7DayNonConverters, 1);
  assert.deepEqual(controlUsd.realizedMoney, {
    currency: "usd",
    grossMinor: "1999",
    refundsMinor: "100",
    creditsMinor: "0",
    netMinor: "1899",
    realizedRevenuePerExposed: 949.5,
    realizedRevenuePerExposedNumeratorMinor: "1899",
    realizedRevenuePerExposedDenominator: 2,
    mrrMinor: "0",
  });

  assert.equal(monthlyUsd.counts.firstSuccessfulSubscriptionPayments, 2);
  assert.equal(monthlyUsd.counts.secondInvoiceSuccess, 1);
  assert.equal(monthlyUsd.counts.thirdInvoiceSuccess, 1);
  assert.equal(monthlyUsd.counts.failedInvoices, 1);
  assert.equal(monthlyUsd.counts.recoveredInvoices, 1);
  assert.equal(monthlyUsd.counts.cancellationsBeforePaymentTwo, 1);
  assert.equal(monthlyUsd.counts.activeSubscribers, 1);
  assert.equal(monthlyUsd.counts.cancelAtPeriodEnd, 1);
  assert.deepEqual(monthlyUsd.retention.paymentTwo, {
    numerator: 1,
    denominator: 2,
    rate: 0.5,
  });
  assert.deepEqual(monthlyUsd.retention.paymentThree, {
    numerator: 1,
    denominator: 1,
    rate: 1,
  });
  assert.equal(monthlyUsd.realizedMoney.grossMinor, "3996");
  assert.equal(monthlyUsd.realizedMoney.refundsMinor, "50");
  assert.equal(monthlyUsd.realizedMoney.creditsMinor, "25");
  assert.equal(monthlyUsd.realizedMoney.netMinor, "3921");
  assert.equal(monthlyUsd.realizedMoney.mrrMinor, "83");

  assert.equal(monthlyInr.realizedMoney.currency, "inr");
  assert.equal(monthlyInr.realizedMoney.grossMinor, "0");
  assert.equal(monthlyInr.counts.mature24HourNonConverters, 1);
  assert.equal(monthlyInr.counts.mature7DayNonConverters, 0);
  assert.equal(report.currencyTotals.some((row) => row.currency === "all"), false);
  assert.equal(report.currencyTotals.find((row) =>
    row.currency === "usd" && row.variant === "annual_same_price").grossMinor, "3996");

  const allMonthly = report.allUpNonMoney.find((row) => row.variant === "annual_same_price");
  assert.deepEqual(allMonthly.activation, { numerator: 2, denominator: 4, rate: 0.5 });
  assert.equal(report.assignmentBalance.total, 6);
  assert.deepEqual(report.assignmentBalance.annualShare, {
    numerator: 4,
    denominator: 6,
    rate: 0.666667,
  });
  assert.ok(report.relativeLift.activation.some((row) =>
    row.country === "ALL" && row.currency === "all" &&
    row.annual.numerator === 2 && row.annual.denominator === 4 &&
    row.control.numerator === 1 && row.control.denominator === 2));
  assert.ok(report.relativeLift.realizedRevenuePerExposed.some((row) =>
    row.country === "US" && row.currency === "usd" &&
    row.annual.numeratorMinor === "3921" && row.annual.denominator === 2 &&
    row.control.numeratorMinor === "1899" && row.control.denominator === 2));

  assert.deepEqual(report.clientVersionSegments, [
    { variant: "control_one_time", clientVersion: "1.0.11", exactLineageActivations: 1 },
    { variant: "annual_same_price", clientVersion: "1.0.12", exactLineageActivations: 1 },
  ]);
});

test("signed keyset pages reject tampering and modeled scenarios stay explicitly separate from observed money", () => {
  const first = buildUpgradePricingReport(cohort(), events(), {
    ...WINDOW,
    pageSize: 1,
    modeledLtv: {
      horizonMonths: 12,
      monthlyChurnRate: 0.1,
      feeRate: 0.03,
      refundRate: 0.02,
      fixedFeeMinorByCurrency: { usd: 30, inr: 200 },
    },
  }, SECRET);
  assert.equal(first.segments.length, 1);
  assert.ok(first.pagination.nextCursor);
  assert.equal(first.mode, "observed");
  assert.ok(first.modeledLtvScenarios.every((row) => row.status === "modeled_not_observed"));
  assert.ok(first.modeledLtvScenarios.every((row) =>
    row.assumptions.priceMinor && row.assumptions.monthlySurvivalRate !== undefined &&
    row.assumptions.feeRate === 0.03 && row.assumptions.refundRate === 0.02));

  const second = buildUpgradePricingReport(cohort(), events(), {
    ...WINDOW,
    pageSize: 1,
    cursor: first.pagination.nextCursor,
    modeledLtv: first.modeledLtvScenarios.length ? {
      horizonMonths: 12,
      monthlyChurnRate: 0.1,
      feeRate: 0.03,
      refundRate: 0.02,
      fixedFeeMinorByCurrency: { usd: 30, inr: 200 },
    } : null,
  }, SECRET);
  assert.notDeepEqual(second.segments, first.segments);
  assert.throws(() => buildUpgradePricingReport(cohort(), events(), {
    ...WINDOW,
    pageSize: 1,
    cursor: `${first.pagination.nextCursor.slice(0, -1)}x`,
  }, SECRET), /Invalid report cursor/);
});

test("zero-total control is a completed entitlement and one-time refunds are not double counted", () => {
  const zeroTotal = row(
    "control-zero",
    "account-control-zero",
    "control_one_time",
    "US",
    "usd",
    1999,
    {
      exposedAt: "2026-08-01T00:00:00Z",
      oneTimePaidAt: "2026-08-01T00:05:00Z",
      oneTimeGrossMinor: 0,
      entitlementActivated: true,
    },
  );
  const refunded = row(
    "control-refunded",
    "account-control-refunded",
    "control_one_time",
    "US",
    "usd",
    1999,
    {
      exposedAt: "2026-08-01T00:00:00Z",
      oneTimePaidAt: "2026-08-01T00:05:00Z",
      oneTimeGrossMinor: 1999,
      oneTimeRefundedMinor: 100,
      entitlementActivated: true,
    },
  );
  const report = buildUpgradePricingReport([zeroTotal, refunded], [
    event(
      "evt-control-refund",
      "control-refunded",
      "refund-control",
      "refund.updated",
      "2026-08-02T00:00:00Z",
      { amountMinor: 100, currency: "usd", status: "succeeded" },
    ),
  ], WINDOW, SECRET);
  const control = segment(report, "control_one_time", "US", "usd");
  assert.equal(control.counts.completedOneTimePurchases, 2);
  assert.equal(control.counts.entitlementActivations, 2);
  assert.deepEqual(control.activation, { numerator: 2, denominator: 2, rate: 1 });
  assert.equal(control.counts.refunds, 1);
  assert.equal(control.realizedMoney.grossMinor, "1999");
  assert.equal(control.realizedMoney.refundsMinor, "100");
});

test("report surface excludes identity, provider, secret, and raw payload data", () => {
  const report = buildUpgradePricingReport(cohort(), events(), WINDOW, SECRET);
  const text = JSON.stringify(report);
  for (const forbidden of [
    "buyer@example.com", "127.0.0.9", "activation-secret", "device-hash",
    "install-hash", "receipt-hash", "cs_test_", "sub_", "pi_", "raw_payload",
  ]) assert.doesNotMatch(text, new RegExp(forbidden, "i"));
  for (const forbiddenKey of [
    "accountId", "intentId", "eventKey", "objectKey", "email", "ipAddress",
    "activationKey", "deviceIdHash", "installIdHash", "receiptIdHash", "stripeId",
  ]) assert.doesNotMatch(text, new RegExp(`"${forbiddenKey}"`, "i"));
});

test("internal route is POST-only, non-browser, bearer-protected, and no-store", async () => {
  const report = { schemaVersion: 1, segments: [], pagination: { nextCursor: null } };
  const handler = createUpgradePricingReportHandler({
    getAdminSecret: () => SECRET,
    queryReport: async () => report,
  });

  for (const request of [
    mockRequest({ method: "GET" }),
    mockRequest({ method: "POST", origin: "https://sidestream.tv", authorization: `Bearer ${SECRET}` }),
    mockRequest({ method: "POST", authorization: "Bearer wrong" }),
  ]) {
    const response = mockResponse();
    await handler(request, response);
    assert.notEqual(response.statusCode, 200);
    assert.equal(response.getHeader("cache-control"), "no-store, max-age=0");
  }

  const accepted = mockResponse();
  await handler(mockRequest({
    method: "POST",
    authorization: `Bearer ${SECRET}`,
    body: { namespace: "test" },
  }), accepted);
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.getHeader("cache-control"), "no-store, max-age=0");
  assert.deepEqual(JSON.parse(accepted.body), report);
});

test("operator CLI accepts only privacy-safe operators and local 127.0.0.1 pagination", async () => {
  const options = parseUpgradePricingReportArguments([
    "--operator", "alex.ops",
    "--namespace", "test",
    "--port", "4317",
    "--page-size", "1",
  ]);
  assert.equal(buildLocalReportUrl(options.port),
    "http://127.0.0.1:4317/api/internal/upgrade-pricing-report");
  assert.equal(options.experimentId, "upgrade-pricing-v2");
  assert.throws(() => parseUpgradePricingReportArguments([
    "--operator", "alex@example.com", "--namespace", "test",
  ]), /not an email/);

  const calls = [];
  const complete = await fetchCompleteUpgradePricingReport(options, {
    secret: SECRET,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({
        schemaVersion: 1,
        observationWindow: {
          from: "2026-07-01T00:00:00.000Z",
          throughExclusive: "2026-08-01T00:00:00.000Z",
          asOf: "2026-08-02T00:00:00.000Z",
        },
        segments: [{ country: body.cursor ? "IN" : "US" }],
        pagination: {
          nextCursor: body.cursor ? null : "signed-page-two",
          totalSegments: 2,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.url.startsWith("http://127.0.0.1:")));
  assert.ok(calls.every((call) => call.init.headers.Authorization === `Bearer ${SECRET}`));
  assert.ok(calls.every((call) => !("Origin" in call.init.headers)));
  assert.ok(calls.every((call) =>
    JSON.parse(call.init.body).experimentId === "upgrade-pricing-v2"));
  assert.deepEqual(complete.segments, [{ country: "US" }, { country: "IN" }]);
  assert.equal(complete.requestedByOperator, "alex.ops");
});

function cohort() {
  return [
    row("control-paid", "account-control-paid", "control_one_time", "US", "usd", 1999, {
      exposedAt: "2026-08-01T00:00:00Z",
      oneTimePaidAt: "2026-08-01T00:05:00Z",
      oneTimeGrossMinor: 1999,
      oneTimeRefundedMinor: 100,
      entitlementActivated: true,
      activationCompletedAt: "2026-08-01T01:00:00Z",
      activationClientVersion: "1.0.11",
    }),
    row("control-no", "account-control-no", "control_one_time", "US", "usd", 1999, {
      exposedAt: "2026-08-01T00:00:00Z",
    }),
    row("monthly-three", "account-monthly-three", "annual_same_price", "US", "usd", 999, {
      exposedAt: "2026-05-01T00:00:00Z",
      subscriptionStatus: "active",
      subscriptionEntitlementStatus: "active",
      entitlementActivated: true,
      cancelAtPeriodEnd: true,
      activationCompletedAt: "2026-05-01T01:00:00Z",
      activationClientVersion: "1.0.12",
    }),
    row("monthly-canceled", "account-monthly-canceled", "annual_same_price", "US", "usd", 999, {
      exposedAt: "2026-06-01T00:00:00Z",
      subscriptionStatus: "canceled",
      subscriptionEntitlementStatus: "revoked",
      entitlementActivated: true,
    }),
    row("monthly-recent", "account-monthly-recent", "annual_same_price", "IN", "inr", 25000, {
      exposedAt: "2026-08-10T00:00:00Z",
    }),
    row("monthly-week", "account-monthly-week", "annual_same_price", "BR", "brl", 1250, {
      exposedAt: "2026-08-01T00:00:00Z",
    }),
  ];
}

function row(intentId, accountId, variant, country, currency, amountMinor, overrides = {}) {
  return {
    intentId,
    assignmentId: `assignment-${accountId}`,
    accountId,
    acquisitionId: `acquisition-${accountId}`,
    variant,
    billingModel: variant === "annual_same_price" ? "subscription" : "one_time",
    country,
    currency,
    amountMinor,
    assignedAt: "2026-07-01T00:00:00Z",
    intentCreatedAt: overrides.exposedAt || "2026-08-01T00:00:00Z",
    exposedAt: null,
    sessionStarted: true,
    sessionAttempt: 0,
    intentState: "open",
    oneTimePaidAt: null,
    oneTimeGrossMinor: 0,
    oneTimeRefundedMinor: 0,
    subscriptionStatus: null,
    subscriptionEntitlementStatus: null,
    cancelAtPeriodEnd: false,
    entitlementActivated: false,
    activationCompletedAt: null,
    activationClientVersion: null,
    assignmentSnapshotDefect: false,
    exposureLineageDefect: false,
    acquisitionLineageDefect: false,
    activationLineageDefect: false,
    ...overrides,
  };
}

function events() {
  const list = [
    invoice("evt-m1-third", "monthly-three", "invoice-third", "2026-07-01T00:00:00Z", 999, "2026-08-01T00:00:00Z"),
    invoice("evt-m1-first", "monthly-three", "invoice-first", "2026-05-01T00:00:00Z", 999, "2026-06-01T00:00:00Z"),
    event("evt-m1-fail", "monthly-three", "invoice-second", "invoice.payment_failed", "2026-06-01T00:00:00Z"),
    invoice("evt-m1-second", "monthly-three", "invoice-second", "2026-06-02T00:00:00Z", 999, "2026-07-01T00:00:00Z"),
    invoice("evt-m1-second", "monthly-three", "invoice-second", "2026-06-02T00:00:00Z", 999, "2026-07-01T00:00:00Z"),
    event("evt-refund", "monthly-three", "refund-one", "refund.updated", "2026-07-02T00:00:00Z", {
      amountMinor: 50, currency: "usd", status: "succeeded",
    }),
    event("evt-credit", "monthly-three", "credit-one", "credit_note.updated", "2026-07-03T00:00:00Z", {
      amountMinor: 25, currency: "usd", status: "issued",
    }),
    invoice("evt-m2-first", "monthly-canceled", "invoice-canceled-first", "2026-06-01T00:00:00Z", 999, "2026-07-01T00:00:00Z"),
    event("evt-m2-deleted", "monthly-canceled", "subscription-canceled", "customer.subscription.deleted", "2026-06-15T00:00:00Z", {
      status: "canceled",
    }),
  ];
  return list;
}

function invoice(eventKey, intentId, objectKey, occurredAt, amountMinor, periodEnd) {
  return event(eventKey, intentId, objectKey, "invoice.paid", occurredAt, {
    amountMinor,
    currency: "usd",
    status: "paid",
    periodEnd,
  });
}

function event(eventKey, intentId, objectKey, eventType, occurredAt, overrides = {}) {
  return {
    eventKey,
    intentId,
    objectKey,
    eventType,
    occurredAt,
    amountMinor: 0,
    currency: null,
    status: null,
    billingReason: null,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

function segment(report, variant, country, currency) {
  return report.segments.find((row) =>
    row.variant === variant && row.country === country && row.currency === currency);
}

function mockRequest({ method, authorization, origin, body }) {
  const request = new EventEmitter();
  request.method = method;
  request.headers = {};
  request.rawHeaders = [];
  if (authorization) {
    request.headers.authorization = authorization;
    request.rawHeaders.push("Authorization", authorization);
  }
  if (origin) {
    request.headers.origin = origin;
    request.rawHeaders.push("Origin", origin);
  }
  if (body !== undefined) request.body = body;
  request[Symbol.asyncIterator] = async function* iterator() {};
  return request;
}

function mockResponse() {
  const headers = new Map();
  return {
    statusCode: 200,
    body: "",
    setHeader(name, value) { headers.set(name.toLowerCase(), String(value)); },
    getHeader(name) { return headers.get(name.toLowerCase()); },
    end(value = "") { this.body += String(value); },
  };
}

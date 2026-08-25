import assert from "node:assert/strict";
import test from "node:test";
import {
  decideUpgradePricing,
  deriveAnnualOfferAmount,
  deriveMonthlyHalfAmount,
  UPGRADE_PRICING_ANNUAL_VARIANT,
  UPGRADE_PRICING_CONTROL_VARIANT,
  UPGRADE_PRICING_EXPERIMENT_ID,
  UPGRADE_PRICING_MONTHLY_VARIANT,
  UpgradePricingExperimentError,
  upgradePricingBucket,
} from "../api/_lib/upgrade-pricing-experiment.ts";
import {
  readUpgradePricingRollout,
  UPGRADE_PRICING_EXPERIMENT_CONFIG,
} from "../config/upgrade-pricing-experiment.mjs";

const SECRET = "upgrade-pricing-fixture-secret-000000000000000000000000";
const FIXTURE_SIZE = 20_000;

function accountId(index) {
  return `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function decide(index, overrides = {}) {
  return decideUpgradePricing({
    accountId: accountId(index),
    currency: "usd",
    oneTimeAmountMinor: 1999,
    enabled: true,
    rolloutBasisPoints: 5_000,
    secret: SECRET,
    ...overrides,
  });
}

test("v2 is dormant by default and supports an explicit 50/50 one-time versus annual rollout", () => {
  assert.equal(UPGRADE_PRICING_EXPERIMENT_ID, "upgrade-pricing-v2");
  assert.equal(UPGRADE_PRICING_EXPERIMENT_CONFIG.assignmentVersion, 2);
  assert.deepEqual(UPGRADE_PRICING_EXPERIMENT_CONFIG.variants, [
    "control_one_time",
    "annual_same_price",
  ]);
  assert.equal(UPGRADE_PRICING_EXPERIMENT_CONFIG.closedAt, null);
  assert.deepEqual(readUpgradePricingRollout({}), {
    enabled: false,
    rolloutBasisPoints: 0,
    reason: "kill_switch",
  });
  assert.deepEqual(readUpgradePricingRollout({
    SIDESTREAM_UPGRADE_PRICING_EXPERIMENT_ENABLED: "true",
    SIDESTREAM_UPGRADE_PRICING_EXPERIMENT_ROLLOUT_BPS: "5000",
  }), {
    enabled: false,
    rolloutBasisPoints: 0,
    reason: "kill_switch",
  });
  assert.deepEqual(readUpgradePricingRollout({
    SIDESTREAM_UPGRADE_PRICING_V2_ENABLED: "false",
  }), {
    enabled: false,
    rolloutBasisPoints: 0,
    reason: "kill_switch",
  });
  assert.deepEqual(readUpgradePricingRollout({
    SIDESTREAM_UPGRADE_PRICING_V2_ENABLED: "true",
  }), {
    enabled: true,
    rolloutBasisPoints: 0,
    reason: "source_default",
  });
  assert.deepEqual(readUpgradePricingRollout({
    SIDESTREAM_UPGRADE_PRICING_V2_ENABLED: "true",
    SIDESTREAM_UPGRADE_PRICING_V2_ROLLOUT_BPS: "125",
  }), {
    enabled: true,
    rolloutBasisPoints: 125,
    reason: "configured",
  });
});

test("annual treatment is exactly $19.99 and deliberately global USD only", () => {
  assert.equal(deriveAnnualOfferAmount("usd", 1999), 1999);
  for (const [currency, amount] of [["inr", 49900], ["brl", 2500], ["krw", 24900]]) {
    assert.throws(
      () => deriveAnnualOfferAmount(currency, amount),
      (error) => error instanceof UpgradePricingExperimentError && error.code === "invalid_offer",
    );
  }
  assert.throws(
    () => deriveAnnualOfferAmount("eur", 1999),
    (error) => error instanceof UpgradePricingExperimentError && error.code === "unsupported_currency",
  );
  assert.equal(deriveMonthlyHalfAmount("usd", 1999), 499);
});

test("the cryptographic account fixture is deterministic and approximately balanced", () => {
  let annual = 0;
  const seenBuckets = new Set();
  for (let index = 0; index < FIXTURE_SIZE; index += 1) {
    const id = accountId(index);
    const first = upgradePricingBucket({ accountId: id, secret: SECRET });
    assert.equal(first, upgradePricingBucket({ accountId: id, secret: SECRET }));
    assert.ok(first >= 0 && first < 10_000);
    if (first < 5_000) annual += 1;
    seenBuckets.add(first);
  }
  assert.ok(annual > FIXTURE_SIZE * 0.48, `annual fixture count ${annual}`);
  assert.ok(annual < FIXTURE_SIZE * 0.52, `annual fixture count ${annual}`);
  assert.ok(seenBuckets.size > 8_000, `distinct buckets ${seenBuckets.size}`);
});

test("rollout zero, canary, and fifty percent use the exact server bucket", () => {
  let canaryAnnual = 0;
  let halfAnnual = 0;
  for (let index = 0; index < FIXTURE_SIZE; index += 1) {
    const bucket = upgradePricingBucket({ accountId: accountId(index), secret: SECRET });
    const zero = decide(index, { rolloutBasisPoints: 0 });
    const canary = decide(index, { rolloutBasisPoints: 100 });
    const half = decide(index, { rolloutBasisPoints: 5_000 });
    assert.equal(zero.variant, UPGRADE_PRICING_CONTROL_VARIANT);
    assert.equal(zero.reason, "rollout_zero");
    assert.equal(canary.variant === UPGRADE_PRICING_ANNUAL_VARIANT, bucket < 100);
    assert.equal(half.variant === UPGRADE_PRICING_ANNUAL_VARIANT, bucket < 5_000);
    if (canary.variant === UPGRADE_PRICING_ANNUAL_VARIANT) canaryAnnual += 1;
    if (half.variant === UPGRADE_PRICING_ANNUAL_VARIANT) halfAnnual += 1;
  }
  assert.ok(canaryAnnual > FIXTURE_SIZE * 0.0075);
  assert.ok(canaryAnnual < FIXTURE_SIZE * 0.0125);
  assert.ok(halfAnnual > FIXTURE_SIZE * 0.48);
  assert.ok(halfAnnual < FIXTURE_SIZE * 0.52);
});

test("a persisted v1 monthly assignment survives the new annual experiment", () => {
  const existingAssignment = {
    assignmentId: "20000000-0000-4000-8000-000000000001",
    assignmentVersion: 1,
    experimentId: "upgrade-pricing-v1",
    accountId: accountId(42),
    variant: "monthly_half",
    billingModel: "subscription",
    bucket: 17,
    rolloutBasisPoints: 100,
    assignedAt: "2026-08-12T00:00:00.000Z",
  };
  const retry = decide(42, { existingAssignment, enabled: false });
  assert.equal(retry.experimentId, "upgrade-pricing-v1");
  assert.equal(retry.assignmentVersion, 1);
  assert.equal(retry.variant, UPGRADE_PRICING_MONTHLY_VARIANT);
  assert.equal(retry.recurringAmountMinor, 499);
  assert.equal(retry.recurringInterval, "month");
  assert.equal(retry.assignmentId, existingAssignment.assignmentId);
  assert.equal(retry.usedExistingAssignment, true);
  assert.equal(retry.shouldPersistAssignment, false);
});

test("a persisted v2 annual assignment is permanent across rollout changes", () => {
  const existingAssignment = {
    assignmentId: "20000000-0000-4000-8000-000000000002",
    assignmentVersion: 2,
    experimentId: "upgrade-pricing-v2",
    accountId: accountId(43),
    variant: "annual_same_price",
    billingModel: "subscription",
    bucket: 12,
    rolloutBasisPoints: 5_000,
    assignedAt: "2026-08-22T00:00:00.000Z",
  };
  const retry = decide(43, { existingAssignment, enabled: false });
  assert.equal(retry.variant, UPGRADE_PRICING_ANNUAL_VARIANT);
  assert.equal(retry.recurringAmountMinor, 1999);
  assert.equal(retry.recurringInterval, "year");
  assert.equal(retry.assignmentId, existingAssignment.assignmentId);
  assert.equal(retry.shouldPersistAssignment, false);
});

test("kill switch, invalid assignments, and unsupported offers fail to one-time without cohort contamination", () => {
  const killed = decide(1, { enabled: false });
  assert.deepEqual({
    variant: killed.variant,
    billingModel: killed.billingModel,
    reason: killed.reason,
    shouldPersistAssignment: killed.shouldPersistAssignment,
    recurringCohortEligible: killed.recurringCohortEligible,
  }, {
    variant: "control_one_time",
    billingModel: "one_time",
    reason: "kill_switch",
    shouldPersistAssignment: false,
    recurringCohortEligible: false,
  });
  const malformed = decide(2, {
    existingAssignment: {
      assignmentId: "not-a-database-id",
      assignmentVersion: 2,
      experimentId: "upgrade-pricing-v2",
      accountId: accountId(2),
      variant: "annual_same_price",
      billingModel: "subscription",
      bucket: 2,
      rolloutBasisPoints: 5_000,
      assignedAt: "2026-08-22T00:00:00.000Z",
    },
  });
  assert.equal(malformed.reason, "assignment_unavailable");
  assert.equal(malformed.shouldPersistAssignment, false);
  const regional = decide(3, {
    rolloutBasisPoints: 10_000,
    currency: "inr",
    oneTimeAmountMinor: 49900,
  });
  assert.equal(regional.variant, UPGRADE_PRICING_CONTROL_VARIANT);
  assert.equal(regional.reason, "assignment_unavailable");
  assert.equal(regional.recurringCohortEligible, false);
  assert.equal(regional.recurringAmountMinor, null);
});

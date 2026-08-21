import assert from "node:assert/strict";
import test from "node:test";
import {
  decideUpgradePricing,
  deriveMonthlyHalfAmount,
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

test("the concluded experiment stays source-closed even when stale environment rollout remains", () => {
  assert.equal(UPGRADE_PRICING_EXPERIMENT_ID, "upgrade-pricing-v1");
  assert.deepEqual(UPGRADE_PRICING_EXPERIMENT_CONFIG.variants, [
    "control_one_time",
    "monthly_half",
  ]);
  assert.equal(UPGRADE_PRICING_EXPERIMENT_CONFIG.closedAt, "2026-08-21T09:51:17.000Z");
  assert.deepEqual(readUpgradePricingRollout({}), {
    enabled: false,
    rolloutBasisPoints: 0,
    reason: "kill_switch",
  });
  assert.deepEqual(readUpgradePricingRollout({
    SIDESTREAM_UPGRADE_PRICING_EXPERIMENT_ENABLED: "true",
    SIDESTREAM_UPGRADE_PRICING_EXPERIMENT_ROLLOUT_BPS: "125",
  }), {
    enabled: false,
    rolloutBasisPoints: 0,
    reason: "kill_switch",
  });
  for (const invalid of ["", "-1", "10001", "1.5", "browser-value"] ) {
    assert.deepEqual(readUpgradePricingRollout({
      SIDESTREAM_UPGRADE_PRICING_EXPERIMENT_ENABLED: "true",
      SIDESTREAM_UPGRADE_PRICING_EXPERIMENT_ROLLOUT_BPS: invalid,
    }), {
      enabled: false,
      rolloutBasisPoints: 0,
      reason: "kill_switch",
    });
  }
});

test("monthly_half uses the exact recurring amounts from the pricing contract", () => {
  for (const [currency, oneTimeAmountMinor, monthlyAmountMinor] of [
    ["usd", 1999, 499],
    ["inr", 49900, 29900],
    ["brl", 2500, 1299],
    ["krw", 24900, 12900],
  ]) {
    assert.equal(
      deriveMonthlyHalfAmount(currency, oneTimeAmountMinor),
      monthlyAmountMinor,
    );
  }
  assert.throws(
    () => deriveMonthlyHalfAmount("eur", 1999),
    (error) => error instanceof UpgradePricingExperimentError &&
      error.code === "unsupported_currency",
  );
  assert.throws(
    () => deriveMonthlyHalfAmount("usd", 0),
    (error) => error instanceof UpgradePricingExperimentError &&
      error.code === "invalid_offer",
  );
  assert.throws(
    () => deriveMonthlyHalfAmount("usd", 2499),
    (error) => error instanceof UpgradePricingExperimentError &&
      error.code === "invalid_offer",
  );
});

test("the cryptographic account fixture is deterministic and approximately balanced", () => {
  let monthly = 0;
  const seenBuckets = new Set();
  for (let index = 0; index < FIXTURE_SIZE; index += 1) {
    const id = accountId(index);
    const first = upgradePricingBucket({ accountId: id, secret: SECRET });
    const retry = upgradePricingBucket({ accountId: id, secret: SECRET });
    assert.equal(first, retry);
    assert.ok(first >= 0 && first < 10_000);
    if (first < 5_000) monthly += 1;
    seenBuckets.add(first);
  }
  assert.ok(monthly > FIXTURE_SIZE * 0.48, `monthly fixture count ${monthly}`);
  assert.ok(monthly < FIXTURE_SIZE * 0.52, `monthly fixture count ${monthly}`);
  assert.ok(seenBuckets.size > 8_000, `distinct buckets ${seenBuckets.size}`);
});

test("rollout zero, canary, and fifty percent use the exact server bucket", () => {
  let canaryMonthly = 0;
  let halfMonthly = 0;
  for (let index = 0; index < FIXTURE_SIZE; index += 1) {
    const bucket = upgradePricingBucket({ accountId: accountId(index), secret: SECRET });
    const zero = decide(index, { rolloutBasisPoints: 0 });
    const canary = decide(index, { rolloutBasisPoints: 100 });
    const half = decide(index, { rolloutBasisPoints: 5_000 });
    assert.equal(zero.variant, UPGRADE_PRICING_CONTROL_VARIANT);
    assert.equal(zero.reason, "rollout_zero");
    assert.equal(zero.shouldPersistAssignment, true);
    assert.equal(canary.variant === UPGRADE_PRICING_MONTHLY_VARIANT, bucket < 100);
    assert.equal(half.variant === UPGRADE_PRICING_MONTHLY_VARIANT, bucket < 5_000);
    if (canary.variant === UPGRADE_PRICING_MONTHLY_VARIANT) canaryMonthly += 1;
    if (half.variant === UPGRADE_PRICING_MONTHLY_VARIANT) halfMonthly += 1;
  }
  assert.ok(canaryMonthly > FIXTURE_SIZE * 0.0075);
  assert.ok(canaryMonthly < FIXTURE_SIZE * 0.0125);
  assert.ok(halfMonthly > FIXTURE_SIZE * 0.48);
  assert.ok(halfMonthly < FIXTURE_SIZE * 0.52);
});

test("a persisted account assignment survives rollout, country, device, client, and retry changes", () => {
  const existingAssignment = {
    assignmentId: "20000000-0000-4000-8000-000000000001",
    experimentId: "upgrade-pricing-v1",
    accountId: accountId(42),
    variant: "monthly_half",
    billingModel: "subscription",
    bucket: 17,
    rolloutBasisPoints: 100,
    assignedAt: "2026-08-12T00:00:00.000Z",
  };
  const first = decide(42, {
    existingAssignment,
    currency: "usd",
    oneTimeAmountMinor: 1999,
  });
  const retryFromAnotherClient = decide(42, {
    existingAssignment,
    enabled: false,
    rolloutBasisPoints: 0,
    currency: "inr",
    oneTimeAmountMinor: 49900,
    country: "IN",
    device: "changed",
    clientVersion: "1.0.11",
    retry: 99,
  });
  assert.equal(first.variant, UPGRADE_PRICING_MONTHLY_VARIANT);
  assert.equal(first.monthlyAmountMinor, 499);
  assert.equal(retryFromAnotherClient.variant, UPGRADE_PRICING_MONTHLY_VARIANT);
  assert.equal(retryFromAnotherClient.monthlyAmountMinor, 29900);
  assert.equal(retryFromAnotherClient.assignmentId, existingAssignment.assignmentId);
  assert.equal(retryFromAnotherClient.bucket, existingAssignment.bucket);
  assert.equal(retryFromAnotherClient.rolloutBasisPoints, 100);
  assert.equal(retryFromAnotherClient.usedExistingAssignment, true);
  assert.equal(retryFromAnotherClient.shouldPersistAssignment, false);
});

test("kill switch and assignment failures are observable one-time control fallbacks", () => {
  const killed = decide(1, { enabled: false, rolloutBasisPoints: 10_000 });
  assert.deepEqual({
    variant: killed.variant,
    billingModel: killed.billingModel,
    reason: killed.reason,
    shouldPersistAssignment: killed.shouldPersistAssignment,
    monthlyCohortEligible: killed.monthlyCohortEligible,
  }, {
    variant: "control_one_time",
    billingModel: "one_time",
    reason: "kill_switch",
    shouldPersistAssignment: false,
    monthlyCohortEligible: false,
  });

  const missingSecret = decide(2, {
    rolloutBasisPoints: 10_000,
    secret: "too-short",
  });
  assert.equal(missingSecret.variant, UPGRADE_PRICING_CONTROL_VARIANT);
  assert.equal(missingSecret.reason, "assignment_unavailable");
  assert.equal(missingSecret.assignedVariant, null);
  assert.equal(missingSecret.monthlyCohortEligible, false);

  const malformedPersistedAssignment = decide(2, {
    existingAssignment: {
      assignmentId: "not-a-database-id",
      experimentId: "upgrade-pricing-v1",
      accountId: accountId(2),
      variant: "monthly_half",
      billingModel: "subscription",
      bucket: 2,
      rolloutBasisPoints: 5_000,
      assignedAt: "2026-08-12T00:00:00.000Z",
    },
    rolloutBasisPoints: 10_000,
  });
  assert.equal(malformedPersistedAssignment.variant, UPGRADE_PRICING_CONTROL_VARIANT);
  assert.equal(malformedPersistedAssignment.reason, "assignment_unavailable");
  assert.equal(malformedPersistedAssignment.shouldPersistAssignment, false);

  const invalidRollout = decide(2, {
    enabled: true,
    rolloutBasisPoints: 10_001,
  });
  assert.equal(invalidRollout.variant, UPGRADE_PRICING_CONTROL_VARIANT);
  assert.equal(invalidRollout.reason, "assignment_unavailable");
  assert.equal(invalidRollout.monthlyCohortEligible, false);
});

test("unsupported currencies never create or expose a monthly cohort member", () => {
  const unsupported = decide(3, {
    rolloutBasisPoints: 10_000,
    currency: "eur",
  });
  assert.equal(unsupported.variant, UPGRADE_PRICING_CONTROL_VARIANT);
  assert.equal(unsupported.billingModel, "one_time");
  assert.equal(unsupported.reason, "unsupported_currency");
  assert.equal(unsupported.shouldPersistAssignment, false);
  assert.equal(unsupported.monthlyCohortEligible, false);
  assert.equal(unsupported.monthlyAmountMinor, null);

  const existingMonthly = decide(4, {
    existingAssignment: {
      assignmentId: "20000000-0000-4000-8000-000000000004",
      experimentId: "upgrade-pricing-v1",
      accountId: accountId(4),
      variant: "monthly_half",
      billingModel: "subscription",
      bucket: 4,
      rolloutBasisPoints: 5_000,
      assignedAt: "2026-08-12T00:00:00.000Z",
    },
    currency: "eur",
  });
  assert.equal(existingMonthly.variant, UPGRADE_PRICING_CONTROL_VARIANT);
  assert.equal(existingMonthly.assignedVariant, UPGRADE_PRICING_MONTHLY_VARIANT);
  assert.equal(existingMonthly.reason, "unsupported_currency");
  assert.equal(existingMonthly.monthlyCohortEligible, false);
});

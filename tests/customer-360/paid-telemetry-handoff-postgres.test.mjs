import assert from "node:assert/strict";
import test from "node:test";

import { runPaidTelemetryHandoffFixture } from "../helpers/paid-telemetry-handoff-fixture.mjs";

test("paid activation, commerce, telemetry, and Customer 360 converge on one profile", {
  timeout: 120_000,
}, async () => {
  const summary = await runPaidTelemetryHandoffFixture({ expectation: "repaired" });
  assert.deepEqual(summary.funnelCoverage, {
    exactPaidCheckout: "1/1",
    attributed: "1/1",
    unknown: "0/1",
    paidCustomer: true,
    integrityState: "intact",
  });
  assert.equal(summary.acquisitionLineage.expectedStagesExactlyOnce, true);
  assert.equal(summary.commerceLineage.exactLookupOwnerProfiles, 1);
  assert.equal(summary.telemetryCounts.currentProfileSuccessfulDownloads, 2);
  assert.ok(Object.values(summary.negativeFixtures).every(Boolean));
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /\b(?:cus|cs|pi|ch)_[A-Za-z0-9_]+\b/);
  assert.doesNotMatch(serialized, /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i);
  assert.doesNotMatch(serialized, /\b[0-9a-f]{64}\b/i);
  assert.doesNotMatch(serialized, /@example\.invalid\b/);
});

test("pending verified-account review converges through the exact current paid path", {
  timeout: 120_000,
}, async () => {
  const summary = await runPaidTelemetryHandoffFixture({
    expectation: "pending-review-repaired",
  });
  assert.equal(summary.observedContract, "pending-review-account-bridge-repaired");
  assert.deepEqual(summary.runtimeConvergence, {
    firstOutcome: "installation_claimed_recorded",
    replayOutcome: "installation_claimed_recorded",
  });
  assert.deepEqual(summary.guardedOperator, {
    beforeReasonCode: "repair_ready",
    beforeEligible: true,
    beforeWouldMutate: true,
    applyProbeReasonCode: "already_repaired",
    afterReasonCode: "already_repaired",
    afterEligible: true,
    afterWouldMutate: false,
  });
  assert.equal(summary.pendingReviewShape.verifiedAccountReviews, 1);
  assert.ok(summary.pendingReviewShape.currentAccountOrStripeLinks >= 4);
  assert.equal(summary.stageAndBindingState.immutableBindings, 1);
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /\b(?:cus|cs|pi|ch)_[A-Za-z0-9_]+\b/);
  assert.doesNotMatch(serialized, /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i);
  assert.doesNotMatch(serialized, /\b[0-9a-f]{64}\b/i);
  assert.doesNotMatch(serialized, /@example\.invalid\b/);
});

test("a unique reviewed path excludes the direct historical path and replays as a no-op", {
  timeout: 120_000,
}, async () => {
  const summary = await runPaidTelemetryHandoffFixture({
    expectation: "reviewed-path-repaired",
  });
  assert.equal(summary.observedContract, "unique-reviewed-paid-path-repaired");
  assert.deepEqual(summary.acquisitionShape, {
    paidPaths: 2,
    activeConsistentPaths: 2,
    activationPaths: 2,
  });
  assert.equal(summary.bridgeKindsNonOverlapping, true);
  assert.deepEqual(summary.guardedOperator, {
    beforeReasonCode: "repair_ready",
    beforeEligible: true,
    beforeWouldMutate: true,
    hasJourneyFingerprint: true,
    firstApplyReasonCode: "already_repaired",
    replayReasonCode: "already_repaired",
    afterReplayReasonCode: "already_repaired",
    afterReplayWouldMutate: false,
  });
  assert.equal(summary.mutationBoundary.dryRunStateUnchanged, true);
  assert.equal(summary.mutationBoundary.applyChangedState, true);
  assert.equal(summary.mutationBoundary.replayWasNoOp, true);
  assert.deepEqual(
    summary.mutationBoundary.afterReplay,
    summary.mutationBoundary.afterFirstApply,
  );
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /\b(?:cus|cs|pi|ch)_[A-Za-z0-9_]+\b/);
  assert.doesNotMatch(serialized, /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i);
  assert.doesNotMatch(serialized, /\b[0-9a-f]{64}\b/i);
  assert.doesNotMatch(serialized, /@example\.invalid\b/);
  assert.doesNotMatch(serialized, /postgres(?:ql)?:\/\//i);
});

test("the exact legacy entitlement placeholder repairs without rewriting legacy fields", {
  timeout: 120_000,
}, async () => {
  const summary = await runPaidTelemetryHandoffFixture({
    expectation: "legacy-entitlement-repaired",
  });
  assert.equal(
    summary.observedContract,
    "unique-reviewed-legacy-entitlement-repaired",
  );
  assert.deepEqual(summary.guardedOperator, {
    beforeReasonCode: "repair_ready",
    beforeEligible: true,
    beforeWouldMutate: true,
    hasJourneyFingerprint: true,
    firstApplyReasonCode: "already_repaired",
    replayReasonCode: "already_repaired",
    afterReplayReasonCode: "already_repaired",
    afterReplayWouldMutate: false,
  });
  assert.ok(Object.values(summary.reviewedLegacyPath).every(Boolean));
  assert.equal(summary.reviewedPath.verifiedAccountReviews, 1);
  assert.equal(summary.reviewedPath.directAccountOrStripeLinks, 0);
  assert.equal(summary.mutationBoundary.dryRunStateUnchanged, true);
  assert.equal(summary.mutationBoundary.applyChangedState, true);
  assert.equal(summary.mutationBoundary.replayWasNoOp, true);
  assert.equal(summary.mutationBoundary.legacyStateUnchanged, true);
  assert.deepEqual(
    summary.mutationBoundary.afterReplay,
    summary.mutationBoundary.afterFirstApply,
  );
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /\b(?:cus|cs|pi|ch)_[A-Za-z0-9_]+\b/);
  assert.doesNotMatch(serialized, /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i);
  assert.doesNotMatch(serialized, /\b[0-9a-f]{64}\b/i);
  assert.doesNotMatch(serialized, /@example\.invalid\b/);
  assert.doesNotMatch(serialized, /postgres(?:ql)?:\/\//i);
});

test("the exact reviewed legacy path repairs one verified unowned zero-total Checkout fact", {
  timeout: 120_000,
}, async () => {
  const summary = await runPaidTelemetryHandoffFixture({
    expectation: "unowned-commerce-repaired",
  });
  assert.equal(
    summary.observedContract,
    "unique-reviewed-legacy-unowned-zero-commerce-repaired",
  );
  assert.ok(Object.values(summary.reviewedLegacyPath).every(Boolean));
  assert.ok(Object.values(summary.recoverableCommercePreState).every(Boolean));
  assert.ok(Object.values(summary.repairedCommerce).every(Boolean));
  assert.ok(Object.values(summary.refusalMatrix).every(Boolean));
  assert.equal(summary.guardedOperator.beforeReasonCode, "repair_ready");
  assert.equal(summary.guardedOperator.beforeEligible, true);
  assert.equal(summary.guardedOperator.firstApplyReasonCode, "already_repaired");
  assert.equal(summary.guardedOperator.replayReasonCode, "already_repaired");
  assert.equal(summary.guardedOperator.afterReplayReasonCode, "already_repaired");
  assert.ok(Object.values(summary.mutationBoundary).filter((value) =>
    typeof value === "boolean").every(Boolean));
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /\b(?:cus|cs|pi|ch)_[A-Za-z0-9_]+\b/);
  assert.doesNotMatch(serialized, /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i);
  assert.doesNotMatch(serialized, /\b[0-9a-f]{64}\b/i);
  assert.doesNotMatch(serialized, /@example\.invalid\b/);
  assert.doesNotMatch(serialized, /postgres(?:ql)?:\/\//i);
});

test("the repaired live shape can still omit the exact current Stripe Customer link", {
  timeout: 120_000,
}, async () => {
  const summary = await runPaidTelemetryHandoffFixture({
    expectation: "missing-current-customer-broken",
  });
  assert.equal(
    summary.observedContract,
    "repaired-handoff-missing-exact-current-customer-link",
  );
  assert.ok(Object.values(summary.convergedState).every(Boolean));
  assert.ok(Object.values(summary.exactCurrentCustomerGap).every(Boolean));
  assert.deepEqual(summary.guardedOperator, {
    reasonCode: "already_repaired",
    eligible: true,
    wouldMutate: false,
    hasJourneyFingerprint: true,
    counts: {
      authenticationStages: 1,
      installationStages: 1,
      bindings: 1,
      mergeAudits: 1,
      acquisitionConflicts: 0,
      lifecycleStops: 0,
      commerceFacts: 1,
      commerceProfiles: 1,
      commerceConflicts: 0,
    },
  });
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /\b(?:cus|cs|pi|ch)_[A-Za-z0-9_]+\b/);
  assert.doesNotMatch(serialized, /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i);
  assert.doesNotMatch(serialized, /\b[0-9a-f]{64}\b/i);
  assert.doesNotMatch(serialized, /@example\.invalid\b/);
  assert.doesNotMatch(serialized, /postgres(?:ql)?:\/\//i);
});

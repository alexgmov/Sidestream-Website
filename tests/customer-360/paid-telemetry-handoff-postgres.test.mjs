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

test("the exact legacy entitlement placeholder is selected and rejected without mutation", {
  timeout: 120_000,
}, async () => {
  const summary = await runPaidTelemetryHandoffFixture({
    expectation: "legacy-entitlement-broken",
  });
  assert.equal(
    summary.observedContract,
    "unique-reviewed-legacy-entitlement-rejected",
  );
  assert.deepEqual(summary.guardedOperator, {
    reasonCode: "payment_or_account_conflict",
    eligible: false,
    wouldMutate: false,
    hasJourneyFingerprint: false,
    canonicalAcquisitionSelected: true,
    exactPaidPathSelected: true,
  });
  assert.ok(Object.values(summary.reviewedLegacyPath).every(Boolean));
  assert.equal(summary.reviewedPath.verifiedAccountReviews, 1);
  assert.equal(summary.reviewedPath.directAccountOrStripeLinks, 0);
  assert.equal(summary.mutationBoundary.stateUnchanged, true);
  assert.equal(summary.mutationBoundary.legacyStateUnchanged, true);
  assert.deepEqual(summary.mutationBoundary.after, summary.mutationBoundary.before);
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /\b(?:cus|cs|pi|ch)_[A-Za-z0-9_]+\b/);
  assert.doesNotMatch(serialized, /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i);
  assert.doesNotMatch(serialized, /\b[0-9a-f]{64}\b/i);
  assert.doesNotMatch(serialized, /@example\.invalid\b/);
  assert.doesNotMatch(serialized, /postgres(?:ql)?:\/\//i);
});

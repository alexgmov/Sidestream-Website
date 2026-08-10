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

test("pending verified-account review remains a privacy-safe reproduced handoff defect", {
  timeout: 120_000,
}, async () => {
  const summary = await runPaidTelemetryHandoffFixture({
    expectation: "pending-review-broken",
  });
  assert.equal(summary.observedContract, "pending-review-account-bridge-defect");
  assert.deepEqual(summary.currentCodeFailure, {
    activeUnclaimedOutcome: "claim_binding_conflict",
    pendingReviewProbeOutcome: "installation_identity_missing",
  });
  assert.deepEqual(summary.guardedDryRunFailure, {
    structuralBoundary: "verified_account_pending_review",
    fullReplayReasonCode: "paid_path_missing_or_ambiguous",
    fullReplayEligible: false,
    pendingReviewProbeReasonCode: "exact_identity_missing_or_ambiguous",
    pendingReviewProbeEligible: false,
  });
  assert.equal(summary.pendingReviewShape.verifiedAccountReviews, 1);
  assert.equal(summary.pendingReviewShape.currentAccountOrStripeLinks, 0);
  assert.equal(summary.stageAndBindingState.immutableBindings, 0);
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /\b(?:cus|cs|pi|ch)_[A-Za-z0-9_]+\b/);
  assert.doesNotMatch(serialized, /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i);
  assert.doesNotMatch(serialized, /\b[0-9a-f]{64}\b/i);
  assert.doesNotMatch(serialized, /@example\.invalid\b/);
});

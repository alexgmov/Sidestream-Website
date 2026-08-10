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

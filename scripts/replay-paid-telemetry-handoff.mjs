#!/usr/bin/env node

import { runPaidTelemetryHandoffFixture } from "../tests/helpers/paid-telemetry-handoff-fixture.mjs";

const options = process.argv.slice(2);
const diagnosticOptions = new Set([
  "--expect-broken",
  "--expect-pending-review-repaired",
  "--expect-reviewed-path-repaired",
  "--expect-legacy-entitlement-repaired",
]);
const unknown = options.filter((option) => !diagnosticOptions.has(option));
if (
  unknown.length > 0 ||
  options.length > 1
) {
  console.error(
    "Usage: npm run replay:paid-telemetry-handoff -- [--expect-broken|--expect-pending-review-repaired|--expect-reviewed-path-repaired|--expect-legacy-entitlement-repaired]",
  );
  process.exitCode = 1;
} else {
  const expectation = options.includes("--expect-legacy-entitlement-repaired")
    ? "legacy-entitlement-repaired"
    : options.includes("--expect-reviewed-path-repaired")
      ? "reviewed-path-repaired"
      : options.includes("--expect-pending-review-repaired")
        ? "pending-review-repaired"
        : options.includes("--expect-broken") ? "broken" : "repaired";
  runPaidTelemetryHandoffFixture({ expectation }).then((summary) => {
    console.log(`Paid telemetry handoff replay observed the expected ${expectation} contract.`);
    console.log(JSON.stringify(summary, null, 2));
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : "Paid telemetry handoff replay failed");
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

import { runPaidTelemetryHandoffFixture } from "../tests/helpers/paid-telemetry-handoff-fixture.mjs";

const options = process.argv.slice(2);
const unknown = options.filter((option) => option !== "--expect-broken");
if (unknown.length > 0 || options.filter((option) => option === "--expect-broken").length > 1) {
  console.error("Usage: npm run replay:paid-telemetry-handoff -- [--expect-broken]");
  process.exitCode = 1;
} else {
  const expectation = options.includes("--expect-broken") ? "broken" : "repaired";
  runPaidTelemetryHandoffFixture({ expectation }).then((summary) => {
    console.log(`Paid telemetry handoff replay observed the expected ${expectation} contract.`);
    console.log(JSON.stringify(summary, null, 2));
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : "Paid telemetry handoff replay failed");
    process.exitCode = 1;
  });
}

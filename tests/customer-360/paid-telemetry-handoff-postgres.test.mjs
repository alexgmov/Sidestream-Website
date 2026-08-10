import test from "node:test";

import { runPaidTelemetryHandoffFixture } from "../helpers/paid-telemetry-handoff-fixture.mjs";

test("paid activation, commerce, telemetry, and Customer 360 converge on one profile", {
  timeout: 120_000,
}, async () => {
  await runPaidTelemetryHandoffFixture({ expectation: "repaired" });
});

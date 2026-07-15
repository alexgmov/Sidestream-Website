import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import { loadInjectedModule } from "../helpers/handler-loader.mjs";

const {
  CUSTOMER_USAGE_JSON_PATH_ALLOWLIST,
  compareCustomerUsageHighWater,
  loadCustomerUsageSyncConfiguration,
  normalizeCustomerUsageAggregateRow,
  resolveDownloadOutcome,
  utcUsageWindow,
} = await loadInjectedModule(
  new URL("../../api/_lib/customer-usage.ts", import.meta.url),
  {
    pg: { Pool },
    "./postgres.js": {
      getPostgresPool: () => {
        throw new Error("Pure usage tests must inject both database pools");
      },
      RUNTIME_POSTGRES_URL_ENV_NAMES: [
        "SIDESTREAM_POSTGRES_URL",
        "SIDESTREAM_POSTGRES_PRISMA_URL",
        "SIDESTREAM_POSTGRES_URL_NON_POOLING",
        "POSTGRES_URL",
        "POSTGRES_PRISMA_URL",
        "POSTGRES_URL_NON_POOLING",
      ],
    },
  },
);

test("telemetry configuration is read-only, separate, bounded, and namespace-scoped", () => {
  const configuration = loadCustomerUsageSyncConfiguration({
    SIDESTREAM_TELEMETRY_POSTGRES_URL:
      "postgres://telemetry:secret@telemetry.internal/telemetry?sslmode=require",
    SIDESTREAM_POSTGRES_URL:
      "postgres://runtime:secret@runtime.internal/sidestream?sslmode=require",
    VERCEL_ENV: "production",
    SIDESTREAM_CUSTOMER_USAGE_OVERLAP_HOURS: "72",
    SIDESTREAM_CUSTOMER_USAGE_BATCH_SIZE: "100",
  });
  assert.equal(configuration.licenseNamespace, "production");
  assert.equal(configuration.overlapMs, 72 * 60 * 60 * 1_000);
  assert.equal(configuration.batchSize, 100);

  assert.throws(() => loadCustomerUsageSyncConfiguration({
    SIDESTREAM_TELEMETRY_POSTGRES_URL:
      "postgres://reader:reader@db.internal:5432/shared?application_name=telemetry",
    POSTGRES_URL:
      "postgres://writer:writer@DB.INTERNAL/shared?application_name=runtime",
    VERCEL_ENV: "production",
  }), /separate from runtime database POSTGRES_URL/);
  assert.throws(() => loadCustomerUsageSyncConfiguration({
    SIDESTREAM_TELEMETRY_POSTGRES_URL: "postgres://reader:reader@db.invalid/telemetry",
  }), /trusted deployment namespace/);
  assert.throws(() => loadCustomerUsageSyncConfiguration({
    SIDESTREAM_TELEMETRY_POSTGRES_URL: "postgres://reader:reader@db.invalid/telemetry",
    SIDESTREAM_LICENSE_NAMESPACE: "client-selected",
  }), /must be production or test/);
});

test("only versioned scalar paths and explicit aggregate columns cross the boundary", async () => {
  const paths = Object.values(CUSTOMER_USAGE_JSON_PATH_ALLOWLIST).flat();
  assert.deepEqual(Object.keys(CUSTOMER_USAGE_JSON_PATH_ALLOWLIST), ["0.2.0"]);
  assert.ok(paths.length > 0);
  for (const forbidden of [
    "search", "query", "title", "url", "ip", "user_agent", "token", "credential",
    "gmail_campaign",
  ]) {
    assert.equal(paths.some((path) => path.toLowerCase().includes(forbidden)), false, forbidden);
  }

  const aggregate = normalizeCustomerUsageAggregateRow({
    install_id_hash: "a".repeat(64),
    activity_day: "2026-11-01",
    first_app_use_at: "2026-11-01T08:30:00.000Z",
    last_app_use_at: "2026-11-01T09:30:00.000Z",
    first_download_attempt_at: null,
    last_download_attempt_at: null,
    first_download_success_at: null,
    last_download_success_at: null,
    active_event_count: "2",
    download_attempt_count: "0",
    download_outcome_count: "0",
    download_success_count: "0",
    download_failure_count: "0",
    download_cancelled_count: "0",
    download_pending_count: "0",
    download_unknown_count: "0",
    platform: "macos",
    app_version: "1.0.13",
    payload: { token: "must-not-cross" },
    data_points: { details: { searchQuery: "must-not-cross" } },
    source_url: "https://must-not-cross.invalid",
  });
  assert.deepEqual(Object.keys(aggregate), [
    "installIdHash",
    "activityDay",
    "firstAppUseAt",
    "lastAppUseAt",
    "firstDownloadAttemptAt",
    "lastDownloadAttemptAt",
    "firstDownloadSuccessAt",
    "lastDownloadSuccessAt",
    "activeEventCount",
    "downloadAttemptCount",
    "downloadOutcomeCount",
    "downloadSuccessCount",
    "downloadFailureCount",
    "downloadCancelledCount",
    "downloadPendingCount",
    "downloadUnknownCount",
    "platform",
    "appVersion",
  ]);
  assert.doesNotMatch(JSON.stringify(aggregate), /must-not-cross/);

  const source = await readFile(new URL("../../api/_lib/customer-usage.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /select\s+[^;]*(?:event\.)?payload\s*,/i);
  assert.doesNotMatch(source, /select\s+[^;]*(?:event\.)?data_points\s*,/i);
  assert.match(source, /case event\.schema_version/);
  assert.match(source, /default_transaction_read_only=on/);
  assert.doesNotMatch(source, /gmail_campaign_hash/i);
});

test("download outcomes prefer finalization and preserve pending and unknown", () => {
  assert.equal(resolveDownloadOutcome({
    hasFinalization: true,
    fileDelivered: true,
    legacyFailed: true,
  }), "success");
  assert.equal(resolveDownloadOutcome({
    hasFinalization: true,
    fileDelivered: true,
    importResult: "failed",
  }), "failure");
  assert.equal(resolveDownloadOutcome({
    hasFinalization: true,
    userOutcome: "cancelled",
    legacyFailed: true,
  }), "cancelled");
  assert.equal(resolveDownloadOutcome({}), "pending");
  assert.equal(resolveDownloadOutcome({
    hasFinalization: true,
    userOutcome: "future_state",
  }), null);
  assert.equal(resolveDownloadOutcome({
    legacyCompleted: true,
    legacyImportFailed: true,
  }), "failure");
});

test("high-water ordering preserves equal timestamps with the telemetry event id tie-breaker", () => {
  const timestamp = new Date("2026-07-15T12:00:00.000Z");
  assert.equal(compareCustomerUsageHighWater(
    { receivedAt: timestamp, telemetryEventId: "event-a" },
    { receivedAt: timestamp, telemetryEventId: "event-b" },
  ), -1);
  assert.equal(compareCustomerUsageHighWater(
    { receivedAt: timestamp, telemetryEventId: "event-b" },
    { receivedAt: timestamp, telemetryEventId: "event-a" },
  ), 1);
  assert.equal(compareCustomerUsageHighWater(
    { receivedAt: timestamp, telemetryEventId: "event-a" },
    { receivedAt: new Date(timestamp), telemetryEventId: "event-a" },
  ), 0);
});

test("rolling boundaries are UTC across Los Angeles spring-forward and fall-back", () => {
  assert.equal(process.env.TZ, "America/Los_Angeles");
  assert.deepEqual(utcUsageWindow(new Date("2026-03-08T09:30:00.000Z")), {
    today: "2026-03-08",
    sevenDayStart: "2026-03-02",
    thirtyDayStart: "2026-02-07",
  });
  assert.deepEqual(utcUsageWindow(new Date("2026-11-01T09:30:00.000Z")), {
    today: "2026-11-01",
    sevenDayStart: "2026-10-26",
    thirtyDayStart: "2026-10-03",
  });
});

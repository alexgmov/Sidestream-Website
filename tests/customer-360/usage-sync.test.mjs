import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  connectedDatabaseFingerprint,
  loadOperatorPackage,
} from "../../scripts/customer-360-operator-guards.mjs";
import {
  CUSTOMER_USAGE_OPERATOR_INVARIANTS,
  PRODUCTION_CONFIRMATION,
  authenticatedPostgresPoolOptions,
  parseCustomerUsageSyncArgs,
  runCustomerUsageSyncOperator,
} from "../../scripts/sync-customer-usage.mjs";

const worktreeRoot = new URL("../..", import.meta.url).pathname;
const [{ Pool }, ts] = await Promise.all([
  loadOperatorPackage("pg", worktreeRoot),
  loadOperatorPackage("typescript", worktreeRoot),
]);

const {
  CUSTOMER_USAGE_JSON_PATH_ALLOWLIST,
  buildTelemetryPoolOptions,
  compareCustomerUsageHighWater,
  loadCustomerUsageSyncConfiguration,
  normalizeCustomerUsageAggregateRow,
  resolveDownloadOutcome,
  utcUsageWindow,
} = await loadCustomerUsageTestModule(
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

async function loadCustomerUsageTestModule(sourceUrl, injectedModules) {
  const source = await readFile(sourceUrl, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
  }).outputText;
  let executable = transpiled;
  for (const [specifier, bindings] of Object.entries(injectedModules)) {
    executable = executable.replaceAll(
      `from ${JSON.stringify(specifier)}`,
      `from ${JSON.stringify(injectedModuleUrl(bindings))}`,
    );
  }
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(executable)}`);
}

function injectedModuleUrl(bindings) {
  const key = `sidestream.usage.test.${Math.random()}`;
  globalThis[key] = bindings;
  const exports = Object.keys(bindings).map(
    (name) => `export const ${name} = globalThis[${JSON.stringify(key)}][${JSON.stringify(name)}];`,
  );
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(exports.join("\n"))}`;
}

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

test("high-water ordering preserves PostgreSQL microseconds within one millisecond", () => {
  assert.equal(compareCustomerUsageHighWater(
    { receivedAt: "2026-08-02T06:00:32.330001Z", telemetryEventId: "event-z" },
    { receivedAt: "2026-08-02T06:00:32.330002Z", telemetryEventId: "event-a" },
  ), -1);
  assert.equal(compareCustomerUsageHighWater(
    { receivedAt: "2026-08-02T06:00:32.330999Z", telemetryEventId: "event-a" },
    { receivedAt: "2026-08-02T06:00:32.330001Z", telemetryEventId: "event-z" },
  ), 1);
});

test("rolling boundaries are UTC across Los Angeles spring-forward and fall-back", () => {
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

test("offline sync is dry-run by default and Production requires two exact confirmations", async () => {
  const dryRun = parseCustomerUsageSyncArgs(["--target", "test", "--dry-run"]);
  let connections = 0;
  const report = await runCustomerUsageSyncOperator({
    options: dryRun,
    environment: {
      SIDESTREAM_TEST_POSTGRES_URL: "postgres://user:password@localhost/disposable",
    },
    createPool() {
      connections += 1;
      throw new Error("dry-run connected");
    },
  });
  assert.equal(report.mode, "dry_run");
  assert.equal(report.connected, false);
  assert.equal(report.writes, 0);
  assert.equal(connections, 0);
  assert.equal(CUSTOMER_USAGE_OPERATOR_INVARIANTS.deleteStatements, "forbidden");

  assert.throws(
    () => parseCustomerUsageSyncArgs(["--apply", "--target", "production"]),
    /confirm-production/,
  );
  assert.throws(
    () => parseCustomerUsageSyncArgs([
      "--apply", "--target", "production",
      "--confirm-production", PRODUCTION_CONFIRMATION,
    ]),
    /confirm-target/,
  );
  assert.throws(
    () => parseCustomerUsageSyncArgs([
      "--apply", "--target", "test", "--target-url-env", "POSTGRES_URL",
    ]),
    /only SIDESTREAM_TEST_POSTGRES_URL/,
  );
  assert.equal(
    parseCustomerUsageSyncArgs(["--apply", "--target", "test", "--batch-size", "5000"])
      .batchSize,
    5_000,
  );
  assert.throws(
    () => parseCustomerUsageSyncArgs([
      "--apply", "--target", "test", "--batch-size", "5001",
    ]),
    /between 25 and 5000/,
  );
});

test("connected fingerprints bind operation and namespace while remote pools authenticate TLS", () => {
  const first = connectedDatabaseFingerprint({
    hostname: "db.example.com",
    port: "5432",
    databaseName: "sidestream",
    namespace: "production",
    operation: "customer_usage_sync",
  });
  const second = connectedDatabaseFingerprint({
    hostname: "db.example.com",
    port: "5432",
    databaseName: "sidestream",
    namespace: "production",
    operation: "customer_usage_sync",
  });
  assert.equal(first, second);
  assert.match(first, /^pg-[0-9a-f]{20}$/);
  assert.doesNotMatch(first, /private|password|example|sidestream/);
  assert.notEqual(first, connectedDatabaseFingerprint({
    hostname: "db.example.com",
    port: "5432",
    databaseName: "sidestream",
    namespace: "test",
    operation: "customer_usage_sync",
  }));
  const remote = authenticatedPostgresPoolOptions(
    "postgres://private-user:private-password@db.example.com/sidestream?sslmode=require",
    { readOnly: true },
  );
  assert.deepEqual(remote.ssl, { rejectUnauthorized: true });
  assert.equal(remote.options, "-c default_transaction_read_only=on");
  assert.throws(
    () => authenticatedPostgresPoolOptions(
      "postgres://private:secret@db.example.com/sidestream?sslmode=disable",
    ),
    /authenticated TLS/,
  );
  assert.deepEqual(
    buildTelemetryPoolOptions(
      "postgres://reader:secret@telemetry.example.com/events?sslmode=require",
    ).ssl,
    { rejectUnauthorized: true },
  );
  assert.throws(
    () => buildTelemetryPoolOptions(
      "postgres://reader:secret@telemetry.example.com/events?sslmode=disable",
    ),
    /authenticated TLS/,
  );
});

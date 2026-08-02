import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PRODUCTION_CONFIRMATION,
} from "../../scripts/sync-customer-usage.mjs";
import { connectedDatabaseFingerprint } from "../../scripts/customer-360-operator-guards.mjs";
import {
  CUSTOMER_USAGE_RESCAN_OPERATION,
  REPLAY_CONFIRMATION,
  normalizeRescanCheckpoint,
  parseCustomerUsageRescanArgs,
  runCustomerUsageRescanOperator,
} from "../../scripts/rescan-customer-usage.mjs";

test("rescan dry-run has no database or checkpoint side effects", async () => {
  const options = parseCustomerUsageRescanArgs(["--dry-run", "--target", "test"]);
  let connections = 0;
  let checkpointWrites = 0;
  const report = await runCustomerUsageRescanOperator({
    options,
    environment: {
      SIDESTREAM_TEST_POSTGRES_URL: "postgres://test:test@localhost/disposable",
    },
    createPool() {
      connections += 1;
      throw new Error("dry-run connected");
    },
    writeCheckpoint() {
      checkpointWrites += 1;
      throw new Error("dry-run wrote checkpoint");
    },
  });
  assert.equal(report.mode, "dry_run");
  assert.equal(report.operation, "full_historical_session_started_rescan");
  assert.equal(report.connected, false);
  assert.equal(report.writes, 0);
  assert.equal(connections, 0);
  assert.equal(checkpointWrites, 0);
});

test("rescan apply, Production, and replay require explicit bounded controls", () => {
  assert.throws(
    () => parseCustomerUsageRescanArgs(["--apply", "--target", "test"]),
    /--checkpoint/,
  );
  assert.throws(
    () => parseCustomerUsageRescanArgs([
      "--apply", "--target", "production", "--checkpoint", "state.json",
    ]),
    /confirm-production/,
  );
  assert.throws(
    () => parseCustomerUsageRescanArgs(["--replay"]),
    /confirm-replay/,
  );
  const replay = parseCustomerUsageRescanArgs([
    "--dry-run", "--replay", "--confirm-replay", REPLAY_CONFIRMATION,
    "--batch-size", "25", "--max-batches", "1",
  ]);
  assert.equal(replay.replay, true);
  assert.equal(replay.batchSize, 25);
  assert.equal(replay.maxBatches, 1);
  assert.throws(
    () => parseCustomerUsageRescanArgs(["--max-batches", "10001"]),
    /between 1 and 10000/,
  );
});

test("checkpoint resume binds to the sanitized source and target fingerprints", () => {
  const identity = {
    target: "test",
    targetFingerprint: "pg-1111111111111111",
    sourceFingerprint: "pg-2222222222222222",
  };
  const checkpoint = normalizeRescanCheckpoint({
    version: 1,
    ...identity,
    complete: false,
    next: {
      receivedAt: "2026-07-31T12:00:00Z",
      telemetryEventId: "event-100",
    },
  }, identity);
  assert.equal(checkpoint.next.receivedAt, "2026-07-31T12:00:00.000Z");
  assert.throws(
    () => normalizeRescanCheckpoint(checkpoint, {
      ...identity,
      sourceFingerprint: "pg-3333333333333333",
    }),
    /does not match/,
  );
});

test("committed batches checkpoint for resume and replay remains idempotent", async () => {
  const targetUrl = "postgres://writer:secret@target.example.com/sidestream?sslmode=require";
  const sourceUrl = "postgres://reader:secret@source.example.com/telemetry?sslmode=require";
  const targetFingerprint = connectedDatabaseFingerprint({
    hostname: "target.example.com",
    port: "5432",
    databaseName: "sidestream",
    namespace: "production",
    operation: CUSTOMER_USAGE_RESCAN_OPERATION,
  });
  const options = parseCustomerUsageRescanArgs([
    "--apply", "--target", "production", "--checkpoint", "state.json",
    "--confirm-production", PRODUCTION_CONFIRMATION,
    "--confirm-target", targetFingerprint,
  ]);
  const checkpoints = [];
  const pools = [];
  const report = await runCustomerUsageRescanOperator({
    options,
    environment: {
      SIDESTREAM_POSTGRES_URL_NON_POOLING: targetUrl,
      SIDESTREAM_TELEMETRY_POSTGRES_URL: sourceUrl,
    },
    now: new Date("2026-07-31T13:00:00Z"),
    createPool(poolOptions) {
      const databaseName = new URL(poolOptions.connectionString).pathname.slice(1);
      const pool = {
        options: poolOptions,
        async connect() {
          return {
            async query(sql) {
              if (sql.includes("current_database()")) {
                return { rows: [{ database_name: databaseName, server_port: "5432" }] };
              }
              if (sql.includes("to_regclass")) {
                return { rows: [{ profiles: false, usage: false }] };
              }
              throw new Error("unexpected identity query");
            },
            release() {},
          };
        },
        async query() {
          return { rows: [{ source_freshness_at: "2026-07-31T12:00:00Z" }] };
        },
        async end() {},
      };
      pools.push(pool);
      return pool;
    },
    async runRescan(runOptions) {
      const first = {
        receivedAt: new Date("2026-07-31T10:00:00Z"),
        telemetryEventId: "event-050",
      };
      const second = {
        receivedAt: new Date("2026-07-31T12:00:00Z"),
        telemetryEventId: "event-100",
      };
      await runOptions.afterBatchCommitted({ batch: 1, checkpoint: first });
      await runOptions.afterBatchCommitted({ batch: 2, checkpoint: second });
      return {
        outcome: "completed",
        complete: true,
        checkpoint: {
          receivedAt: second.receivedAt.toISOString(),
          telemetryEventId: second.telemetryEventId,
        },
        batches: 2,
        sourceEventsScanned: 50,
        dailyBucketsWritten: 7,
        profilesRefreshed: 3,
        sourceFreshnessAt: second.receivedAt.toISOString(),
      };
    },
    async writeCheckpoint(checkpoint) {
      checkpoints.push(checkpoint);
    },
  });
  assert.equal(report.summary.complete, true);
  assert.equal(report.checkpointWrites, 3);
  assert.equal(checkpoints.at(-1).complete, true);
  assert.equal(checkpoints.at(-1).next.telemetryEventId, "event-100");
  assert.equal(pools[1].options.options, "-c default_transaction_read_only=on");

  const completed = await runCustomerUsageRescanOperator({
    options,
    checkpoint: checkpoints.at(-1),
    environment: {
      SIDESTREAM_POSTGRES_URL_NON_POOLING: targetUrl,
      SIDESTREAM_TELEMETRY_POSTGRES_URL: sourceUrl,
    },
    createPool(poolOptions) {
      const databaseName = new URL(poolOptions.connectionString).pathname.slice(1);
      return {
        async connect() {
          return {
            async query(sql) {
              if (sql.includes("current_database()")) {
                return { rows: [{ database_name: databaseName, server_port: "5432" }] };
              }
              return { rows: [{ profiles: false, usage: false }] };
            },
            release() {},
          };
        },
        async end() {},
      };
    },
  });
  assert.equal(completed.complete, true);
  assert.equal(completed.connected, true);
});

test("rescan implementation is aggregate-only and contains no delete capability", async () => {
  const [core, script] = await Promise.all([
    readFile(new URL("../../api/_lib/customer-usage.ts", import.meta.url), "utf8"),
    readFile(new URL("../../scripts/rescan-customer-usage.mjs", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(`${core}\n${script}`, /\bdelete\s+from\b/i);
  assert.match(core, /event_name = 'session_started'/);
  assert.match(core, /on conflict \(license_namespace, install_id_hash, activity_day\) do update/i);
  assert.doesNotMatch(core, /(?:payload|data_points)\s*->[^\n]*(?:source|utm_source)/i);
  for (const forbidden of [
    "sidestream_entitlements", "sidestream_license_devices", "stripe_payment_intents",
    "sidestream_anonymous_acquisition_sessions set", "sidestream_customer_identity_links set",
  ]) {
    assert.equal(script.toLowerCase().includes(forbidden), false, forbidden);
  }
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  connectAndFingerprintOperatorDatabase,
  connectedDatabaseFingerprint,
  rejectConnectedCollision,
  requireProductionConfirmations,
  resolveOperatorDatabase,
  safeOperatorCliError,
  writeMode600JsonAtomic,
} from "../../scripts/customer-360-operator-guards.mjs";
import {
  CUSTOMER_USAGE_SYNC_OPERATION,
  PRODUCTION_CONFIRMATION,
  parseCustomerUsageSyncArgs,
  runCustomerUsageSyncOperator,
} from "../../scripts/sync-customer-usage.mjs";
import {
  REPLAY_CONFIRMATION,
  parseCustomerUsageRescanArgs,
  runCustomerUsageRescanOperator,
} from "../../scripts/rescan-customer-usage.mjs";
import {
  CUSTOMER_360_BACKFILL_OPERATION,
  normalizeBackfillOperatorCheckpoint,
} from "../../scripts/backfill-customer-360.mjs";

const TEST_URL = "postgres://test:secret@localhost:5432/disposable_test";
test("exact selectors reject missing URLs, missing secrets, insecure TLS, and ambiguity", () => {
  assert.throws(
    () => resolveOperatorDatabase({
      environment: {},
      namespace: "test",
      selector: "SIDESTREAM_TEST_POSTGRES_URL",
    }),
    /not configured/,
  );
  assert.throws(
    () => resolveOperatorDatabase({
      environment: { SIDESTREAM_TEST_POSTGRES_URL: TEST_URL },
      namespace: "test",
      selector: "POSTGRES_URL",
    }),
    /exact SIDESTREAM_TEST_POSTGRES_URL/,
  );
  assert.throws(
    () => resolveOperatorDatabase({
      environment: {
        SIDESTREAM_POSTGRES_URL_NON_POOLING:
          "postgres://production@production.example.com/sidestream?sslmode=require",
      },
      namespace: "production",
      selector: "SIDESTREAM_POSTGRES_URL_NON_POOLING",
    }),
    /authentication secret/,
  );
  assert.throws(
    () => resolveOperatorDatabase({
      environment: {
        SIDESTREAM_POSTGRES_URL_NON_POOLING:
          "postgres://production:secret@production.example.com/sidestream?sslmode=disable",
      },
      namespace: "production",
      selector: "SIDESTREAM_POSTGRES_URL_NON_POOLING",
    }),
    /authenticated TLS/,
  );
  assert.throws(
    () => resolveOperatorDatabase({
      environment: {
        SIDESTREAM_TEST_POSTGRES_URL: TEST_URL,
        SIDESTREAM_POSTGRES_URL_NON_POOLING:
          "postgres://other:secret@localhost:5432/disposable_test",
      },
      namespace: "test",
      selector: "SIDESTREAM_TEST_POSTGRES_URL",
    }),
    /same database endpoint/,
  );
});

test("fingerprints are produced only after connected database and namespace attestation", async () => {
  const descriptor = resolveOperatorDatabase({
    environment: { SIDESTREAM_TEST_POSTGRES_URL: TEST_URL },
    namespace: "test",
    selector: "SIDESTREAM_TEST_POSTGRES_URL",
  });
  let connected = false;
  const pool = fakePool({ databaseName: "disposable_test", namespace: "test", onConnect() {
    connected = true;
  } });
  assert.equal(connected, false);
  const attestation = await connectAndFingerprintOperatorDatabase({
    pool,
    descriptor,
    namespace: "test",
    operation: CUSTOMER_USAGE_SYNC_OPERATION,
  });
  assert.equal(connected, true);
  assert.match(attestation.fingerprint, /^pg-[0-9a-f]{20}$/);
  assert.equal(JSON.stringify(attestation).includes(TEST_URL), false);
  attestation.client.release();

  await assert.rejects(
    connectAndFingerprintOperatorDatabase({
      pool: fakePool({ databaseName: "wrong_database", namespace: "test" }),
      descriptor,
      namespace: "test",
      operation: CUSTOMER_USAGE_SYNC_OPERATION,
    }),
    /does not match the selected database name/,
  );
  await assert.rejects(
    connectAndFingerprintOperatorDatabase({
      pool: fakePool({ databaseName: "disposable_test", namespace: "production" }),
      descriptor,
      namespace: "test",
      operation: CUSTOMER_USAGE_SYNC_OPERATION,
    }),
    /wrong or ambiguous license namespace/,
  );
});

test("connected target confirmation and source collision fail closed", () => {
  const fingerprint = connectedDatabaseFingerprint({
    hostname: "production.example.com",
    port: "5432",
    databaseName: "sidestream",
    namespace: "production",
    operation: CUSTOMER_USAGE_SYNC_OPERATION,
  });
  assert.throws(
    () => requireProductionConfirmations({
      namespace: "production",
      operation: CUSTOMER_USAGE_SYNC_OPERATION,
      expectedConfirmation: PRODUCTION_CONFIRMATION,
      fingerprint,
      confirmOperation: PRODUCTION_CONFIRMATION,
      confirmTarget: "pg-wrong",
    }),
    /does not match the connected database/,
  );
  assert.throws(
    () => rejectConnectedCollision(fingerprint, fingerprint),
    /must be separate connected databases/,
  );
});

test("provider errors and customer-like values are replaced by fixed safe errors", async () => {
  const descriptor = resolveOperatorDatabase({
    environment: { SIDESTREAM_TEST_POSTGRES_URL: TEST_URL },
    namespace: "test",
    selector: "SIDESTREAM_TEST_POSTGRES_URL",
  });
  const privateProviderError =
    "password=secret customer.private@example.com postgres://user:secret@host/database";
  await assert.rejects(
    connectAndFingerprintOperatorDatabase({
      pool: fakePool({ providerError: privateProviderError }),
      descriptor,
      namespace: "test",
      operation: CUSTOMER_USAGE_SYNC_OPERATION,
    }),
    (error) => {
      assert.equal(error.message, "Database identity attestation failed.");
      assert.equal(error.message.includes("secret"), false);
      assert.equal(error.message.includes("customer.private"), false);
      return true;
    },
  );
  assert.equal(
    safeOperatorCliError(new Error(privateProviderError), "Operator failed."),
    "Operator failed.",
  );
});

test("dry-runs stay network-free and replay remains an explicit confirmation", async () => {
  let connections = 0;
  const sync = await runCustomerUsageSyncOperator({
    options: parseCustomerUsageSyncArgs(["--dry-run", "--target", "production"]),
    environment: {},
    createPool() {
      connections += 1;
      throw new Error("dry-run connected");
    },
  });
  const rescan = await runCustomerUsageRescanOperator({
    options: parseCustomerUsageRescanArgs(["--dry-run", "--target", "production"]),
    environment: {},
    createPool() {
      connections += 1;
      throw new Error("dry-run connected");
    },
  });
  assert.equal(sync.connected, false);
  assert.equal(rescan.connected, false);
  assert.equal(sync.targetFingerprint, null);
  assert.equal(rescan.targetFingerprint, null);
  assert.equal(connections, 0);
  assert.throws(
    () => parseCustomerUsageRescanArgs(["--dry-run", "--replay"]),
    /confirm-replay/,
  );
  assert.equal(parseCustomerUsageRescanArgs([
    "--dry-run", "--replay", "--confirm-replay", REPLAY_CONFIRMATION,
  ]).replay, true);
});

test("connected status returns operation-bound fingerprints without running writes", async () => {
  let syncCalls = 0;
  const report = await runCustomerUsageSyncOperator({
    options: parseCustomerUsageSyncArgs(["--status", "--target", "test"]),
    environment: {
      SIDESTREAM_TEST_POSTGRES_URL: TEST_URL,
      SIDESTREAM_TELEMETRY_POSTGRES_URL:
        "postgres://reader:secret@localhost:5432/telemetry_test",
    },
    createPool(poolOptions) {
      const databaseName = new URL(poolOptions.connectionString).pathname.slice(1);
      return fakePool({ databaseName, namespace: "test" });
    },
    runSync() {
      syncCalls += 1;
    },
  });
  assert.equal(report.mode, "status");
  assert.equal(report.connected, true);
  assert.match(report.targetFingerprint, /^pg-[0-9a-f]{20}$/);
  assert.match(report.sourceFingerprint, /^pg-[0-9a-f]{20}$/);
  assert.notEqual(report.targetFingerprint, report.sourceFingerprint);
  assert.equal(report.writes, 0);
  assert.equal(syncCalls, 0);
});

test("connected sync rejects source and target collision before any write", async () => {
  const options = parseCustomerUsageSyncArgs(["--apply", "--target", "test"]);
  let syncCalls = 0;
  await assert.rejects(
    runCustomerUsageSyncOperator({
      options,
      environment: {
        SIDESTREAM_TEST_POSTGRES_URL: TEST_URL,
        SIDESTREAM_TELEMETRY_POSTGRES_URL:
          "postgres://reader:secret@localhost:5432/disposable_test",
      },
      createPool() {
        return fakePool({ databaseName: "disposable_test", namespace: "test" });
      },
      runSync() {
        syncCalls += 1;
      },
    }),
    /must be separate connected databases/,
  );
  assert.equal(syncCalls, 0);
});

test("operator checkpoint identity and mode-0600 atomic persistence survive resume", async () => {
  const identity = { namespace: "test", targetFingerprint: "pg-11111111111111111111" };
  const checkpoint = {
    version: 1,
    operation: CUSTOMER_360_BACKFILL_OPERATION,
    ...identity,
    backfill: { version: 3 },
  };
  assert.deepEqual(normalizeBackfillOperatorCheckpoint(checkpoint, identity), { version: 3 });
  assert.throws(
    () => normalizeBackfillOperatorCheckpoint(checkpoint, {
      ...identity,
      targetFingerprint: "pg-22222222222222222222",
    }),
    /does not match the connected target/,
  );

  const directory = await mkdtemp(path.join(os.tmpdir(), "sidestream-operator-checkpoint-"));
  const filename = path.join(directory, "checkpoint.json");
  try {
    await writeMode600JsonAtomic(filename, checkpoint);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), checkpoint);
    await writeMode600JsonAtomic(filename, { ...checkpoint, resumed: true });
    assert.equal(JSON.parse(await readFile(filename, "utf8")).resumed, true);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function fakePool({
  databaseName = "disposable_test",
  namespace = null,
  providerError = "",
  onConnect = () => {},
} = {}) {
  return {
    async connect() {
      onConnect();
      return {
        async query(sql) {
          if (providerError) throw new Error(providerError);
          if (sql.includes("current_database()")) {
            return { rows: [{ database_name: databaseName, server_port: "5432" }] };
          }
          if (sql.includes("to_regclass")) {
            return { rows: [{ profiles: namespace !== null, usage: false }] };
          }
          if (sql.includes("sidestream_customer_profiles")) {
            return { rows: namespace === null ? [] : [{ license_namespace: namespace }] };
          }
          throw new Error("unexpected guarded query");
        },
        release() {},
      };
    },
    async query() {
      return { rows: [{ source_freshness_at: "2026-08-01T12:00:00.000Z" }] };
    },
    async end() {},
  };
}

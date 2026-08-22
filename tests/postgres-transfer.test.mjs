import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  READ_ONLY_SNAPSHOT_SQL,
  TRANSFER_SOURCE_ENV,
  TRANSFER_TARGET_ENV,
  compareDatabaseSnapshots,
  createTransferPoolOptions,
  formatTransferReport,
  parseTransferArguments,
  quoteIdentifier,
  resolveTransferTargets,
  tableFingerprintSql,
} from "../scripts/verify-postgres-transfer.mjs";
import {
  classifyPortProbeOutcome,
  parsePortBoundaryArguments,
  probePublicPostgresPort,
} from "../scripts/verify-postgres-port-closed.mjs";

const STRUCTURE_SECTIONS = Object.freeze([
  "tables",
  "columns",
  "constraints",
  "indexes",
  "triggers",
  "policies",
  "functions",
  "views",
  "enums",
  "sequences",
  "exposed_table_privileges",
  "exposed_routine_privileges",
  "exposed_sequence_privileges",
]);

function snapshot(overrides = {}) {
  const structure = Object.fromEntries(
    STRUCTURE_SECTIONS.map((name) => [name, [{ name, contract: "same" }]]),
  );
  return {
    identity: {
      fingerprint: overrides.fingerprint || "pg-source",
      serverVersionNum: "170004",
      listenAddresses: "localhost",
      passwordEncryption: "scram-sha-256",
    },
    structure: { ...structure, ...(overrides.structure || {}) },
    migrationLedger: overrides.migrationLedger || [
      { filename: "20260814120000_example.sql", checksum_sha256: "a".repeat(64) },
    ],
    tableFingerprints: overrides.tableFingerprints || [
      { name: "public.sidestream_accounts", rowCount: "4", fingerprint: "b".repeat(64) },
      { name: "public.sidestream_licenses", rowCount: "3", fingerprint: "c".repeat(64) },
    ],
    sequences: overrides.sequences || [
      { name: "public.sidestream_sequence", lastValue: "9", isCalled: true },
    ],
  };
}

test("transfer verifier accepts only its bounded read-only CLI surface", () => {
  assert.deepEqual(parseTransferArguments([]), { help: false, json: false });
  assert.deepEqual(parseTransferArguments(["--json"]), { help: false, json: true });
  assert.deepEqual(parseTransferArguments(["--help"]), { help: true, json: false });
  assert.throws(() => parseTransferArguments(["--apply"]), /Unknown database-transfer option/);
  assert.match(READ_ONLY_SNAPSHOT_SQL, /repeatable read read only$/);
});

test("the transfer verifier contains no database mutation query", async () => {
  const source = await readFile(
    new URL("../scripts/verify-postgres-transfer.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /client\.query\(\s*[`'"]\s*(?:insert|update|delete|alter|drop|create|truncate|grant|revoke)\b/i,
  );
  assert.match(source, /client\.query\("rollback"\)/);
});

test("transfer targets require exact selectors, distinct databases, and a loopback target", () => {
  const targets = resolveTransferTargets({
    [TRANSFER_SOURCE_ENV]:
      "postgresql://source:source-secret@source.example.test:5432/sidestream?sslmode=verify-full",
    [TRANSFER_TARGET_ENV]:
      "postgresql://target:target-secret@127.0.0.1:5432/sidestream?sslmode=disable",
  });
  assert.equal(targets.source.local, false);
  assert.equal(targets.target.local, true);
  assert.notEqual(targets.source.fingerprint, targets.target.fingerprint);
  assert.doesNotMatch(JSON.stringify({
    source: targets.source.fingerprint,
    target: targets.target.fingerprint,
  }), /source-secret|target-secret/);

  assert.throws(() => resolveTransferTargets({
    [TRANSFER_SOURCE_ENV]: "postgresql://user:secret@127.0.0.1:5432/sidestream",
    [TRANSFER_TARGET_ENV]: "postgresql://user:secret@localhost:5432/sidestream",
  }), /different databases/);
  assert.throws(() => resolveTransferTargets({
    [TRANSFER_SOURCE_ENV]: "postgresql://user:secret@source.example.test/sidestream?sslmode=verify-full",
    [TRANSFER_TARGET_ENV]: "postgresql://user:secret@target.example.test/sidestream?sslmode=verify-full",
  }), /must use localhost/);
  assert.throws(() => resolveTransferTargets({
    [TRANSFER_SOURCE_ENV]: "postgresql://user:secret@source.example.test/sidestream?sslmode=verify-full",
    [TRANSFER_TARGET_ENV]: "postgresql://user:secret@localhost/postgres",
  }), /dedicated application database/);
});

test("remote transfer reads require authenticated TLS and every pool is read-only", () => {
  const remote = createTransferPoolOptions(
    "postgresql://user:secret@source.example.test/sidestream?sslmode=verify-full",
  );
  assert.deepEqual(remote.ssl, { rejectUnauthorized: true });
  assert.match(remote.options, /default_transaction_read_only=on/);
  assert.equal(remote.max, 1);
  assert.equal(remote.statement_timeout, 600_000);
  assert.throws(() => createTransferPoolOptions(
    "postgresql://user:secret@source.example.test/sidestream?sslmode=disable",
  ), /authenticated TLS/);
});

test("table fingerprints are order-independent, content-sensitive, and safely quoted", () => {
  assert.equal(quoteIdentifier('odd"name'), '"odd""name"');
  const sql = tableFingerprintSql("public", 'odd"table');
  assert.match(sql, /from "public"\."odd""table" row_value/);
  assert.match(sql, /row_to_json\(row_value\)::text/);
  assert.match(sql, /sum\(/);
  assert.match(sql, /minimum_hash/);
  assert.doesNotMatch(sql, /order by/);
});

test("matching snapshots pass with schema, ledger, data, and sequence evidence", () => {
  const source = snapshot({ fingerprint: "pg-source" });
  const target = snapshot({ fingerprint: "pg-target" });
  const report = compareDatabaseSnapshots(source, target);
  assert.equal(report.status, "pass");
  assert.equal(report.schema.matched, true);
  assert.equal(report.migrationLedger.matched, true);
  assert.equal(report.data.matched, true);
  assert.equal(report.data.sourceRows, "7");
  assert.equal(report.data.targetRows, "7");
  assert.equal(report.sequences.matched, true);
  assert.equal(report.targetSecurity.matched, true);
  assert.match(formatTransferReport(report), /Database transfer parity: PASS/);
});

test("any catalog, migration, row, or sequence drift fails with sanitized diagnostics", () => {
  const source = snapshot({ fingerprint: "pg-source" });
  const target = snapshot({
    fingerprint: "pg-target",
    structure: { columns: [{ name: "columns", contract: "changed" }] },
    migrationLedger: [],
    tableFingerprints: [
      { name: "public.sidestream_accounts", rowCount: "5", fingerprint: "d".repeat(64) },
    ],
    sequences: [
      { name: "public.sidestream_sequence", lastValue: "10", isCalled: true },
    ],
  });
  const report = compareDatabaseSnapshots(source, target);
  const output = formatTransferReport(report);
  assert.equal(report.status, "fail");
  assert.equal(report.schema.matched, false);
  assert.equal(report.migrationLedger.matched, false);
  assert.equal(report.data.matched, false);
  assert.equal(report.sequences.matched, false);
  assert.match(output, /mismatch schema:columns/);
  assert.match(output, /mismatch table:public\.sidestream_accounts rows=4\/5/);
  assert.match(output, /mismatch table:public\.sidestream_licenses rows=3\/missing/);
  assert.match(output, /mismatch sequence:public\.sidestream_sequence/);
  assert.doesNotMatch(output, /secret|postgresql:\/\//i);
});

test("a target listening beyond loopback or using legacy password hashes fails closed", () => {
  const source = snapshot({ fingerprint: "pg-source" });
  const target = snapshot({ fingerprint: "pg-target" });
  target.identity.listenAddresses = "*";
  target.identity.passwordEncryption = "md5";
  const report = compareDatabaseSnapshots(source, target);
  assert.equal(report.status, "fail");
  assert.deepEqual(report.targetSecurity.reasons, [
    "listen-addresses-not-loopback-only",
    "password-encryption-not-scram-sha-256",
  ]);
  assert.match(formatTransferReport(report), /target-security:listen-addresses-not-loopback-only/);
});

test("the public-port probe fails open ports and accepts only refusal or unreachable outcomes", async () => {
  assert.deepEqual(classifyPortProbeOutcome("connected"), { safe: false, outcome: "open" });
  assert.deepEqual(classifyPortProbeOutcome("ECONNREFUSED"), {
    safe: true,
    outcome: "not-reachable",
  });
  assert.deepEqual(classifyPortProbeOutcome("timeout"), {
    safe: true,
    outcome: "not-reachable",
  });
  assert.throws(() => classifyPortProbeOutcome("ENOTFOUND"), /inconclusive/);

  const open = await probePublicPostgresPort({
    host: "db.example.test",
    createConnection: fakeSocket("connect"),
  });
  assert.equal(open.safe, false);
  const closed = await probePublicPostgresPort({
    host: "db.example.test",
    createConnection: fakeSocket("error", { code: "ECONNREFUSED" }),
  });
  assert.equal(closed.safe, true);
});

test("the public-port CLI requires an external host and bounded controls", () => {
  assert.deepEqual(
    parsePortBoundaryArguments(["--host", "db.example.test"]),
    { host: "db.example.test", port: 5432, timeoutMs: 3_000, help: false },
  );
  assert.throws(
    () => parsePortBoundaryArguments(["--host", "127.0.0.1"]),
    /public hostname or IP/,
  );
  assert.throws(
    () => parsePortBoundaryArguments(["--host", "db.example.test", "--port", "70000"]),
    /between 1 and 65535/,
  );
  assert.throws(
    () => parsePortBoundaryArguments(["--host", "https:\/\/db.example.test"]),
    /one public hostname or IP/,
  );
});

function fakeSocket(event, value) {
  return () => {
    const socket = new EventEmitter();
    socket.setTimeout = () => {};
    socket.destroy = () => {};
    queueMicrotask(() => socket.emit(event, value));
    return socket;
  };
}

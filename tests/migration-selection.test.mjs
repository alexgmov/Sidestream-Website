import assert from "node:assert/strict";
import test from "node:test";
import {
  MIGRATION_PRODUCTION_CONFIRMATION,
  loadMigrationFiles,
  parseMigrationOperatorArguments,
  selectPendingMigrations,
  validateMigrationFiles,
} from "../scripts/apply-postgres-migrations.mjs";

const ONLY = "20261103120000_add_selected_upgrade_plans.sql";
const PREREQUISITE = "20260825140000_add_annual_upgrade_pricing_experiment.sql";
const UNRELATED = "20261013190000_add_ugc_link_arrivals.sql";
const migrations = validateMigrationFiles(await loadMigrationFiles());
const ledger = migrations.filter(({ filename }) => ![ONLY, UNRELATED].includes(filename))
  .map(({ filename, checksum }) => ({ filename, checksum_sha256: checksum }));

test("exact bounded apply parses both forms and retains Production confirmations", () => {
  for (const args of [["--only", ONLY], [`--only=${ONLY}`]]) {
    const options = parseMigrationOperatorArguments(["--target", "test", ...args]);
    assert.equal(options.mode, "apply");
    assert.equal(options.only, ONLY);
  }
  assert.throws(() => parseMigrationOperatorArguments(["--only", ONLY]), /explicit --target/);
  assert.throws(() => parseMigrationOperatorArguments([
    "--target", "production", "--only", ONLY,
  ]), /confirm-operation/);
  assert.throws(() => parseMigrationOperatorArguments([
    "--target", "production", "--only", ONLY,
    "--confirm-operation", MIGRATION_PRODUCTION_CONFIRMATION,
  ]), /confirm-target/);
  const production = parseMigrationOperatorArguments([
    "--target", "production", "--only", ONLY,
    "--confirm-operation", MIGRATION_PRODUCTION_CONFIRMATION,
    "--confirm-target", "pg-connected-fingerprint",
  ]);
  assert.equal(production.targetUrlEnv, "SIDESTREAM_POSTGRES_URL_NON_POOLING");
  assert.equal(production.only, ONLY);
});

test("bounded selection rejects other modes, duplicate flags, empty and nonallowlisted names", () => {
  for (const mode of ["--status", "--baseline", "--validate", "--dry-run", "--help"]) {
    assert.throws(() => parseMigrationOperatorArguments([
      "--target", "test", mode, "--only", ONLY,
    ]), /only when applying/);
  }
  for (const name of [UNRELATED, "missing.sql", `db/migrations/${ONLY}`, `${ONLY},${UNRELATED}`]) {
    assert.throws(() => parseMigrationOperatorArguments([
      "--target", "test", "--only", name,
    ]), /not approved for --only/);
  }
  assert.throws(() => parseMigrationOperatorArguments(["--target", "test", "--only"]), /requires a value/);
  assert.throws(() => parseMigrationOperatorArguments(["--target", "test", "--only="]), /requires a value/);
  assert.throws(() => parseMigrationOperatorArguments([
    "--target", "test", "--only", ONLY, "--only", ONLY,
  ]), /only once/);
});

test("bounded selection skips unrelated pending files and is idempotent", () => {
  assert.deepEqual(selectPendingMigrations(migrations, ledger, ONLY).map(({ filename }) => filename), [ONLY]);
  assert.deepEqual(selectPendingMigrations(migrations, ledger).map(({ filename }) => filename), [UNRELATED, ONLY]);
  const selected = migrations.find(({ filename }) => filename === ONLY);
  assert.deepEqual(selectPendingMigrations(migrations, [
    ...ledger, { filename: ONLY, checksum_sha256: selected.checksum },
  ], ONLY), []);
});

test("bounded selection requires the exact local file and applied prerequisite", () => {
  assert.throws(() => selectPendingMigrations(
    migrations.filter(({ filename }) => filename !== ONLY), ledger, ONLY,
  ), /Selected migration file is missing/);
  assert.throws(() => selectPendingMigrations(
    migrations, ledger.filter(({ filename }) => filename !== PREREQUISITE), ONLY,
  ), /requires an applied prerequisite/);
  assert.throws(() => selectPendingMigrations(migrations, ledger, UNRELATED), /not approved for --only/);
});

test("bounded selection still rejects drift, missing files and duplicates anywhere in the ledger", () => {
  const unrelatedApplied = ledger[0];
  assert.throws(() => selectPendingMigrations(migrations, ledger.map((row) =>
    row === unrelatedApplied ? { ...row, checksum_sha256: "0".repeat(64) } : row
  ), ONLY), /checksum drift detected/);
  assert.throws(() => selectPendingMigrations(migrations, [
    ...ledger, { filename: "20000101000000_missing.sql", checksum_sha256: "0".repeat(64) },
  ], ONLY), /missing file/);
  assert.throws(() => selectPendingMigrations(migrations, [...ledger, unrelatedApplied], ONLY), /Duplicate migration ledger row/);
  assert.throws(() => validateMigrationFiles(migrations.map((migration, index) =>
    index === 0 ? { ...migration, checksum: "0".repeat(64) } : migration
  )), /Known baseline migration checksum drift/);
});

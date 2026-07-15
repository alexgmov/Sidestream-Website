import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  classifyMigrationState,
  loadMigrationFiles,
  migrationSqlForTransaction,
  parseMigrationArguments,
  selectMigrationDatabase,
  validateMigrationFiles,
} from "../scripts/apply-postgres-migrations.mjs";
import {
  ACTIVATION_ROTATION_MIGRATION,
  KNOWN_PRE_20260713_COLUMNS,
  KNOWN_PRE_20260713_REQUIRED_CONSTRAINTS,
  KNOWN_PRE_20260713_REQUIRED_INDEXES,
  verifyMigrationBaselineSnapshot,
} from "../scripts/verify-migration-baseline.mjs";

function knownBaselineSnapshot(rowSecurityEnabled = false) {
  return {
    tables: Object.keys(KNOWN_PRE_20260713_COLUMNS).sort().map((name) => ({
      name,
      rowSecurityEnabled,
    })),
    columns: Object.entries(KNOWN_PRE_20260713_COLUMNS).flatMap(
      ([table, columns]) => columns.map((signature) => {
        const [name, type, nullable] = signature.split(":");
        return { table, name, type, nullable };
      }),
    ),
    constraints: [...KNOWN_PRE_20260713_REQUIRED_CONSTRAINTS],
    indexes: [...KNOWN_PRE_20260713_REQUIRED_INDEXES],
  };
}

test("migration files are ordered, checksummed, and append-only baseline files are pinned", async () => {
  const migrations = validateMigrationFiles(await loadMigrationFiles());
  assert.equal(migrations.length, 21);
  assert.deepEqual(
    migrations.map((migration) => migration.filename),
    [...migrations.map((migration) => migration.filename)].sort(),
  );
  assert.ok(migrations.every((migration) => /^[0-9a-f]{64}$/.test(migration.checksum)));
  assert.ok(migrations.some((migration) => migration.filename === ACTIVATION_ROTATION_MIGRATION));
  assert.ok(migrations.some((migration) =>
    migration.filename === "20260713200000_add_api_operational_controls.sql"
  ));
  for (const filename of [
    "20260713201000_enforce_activation_credential_invariants.sql",
    "20260713202000_harden_stripe_event_processing.sql",
    "20260713203000_add_checkout_intents.sql",
    "20260713204000_add_entitlement_lifecycle.sql",
    "20260713205000_harden_download_leads.sql",
    "20260713206000_add_maintenance_indexes.sql",
    "20260714200000_remove_redundant_download_lead_key_unique.sql",
    "20260715120000_add_customer_360_core.sql",
    "20260715121000_add_customer_identity_links.sql",
    "20260715122000_add_customer_commerce_ledger.sql",
  ]) {
    assert.ok(migrations.some((migration) => migration.filename === filename));
  }
});

test("Customer commerce migration keeps money currency-separated and entitlement-independent", async () => {
  const migration = await readFile(new URL(
    "../db/migrations/20260715122000_add_customer_commerce_ledger.sql",
    import.meta.url,
  ), "utf8");
  assert.match(migration, /create table public\.sidestream_customer_commerce_materializations/);
  assert.match(migration, /create table public\.sidestream_customer_commerce_invoice_payments/);
  assert.match(migration, /create table public\.sidestream_customer_money_totals/);
  assert.match(migration, /primary key \(license_namespace, profile_id, currency\)/);
  for (const column of [
    "gross_paid_minor",
    "discount_minor",
    "tax_minor",
    "off_stripe_paid_minor",
    "refunded_minor",
    "disputed_minor",
    "inquiry_minor",
    "net_paid_minor",
    "billing_period_start",
    "billing_period_end",
    "first_inferred_paid_at",
    "last_inferred_paid_at",
    "first_inferred_upgraded_at",
    "last_inferred_upgraded_at",
    "source_confidence",
    "identity_conflict",
  ]) {
    assert.match(migration, new RegExp(`\\b${column}\\b`));
  }
  assert.doesNotMatch(migration, /update public\.sidestream_licenses/i);
  assert.doesNotMatch(migration, /alter table public\.sidestream_licenses/i);
  assert.match(migration, /Mutable latest-state money materializations/);
  assert.match(migration, /insert-only event_id, event_type, and stripe_created_at/);
  assert.match(migration, /processing state is mutable/);
  assert.match(migration, /payload fields may be redacted/);
  assert.doesNotMatch(migration, /immutable signed-event history/i);
  assert.doesNotMatch(migration, /max\(fact\.gross_paid_minor\)/i);
  assert.match(migration, /source_object_type in \('payment_intent', 'charge'\)/);
  assert.match(migration, /edge\.status = 'paid'/);
  assert.match(migration, /off_stripe_paid_minor bigint not null default 0/);
  assert.match(migration, /off_stripe_paid_minor <= gross_paid_minor/);
  assert.match(migration, /ranked_fallbacks as/);
  assert.match(migration, /fact\.source_object_type in \('checkout_session', 'invoice'\)/);
  assert.match(migration, /sidestream_customer_commerce_reconcile_namespace/);
  assert.match(migration, /fact\.had_conflict and not allow_conflict_clear/);
});

test("ledger classification reports pending files and rejects every checksum mismatch", async () => {
  const migrations = validateMigrationFiles(await loadMigrationFiles());
  const first = migrations[0];
  const statuses = classifyMigrationState(migrations, [{
    filename: first.filename,
    checksum_sha256: first.checksum,
    applied_at: new Date(),
    duration_ms: 12,
  }]);
  assert.equal(statuses[0].status, "applied");
  assert.ok(statuses.slice(1).every((status) => status.status === "pending"));
  assert.throws(() => classifyMigrationState(migrations, [{
    filename: first.filename,
    checksum_sha256: "0".repeat(64),
  }]), /checksum drift detected/);
  assert.throws(() => classifyMigrationState(migrations, [{
    filename: "20000101000000_deleted.sql",
    checksum_sha256: "0".repeat(64),
  }]), /missing file/);
});

test("known production baseline is exact and never marks activation rotation as applied", () => {
  const beforeRls = verifyMigrationBaselineSnapshot(knownBaselineSnapshot(false));
  assert.equal(beforeRls.profile, "known-pre-20260713-before-rls");
  assert.ok(beforeRls.pendingMigrations.includes(ACTIVATION_ROTATION_MIGRATION));
  assert.ok(!beforeRls.appliedMigrations.includes(ACTIVATION_ROTATION_MIGRATION));

  const withRls = verifyMigrationBaselineSnapshot(knownBaselineSnapshot(true));
  assert.equal(withRls.profile, "known-pre-20260713-with-rls");
  assert.ok(withRls.appliedMigrations.includes(
    "20260707120000_enable_sidestream_server_table_rls.sql",
  ));
  assert.ok(withRls.pendingMigrations.includes(ACTIVATION_ROTATION_MIGRATION));
});

test("baseline refuses unknown tables, columns, missing constraints, and unknown RLS drift", () => {
  const extraTable = knownBaselineSnapshot(false);
  extraTable.tables.push({ name: "sidestream_unknown", rowSecurityEnabled: false });
  assert.throws(() => verifyMigrationBaselineSnapshot(extraTable), /tables unexpected/);

  const activationAlreadyChanged = knownBaselineSnapshot(false);
  activationAlreadyChanged.columns.push({
    table: "sidestream_activation_sessions",
    name: "stripe_checkout_session_id",
    type: "text",
    nullable: "YES",
  });
  assert.throws(() => verifyMigrationBaselineSnapshot(activationAlreadyChanged), /columns unexpected/);

  const missingConstraint = knownBaselineSnapshot(false);
  missingConstraint.constraints = missingConstraint.constraints.slice(1);
  assert.throws(() => verifyMigrationBaselineSnapshot(missingConstraint), /constraints missing/);

  const mixedRls = knownBaselineSnapshot(false);
  mixedRls.tables.find((table) => table.name === "sidestream_accounts").rowSecurityEnabled = true;
  assert.throws(() => verifyMigrationBaselineSnapshot(mixedRls), /Row-level-security state/);
});

test("CLI operations are mutually exclusive and migration URLs prefer direct endpoints", () => {
  assert.equal(parseMigrationArguments([]), "apply");
  assert.equal(parseMigrationArguments(["--status"]), "status");
  assert.equal(parseMigrationArguments(["--validate"]), "validate");
  assert.equal(parseMigrationArguments(["--baseline"]), "baseline");
  assert.throws(() => parseMigrationArguments(["--status", "--baseline"]), /only one/);
  assert.throws(() => parseMigrationArguments(["--mystery"]), /Unknown migration option/);

  const selected = selectMigrationDatabase({
    SIDESTREAM_POSTGRES_URL: "postgres://pooled:secret@pool.invalid/app",
    POSTGRES_URL_NON_POOLING: "postgres://direct:secret@db.invalid/app",
  });
  assert.equal(selected.environmentVariable, "POSTGRES_URL_NON_POOLING");
  assert.equal(selected.direct, true);
});

test("runner holds one global lock and persists each ledger row with its migration transaction", async () => {
  const source = await readFile(new URL(
    "../scripts/apply-postgres-migrations.mjs",
    import.meta.url,
  ), "utf8");
  const lock = source.indexOf('client.query("select pg_advisory_lock(hashtext($1))"');
  const loop = source.indexOf("for (const migration of statuses.filter");
  const begin = source.indexOf('client.query("begin")', loop);
  const sql = source.indexOf(
    "client.query(migrationSqlForTransaction(migration.sql))",
    begin,
  );
  const ledger = source.indexOf(`insert into \${MIGRATION_LEDGER}`, sql);
  const commit = source.indexOf('client.query("commit")', ledger);
  assert.ok(lock >= 0 && loop > lock && begin > loop && sql > begin && ledger > sql && commit > ledger);
  assert.match(source, /Migration checksum drift detected/);
  assert.match(source, /explicit --baseline/);
  assert.equal(
    migrationSqlForTransaction("begin;\nselect 1;\ncommit;"),
    "select 1;\n",
  );
  assert.equal(migrationSqlForTransaction("select 1;"), "select 1;");
});

test("operational migration defines the immutable ledger contract and supporting indexes", async () => {
  const migration = await readFile(new URL(
    "../db/migrations/20260713200000_add_api_operational_controls.sql",
    import.meta.url,
  ), "utf8");
  assert.match(migration, /create table if not exists public\.sidestream_schema_migrations/);
  assert.match(migration, /filename text primary key/);
  assert.match(migration, /checksum_sha256 text not null/);
  assert.match(migration, /applied_at timestamptz not null/);
  assert.match(migration, /duration_ms bigint not null/);
  assert.match(migration, /sidestream_schema_migrations_applied_idx/);
});

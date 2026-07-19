import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  classifyMigrationState,
  buildMigrationApprovalMessage,
  loadMigrationFiles,
  migrationSetFingerprint,
  migrationSqlForTransaction,
  parseMigrationArguments,
  selectMigrationDatabase,
  validateMigrationFiles,
  verifyMigrationApproval,
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
  assert.equal(migrations.length, 25);
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
    "20260715123000_add_customer_usage_aggregates.sql",
    "20260715124000_add_customer_360_read_model.sql",
    "20260717230000_add_stripe_event_recovery_audit.sql",
    "20260719120000_remediate_customer_360_final_audit.sql",
  ]) {
    assert.ok(migrations.some((migration) => migration.filename === filename));
  }
});

test("Customer query migration exposes only compact live read models", async () => {
  const migration = await readFile(new URL(
    "../db/migrations/20260715124000_add_customer_360_read_model.sql",
    import.meta.url,
  ), "utf8");
  assert.match(migration, /create function public\.sidestream_customer_360_profile_read_model\(\)/);
  assert.match(migration, /create function public\.sidestream_customer_360_money_read_model\(\)/);
  assert.match(migration, /security invoker/);
  assert.match(migration, /stable/);
  assert.match(migration, /where profile\.merged_into is null/);
  assert.match(migration, /first_download_success_at as first_download_succeeded_at/);
  assert.match(migration, /download_success_count as download_outcome_numerator/);
  assert.match(migration, /download_outcome_count as download_outcome_denominator/);
  assert.match(migration, /usage_source_freshness_at/);
  assert.match(migration, /data_quality_flags/);
  assert.match(migration, /revoke all on function .* from public/);
  assert.doesNotMatch(migration, /payload|data_points|search_query|install_id_hash|link_value/i);
});

test("Customer usage migration stores private UTC aggregates without raw telemetry", async () => {
  const migration = await readFile(new URL(
    "../db/migrations/20260715123000_add_customer_usage_aggregates.sql",
    import.meta.url,
  ), "utf8");
  assert.match(migration, /create table public\.sidestream_customer_usage_daily/);
  assert.match(migration, /create table public\.sidestream_customer_usage_sync_state/);
  assert.match(migration, /primary key \(license_namespace, install_id_hash, activity_day\)/);
  assert.match(migration, /checkpoint_received_at timestamptz/);
  assert.match(migration, /checkpoint_telemetry_event_id text/);
  assert.match(migration, /enable row level security/);
  for (const column of [
    "first_app_use_at",
    "last_app_use_at",
    "first_download_attempt_at",
    "last_download_attempt_at",
    "first_download_success_at",
    "last_download_success_at",
    "download_attempt_count",
    "download_outcome_count",
    "download_success_count",
    "download_failure_count",
    "download_cancelled_count",
    "download_pending_count",
    "download_unknown_count",
    "usage_active_days_count",
    "usage_active_days_7",
    "usage_active_days_30",
    "download_frequency_30d",
    "usage_install_count",
    "usage_synced_at",
    "usage_source_freshness_at",
  ]) {
    assert.match(migration, new RegExp(`\\b${column}\\b`));
  }
  assert.doesNotMatch(migration, /\bjsonb?\b/i);
  assert.doesNotMatch(migration, /search[_ ]?(?:text|query)|user[_ ]?agent|ip_address|url|title/i);
  assert.doesNotMatch(migration, /gmail_campaign_hash/i);
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
  assert.equal(parseMigrationArguments([]), "validate");
  assert.equal(parseMigrationArguments(["--apply"]), "apply");
  assert.equal(parseMigrationArguments(["--status"]), "status");
  assert.equal(parseMigrationArguments(["--validate"]), "validate");
  assert.equal(parseMigrationArguments(["--baseline"]), "baseline");
  assert.throws(() => parseMigrationArguments(["--status", "--baseline"]), /only one/);
  assert.throws(() => parseMigrationArguments(["--mystery"]), /Unknown migration option/);

  const selected = selectMigrationDatabase({
    POSTGRES_URL_NON_POOLING: "postgres://direct:secret@db.invalid/app",
  });
  assert.equal(selected.environmentVariable, "POSTGRES_URL_NON_POOLING");
  assert.equal(selected.direct, true);
  assert.throws(() => selectMigrationDatabase({
    SIDESTREAM_POSTGRES_URL: "postgres://pooled:secret@pool.invalid/app",
    POSTGRES_URL_NON_POOLING: "postgres://direct:secret@db.invalid/app",
  }), /ambiguous/);
});

test("migration mutation approval binds Test, target, set, candidate, mode, and expiry", async () => {
  const migrations = validateMigrationFiles(await loadMigrationFiles());
  const targetFingerprint = "1".repeat(64);
  const setFingerprint = migrationSetFingerprint(migrations);
  const candidateSha = "3".repeat(40);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
  const secret = "migration-approval-secret-with-at-least-32-bytes";
  const approval = {
    mode: "apply",
    targetFingerprint,
    migrationSetFingerprint: setFingerprint,
    candidateSha,
    expiresAt,
  };
  const environment = {
    SIDESTREAM_MIGRATION_TARGET_FINGERPRINT: targetFingerprint,
    SIDESTREAM_MIGRATION_SET_FINGERPRINT: setFingerprint,
    SIDESTREAM_MIGRATION_CANDIDATE_SHA: candidateSha,
    SIDESTREAM_MIGRATION_NAMESPACE: "test",
    SIDESTREAM_MIGRATION_APPROVAL_EXPIRES_AT: expiresAt,
    SIDESTREAM_MIGRATION_APPROVAL_SECRET: secret,
    SIDESTREAM_MIGRATION_CONFIRM:
      `MIGRATE_TEST:apply:${targetFingerprint.slice(0, 12)}:${
        setFingerprint.slice(0, 12)
      }:${candidateSha}`,
  };
  environment.SIDESTREAM_MIGRATION_APPROVAL_TOKEN = createHmac("sha256", secret)
    .update(buildMigrationApprovalMessage(approval))
    .digest("hex");

  assert.doesNotThrow(() => verifyMigrationApproval(approval, environment));
  for (const mutation of [
    { SIDESTREAM_MIGRATION_NAMESPACE: "production" },
    { SIDESTREAM_MIGRATION_TARGET_FINGERPRINT: "4".repeat(64) },
    { SIDESTREAM_MIGRATION_SET_FINGERPRINT: "5".repeat(64) },
    { SIDESTREAM_MIGRATION_CANDIDATE_SHA: "6".repeat(40) },
    { SIDESTREAM_MIGRATION_CONFIRM: "MIGRATE_TEST:apply:wrong" },
    { SIDESTREAM_MIGRATION_APPROVAL_TOKEN: "0".repeat(64) },
  ]) {
    assert.throws(() => verifyMigrationApproval(approval, {
      ...environment,
      ...mutation,
    }));
  }
  assert.throws(() => verifyMigrationApproval({ ...approval, mode: "baseline" }, environment));
  assert.throws(() => verifyMigrationApproval({
    ...approval,
    expiresAt: new Date(Date.now() + 25 * 60 * 60 * 1_000).toISOString(),
  }, {
    ...environment,
    SIDESTREAM_MIGRATION_APPROVAL_EXPIRES_AT:
      new Date(Date.now() + 25 * 60 * 60 * 1_000).toISOString(),
  }));
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

test("Stripe recovery migration is append-only, immutable, Test-only, and digest-bound", async () => {
  const migration = await readFile(new URL(
    "../db/migrations/20260717230000_add_stripe_event_recovery_audit.sql",
    import.meta.url,
  ), "utf8");
  const auditTable = migration.slice(
    migration.indexOf("create table public.sidestream_stripe_event_recovery_audit"),
    migration.indexOf("comment on table public.sidestream_stripe_event_recovery_audit"),
  );

  assert.match(migration, /create table public\.sidestream_stripe_event_recovery_audit/);
  assert.match(migration, /request_digest text not null unique/);
  assert.match(migration, /event_reference_digest text not null/);
  assert.match(migration, /payload_digest text not null/);
  assert.match(migration, /target_fingerprint text not null/);
  assert.match(migration, /check \(license_namespace = 'test'\)/);
  assert.match(migration, /check \(prior_processing_status = 'dead_letter'\)/);
  assert.match(migration, /check \(prior_attempt_count = 8\)/);
  assert.match(migration, /pending_recovery_audit_id uuid/);
  assert.match(migration, /references public\.sidestream_stripe_event_recovery_audit\(id\)/);
  assert.match(migration, /on delete restrict/);
  assert.match(migration, /attempt_count = 9/);
  assert.match(migration, /sidestream_stripe_events_pending_recovery_audit_unique/);
  assert.match(migration, /before update or delete on public\.sidestream_stripe_event_recovery_audit/);
  assert.match(migration, /before truncate on public\.sidestream_stripe_event_recovery_audit/);
  assert.match(migration, /sidestream_stripe_event_recovery_audit is immutable/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all privileges .* from public/);
  assert.doesNotMatch(auditTable, /\bevent_id\b|raw_payload|\bpayload jsonb\b|customer_id|stripe_customer/i);
  assert.doesNotMatch(migration, /update public\.sidestream_licenses/i);
  assert.doesNotMatch(migration, /alter table public\.sidestream_licenses/i);
  assert.doesNotMatch(
    migration,
    /delete\s+from\s+public\.sidestream_stripe_event_recovery_audit/i,
  );
});

test("final audit remediation binds database identity, ingress, and migration evidence", async () => {
  const migration = await readFile(new URL(
    "../db/migrations/20260719120000_remediate_customer_360_final_audit.sql",
    import.meta.url,
  ), "utf8");
  const runner = await readFile(new URL(
    "../scripts/apply-postgres-migrations.mjs",
    import.meta.url,
  ), "utf8");

  assert.match(migration, /create table public\.sidestream_database_identity/);
  assert.match(migration, /environment in \('production', 'test'\)/);
  assert.doesNotMatch(migration, /insert into public\.sidestream_database_identity/i);
  assert.match(migration, /sidestream_database_identity_no_truncate/);
  assert.match(migration, /sidestream_customer_profile_merges_no_truncate/);
  assert.match(migration, /sidestream_customer_identity_reviews_no_truncate/);
  assert.match(migration, /before update of event_id, event_type, stripe_created_at, payload, raw_payload/);
  for (const column of [
    "ingress_event_id",
    "ingress_event_type",
    "ingress_created",
    "ingress_livemode",
    "ingress_api_version",
    "ingress_payload_sha256",
    "ingress_raw_sha256",
    "recovery_runner_token",
    "recovery_runner_lease_expires_at",
    "recovery_runner_epoch",
  ]) {
    assert.match(migration, new RegExp(`\\b${column}\\b`));
  }
  assert.match(migration, /create table public\.sidestream_migration_attestations/);
  assert.match(migration, /sidestream_schema_migrations_no_truncate/);
  assert.match(migration, /sidestream_migration_attestations_no_truncate/);
  assert.match(runner, /assertPendingCreateTargetsAbsent/);
  assert.match(runner, /to_regclass\(\$1\)/);
  assert.match(runner, /attestMigrationSet/);
  assert.match(runner, /Migration attestation target or migration-set fingerprint mismatch/);
});

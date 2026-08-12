import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MIGRATION_PRODUCTION_CONFIRMATION,
  classifyMigrationState,
  loadMigrationFiles,
  migrationSqlForTransaction,
  parseMigrationArguments,
  parseMigrationOperatorArguments,
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
  assert.equal(migrations.length, 32);
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
    "20260727010000_add_paid_acquisition_experiment.sql",
    "20260728090000_update_paid_acquisition_price.sql",
    "20260728093000_make_paid_price_constraint_amount_agnostic.sql",
    "20260729010000_allow_two_active_account_devices.sql",
    "20260729120000_add_regional_checkout_offer_snapshots.sql",
    "20260803120000_add_acquisition_integrity.sql",
    "20260810120000_bind_paid_telemetry_profile.sql",
    "20260812120000_add_upgrade_pricing_experiment.sql",
  ]) {
    assert.ok(migrations.some((migration) => migration.filename === filename));
  }
});

test("Upgrade pricing migration is permanent, complete, private, and append-only", async () => {
  const migration = await readFile(new URL(
    "../db/migrations/20260812120000_add_upgrade_pricing_experiment.sql",
    import.meta.url,
  ), "utf8");
  assert.match(migration, /create table public\.sidestream_upgrade_pricing_assignments/);
  assert.match(migration, /create table public\.sidestream_upgrade_pricing_exposures/);
  assert.match(migration, /unique \(experiment_id, account_id\)/);
  assert.match(migration, /assignment_bucket between 0 and 9999/);
  assert.match(migration, /rollout_basis_points between 0 and 10000/);
  assert.match(migration, /variant = 'control_one_time' and billing_model = 'one_time'/);
  assert.match(migration, /variant = 'monthly_half' and billing_model = 'subscription'/);
  assert.match(migration, /assigned_at timestamptz not null/);
  assert.match(migration, /exposed_at timestamptz not null/);
  assert.match(migration, /unique \(experiment_id, checkout_intent_id\)/);
  assert.match(migration, /stripe_checkout_session_id is not null/);
  assert.match(migration, /new\.assignment_id is null/);
  assert.match(migration, /intent\.upgrade_pricing_decision_reason in/);
  assert.match(migration, /before update or delete on public\.sidestream_upgrade_pricing_assignments/);
  assert.match(migration, /before update or delete on public\.sidestream_upgrade_pricing_exposures/);
  assert.match(migration, /before update on public\.sidestream_checkout_intents/);
  assert.match(migration, /upgrade_pricing_snapshot_version is null/);
  assert.match(migration, /upgrade_pricing_snapshot_version = 1/);
  for (const column of [
    "upgrade_pricing_experiment_id",
    "upgrade_pricing_decision_reason",
    "upgrade_pricing_assignment_id",
    "upgrade_pricing_assignment_bucket",
    "upgrade_pricing_rollout_basis_points",
    "upgrade_pricing_assigned_at",
    "upgrade_pricing_variant",
    "upgrade_pricing_billing_model",
    "upgrade_pricing_country",
    "upgrade_pricing_currency",
    "upgrade_pricing_amount_minor",
    "upgrade_pricing_stripe_product_id",
    "upgrade_pricing_stripe_price_id",
    "upgrade_pricing_account_id",
    "upgrade_pricing_acquisition_id",
    "upgrade_pricing_checkout_intent_id",
    "upgrade_pricing_activation_session_id",
  ]) {
    assert.match(migration, new RegExp(`\\b${column}\\b`));
  }
  assert.match(migration, /upgrade_pricing_checkout_intent_id = id/);
  assert.match(migration, /upgrade_pricing_account_id = account_id/);
  assert.match(migration, /upgrade_pricing_acquisition_id = acquisition_id/);
  assert.match(
    migration,
    /upgrade_pricing_activation_session_id is not distinct from activation_session_id/,
  );
  assert.match(migration, /sidestream_checkout_intents_upgrade_pricing_reporting_idx/);
  assert.match(migration, /sidestream_upgrade_pricing_assignments_reporting_idx/);
  assert.match(migration, /sidestream_upgrade_pricing_exposures_reporting_idx/);
  assert.equal((migration.match(/enable row level security/g) || []).length, 2);
  assert.match(migration, /revoke all on table public\.sidestream_upgrade_pricing_assignments from public/);
  assert.match(migration, /revoke all on table public\.sidestream_upgrade_pricing_exposures from public/);
  assert.match(migration, /array\['anon', 'authenticated'\]/);
  assert.doesNotMatch(
    migration,
    /\b(email|raw_ip|ip_address|cookie|activation_key|device_id|payment_secret|client_secret)\b/i,
  );
});

test("paid telemetry binding is exact, immutable, private, and replay-safe", async () => {
  const migration = await readFile(new URL(
    "../db/migrations/20260810120000_bind_paid_telemetry_profile.sql",
    import.meta.url,
  ), "utf8");
  assert.match(
    migration,
    /create table public\.sidestream_paid_telemetry_profile_bindings/,
  );
  for (const column of [
    "claim_id",
    "acquisition_id",
    "account_id",
    "activation_ref",
    "install_membership_id",
    "install_id_hash",
    "installer_receipt_identity_link_id",
    "installer_receipt_id_hash",
    "binding_key",
  ]) {
    assert.match(migration, new RegExp(`\\b${column}\\b`));
  }
  assert.match(migration, /unique \(license_namespace, binding_key\)/);
  assert.match(migration, /before insert on public\.sidestream_paid_telemetry_profile_bindings/);
  assert.match(migration, /before update or delete on public\.sidestream_paid_telemetry_profile_bindings/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on table .* from public/);
  assert.doesNotMatch(
    migration,
    /\b(raw_ip|ip_address|user_agent|email|display_name|campaign|referrer)\b/i,
  );
});

test("acquisition migration requires future Checkout linkage without inferring history", async () => {
  const migration = await readFile(new URL(
    "../db/migrations/20260803120000_add_acquisition_integrity.sql",
    import.meta.url,
  ), "utf8");
  assert.match(migration, /create table public\.sidestream_acquisitions/);
  assert.match(migration, /create table public\.sidestream_acquisition_stages/);
  assert.match(migration, /create table public\.sidestream_acquisition_conflicts/);
  assert.match(migration, /Historical intents deliberately stay null/);
  assert.match(migration, /before insert on public\.sidestream_checkout_intents/i);
  assert.match(migration, /New Checkout intents require a canonical acquisition/);
  assert.match(migration, /unique \(license_namespace, stage, deduplication_key\)/);
  for (const [stage, grain] of [
    ["landing_observed", "acquisition"],
    ["email_handoff_created", "delivery_handoff"],
    ["installer_requested", "installer_request"],
    ["installation_claimed", "installation"],
    ["authentication_completed", "authentication"],
    ["checkout_started", "checkout_intent"],
    ["checkout_completed", "checkout_session"],
    ["payment_settled", "payment"],
    ["refunded", "refund"],
    ["disputed", "dispute"],
  ]) {
    assert.match(migration, new RegExp(`stage = '${stage}' and counting_grain = '${grain}'`));
  }
  assert.doesNotMatch(
    migration,
    /\b(raw_ip|ip_address|user_agent|cookie|email|stripe_payload|telemetry_payload|install_hash|receipt_hash)\b/i,
  );
});

test("regional checkout snapshots are all-null or structurally complete", async () => {
  const migration = await readFile(new URL(
    "../db/migrations/20260729120000_add_regional_checkout_offer_snapshots.sql",
    import.meta.url,
  ), "utf8");
  for (const column of [
    "offer_id",
    "offer_country",
    "offer_currency",
    "offer_amount_minor",
    "offer_stripe_product_id",
    "offer_stripe_price_id",
  ]) {
    assert.match(migration, new RegExp(`${column} is null`));
    assert.match(migration, new RegExp(`${column} is not null`));
  }
  assert.match(migration, /offer_country ~ '\^\[A-Z\]\{2\}\$'/);
  assert.match(migration, /offer_currency ~ '\^\[a-z\]\{3\}\$'/);
  assert.match(migration, /offer_amount_minor > 0/);
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

test("CLI operations are mutually exclusive and migration URLs use exact named selectors", () => {
  assert.equal(parseMigrationArguments([]), "apply");
  assert.equal(parseMigrationArguments(["--status"]), "status");
  assert.equal(parseMigrationArguments(["--validate"]), "validate");
  assert.equal(parseMigrationArguments(["--baseline"]), "baseline");
  assert.throws(() => parseMigrationArguments(["--status", "--baseline"]), /only one/);
  assert.throws(() => parseMigrationArguments(["--mystery"]), /Unknown migration option/);

  assert.throws(
    () => parseMigrationOperatorArguments(["--status"]),
    /explicit --target/,
  );
  const status = parseMigrationOperatorArguments(["--status", "--target", "production"]);
  assert.equal(status.targetUrlEnv, "SIDESTREAM_POSTGRES_URL_NON_POOLING");
  assert.throws(
    () => parseMigrationOperatorArguments(["--target", "production"]),
    /confirm-operation/,
  );
  assert.throws(
    () => parseMigrationOperatorArguments([
      "--target", "production", "--confirm-operation", MIGRATION_PRODUCTION_CONFIRMATION,
    ]),
    /confirm-target/,
  );
  assert.throws(
    () => parseMigrationOperatorArguments([
      "--status", "--target", "production", "--target-url-env", "POSTGRES_URL_NON_POOLING",
    ]),
    /may use only SIDESTREAM_POSTGRES_URL_NON_POOLING/,
  );

  const selected = selectMigrationDatabase({
    SIDESTREAM_POSTGRES_URL_NON_POOLING:
      "postgres://direct:secret@db.invalid/app?sslmode=require",
  }, "production", "SIDESTREAM_POSTGRES_URL_NON_POOLING");
  assert.equal(selected.environmentVariable, "SIDESTREAM_POSTGRES_URL_NON_POOLING");
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

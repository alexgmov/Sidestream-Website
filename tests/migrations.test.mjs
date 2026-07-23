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

const CUSTOMER_360_MIGRATION_CHECKSUMS = new Map([
  [
    "20260715120000_add_customer_360_core.sql",
    "69d332381feabb8ff6fe0da597e72ff3c2cc81b26240a602a102d8f98ac23700",
  ],
  [
    "20260715121000_add_customer_identity_links.sql",
    "733bfa2404fd0f6f373751d61d17eb119d326b030140b2e136c0b002fd49adce",
  ],
  [
    "20260715122000_add_customer_commerce_ledger.sql",
    "73787fdef5e96b5804186f417412248516f186e98cbf8bb10c9576e78a79afa6",
  ],
  [
    "20260715123000_add_customer_usage_aggregates.sql",
    "ade69b8aa97f2895068317777cbc246d162ada39dc5358161dfde4066ca45ea0",
  ],
  [
    "20260715124000_add_customer_360_read_model.sql",
    "0d325e2a6186259316b719662e91a746e1603be1480aa9b9eb6294081dcdfbd5",
  ],
]);

const CUSTOMER_360_RETIREMENT_MIGRATION = "20260722120000_retire_customer_360.sql";
const ACTIVATION_TELEMETRY_LINK_MIGRATION =
  "20260722230000_add_activation_telemetry_link.sql";

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
    CUSTOMER_360_RETIREMENT_MIGRATION,
    ACTIVATION_TELEMETRY_LINK_MIGRATION,
  ]) {
    assert.ok(migrations.some((migration) => migration.filename === filename));
  }
  for (const [filename, checksum] of CUSTOMER_360_MIGRATION_CHECKSUMS) {
    assert.equal(
      migrations.find((migration) => migration.filename === filename)?.checksum,
      checksum,
    );
  }
  assert.equal(migrations.at(-2)?.filename, CUSTOMER_360_RETIREMENT_MIGRATION);
  assert.equal(migrations.at(-1)?.filename, ACTIVATION_TELEMETRY_LINK_MIGRATION);
});

test("Customer 360 retirement leaves one private telemetry identity bridge", async () => {
  const migration = await readFile(new URL(
    `../db/migrations/${CUSTOMER_360_RETIREMENT_MIGRATION}`,
    import.meta.url,
  ), "utf8");

  for (const functionSignature of [
    "sidestream_customer_360_profile_read_model\\(\\)",
    "sidestream_customer_360_money_read_model\\(\\)",
    "sidestream_customer_commerce_identity_attach\\(\\)",
    "sidestream_customer_commerce_profile_merge\\(\\)",
    "sidestream_customer_commerce_apply\\(jsonb\\)",
    "sidestream_customer_commerce_reconcile_namespace\\(text, boolean\\)",
    "sidestream_customer_commerce_refresh_namespace\\(text\\)",
    "sidestream_customer_commerce_key_priority\\(text\\)",
    "sidestream_customer_identity_reviews_reject_mutation\\(\\)",
    "sidestream_customer_profiles_require_merge_audit\\(\\)",
    "sidestream_customer_profile_merges_reject_mutation\\(\\)",
    "sidestream_customer_membership_require_live_profile\\(\\)",
    "sidestream_customer_profiles_guard_merge_cycle\\(\\)",
  ]) {
    assert.match(migration, new RegExp(`drop function if exists public\\.${functionSignature}`));
  }

  for (const trigger of [
    "sidestream_customer_identity_links_live_profile_guard",
    "sidestream_customer_commerce_identity_attach_trigger",
    "sidestream_customer_installs_live_profile_guard",
    "sidestream_customer_identity_reviews_immutable_guard",
    "sidestream_customer_identity_reviews_no_truncate",
    "sidestream_customer_profile_merges_immutable_guard",
    "sidestream_customer_profile_merges_no_truncate",
    "sidestream_customer_profiles_merge_cycle_insert_guard",
    "sidestream_customer_profiles_merge_cycle_update_guard",
    "sidestream_customer_profiles_merge_audit_insert_guard",
    "sidestream_customer_profiles_merge_audit_update_guard",
    "sidestream_customer_commerce_profile_merge_trigger",
  ]) {
    assert.match(migration, new RegExp(`drop trigger if exists ${trigger}`));
  }

  for (const table of [
    "sidestream_customer_usage_daily",
    "sidestream_customer_usage_sync_state",
    "sidestream_customer_money_totals",
    "sidestream_customer_commerce_invoice_payments",
    "sidestream_customer_commerce_aliases",
    "sidestream_customer_commerce_materializations",
    "sidestream_customer_identity_reviews",
    "sidestream_customer_profile_merges",
    "sidestream_customer_installs",
    "sidestream_customer_identity_links",
    "sidestream_customer_profiles",
  ]) {
    assert.match(migration, new RegExp(`drop table if exists public\\.${table}\\b`));
  }

  assert.equal(
    [...migration.matchAll(/create table(?: if not exists)? public\./gi)].length,
    1,
  );
  assert.match(
    migration,
    /create table if not exists public\.sidestream_telemetry_identity_links/,
  );
  assert.match(migration, /primary key \(license_namespace, install_id_hash\)/);
  assert.match(migration, /license_namespace in \('production', 'test'\)/);
  assert.match(migration, /install_id_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(migration, /device_id_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(migration, /last_seen_at >= first_seen_at/);
  assert.match(migration, /linked_at >= first_seen_at and linked_at <= last_seen_at/);
  assert.match(migration, /foreign key \(account_id\)[\s\S]*references public\.sidestream_accounts \(id\)/);
  assert.match(migration, /sidestream_telemetry_identity_links_device_idx/);
  assert.match(migration, /sidestream_telemetry_identity_links_account_idx/);
  assert.match(
    migration,
    /alter table public\.sidestream_telemetry_identity_links enable row level security/,
  );
  assert.match(
    migration,
    /revoke all on table public\.sidestream_telemetry_identity_links from public/,
  );
  assert.match(migration, /array\['anon', 'authenticated'\]/);
  assert.doesNotMatch(migration, /\bcascade\b/i);

  const bridgeDefinition = migration.slice(
    migration.indexOf("create table if not exists public.sidestream_telemetry_identity_links"),
    migration.indexOf("create index if not exists sidestream_telemetry_identity_links_device_idx"),
  );
  assert.deepEqual(
    [...bridgeDefinition.matchAll(/^  ([a-z][a-z0-9_]*) (?:text|uuid|timestamptz)\b/gm)]
      .map((match) => match[1]),
    [
      "license_namespace",
      "install_id_hash",
      "device_id_hash",
      "account_id",
      "first_seen_at",
      "last_seen_at",
      "linked_at",
    ],
  );
  assert.doesNotMatch(
    bridgeDefinition,
    /support_code|installer_receipt|email|stripe|payment|payload|raw_device|credential/i,
  );

  for (const protectedTable of [
    "sidestream_accounts",
    "sidestream_account_sessions",
    "sidestream_activation_sessions",
    "sidestream_licenses",
    "sidestream_license_tokens",
    "sidestream_stripe_events",
    "sidestream_checkout_intents",
    "sidestream_account_devices",
    "sidestream_device_transfers",
    "sidestream_download_leads",
    "sidestream_download_lead_idempotency",
    "sidestream_download_lead_replay_receipts",
    "sidestream_api_rate_limits",
    "sidestream_billing_resources",
    "sidestream_installer_requests",
    "sidestream_schema_migrations",
  ]) {
    assert.doesNotMatch(
      migration,
      new RegExp(`drop table(?: if exists)? public\\.${protectedTable}\\b`, "i"),
    );
  }
});

test("activation telemetry reference preserves the anonymous bridge key and privacy boundary", async () => {
  const migration = await readFile(new URL(
    `../db/migrations/${ACTIVATION_TELEMETRY_LINK_MIGRATION}`,
    import.meta.url,
  ), "utf8");

  assert.match(
    migration,
    /alter table public\.sidestream_telemetry_identity_links[\s\S]*add column id uuid not null default gen_random_uuid\(\)/,
  );
  assert.match(
    migration,
    /add constraint sidestream_telemetry_identity_links_id_unique unique \(id\)/,
  );
  assert.match(
    migration,
    /alter table public\.sidestream_activation_sessions[\s\S]*add column telemetry_identity_link_id uuid/,
  );
  assert.match(
    migration,
    /foreign key \(telemetry_identity_link_id\)[\s\S]*references public\.sidestream_telemetry_identity_links \(id\)[\s\S]*on delete set null/,
  );
  assert.match(
    migration,
    /create index sidestream_activation_sessions_telemetry_identity_link_idx[\s\S]*on public\.sidestream_activation_sessions \(telemetry_identity_link_id\)/,
  );
  assert.doesNotMatch(migration, /primary key/i);
  assert.doesNotMatch(
    migration,
    /email|stripe|payment|behavior(?:al)?|payload|support_code|installer_receipt/i,
  );
  assert.doesNotMatch(
    migration,
    /create table|materialized view|create trigger|disable row level security|\bgrant\b|\bcascade\b|\bdrop\b/i,
  );
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

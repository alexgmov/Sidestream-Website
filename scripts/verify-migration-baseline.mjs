import { pathToFileURL } from "node:url";

export const ACTIVATION_ROTATION_MIGRATION =
  "20260713180000_add_activation_checkout_and_refresh_rotation.sql";

export const KNOWN_PRE_20260713_MIGRATION_CHECKSUMS = Object.freeze({
  "20260626120000_add_sidestream_download_leads.sql":
    "d8b821b462001c7d37c82ec7d2a65aeb12a663f00bea9902cf73e22b4b01fd61",
  "20260626123000_add_download_lead_ip_and_drop_storage_targets.sql":
    "93a6752900cc94f4b4e69fbc914306dba1a7902f8259885aa95b0393385c11f6",
  "20260703120000_add_sidestream_accounts_billing.sql":
    "7c66015b6880d4e008554fb0876c59b78120748bdf51fa8f079424f338e114c3",
  "20260704120000_add_sidestream_billing_resources.sql":
    "9d642bafb48e611a0e436150c0d81b5548d59a9f0569720f6e42c395385a6adf",
  "20260704130000_allow_stripe_first_accounts.sql":
    "4456bac7ec4c6099c8b9d1e49296c78edd6e3399482a32e6b28c61e54fdc9d7a",
  "20260704150000_allow_one_time_checkout_licenses.sql":
    "ba7775f18b8b89180b6fd23723d96a44d149949df3ad2f95fc9b42265694ab93",
  "20260707120000_enable_sidestream_server_table_rls.sql":
    "27dd3305c036c9bd13947520db9d9db4f3764b16f904602b0b45e88309037d29",
});

const RLS_MIGRATION = "20260707120000_enable_sidestream_server_table_rls.sql";
const CORE_MIGRATIONS = Object.keys(KNOWN_PRE_20260713_MIGRATION_CHECKSUMS)
  .filter((filename) => filename !== RLS_MIGRATION);
const OPERATIONAL_TABLES = new Set([
  "sidestream_schema_migrations",
  "sidestream_api_rate_limits",
]);

export const KNOWN_PRE_20260713_COLUMNS = Object.freeze({
  sidestream_download_leads: [
    "id:uuid:NO", "lead_key:text:NO", "email:text:NO", "email_hash:text:YES",
    "captured_at:timestamptz:NO", "source_page:text:YES", "cta_source:text:YES",
    "referrer:text:YES", "user_agent:text:YES", "migrated_from_blob_pathname:text:YES",
    "context:jsonb:NO", "created_at:timestamptz:NO", "updated_at:timestamptz:NO",
    "ip_address:inet:YES",
  ],
  sidestream_accounts: [
    "id:uuid:NO", "google_sub:text:YES", "email:text:NO", "display_name:text:YES",
    "avatar_url:text:YES", "stripe_customer_id:text:YES", "last_login_at:timestamptz:YES",
    "created_at:timestamptz:NO", "updated_at:timestamptz:NO",
  ],
  sidestream_account_sessions: [
    "id:uuid:NO", "account_id:uuid:NO", "session_token_hash:text:NO",
    "user_agent:text:YES", "ip_address:inet:YES", "expires_at:timestamptz:NO",
    "revoked_at:timestamptz:YES", "created_at:timestamptz:NO", "updated_at:timestamptz:NO",
  ],
  sidestream_licenses: [
    "id:uuid:NO", "account_id:uuid:NO", "stripe_customer_id:text:NO",
    "stripe_subscription_id:text:YES", "plan_key:text:NO", "status:text:NO",
    "current_period_end:timestamptz:YES", "cancel_at_period_end:bool:NO",
    "grace_until:timestamptz:YES", "features:jsonb:NO", "created_at:timestamptz:NO",
    "updated_at:timestamptz:NO", "stripe_checkout_session_id:text:YES",
    "stripe_payment_intent_id:text:YES",
  ],
  sidestream_activation_sessions: [
    "id:uuid:NO", "activation_key:text:NO", "account_id:uuid:YES", "license_id:uuid:YES",
    "device_id_hash:text:YES", "app_version:text:YES", "build_channel:text:YES",
    "source:text:YES", "status:text:NO", "ip_address:inet:YES", "user_agent:text:YES",
    "expires_at:timestamptz:NO", "completed_at:timestamptz:YES",
    "created_at:timestamptz:NO", "updated_at:timestamptz:NO",
  ],
  sidestream_license_tokens: [
    "id:uuid:NO", "account_id:uuid:NO", "license_id:uuid:NO",
    "activation_session_id:uuid:YES", "device_id_hash:text:YES", "token_hash:text:NO",
    "expires_at:timestamptz:NO", "last_seen_at:timestamptz:YES", "revoked_at:timestamptz:YES",
    "created_at:timestamptz:NO", "updated_at:timestamptz:NO",
  ],
  sidestream_stripe_events: [
    "event_id:text:NO", "event_type:text:NO", "stripe_created_at:timestamptz:YES",
    "payload:jsonb:NO", "raw_payload:text:YES", "received_at:timestamptz:NO",
    "processed_at:timestamptz:YES", "created_at:timestamptz:NO", "updated_at:timestamptz:NO",
  ],
  sidestream_billing_resources: [
    "resource_key:text:NO", "stripe_product_id:text:NO", "stripe_price_id:text:NO",
    "product_name:text:NO", "product_description:text:YES", "tax_code:text:NO",
    "unit_amount:int4:NO", "currency:text:NO", "recurring_interval:text:NO",
    "created_at:timestamptz:NO", "updated_at:timestamptz:NO",
  ],
});

export const KNOWN_PRE_20260713_REQUIRED_CONSTRAINTS = Object.freeze([
  "sidestream_account_sessions_account_id_fkey",
  "sidestream_account_sessions_pkey",
  "sidestream_account_sessions_token_unique",
  "sidestream_accounts_email_normalized",
  "sidestream_accounts_email_valid",
  "sidestream_accounts_google_sub_unique",
  "sidestream_accounts_pkey",
  "sidestream_accounts_stripe_customer_unique",
  "sidestream_activation_sessions_account_id_fkey",
  "sidestream_activation_sessions_key_unique",
  "sidestream_activation_sessions_license_id_fkey",
  "sidestream_activation_sessions_pkey",
  "sidestream_billing_resources_currency_normalized",
  "sidestream_billing_resources_pkey",
  "sidestream_billing_resources_price_unique",
  "sidestream_billing_resources_product_unique",
  "sidestream_billing_resources_unit_amount_positive",
  "sidestream_download_leads_blob_pathname_unique",
  "sidestream_download_leads_email_normalized",
  "sidestream_download_leads_email_valid",
  "sidestream_download_leads_lead_key_unique",
  "sidestream_download_leads_pkey",
  "sidestream_license_tokens_account_id_fkey",
  "sidestream_license_tokens_activation_session_id_fkey",
  "sidestream_license_tokens_hash_unique",
  "sidestream_license_tokens_license_id_fkey",
  "sidestream_license_tokens_pkey",
  "sidestream_licenses_account_id_fkey",
  "sidestream_licenses_checkout_session_unique",
  "sidestream_licenses_payment_intent_unique",
  "sidestream_licenses_pkey",
  "sidestream_licenses_subscription_unique",
  "sidestream_stripe_events_pkey",
]);

export const KNOWN_PRE_20260713_REQUIRED_INDEXES = Object.freeze([
  "sidestream_account_sessions_account_idx",
  "sidestream_account_sessions_expiry_idx",
  "sidestream_account_sessions_pkey",
  "sidestream_account_sessions_token_unique",
  "sidestream_accounts_email_idx",
  "sidestream_accounts_google_sub_unique",
  "sidestream_accounts_pkey",
  "sidestream_accounts_stripe_customer_unique",
  "sidestream_activation_sessions_account_idx",
  "sidestream_activation_sessions_expiry_idx",
  "sidestream_activation_sessions_key_unique",
  "sidestream_activation_sessions_pkey",
  "sidestream_billing_resources_pkey",
  "sidestream_billing_resources_price_idx",
  "sidestream_billing_resources_price_unique",
  "sidestream_billing_resources_product_unique",
  "sidestream_download_leads_blob_pathname_unique",
  "sidestream_download_leads_captured_idx",
  "sidestream_download_leads_email_idx",
  "sidestream_download_leads_ip_idx",
  "sidestream_download_leads_lead_key_unique",
  "sidestream_download_leads_pkey",
  "sidestream_license_tokens_account_idx",
  "sidestream_license_tokens_expiry_idx",
  "sidestream_license_tokens_hash_unique",
  "sidestream_license_tokens_license_idx",
  "sidestream_license_tokens_pkey",
  "sidestream_licenses_account_idx",
  "sidestream_licenses_checkout_session_unique",
  "sidestream_licenses_customer_idx",
  "sidestream_licenses_payment_intent_unique",
  "sidestream_licenses_pkey",
  "sidestream_licenses_subscription_unique",
  "sidestream_stripe_events_pkey",
  "sidestream_stripe_events_type_idx",
]);

export async function collectMigrationBaselineSnapshot(client) {
  const [columns, tables, constraints, indexes] = await Promise.all([
    client.query(`
      select table_name, column_name, udt_name, is_nullable
      from information_schema.columns
      where table_schema = 'public' and table_name like 'sidestream\\_%' escape '\\'
      order by table_name, ordinal_position
    `),
    client.query(`
      select c.relname as table_name, c.relrowsecurity as row_security_enabled
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and c.relname like 'sidestream\\_%' escape '\\'
      order by c.relname
    `),
    client.query(`
      select con.conname as constraint_name
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_class c on c.oid = con.conrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any($1::text[])
      order by con.conname
    `, [Object.keys(KNOWN_PRE_20260713_COLUMNS)]),
    client.query(`
      select indexname as index_name
      from pg_catalog.pg_indexes
      where schemaname = 'public' and tablename = any($1::text[])
      order by indexname
    `, [Object.keys(KNOWN_PRE_20260713_COLUMNS)]),
  ]);

  return {
    tables: tables.rows.map((row) => ({
      name: String(row.table_name),
      rowSecurityEnabled: Boolean(row.row_security_enabled),
    })),
    columns: columns.rows.map((row) => ({
      table: String(row.table_name),
      name: String(row.column_name),
      type: String(row.udt_name),
      nullable: String(row.is_nullable),
    })),
    constraints: constraints.rows.map((row) => String(row.constraint_name)),
    indexes: indexes.rows.map((row) => String(row.index_name)),
  };
}

export async function verifyKnownPre20260713Schema(client) {
  return verifyMigrationBaselineSnapshot(await collectMigrationBaselineSnapshot(client));
}

export function verifyMigrationBaselineSnapshot(snapshot) {
  const errors = [];
  const expectedTableNames = Object.keys(KNOWN_PRE_20260713_COLUMNS).sort();
  const actualTableNames = snapshot.tables
    .map((table) => table.name)
    .filter((name) => !OPERATIONAL_TABLES.has(name))
    .sort();
  compareExactList("Sidestream tables", actualTableNames, expectedTableNames, errors);

  for (const [tableName, expectedColumns] of Object.entries(KNOWN_PRE_20260713_COLUMNS)) {
    const actualColumns = snapshot.columns
      .filter((column) => column.table === tableName)
      .map((column) => `${column.name}:${column.type}:${column.nullable}`);
    compareExactList(`${tableName} columns`, actualColumns, expectedColumns, errors);
  }

  compareExactList(
    "constraints",
    [...snapshot.constraints].sort(),
    KNOWN_PRE_20260713_REQUIRED_CONSTRAINTS,
    errors,
  );
  compareExactList(
    "indexes",
    [...snapshot.indexes].sort(),
    KNOWN_PRE_20260713_REQUIRED_INDEXES,
    errors,
  );

  const tableRls = new Map(snapshot.tables.map((table) => [
    table.name,
    table.rowSecurityEnabled,
  ]));
  const rlsStates = expectedTableNames.map((name) => tableRls.get(name));
  let rlsMigrationApplied = false;
  let profile = "";
  if (rlsStates.every((enabled) => enabled === true)) {
    rlsMigrationApplied = true;
    profile = "known-pre-20260713-with-rls";
  } else if (rlsStates.every((enabled) => enabled === false)) {
    profile = "known-pre-20260713-before-rls";
  } else if (
    tableRls.get("sidestream_download_leads") === false &&
    expectedTableNames
      .filter((name) => name !== "sidestream_download_leads")
      .every((name) => tableRls.get(name) === true)
  ) {
    profile = "known-pre-20260713-download-lead-rls-drift";
  } else {
    errors.push("Row-level-security state does not match a known pre-20260713 profile");
  }

  if (errors.length > 0) {
    const error = new Error(`Schema does not match the known pre-20260713 baseline:\n- ${errors.join("\n- ")}`);
    error.code = "unknown_migration_baseline";
    throw error;
  }

  const appliedMigrations = rlsMigrationApplied
    ? [...CORE_MIGRATIONS, RLS_MIGRATION]
    : [...CORE_MIGRATIONS];
  const pendingMigrations = [
    ...(!rlsMigrationApplied ? [RLS_MIGRATION] : []),
    ACTIVATION_ROTATION_MIGRATION,
  ];
  return Object.freeze({
    profile,
    appliedMigrations: Object.freeze(appliedMigrations),
    pendingMigrations: Object.freeze(pendingMigrations),
  });
}

export function formatMigrationBaselineVerification(verification) {
  return [
    `Recognized baseline: ${verification.profile}`,
    ...verification.appliedMigrations.map((filename) => `applied: ${filename}`),
    ...verification.pendingMigrations.map((filename) => `pending: ${filename}`),
  ].join("\n");
}

function compareExactList(label, actual, expected, errors) {
  if (actual.length === expected.length && actual.every((value, index) => value === expected[index])) {
    return;
  }
  const missing = expected.filter((value) => !actual.includes(value));
  const unexpected = actual.filter((value) => !expected.includes(value));
  if (missing.length) errors.push(`${label} missing: ${missing.join(", ")}`);
  if (unexpected.length) errors.push(`${label} unexpected: ${unexpected.join(", ")}`);
  if (!missing.length && !unexpected.length) errors.push(`${label} order is not canonical`);
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: node scripts/verify-migration-baseline.mjs [--json]");
    return;
  }
  const target = selectMigrationDatabase(process.env);
  if (!target) throw new Error("Missing Postgres connection for baseline verification");
  const { Pool } = await import("pg");
  const pool = new Pool(createPoolOptions(target.connectionString, process.env));
  try {
    const verification = await verifyKnownPre20260713Schema(pool);
    console.log(process.argv.includes("--json")
      ? JSON.stringify(verification, null, 2)
      : formatMigrationBaselineVerification(verification));
  } finally {
    await pool.end();
  }
}

function selectMigrationDatabase(environment) {
  for (const environmentVariable of [
    "SIDESTREAM_POSTGRES_URL_NON_POOLING",
    "POSTGRES_URL_NON_POOLING",
    "SIDESTREAM_TEST_POSTGRES_URL",
    "SIDESTREAM_POSTGRES_URL",
    "POSTGRES_URL",
    "SIDESTREAM_POSTGRES_PRISMA_URL",
    "POSTGRES_PRISMA_URL",
  ]) {
    const connectionString = environment[environmentVariable]?.trim() || "";
    if (connectionString && !connectionString.includes("[YOUR-") && connectionString !== "changeme") {
      return { environmentVariable, connectionString };
    }
  }
  return null;
}

function createPoolOptions(connectionString, environment) {
  const url = new URL(connectionString);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Migration connection must use postgres: or postgresql:");
  }
  if (/^(prefer|require)$/i.test(url.searchParams.get("sslmode") || "")) {
    url.searchParams.delete("sslmode");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
  return {
    connectionString: url.toString(),
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    ssl: environment.POSTGRES_SSL === "0" || local
      ? false
      : { rejectUnauthorized: false },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Baseline verification failed";
    console.error(message
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted-postgres-url]")
      .replace(/\bpassword\s*=\s*[^\s]+/gi, "password=[redacted]"));
    process.exitCode = 1;
  });
}

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { loadInjectedModule } from "../helpers/handler-loader.mjs";
import {
  createTestPoolOptions,
  requireSafeTestDatabaseUrl,
} from "../../scripts/run-postgres-integration.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migrations = [
  "20260715120000_add_customer_360_core.sql",
  "20260715121000_add_customer_identity_links.sql",
  "20260715122000_add_customer_commerce_ledger.sql",
  "20260715123000_add_customer_usage_aggregates.sql",
  "20260715124000_add_customer_360_read_model.sql",
];
const ADMIN_SECRET = "postgres-customer-admin-secret-2026";
const PROFILE_NULL = "00000000-0000-4000-8000-000000000001";
const PROFILE_D = "00000000-0000-4000-8000-000000000002";
const PROFILE_C = "00000000-0000-4000-8000-000000000003";
const PROFILE_B = "00000000-0000-4000-8000-000000000004";
const TOMBSTONE = "00000000-0000-4000-8000-000000000010";
const PRODUCTION_PROFILE = "00000000-0000-4000-8000-000000000099";

const queryModule = await loadInjectedModule(
  new URL("../../api/_lib/customer-query.ts", import.meta.url),
  {
    "./postgres.js": {
      withPostgresTransaction: async () => {
        throw new Error("Postgres customer query tests inject the disposable schema");
      },
    },
  },
);

test("Customer 360 list/detail stay private, compact, stable, and currency-separated", {
  timeout: 120_000,
}, async (t) => {
  const databaseUrl = requireSafeTestDatabaseUrl(process.env);
  const schema = `sidestream_c360_query_${randomBytes(8).toString("hex")}`;
  const quotedSchema = quoteIdentifier(schema);
  const pool = new Pool(createTestPoolOptions(databaseUrl));
  let schemaCreated = false;
  const transaction = async (callback) => {
    const client = await pool.connect();
    try {
      await client.query("begin isolation level repeatable read read only");
      const result = await callback({
        query: (sql, params = []) => client.query(
          sql.replace(/\bpublic\./g, `${quotedSchema}.`),
          [...params],
        ),
      });
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  try {
    await pool.query(`create schema ${quotedSchema}`);
    schemaCreated = true;
    for (const filename of migrations) {
      const sql = await readFile(join(repositoryRoot, "db/migrations", filename), "utf8");
      await pool.query(sql.replace(/\bpublic\./g, `${quotedSchema}.`));
    }
    await seedProfiles(pool, quotedSchema);

    await t.test("read functions have private grants and no raw evidence outputs", async () => {
      const functions = await pool.query(
        `select proname, prosecdef, provolatile, proparallel,
           pg_get_function_result(pg_proc.oid) as result
         from pg_proc
         join pg_namespace on pg_namespace.oid = pg_proc.pronamespace
         where nspname = $1 and proname in (
           'sidestream_customer_360_profile_read_model',
           'sidestream_customer_360_money_read_model'
         ) order by proname`,
        [schema],
      );
      assert.deepEqual(functions.rows.map((row) => ({
        name: row.proname,
        securityDefiner: row.prosecdef,
        volatility: row.provolatile,
        parallel: row.proparallel,
      })), [
        {
          name: "sidestream_customer_360_money_read_model",
          securityDefiner: false,
          volatility: "s",
          parallel: "s",
        },
        {
          name: "sidestream_customer_360_profile_read_model",
          securityDefiner: false,
          volatility: "s",
          parallel: "s",
        },
      ]);

      const forbiddenGrants = await pool.query(
        `select count(*)::int as count
         from information_schema.routine_privileges
         where specific_schema = $1
           and routine_name like 'sidestream_customer_360_%_read_model'
           and grantee in ('PUBLIC', 'anon', 'authenticated')`,
        [schema],
      );
      assert.equal(forbiddenGrants.rows[0].count, 0);

      const accidentalRelations = await pool.query(
        `select count(*)::int as count
         from information_schema.tables
         where table_schema = $1 and table_name in (
             'sidestream_customer_360_profile_read_model',
             'sidestream_customer_360_money_read_model'
           )`,
        [schema],
      );
      assert.equal(accidentalRelations.rows[0].count, 0);

      const signatures = functions.rows.map((row) => row.result).join("\n");
      for (const forbidden of [
        "payload",
        "data_points",
        "link_value",
        "install_id_hash",
        "source_object_id",
        "event_id",
        "identity_evidence",
        "merged_into",
      ]) {
        assert.doesNotMatch(signatures, new RegExp(`\\b${forbidden}\\b`, "i"), forbidden);
      }
    });

    await t.test("NULL-heavy detail stays nullable and merged tombstones stay hidden", async () => {
      const customer = await queryModule.queryCustomerDetail(
        PROFILE_NULL,
        { licenseNamespace: "test" },
        { transaction },
      );
      assert.equal(customer.customerId, PROFILE_NULL);
      assert.equal(customer.name, null);
      assert.equal(customer.email, null);
      assert.equal(customer.billingModel, null);
      assert.deepEqual(customer.money, []);
      assert.equal(customer.usage.firstDownloadAttemptAt, null);
      assert.equal(customer.usage.firstDownloadSucceededAt, null);
      assert.deepEqual(customer.dataQualityFlags, [
        "usage_not_synced",
        "missing_install_membership",
      ]);

      assert.equal(await queryModule.queryCustomerDetail(
        TOMBSTONE,
        { licenseNamespace: "test" },
        { transaction },
      ), null);
      assert.equal(await queryModule.queryCustomerDetail(
        PRODUCTION_PROFILE,
        { licenseNamespace: "test" },
        { transaction },
      ), null);
    });

    await t.test("multi-currency detail keeps attempts and successes distinct", async () => {
      const customer = await queryModule.queryCustomerDetail(
        PROFILE_B,
        { licenseNamespace: "test" },
        { transaction },
      );
      assert.equal(customer.usage.firstDownloadAttemptAt, "2026-07-10T10:00:00.000Z");
      assert.equal(customer.usage.firstDownloadSucceededAt, "2026-07-10T10:05:00.000Z");
      assert.equal(customer.usage.downloadOutcomeNumerator, "3");
      assert.equal(customer.usage.downloadOutcomeDenominator, "4");
      assert.equal(customer.usage.activeDays7, "2");
      assert.equal(customer.usage.activeDays30, "4");
      assert.equal(customer.usage.downloadFrequency30d, "1.250000");
      assert.deepEqual(customer.money.map((money) => money.currency), ["eur", "usd"]);
      assert.deepEqual(customer.money.map((money) => money.netPaidMinor), ["500", "700"]);
      assert.ok(customer.dataQualityFlags.includes("pending_download_outcomes"));
      assert.ok(customer.dataQualityFlags.includes("pending_identity_review"));
      assert.doesNotMatch(JSON.stringify(customer), /install_id_hash|stripe_|payload|data_points/);
    });

    await t.test("keyset pages are stable and cursors bind namespace, limit, and filters", async () => {
      const request = {
        licenseNamespace: "test",
        limit: 2,
        filters: { billingModel: "one_time" },
      };
      const first = await queryModule.queryCustomerList(request, ADMIN_SECRET, { transaction });
      const repeated = await queryModule.queryCustomerList(request, ADMIN_SECRET, { transaction });
      assert.deepEqual(first.customers.map((customer) => customer.customerId), [
        PROFILE_B,
        PROFILE_C,
      ]);
      assert.equal(first.nextCursor, repeated.nextCursor);
      assert.ok(first.nextCursor);

      const second = await queryModule.queryCustomerList({
        ...request,
        cursor: first.nextCursor,
      }, ADMIN_SECRET, { transaction });
      assert.deepEqual(second.customers.map((customer) => customer.customerId), [PROFILE_D]);
      assert.equal(second.nextCursor, null);
      assert.equal(new Set([
        ...first.customers.map((customer) => customer.customerId),
        ...second.customers.map((customer) => customer.customerId),
      ]).size, 3);

      await assert.rejects(queryModule.queryCustomerList({
        ...request,
        filters: { billingModel: "one_time", hasEmail: true },
        cursor: first.nextCursor,
      }, ADMIN_SECRET, { transaction }), (error) => error?.code === "invalid_cursor");
      await assert.rejects(queryModule.queryCustomerList({
        ...request,
        licenseNamespace: "production",
        cursor: first.nextCursor,
      }, ADMIN_SECRET, { transaction }), (error) => error?.code === "invalid_cursor");
      await assert.rejects(queryModule.queryCustomerList({
        ...request,
        limit: 1,
        cursor: first.nextCursor,
      }, ADMIN_SECRET, { transaction }), (error) => error?.code === "invalid_cursor");
    });
  } finally {
    if (schemaCreated) {
      await pool.query(`drop schema if exists ${quotedSchema} cascade`).catch(() => {});
    }
    await pool.end().catch(() => {});
  }
});

async function seedProfiles(pool, schema) {
  const rows = [
    [PROFILE_NULL, "test", "2026-07-15T08:00:00Z", null, null, null],
    [PROFILE_D, "test", "2026-07-15T10:00:00Z", "2026-07-15T12:00:00Z", "d@example.com", "Delta"],
    [PROFILE_C, "test", "2026-07-15T10:00:00Z", "2026-07-15T12:00:00Z", null, "Charlie"],
    [PROFILE_B, "test", "2026-07-15T10:00:00Z", "2026-07-15T12:00:00Z", "b@example.com", "Bravo"],
    [TOMBSTONE, "test", "2026-07-15T11:00:00Z", "2026-07-15T13:00:00Z", "merged@example.com", "Merged"],
    [PRODUCTION_PROFILE, "production", "2026-07-15T12:00:00Z", "2026-07-15T14:00:00Z", "prod@example.com", "Production"],
  ];
  for (const [id, namespace, createdAt, lastActivityAt, email, name] of rows) {
    await pool.query(
      `insert into ${schema}.sidestream_customer_profiles (
         id, license_namespace, created_at, updated_at, first_seen_at,
         last_activity_at, contact_email, display_name
       ) values ($1, $2, $3, $3, $3, $4, $5, $6)`,
      [id, namespace, createdAt, lastActivityAt, email, name],
    );
  }

  const mergeClient = await pool.connect();
  try {
    await mergeClient.query("begin");
    await mergeClient.query(
      `update ${schema}.sidestream_customer_profiles
       set merged_into = $1, merged_at = '2026-07-15T14:00:00Z'
       where id = $2`,
      [PROFILE_NULL, TOMBSTONE],
    );
    await mergeClient.query(
      `insert into ${schema}.sidestream_customer_profile_merges (
         license_namespace, source_profile_id, target_profile_id,
         merge_evidence_type, merge_evidence_value_hash, initiated_by,
         merged_at
       ) values ('test', $1, $2, 'support_code', $3, 'backfill',
         '2026-07-15T14:00:00Z')`,
      [TOMBSTONE, PROFILE_NULL, "e".repeat(64)],
    );
    await mergeClient.query("commit");
  } catch (error) {
    await mergeClient.query("rollback").catch(() => {});
    throw error;
  } finally {
    mergeClient.release();
  }

  for (const [index, profileId] of [PROFILE_D, PROFILE_C, PROFILE_B].entries()) {
    await pool.query(
      `insert into ${schema}.sidestream_customer_installs (
         profile_id, license_namespace, install_id_hash, platform, app_version,
         first_seen_at, last_seen_at
       ) values ($1, 'test', $2, 'macos', '1.0.13',
         '2026-07-01T00:00:00Z', '2026-07-15T12:00:00Z')`,
      [profileId, String(index + 1).repeat(64)],
    );
    await pool.query(
      `update ${schema}.sidestream_customer_profiles
       set commerce_model = 'one_time', entitlement_status = 'active',
           commerce_synced_at = '2026-07-15T12:30:00Z',
           first_paid_at = '2026-07-10T09:00:00Z',
           last_paid_at = '2026-07-10T09:00:00Z',
           first_upgraded_at = '2026-07-10T09:00:00Z',
           last_upgraded_at = '2026-07-10T09:00:00Z',
           first_app_use_at = '2026-07-01T00:00:00Z',
           last_app_use_at = '2026-07-15T12:00:00Z',
           download_success_count = 0, download_failure_count = 0,
           download_attempt_count = 0, download_outcome_count = 0,
           download_cancelled_count = 0, download_pending_count = 0,
           download_unknown_count = 0, usage_active_days_count = 1,
           usage_active_days_7 = 1, usage_active_days_30 = 1,
           download_frequency_30d = 0, usage_install_count = 1,
           usage_synced_at = '2026-07-15T12:30:00Z',
           usage_source_freshness_at = '2026-07-15T12:00:00Z'
       where id = $1`,
      [profileId],
    );
  }

  await pool.query(
    `update ${schema}.sidestream_customer_profiles
     set first_download_attempt_at = '2026-07-10T10:00:00Z',
         last_download_attempt_at = '2026-07-15T11:00:00Z',
         first_download_success_at = '2026-07-10T10:05:00Z',
         last_download_success_at = '2026-07-15T10:00:00Z',
         download_success_count = 3, download_failure_count = 1,
         download_attempt_count = 5, download_outcome_count = 4,
         download_pending_count = 1, usage_active_days_count = 8,
         usage_active_days_7 = 2, usage_active_days_30 = 4,
         download_frequency_30d = 1.25
     where id = $1`,
    [PROFILE_B],
  );

  for (const money of [
    ["eur", 500, 0, 500],
    ["usd", 1000, 300, 700],
  ]) {
    await pool.query(
      `insert into ${schema}.sidestream_customer_money_totals (
         profile_id, license_namespace, currency, commerce_model,
         gross_paid_minor, off_stripe_paid_minor, discount_minor, tax_minor,
         refunded_minor, disputed_minor, inquiry_minor, net_paid_minor,
         paid_transaction_count, comped_transaction_count,
         first_paid_at, last_paid_at, first_upgraded_at, last_upgraded_at,
         materialized_at
       ) values (
         $1, 'test', $2, 'one_time', $3, 0, 0, 0, $4, 0, 0, $5,
         1, 0, '2026-07-10T09:00:00Z', '2026-07-10T09:00:00Z',
         '2026-07-10T09:00:00Z', '2026-07-10T09:00:00Z',
         '2026-07-15T12:30:00Z'
       )`,
      [PROFILE_B, ...money],
    );
  }

  await pool.query(
    `insert into ${schema}.sidestream_customer_identity_reviews (
       license_namespace, candidate_profile_id, existing_profile_id,
       evidence_type, evidence_value_hash, evidence_trust, attachment_source
     ) values ('test', $1, $2, 'account_identity', $3,
       'verified_server', 'activation_claim')`,
    [PROFILE_B, PROFILE_C, "f".repeat(64)],
  );
}

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new TypeError("Unsafe identifier");
  return `"${identifier}"`;
}

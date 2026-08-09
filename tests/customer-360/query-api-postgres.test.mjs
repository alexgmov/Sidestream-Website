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
  "20260703120000_add_sidestream_accounts_billing.sql",
  "20260713203000_add_checkout_intents.sql",
  "20260715120000_add_customer_360_core.sql",
  "20260715121000_add_customer_identity_links.sql",
  "20260715122000_add_customer_commerce_ledger.sql",
  "20260715123000_add_customer_usage_aggregates.sql",
  "20260715124000_add_customer_360_read_model.sql",
  "20260803120000_add_acquisition_integrity.sql",
];
const ADMIN_SECRET = "postgres-customer-admin-secret-2026";
const PROFILE_NULL = "00000000-0000-4000-8000-000000000001";
const PROFILE_D = "00000000-0000-4000-8000-000000000002";
const PROFILE_C = "00000000-0000-4000-8000-000000000003";
const PROFILE_B = "00000000-0000-4000-8000-000000000004";
const TOMBSTONE = "00000000-0000-4000-8000-000000000010";
const PRODUCTION_PROFILE = "00000000-0000-4000-8000-000000000099";
const LOOKUP_ACCOUNT = "10000000-0000-4000-8000-000000000010";
const LOOKUP_ACQUISITION = "20000000-0000-4000-8000-000000000010";
const LOOKUP_INTENT = "30000000-0000-4000-8000-000000000010";
const EXACT_LOOKUP_ACQUISITION = "20000000-0000-4000-8000-000000000011";
const EXACT_LOOKUP_INTENT = "30000000-0000-4000-8000-000000000011";

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
      assert.equal(Object.hasOwn(customer, "email"), false);
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
      assert.doesNotMatch(
        JSON.stringify(customer),
        /install_id_hash|stripe_|payload|data_points|b@example\.com/,
      );
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

    await t.test("exact Stripe aliases prioritize their Checkout acquisition without leaking identifiers", async () => {
      for (const stripeReference of [
        "cs_lookup_exact",
        "pi_lookup_exact",
        "ch_lookup_exact",
      ]) {
        const customer = await queryModule.queryCustomerLookup({
          licenseNamespace: "test",
          stripeReference,
        }, { transaction });
        assert.equal(customer.customerId, PROFILE_B);
        assert.equal(customer.acquisition.source, "meta");
        assert.equal(customer.acquisition.campaign, "exact-checkout-campaign");
        assert.equal(customer.acquisition.stageTimestamps.payment_settled,
          "2026-07-10T09:00:00.000Z");
        assert.ok(customer.acquisition.missingStages.includes("refunded"));
        assert.deepEqual(customer.acquisition.conflictingStages, []);
        assert.equal(customer.paymentStatus.settled, true);
        assert.equal(customer.paymentStatus.refunded, true);
        assert.equal(customer.paymentStatus.disputed, true);
        const serialized = JSON.stringify(customer);
        assert.doesNotMatch(serialized, /(?:cus|cs|pi|ch)_lookup_exact/);
        assert.doesNotMatch(serialized, /b@example\.com|link_value|identity_evidence/);
      }

      const customerFallback = await queryModule.queryCustomerLookup({
        licenseNamespace: "test",
        stripeReference: "cus_lookup_exact",
      }, { transaction });
      assert.equal(customerFallback.customerId, PROFILE_B);
      assert.equal(customerFallback.acquisition.source, "website_direct_or_unknown");
      assert.equal(customerFallback.acquisition.campaign, "lookup-campaign");

      const paymentFallback = await queryModule.queryCustomerLookup({
        licenseNamespace: "test",
        stripeReference: "pi_profile_only",
      }, { transaction });
      assert.equal(paymentFallback.customerId, PROFILE_B);
      assert.equal(paymentFallback.acquisition.source, "website_direct_or_unknown");
      assert.equal(paymentFallback.acquisition.campaign, "lookup-campaign");

      await assert.rejects(queryModule.queryCustomerLookup({
        licenseNamespace: "test",
        stripeReference: "pi_lookup_conflict",
      }, { transaction }), (error) => error?.code === "conflicting_lookup_ownership");

      assert.equal(await queryModule.queryCustomerLookup({
        licenseNamespace: "production",
        stripeReference: "pi_lookup_exact",
      }, { transaction }), null);
      assert.equal(await queryModule.queryCustomerLookup({
        licenseNamespace: "test",
        stripeReference: "pi_not_stored",
      }, { transaction }), null);
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

  await pool.query(
    `insert into ${schema}.sidestream_accounts (
       id, google_sub, email, created_at, updated_at
     ) values ($1, 'google-lookup', 'lookup@example.com',
       '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')`,
    [LOOKUP_ACCOUNT],
  );
  await pool.query(
    `insert into ${schema}.sidestream_acquisitions (
       id, license_namespace, first_observed_source, first_observed_medium,
       first_observed_campaign, first_observed_content_creative,
       entry_channel, first_observed_at, experiment_id, experiment_cohort,
       attribution_confidence, integrity_state, trusted_delivery_evidence
     ) values
     (
       $1, 'test', 'website_direct_or_unknown', null, 'lookup-campaign',
       'lookup-creative', 'website', '2026-07-01T00:00:00Z',
       'lookup-experiment', 'lookup-cohort', 'exact_sidestream_entry', 'intact',
       array['website_entry', 'authenticated_account', 'checkout_intent']::text[]
     ),
     (
       $2, 'test', 'meta', 'paid_social', 'exact-checkout-campaign',
       'exact-creative', 'website', '2026-07-09T00:00:00Z',
       'meta-direct-links-v1', 'paid', 'exact_sidestream_entry', 'intact',
       array['website_entry', 'checkout_intent', 'stripe_checkout_session']::text[]
     )`,
    [LOOKUP_ACQUISITION, EXACT_LOOKUP_ACQUISITION],
  );
  await pool.query(
    `insert into ${schema}.sidestream_checkout_intents (
       id, acquisition_id, intent_kind, browser_token_hash, account_id,
       state, expires_at, created_at, updated_at
     ) values ($1, $2, 'account', $3, $4, 'completed',
       '2026-08-01T00:00:00Z', '2026-07-10T08:00:00Z',
       '2026-07-10T09:00:00Z')`,
    [LOOKUP_INTENT, LOOKUP_ACQUISITION, "9".repeat(64), LOOKUP_ACCOUNT],
  );
  await pool.query(
    `insert into ${schema}.sidestream_checkout_intents (
       id, acquisition_id, intent_kind, browser_token_hash, account_id,
       state, stripe_checkout_session_id, stripe_checkout_url,
       stripe_price_id, stripe_product_id, stripe_session_expires_at,
       expires_at, created_at, updated_at
     ) values (
       $1, $2, 'account', $3, $4, 'completed', 'cs_lookup_exact',
       'https://checkout.stripe.test/cs_lookup_exact', 'price_lookup_exact',
       'prod_lookup_exact', '2026-07-10T10:00:00Z',
       '2026-08-01T00:00:00Z', '2026-07-09T08:00:00Z',
       '2026-07-10T09:00:00Z'
     )`,
    [EXACT_LOOKUP_INTENT, EXACT_LOOKUP_ACQUISITION, "8".repeat(64), LOOKUP_ACCOUNT],
  );
  await pool.query(
    `insert into ${schema}.sidestream_customer_identity_links (
       profile_id, license_namespace, link_type, link_value
     ) values
       ($1, 'test', 'account_identity', $2),
       ($1, 'test', 'stripe_customer', 'cus_lookup_exact'),
       ($1, 'test', 'stripe_checkout_session', 'cs_lookup_exact'),
       ($1, 'test', 'stripe_payment_intent', 'pi_lookup_exact'),
       ($1, 'test', 'stripe_payment_intent', 'pi_lookup_conflict')`,
    [PROFILE_B, LOOKUP_ACCOUNT],
  );
  await pool.query(
    `insert into ${schema}.sidestream_customer_commerce_materializations (
       license_namespace, profile_id, event_id, event_type, event_created_at,
       source_object_type, source_object_id, fact_kind, commerce_model, state,
       currency, gross_paid_minor, refunded_minor, disputed_minor,
       net_paid_minor, effective_at, timestamp_source, source,
       source_confidence, payment_key
     ) values
       ('test', $1, 'evt_lookup_payment', 'payment_intent.succeeded',
        '2026-07-10T09:00:00Z', 'payment_intent', 'pi_lookup_exact',
        'payment', 'one_time', 'succeeded', 'usd', 1999, 300, 0, 1699,
        '2026-07-10T09:00:00Z', 'stripe_object', 'stripe_object', 'verified',
        'payment_intent:pi_lookup_exact'),
       ('test', $1, 'evt_lookup_dispute', 'charge.dispute.created',
        '2026-07-11T09:00:00Z', 'dispute', 'dp_lookup_private',
        'dispute', 'one_time', 'needs_response', 'usd', 0, 0, 200, 0,
        '2026-07-11T09:00:00Z', 'stripe_object', 'stripe_object', 'verified',
        'payment_intent:pi_lookup_exact')`,
    [PROFILE_B],
  );
  await pool.query(
    `insert into ${schema}.sidestream_customer_commerce_materializations (
       license_namespace, profile_id, event_id, event_type, event_created_at,
       source_object_type, source_object_id, fact_kind, commerce_model, state,
       currency, gross_paid_minor, net_paid_minor, effective_at,
       timestamp_source, source, source_confidence, payment_key
     ) values (
       'test', $1, 'evt_profile_only', 'payment_intent.succeeded',
       '2026-07-08T09:00:00Z', 'payment_intent', 'pi_profile_only',
       'payment', 'one_time', 'succeeded', 'usd', 1999, 1999,
       '2026-07-08T09:00:00Z', 'stripe_object', 'stripe_object', 'verified',
       'payment_intent:pi_profile_only'
     )`,
    [PROFILE_B],
  );
  await pool.query(
    `insert into ${schema}.sidestream_customer_commerce_materializations (
       license_namespace, profile_id, event_id, event_type, event_created_at,
       source_object_type, source_object_id, fact_kind, commerce_model, state,
       currency, gross_paid_minor, net_paid_minor, effective_at,
       timestamp_source, source, source_confidence, payment_key,
       identity_conflict
     ) values (
       'test', $1, 'evt_lookup_conflict', 'payment_intent.succeeded',
       '2026-07-12T09:00:00Z', 'payment_intent', 'pi_lookup_conflict',
       'payment', 'one_time', 'succeeded', 'usd', 1999, 1999,
       '2026-07-12T09:00:00Z', 'stripe_object', 'stripe_object', 'verified',
       'payment_intent:pi_lookup_conflict', true
     )`,
    [PROFILE_B],
  );
  await pool.query(
    `insert into ${schema}.sidestream_customer_commerce_aliases (
       license_namespace, alias_type, alias_id, payment_key, first_event_id
     ) values
       ('test', 'checkout_session', 'cs_lookup_exact',
        'payment_intent:pi_lookup_exact', 'evt_lookup_payment'),
       ('test', 'payment_intent', 'pi_lookup_exact',
        'payment_intent:pi_lookup_exact', 'evt_lookup_payment'),
       ('test', 'charge', 'ch_lookup_exact',
        'payment_intent:pi_lookup_exact', 'evt_lookup_payment'),
       ('test', 'payment_intent', 'pi_profile_only',
        'payment_intent:pi_profile_only', 'evt_profile_only'),
       ('test', 'payment_intent', 'pi_lookup_conflict',
        'payment_intent:pi_lookup_conflict', 'evt_lookup_conflict')`,
  );
  await pool.query(
    `insert into ${schema}.sidestream_acquisition_stages (
       acquisition_id, license_namespace, stage, counting_grain,
       deduplication_key, occurred_at
     ) values
       ($1, 'test', 'landing_observed', 'acquisition', $2,
        '2026-07-01T00:00:00Z'),
       ($1, 'test', 'payment_settled', 'payment', $3,
        '2026-07-10T09:00:00Z')`,
    [LOOKUP_ACQUISITION, "a".repeat(64), "b".repeat(64)],
  );
  await pool.query(
    `insert into ${schema}.sidestream_acquisition_stages (
       acquisition_id, license_namespace, stage, counting_grain,
       deduplication_key, occurred_at
     ) values
       ($1, 'test', 'landing_observed', 'acquisition', $2,
        '2026-07-09T00:00:00Z'),
       ($1, 'test', 'payment_settled', 'payment', $3,
        '2026-07-10T09:00:00Z')`,
    [EXACT_LOOKUP_ACQUISITION, "c".repeat(64), "d".repeat(64)],
  );

  await pool.query(
    `update ${schema}.sidestream_customer_profiles
     set commerce_model = 'one_time', entitlement_status = 'active',
         commerce_synced_at = '2026-07-15T12:30:00Z',
         first_paid_at = '2026-07-10T09:00:00Z',
         last_paid_at = '2026-07-10T09:00:00Z',
         first_upgraded_at = '2026-07-10T09:00:00Z',
         last_upgraded_at = '2026-07-10T09:00:00Z'
     where id = any($1::uuid[])`,
    [[PROFILE_D, PROFILE_C, PROFILE_B]],
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
       ) on conflict (license_namespace, profile_id, currency) do update set
         gross_paid_minor = excluded.gross_paid_minor,
         refunded_minor = excluded.refunded_minor,
         net_paid_minor = excluded.net_paid_minor,
         materialized_at = excluded.materialized_at`,
      [PROFILE_B, ...money],
    );
  }
}

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new TypeError("Unsafe identifier");
  return `"${identifier}"`;
}

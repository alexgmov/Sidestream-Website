import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";

import "../helpers/customer-360-network-guard.mjs";
import {
  loadMigrationFiles,
  migrationSqlForTransaction,
  validateMigrationFiles,
} from "../../scripts/apply-postgres-migrations.mjs";
import {
  createTestPoolOptions,
  requireSafeTestDatabaseUrl,
} from "../../scripts/run-postgres-integration.mjs";

const ACCOUNT = "10000000-0000-4000-8000-000000000001";
const FALLBACK_ACCOUNT = "10000000-0000-4000-8000-000000000002";
const ACQUISITION = "20000000-0000-4000-8000-000000000001";
const FALLBACK_ACQUISITION = "20000000-0000-4000-8000-000000000002";
const ACTIVATION = "30000000-0000-4000-8000-000000000001";
const INTENT = "40000000-0000-4000-8000-000000000001";
const FALLBACK_INTENT = "40000000-0000-4000-8000-000000000002";
const LICENSE = "50000000-0000-4000-8000-000000000001";
const ACQUISITION_INTEGRITY_MIGRATION = "20260803120000_add_acquisition_integrity.sql";
const UPGRADE_PRICING_MIGRATION = "20260812120000_add_upgrade_pricing_experiment.sql";

test("full migrations preserve contended assignment, immutable lineage, fallback isolation, and activation binding", {
  timeout: 120_000,
}, async () => {
  const databaseUrl = requireSafeTestDatabaseUrl(process.env);
  const schemaName = `sidestream_upgrade_pricing_${randomBytes(8).toString("hex")}`;
  const schema = quoteIdentifier(schemaName);
  const pool = new Pool(createTestPoolOptions(databaseUrl));
  let schemaCreated = false;
  try {
    await pool.query(`create schema ${schema}`);
    schemaCreated = true;
    const migrations = validateMigrationFiles(await loadMigrationFiles());
    for (const migration of migrations) {
      await pool.query(scopedMigrationSql(migration.sql, schema));
    }
    assert.ok(migrations.length >= 32);
    const acquisitionIntegrityMigrationIndex = migrations.findIndex(
      ({ filename }) => filename === ACQUISITION_INTEGRITY_MIGRATION,
    );
    const upgradePricingMigrationIndex = migrations.findIndex(
      ({ filename }) => filename === UPGRADE_PRICING_MIGRATION,
    );
    assert.notEqual(acquisitionIntegrityMigrationIndex, -1);
    assert.ok(upgradePricingMigrationIndex > acquisitionIntegrityMigrationIndex);

    await seedAccountsAndAcquisitions(pool, schema);
    const contenders = await Promise.all([
      insertAssignment(pool, schema, "60000000-0000-4000-8000-000000000001", {
        variant: "control_one_time",
        billingModel: "one_time",
        bucket: 7_500,
      }),
      insertAssignment(pool, schema, "60000000-0000-4000-8000-000000000002", {
        variant: "monthly_half",
        billingModel: "subscription",
        bucket: 2_500,
      }),
    ]);
    assert.equal(contenders.filter(Boolean).length, 1);
    const assignment = (await pool.query(`
      select id, account_id, variant, billing_model, assignment_bucket,
        rollout_basis_points, assigned_at
      from ${schema}.sidestream_upgrade_pricing_assignments
      where experiment_id = 'upgrade-pricing-v1' and account_id = $1
    `, [ACCOUNT])).rows[0];
    assert.equal(assignment.account_id, ACCOUNT);
    assert.equal(assignment.rollout_basis_points, 5_000);

    await pool.query(`
      insert into ${schema}.sidestream_activation_sessions (
        id, activation_key, device_id_hash, app_version, build_channel,
        source, status, expires_at, created_at, updated_at
      ) values (
        $1, 'activation-upgrade-integration', $2, '1.0.11', 'stable',
        'upgrade-integration', 'pending', '2026-08-13T00:00:00Z',
        '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'
      )
    `, [ACTIVATION, "a".repeat(64)]);
    await insertExperimentIntent(pool, schema, {
      id: INTENT,
      accountId: ACCOUNT,
      acquisitionId: ACQUISITION,
      activationId: ACTIVATION,
      assignment,
      reason: "existing_assignment",
      sessionId: "cs_upgrade_monthly",
    });
    await pool.query(`
      insert into ${schema}.sidestream_upgrade_pricing_exposures (
        assignment_id, experiment_id, account_id, variant, billing_model,
        checkout_intent_id, exposed_at
      ) values ($1, 'upgrade-pricing-v1', $2, $3, $4, $5, '2026-08-12T00:05:00Z')
    `, [assignment.id, ACCOUNT, assignment.variant, assignment.billing_model, INTENT]);

    await insertFallbackIntent(pool, schema);
    await pool.query(`
      insert into ${schema}.sidestream_upgrade_pricing_exposures (
        assignment_id, experiment_id, account_id, variant, billing_model,
        checkout_intent_id, exposed_at
      ) values (
        null, 'upgrade-pricing-v1', $1, 'control_one_time', 'one_time',
        $2, '2026-08-12T00:06:00Z'
      )
    `, [FALLBACK_ACCOUNT, FALLBACK_INTENT]);
    const exposures = await pool.query(`
      select variant, assignment_id is null as fallback
      from ${schema}.sidestream_upgrade_pricing_exposures
      order by fallback, variant
    `);
    assert.deepEqual(exposures.rows, [
      { variant: assignment.variant, fallback: false },
      { variant: "control_one_time", fallback: true },
    ]);

    await assert.rejects(
      pool.query(`update ${schema}.sidestream_upgrade_pricing_assignments
        set rollout_basis_points = 10000 where id = $1`, [assignment.id]),
      (error) => error?.code === "55000",
    );
    await assert.rejects(
      pool.query(`update ${schema}.sidestream_checkout_intents
        set upgrade_pricing_amount_minor = upgrade_pricing_amount_minor + 1
        where id = $1`, [INTENT]),
      (error) => error?.code === "55000",
    );
    await assert.rejects(
      pool.query(`delete from ${schema}.sidestream_upgrade_pricing_exposures
        where checkout_intent_id = $1`, [INTENT]),
      (error) => error?.code === "55000",
    );
    await assert.rejects(
      pool.query(`
        insert into ${schema}.sidestream_upgrade_pricing_exposures (
          assignment_id, experiment_id, account_id, variant, billing_model,
          checkout_intent_id, exposed_at
        ) values (
          null, 'upgrade-pricing-v1', $1, 'monthly_half', 'subscription',
          $2, '2026-08-12T00:07:00Z'
        )
      `, [FALLBACK_ACCOUNT, FALLBACK_INTENT]),
      (error) => error?.code === "23514" || error?.code === "23505",
    );

    await pool.query(`
      insert into ${schema}.sidestream_licenses (
        id, account_id, stripe_customer_id, stripe_subscription_id,
        stripe_checkout_session_id, stripe_price_id, stripe_product_id,
        plan_key, status, current_period_end, cancel_at_period_end, features,
        amount_paid, amount_refunded, currency, entitlement_status,
        status_reason, reconciled_at, created_at, updated_at
      ) values (
        $1, $2, 'cus_upgrade', 'sub_upgrade', 'cs_upgrade_monthly',
        $3, 'prod_sidestream', 'sidestream_pro', 'active',
        '2026-09-12T00:00:00Z', false,
        '{"upgrade_pricing_v1":true,"subscription":true}'::jsonb,
        999, 0, 'usd', 'active', 'subscription_active',
        '2026-08-12T00:10:00Z', '2026-08-12T00:10:00Z', '2026-08-12T00:10:00Z'
      )
    `, [LICENSE, ACCOUNT, intentPriceId(assignment)]);
    await pool.query(`
      update ${schema}.sidestream_activation_sessions
      set account_id = $2, license_id = $3, status = 'paid',
        completed_at = '2026-08-12T00:11:00Z', updated_at = '2026-08-12T00:11:00Z'
      where id = $1
    `, [ACTIVATION, ACCOUNT, LICENSE]);
    const bound = await pool.query(`
      select intent.upgrade_pricing_variant as variant,
        license.entitlement_status,
        activation.app_version,
        activation.account_id = intent.account_id as exact_account,
        activation.license_id = license.id as exact_license,
        license.stripe_checkout_session_id = intent.stripe_checkout_session_id as exact_session
      from ${schema}.sidestream_checkout_intents intent
      join ${schema}.sidestream_activation_sessions activation
        on activation.id = intent.upgrade_pricing_activation_session_id
      join ${schema}.sidestream_licenses license on license.id = activation.license_id
      where intent.id = $1
    `, [INTENT]);
    assert.deepEqual(bound.rows, [{
      variant: assignment.variant,
      entitlement_status: "active",
      app_version: "1.0.11",
      exact_account: true,
      exact_license: true,
      exact_session: true,
    }]);

    const privateColumns = await pool.query(`
      select column_name
      from information_schema.columns
      where table_schema = $1
        and table_name in (
          'sidestream_upgrade_pricing_assignments',
          'sidestream_upgrade_pricing_exposures'
        )
    `, [schemaName]);
    const names = new Set(privateColumns.rows.map((row) => row.column_name));
    for (const forbidden of [
      "email", "raw_ip", "ip_address", "user_agent", "device_id_hash",
      "activation_key", "stripe_customer_id", "stripe_checkout_session_id",
    ]) assert.equal(names.has(forbidden), false, forbidden);
    assert.deepEqual(globalThis.__SIDESTREAM_CUSTOMER_360_NETWORK_GUARD__, {
      allowedProtocol: "postgres",
      allowedHost: new URL(databaseUrl).hostname.toLowerCase(),
      allowedPort: Number(new URL(databaseUrl).port || 5432),
      stripe: "blocked",
      vercel: "blocked",
    });
  } finally {
    if (schemaCreated) await pool.query(`drop schema if exists ${schema} cascade`).catch(() => {});
    await pool.end().catch(() => {});
  }
});

async function seedAccountsAndAcquisitions(pool, schema) {
  await pool.query(`
    insert into ${schema}.sidestream_accounts (id, google_sub, email, display_name)
    values
      ($1, 'google-upgrade-primary', 'upgrade-primary@example.com', 'Primary'),
      ($2, 'google-upgrade-fallback', 'upgrade-fallback@example.com', 'Fallback')
  `, [ACCOUNT, FALLBACK_ACCOUNT]);
  await pool.query(`
    insert into ${schema}.sidestream_acquisitions (
      id, license_namespace, first_observed_source, first_observed_medium,
      first_observed_campaign, entry_channel, first_observed_at,
      experiment_id, experiment_cohort, attribution_confidence,
      integrity_state, trusted_delivery_evidence
    ) values
      ($1, 'test', 'website', 'direct', 'upgrade_integration', 'website',
       '2026-08-12T00:00:00Z', 'upgrade-pricing-v1', 'authenticated',
       'exact_sidestream_entry', 'intact', array['website_entry','authenticated_account']),
      ($2, 'test', 'manychat', 'dm', 'upgrade_integration', 'manychat_email',
       '2026-08-12T00:00:00Z', 'upgrade-pricing-v1', 'control_fallback',
       'exact_trusted_delivery', 'intact', array['signed_email_handoff','authenticated_account'])
  `, [ACQUISITION, FALLBACK_ACQUISITION]);
}

async function insertAssignment(pool, schema, id, options) {
  const result = await pool.query(`
    insert into ${schema}.sidestream_upgrade_pricing_assignments (
      id, assignment_version, experiment_id, account_id, variant,
      billing_model, assignment_bucket, rollout_basis_points, assigned_at
    ) values ($1, 1, 'upgrade-pricing-v1', $2, $3, $4, $5, 5000,
      '2026-08-12T00:00:00Z')
    on conflict (experiment_id, account_id) do nothing
    returning id
  `, [id, ACCOUNT, options.variant, options.billingModel, options.bucket]);
  return result.rows[0]?.id || null;
}

async function insertExperimentIntent(pool, schema, options) {
  const { assignment } = options;
  const priceId = intentPriceId(assignment);
  const amountMinor = assignment.billing_model === "subscription" ? 999 : 1999;
  await pool.query(`
    insert into ${schema}.sidestream_checkout_intents (
      id, acquisition_id, intent_kind, browser_token_hash, account_id,
      activation_session_id, state, attempt, stripe_checkout_session_id,
      stripe_checkout_url, stripe_price_id, stripe_product_id,
      stripe_session_expires_at, expires_at,
      offer_id, offer_country, offer_currency, offer_amount_minor,
      offer_stripe_product_id, offer_stripe_price_id,
      upgrade_pricing_snapshot_version, upgrade_pricing_experiment_id,
      upgrade_pricing_decision_reason, upgrade_pricing_assignment_id,
      upgrade_pricing_assignment_bucket, upgrade_pricing_rollout_basis_points,
      upgrade_pricing_assigned_at, upgrade_pricing_variant,
      upgrade_pricing_billing_model, upgrade_pricing_country,
      upgrade_pricing_currency, upgrade_pricing_amount_minor,
      upgrade_pricing_stripe_product_id, upgrade_pricing_stripe_price_id,
      upgrade_pricing_account_id, upgrade_pricing_acquisition_id,
      upgrade_pricing_checkout_intent_id,
      upgrade_pricing_activation_session_id, created_at, updated_at
    ) values (
      $1, $2, 'activation', $3, $4, $5, 'open', 0, $6,
      'https://checkout.stripe.test/upgrade', $7, 'prod_sidestream',
      '2026-08-12T01:00:00Z', '2026-08-13T00:00:00Z',
      'global', 'US', 'usd', $8::integer, 'prod_sidestream', $7,
      1, 'upgrade-pricing-v1', $9, $10, $11, 5000,
      $12, $13, $14, 'US', 'usd', $8::integer, 'prod_sidestream', $7,
      $4, $2, $1, $5, '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'
    )
  `, [
    options.id, options.acquisitionId, "b".repeat(64), options.accountId,
    options.activationId, options.sessionId, priceId, amountMinor, options.reason,
    assignment.id, assignment.assignment_bucket, assignment.assigned_at,
    assignment.variant, assignment.billing_model,
  ]);
}

async function insertFallbackIntent(pool, schema) {
  await pool.query(`
    insert into ${schema}.sidestream_checkout_intents (
      id, acquisition_id, intent_kind, browser_token_hash, account_id, state,
      attempt, stripe_checkout_session_id, stripe_checkout_url,
      stripe_price_id, stripe_product_id, stripe_session_expires_at, expires_at,
      offer_id, offer_country, offer_currency, offer_amount_minor,
      offer_stripe_product_id, offer_stripe_price_id,
      upgrade_pricing_snapshot_version, upgrade_pricing_experiment_id,
      upgrade_pricing_decision_reason, upgrade_pricing_assignment_id,
      upgrade_pricing_assignment_bucket, upgrade_pricing_rollout_basis_points,
      upgrade_pricing_assigned_at, upgrade_pricing_variant,
      upgrade_pricing_billing_model, upgrade_pricing_country,
      upgrade_pricing_currency, upgrade_pricing_amount_minor,
      upgrade_pricing_stripe_product_id, upgrade_pricing_stripe_price_id,
      upgrade_pricing_account_id, upgrade_pricing_acquisition_id,
      upgrade_pricing_checkout_intent_id,
      upgrade_pricing_activation_session_id, created_at, updated_at
    ) values (
      $1, $2, 'account', $3, $4, 'open', 0, 'cs_upgrade_fallback',
      'https://checkout.stripe.test/fallback', 'price_once', 'prod_sidestream',
      '2026-08-12T01:00:00Z', '2026-08-13T00:00:00Z',
      'global', 'US', 'usd', 1999, 'prod_sidestream', 'price_once',
      1, 'upgrade-pricing-v1', 'kill_switch', null, null, 0, null,
      'control_one_time', 'one_time', 'US', 'usd', 1999,
      'prod_sidestream', 'price_once', $4, $2, $1, null,
      '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'
    )
  `, [FALLBACK_INTENT, FALLBACK_ACQUISITION, "c".repeat(64), FALLBACK_ACCOUNT]);
}

function intentPriceId(assignment) {
  return assignment.billing_model === "subscription" ? "price_monthly" : "price_once";
}

function scopedMigrationSql(sql, schema) {
  return migrationSqlForTransaction(sql).replace(/\bpublic\./g, `${schema}.`);
}

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new TypeError("Unsafe schema name");
  return `"${value}"`;
}

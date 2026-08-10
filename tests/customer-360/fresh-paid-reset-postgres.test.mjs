import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import {
  loadMigrationFiles,
  migrationSqlForTransaction,
  validateMigrationFiles,
} from "../../scripts/apply-postgres-migrations.mjs";
import {
  applyFreshPaidDatabaseReset,
  inventoryFreshPaidClosure,
} from "../../scripts/reset-alex-upgrade-state.mjs";
import {
  createTestPoolOptions,
  requireSafeTestDatabaseUrl,
} from "../../scripts/run-postgres-integration.mjs";

test("fresh-paid reset closes profile-owned history and preserves anonymous events", {
  timeout: 120_000,
}, async () => {
  const databaseUrl = requireSafeTestDatabaseUrl(process.env);
  const schema = `sidestream_fresh_paid_${randomBytes(10).toString("hex")}`;
  const quotedSchema = quoteIdentifier(schema);
  const pool = new Pool(createTestPoolOptions(databaseUrl));

  try {
    assert.equal(globalThis.__SIDESTREAM_CUSTOMER_360_NETWORK_GUARD__?.stripe, "blocked");
    await assert.rejects(
      globalThis.fetch("https://api.stripe.com/v1/customers"),
      /forbidden in the Customer 360 Postgres harness/,
    );

    await pool.query(`create schema ${quotedSchema}`);
    for (const migration of validateMigrationFiles(await loadMigrationFiles())) {
      await pool.query("begin");
      try {
        await pool.query(rewritePublicSchema(
          migrationSqlForTransaction(migration.sql),
          schema,
        ));
        await pool.query("commit");
      } catch (error) {
        await pool.query("rollback").catch(() => {});
        throw error;
      }
    }

    const root = await insertProfile(pool, quotedSchema, {
      createdAt: "2026-08-10T10:00:00Z",
    });
    const alexSeed = await insertProfile(pool, quotedSchema, {
      createdAt: "2026-08-10T10:01:00Z",
      contactEmail: "alex@alexg.mov",
    });
    const child = await insertProfile(pool, quotedSchema, {
      createdAt: "2026-08-10T10:02:00Z",
    });
    const grandchild = await insertProfile(pool, quotedSchema, {
      createdAt: "2026-08-10T10:03:00Z",
    });
    const unrelated = await insertProfile(pool, quotedSchema, {
      createdAt: "2026-08-10T10:04:00Z",
    });
    const otherNamespaceAlex = await insertProfile(pool, quotedSchema, {
      namespace: "test",
      createdAt: "2026-08-10T10:05:00Z",
      contactEmail: "alex@alexg.mov",
    });
    await mergeProfiles(pool, quotedSchema, alexSeed, root, "a".repeat(64));
    await mergeProfiles(pool, quotedSchema, child, alexSeed, "b".repeat(64));
    await mergeProfiles(pool, quotedSchema, grandchild, child, "c".repeat(64));

    const fixedAccount = await insertAccount(pool, quotedSchema, {
      email: "alex@alexg.mov",
      stripeCustomerId: "cus_fixed_live",
    });
    const foreignAccount = await insertAccount(pool, quotedSchema, {
      email: "different@example.com",
      stripeCustomerId: "cus_foreign_live",
    });
    const historicalActivation = await insertActivation(pool, quotedSchema);
    const deletedCustomerLicense = await insertLicense(pool, quotedSchema, {
      accountId: fixedAccount,
      stripeCustomerId: "cus_fixed_deleted",
    });
    const foreignIdentityLink = await insertIdentityLink(pool, quotedSchema, {
      profileId: root,
      linkType: "account_identity",
      linkValue: foreignAccount,
    });
    await insertIdentityLink(pool, quotedSchema, {
      profileId: root,
      linkType: "activation_record",
      linkValue: historicalActivation,
    });
    await insertIdentityLink(pool, quotedSchema, {
      profileId: root,
      linkType: "stripe_customer",
      linkValue: "cus_fixed_deleted",
    });

    const targetAcquisition = await insertAcquisition(pool, quotedSchema, "meta");
    const unrelatedAcquisition = await insertAcquisition(pool, quotedSchema, "unrelated");
    const ownedIntent = await insertCheckoutIntent(pool, quotedSchema, {
      accountId: fixedAccount,
      acquisitionId: targetAcquisition,
      hash: "d".repeat(64),
    });
    const sameRootRetryIntent = await insertCheckoutIntent(pool, quotedSchema, {
      acquisitionId: targetAcquisition,
      hash: "e".repeat(64),
    });
    const unrelatedIntent = await insertCheckoutIntent(pool, quotedSchema, {
      accountId: foreignAccount,
      acquisitionId: unrelatedAcquisition,
      hash: "f".repeat(64),
    });
    const anonymousPaidEvent = await insertAnonymousPaidEvent(pool, quotedSchema);

    const inventoryClient = scopedInventoryClient(pool, schema);
    await assert.rejects(
      inventoryFreshPaidClosure(inventoryClient, []),
      /crosses an unrelated live customer/,
    );
    await pool.query(
      `delete from ${quotedSchema}.sidestream_customer_identity_links where id = $1`,
      [foreignIdentityLink],
    );
    const accountIdentityLink = await insertIdentityLink(pool, quotedSchema, {
      profileId: root,
      linkType: "account_identity",
      linkValue: fixedAccount,
    });
    const exactBinding = await insertExactPaidTelemetryBinding(pool, quotedSchema, {
      profileId: root,
      accountId: fixedAccount,
      accountIdentityLink,
      licenseId: deletedCustomerLicense,
      acquisitionId: targetAcquisition,
      checkoutIntentId: ownedIntent,
    });
    await assert.rejects(
      pool.query(
        `delete from ${quotedSchema}.sidestream_paid_telemetry_profile_bindings where id = $1`,
        [exactBinding.id],
      ),
      (error) => error?.code === "55000",
    );

    const first = await inventoryFreshPaidClosure(inventoryClient, []);
    assert.deepEqual(
      [...first.profileIds].sort(),
      [root, alexSeed, child, grandchild].sort(),
    );
    assert.equal(first.profileIds.includes(unrelated), false);
    assert.equal(first.profileIds.includes(otherNamespaceAlex), false);
    assert.deepEqual(first.accountIds, [fixedAccount]);
    assert.equal(first.activationIds.includes(historicalActivation), true);
    assert.equal(first.licenseIds.includes(deletedCustomerLicense), true);
    assert.equal(first.customerIds.includes("cus_fixed_deleted"), true);
    assert.equal(first.checkoutIntentIds.includes(ownedIntent), true);
    assert.equal(first.checkoutIntentIds.includes(sameRootRetryIntent), true);
    assert.equal(first.checkoutIntentIds.includes(unrelatedIntent), false);
    assert.deepEqual(first.acquisitionIds, [targetAcquisition]);
    assert.deepEqual(first.bindingIds, [exactBinding.id]);

    const beforeUnrelated = await snapshotUnrelatedRows(pool, quotedSchema, {
      accountId: foreignAccount,
      profileId: unrelated,
      acquisitionId: unrelatedAcquisition,
      checkoutIntentId: unrelatedIntent,
      paidEventId: anonymousPaidEvent,
    });
    const applied = await applyFreshPaidDatabaseReset(
      scopedInventoryPool(pool, schema),
      first,
    );
    assert.equal(applied.deleted.activations >= 1, true);
    assert.equal(applied.deleted.licenses, 1);
    assert.equal(applied.deleted.checkoutIntents, 2);
    assert.equal(applied.deleted.bindings, 1);
    assert.equal("paidEvents" in applied.deleted, false);
    assert.deepEqual(
      await snapshotUnrelatedRows(pool, quotedSchema, {
        accountId: foreignAccount,
        profileId: unrelated,
        acquisitionId: unrelatedAcquisition,
        checkoutIntentId: unrelatedIntent,
        paidEventId: anonymousPaidEvent,
      }),
      beforeUnrelated,
    );
    assert.equal(
      await rowExists(
        pool,
        quotedSchema,
        "sidestream_paid_telemetry_profile_bindings",
        exactBinding.id,
      ),
      false,
    );

    const replay = await inventoryFreshPaidClosure(inventoryClient, []);
    assert.equal(Object.values(replay).every((values) => values.length === 0), true);
    assert.deepEqual(await inventoryFreshPaidClosure(inventoryClient, []), replay);
  } finally {
    await pool.query(`drop schema if exists ${quotedSchema} cascade`).catch(() => {});
    await pool.end().catch(() => {});
  }
});

async function insertProfile(pool, schema, {
  namespace = "production",
  createdAt,
  contactEmail = null,
}) {
  const result = await pool.query(
    `insert into ${schema}.sidestream_customer_profiles (
       license_namespace, created_at, updated_at, contact_email
     ) values ($1, $2::timestamptz, $2::timestamptz, $3)
     returning id`,
    [namespace, createdAt, contactEmail],
  );
  return result.rows[0].id;
}

async function insertAccount(pool, schema, { email, stripeCustomerId }) {
  const result = await pool.query(
    `insert into ${schema}.sidestream_accounts (
       google_sub, email, stripe_customer_id
     ) values ($1, $2, $3)
     returning id`,
    [`google-${email}`, email, stripeCustomerId],
  );
  return result.rows[0].id;
}

async function insertLicense(pool, schema, { accountId, stripeCustomerId }) {
  const result = await pool.query(
    `insert into ${schema}.sidestream_licenses (
       account_id, stripe_customer_id, plan_key, status, entitlement_status,
       status_reason
     ) values (
       $1, $2, 'sidestream_pro', 'active', 'active',
       'paid_checkout_fulfilled'
     )
     returning id`,
    [accountId, stripeCustomerId],
  );
  return result.rows[0].id;
}

async function insertActivation(pool, schema) {
  const result = await pool.query(
    `insert into ${schema}.sidestream_activation_sessions (
       activation_key, status, expires_at
     ) values ($1, 'expired', now() + interval '1 day')
     returning id`,
    [`historical-${randomBytes(8).toString("hex")}`],
  );
  return result.rows[0].id;
}

async function insertIdentityLink(pool, schema, {
  profileId,
  linkType,
  linkValue,
}) {
  const result = await pool.query(
    `insert into ${schema}.sidestream_customer_identity_links (
       profile_id, license_namespace, link_type, link_value
     ) values ($1, 'production', $2, $3)
     returning id`,
    [profileId, linkType, linkValue],
  );
  return result.rows[0].id;
}

async function insertAcquisition(pool, schema, content) {
  const result = await pool.query(
    `insert into ${schema}.sidestream_acquisitions (
       license_namespace, first_observed_source, first_observed_medium,
       first_observed_campaign, first_observed_content_creative,
       entry_channel, first_observed_at, external_referrer_category,
       attribution_confidence
     ) values (
       'production', 'meta', 'social', 'sidestream_direct_offer_test', $1,
       'website', now(), 'social', 'exact_sidestream_entry'
     )
     returning id`,
    [content],
  );
  return result.rows[0].id;
}

async function insertCheckoutIntent(pool, schema, {
  accountId = null,
  acquisitionId,
  hash,
}) {
  const result = await pool.query(
    `insert into ${schema}.sidestream_checkout_intents (
       intent_kind, browser_token_hash, account_id, expires_at, acquisition_id
     ) values ($1, $2, $3, now() + interval '1 day', $4)
     returning id`,
    [accountId ? "account" : "anonymous", hash, accountId, acquisitionId],
  );
  return result.rows[0].id;
}

async function insertAnonymousPaidEvent(pool, schema) {
  const result = await pool.query(
    `insert into ${schema}.sidestream_paid_acquisition_events (
       event_id, schema_version, occurred_at, environment, experiment_id,
       cohort, event_name, outcome, anonymous_day_hash, utm_medium, utm_campaign
     ) values (
       gen_random_uuid(), 1, now(), 'production', 'mc-mobile-paid-v1',
       'mc-paid-v1', 'mc_checkout_started', 'success', $1, 'social',
       'sidestream_direct_offer_test'
     )
     returning event_id`,
    ["9".repeat(64)],
  );
  return result.rows[0].event_id;
}

async function insertExactPaidTelemetryBinding(pool, schema, {
  profileId,
  accountId,
  accountIdentityLink,
  licenseId,
  acquisitionId,
  checkoutIntentId,
}) {
  const installHash = "1".repeat(64);
  const receiptHash = "2".repeat(64);
  const activation = await pool.query(
    `insert into ${schema}.sidestream_activation_sessions (
       activation_key, account_id, license_id, source, status,
       completed_at, expires_at
     ) values (
       $1, $2, $3, 'paid-acquisition-mc-v1', 'completed',
       now(), now() + interval '1 day'
     ) returning id`,
    [`exact-binding-${randomBytes(8).toString("hex")}`, accountId, licenseId],
  );
  const activationId = activation.rows[0].id;
  const install = await pool.query(
    `insert into ${schema}.sidestream_customer_installs (
       profile_id, license_namespace, install_id_hash, platform, app_version
     ) values ($1, 'production', $2, 'macos', '1.0.17')
     returning id`,
    [profileId, installHash],
  );
  const installIdentityLink = await insertIdentityLink(pool, schema, {
    profileId,
    linkType: "install_identity_hash",
    linkValue: installHash,
  });
  const activationIdentityLink = await insertIdentityLink(pool, schema, {
    profileId,
    linkType: "activation_record",
    linkValue: activationId,
  });
  const receiptIdentityLink = await insertIdentityLink(pool, schema, {
    profileId,
    linkType: "installer_receipt_hash",
    linkValue: receiptHash,
  });
  const paidEntry = await pool.query(
    `insert into ${schema}.sidestream_paid_acquisition_entries (
       contract_version, environment, experiment_id, cohort,
       assignment_id_hash, assignment_cookie_signature_hash, entry_path,
       entry_token_hash, attribution_hash, utm_medium, utm_campaign, expires_at
     ) values (
       1, 'production', 'mc-mobile-paid-v1', 'mc-paid-v1',
       $1, $2, '/mc', $3, $4, 'social',
       'sidestream_direct_offer_test', now() + interval '1 day'
     ) returning id`,
    ["3".repeat(64), "4".repeat(64), "5".repeat(64), "6".repeat(64)],
  );
  const paymentRef = `pi_fixture_${randomBytes(8).toString("hex")}`;
  const paidCheckout = await pool.query(
    `insert into ${schema}.sidestream_paid_acquisition_checkouts (
       entry_id, contract_version, environment, experiment_id, cohort,
       assignment_id_hash, entry_token_hash, attribution_hash,
       checkout_intent_ref, idempotency_key, request_fingerprint,
       verified_checkout_session_ref, canonical_payment_ref,
       checkout_email_normalized, verified_product_ref, verified_price_ref,
       verified_quantity, verified_amount_minor, verified_currency,
       installer_receipt_hash, payment_state, claim_state, receipt_expires_at,
       completed_at, expires_at
     ) values (
       $1, 1, 'production', 'mc-mobile-paid-v1', 'mc-paid-v1',
       $2, $3, $4, $5, gen_random_uuid(), $6, $7, $8,
       'alex@alexg.mov', 'prod_fixture', 'price_fixture', 1, 1999, 'usd',
       $9, 'active', 'claimed', now() + interval '1 day', now(),
       now() + interval '1 day'
     ) returning id`,
    [
      paidEntry.rows[0].id,
      "3".repeat(64),
      "5".repeat(64),
      "6".repeat(64),
      checkoutIntentId,
      "7".repeat(64),
      `cs_fixture_${randomBytes(8).toString("hex")}`,
      paymentRef,
      receiptHash,
    ],
  );
  const claim = await pool.query(
    `insert into ${schema}.sidestream_paid_acquisition_claims (
       checkout_id, environment, canonical_payment_ref, activation_ref,
       account_ref, entitlement_ref, google_email_normalized, claim_state,
       expires_at
     ) values (
       $1, 'production', $2, $3, $4, $5, 'alex@alexg.mov', 'claimed',
       now() + interval '1 day'
     ) returning id`,
    [paidCheckout.rows[0].id, paymentRef, activationId, accountId, licenseId],
  );
  const binding = await pool.query(
    `insert into ${schema}.sidestream_paid_telemetry_profile_bindings (
       license_namespace, claim_id, checkout_id, acquisition_id,
       account_id, entitlement_id, activation_ref, profile_id_at_binding,
       install_membership_id, install_id_hash, install_identity_link_id,
       activation_identity_link_id, account_identity_link_id,
       installer_receipt_identity_link_id, installer_receipt_id_hash,
       binding_key, bound_at
     ) values (
       'production', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       $12, $13, $14, $15, now()
     ) returning id`,
    [
      claim.rows[0].id,
      paidCheckout.rows[0].id,
      acquisitionId,
      accountId,
      licenseId,
      activationId,
      profileId,
      install.rows[0].id,
      installHash,
      installIdentityLink,
      activationIdentityLink,
      accountIdentityLink,
      receiptIdentityLink,
      receiptHash,
      "8".repeat(64),
    ],
  );
  return { id: binding.rows[0].id };
}

async function rowExists(pool, schema, table, id) {
  const result = await pool.query(
    `select exists(select 1 from ${schema}.${table} where id = $1) as exists`,
    [id],
  );
  return result.rows[0].exists;
}

async function snapshotUnrelatedRows(pool, schema, ids) {
  const result = await pool.query(
    `select
       exists(select 1 from ${schema}.sidestream_accounts where id = $1) as account,
       exists(select 1 from ${schema}.sidestream_customer_profiles where id = $2) as profile,
       exists(select 1 from ${schema}.sidestream_acquisitions where id = $3) as acquisition,
       exists(select 1 from ${schema}.sidestream_checkout_intents where id = $4) as checkout_intent,
       exists(select 1 from ${schema}.sidestream_paid_acquisition_events where event_id = $5) as paid_event,
       (select count(*)::integer from ${schema}.sidestream_paid_acquisition_events) as paid_event_count`,
    [
      ids.accountId,
      ids.profileId,
      ids.acquisitionId,
      ids.checkoutIntentId,
      ids.paidEventId,
    ],
  );
  return result.rows[0];
}

async function mergeProfiles(pool, schema, sourceId, targetId, evidenceHash) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `update ${schema}.sidestream_customer_profiles
       set merged_into = $2, merged_at = now(), updated_at = now()
       where id = $1`,
      [sourceId, targetId],
    );
    await client.query(
      `insert into ${schema}.sidestream_customer_profile_merges (
         license_namespace, source_profile_id, target_profile_id,
         merge_evidence_type, merge_evidence_value_hash, initiated_by
       ) values ('production', $1, $2, 'account_identity', $3, 'system')`,
      [sourceId, targetId, evidenceHash],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function scopedInventoryClient(pool, schema) {
  return {
    query(sql, params = []) {
      return pool.query(
        rewritePublicSchema(sql, schema).replace(
          "table_schema = 'public'",
          `table_schema = '${schema}'`,
        ),
        params,
      );
    },
  };
}

function scopedInventoryPool(pool, schema) {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        query(sql, params = []) {
          return client.query(
            rewritePublicSchema(sql, schema).replace(
              "table_schema = 'public'",
              `table_schema = '${schema}'`,
            ),
            params,
          );
        },
        release() {
          client.release();
        },
      };
    },
  };
}

function rewritePublicSchema(source, schema) {
  return source.replace(/\bpublic\./g, `${quoteIdentifier(schema)}.`);
}

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
    throw new TypeError("Unsafe Postgres identifier");
  }
  return `"${identifier}"`;
}

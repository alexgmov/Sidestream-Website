import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import {
  createCanonicalAcquisitionRoot,
  recordAcquisitionStage,
} from "../../api/_lib/acquisition-integrity.ts";
import {
  createTestPoolOptions,
  requireSafeTestDatabaseUrl,
} from "../../scripts/run-postgres-integration.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const checkoutMigration = "20260713203000_add_checkout_intents.sql";
const acquisitionMigration = "20260803120000_add_acquisition_integrity.sql";
const FIRST_OBSERVED = "2026-08-03T12:00:00.000Z";
const ROOT_ONE = "00000000-0000-4000-8000-000000000101";
const ROOT_TWO = "00000000-0000-4000-8000-000000000102";
const ROOT_PRODUCTION = "00000000-0000-4000-8000-000000000103";

test("acquisition integrity is immutable, namespaced, idempotent, and history-safe", {
  timeout: 120_000,
}, async (t) => {
  const databaseUrl = requireSafeTestDatabaseUrl(process.env);
  const schema = `sidestream_acquisition_integrity_${randomBytes(8).toString("hex")}`;
  const quotedSchema = quoteIdentifier(schema);
  const pool = new Pool(createTestPoolOptions(databaseUrl));
  const transaction = createTransaction(pool, quotedSchema);
  let schemaCreated = false;

  try {
    await pool.query(`create schema ${quotedSchema}`);
    schemaCreated = true;
    await pool.query(`
      create table ${quotedSchema}.sidestream_accounts (id uuid primary key);
      create table ${quotedSchema}.sidestream_activation_sessions (id uuid primary key);
    `);
    await applyMigration(pool, quotedSchema, checkoutMigration);
    await pool.query(`
      insert into ${quotedSchema}.sidestream_checkout_intents (
        id, intent_kind, browser_token_hash, state, expires_at, created_at, updated_at
      ) values (
        '10000000-0000-4000-8000-000000000001', 'anonymous', $1, 'pending',
        '2026-08-04T12:00:00Z', '2026-08-03T12:00:00Z', '2026-08-03T12:00:00Z'
      )
    `, ["1".repeat(64)]);
    await pool.query(`
      create table ${quotedSchema}.sidestream_licenses (
        id uuid primary key, entitlement_status text not null
      );
      create table ${quotedSchema}.sidestream_account_devices (
        id uuid primary key, device_state text not null
      );
      create table ${quotedSchema}.sidestream_customer_commerce_facts (
        id uuid primary key, amount_minor bigint not null
      );
      insert into ${quotedSchema}.sidestream_licenses values
        ('20000000-0000-4000-8000-000000000001', 'active');
      insert into ${quotedSchema}.sidestream_account_devices values
        ('30000000-0000-4000-8000-000000000001', 'active');
      insert into ${quotedSchema}.sidestream_customer_commerce_facts values
        ('40000000-0000-4000-8000-000000000001', 1999);
    `);
    const protectedBefore = await protectedRows(pool, quotedSchema);

    await applyMigration(pool, quotedSchema, acquisitionMigration);

    await t.test("schema is private, constrained, and preserves historical nulls", async () => {
      const rls = await pool.query(`
        select relname, relrowsecurity
        from pg_class
        join pg_namespace on pg_namespace.oid = pg_class.relnamespace
        where nspname = $1
          and relname in (
            'sidestream_acquisitions',
            'sidestream_acquisition_stages',
            'sidestream_acquisition_conflicts'
          )
        order by relname
      `, [schema]);
      assert.deepEqual(rls.rows, [
        { relname: "sidestream_acquisition_conflicts", relrowsecurity: true },
        { relname: "sidestream_acquisition_stages", relrowsecurity: true },
        { relname: "sidestream_acquisitions", relrowsecurity: true },
      ]);

      const historical = await pool.query(`
        select acquisition_id, state
        from ${quotedSchema}.sidestream_checkout_intents
        where id = '10000000-0000-4000-8000-000000000001'
      `);
      assert.deepEqual(historical.rows, [{ acquisition_id: null, state: "pending" }]);
      await pool.query(`
        update ${quotedSchema}.sidestream_checkout_intents
        set state = 'expired'
        where id = '10000000-0000-4000-8000-000000000001'
      `);
      await assert.rejects(
        insertCheckoutIntent(pool, quotedSchema, {
          id: "10000000-0000-4000-8000-000000000002",
          browserHash: "2".repeat(64),
          acquisitionId: null,
        }),
        postgresError("23502"),
      );
      assert.deepEqual(await protectedRows(pool, quotedSchema), protectedBefore);
    });

    await t.test("root creation and concurrent landing replay converge", async () => {
      const input = {
        acquisitionId: ROOT_ONE,
        firstObservedAt: FIRST_OBSERVED,
        landingDeduplicationReference: "landing-request-one",
      };
      const [first, replay] = await Promise.all([
        createCanonicalAcquisitionRoot(input, { transaction, namespace: "test" }),
        createCanonicalAcquisitionRoot(input, { transaction, namespace: "test" }),
      ]);
      assert.equal(first.id, ROOT_ONE);
      assert.equal(replay.id, ROOT_ONE);
      assert.equal(first.firstObserved.source, "website_direct_or_unknown");
      assert.equal(first.entryChannel, "website");
      assert.equal(first.attributionConfidence, "exact_sidestream_entry");
      assert.equal(await count(pool, quotedSchema, "sidestream_acquisitions"), 1);
      assert.equal(await count(pool, quotedSchema, "sidestream_acquisition_stages"), 1);

      await assert.rejects(
        pool.query(`
          update ${quotedSchema}.sidestream_acquisitions
          set first_observed_source = 'facebook'
          where id = $1
        `, [ROOT_ONE]),
        postgresError("23514"),
      );
      await assert.rejects(
        pool.query(`
          insert into ${quotedSchema}.sidestream_acquisition_stages (
            acquisition_id, license_namespace, stage, counting_grain,
            deduplication_key, occurred_at
          ) values ($1, 'test', 'checkout_started', 'payment', $2, $3)
        `, [ROOT_ONE, "a".repeat(64), FIRST_OBSERVED]),
        postgresError("23514"),
      );
    });

    await t.test("all stage retries and concurrent webhook replays retain the first fact", async () => {
      const firstOccurredAt = "2026-08-03T12:10:00.000Z";
      const laterOccurredAt = "2026-08-03T12:11:00.000Z";
      const calls = Array.from({ length: 8 }, (_, index) => recordAcquisitionStage({
        acquisitionId: ROOT_ONE,
        stage: "payment_settled",
        stableServerReference: "verified-payment-one",
        occurredAt: index === 0 ? firstOccurredAt : laterOccurredAt,
      }, { transaction, namespace: "test" }));
      const results = await Promise.all(calls);
      assert.equal(new Set(results.map((row) => row.id)).size, 1);
      assert.equal(new Set(results.map((row) => row.deduplicationKey)).size, 1);
      assert.ok(results.every((row) => row.countingGrain === "payment"));
      assert.ok(results.every((row) => row.ownerConflict === false));
      assert.ok(results.every((row) => row.occurredAt === firstOccurredAt));
      const rows = await pool.query(`
        select count(*)::int as count
        from ${quotedSchema}.sidestream_acquisition_stages
        where stage = 'payment_settled'
      `);
      assert.equal(rows.rows[0].count, 1);
    });

    await t.test("namespace isolation and conflicting ownership fail closed without guessing", async () => {
      await assert.rejects(
        createCanonicalAcquisitionRoot({
          acquisitionId: ROOT_ONE,
          firstObservedAt: FIRST_OBSERVED,
          landingDeduplicationReference: "production-landing-one",
        }, { transaction, namespace: "production" }),
        (error) => error?.code === "namespace_conflict",
      );
      const production = await createCanonicalAcquisitionRoot({
        acquisitionId: ROOT_PRODUCTION,
        firstObservedAt: FIRST_OBSERVED,
        landingDeduplicationReference: "landing-request-one",
      }, { transaction, namespace: "production" });
      assert.equal(production.licenseNamespace, "production");

      await createCanonicalAcquisitionRoot({
        acquisitionId: ROOT_TWO,
        firstObservedAt: FIRST_OBSERVED,
        landingDeduplicationReference: "landing-request-two",
        source: "facebook",
        medium: "paid_social",
        campaign: "Launch_01",
        externalReferrerCategory: "social",
      }, { transaction, namespace: "test" });
      const first = await recordAcquisitionStage({
        acquisitionId: ROOT_ONE,
        stage: "checkout_completed",
        stableServerReference: "same-verified-checkout",
        occurredAt: "2026-08-03T12:20:00.000Z",
      }, { transaction, namespace: "test" });
      const conflict = await recordAcquisitionStage({
        acquisitionId: ROOT_TWO,
        stage: "checkout_completed",
        stableServerReference: "same-verified-checkout",
        occurredAt: "2026-08-03T12:21:00.000Z",
      }, { transaction, namespace: "test" });
      assert.equal(first.ownerConflict, false);
      assert.equal(conflict.ownerConflict, true);
      assert.equal(conflict.acquisitionId, ROOT_ONE);
      const states = await pool.query(`
        select id, integrity_state
        from ${quotedSchema}.sidestream_acquisitions
        where id = any($1::uuid[])
        order by id
      `, [[ROOT_ONE, ROOT_TWO]]);
      assert.deepEqual(states.rows, [
        { id: ROOT_ONE, integrity_state: "quarantined" },
        { id: ROOT_TWO, integrity_state: "quarantined" },
      ]);
      assert.equal(await count(pool, quotedSchema, "sidestream_acquisition_conflicts"), 2);
      await assert.rejects(
        pool.query(`
          update ${quotedSchema}.sidestream_acquisition_stages
          set occurred_at = occurred_at + interval '1 second'
          where stage = 'checkout_completed'
        `),
        postgresError("55000"),
      );
    });

    await t.test("new Checkout rows bind exactly while protected domains stay unchanged", async () => {
      await insertCheckoutIntent(pool, quotedSchema, {
        id: "10000000-0000-4000-8000-000000000003",
        browserHash: "3".repeat(64),
        acquisitionId: ROOT_ONE,
      });
      const checkout = await pool.query(`
        select acquisition_id
        from ${quotedSchema}.sidestream_checkout_intents
        where id = '10000000-0000-4000-8000-000000000003'
      `);
      assert.equal(checkout.rows[0].acquisition_id, ROOT_ONE);
      assert.deepEqual(await protectedRows(pool, quotedSchema), protectedBefore);
    });
  } finally {
    if (schemaCreated) await pool.query(`drop schema if exists ${quotedSchema} cascade`);
    await pool.end();
  }
});

async function applyMigration(pool, quotedSchema, filename) {
  const sql = await readFile(join(repositoryRoot, "db/migrations", filename), "utf8");
  await pool.query(sql.replace(/\bpublic\./g, `${quotedSchema}.`));
}

function createTransaction(pool, quotedSchema) {
  return async (callback) => {
    const client = await pool.connect();
    const scoped = {
      query: (sql, params = []) => client.query(
        sql.replace(/\bpublic\./g, `${quotedSchema}.`),
        params,
      ),
    };
    try {
      await client.query("begin");
      const result = await callback(scoped);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };
}

async function insertCheckoutIntent(pool, quotedSchema, input) {
  return pool.query(`
    insert into ${quotedSchema}.sidestream_checkout_intents (
      id, intent_kind, browser_token_hash, state, acquisition_id,
      expires_at, created_at, updated_at
    ) values ($1, 'anonymous', $2, 'pending', $3,
      '2026-08-04T12:00:00Z', '2026-08-03T12:00:00Z', '2026-08-03T12:00:00Z')
  `, [input.id, input.browserHash, input.acquisitionId]);
}

async function protectedRows(pool, quotedSchema) {
  const result = await pool.query(`
    select
      (select jsonb_agg(to_jsonb(row_value) order by row_value.id)
       from ${quotedSchema}.sidestream_licenses row_value) as licenses,
      (select jsonb_agg(to_jsonb(row_value) order by row_value.id)
       from ${quotedSchema}.sidestream_account_devices row_value) as devices,
      (select jsonb_agg(to_jsonb(row_value) order by row_value.id)
       from ${quotedSchema}.sidestream_customer_commerce_facts row_value) as commerce
  `);
  return result.rows[0];
}

async function count(pool, quotedSchema, table) {
  const result = await pool.query(`select count(*)::int as count from ${quotedSchema}.${table}`);
  return result.rows[0].count;
}

function postgresError(code) {
  return (error) => error?.code === code;
}

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new TypeError("Unsafe schema");
  return `"${identifier}"`;
}

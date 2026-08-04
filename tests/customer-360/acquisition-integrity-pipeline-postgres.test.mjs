import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import "../helpers/customer-360-network-guard.mjs";
import {
  ACQUISITION_PRIVACY_EXCLUSIONS,
  ACQUISITION_STAGES,
  ACQUISITION_STAGE_COUNTING_GRAINS,
  createCanonicalAcquisitionRoot,
  recordAcquisitionStage,
  summarizeAcquisitionStages,
} from "../../api/_lib/acquisition-integrity.ts";
import {
  createTestPoolOptions,
  requireSafeTestDatabaseUrl,
} from "../../scripts/run-postgres-integration.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const checkoutMigration = "20260713203000_add_checkout_intents.sql";
const acquisitionMigration = "20260803120000_add_acquisition_integrity.sql";
const ROOT = "80000000-0000-4000-8000-000000000001";
const CONFLICT_ROOT = "80000000-0000-4000-8000-000000000002";
const MISSING_ROOT = "80000000-0000-4000-8000-000000000003";
const HISTORICAL_ROOT = "80000000-0000-4000-8000-000000000004";
const INTENT = "81000000-0000-4000-8000-000000000001";
const HISTORICAL_INTENT = "81000000-0000-4000-8000-000000000002";
const FIRST_OBSERVED = "2026-08-03T12:00:00.000Z";

test("canonical acquisition pipeline binds every new intent and retains its complete ledger", {
  timeout: 120_000,
}, async () => {
  const databaseUrl = requireSafeTestDatabaseUrl(process.env);
  const schema = `sidestream_acquisition_pipeline_${randomBytes(8).toString("hex")}`;
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
        $1, 'anonymous', $2, 'pending', '2026-08-04T12:00:00Z',
        '2026-08-03T12:00:00Z', '2026-08-03T12:00:00Z'
      )
    `, [HISTORICAL_INTENT, "f".repeat(64)]);
    await applyMigration(pool, quotedSchema, acquisitionMigration);

    const root = await createCanonicalAcquisitionRoot({
      acquisitionId: ROOT,
      firstObservedAt: FIRST_OBSERVED,
      landingDeduplicationReference: `browser-entry:${ROOT}`,
      source: "manychat",
      medium: "email",
      campaign: "Journey_Matrix",
      entryChannel: "manychat_email",
      externalReferrerCategory: "messaging",
      attributionConfidence: "exact_trusted_delivery",
      trustedDeliveryEvidence: ["signed_email_handoff"],
    }, { transaction, namespace: "test" });
    assert.deepEqual({
      id: root.id,
      source: root.firstObserved.source,
      channel: root.entryChannel,
      confidence: root.attributionConfidence,
      namespace: root.licenseNamespace,
    }, {
      id: ROOT,
      source: "manychat",
      channel: "manychat_email",
      confidence: "exact_trusted_delivery",
      namespace: "test",
    });

    await pool.query(`
      insert into ${quotedSchema}.sidestream_checkout_intents (
        id, acquisition_id, intent_kind, browser_token_hash, state,
        stripe_customer_id, stripe_checkout_session_id, stripe_checkout_url,
        stripe_price_id, stripe_product_id, stripe_session_expires_at,
        confirmed_at, expires_at, created_at, updated_at
      ) values (
        $1, $2, 'anonymous', $3, 'completed',
        'cus_matrix_exact', 'cs_matrix_exact', 'https://checkout.stripe.test/matrix',
        'price_matrix_exact', 'prod_matrix_exact', '2026-08-03T13:00:00Z',
        '2026-08-03T12:05:00Z', '2026-08-04T12:00:00Z',
        '2026-08-03T12:01:00Z', '2026-08-03T12:05:00Z'
      )
    `, [INTENT, ROOT, "a".repeat(64)]);

    const stagesToRecord = ACQUISITION_STAGES.filter((stage) => stage !== "landing_observed");
    for (const [index, stage] of stagesToRecord.entries()) {
      const input = {
        acquisitionId: ROOT,
        stage,
        stableServerReference: `${stage}:matrix-reference-${index}`,
        occurredAt: new Date(Date.parse(FIRST_OBSERVED) + (index + 1) * 60_000),
      };
      const replays = await Promise.all(Array.from({ length: 4 }, () =>
        recordAcquisitionStage(input, { transaction, namespace: "test" })
      ));
      assert.equal(new Set(replays.map((row) => row.id)).size, 1, stage);
      assert.equal(new Set(replays.map((row) => row.deduplicationKey)).size, 1, stage);
      assert.ok(replays.every((row) => row.ownerConflict === false), stage);
    }

    const storedStages = await pool.query(`
      select stage, counting_grain, occurred_at
      from ${quotedSchema}.sidestream_acquisition_stages
      where acquisition_id = $1
      order by occurred_at, stage
    `, [ROOT]);
    assert.equal(storedStages.rows.length, ACQUISITION_STAGES.length);
    assert.deepEqual(
      Object.fromEntries(storedStages.rows.map((row) => [row.stage, row.counting_grain])),
      ACQUISITION_STAGE_COUNTING_GRAINS,
    );
    const summary = summarizeAcquisitionStages(storedStages.rows.map((row) => ({
      stage: row.stage,
      occurredAt: row.occurred_at,
    })));
    assert.deepEqual(summary.missingStages, []);
    assert.deepEqual(summary.conflictingStages, []);
    assert.ok(Object.values(summary.counts).every((count) => count === "1"));

    const intent = await pool.query(`
      select acquisition_id, stripe_customer_id, stripe_checkout_session_id, state
      from ${quotedSchema}.sidestream_checkout_intents where id = $1
    `, [INTENT]);
    assert.deepEqual(intent.rows[0], {
      acquisition_id: ROOT,
      stripe_customer_id: "cus_matrix_exact",
      stripe_checkout_session_id: "cs_matrix_exact",
      state: "completed",
    });

    const historical = await pool.query(`
      select acquisition_id, state
      from ${quotedSchema}.sidestream_checkout_intents where id = $1
    `, [HISTORICAL_INTENT]);
    assert.deepEqual(historical.rows, [{ acquisition_id: null, state: "pending" }]);
    await assert.rejects(
      pool.query(`
        insert into ${quotedSchema}.sidestream_checkout_intents (
          intent_kind, browser_token_hash, state, expires_at, created_at, updated_at
        ) values ('anonymous', $1, 'pending', '2026-08-04T12:00:00Z',
          '2026-08-03T12:00:00Z', '2026-08-03T12:00:00Z')
      `, ["b".repeat(64)]),
      (error) => error?.code === "23502",
    );

    await createCanonicalAcquisitionRoot({
      acquisitionId: CONFLICT_ROOT,
      firstObservedAt: FIRST_OBSERVED,
      landingDeduplicationReference: `browser-entry:${CONFLICT_ROOT}`,
      source: "facebook",
      medium: "paid_social",
      campaign: "Journey_Matrix",
      entryChannel: "website",
    }, { transaction, namespace: "test" });
    const ownerConflict = await recordAcquisitionStage({
      acquisitionId: CONFLICT_ROOT,
      stage: "payment_settled",
      stableServerReference: "payment_settled:matrix-reference-6",
      occurredAt: "2026-08-03T12:30:00Z",
    }, { transaction, namespace: "test" });
    assert.equal(ownerConflict.ownerConflict, true);
    assert.equal(ownerConflict.acquisitionId, ROOT);

    await createCanonicalAcquisitionRoot({
      acquisitionId: MISSING_ROOT,
      firstObservedAt: FIRST_OBSERVED,
      landingDeduplicationReference: `missing:${MISSING_ROOT}`,
      source: "unknown_source",
      entryChannel: "account",
      attributionConfidence: "missing_internal_linkage",
      integrityState: "missing_internal_linkage",
      trustedDeliveryEvidence: ["authenticated_account"],
      recordLandingObserved: false,
    }, { transaction, namespace: "test" });
    await createCanonicalAcquisitionRoot({
      acquisitionId: HISTORICAL_ROOT,
      firstObservedAt: FIRST_OBSERVED,
      landingDeduplicationReference: `historical:${HISTORICAL_ROOT}`,
      source: "legacy_unknown",
      entryChannel: "account",
      attributionConfidence: "historical_unlinked",
      integrityState: "historical_unlinked",
      trustedDeliveryEvidence: ["authenticated_account"],
      recordLandingObserved: false,
    }, { transaction, namespace: "test" });
    const alerts = await pool.query(`
      select integrity_state, count(*)::integer as count
      from ${quotedSchema}.sidestream_acquisitions
      where integrity_state in ('missing_internal_linkage', 'historical_unlinked')
      group by integrity_state order by integrity_state
    `);
    assert.deepEqual(alerts.rows, [
      { integrity_state: "historical_unlinked", count: 1 },
      { integrity_state: "missing_internal_linkage", count: 1 },
    ]);

    await assert.rejects(
      createCanonicalAcquisitionRoot({
        acquisitionId: ROOT,
        firstObservedAt: FIRST_OBSERVED,
        landingDeduplicationReference: "production-reuse",
      }, { transaction, namespace: "production" }),
      (error) => error?.code === "namespace_conflict",
    );

    const columns = await pool.query(`
      select column_name
      from information_schema.columns
      where table_schema = $1
        and table_name in (
          'sidestream_acquisitions',
          'sidestream_acquisition_stages',
          'sidestream_acquisition_conflicts'
        )
    `, [schema]);
    const normalizedColumns = new Set(columns.rows.map((row) => normalizeKey(row.column_name)));
    for (const field of ACQUISITION_PRIVACY_EXCLUSIONS) {
      assert.equal(normalizedColumns.has(normalizeKey(field)), false, field);
    }
    for (const field of [
      "email", "browser_token", "stripe_payload", "telemetry_payload",
      "install_id_hash", "installer_receipt_id_hash",
    ]) {
      assert.equal(normalizedColumns.has(normalizeKey(field)), false, field);
    }
    assert.deepEqual(globalThis.__SIDESTREAM_CUSTOMER_360_NETWORK_GUARD__, {
      allowedProtocol: "postgres",
      allowedHost: new URL(databaseUrl).hostname.toLowerCase(),
      allowedPort: Number(new URL(databaseUrl).port || 5432),
      stripe: "blocked",
      vercel: "blocked",
    });
  } finally {
    if (schemaCreated) await pool.query(`drop schema if exists ${quotedSchema} cascade`).catch(() => {});
    await pool.end().catch(() => {});
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

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new TypeError("Unsafe schema");
  return `"${identifier}"`;
}

function normalizeKey(value) {
  return String(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

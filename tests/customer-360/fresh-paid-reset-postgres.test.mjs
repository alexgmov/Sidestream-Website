import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import {
  loadMigrationFiles,
  migrationSqlForTransaction,
  validateMigrationFiles,
} from "../../scripts/apply-postgres-migrations.mjs";
import { inventoryFreshPaidClosure } from "../../scripts/reset-alex-upgrade-state.mjs";
import {
  createTestPoolOptions,
  requireSafeTestDatabaseUrl,
} from "../../scripts/run-postgres-integration.mjs";

test("fresh-paid inventory closes over profile ancestors and descendants", {
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

    const inventoryClient = scopedInventoryClient(pool, schema);
    const first = await inventoryFreshPaidClosure(inventoryClient, []);
    assert.deepEqual(
      [...first.profileIds].sort(),
      [root, alexSeed, child, grandchild].sort(),
    );
    assert.equal(first.profileIds.includes(unrelated), false);
    assert.equal(first.profileIds.includes(otherNamespaceAlex), false);

    const replay = await inventoryFreshPaidClosure(inventoryClient, []);
    assert.deepEqual(replay, first);
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

function rewritePublicSchema(source, schema) {
  return source.replace(/\bpublic\./g, `${quoteIdentifier(schema)}.`);
}

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
    throw new TypeError("Unsafe Postgres identifier");
  }
  return `"${identifier}"`;
}

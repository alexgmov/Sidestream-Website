import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { loadInjectedModule } from "./helpers/handler-loader.mjs";
import {
  createTestPoolOptions,
  requireSafeTestDatabaseUrl,
} from "../scripts/run-postgres-integration.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportModule = await loadInjectedModule(
  new URL("../api/_lib/meta-roas-report.ts", import.meta.url),
  {
    "./postgres.js": {
      withPostgresTransaction: async () => {
        throw new Error("Meta ROAS Postgres test injects its disposable schema.");
      },
    },
  },
);

test("Meta ROAS SQL runs against the full schema and keeps unmatched spend explicit", {
  timeout: 120_000,
}, async () => {
  const databaseUrl = requireSafeTestDatabaseUrl(process.env);
  const schema = `sidestream_meta_roas_${randomBytes(8).toString("hex")}`;
  const quotedSchema = quoteIdentifier(schema);
  const pool = new Pool(createTestPoolOptions(databaseUrl));
  let schemaCreated = false;
  try {
    await pool.query(`create schema ${quotedSchema}`);
    schemaCreated = true;
    const migrations = (await readdir(join(repositoryRoot, "db/migrations")))
      .filter((filename) => /^\d{14}_[a-z0-9_]+\.sql$/.test(filename))
      .sort();
    for (const filename of migrations) {
      const sql = await readFile(join(repositoryRoot, "db/migrations", filename), "utf8");
      await pool.query(sql.replace(/\bpublic\./g, `${quotedSchema}.`));
    }
    await pool.query(`
      insert into ${quotedSchema}.sidestream_meta_ad_spend_daily (
        license_namespace, spend_day, campaign, creative_key, ad_id, currency,
        spend_minor, impressions, clicks, import_batch_hash
      ) values (
        'test', '2026-08-30', 'sidestream_direct_offer_test', '2385001',
        '2385001', 'usd', 1234, 10000, 225, repeat('a', 64)
      )
    `);

    const transaction = async (callback) => {
      const client = await pool.connect();
      try {
        await client.query("begin isolation level repeatable read read only");
        const value = await callback({
          query: (sql, parameters = []) => client.query(
            sql.replace(/\bpublic\./g, `${quotedSchema}.`),
            [...parameters],
          ),
        });
        await client.query("commit");
        return value;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    };

    const report = await reportModule.queryMetaRoasReport({
      licenseNamespace: "test",
      from: "2026-08-01T00:00:00Z",
      through: "2026-08-31T00:00:00Z",
      asOf: "2026-08-31T12:00:00Z",
      campaign: "sidestream_direct_offer_test",
    }, { transaction });
    assert.equal(report.totals.traffic.acquisitions, "0");
    assert.equal(report.creatives.length, 1);
    assert.equal(report.creatives[0].creativeKey, "2385001");
    assert.equal(report.creatives[0].moneyByCurrency[0].spendMinor, "1234");
    assert.equal(report.creatives[0].moneyByCurrency[0].status, "spend_without_acquisition");
    assert.equal(report.integrity.creativeCurrencyRowsSpendWithoutAcquisition, 1);
  } finally {
    if (schemaCreated) await pool.query(`drop schema ${quotedSchema} cascade`).catch(() => {});
    await pool.end();
  }
});

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

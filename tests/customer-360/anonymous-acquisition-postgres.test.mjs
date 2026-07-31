import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import {
  claimAnonymousAcquisitionSession,
  createAnonymousAcquisitionAssignment,
  createAnonymousAcquisitionSession,
  generateAnonymousAcquisitionToken,
  recordAnonymousAcquisitionInstallerRequest,
} from "../../api/_lib/anonymous-acquisition.ts";
import {
  createTestPoolOptions,
  requireSafeTestDatabaseUrl,
} from "../../scripts/run-postgres-integration.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migrations = [
  "20260715120000_add_customer_360_core.sql",
  "20260731120000_add_anonymous_acquisition_sessions.sql",
];
const SECRET = "anonymous-acquisition-postgres-secret-minimum-32-bytes";
const FIRST_SEEN = "2026-07-31T10:00:00.000Z";
const PROFILE_ONE = "00000000-0000-4000-8000-000000000001";
const PROFILE_TWO = "00000000-0000-4000-8000-000000000002";

test("anonymous acquisition is first-touch immutable, namespaced, quarantined, and isolated", {
  timeout: 120_000,
}, async () => {
  const databaseUrl = requireSafeTestDatabaseUrl(process.env);
  const schema = `sidestream_anonymous_acq_${randomBytes(8).toString("hex")}`;
  const quotedSchema = quoteIdentifier(schema);
  const pool = new Pool(createTestPoolOptions(databaseUrl));
  let schemaCreated = false;
  const transaction = createTransaction(pool, quotedSchema);

  try {
    await pool.query(`create schema ${quotedSchema}`);
    schemaCreated = true;
    for (const filename of migrations) {
      const sql = await readFile(join(repositoryRoot, "db/migrations", filename), "utf8");
      await pool.query(sql.replace(/\bpublic\./g, `${quotedSchema}.`));
    }
    await pool.query(`
      create table ${quotedSchema}.sidestream_licenses (
        id uuid primary key, entitlement_status text not null
      );
      create table ${quotedSchema}.sidestream_account_devices (
        id uuid primary key, device_state text not null
      );
      insert into ${quotedSchema}.sidestream_licenses values
        ('10000000-0000-4000-8000-000000000001', 'active');
      insert into ${quotedSchema}.sidestream_account_devices values
        ('20000000-0000-4000-8000-000000000001', 'active');
      insert into ${quotedSchema}.sidestream_customer_profiles (
        id, license_namespace, created_at, updated_at
      ) values
        ('${PROFILE_ONE}', 'test', '2026-07-01', '2026-07-01'),
        ('${PROFILE_TWO}', 'test', '2026-07-02', '2026-07-02');
    `);

    const token = generateAnonymousAcquisitionToken();
    const direct = await createAnonymousAcquisitionSession({
      token,
      firstSeenAt: FIRST_SEEN,
    }, { transaction, namespace: "test" });
    assert.equal(direct.firstTouch.source, "direct");
    assert.equal(direct.attributionConfidence, "direct");
    assert.notEqual(direct.tokenHash, token);
    assert.equal(await count(pool, quotedSchema, "sidestream_customer_profiles"), 2);

    const filled = await createAnonymousAcquisitionSession({
      token,
      attribution: { campaign: "LateValidCampaign", content: "hero" },
      firstSeenAt: "2026-08-01T10:00:00.000Z",
    }, { transaction, namespace: "test" });
    assert.equal(filled.id, direct.id);
    assert.equal(filled.firstSeenAt, FIRST_SEEN);
    assert.equal(filled.firstTouch.campaign, "LateValidCampaign");
    assert.equal(filled.firstTouch.content, "hero");

    const preserved = await createAnonymousAcquisitionSession({
      token,
      attribution: { campaign: "LateValidCampaign", content: "hero" },
      firstSeenAt: FIRST_SEEN,
    }, { transaction, namespace: "test" });
    assert.equal(preserved.claimState, "unclaimed");

    const production = await createAnonymousAcquisitionSession({
      token,
      attribution: { source: "reddit", campaign: "Launch" },
      firstSeenAt: FIRST_SEEN,
    }, { transaction, namespace: "production" });
    assert.notEqual(production.id, direct.id);
    assert.equal(production.licenseNamespace, "production");

    const quarantined = await createAnonymousAcquisitionSession({
      token,
      attribution: { source: "manychat", campaign: "LateValidCampaign", content: "hero" },
      firstSeenAt: FIRST_SEEN,
    }, { transaction, namespace: "test" });
    assert.equal(quarantined.claimState, "quarantined");
    assert.ok(quarantined.quarantinedAt);
    const conflictReplay = await createAnonymousAcquisitionSession({
      token,
      attribution: { source: "manychat", campaign: "LateValidCampaign", content: "hero" },
      firstSeenAt: FIRST_SEEN,
    }, { transaction, namespace: "test" });
    assert.equal(conflictReplay.quarantinedAt, quarantined.quarantinedAt);
    assert.equal(await count(pool, quotedSchema, "sidestream_anonymous_acquisition_conflicts"), 1);

    const assignedToken = generateAnonymousAcquisitionToken();
    const assignment = createAnonymousAcquisitionAssignment({
      experimentId: "anonymous-download-v1",
      cohort: "freemium",
      issuedAt: new Date("2026-07-31T09:00:00.000Z"),
      expiresAt: new Date("2026-08-02T09:00:00.000Z"),
      secret: SECRET,
    });
    const assigned = await createAnonymousAcquisitionSession({
      token: assignedToken,
      assignment,
      assignmentSecret: SECRET,
      firstSeenAt: FIRST_SEEN,
    }, { transaction, namespace: "test" });
    assert.equal(assigned.experiment.experimentId, "anonymous-download-v1");
    assert.equal(assigned.experiment.cohort, "freemium");
    assert.equal(assigned.attributionConfidence, "signed_freemium");
    const originalSignatureHash = assigned.experiment.signatureHash;
    const refreshedAssignment = createAnonymousAcquisitionAssignment({
      experimentId: "anonymous-download-v1",
      cohort: "freemium",
      issuedAt: new Date("2026-07-31T09:30:00.000Z"),
      expiresAt: new Date("2026-08-02T09:30:00.000Z"),
      secret: SECRET,
    });
    const assignmentReplay = await createAnonymousAcquisitionSession({
      token: assignedToken,
      assignment: refreshedAssignment,
      assignmentSecret: SECRET,
      firstSeenAt: FIRST_SEEN,
    }, { transaction, namespace: "test" });
    assert.equal(assignmentReplay.claimState, "unclaimed");
    assert.equal(assignmentReplay.experiment.signatureHash, originalSignatureHash);

    const firstInstaller = await recordAnonymousAcquisitionInstallerRequest({
      token: assignedToken,
      platform: "macos",
      requestedAt: "2026-07-31T11:00:00.000Z",
    }, { transaction, namespace: "test" });
    const installerReplay = await recordAnonymousAcquisitionInstallerRequest({
      token: assignedToken,
      platform: "windows",
      requestedAt: "2026-07-31T12:00:00.000Z",
    }, { transaction, namespace: "test" });
    assert.equal(installerReplay.firstInstallerRequestedAt, firstInstaller.firstInstallerRequestedAt);
    assert.equal(installerReplay.firstInstallerPlatform, "macos");

    const claimed = await claimAnonymousAcquisitionSession({
      token: assignedToken,
      profileId: PROFILE_ONE,
      claimedAt: "2026-07-31T12:30:00.000Z",
    }, { transaction, namespace: "test" });
    assert.equal(claimed.claimState, "claimed");
    assert.equal(claimed.claimedProfileId, PROFILE_ONE);
    const claimReplay = await claimAnonymousAcquisitionSession({
      token: assignedToken,
      profileId: PROFILE_ONE,
      claimedAt: "2026-07-31T13:00:00.000Z",
    }, { transaction, namespace: "test" });
    assert.equal(claimReplay.claimedAt, claimed.claimedAt);
    const claimConflict = await claimAnonymousAcquisitionSession({
      token: assignedToken,
      profileId: PROFILE_TWO,
      claimedAt: "2026-07-31T13:30:00.000Z",
    }, { transaction, namespace: "test" });
    assert.equal(claimConflict.claimState, "quarantined");
    assert.equal(claimConflict.claimedProfileId, PROFILE_ONE);

    const stored = await pool.query(`
      select * from ${quotedSchema}.sidestream_anonymous_acquisition_sessions
      where license_namespace = 'test' and token_hash = $1
    `, [direct.tokenHash]);
    assert.equal(stored.rows.length, 1);
    assert.equal(JSON.stringify(stored.rows).includes(token), false);
    for (const forbidden of [
      "ip", "user_agent", "email", "install_id_hash", "receipt_hash",
      "telemetry_payload", "browser_token",
    ]) assert.equal(Object.hasOwn(stored.rows[0], forbidden), false, forbidden);

    const untouched = await pool.query(`
      select
        (select json_agg(row_to_json(license)) from ${quotedSchema}.sidestream_licenses license) as licenses,
        (select json_agg(row_to_json(device)) from ${quotedSchema}.sidestream_account_devices device) as devices
    `);
    assert.deepEqual(untouched.rows[0].licenses, [{
      id: "10000000-0000-4000-8000-000000000001",
      entitlement_status: "active",
    }]);
    assert.deepEqual(untouched.rows[0].devices, [{
      id: "20000000-0000-4000-8000-000000000001",
      device_state: "active",
    }]);

    const rls = await pool.query(`
      select relname, relrowsecurity
      from pg_class
      where relnamespace = $1::regnamespace
        and relname in (
          'sidestream_anonymous_acquisition_sessions',
          'sidestream_anonymous_acquisition_conflicts'
        )
      order by relname
    `, [schema]);
    assert.deepEqual(rls.rows, [
      { relname: "sidestream_anonymous_acquisition_conflicts", relrowsecurity: true },
      { relname: "sidestream_anonymous_acquisition_sessions", relrowsecurity: true },
    ]);

    await assert.rejects(
      pool.query(`update ${quotedSchema}.sidestream_anonymous_acquisition_conflicts set conflict_type = 'profile_claim'`),
      (error) => error?.code === "55000",
    );
  } finally {
    if (schemaCreated) await pool.query(`drop schema if exists ${quotedSchema} cascade`);
    await pool.end();
  }
});

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

async function count(pool, quotedSchema, table) {
  const result = await pool.query(`select count(*)::int as count from ${quotedSchema}.${table}`);
  return result.rows[0].count;
}

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new TypeError("Unsafe schema");
  return `"${identifier}"`;
}

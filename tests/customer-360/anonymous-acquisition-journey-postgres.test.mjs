import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import {
  createAnonymousAcquisitionSession,
  generateAnonymousAcquisitionToken,
  recordAnonymousAcquisitionInstallerRequest,
} from "../../api/_lib/anonymous-acquisition.ts";
import {
  completeAnonymousInstallationClaim,
  createAnonymousInstallationClaim,
} from "../../api/_lib/anonymous-install-claim.ts";
import { attachCustomerIdentity } from "../../api/_lib/customer-identity.ts";
import {
  createTestPoolOptions,
  requireSafeTestDatabaseUrl,
} from "../../scripts/run-postgres-integration.mjs";
import { loadInjectedModule } from "../helpers/handler-loader.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migrations = [
  "20260626120000_add_sidestream_download_leads.sql",
  "20260703120000_add_sidestream_accounts_billing.sql",
  "20260704150000_allow_one_time_checkout_licenses.sql",
  "20260713203000_add_checkout_intents.sql",
  "20260713205000_harden_download_leads.sql",
  "20260715120000_add_customer_360_core.sql",
  "20260715121000_add_customer_identity_links.sql",
  "20260715123000_add_customer_usage_aggregates.sql",
  "20260727010000_add_paid_acquisition_experiment.sql",
  "20260729120000_add_regional_checkout_offer_snapshots.sql",
  "20260731120000_add_anonymous_acquisition_sessions.sql",
];
const SECRET = "anonymous-acquisition-journey-postgres-secret-2026";
const ACCOUNT = "10000000-0000-4000-8000-000000000001";
const SOURCES = ["direct", "instagram", "facebook", "linkedin", "reddit"];
const ENVIRONMENT = Object.freeze({ namespace: "test" });

const funnelModule = await loadInjectedModule(
  new URL("../../api/_lib/acquisition-funnel.ts", import.meta.url),
  {
    "./postgres.js": {
      withPostgresTransaction: async () => {
        throw new Error("Journey tests inject their disposable schema");
      },
    },
  },
);

test("anonymous acquisition survives download, claim, retention, and later verified attachment", {
  timeout: 180_000,
}, async () => {
  const databaseUrl = requireSafeTestDatabaseUrl(process.env);
  const schema = `sidestream_anonymous_journey_${randomBytes(8).toString("hex")}`;
  const quotedSchema = quoteIdentifier(schema);
  const pool = new Pool(createTestPoolOptions(databaseUrl));
  const transaction = createTransaction(pool, quotedSchema);
  const readOnlyTransaction = createReadOnlyTransaction(pool, quotedSchema);
  let schemaCreated = false;

  try {
    await pool.query(`create schema ${quotedSchema}`);
    schemaCreated = true;
    for (const filename of migrations) {
      const sql = await readFile(join(repositoryRoot, "db/migrations", filename), "utf8");
      await pool.query(sql.replace(/\bpublic\./g, `${quotedSchema}.`));
    }

    const journeys = [];
    for (const [index, source] of SOURCES.entries()) {
      const firstSeenAt = new Date(Date.UTC(2026, 6, 20 + index, 9, 0, 0));
      const installerRequestedAt = new Date(firstSeenAt.getTime() + 10 * 60_000);
      const firstInstallAt = new Date(firstSeenAt.getTime() + 30 * 60_000);
      const firstOpenAt = new Date(firstSeenAt.getTime() + 2 * 60 * 60_000);
      const installIdHash = `${index + 1}`.repeat(64);
      const installerReceiptIdHash = "abcdef"[index].repeat(64);
      const token = generateAnonymousAcquisitionToken();

      await createAnonymousAcquisitionSession({
        token,
        attribution: source === "direct"
          ? undefined
          : { source, medium: "social", campaign: "anonymous-no-email" },
        firstSeenAt,
      }, { transaction, namespace: "test" });
      await recordAnonymousAcquisitionInstallerRequest({
        token,
        platform: index % 2 === 0 ? "macos" : "windows",
        requestedAt: installerRequestedAt,
      }, { transaction, namespace: "test" });

      const claimNow = new Date();
      const claim = await createAnonymousInstallationClaim({
        installIdHash,
        installerReceiptIdHash,
      }, {
        transaction,
        namespace: "test",
        secret: SECRET,
        now: claimNow,
      });
      const completed = await completeAnonymousInstallationClaim({
        nonce: claim.nonce,
        acquisitionToken: token,
      }, {
        transaction,
        namespace: "test",
        secret: SECRET,
        now: new Date(claimNow.getTime() + 1_000),
      });
      assert.equal(completed.outcome, "connected", source);
      assert.ok(completed.profileId, source);

      await pool.query(
        `update ${quotedSchema}.sidestream_customer_installs
         set platform = $1, app_version = '1.0.16',
             first_seen_at = $2, last_seen_at = $2
         where license_namespace = 'test' and install_id_hash = $3`,
        [index % 2 === 0 ? "macos" : "windows", firstInstallAt, installIdHash],
      );
      await insertUsageDay(pool, quotedSchema, {
        installIdHash,
        day: firstOpenAt.toISOString().slice(0, 10),
        firstOpenAt,
        attempts: 1,
        watermark: `first-open-${index}`,
      });
      if (source === "direct") {
        const laterOpenAt = new Date(firstOpenAt.getTime() + 2 * 24 * 60 * 60_000);
        await insertUsageDay(pool, quotedSchema, {
          installIdHash,
          day: laterOpenAt.toISOString().slice(0, 10),
          firstOpenAt: laterOpenAt,
          attempts: 0,
          watermark: "direct-retention",
        });
      }
      journeys.push({
        source,
        profileId: completed.profileId,
        token,
        installIdHash,
        installerReceiptIdHash,
        firstSeenAt,
        installerRequestedAt,
        firstInstallAt,
        firstOpenAt,
      });
    }

    const anonymousProfiles = await pool.query(
      `select id, contact_email from ${quotedSchema}.sidestream_customer_profiles
       where license_namespace = 'test' order by id`,
    );
    assert.equal(anonymousProfiles.rows.length, SOURCES.length);
    assert.ok(anonymousProfiles.rows.every((row) => row.contact_email === null));

    await pool.query(
      `insert into ${quotedSchema}.sidestream_accounts (
         id, google_sub, email, display_name, stripe_customer_id
       ) values ($1, 'verified-direct-account', 'direct@example.com', 'Direct Customer', null)`,
      [ACCOUNT],
    );
    const accountBefore = await accountState(pool, quotedSchema);
    const direct = journeys[0];
    const attached = await transaction((client) => attachCustomerIdentity(client, {
      environment: ENVIRONMENT,
      identity: {
        installIdHash: direct.installIdHash,
        installerReceiptIdHash: direct.installerReceiptIdHash,
      },
      accountId: ACCOUNT,
      platform: "macos",
      appVersion: "1.0.16",
      source: "license_verify",
    }));
    assert.deepEqual(attached, {
      profileId: direct.profileId,
      attached: true,
      reviewRequired: false,
    });
    assert.deepEqual(await accountState(pool, quotedSchema), accountBefore);

    const contacts = await pool.query(
      `select id, contact_email from ${quotedSchema}.sidestream_customer_profiles
       where license_namespace = 'test' order by id`,
    );
    assert.equal(
      contacts.rows.find((row) => row.id === direct.profileId)?.contact_email,
      "direct@example.com",
    );
    assert.ok(contacts.rows
      .filter((row) => row.id !== direct.profileId)
      .every((row) => row.contact_email === null));

    const report = await funnelModule.queryAcquisitionFunnel({
      licenseNamespace: "test",
      cohortStart: "2026-07-20T00:00:00Z",
      cohortEnd: "2026-07-26T00:00:00Z",
      observationEnd: "2026-08-01T00:00:00Z",
      journeyLimit: 10,
    }, { transaction: readOnlyTransaction });

    assert.deepEqual(report.totals, {
      profiles: "5",
      firstOpenedProfiles: "5",
      completedActivations: "0",
      paidCustomers: "0",
      returnEligibleProfiles: "5",
      returnedProfiles: "1",
      oneAndDoneProfiles: "4",
    });
    assert.deepEqual(report.attributionCoverage, {
      numerator: "5",
      denominator: "5",
      percentage: "100.00",
      paidAttributedProfiles: "0",
      anonymousAttributedProfiles: "5",
      freemiumAttributedProfiles: "0",
      unattributedProfiles: "0",
    });
    assert.equal(report.groups.length, SOURCES.length);
    assert.deepEqual(
      report.groups.map((group) => group.source).sort(),
      [...SOURCES].sort(),
    );
    assert.ok(report.groups.every((group) =>
      group.attributionConfidence === "exact_anonymous_claim" &&
      group.profileCount === "1"
    ));

    const directJourney = report.journeys.find(
      (journey) => journey.customerId === direct.profileId,
    );
    assert.equal(directJourney.source, "direct");
    assert.equal(directJourney.attributionConfidence, "exact_anonymous_claim");
    assert.equal(directJourney.firstVisitAt, direct.firstSeenAt.toISOString());
    assert.equal(
      directJourney.installerRequestedAt,
      direct.installerRequestedAt.toISOString(),
    );
    assert.equal(directJourney.firstInstallAt, direct.firstInstallAt.toISOString());
    assert.equal(directJourney.firstOpenAt, direct.firstOpenAt.toISOString());
    assert.equal(directJourney.dayZeroDownloadAttempts, "1");
    assert.deepEqual(directJourney.laterOpenDays, ["2026-07-22"]);
    assert.equal(directJourney.returned, true);
    assert.equal(directJourney.oneAndDone, false);

    for (const source of SOURCES.slice(1)) {
      const journeyFixture = journeys.find((journey) => journey.source === source);
      const journey = report.journeys.find(
        (candidate) => candidate.customerId === journeyFixture.profileId,
      );
      assert.equal(journey.source, source);
      assert.equal(journey.attributionConfidence, "exact_anonymous_claim");
      assert.equal(journey.dayZeroDownloadAttempts, "1");
      assert.deepEqual(journey.laterOpenDays, []);
      assert.equal(journey.oneAndDone, true);
    }

    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /direct@example\.com/);
    for (const journey of journeys) {
      assert.equal(serialized.includes(journey.token), false);
      assert.equal(serialized.includes(journey.installIdHash), false);
      assert.equal(serialized.includes(journey.installerReceiptIdHash), false);
    }
  } finally {
    if (schemaCreated) {
      await pool.query(`drop schema if exists ${quotedSchema} cascade`).catch(() => {});
    }
    await pool.end().catch(() => {});
  }
});

async function insertUsageDay(pool, schema, {
  installIdHash,
  day,
  firstOpenAt,
  attempts,
  watermark,
}) {
  await pool.query(
    `insert into ${schema}.sidestream_customer_usage_daily (
       license_namespace, install_id_hash, activity_day,
       first_app_use_at, last_app_use_at,
       first_download_attempt_at, last_download_attempt_at,
       active_event_count, download_attempt_count, download_outcome_count,
       download_success_count, download_failure_count,
       download_cancelled_count, download_pending_count,
       download_unknown_count, source_watermark_received_at,
       source_watermark_telemetry_event_id, refreshed_at
     ) values (
       'test', $1, $2, $3, $3,
       case when $4::bigint > 0 then $3::timestamptz else null end,
       case when $4::bigint > 0 then $3::timestamptz else null end,
       1, $4, 0, 0, 0, 0, $4, 0, $3, $5, $3
     )`,
    [installIdHash, day, firstOpenAt, attempts, watermark],
  );
}

async function accountState(pool, schema) {
  const result = await pool.query(
    `select id, google_sub, email, display_name, stripe_customer_id
     from ${schema}.sidestream_accounts order by id`,
  );
  return result.rows;
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

function createReadOnlyTransaction(pool, quotedSchema) {
  return async (callback) => {
    const client = await pool.connect();
    try {
      await client.query("begin isolation level repeatable read read only");
      const result = await callback({
        query: (sql, params = []) => client.query(
          sql.replace(/\bpublic\./g, `${quotedSchema}.`),
          params,
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
}

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new TypeError("Unsafe schema");
  return `"${identifier}"`;
}

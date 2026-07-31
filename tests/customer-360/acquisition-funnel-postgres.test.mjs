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
  "20260626120000_add_sidestream_download_leads.sql",
  "20260703120000_add_sidestream_accounts_billing.sql",
  "20260713203000_add_checkout_intents.sql",
  "20260713205000_harden_download_leads.sql",
  "20260715120000_add_customer_360_core.sql",
  "20260715121000_add_customer_identity_links.sql",
  "20260715123000_add_customer_usage_aggregates.sql",
  "20260727010000_add_paid_acquisition_experiment.sql",
];

const PROFILE_PAID = "00000000-0000-4000-8000-000000000001";
const PROFILE_FREEMIUM = "00000000-0000-4000-8000-000000000002";
const PROFILE_UNVERIFIED_EMAIL = "00000000-0000-4000-8000-000000000003";
const PROFILE_UNKNOWN = "00000000-0000-4000-8000-000000000004";
const ACCOUNT_FREEMIUM = "10000000-0000-4000-8000-000000000001";
const ACTIVATION_PAID = "20000000-0000-4000-8000-000000000001";
const CHECKOUT_INTENT = "30000000-0000-4000-8000-000000000001";
const ENTRY_PAID = "40000000-0000-4000-8000-000000000001";
const CHECKOUT_PAID = "50000000-0000-4000-8000-000000000001";
const RECEIPT_HASH = "a".repeat(64);
const ASSIGNMENT_HASH = "b".repeat(64);

const funnelModule = await loadInjectedModule(
  new URL("../../api/_lib/acquisition-funnel.ts", import.meta.url),
  {
    "./postgres.js": {
      withPostgresTransaction: async () => {
        throw new Error("Postgres funnel tests inject the disposable schema");
      },
    },
  },
);

test("acquisition funnel keeps attribution exact and retention UTC-day based", {
  timeout: 120_000,
}, async () => {
  const databaseUrl = requireSafeTestDatabaseUrl(process.env);
  const schema = `sidestream_c360_funnel_${randomBytes(8).toString("hex")}`;
  const quotedSchema = quoteIdentifier(schema);
  const pool = new Pool(createTestPoolOptions(databaseUrl));
  let schemaCreated = false;
  const transaction = async (callback) => {
    const client = await pool.connect();
    try {
      await client.query("begin isolation level repeatable read read only");
      const isolation = await client.query(
        "select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as read_only",
      );
      assert.deepEqual(isolation.rows[0], {
        isolation: "repeatable read",
        read_only: "on",
      });
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
    await seedFunnel(pool, quotedSchema);

    const report = await funnelModule.queryAcquisitionFunnel({
      licenseNamespace: "test",
      cohortStart: "2026-07-01T00:00:00Z",
      cohortEnd: "2026-08-01T00:00:00Z",
      journeyLimit: 3,
    }, { transaction });

    assert.deepEqual(report.dateWindow, {
      cohortStart: "2026-07-01T00:00:00.000Z",
      cohortEnd: "2026-08-01T00:00:00.000Z",
      endExclusive: true,
      cohortDefinition: "first_install_at",
      observationDefinition: "events_before_cohort_end",
    });
    assert.deepEqual(report.totals, {
      profiles: "4",
      firstOpenedProfiles: "2",
      completedActivations: "1",
    });
    assert.deepEqual(report.activationPercentage, {
      numerator: "1",
      denominator: "2",
      percentage: "50.00",
    });
    assert.deepEqual(report.attributionCoverage, {
      numerator: "2",
      denominator: "4",
      percentage: "50.00",
      paidAttributedProfiles: "1",
      freemiumAttributedProfiles: "1",
      unattributedProfiles: "2",
    });
    assert.equal(report.groups.length, 3);

    const paidGroup = report.groups.find(
      (group) => group.attributionConfidence === "verified_paid",
    );
    assert.deepEqual(paidGroup, {
      source: "manychat",
      medium: "dm",
      campaign: "paid-launch",
      experiment: "mc-mobile-paid-v1",
      cohort: "mc-paid-v1",
      attributionConfidence: "verified_paid",
      profileCount: "1",
      firstOpenedProfiles: "1",
      completedActivations: "1",
      activationPercentage: {
        numerator: "1",
        denominator: "1",
        percentage: "100.00",
      },
    });

    const freemium = report.journeys.find(
      (journey) => journey.customerId === PROFILE_FREEMIUM,
    );
    assert.equal(freemium.attributionConfidence, "verified_email");
    assert.equal(freemium.source, "manychat");
    assert.equal(freemium.medium, "dm");
    assert.equal(freemium.campaign, "freemium-launch");
    assert.equal(freemium.experiment, "mc-mobile-paid-v1");
    assert.equal(freemium.cohort, "mc-control-v1");
    assert.equal(freemium.dayZeroDownloadAttempts, "1");
    assert.deepEqual(freemium.laterOpenDays, []);
    assert.equal(freemium.oneAndDone, true);

    const paid = report.journeys.find(
      (journey) => journey.customerId === PROFILE_PAID,
    );
    assert.equal(paid.firstAttributedAt, "2026-07-01T08:00:00.000Z");
    assert.equal(paid.firstInstallAt, "2026-07-02T10:15:16.789Z");
    assert.equal(paid.firstOpenAt, "2026-07-02T11:00:00.000Z");
    assert.equal(paid.activationAt, "2026-07-03T12:00:00.000Z");
    assert.equal(paid.dayZeroDownloadAttempts, "2");
    assert.deepEqual(paid.laterOpenDays, ["2026-07-04"]);
    assert.equal(paid.oneAndDone, false);

    assert.equal(report.journeysReturned, 3);
    assert.equal(report.journeysTruncated, true);
    assert.deepEqual(report.journeys.map((journey) => journey.customerId), [
      PROFILE_PAID,
      PROFILE_FREEMIUM,
      PROFILE_UNVERIFIED_EMAIL,
    ]);
    assert.equal(
      report.journeys.find(
        (journey) => journey.customerId === PROFILE_UNVERIFIED_EMAIL,
      ).attributionConfidence,
      "unattributed",
    );

    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /freemium@example\.com|unverified@example\.com/);
    assert.doesNotMatch(serialized, new RegExp(RECEIPT_HASH));
    assert.doesNotMatch(serialized, new RegExp(ASSIGNMENT_HASH));
    assert.doesNotMatch(serialized, /cs_test_|install_id_hash|link_value/);

    const production = await funnelModule.queryAcquisitionFunnel({
      licenseNamespace: "production",
      cohortStart: "2026-07-01T00:00:00Z",
      cohortEnd: "2026-08-01T00:00:00Z",
    }, { transaction });
    assert.equal(production.totals.profiles, "0");
    assert.deepEqual(production.groups, []);
    assert.deepEqual(production.journeys, []);
  } finally {
    if (schemaCreated) {
      await pool.query(`drop schema if exists ${quotedSchema} cascade`).catch(() => {});
    }
    await pool.end().catch(() => {});
  }
});

async function seedFunnel(pool, schema) {
  await pool.query(
    `insert into ${schema}.sidestream_accounts (
       id, google_sub, email, created_at, updated_at
     ) values ($1, 'google-freemium', 'freemium@example.com',
       '2026-06-30T00:00:00Z', '2026-06-30T00:00:00Z')`,
    [ACCOUNT_FREEMIUM],
  );
  await pool.query(
    `insert into ${schema}.sidestream_activation_sessions (
       id, activation_key, status, completed_at, expires_at, created_at, updated_at
     ) values (
       $1, 'paid-activation-key', 'completed', '2026-07-03T12:00:00Z',
       '2026-08-01T00:00:00Z', '2026-07-03T11:00:00Z',
       '2026-07-03T12:00:00Z'
     )`,
    [ACTIVATION_PAID],
  );

  const profiles = [
    [PROFILE_PAID, null, "2026-07-02T10:15:16.789Z"],
    [PROFILE_FREEMIUM, "freemium@example.com", "2026-07-05T09:00:00Z"],
    [PROFILE_UNVERIFIED_EMAIL, "unverified@example.com", "2026-07-06T09:00:00Z"],
    [PROFILE_UNKNOWN, null, "2026-07-07T09:00:00Z"],
  ];
  for (const [profileId, email, firstInstallAt] of profiles) {
    await pool.query(
      `insert into ${schema}.sidestream_customer_profiles (
         id, license_namespace, contact_email, created_at, updated_at
       ) values ($1, 'test', $2, $3, $3)`,
      [profileId, email, firstInstallAt],
    );
    await pool.query(
      `insert into ${schema}.sidestream_customer_installs (
         profile_id, license_namespace, install_id_hash, platform, app_version,
         first_seen_at, last_seen_at
       ) values ($1, 'test', $2, 'macos', '1.0.16', $3, $3)`,
      [profileId, installHash(profileId), firstInstallAt],
    );
  }

  await pool.query(
    `insert into ${schema}.sidestream_customer_identity_links (
       profile_id, license_namespace, link_type, link_value
     ) values
       ($1, 'test', 'installer_receipt_hash', $2),
       ($1, 'test', 'activation_record', $3),
       ($4, 'test', 'account_identity', $5)`,
    [
      PROFILE_PAID,
      RECEIPT_HASH,
      ACTIVATION_PAID,
      PROFILE_FREEMIUM,
      ACCOUNT_FREEMIUM,
    ],
  );

  await insertUsageDay(pool, schema, {
    profileId: PROFILE_PAID,
    day: "2026-07-02",
    firstOpenAt: "2026-07-02T11:00:00Z",
    attempts: 2,
  });
  await insertUsageDay(pool, schema, {
    profileId: PROFILE_PAID,
    day: "2026-07-04",
    firstOpenAt: "2026-07-04T11:00:00Z",
    attempts: 0,
  });
  await insertUsageDay(pool, schema, {
    profileId: PROFILE_FREEMIUM,
    day: "2026-07-05",
    firstOpenAt: "2026-07-05T10:00:00Z",
    attempts: 1,
  });

  await pool.query(
    `insert into ${schema}.sidestream_download_leads (
       lead_key, email, captured_at, cta_source, context,
       first_captured_at, last_captured_at, submission_count,
       utm_source, utm_medium, utm_campaign
     ) values
       (
         'lead-freemium', 'freemium@example.com', '2026-07-04T08:00:00Z',
         'mobile-download-handoff',
         $1::jsonb,
         '2026-07-04T08:00:00Z', '2026-07-04T08:00:00Z', 1,
         'manychat', 'dm', 'freemium-launch'
       ),
       (
         'lead-unverified', 'unverified@example.com', '2026-07-04T09:00:00Z',
         'mobile-download-handoff',
         '{}'::jsonb,
         '2026-07-04T09:00:00Z', '2026-07-04T09:00:00Z', 1,
         'manychat', 'dm', 'must-not-attach'
       )`,
    [JSON.stringify({
      source: "mobile-download-handoff",
      schemaVersion: 1,
      experimentId: "mc-mobile-paid-v1",
      cohort: "mc-control-v1",
      assignmentIdHash: ASSIGNMENT_HASH,
    })],
  );

  await pool.query(
    `insert into ${schema}.sidestream_checkout_intents (
       id, intent_kind, browser_token_hash, state, expires_at, created_at, updated_at
     ) values (
       $1, 'anonymous', $2, 'completed', '2026-08-01T00:00:00Z',
       '2026-07-01T08:05:00Z', '2026-07-01T08:10:00Z'
     )`,
    [CHECKOUT_INTENT, "c".repeat(64)],
  );
  await pool.query(
    `insert into ${schema}.sidestream_paid_acquisition_entries (
       id, contract_version, environment, experiment_id, cohort,
       assignment_id_hash, assignment_cookie_signature_hash, entry_path,
       entry_token_hash, attribution_hash, utm_medium, utm_campaign,
       expires_at, created_at, updated_at
     ) values (
       $1, 1, 'test', 'mc-mobile-paid-v1', 'mc-paid-v1',
       $2, $3, '/mc', $4, $5, 'dm', 'paid-launch',
       '2026-07-02T08:00:00Z', '2026-07-01T08:00:00Z',
       '2026-07-01T08:00:00Z'
     )`,
    [
      ENTRY_PAID,
      ASSIGNMENT_HASH,
      "d".repeat(64),
      "e".repeat(64),
      "f".repeat(64),
    ],
  );
  await pool.query(
    `insert into ${schema}.sidestream_paid_acquisition_checkouts (
       id, entry_id, contract_version, environment, experiment_id, cohort,
       assignment_id_hash, entry_token_hash, attribution_hash,
       checkout_intent_ref, idempotency_key, request_fingerprint,
       verified_checkout_session_ref, installer_receipt_hash,
       payment_state, completed_at, expires_at, created_at, updated_at
     ) values (
       $1, $2, 1, 'test', 'mc-mobile-paid-v1', 'mc-paid-v1',
       $3, $4, $5, $6, $7, $8, 'cs_test_verified_paid',
       $9, 'active', '2026-07-01T08:10:00Z',
       '2026-08-01T00:00:00Z', '2026-07-01T08:05:00Z',
       '2026-07-01T08:10:00Z'
     )`,
    [
      CHECKOUT_PAID,
      ENTRY_PAID,
      ASSIGNMENT_HASH,
      "e".repeat(64),
      "f".repeat(64),
      CHECKOUT_INTENT,
      "60000000-0000-4000-8000-000000000001",
      "1".repeat(64),
      RECEIPT_HASH,
    ],
  );
}

async function insertUsageDay(pool, schema, {
  profileId,
  day,
  firstOpenAt,
  attempts,
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
       1, $4, 0, 0, 0, 0, $4, 0,
       $3, $5, $3
     )`,
    [installHash(profileId), day, firstOpenAt, attempts, `watermark-${profileId}`],
  );
}

function installHash(profileId) {
  return profileId.replaceAll("-", "").padEnd(64, "0");
}

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new TypeError("Unsafe identifier");
  return `"${identifier}"`;
}

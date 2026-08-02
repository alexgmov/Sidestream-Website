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
  "20260731120000_add_anonymous_acquisition_sessions.sql",
];

const PROFILE_PAID = "00000000-0000-4000-8000-000000000001";
const PROFILE_FREEMIUM = "00000000-0000-4000-8000-000000000002";
const PROFILE_UNVERIFIED_EMAIL = "00000000-0000-4000-8000-000000000003";
const PROFILE_UNKNOWN = "00000000-0000-4000-8000-000000000004";
const ACCOUNT_FREEMIUM = "10000000-0000-4000-8000-000000000001";
const ACCOUNT_LATE_EMAIL = "10000000-0000-4000-8000-000000000002";
const ACTIVATION_PAID = "20000000-0000-4000-8000-000000000001";
const ACTIVATION_UNOPENED = "20000000-0000-4000-8000-000000000002";
const ACTIVATION_AFTER_OBSERVATION = "20000000-0000-4000-8000-000000000003";
const CHECKOUT_INTENT = "30000000-0000-4000-8000-000000000001";
const CHECKOUT_INTENT_LATE = "30000000-0000-4000-8000-000000000002";
const ENTRY_PAID = "40000000-0000-4000-8000-000000000001";
const ENTRY_LATE = "40000000-0000-4000-8000-000000000002";
const CHECKOUT_PAID = "50000000-0000-4000-8000-000000000001";
const CHECKOUT_LATE = "50000000-0000-4000-8000-000000000002";
const RECEIPT_HASH = "a".repeat(64);
const LATE_RECEIPT_HASH = "9".repeat(64);
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
      cohortEnd: "2026-07-08T00:00:00Z",
      observationEnd: "2026-08-01T00:00:00Z",
      journeyLimit: 4,
    }, { transaction });

    assert.deepEqual(report.dateWindow, {
      cohortStart: "2026-07-01T00:00:00.000Z",
      cohortEnd: "2026-07-08T00:00:00.000Z",
      observationEnd: "2026-08-01T00:00:00.000Z",
      endExclusive: true,
      observationEndExclusive: true,
      cohortDefinition: "first_install_at",
      observationDefinition: "completed_utc_days_before_observation_end",
    });
    assert.deepEqual(report.totals, {
      profiles: "4",
      firstOpenedProfiles: "3",
      completedActivations: "1",
      returnEligibleProfiles: "2",
      returnedProfiles: "1",
      oneAndDoneProfiles: "1",
    });
    assert.deepEqual(report.firstOpenPercentage, {
      numerator: "3",
      denominator: "4",
      percentage: "75.00",
    });
    assert.deepEqual(report.activationPercentage, {
      numerator: "1",
      denominator: "3",
      percentage: "33.33",
    });
    assert.deepEqual(report.returnPercentage, {
      numerator: "1",
      denominator: "2",
      percentage: "50.00",
    });
    assert.deepEqual(report.oneAndDonePercentage, {
      numerator: "1",
      denominator: "2",
      percentage: "50.00",
    });
    assert.deepEqual(report.attributionCoverage, {
      numerator: "3",
      denominator: "4",
      percentage: "75.00",
      paidAttributedProfiles: "1",
      anonymousAttributedProfiles: "1",
      freemiumAttributedProfiles: "1",
      unattributedProfiles: "1",
    });
    assert.deepEqual(report.coverage.unknown, {
      numerator: "1",
      denominator: "4",
      percentage: "25.00",
    });
    assert.equal(report.groups.length, 4);

    const paidGroup = report.groups.find(
      (group) => group.attributionConfidence === "exact_paid_checkout",
    );
    assert.deepEqual(paidGroup, {
      source: "manychat",
      medium: "dm",
      campaign: "paid-launch",
      experiment: "mc-mobile-paid-v1",
      cohort: "mc-paid-v1",
      attributionConfidence: "exact_paid_checkout",
      confidence: "exact_paid_checkout",
      profileCount: "1",
      firstOpenedProfiles: "1",
      completedActivations: "1",
      returnEligibleProfiles: "1",
      returnedProfiles: "1",
      oneAndDoneProfiles: "0",
      firstOpenPercentage: {
        numerator: "1",
        denominator: "1",
        percentage: "100.00",
      },
      activationPercentage: {
        numerator: "1",
        denominator: "1",
        percentage: "100.00",
      },
      returnPercentage: {
        numerator: "1",
        denominator: "1",
        percentage: "100.00",
      },
      oneAndDonePercentage: {
        numerator: "0",
        denominator: "1",
        percentage: "0.00",
      },
    });

    const freemium = report.journeys.find(
      (journey) => journey.customerId === PROFILE_FREEMIUM,
    );
    assert.equal(freemium.attributionConfidence, "exact_verified_email");
    assert.equal(freemium.source, "manychat");
    assert.equal(freemium.medium, "dm");
    assert.equal(freemium.campaign, "freemium-launch");
    assert.equal(freemium.experiment, "mc-mobile-paid-v1");
    assert.equal(freemium.cohort, "mc-control-v1");
    assert.equal(freemium.dayZeroDownloadAttempts, "1");
    assert.deepEqual(freemium.laterOpenDays, []);
    assert.equal(freemium.returnEligible, true);
    assert.equal(freemium.returned, false);
    assert.equal(freemium.oneAndDone, true);

    const paid = report.journeys.find(
      (journey) => journey.customerId === PROFILE_PAID,
    );
    assert.equal(paid.firstAttributedAt, "2026-07-01T08:00:00.000Z");
    assert.equal(paid.installerRequestedAt, "2026-07-01T07:30:00.000Z");
    assert.equal(paid.installerPlatform, "macos");
    assert.equal(paid.firstInstallAt, "2026-07-02T10:15:16.789Z");
    assert.equal(paid.firstOpenAt, "2026-07-02T11:00:00.000Z");
    assert.equal(paid.activationAt, "2026-07-03T12:00:00.000Z");
    assert.equal(paid.dayZeroDownloadAttempts, "2");
    assert.deepEqual(paid.laterOpenDays, ["2026-07-04"]);
    assert.equal(paid.returnEligible, true);
    assert.equal(paid.returned, true);
    assert.equal(paid.oneAndDone, false);

    const lateEmail = report.journeys.find(
      (journey) => journey.customerId === PROFILE_UNVERIFIED_EMAIL,
    );
    assert.equal(lateEmail.attributionConfidence, "unattributed");
    assert.equal(lateEmail.firstOpenAt, "2026-07-31T10:00:00.000Z");
    assert.equal(lateEmail.returnEligible, false);
    assert.equal(lateEmail.returned, false);
    assert.equal(lateEmail.oneAndDone, false);

    const unopened = report.journeys.find(
      (journey) => journey.customerId === PROFILE_UNKNOWN,
    );
    assert.equal(unopened.attributionConfidence, "exact_anonymous_claim");
    assert.equal(unopened.source, "instagram");
    assert.equal(unopened.medium, "organic");
    assert.equal(unopened.campaign, "anonymous-first");
    assert.equal(unopened.firstVisitAt, "2026-07-06T07:00:00.000Z");
    assert.equal(unopened.installerRequestedAt, "2026-07-06T08:00:00.000Z");
    assert.equal(unopened.installerPlatform, "macos");
    assert.equal(unopened.firstOpenAt, null);
    assert.equal(unopened.activationAt, "2026-07-08T12:00:00.000Z");
    assert.equal(unopened.returnEligible, false);
    assert.equal(unopened.oneAndDone, false);

    assert.equal(report.journeysReturned, 4);
    assert.equal(report.journeysTruncated, false);
    assert.deepEqual(report.journeys.map((journey) => journey.customerId), [
      PROFILE_PAID,
      PROFILE_FREEMIUM,
      PROFILE_UNVERIFIED_EMAIL,
      PROFILE_UNKNOWN,
    ]);

    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /freemium@example\.com|unverified@example\.com/);
    assert.doesNotMatch(serialized, new RegExp(RECEIPT_HASH));
    assert.doesNotMatch(serialized, new RegExp(ASSIGNMENT_HASH));
    assert.doesNotMatch(serialized, /cs_test_|install_id_hash|link_value/);

    const production = await funnelModule.queryAcquisitionFunnel({
      licenseNamespace: "production",
      cohortStart: "2026-07-01T00:00:00Z",
      cohortEnd: "2026-08-01T00:00:00Z",
      observationEnd: "2026-08-01T00:00:00Z",
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
     ) values
       ($1, 'google-freemium', 'freemium@example.com',
        '2026-06-30T00:00:00Z', '2026-06-30T00:00:00Z'),
       ($2, 'google-late-email', 'unverified@example.com',
        '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z')`,
    [ACCOUNT_FREEMIUM, ACCOUNT_LATE_EMAIL],
  );
  await pool.query(
    `insert into ${schema}.sidestream_activation_sessions (
       id, activation_key, status, completed_at, expires_at, created_at, updated_at
     ) values
       (
         $1, 'paid-activation-key', 'completed', '2026-07-03T12:00:00Z',
         '2026-08-01T00:00:00Z', '2026-07-03T11:00:00Z',
         '2026-07-03T12:00:00Z'
       ),
       (
         $2, 'unopened-activation-key', 'completed', '2026-07-08T12:00:00Z',
         '2026-08-01T00:00:00Z', '2026-07-08T11:00:00Z',
         '2026-07-08T12:00:00Z'
       ),
       (
         $3, 'late-activation-key', 'completed', '2026-08-02T12:00:00Z',
         '2026-09-01T00:00:00Z', '2026-08-02T11:00:00Z',
         '2026-08-02T12:00:00Z'
       )`,
    [ACTIVATION_PAID, ACTIVATION_UNOPENED, ACTIVATION_AFTER_OBSERVATION],
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
    `insert into ${schema}.sidestream_anonymous_acquisition_sessions (
       license_namespace, token_hash, first_touch_source, first_touch_medium,
       first_touch_campaign, attribution_confidence, first_seen_at,
       first_installer_requested_at, first_installer_platform, claim_state,
       claimed_profile_id, claimed_at, expires_at, retained_until
     ) values
       (
         'test', $1, 'instagram', 'organic', 'anonymous-first', 'utm',
         '2026-07-06T07:00:00Z', '2026-07-06T08:00:00Z', 'macos', 'claimed',
         $2, '2026-07-07T08:00:00Z', '2026-08-01T00:00:00Z',
         '2026-09-01T00:00:00Z'
       ),
       (
         'test', $3, 'later-visit', 'organic', 'must-not-rewrite', 'utm',
         '2026-07-08T07:00:00Z', '2026-07-08T08:00:00Z', 'windows', 'claimed',
         $2, '2026-07-08T08:30:00Z', '2026-08-02T00:00:00Z',
         '2026-09-02T00:00:00Z'
       ),
       (
         'test', $4, 'anonymous-before-paid', 'organic', 'lower-priority', 'utm',
         '2026-07-01T07:00:00Z', '2026-07-01T07:30:00Z', 'macos', 'claimed',
         $5, '2026-07-01T07:45:00Z', '2026-08-01T00:00:00Z',
         '2026-09-01T00:00:00Z'
       )`,
    ["8".repeat(64), PROFILE_UNKNOWN, "7".repeat(64), "6".repeat(64), PROFILE_PAID],
  );

  await pool.query(
    `insert into ${schema}.sidestream_customer_identity_links (
       profile_id, license_namespace, link_type, link_value
     ) values
       ($1, 'test', 'installer_receipt_hash', $2),
       ($1, 'test', 'activation_record', $3),
       ($4, 'test', 'account_identity', $5),
       ($4, 'test', 'activation_record', $6),
       ($7, 'test', 'account_identity', $8),
       ($9, 'test', 'installer_receipt_hash', $10),
       ($9, 'test', 'activation_record', $11)`,
    [
      PROFILE_PAID,
      RECEIPT_HASH,
      ACTIVATION_PAID,
      PROFILE_FREEMIUM,
      ACCOUNT_FREEMIUM,
      ACTIVATION_AFTER_OBSERVATION,
      PROFILE_UNVERIFIED_EMAIL,
      ACCOUNT_LATE_EMAIL,
      PROFILE_UNKNOWN,
      LATE_RECEIPT_HASH,
      ACTIVATION_UNOPENED,
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
  await insertUsageDay(pool, schema, {
    profileId: PROFILE_FREEMIUM,
    day: "2026-08-02",
    firstOpenAt: "2026-08-02T10:00:00Z",
    attempts: 0,
  });
  await insertUsageDay(pool, schema, {
    profileId: PROFILE_UNVERIFIED_EMAIL,
    day: "2026-07-31",
    firstOpenAt: "2026-07-31T10:00:00Z",
    attempts: 0,
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
         'lead-unverified', 'unverified@example.com', '2026-07-05T09:00:00Z',
         'mobile-download-handoff',
         '{}'::jsonb,
         '2026-07-05T09:00:00Z', '2026-07-07T09:00:00Z', 2,
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
     ) values
       (
         $1, 'anonymous', $2, 'completed', '2026-08-01T00:00:00Z',
         '2026-07-01T08:05:00Z', '2026-07-01T08:10:00Z'
       ),
       (
         $3, 'anonymous', $4, 'completed', '2026-09-01T00:00:00Z',
         '2026-07-08T08:05:00Z', '2026-07-08T08:10:00Z'
       )`,
    [
      CHECKOUT_INTENT,
      "c".repeat(64),
      CHECKOUT_INTENT_LATE,
      "7".repeat(64),
    ],
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
  await pool.query(
    `insert into ${schema}.sidestream_paid_acquisition_entries (
       id, contract_version, environment, experiment_id, cohort,
       assignment_id_hash, assignment_cookie_signature_hash, entry_path,
       entry_token_hash, attribution_hash, utm_medium, utm_campaign,
       expires_at, created_at, updated_at
     ) values (
       $1, 1, 'test', 'mc-mobile-paid-v1', 'mc-paid-v1',
       $2, $3, '/mc', $4, $5, 'dm', 'late-paid-visit',
       '2026-07-09T08:00:00Z', '2026-07-08T08:00:00Z',
       '2026-07-08T08:00:00Z'
     )`,
    [
      ENTRY_LATE,
      "6".repeat(64),
      "5".repeat(64),
      "4".repeat(64),
      "3".repeat(64),
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
       $3, $4, $5, $6, $7, $8, 'cs_test_late_paid',
       $9, 'active', '2026-07-08T08:10:00Z',
       '2026-09-01T00:00:00Z', '2026-07-08T08:05:00Z',
       '2026-07-08T08:10:00Z'
     )`,
    [
      CHECKOUT_LATE,
      ENTRY_LATE,
      "6".repeat(64),
      "4".repeat(64),
      "3".repeat(64),
      CHECKOUT_INTENT_LATE,
      "60000000-0000-4000-8000-000000000002",
      "2".repeat(64),
      LATE_RECEIPT_HASH,
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

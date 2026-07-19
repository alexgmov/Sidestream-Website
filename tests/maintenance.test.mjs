import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";
import { deriveActivationTokenPair } from "../api/_lib/entitlement.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationsDirectory = join(repositoryRoot, "db", "migrations");
const TEST_SECRET = "maintenance-test-secret-that-is-long-enough";
const CONTROLLED_ENVIRONMENT = [
  "SIDESTREAM_POSTGRES_URL",
  "SIDESTREAM_POSTGRES_PRISMA_URL",
  "SIDESTREAM_POSTGRES_URL_NON_POOLING",
  "SIDESTREAM_TEST_POSTGRES_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
  "SIDESTREAM_LICENSE_HASH_SECRET",
  "SIDESTREAM_LICENSE_NAMESPACE",
  "SIDESTREAM_PRODUCTION_API_HOSTS",
  "SIDESTREAM_TEST_API_HOSTS",
  "SIDESTREAM_LICENSE_WRITE_THROTTLE_SECONDS",
  "SIDESTREAM_LEGACY_TOKEN_RENEWAL_THRESHOLD_DAYS",
  "VERCEL_ENV",
  "POSTGRES_SSL",
  "POSTGRES_POOL_MAX",
];

test("maintenance throttles hot writes and retains only bounded audit data", {
  timeout: 120_000,
}, async (t) => {
  const environmentSnapshot = snapshotEnvironment(CONTROLLED_ENVIRONMENT);
  const postgres = await startEphemeralPostgres();
  const pool = new Pool({
    connectionString: postgres.connectionString,
    max: 12,
    ssl: false,
  });
  let runtime;

  try {
    await applyMigrations(pool);
    configureRuntime(postgres.connectionString);
    runtime = await loadRuntimeModules();

    await t.test("configuration defaults and every override are bounded", () => {
      assert.deepEqual(runtime.maintenance.loadMaintenanceConfiguration({}), {
        batchSize: 100,
        licenseWriteThrottleSeconds: 3_600,
        legacyTokenRenewalThresholdDays: 30,
        webSessionGraceDays: 7,
        activationSessionGraceDays: 30,
        credentialAuditGraceDays: 30,
        rateLimitGraceHours: 24,
        checkoutIntentGraceDays: 7,
        stripePayloadRetentionDays: 14,
        stripeDeadLetterPayloadRetentionDays: 90,
      });
      assert.throws(
        () => runtime.maintenance.loadMaintenanceConfiguration({
          SIDESTREAM_MAINTENANCE_BATCH_SIZE: "0",
        }),
        /between 1 and 500/,
      );
      assert.throws(
        () => runtime.maintenance.loadLicenseWriteConfiguration({
          SIDESTREAM_LICENSE_WRITE_THROTTLE_SECONDS: "59",
        }),
        /between 60 and 86400/,
      );
      assert.throws(
        () => runtime.maintenance.loadMaintenanceConfiguration({
          SIDESTREAM_STRIPE_PAYLOAD_RETENTION_DAYS: "60",
          SIDESTREAM_STRIPE_DEAD_LETTER_PAYLOAD_RETENTION_DAYS: "30",
        }),
        /must be at least/,
      );
    });

    await t.test("the route requires the exact secret and logs aggregates only", async () => {
      const configuration = runtime.maintenance.loadMaintenanceConfiguration({});
      const summary = {
        outcome: "completed",
        durationMs: 12,
        batchSize: configuration.batchSize,
        hasMore: false,
        counts: zeroCounts(),
      };
      const logs = [];
      let runs = 0;
      const handler = runtime.route.createMaintenanceHandler({
        getCronSecret: () => "maintenance-cron-secret",
        getConfiguration: () => configuration,
        runJob: async () => {
          runs += 1;
          return summary;
        },
        log: (entry) => logs.push(entry),
      });

      const unauthorized = await invokeHandler(handler, {
        method: "GET",
        headers: { authorization: "Bearer wrong" },
      });
      assert.equal(unauthorized.statusCode, 401);
      assert.equal(runs, 0);

      const disallowed = await invokeHandler(handler, {
        method: "POST",
        headers: { authorization: "Bearer maintenance-cron-secret" },
      });
      assert.equal(disallowed.statusCode, 405);
      assert.equal(disallowed.headers.allow, "GET");

      const authorized = await invokeHandler(handler, {
        method: "GET",
        headers: { authorization: "Bearer maintenance-cron-secret" },
      });
      assert.equal(authorized.statusCode, 200);
      assert.deepEqual(JSON.parse(authorized.body), { ok: true, ...summary });
      assert.equal(runs, 1);
      assert.deepEqual(logs, [{
        outcome: "completed",
        durationMs: 12,
        counts: zeroCounts(),
      }]);
      assert.doesNotMatch(JSON.stringify(logs), /secret|authorization|event_id/i);
    });

    const credential = await seedActiveLegacyCredential(pool);
    const environment = runtime.account.resolveRequestLicenseEnvironment({
      headers: { host: "sidestream.tv" },
    });
    assert.equal(environment?.namespace, "production");

    await t.test("successful verification and linked replay no-op inside the throttle", async () => {
      const before = await credentialTimestamps(pool, credential);
      const verified = await runtime.account.verifyLicenseToken(
        credential.licenseToken,
        credential.deviceId,
        environment,
      );
      assert.equal(verified.active, true);
      assert.equal(verified.tokenExpiresAt, before.expiresAt.toISOString());

      const status = await runtime.account.getActivationStatus(
        credential.activationKey,
        credential.deviceId,
        { environment, platform: "macos" },
      );
      assert.equal(status.status, "active");
      assert.equal(status.licenseToken, credential.licenseToken);

      const after = await credentialTimestamps(pool, credential);
      assert.deepEqual(after, before);
    });

    await t.test("the throttle and legacy renewal thresholds cause one bounded touch", async () => {
      await pool.query(
        `
          update public.sidestream_license_tokens
          set last_seen_at = now() - interval '2 hours',
              expires_at = now() + interval '10 days',
              updated_at = now() - interval '2 hours'
          where id = $1
        `,
        [credential.tokenId],
      );
      await pool.query(
        `update public.sidestream_account_devices
         set last_seen_at = now() - interval '2 hours'
         where id = $1`,
        [credential.deviceRowId],
      );
      await pool.query(
        `update public.sidestream_activation_sessions
         set updated_at = now() - interval '2 hours'
         where id = $1`,
        [credential.activationId],
      );

      const beforeCall = Date.now();
      const verified = await runtime.account.verifyLicenseToken(
        credential.licenseToken,
        credential.deviceId,
        environment,
      );
      assert.equal(verified.active, true);
      assert.ok(new Date(verified.tokenExpiresAt).getTime() > beforeCall + 300 * 86_400_000);

      const status = await runtime.account.getActivationStatus(
        credential.activationKey,
        credential.deviceId,
        { environment, platform: "macos" },
      );
      assert.equal(status.status, "active");

      const after = await credentialTimestamps(pool, credential);
      assert.ok(after.tokenLastSeenAt.getTime() >= beforeCall - 2_000);
      assert.ok(after.deviceLastSeenAt.getTime() >= beforeCall - 2_000);
      assert.ok(after.activationUpdatedAt.getTime() >= beforeCall - 2_000);
      assert.ok(after.expiresAt.getTime() > beforeCall + 300 * 86_400_000);
    });

    await t.test("the migration exposes resumable retention and redaction indexes", async () => {
      const column = await pool.query(
        `
          select column_name
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'sidestream_stripe_events'
            and column_name = 'payload_redacted_at'
        `,
      );
      assert.equal(column.rows.length, 1);
      const indexes = await pool.query(
        `
          select indexname
          from pg_indexes
          where schemaname = 'public'
            and indexname like 'sidestream_%_retention_idx'
               or (schemaname = 'public' and indexname = 'sidestream_stripe_events_redaction_idx')
          order by indexname
        `,
      );
      assert.deepEqual(indexes.rows.map((row) => row.indexname), [
        "sidestream_account_sessions_retention_idx",
        "sidestream_activation_sessions_retention_idx",
        "sidestream_api_rate_limits_retention_idx",
        "sidestream_checkout_intents_retention_idx",
        "sidestream_license_tokens_retention_idx",
        "sidestream_stripe_events_redaction_idx",
      ]);
    });

    const referenceTime = new Date();
    const retentionFixture = await seedRetentionFixture(
      pool,
      credential,
      referenceTime,
    );
    const configuration = runtime.maintenance.loadMaintenanceConfiguration({
      SIDESTREAM_MAINTENANCE_BATCH_SIZE: "2",
    });

    await t.test("bounded batches resume, preserve live references, and become idempotent", async () => {
      const first = await runtime.maintenance.runMaintenanceJob({
        pool,
        config: configuration,
        referenceTime,
      });
      assert.equal(first.outcome, "completed");
      assert.equal(first.hasMore, true);
      assert.deepEqual(first.counts, {
        credentialRowsDeleted: 2,
        activationSessionsDeleted: 1,
        webSessionsDeleted: 2,
        rateLimitBucketsDeleted: 2,
        checkoutIntentsDeleted: 2,
        stripePayloadsRedacted: 2,
      });

      const second = await runtime.maintenance.runMaintenanceJob({
        pool,
        config: configuration,
        referenceTime,
      });
      assert.equal(second.outcome, "completed");
      assert.equal(second.hasMore, true);
      assert.deepEqual(second.counts, {
        credentialRowsDeleted: 0,
        activationSessionsDeleted: 0,
        webSessionsDeleted: 1,
        rateLimitBucketsDeleted: 1,
        checkoutIntentsDeleted: 1,
        stripePayloadsRedacted: 2,
      });

      const third = await runtime.maintenance.runMaintenanceJob({
        pool,
        config: configuration,
        referenceTime,
      });
      assert.equal(third.hasMore, false);
      assert.deepEqual(third.counts, zeroCounts());

      const preserved = await pool.query(
        `
          select
            exists(select 1 from public.sidestream_activation_sessions where id = $1) as live_activation,
            exists(select 1 from public.sidestream_license_tokens where id = $2) as live_token,
            exists(select 1 from public.sidestream_account_sessions where id = $3) as grace_session,
            exists(select 1 from public.sidestream_api_rate_limits where scope = $4) as grace_rate,
            exists(select 1 from public.sidestream_checkout_intents where id = $5) as grace_intent
        `,
        [
          retentionFixture.liveActivationId,
          retentionFixture.liveTokenId,
          retentionFixture.graceSessionId,
          retentionFixture.graceRateScope,
          retentionFixture.graceIntentId,
        ],
      );
      assert.deepEqual(preserved.rows[0], {
        live_activation: true,
        live_token: true,
        grace_session: true,
        grace_rate: true,
        grace_intent: true,
      });

      const stripeRows = await pool.query(
        `
          select event_id, processing_status, outcome, raw_payload,
            payload_redacted_at, payload
          from public.sidestream_stripe_events
          order by event_id
        `,
      );
      const redacted = stripeRows.rows.filter((row) => row.payload_redacted_at);
      const retained = stripeRows.rows.filter((row) => !row.payload_redacted_at);
      assert.equal(redacted.length, 4);
      assert.equal(retained.length, 2);
      for (const row of redacted) {
        assert.equal(row.raw_payload, null);
        assert.equal(row.payload.redacted, true);
        assert.equal(row.payload.id, row.event_id);
        assert.equal(row.payload.data.object.customer, "cus_audit");
        assert.equal(JSON.stringify(row.payload).includes("private@example.com"), false);
        assert.ok(row.outcome);
      }
      assert.deepEqual(
        retained.map((row) => row.event_id).sort(),
        ["evt_dead_diagnostic", "evt_processed_fresh"],
      );

      const immutableEventId = redacted[0].event_id;
      await assert.rejects(
        pool.query(
          `update public.sidestream_stripe_events
           set raw_payload = '{"restored":true}' where event_id = $1`,
          [immutableEventId],
        ),
        /Stripe ingress evidence is immutable/,
      );
      await assert.rejects(
        pool.query(
          `update public.sidestream_stripe_events
           set payload = '{"redacted":true}'::jsonb where event_id = $1`,
          [immutableEventId],
        ),
        /Stripe ingress evidence is immutable/,
      );
      await assert.rejects(
        pool.query(
          `update public.sidestream_stripe_events
           set event_type = 'customer.updated' where event_id = $1`,
          [immutableEventId],
        ),
        /Stripe ingress evidence is immutable/,
      );
      await assert.rejects(
        pool.query(
          `update public.sidestream_stripe_events
           set ingress_event_id = 'evt_rewritten' where event_id = $1`,
          [immutableEventId],
        ),
        /Stripe ingress evidence is immutable/,
      );

      const durableTruth = await pool.query(
        `
          select l.entitlement_status, l.stripe_state_event_id,
            count(lead.id)::int as lead_count
          from public.sidestream_licenses as l
          cross join public.sidestream_download_leads as lead
          where l.id = $1
          group by l.entitlement_status, l.stripe_state_event_id
        `,
        [credential.licenseId],
      );
      assert.deepEqual(durableTruth.rows[0], {
        entitlement_status: "active",
        stripe_state_event_id: "evt_processed_0",
        lead_count: 1,
      });
    });

    await t.test("grace cutoffs are inclusive without crossing inside the boundary", async () => {
      const atBoundary = randomUUID();
      const insideBoundary = randomUUID();
      await pool.query(
        `
          insert into public.sidestream_account_sessions (
            id, account_id, session_token_hash, expires_at, created_at, updated_at
          ) values
            ($1, $3, $4, $6::timestamptz - interval '7 days',
              $6::timestamptz - interval '30 days', $6::timestamptz - interval '30 days'),
            ($2, $3, $5, $6::timestamptz - interval '7 days' + interval '1 millisecond',
              $6::timestamptz - interval '30 days', $6::timestamptz - interval '30 days')
        `,
        [
          atBoundary,
          insideBoundary,
          credential.accountId,
          digest("boundary-at"),
          digest("boundary-inside"),
          referenceTime.toISOString(),
        ],
      );
      const boundaryConfig = runtime.maintenance.loadMaintenanceConfiguration({
        SIDESTREAM_MAINTENANCE_BATCH_SIZE: "10",
      });
      const result = await runtime.maintenance.runMaintenanceJob({
        pool,
        config: boundaryConfig,
        referenceTime,
      });
      assert.equal(result.counts.webSessionsDeleted, 1);
      const rows = await pool.query(
        `select id from public.sidestream_account_sessions where id in ($1, $2)`,
        [atBoundary, insideBoundary],
      );
      assert.deepEqual(rows.rows.map((row) => row.id), [insideBoundary]);
    });

    await t.test("a held advisory lock excludes a concurrent maintenance run", async () => {
      const locker = await pool.connect();
      try {
        await locker.query("select pg_advisory_lock(hashtext($1))", [
          runtime.maintenance.MAINTENANCE_LOCK_KEY,
        ]);
        const excluded = await runtime.maintenance.runMaintenanceJob({
          pool,
          config: configuration,
          referenceTime,
        });
        assert.equal(excluded.outcome, "locked");
        assert.equal(excluded.hasMore, false);
        assert.deepEqual(excluded.counts, zeroCounts());
      } finally {
        await locker.query("select pg_advisory_unlock(hashtext($1))", [
          runtime.maintenance.MAINTENANCE_LOCK_KEY,
        ]);
        locker.release();
      }
    });
  } finally {
    if (runtime?.postgres) {
      await runtime.postgres.getPostgresPool().end().catch(() => {});
    }
    if (runtime?.directory) {
      await rm(runtime.directory, { recursive: true, force: true });
    }
    await pool.end().catch(() => {});
    await postgres.stop();
    restoreEnvironment(environmentSnapshot);
  }
});

async function seedActiveLegacyCredential(pool) {
  const deviceId = "maintenance-device";
  const activationKey = "activation-maintenance-legacy";
  const tokens = deriveActivationTokenPair(activationKey, deviceId, TEST_SECRET);
  const deviceIdHash = createHmac("sha256", TEST_SECRET).update(deviceId).digest("hex");
  const account = await pool.query(
    `
      insert into public.sidestream_accounts (google_sub, email, created_at, updated_at)
      values ('google-maintenance', 'maintenance@example.com', now(), now())
      returning id
    `,
  );
  const accountId = account.rows[0].id;
  const license = await pool.query(
    `
      insert into public.sidestream_licenses (
        account_id, stripe_customer_id, stripe_checkout_session_id,
        stripe_payment_intent_id, stripe_charge_id, stripe_price_id,
        stripe_product_id, amount_paid, amount_refunded, currency,
        plan_key, status, entitlement_status, status_reason,
        created_at, updated_at
      ) values (
        $1, 'cus_maintenance', 'cs_maintenance', 'pi_maintenance',
        'ch_maintenance', 'price_maintenance', 'prod_maintenance',
        999, 0, 'usd', 'sidestream_pro', 'active', 'active',
        'payment_paid', now() - interval '2 days', now()
      )
      returning id
    `,
    [accountId],
  );
  const licenseId = license.rows[0].id;
  const activation = await pool.query(
    `
      insert into public.sidestream_activation_sessions (
        activation_key, account_id, license_id, device_id_hash,
        app_version, build_channel, status, expires_at, completed_at,
        created_at, updated_at
      ) values (
        $1, $2, $3, $4, '1.0.13', 'stable', 'linked',
        now() + interval '200 days', now() - interval '1 day',
        now() - interval '2 days', now()
      )
      returning id
    `,
    [activationKey, accountId, licenseId, deviceIdHash],
  );
  const activationId = activation.rows[0].id;
  const device = await pool.query(
    `
      insert into public.sidestream_account_devices (
        account_id, license_namespace, device_id_hash, platform,
        app_version, build_channel, activated_at, last_seen_at
      ) values (
        $1, 'production', $2, 'macos', '1.0.13', 'stable',
        now() - interval '2 days', now()
      )
      returning id
    `,
    [accountId, deviceIdHash],
  );
  const token = await pool.query(
    `
      insert into public.sidestream_license_tokens (
        account_id, license_id, activation_session_id, device_id_hash,
        token_hash, expires_at, last_seen_at, refresh_token_hash,
        refresh_expires_at, created_at, updated_at
      ) values (
        $1, $2, $3, $4, $5, now() + interval '100 days', now(),
        $6, now() + interval '400 days', now() - interval '1 day', now()
      )
      returning id
    `,
    [
      accountId,
      licenseId,
      activationId,
      deviceIdHash,
      digest(tokens.licenseToken),
      digest(tokens.refreshToken),
    ],
  );
  return {
    accountId,
    licenseId,
    activationId,
    activationKey,
    deviceId,
    deviceIdHash,
    deviceRowId: device.rows[0].id,
    tokenId: token.rows[0].id,
    licenseToken: tokens.licenseToken,
  };
}

async function credentialTimestamps(pool, credential) {
  const result = await pool.query(
    `
      select token.last_seen_at as token_last_seen_at,
        token.expires_at, token.updated_at as token_updated_at,
        device.last_seen_at as device_last_seen_at,
        activation.updated_at as activation_updated_at
      from public.sidestream_license_tokens as token
      join public.sidestream_account_devices as device on device.id = $2
      join public.sidestream_activation_sessions as activation on activation.id = $3
      where token.id = $1
    `,
    [credential.tokenId, credential.deviceRowId, credential.activationId],
  );
  const row = result.rows[0];
  return {
    tokenLastSeenAt: row.token_last_seen_at,
    expiresAt: row.expires_at,
    tokenUpdatedAt: row.token_updated_at,
    deviceLastSeenAt: row.device_last_seen_at,
    activationUpdatedAt: row.activation_updated_at,
  };
}

async function seedRetentionFixture(pool, credential, referenceTime) {
  await pool.query(
    `
      update public.sidestream_licenses
      set stripe_state_event_created_at = $2::timestamptz - interval '30 days',
          stripe_state_event_id = 'evt_processed_0'
      where id = $1
    `,
    [credential.licenseId, referenceTime.toISOString()],
  );
  await pool.query(
    `
      insert into public.sidestream_download_leads (
        lead_key, email, email_hash, cta_source, captured_at,
        first_captured_at, last_captured_at
      ) values (
        'maintenance-canonical-lead', 'lead@example.com', $1,
        'download-email-gate', $2::timestamptz,
        $2::timestamptz, $2::timestamptz
      )
    `,
    [digest("lead@example.com"), referenceTime.toISOString()],
  );

  for (let index = 0; index < 3; index += 1) {
    await pool.query(
      `
        insert into public.sidestream_account_sessions (
          account_id, session_token_hash, expires_at, created_at, updated_at
        ) values (
          $1, $2, $3::timestamptz - interval '20 days',
          $3::timestamptz - interval '40 days',
          $3::timestamptz - interval '40 days'
        )
      `,
      [credential.accountId, digest(`old-session-${index}`), referenceTime.toISOString()],
    );
  }
  const graceSession = await pool.query(
    `
      insert into public.sidestream_account_sessions (
        account_id, session_token_hash, expires_at, created_at, updated_at
      ) values (
        $1, $2, $3::timestamptz - interval '6 days',
        $3::timestamptz - interval '30 days',
        $3::timestamptz - interval '30 days'
      ) returning id
    `,
    [credential.accountId, digest("grace-session"), referenceTime.toISOString()],
  );

  const oldActivation = await pool.query(
    `
      insert into public.sidestream_activation_sessions (
        activation_key, account_id, license_id, device_id_hash,
        app_version, status, expires_at, completed_at, created_at, updated_at
      ) values (
        'activation-old-terminal', $1, $2, $3, '1.0.13', 'expired',
        $4::timestamptz - interval '40 days',
        $4::timestamptz - interval '41 days',
        $4::timestamptz - interval '50 days',
        $4::timestamptz - interval '40 days'
      ) returning id
    `,
    [credential.accountId, credential.licenseId, digest("old-device"), referenceTime.toISOString()],
  );
  assert.ok(oldActivation.rows[0].id);
  const liveActivation = await pool.query(
    `
      insert into public.sidestream_activation_sessions (
        activation_key, account_id, license_id, device_id_hash,
        app_version, status, expires_at, completed_at, created_at, updated_at
      ) values (
        'activation-old-live-reference', $1, $2, $3, '1.0.13', 'linked',
        $4::timestamptz - interval '40 days',
        $4::timestamptz - interval '41 days',
        $4::timestamptz - interval '50 days',
        $4::timestamptz - interval '40 days'
      ) returning id
    `,
    [credential.accountId, credential.licenseId, digest("live-device"), referenceTime.toISOString()],
  );
  const liveToken = await pool.query(
    `
      insert into public.sidestream_license_tokens (
        account_id, license_id, activation_session_id, device_id_hash,
        token_hash, expires_at, last_seen_at, created_at, updated_at
      ) values (
        $1, $2, $3, $4, $5, $6::timestamptz + interval '10 days',
        $6::timestamptz, $6::timestamptz - interval '50 days', $6::timestamptz
      ) returning id
    `,
    [
      credential.accountId,
      credential.licenseId,
      liveActivation.rows[0].id,
      digest("live-device"),
      digest("live-legacy-token"),
      referenceTime.toISOString(),
    ],
  );

  await pool.query(
    `
      insert into public.sidestream_license_tokens (
        account_id, license_id, token_hash, expires_at, last_seen_at,
        created_at, updated_at
      ) values
        ($1, $2, $3, $5::timestamptz - interval '40 days',
          $5::timestamptz - interval '50 days',
          $5::timestamptz - interval '60 days', $5::timestamptz - interval '40 days'),
        ($1, $2, $4, $5::timestamptz + interval '100 days',
          $5::timestamptz - interval '50 days',
          $5::timestamptz - interval '60 days', $5::timestamptz - interval '40 days')
    `,
    [
      credential.accountId,
      credential.licenseId,
      digest("expired-audit-token"),
      digest("revoked-audit-token"),
      referenceTime.toISOString(),
    ],
  );
  await pool.query(
    `
      update public.sidestream_license_tokens
      set revoked_at = $2::timestamptz - interval '40 days'
      where token_hash = $1
    `,
    [digest("revoked-audit-token"), referenceTime.toISOString()],
  );

  for (let index = 0; index < 3; index += 1) {
    await pool.query(
      `
        insert into public.sidestream_api_rate_limits (
          scope, dimension_hash, window_started_at, window_seconds,
          request_count, expires_at, created_at, updated_at
        ) values (
          $1, $2, $3::timestamptz - interval '10 days', 60, 1,
          $3::timestamptz - interval '9 days',
          $3::timestamptz - interval '10 days',
          $3::timestamptz - interval '10 days'
        )
      `,
      [`maintenance-old-${index}`, digest(`rate-${index}`), referenceTime.toISOString()],
    );
  }
  const graceRateScope = "maintenance-rate-grace";
  await pool.query(
    `
      insert into public.sidestream_api_rate_limits (
        scope, dimension_hash, window_started_at, window_seconds,
        request_count, expires_at, created_at, updated_at
      ) values (
        $1, $2, $3::timestamptz - interval '2 hours', 60, 1,
        $3::timestamptz - interval '30 minutes',
        $3::timestamptz - interval '2 hours',
        $3::timestamptz - interval '2 hours'
      )
    `,
    [graceRateScope, digest("rate-grace"), referenceTime.toISOString()],
  );

  for (let index = 0; index < 3; index += 1) {
    await pool.query(
      `
        insert into public.sidestream_checkout_intents (
          intent_kind, browser_token_hash, state, attempt,
          expires_at, created_at, updated_at
        ) values (
          'anonymous', $1, 'expired', 0,
          $2::timestamptz - interval '20 days',
          $2::timestamptz - interval '30 days',
          $2::timestamptz - interval '20 days'
        )
      `,
      [digest(`intent-${index}`), referenceTime.toISOString()],
    );
  }
  const graceIntent = await pool.query(
    `
      insert into public.sidestream_checkout_intents (
        intent_kind, browser_token_hash, state, attempt,
        expires_at, created_at, updated_at
      ) values (
        'anonymous', $1, 'expired', 0,
        $2::timestamptz - interval '6 days',
        $2::timestamptz - interval '10 days',
        $2::timestamptz - interval '6 days'
      ) returning id
    `,
    [digest("intent-grace"), referenceTime.toISOString()],
  );

  for (let index = 0; index < 3; index += 1) {
    await insertTerminalEvent(pool, {
      eventId: `evt_processed_${index}`,
      status: "processed",
      ageDays: 30 + index,
      referenceTime,
    });
  }
  await insertTerminalEvent(pool, {
    eventId: "evt_processed_fresh",
    status: "processed",
    ageDays: 5,
    referenceTime,
  });
  await insertTerminalEvent(pool, {
    eventId: "evt_dead_diagnostic",
    status: "dead_letter",
    ageDays: 60,
    referenceTime,
  });
  await insertTerminalEvent(pool, {
    eventId: "evt_dead_old",
    status: "dead_letter",
    ageDays: 120,
    referenceTime,
  });

  return {
    liveActivationId: liveActivation.rows[0].id,
    liveTokenId: liveToken.rows[0].id,
    graceSessionId: graceSession.rows[0].id,
    graceRateScope,
    graceIntentId: graceIntent.rows[0].id,
  };
}

async function insertTerminalEvent(pool, options) {
  const payload = {
    id: options.eventId,
    object: "event",
    type: "charge.updated",
    created: Math.floor(options.referenceTime.getTime() / 1_000),
    livemode: false,
    data: {
      object: {
        id: `ch_${options.eventId}`,
        object: "charge",
        customer: "cus_audit",
        payment_intent: "pi_audit",
        amount: 999,
        currency: "usd",
        status: "succeeded",
        billing_details: { email: "private@example.com" },
      },
    },
  };
  await pool.query(
    `
      insert into public.sidestream_stripe_events (
        event_id, event_type, stripe_created_at, payload, raw_payload,
        received_at, processed_at, processing_status, attempt_count,
        next_attempt_at, outcome, terminal_at, created_at, updated_at
      ) values (
        $1, 'charge.updated',
        $4::timestamptz - ($3::bigint * interval '1 day'),
        $2::jsonb, $2,
        $4::timestamptz - ($3::bigint * interval '1 day'),
        $4::timestamptz - ($3::bigint * interval '1 day'),
        $5, 1,
        $4::timestamptz - ($3::bigint * interval '1 day'),
        'maintenance_fixture',
        $4::timestamptz - ($3::bigint * interval '1 day'),
        $4::timestamptz - ($3::bigint * interval '1 day'),
        $4::timestamptz - ($3::bigint * interval '1 day')
      )
    `,
    [
      options.eventId,
      JSON.stringify(payload),
      options.ageDays,
      options.referenceTime.toISOString(),
      options.status,
    ],
  );
}

async function applyMigrations(pool) {
  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  for (const filename of filenames) {
    await pool.query(await readFile(join(migrationsDirectory, filename), "utf8"));
  }
}

async function loadRuntimeModules() {
  const directory = await mkdtemp(join(tmpdir(), "sidestream-maintenance-modules-"));
  try {
    const postgresUrl = pathToFileURL(
      join(repositoryRoot, "api/_lib/postgres.ts"),
    ).href;
    const maintenanceUrl = await writeAdaptedModule(
      directory,
      "maintenance",
      join(repositoryRoot, "api/_lib/maintenance.ts"),
      { "./postgres.js": postgresUrl },
    );
    const accountUrl = await writeAdaptedModule(
      directory,
      "account",
      join(repositoryRoot, "api/_lib/account.ts"),
      {
        stripe: import.meta.resolve("stripe"),
        "./entitlement.js": pathToFileURL(
          join(repositoryRoot, "api/_lib/entitlement.ts"),
        ).href,
        "./device-policy.js": pathToFileURL(
          join(repositoryRoot, "api/_lib/device-policy.ts"),
        ).href,
        "./license-environment.js": pathToFileURL(
          join(repositoryRoot, "api/_lib/license-environment.ts"),
        ).href,
        "./customer-identity.js": pathToFileURL(
          join(repositoryRoot, "api/_lib/customer-identity.ts"),
        ).href,
        "./maintenance.js": maintenanceUrl,
        "./postgres.js": postgresUrl,
      },
    );
    const routeUrl = await writeAdaptedModule(
      directory,
      "maintenance-route",
      join(repositoryRoot, "api/internal/maintenance.ts"),
      { "../_lib/maintenance.js": maintenanceUrl },
    );
    const nonce = randomUUID();
    const [maintenance, account, route, postgresRuntime] = await Promise.all([
      import(`${maintenanceUrl}?test=${nonce}`),
      import(`${accountUrl}?test=${nonce}`),
      import(`${routeUrl}?test=${nonce}`),
      import(postgresUrl),
    ]);
    return {
      directory,
      maintenance,
      account,
      route,
      postgres: postgresRuntime,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function writeAdaptedModule(directory, name, sourcePath, replacements) {
  let source = await readFile(sourcePath, "utf8");
  for (const [original, replacement] of Object.entries(replacements)) {
    assert.match(source, new RegExp(escapeRegExp(JSON.stringify(original))));
    source = source.replaceAll(JSON.stringify(original), JSON.stringify(replacement));
  }
  const destination = join(directory, `${name}-under-test.ts`);
  await writeFile(destination, source, { mode: 0o600 });
  return pathToFileURL(destination).href;
}

async function invokeHandler(handler, options) {
  const request = Readable.from([]);
  request.method = options.method;
  request.url = "/api/internal/maintenance";
  request.headers = options.headers || {};
  const headers = {};
  const response = {
    statusCode: 200,
    body: "",
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
    end(value = "") {
      this.body = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
    },
  };
  await handler(request, response);
  return { statusCode: response.statusCode, headers, body: response.body };
}

function configureRuntime(connectionString) {
  for (const name of CONTROLLED_ENVIRONMENT) delete process.env[name];
  process.env.SIDESTREAM_POSTGRES_URL = connectionString;
  process.env.SIDESTREAM_LICENSE_HASH_SECRET = TEST_SECRET;
  process.env.SIDESTREAM_LICENSE_NAMESPACE = "production";
  process.env.VERCEL_ENV = "production";
  process.env.POSTGRES_SSL = "0";
  process.env.POSTGRES_POOL_MAX = "12";
  process.env.SIDESTREAM_LICENSE_WRITE_THROTTLE_SECONDS = "3600";
  process.env.SIDESTREAM_LEGACY_TOKEN_RENEWAL_THRESHOLD_DAYS = "30";
}

function zeroCounts() {
  return {
    credentialRowsDeleted: 0,
    activationSessionsDeleted: 0,
    webSessionsDeleted: 0,
    rateLimitBucketsDeleted: 0,
    checkoutIntentsDeleted: 0,
    stripePayloadsRedacted: 0,
  };
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function snapshotEnvironment(names) {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(snapshot) {
  for (const [name, value] of snapshot) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function startEphemeralPostgres() {
  const initdb = await findExecutable("initdb");
  const pgCtl = await findExecutable("pg_ctl");
  const root = await mkdtemp(join(tmpdir(), "sidestream-maintenance-pg-"));
  const dataDirectory = join(root, "data");
  const logPath = join(root, "postgres.log");
  const port = await reservePort();
  try {
    execFileSync(initdb, [
      "--pgdata", dataDirectory,
      "--username", "postgres",
      "--auth", "trust",
      "--encoding", "UTF8",
      "--no-locale",
      "--no-sync",
    ], { stdio: "pipe" });
    execFileSync(pgCtl, [
      "--pgdata", dataDirectory,
      "--log", logPath,
      "--options", `-F -p ${port} -h 127.0.0.1 -k /tmp`,
      "--wait",
      "--timeout", "20",
      "start",
    ], { stdio: "pipe" });
  } catch (error) {
    const log = await readFile(logPath, "utf8").catch(() => "");
    await rm(root, { recursive: true, force: true });
    throw new Error(`Unable to start disposable Postgres: ${error.message}\n${log}`);
  }

  let stopped = false;
  return {
    connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`,
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        execFileSync(pgCtl, [
          "--pgdata", dataDirectory,
          "--wait",
          "--timeout", "20",
          "--mode", "immediate",
          "stop",
        ], { stdio: "pipe" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

async function findExecutable(name) {
  for (const directory of (process.env.PATH || "").split(":")) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error(`${name} is required for the self-contained maintenance test`);
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => {
    if (error) reject(error);
    else resolve();
  }));
  if (!port) throw new Error("Unable to reserve a local Postgres port");
  return port;
}

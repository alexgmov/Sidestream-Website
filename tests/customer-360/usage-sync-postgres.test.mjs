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
const targetMigrations = [
  "20260715120000_add_customer_360_core.sql",
  "20260715123000_add_customer_usage_aggregates.sql",
];
const INSTALL_HASH = "a".repeat(64);
const UNMAPPED_INSTALL_HASH = "b".repeat(64);
const CONTRADICTORY_INSTALL_HASH = "c".repeat(64);
const BULK_EVENT_COUNT = 120;
const {
  buildTelemetryPoolOptions,
  runCustomerUsageSync,
} = await loadInjectedModule(
  new URL("../../api/_lib/customer-usage.ts", import.meta.url),
  {
    pg: { Pool },
    "./postgres.js": {
      getPostgresPool: () => {
        throw new Error("Postgres usage tests inject both disposable pools");
      },
      RUNTIME_POSTGRES_URL_ENV_NAMES: [],
    },
  },
);

test("daily usage sync is read-only, resumable, idempotent, and UTC-windowed", {
  timeout: 180_000,
}, async (t) => {
  const databaseUrl = requireSafeTestDatabaseUrl(process.env);
  const nonce = randomBytes(8).toString("hex");
  const targetSchema = `sidestream_c360_usage_${nonce}`;
  const sourceSchema = `sidestream_telemetry_fixture_${nonce}`;
  const sourceRole = `sidestream_telemetry_reader_${nonce}`;
  const sourcePassword = `reader_${randomBytes(18).toString("hex")}`;
  const quotedTarget = quoteIdentifier(targetSchema);
  const quotedSource = quoteIdentifier(sourceSchema);
  const quotedRole = quoteIdentifier(sourceRole);
  const adminPool = new Pool(createTestPoolOptions(databaseUrl));
  let sourcePool;
  let roleCreated = false;
  let targetCreated = false;
  let sourceCreated = false;
  const previousAmbientTelemetry = process.env.SIDESTREAM_TELEMETRY_POSTGRES_URL;
  delete process.env.SIDESTREAM_TELEMETRY_POSTGRES_URL;

  try {
    await adminPool.query(`create schema ${quotedTarget}`);
    targetCreated = true;
    for (const filename of targetMigrations) {
      const sql = await readFile(join(repositoryRoot, "db/migrations", filename), "utf8");
      await adminPool.query(sql.replace(/\bpublic\./g, `${targetSchema}.`));
    }

    await adminPool.query(`create schema ${quotedSource}`);
    sourceCreated = true;
    const fixture = await readFile(new URL("./fixtures/usage-telemetry.sql", import.meta.url), "utf8");
    await adminPool.query(fixture
      .replace(
        "create table sidestream_telemetry_events",
        `create table ${targetSafeIdentifier(sourceSchema)}.sidestream_telemetry_events`,
      )
      .replaceAll(
        "on sidestream_telemetry_events",
        `on ${targetSafeIdentifier(sourceSchema)}.sidestream_telemetry_events`,
      ));

    await adminPool.query(`create role ${quotedRole} login password ${quoteLiteral(sourcePassword)}`);
    roleCreated = true;
    await adminPool.query(`alter role ${quotedRole} set default_transaction_read_only = on`);
    await adminPool.query(`grant connect on database ${quoteIdentifier(
      (await adminPool.query("select current_database() as name")).rows[0].name,
    )} to ${quotedRole}`);
    await adminPool.query(`grant usage on schema ${quotedSource} to ${quotedRole}`);
    await adminPool.query(
      `grant select on ${quotedSource}.sidestream_telemetry_events to ${quotedRole}`,
    );

    const sourceUrl = new URL(databaseUrl);
    sourceUrl.username = sourceRole;
    sourceUrl.password = sourcePassword;
    sourcePool = new Pool(buildTelemetryPoolOptions(sourceUrl.toString()));
    const readOnly = await sourcePool.query("show transaction_read_only");
    assert.equal(readOnly.rows[0].transaction_read_only, "on");
    await assert.rejects(
      sourcePool.query(
        `insert into ${quotedSource}.sidestream_telemetry_events (
          telemetry_event_id, install_id_hash, event_name, occurred_at, received_at,
          schema_version
        ) values ('forbidden', $1, 'session_started', now(), now(), '0.2.0')`,
        [INSTALL_HASH],
      ),
      (error) => ["25006", "42501"].includes(error?.code),
    );

    const mappedProfile = await seedProfileAndInstall(
      adminPool,
      quotedTarget,
      INSTALL_HASH,
    );
    const emptyProfile = await seedProfile(adminPool, quotedTarget);
    await adminPool.query(
      `update ${quotedTarget}.sidestream_customer_profiles
       set first_seen_at = '2025-01-02T03:04:05Z',
           last_activity_at = '2025-06-07T08:09:10Z',
           platform_summary = 'macos', app_version_summary = '0.9.0'
       where id = $1`,
      [emptyProfile],
    );
    await adminPool.query(
      `update ${quotedTarget}.sidestream_customer_profiles
       set first_seen_at = '2026-01-01T00:00:00Z',
           last_activity_at = '2026-11-15T00:00:00Z'
       where id = $1`,
      [mappedProfile],
    );
    await seedInitialTelemetry(adminPool, quotedSource);
    let unseenProfileId = "";
    let unseenSnapshot;

    await t.test("source aggregate egress stays bucket-bounded and crash retry converges", async () => {
      let crashed = false;
      await assert.rejects(
        runCustomerUsageSync({
          targetPool: adminPool,
          telemetryPool: sourcePool,
          targetSchema,
          telemetrySchema: sourceSchema,
          licenseNamespace: "test",
          batchSize: 3,
          now: new Date("2026-11-02T12:00:00.000Z"),
          afterBatchCommitted: () => {
            if (!crashed) {
              crashed = true;
              throw new Error("simulated usage sync crash");
            }
          },
        }),
        /simulated usage sync crash/,
      );
      const afterCrash = await adminPool.query(
        `select checkpoint_received_at, checkpoint_telemetry_event_id,
           last_sync_completed_at, committed_batch_count
         from ${quotedTarget}.sidestream_customer_usage_sync_state
         where license_namespace = 'test'`,
      );
      assert.ok(afterCrash.rows[0].checkpoint_received_at);
      assert.ok(afterCrash.rows[0].checkpoint_telemetry_event_id);
      assert.equal(afterCrash.rows[0].last_sync_completed_at, null);
      assert.equal(Number(afterCrash.rows[0].committed_batch_count), 1);

      const completed = await runCustomerUsageSync({
        targetPool: adminPool,
        telemetryPool: sourcePool,
        targetSchema,
        telemetrySchema: sourceSchema,
        licenseNamespace: "test",
        batchSize: 3,
        now: new Date("2026-11-02T12:00:00.000Z"),
      });
      assert.equal(completed.outcome, "completed");
      assert.ok(completed.batches > 1);
      assert.ok(completed.dailyBucketsWritten > 0);
      assert.ok(
        completed.sourceRowsScanned < BULK_EVENT_COUNT,
        JSON.stringify(completed),
      );
      assert.ok(
        completed.sourceRowsScanned <= completed.batches * 2,
        JSON.stringify(completed),
      );

      const skipped = await runCustomerUsageSync({
        targetPool: adminPool,
        telemetryPool: sourcePool,
        targetSchema,
        telemetrySchema: sourceSchema,
        licenseNamespace: "test",
        batchSize: 3,
        now: new Date("2026-11-02T23:59:00.000Z"),
      });
      assert.equal(skipped.outcome, "skipped");

      assert.deepEqual(await profileUsage(adminPool, quotedTarget, mappedProfile), {
        first_app_use_at: "2026-03-08T07:59:59.000Z",
        last_app_use_at: "2026-11-01T18:07:10.000Z",
        first_download_attempt_at: "2026-11-01T18:00:00.000Z",
        last_download_attempt_at: "2026-11-01T18:07:00.000Z",
        first_download_success_at: "2026-11-01T18:00:00.000Z",
        last_download_success_at: "2026-11-01T18:07:00.000Z",
        download_attempt_count: "8",
        download_outcome_count: "6",
        download_success_count: "3",
        download_failure_count: "2",
        download_cancelled_count: "1",
        download_pending_count: "1",
        download_unknown_count: "1",
        usage_active_days_count: "2",
        usage_active_days_7: "1",
        usage_active_days_30: "1",
        download_frequency_30d: "8.000000",
        usage_install_count: "1",
        platform_summary: "windows",
        app_version_summary: "1.0.13",
      });

      const empty = await profileUsage(adminPool, quotedTarget, emptyProfile);
      assert.equal(empty.first_app_use_at, null);
      assert.equal(empty.download_attempt_count, null);
      assert.equal(empty.download_frequency_30d, null);
      assert.equal(empty.usage_install_count, "0");

      const novemberBucket = await adminPool.query(
        `select download_attempt_count, download_outcome_count,
           download_success_count, download_failure_count,
           download_cancelled_count, download_pending_count,
           download_unknown_count
         from ${quotedTarget}.sidestream_customer_usage_daily
         where license_namespace = 'test' and install_id_hash = $1
           and activity_day = date '2026-11-01'`,
        [INSTALL_HASH],
      );
      assert.deepEqual(novemberBucket.rows[0], {
        download_attempt_count: "8",
        download_outcome_count: "6",
        download_success_count: "3",
        download_failure_count: "2",
        download_cancelled_count: "1",
        download_pending_count: "1",
        download_unknown_count: "1",
      });

      const bucketCount = await adminPool.query(
        `select count(*)::int as count
         from ${quotedTarget}.sidestream_customer_usage_daily
         where license_namespace = 'test' and install_id_hash = $1`,
        [INSTALL_HASH],
      );
      assert.equal(bucketCount.rows[0].count, 2);

    });

    await t.test("linked authoritative failure overrides adopted legacy success", async () => {
      const result = await adminPool.query(
        `select download_attempt_count, download_outcome_count,
           download_success_count, download_failure_count
         from ${quotedTarget}.sidestream_customer_usage_daily
         where license_namespace = 'test' and install_id_hash = $1
           and activity_day = date '2026-11-01'`,
        [CONTRADICTORY_INSTALL_HASH],
      );
      assert.deepEqual(result.rows[0], {
        download_attempt_count: "1",
        download_outcome_count: "1",
        download_success_count: "0",
        download_failure_count: "1",
      });
    });

    await t.test("first telemetry for an unseen install creates one anonymous profile", async () => {
      const unseen = await installUsage(adminPool, quotedTarget, UNMAPPED_INSTALL_HASH);
      unseenProfileId = unseen.profile_id;
      unseenSnapshot = unseen;
      assert.match(unseenProfileId, /^[0-9a-f-]{36}$/);
      assert.deepEqual(unseen, {
        profile_id: unseenProfileId,
        profile_count: 1,
        install_count: 1,
        identity_link_count: 1,
        bucket_count: 1,
        checkpoint_count: 1,
        download_attempt_count: "1",
        download_pending_count: "1",
        usage_install_count: "1",
      });
    });

    await t.test("NULL usage preserves existing lifecycle, platform, and version facts", async () => {
      assert.deepEqual(await profileLifecycle(adminPool, quotedTarget, emptyProfile), {
        first_seen_at: "2025-01-02T03:04:05.000Z",
        last_activity_at: "2025-06-07T08:09:10.000Z",
        platform_summary: "macos",
        app_version_summary: "0.9.0",
      });
      assert.deepEqual(await profileLifecycle(adminPool, quotedTarget, mappedProfile), {
        first_seen_at: "2026-01-01T00:00:00.000Z",
        last_activity_at: "2026-11-15T00:00:00.000Z",
        platform_summary: "windows",
        app_version_summary: "1.0.13",
      });
    });

    await t.test("equal timestamps, overlap boundaries, and unseen-install replay converge", async () => {
      const checkpointBefore = await syncState(adminPool, quotedTarget);
      assert.equal(checkpointBefore.checkpoint_telemetry_event_id, "event-032");
      assert.equal(checkpointBefore.checkpoint_received_at, "2026-11-02T10:00:00.000Z");

      await insertEvents(adminPool, quotedSource, [
        event("late-inside-request", "download_requested", "2026-11-01T18:08:00Z", {
          receivedAt: "2026-11-02T09:00:00Z",
          payload: { download_id: "download-job-late", download_trigger: "result_row" },
        }),
        event("late-inside-complete", "download_completed", "2026-11-01T18:08:20Z", {
          receivedAt: "2026-11-02T09:00:01Z",
          eventScope: "download",
          payload: { download_id: "download-job-late" },
        }),
        event("late-outside-request", "download_requested", "2026-10-15T18:00:00Z", {
          receivedAt: "2026-10-31T09:59:59Z",
          payload: { download_id: "download-job-outside", download_trigger: "result_row" },
        }),
        event("late-outside-complete", "download_completed", "2026-10-15T18:00:20Z", {
          receivedAt: "2026-10-31T09:59:59Z",
          eventScope: "download",
          payload: { download_id: "download-job-outside" },
        }),
      ]);

      const summary = await runCustomerUsageSync({
        targetPool: adminPool,
        telemetryPool: sourcePool,
        targetSchema,
        telemetrySchema: sourceSchema,
        licenseNamespace: "test",
        batchSize: 4,
        now: new Date("2026-11-03T12:00:00.000Z"),
      });
      assert.equal(summary.outcome, "completed");
      const usage = await profileUsage(adminPool, quotedTarget, mappedProfile);
      assert.equal(usage.download_attempt_count, "9");
      assert.equal(usage.download_success_count, "4");
      const outsideBucket = await adminPool.query(
        `select 1 from ${quotedTarget}.sidestream_customer_usage_daily
         where install_id_hash = $1 and activity_day = date '2026-10-15'`,
        [INSTALL_HASH],
      );
      assert.equal(outsideBucket.rows.length, 0);
      assert.deepEqual(await syncState(adminPool, quotedTarget), checkpointBefore);
      assert.deepEqual(
        await installUsage(adminPool, quotedTarget, UNMAPPED_INSTALL_HASH),
        unseenSnapshot,
      );
    });

    await t.test("zero-event days decay both rolling windows without erasing lifetime", async () => {
      const summary = await runCustomerUsageSync({
        targetPool: adminPool,
        telemetryPool: sourcePool,
        targetSchema,
        telemetrySchema: sourceSchema,
        licenseNamespace: "test",
        batchSize: 5,
        now: new Date("2026-12-05T12:00:00.000Z"),
      });
      assert.equal(summary.outcome, "completed");
      const usage = await profileUsage(adminPool, quotedTarget, mappedProfile);
      assert.equal(usage.download_attempt_count, "9");
      assert.equal(usage.download_success_count, "4");
      assert.equal(usage.usage_active_days_count, "2");
      assert.equal(usage.usage_active_days_7, "0");
      assert.equal(usage.usage_active_days_30, "0");
      assert.equal(usage.download_frequency_30d, null);
    });

    await t.test("the target stores no raw telemetry objects or sensitive fixture values", async () => {
      const jsonColumns = await adminPool.query(
        `select column_name
         from information_schema.columns
         where table_schema = $1
           and table_name in (
             'sidestream_customer_usage_daily',
             'sidestream_customer_usage_sync_state'
           ) and data_type in ('json', 'jsonb')`,
        [targetSchema],
      );
      assert.deepEqual(jsonColumns.rows, []);
      const targetRows = await adminPool.query(
        `select coalesce(jsonb_agg(to_jsonb(day)), '[]'::jsonb)::text as rows
         from ${quotedTarget}.sidestream_customer_usage_daily day`,
      );
      for (const forbidden of [
        "secret search text",
        "https://sensitive.invalid/watch?v=1",
        "Sensitive title",
        "203.0.113.10",
        "Bearer source-token",
      ]) {
        assert.doesNotMatch(targetRows.rows[0].rows, new RegExp(escapeRegExp(forbidden)));
      }

      const targetAccess = await adminPool.query(
        `select has_schema_privilege($1, $2, 'USAGE') as schema_usage,
           has_table_privilege($1, $3, 'SELECT') as table_select`,
        [sourceRole, targetSchema, `${targetSchema}.sidestream_customer_usage_daily`],
      );
      assert.deepEqual(targetAccess.rows[0], {
        schema_usage: false,
        table_select: false,
      });
    });
  } finally {
    if (sourcePool) await sourcePool.end().catch(() => {});
    if (sourceCreated) {
      await adminPool.query(`drop schema if exists ${quotedSource} cascade`).catch(() => {});
    }
    if (targetCreated) {
      await adminPool.query(`drop schema if exists ${quotedTarget} cascade`).catch(() => {});
    }
    if (roleCreated) {
      await adminPool.query(`drop owned by ${quotedRole}`).catch(() => {});
      await adminPool.query(`drop role if exists ${quotedRole}`).catch(() => {});
    }
    await adminPool.end().catch(() => {});
    if (previousAmbientTelemetry === undefined) {
      delete process.env.SIDESTREAM_TELEMETRY_POSTGRES_URL;
    } else {
      process.env.SIDESTREAM_TELEMETRY_POSTGRES_URL = previousAmbientTelemetry;
    }
  }
});

async function seedProfileAndInstall(pool, quotedSchema, installHash) {
  const profileId = await seedProfile(pool, quotedSchema);
  await pool.query(
    `insert into ${quotedSchema}.sidestream_customer_installs (
       profile_id, license_namespace, install_id_hash, platform, app_version,
       first_seen_at, last_seen_at
     ) values ($1, 'test', $2, 'windows', '1.0.13',
       '2026-03-08T07:59:59Z', '2026-11-01T09:30:00Z')`,
    [profileId, installHash],
  );
  return profileId;
}

async function seedProfile(pool, quotedSchema) {
  const result = await pool.query(
    `insert into ${quotedSchema}.sidestream_customer_profiles (license_namespace)
     values ('test') returning id`,
  );
  return result.rows[0].id;
}

async function seedInitialTelemetry(pool, quotedSource) {
  const events = [
    event("event-001", "session_started", "2026-03-08T07:59:59Z", {
      dataPoints: { runtime: { os_platform: "darwin" } },
      appVersion: "1.0.12",
    }),
    event("event-002", "session_heartbeat", "2026-03-08T08:00:00Z", {
      dataPoints: { runtime: { os_platform: "darwin" } },
      appVersion: "1.0.12",
    }),
    event("event-003", "session_started", "2026-11-01T08:30:00Z", {
      dataPoints: { runtime: { osPlatform: "win32" } },
      appVersion: "1.0.13",
      payload: {
        search_text: "secret search text",
        source_url: "https://sensitive.invalid/watch?v=1",
        title: "Sensitive title",
        ip: "203.0.113.10",
        token: "Bearer source-token",
      },
    }),
    event("event-004", "session_heartbeat", "2026-11-01T09:30:00Z", {
      dataPoints: { runtime: { os_platform: "win32" } },
      appVersion: "1.0.13",
    }),
    event("event-005", "download_requested", "2026-11-01T18:00:00Z", {
      payload: { download_id: "download-job-1", download_trigger: "result_row" },
    }),
    event("event-006", "download_failed", "2026-11-01T18:00:10Z", {
      eventScope: "app",
      payload: { download_id: "download-job-1", failure_phase: "wrapper" },
    }),
    event("event-007", "download_failed", "2026-11-01T18:00:11Z", {
      eventScope: "download",
      payload: { download_id: "download-job-1", failure_phase: "transfer" },
    }),
    event("event-008", "download_attempt_finalized", "2026-11-01T18:00:12Z", {
      eventScope: "app",
      payload: { download_id: "download-job-1", file_delivered: true, user_outcome: "got_file" },
    }),
    event("event-009", "download_requested", "2026-11-01T18:01:00Z", {
      payload: { download_id: "download-job-2", download_trigger: "preview" },
    }),
    event("event-010", "download_completed", "2026-11-01T18:01:10Z", {
      eventScope: "download",
      payload: { download_id: "download-job-2" },
    }),
    event("event-011", "download_attempt_finalized", "2026-11-01T18:01:20Z", {
      eventScope: "app",
      payload: {
        download_id: "download-job-2",
        file_delivered: true,
        user_outcome: "got_file_import_failed",
        failure_stage: "premiere_import",
        import_result: "failed",
      },
    }),
    event("event-012", "download_requested", "2026-11-01T18:02:00Z", {
      payload: { download_id: "download-job-3", download_trigger: "preview" },
    }),
    event("event-013", "download_attempt_finalized", "2026-11-01T18:02:10Z", {
      payload: { download_id: "download-job-3", user_outcome: "cancelled" },
    }),
    event("event-014", "download_requested", "2026-11-01T18:03:00Z", {
      payload: { download_id: "download-job-4", download_trigger: "result_row" },
    }),
    event("event-015", "download_requested", "2026-11-01T18:04:00Z", {
      payload: { download_id: "download-job-5", download_trigger: "result_row" },
    }),
    event("event-016", "download_attempt_finalized", "2026-11-01T18:04:10Z", {
      payload: { download_id: "download-job-5", user_outcome: "future_state" },
    }),
    event("event-017", "download_requested", "2026-11-01T18:05:00Z", {
      payload: {
        download_id: "download-job-6",
        speculative_download_id: "speculative-download-1",
        download_trigger: "result_row",
      },
    }),
    event("event-018", "speculative_download_relocated", "2026-11-01T18:05:05Z", {
      payload: {
        download_id: "download-job-6",
        speculative_download_id: "speculative-download-1",
      },
    }),
    event("event-019", "download_completed", "2026-11-01T18:05:10Z", {
      eventScope: "download",
      payload: { download_id: "speculative-download-1" },
    }),
    event("event-020", "download_completed", "2026-11-01T18:05:20Z", {
      eventScope: "download",
      payload: { download_id: "speculative-download-2" },
    }),
    event("event-021", "download_requested", "2026-11-01T18:06:00Z", {
      payload: { download_id: "download-job-8", download_trigger: "preview" },
    }),
    event("event-022", "download_failed", "2026-11-01T18:06:10Z", {
      eventScope: "app",
      payload: { download_id: "download-job-8" },
    }),
    event("event-023", "download_failed", "2026-11-01T18:06:11Z", {
      eventScope: "download",
      payload: { download_id: "download-job-8" },
    }),
    event("event-023a", "download_requested", "2026-11-01T18:06:30Z", {
      installHash: CONTRADICTORY_INSTALL_HASH,
      payload: {
        download_id: "direct-authoritative-failure",
        speculative_download_id: "speculative-legacy-success",
        download_trigger: "result_row",
      },
    }),
    event("event-023b", "download_completed", "2026-11-01T18:06:31Z", {
      installHash: CONTRADICTORY_INSTALL_HASH,
      eventScope: "download",
      payload: { download_id: "speculative-legacy-success" },
    }),
    event("event-023c", "download_attempt_finalized", "2026-11-01T18:06:32Z", {
      installHash: CONTRADICTORY_INSTALL_HASH,
      eventScope: "app",
      payload: {
        download_id: "direct-authoritative-failure",
        file_delivered: false,
        user_outcome: "download_failed",
      },
    }),
    event("event-024", "download_requested", "2026-11-01T18:07:00Z", {
      payload: { download_id: "download-job-9", download_trigger: "result_row" },
    }),
    event("event-025", "download_completed", "2026-11-01T18:07:10Z", {
      eventScope: "download",
      payload: { download_id: "download-job-9" },
    }),
    event("event-026", "download_requested", "2026-11-01T18:20:00Z", {
      installHash: UNMAPPED_INSTALL_HASH,
      payload: { download_id: "unmapped-download", download_trigger: "result_row" },
    }),
    event("event-027", "download_requested", "2026-11-01T19:00:00Z", {
      schemaVersion: "0.3.0",
      payload: { download_id: "unsupported-schema", token: "must-not-read" },
    }),
    event("event-028", "installer_install_completed", "2026-11-01T19:10:00Z", {
      eventCategory: "installer",
    }),
    event("event-029", "session_heartbeat", "2026-11-01T09:00:00Z"),
    event("event-030", "session_heartbeat", "2026-11-01T09:10:00Z"),
    event("event-031", "session_heartbeat", "2026-11-01T09:20:00Z"),
    event("event-032", "session_heartbeat", "2026-11-01T09:25:00Z"),
  ];
  for (let index = 0; index < BULK_EVENT_COUNT; index += 1) {
    events.push(event(
      `bulk-event-${String(index).padStart(3, "0")}`,
      "session_heartbeat",
      `2026-11-01T09:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
        index % 60,
      ).padStart(2, "0")}Z`,
    ));
  }
  await insertEvents(pool, quotedSource, events);
}

function event(id, name, occurredAt, options = {}) {
  return {
    id,
    name,
    occurredAt,
    receivedAt: options.receivedAt || "2026-11-02T10:00:00Z",
    installHash: options.installHash || INSTALL_HASH,
    sessionId: options.sessionId || "session-usage",
    eventCategory: options.eventCategory || "app",
    eventScope: options.eventScope || "app",
    appVersion: options.appVersion || "1.0.13",
    schemaVersion: options.schemaVersion || "0.2.0",
    payload: options.payload || {},
    dataPoints: options.dataPoints || {},
  };
}

async function insertEvents(pool, quotedSource, events) {
  for (const [index, row] of events.entries()) {
    await pool.query(
      `insert into ${quotedSource}.sidestream_telemetry_events (
         telemetry_event_id, install_id_hash, session_id, sequence, event_name,
         event_category, event_scope, occurred_at, received_at, app_version,
         build_channel, schema_version, payload, data_points
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'test', $11, $12, $13)`,
      [
        row.id,
        row.installHash,
        row.sessionId,
        index + 1,
        row.name,
        row.eventCategory,
        row.eventScope,
        row.occurredAt,
        row.receivedAt,
        row.appVersion,
        row.schemaVersion,
        row.payload,
        row.dataPoints,
      ],
    );
  }
}

async function profileLifecycle(pool, quotedSchema, profileId) {
  const result = await pool.query(
    `select
       to_char(first_seen_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         as first_seen_at,
       to_char(last_activity_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         as last_activity_at,
       platform_summary, app_version_summary
     from ${quotedSchema}.sidestream_customer_profiles where id = $1`,
    [profileId],
  );
  return result.rows[0];
}

async function installUsage(pool, quotedSchema, installHash) {
  const result = await pool.query(
    `select install.profile_id,
       (select count(*)::int from ${quotedSchema}.sidestream_customer_profiles profile_count
        where profile_count.id = install.profile_id) as profile_count,
       (select count(*)::int from ${quotedSchema}.sidestream_customer_installs install_count
        where install_count.license_namespace = install.license_namespace
          and install_count.install_id_hash = install.install_id_hash) as install_count,
       (select count(*)::int from ${quotedSchema}.sidestream_customer_identity_links identity_link
        where identity_link.profile_id = install.profile_id
          and identity_link.license_namespace = install.license_namespace
          and identity_link.link_type = 'install_identity_hash'
          and identity_link.link_value = install.install_id_hash) as identity_link_count,
       (select count(*)::int from ${quotedSchema}.sidestream_customer_usage_daily day
        where day.license_namespace = install.license_namespace
          and day.install_id_hash = install.install_id_hash) as bucket_count,
       (select count(*)::int from ${quotedSchema}.sidestream_customer_usage_sync_state checkpoint
        where checkpoint.license_namespace = install.license_namespace) as checkpoint_count,
       profile.download_attempt_count, profile.download_pending_count,
       profile.usage_install_count
     from ${quotedSchema}.sidestream_customer_installs install
     join ${quotedSchema}.sidestream_customer_profiles profile on profile.id = install.profile_id
     where install.license_namespace = 'test' and install.install_id_hash = $1`,
    [installHash],
  );
  return result.rows[0];
}

async function profileUsage(pool, quotedSchema, profileId) {
  const result = await pool.query(
    `select
       to_char(first_app_use_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as first_app_use_at,
       to_char(last_app_use_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_app_use_at,
       to_char(first_download_attempt_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as first_download_attempt_at,
       to_char(last_download_attempt_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_download_attempt_at,
       to_char(first_download_success_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as first_download_success_at,
       to_char(last_download_success_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_download_success_at,
       download_attempt_count, download_outcome_count, download_success_count,
       download_failure_count, download_cancelled_count, download_pending_count,
       download_unknown_count, usage_active_days_count, usage_active_days_7,
       usage_active_days_30, download_frequency_30d, usage_install_count,
       platform_summary, app_version_summary
     from ${quotedSchema}.sidestream_customer_profiles where id = $1`,
    [profileId],
  );
  return result.rows[0];
}

async function syncState(pool, quotedSchema) {
  const result = await pool.query(
    `select
       to_char(checkpoint_received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         as checkpoint_received_at,
       checkpoint_telemetry_event_id
     from ${quotedSchema}.sidestream_customer_usage_sync_state
     where license_namespace = 'test'`,
  );
  return result.rows[0];
}

function targetSafeIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new TypeError("Unsafe test identifier");
  return identifier;
}

function quoteIdentifier(identifier) {
  return `"${targetSafeIdentifier(identifier)}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

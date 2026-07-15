import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";
import { materializeCustomerCommerceEvent } from "../../api/_lib/customer-commerce.ts";
import {
  classifyMigrationState,
  loadMigrationFiles,
  migrationSqlForTransaction,
  validateMigrationFiles,
} from "../../scripts/apply-postgres-migrations.mjs";
import { runCustomer360Backfill } from "../../scripts/backfill-customer-360.mjs";
import {
  createTestPoolOptions,
  requireSafeTestDatabaseUrl,
} from "../../scripts/run-postgres-integration.mjs";
import { loadInjectedModule } from "../helpers/handler-loader.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixturePath = join(
  repositoryRoot,
  "tests/customer-360/fixtures/usage-telemetry.sql",
);
const customerProfilesPath = join(repositoryRoot, "api/_lib/customer-profiles.ts");
const licenseEnvironmentPath = join(repositoryRoot, "api/_lib/license-environment.ts");
const ADMIN_SECRET = "customer-360-pipeline-cursor-secret";
const INSTALL_A = "a".repeat(64);
const INSTALL_B = "b".repeat(64);
const INSTALL_PRODUCTION = "c".repeat(64);
const controlledEnvironmentNames = [
  "SIDESTREAM_LICENSE_NAMESPACE",
  "SIDESTREAM_PRODUCTION_API_HOSTS",
  "SIDESTREAM_TEST_API_HOSTS",
  "SIDESTREAM_POSTGRES_URL",
  "SIDESTREAM_TEST_POSTGRES_URL",
  "VERCEL_ENV",
  "NODE_ENV",
];

const usageModule = await loadInjectedModule(
  new URL("../../api/_lib/customer-usage.ts", import.meta.url),
  {
    pg: { Pool },
    "./postgres.js": {
      getPostgresPool: () => {
        throw new Error("Pipeline tests inject both disposable Postgres pools");
      },
      RUNTIME_POSTGRES_URL_ENV_NAMES: [],
    },
  },
);
const queryModule = await loadInjectedModule(
  new URL("../../api/_lib/customer-query.ts", import.meta.url),
  {
    "./postgres.js": {
      withPostgresTransaction: async () => {
        throw new Error("Pipeline tests inject a read-only transaction");
      },
    },
  },
);

test("the complete Customer 360 pipeline survives merge and replay without duplicated facts", {
  timeout: 240_000,
}, async (t) => {
  const databaseUrl = requireSafeTestDatabaseUrl(process.env);
  const nonce = randomBytes(8).toString("hex");
  const crmSchema = `sidestream_c360_crm_fixture_${nonce}`;
  const telemetrySchema = `sidestream_c360_telemetry_fixture_${nonce}`;
  const telemetryRole = `sidestream_c360_telemetry_reader_${nonce}`;
  const telemetryPassword = `reader_${randomBytes(18).toString("hex")}`;
  const quotedCrm = quoteIdentifier(crmSchema);
  const quotedTelemetry = quoteIdentifier(telemetrySchema);
  const quotedRole = quoteIdentifier(telemetryRole);
  const adminPool = new Pool(createTestPoolOptions(databaseUrl));
  const temporaryDirectory = await mkdtemp(join(
    dirname(fileURLToPath(import.meta.url)),
    ".pipeline-postgres-",
  ));
  const environmentSnapshot = snapshotEnvironment(controlledEnvironmentNames);
  let telemetryPool;

  try {
    assert.deepEqual(globalThis.__SIDESTREAM_CUSTOMER_360_NETWORK_GUARD__, {
      allowedProtocol: "postgres",
      allowedHost: new URL(databaseUrl).hostname.toLowerCase(),
      allowedPort: Number(new URL(databaseUrl).port || 5432),
      stripe: "blocked",
      vercel: "blocked",
    });
    await assert.rejects(
      globalThis.fetch("https://api.stripe.com/v1/customers"),
      /forbidden in the Customer 360 Postgres harness/,
    );
    assert.throws(
      () => https.get("https://blob.vercel-storage.com/customer-360"),
      /forbidden in the Customer 360 Postgres harness/,
    );
    assert.throws(
      () => http.get("http://example.invalid/customer-360"),
      /forbidden in the Customer 360 Postgres harness/,
    );
    assert.throws(
      () => net.connect({ host: "example.invalid", port: 443 }),
      /forbidden in the Customer 360 Postgres harness/,
    );

    await adminPool.query(`create schema ${quotedCrm}`);
    const migrations = validateMigrationFiles(await loadMigrationFiles());
    assert.equal(await applyChecksummedMigrations(adminPool, crmSchema, migrations), migrations.length);
    assert.equal(await applyChecksummedMigrations(adminPool, crmSchema, migrations), 0);
    const ledger = await adminPool.query(
      `select filename, checksum_sha256, applied_at, duration_ms
       from ${quotedCrm}.sidestream_schema_migrations order by filename`,
    );
    assert.equal(ledger.rows.length, migrations.length);
    assert.ok(classifyMigrationState(migrations, ledger.rows).every(
      (migration) => migration.status === "applied",
    ));

    await adminPool.query(`create schema ${quotedTelemetry}`);
    await createTelemetryFixture(adminPool, telemetrySchema);
    await adminPool.query(
      `create role ${quotedRole} login password ${quoteLiteral(telemetryPassword)}`,
    );
    await adminPool.query(`alter role ${quotedRole} set default_transaction_read_only = on`);
    const databaseName = (await adminPool.query("select current_database() as name")).rows[0].name;
    await adminPool.query(
      `grant connect on database ${quoteIdentifier(databaseName)} to ${quotedRole}`,
    );
    await adminPool.query(`grant usage on schema ${quotedTelemetry} to ${quotedRole}`);
    await adminPool.query(
      `grant select on ${quotedTelemetry}.sidestream_telemetry_events to ${quotedRole}`,
    );
    const telemetryUrl = new URL(databaseUrl);
    telemetryUrl.username = telemetryRole;
    telemetryUrl.password = telemetryPassword;
    telemetryPool = new Pool(usageModule.buildTelemetryPoolOptions(telemetryUrl.toString()));

    await t.test("full schema is private and telemetry is SELECT-only", async () => {
      assert.equal((await telemetryPool.query("show transaction_read_only")).rows[0]
        .transaction_read_only, "on");
      await assert.rejects(
        telemetryPool.query(
          `insert into ${quotedTelemetry}.sidestream_telemetry_events (
             telemetry_event_id, install_id_hash, event_name, occurred_at,
             received_at, schema_version
           ) values ('forbidden-write', $1, 'session_started', now(), now(), '0.2.0')`,
          [INSTALL_A],
        ),
        (error) => ["25006", "42501"].includes(error?.code),
      );

      const tables = await adminPool.query(
        `select relname, relrowsecurity
         from pg_class join pg_namespace on pg_namespace.oid = pg_class.relnamespace
         where nspname = $1 and relkind = 'r' and relname like 'sidestream_customer_%'
         order by relname`,
        [crmSchema],
      );
      assert.ok(tables.rows.length >= 10);
      assert.ok(tables.rows.every((row) => row.relrowsecurity), tables.rows);
      const publicGrants = await adminPool.query(
        `select count(*)::int as count
         from information_schema.table_privileges
         where table_schema = $1 and table_name like 'sidestream_customer_%'
           and grantee = 'PUBLIC'`,
        [crmSchema],
      );
      assert.equal(publicGrants.rows[0].count, 0);
      const telemetryTargetAccess = await adminPool.query(
        `select has_schema_privilege($1, $2, 'USAGE') as schema_usage,
           has_table_privilege($1, $3, 'SELECT') as table_select`,
        [telemetryRole, crmSchema, `${crmSchema}.sidestream_customer_profiles`],
      );
      assert.deepEqual(telemetryTargetAccess.rows[0], {
        schema_usage: false,
        table_select: false,
      });
    });

    const profiles = await seedProfilesAndEvidence(adminPool, quotedCrm);
    const protectedStateBefore = await protectedState(adminPool, quotedCrm);
    const query = (text, params = []) => adminPool.query(
      text.replace(/\bpublic\./g, `${quotedCrm}.`),
      [...params],
    );
    const oneTimeEvent = stripeEvent(
      "evt_pipeline_one_time",
      "payment_intent.succeeded",
      1_784_000_100,
      {
        id: "pi_pipeline_one_time",
        created: 1_784_000_090,
        customer: "cus_pipeline_a",
        latest_charge: "ch_pipeline_one_time",
        status: "succeeded",
        amount: 1000,
        amount_received: 1000,
        currency: "usd",
      },
    );
    const subscriptionEvent = stripeEvent(
      "evt_pipeline_subscription",
      "invoice.paid",
      1_784_000_200,
      {
        id: "in_pipeline_subscription",
        created: 1_784_000_180,
        customer: "cus_pipeline_b",
        parent: {
          type: "subscription_details",
          subscription_details: { subscription: "sub_pipeline_b" },
        },
        paid: true,
        status: "paid",
        amount_paid: 500,
        amount_paid_off_stripe: 0,
        currency: "usd",
        status_transitions: { paid_at: 1_784_000_190 },
      },
    );
    assert.equal((await materializeCustomerCommerceEvent(
      oneTimeEvent,
      query,
      "test",
    )).applied, 1);
    assert.equal((await materializeCustomerCommerceEvent(
      subscriptionEvent,
      query,
      "test",
    )).applied, 1);

    await seedTelemetry(adminPool, quotedTelemetry);
    let crashed = false;
    await assert.rejects(usageModule.runCustomerUsageSync({
      targetPool: adminPool,
      telemetryPool,
      targetSchema: crmSchema,
      telemetrySchema,
      licenseNamespace: "test",
      batchSize: 1,
      now: new Date("2026-07-16T12:00:00.000Z"),
      afterBatchCommitted() {
        if (!crashed) {
          crashed = true;
          throw new Error("simulated pipeline cursor crash");
        }
      },
    }), /simulated pipeline cursor crash/);
    const resumedUsage = await usageModule.runCustomerUsageSync({
      targetPool: adminPool,
      telemetryPool,
      targetSchema: crmSchema,
      telemetrySchema,
      licenseNamespace: "test",
      batchSize: 1,
      now: new Date("2026-07-16T12:00:00.000Z"),
    });
    assert.equal(resumedUsage.outcome, "completed");
    assert.ok(resumedUsage.dailyBucketsWritten >= 2 && resumedUsage.dailyBucketsWritten <= 4,
      resumedUsage);
    assert.ok(resumedUsage.sourceRowsScanned <= 4, resumedUsage);

    await t.test("two live profiles own distinct commerce and usage facts before merge", async () => {
      assert.deepEqual(await profileFacts(adminPool, quotedCrm, profiles.older), {
        gross_paid_minor: "1000",
        paid_transaction_count: "1",
        download_attempt_count: "1",
        download_success_count: "1",
        usage_install_count: "1",
      });
      assert.deepEqual(await profileFacts(adminPool, quotedCrm, profiles.newer), {
        gross_paid_minor: "500",
        paid_transaction_count: "1",
        download_attempt_count: "1",
        download_success_count: "1",
        usage_install_count: "1",
      });
      const production = await adminPool.query(
        `select license_namespace, merged_into from ${quotedCrm}.sidestream_customer_profiles
         where id = $1`,
        [profiles.production],
      );
      assert.deepEqual(production.rows[0], {
        license_namespace: "production",
        merged_into: null,
      });
    });

    configureMergeEnvironment(databaseUrl);
    const customerProfiles = await loadCustomerProfilesForSchema(
      crmSchema,
      temporaryDirectory,
      adminPool,
    );
    const mergeInput = {
      leftProfileId: profiles.newer,
      rightProfileId: profiles.older,
      evidenceType: "stripe_customer",
      evidenceValueHash: "d".repeat(64),
      initiatedBy: "system",
    };
    const mergeAttempts = await Promise.all([
      customerProfiles.mergeCustomerProfiles(mergeInput),
      customerProfiles.mergeCustomerProfiles(mergeInput),
    ]);
    assert.deepEqual(mergeAttempts.map((result) => result.merged).sort(), [false, true]);
    assert.ok(mergeAttempts.every((result) => result.survivorId === profiles.older));
    await usageModule.materializeCustomerUsageProfiles({
      query: adminPool.query.bind(adminPool),
      targetSchema: crmSchema,
      licenseNamespace: "test",
      now: new Date("2026-07-16T12:00:01.000Z"),
      sourceFreshnessAt: new Date("2026-07-15T10:00:05.000Z"),
    });

    await t.test("one live profile preserves every fact without double counting", async () => {
      const roots = await adminPool.query(
        `select id from ${quotedCrm}.sidestream_customer_profiles
         where license_namespace = 'test' and id = any($1::uuid[]) and merged_into is null`,
        [[profiles.older, profiles.newer]],
      );
      assert.deepEqual(roots.rows, [{ id: profiles.older }]);
      assert.deepEqual(await profileFacts(adminPool, quotedCrm, profiles.older), {
        gross_paid_minor: "1500",
        paid_transaction_count: "2",
        download_attempt_count: "2",
        download_success_count: "2",
        usage_install_count: "2",
      });
      const factCounts = await adminPool.query(
        `select
           (select count(*)::int from ${quotedCrm}.sidestream_customer_commerce_materializations
            where profile_id = $1) as commerce,
           (select count(*)::int from ${quotedCrm}.sidestream_customer_usage_daily
            where license_namespace = 'test') as usage_days,
           (select count(*)::int from ${quotedCrm}.sidestream_customer_profile_merges
            where source_profile_id = $2) as merge_audits`,
        [profiles.older, profiles.newer],
      );
      assert.deepEqual(factCounts.rows[0], {
        commerce: 2,
        usage_days: 2,
        merge_audits: 1,
      });

      const detail = await queryModule.queryCustomerDetail(
        profiles.older,
        { licenseNamespace: "test" },
        { transaction: readOnlyTransaction(adminPool, quotedCrm) },
      );
      assert.equal(detail.billingModel, "mixed");
      assert.deepEqual(detail.money.map((money) => ({
        currency: money.currency,
        grossPaidMinor: money.grossPaidMinor,
        paidTransactionCount: money.paidTransactionCount,
      })), [{
        currency: "usd",
        grossPaidMinor: "1500",
        paidTransactionCount: "2",
      }]);
      assert.equal(detail.usage.downloadOutcomeNumerator, "2");
      assert.equal(detail.usage.downloadOutcomeDenominator, "2");
      assert.doesNotMatch(
        JSON.stringify(detail),
        /install_id_hash|stripe_|payload|data_points|gmail_campaign_hmac/i,
      );
      assert.equal(await queryModule.queryCustomerDetail(
        profiles.newer,
        { licenseNamespace: "test" },
        { transaction: readOnlyTransaction(adminPool, quotedCrm) },
      ), null);
    });

    await t.test("merge, projector, sync, and backfill replays are no-ops", async () => {
      const before = await pipelineSnapshot(adminPool, quotedCrm);
      const repeatedMerge = await customerProfiles.mergeCustomerProfiles(mergeInput);
      assert.equal(repeatedMerge.merged, false);
      assert.equal((await materializeCustomerCommerceEvent(
        oneTimeEvent,
        query,
        "test",
      )).applied, 0);
      assert.equal((await materializeCustomerCommerceEvent(
        subscriptionEvent,
        query,
        "test",
      )).applied, 0);
      const skippedUsage = await usageModule.runCustomerUsageSync({
        targetPool: adminPool,
        telemetryPool,
        targetSchema: crmSchema,
        telemetrySchema,
        licenseNamespace: "test",
        batchSize: 1,
        now: new Date("2026-07-16T23:59:00.000Z"),
      });
      assert.equal(skippedUsage.outcome, "skipped");

      const backfillInput = [{
        recordId: "e".repeat(64),
        stripePaymentIntentId: "pi_pipeline_one_time",
      }];
      const dryRun = await runCustomer360Backfill({
        input: backfillInput,
        namespace: "test",
      });
      assert.equal(dryRun.mode, "dry_run");
      assert.equal(dryRun.checkpoint.nextComponentIndex, 0);
      let persistedCheckpoint = null;
      const firstBackfill = await runCustomer360Backfill({
        input: backfillInput,
        namespace: "test",
        apply: true,
        pool: adminPool,
        schema: crmSchema,
        batchSize: 1,
        writeCheckpoint(checkpoint) {
          persistedCheckpoint = checkpoint;
        },
      });
      const repeatedBackfill = await runCustomer360Backfill({
        input: backfillInput,
        namespace: "test",
        apply: true,
        pool: adminPool,
        schema: crmSchema,
        checkpoint: persistedCheckpoint,
        batchSize: 1,
      });
      assert.equal(firstBackfill.summary.currentRun.writes, 0);
      assert.equal(repeatedBackfill.summary.currentRun.writes, 0);
      assert.deepEqual(await pipelineSnapshot(adminPool, quotedCrm), before);
      assert.deepEqual(await protectedState(adminPool, quotedCrm), protectedStateBefore);
    });

    const list = await queryModule.queryCustomerList({
      licenseNamespace: "test",
      limit: 10,
      filters: {},
    }, ADMIN_SECRET, { transaction: readOnlyTransaction(adminPool, quotedCrm) });
    assert.equal(list.customers.some((customer) => customer.customerId === profiles.older), true);
    assert.equal(list.customers.some((customer) => customer.customerId === profiles.newer), false);
  } finally {
    restoreEnvironment(environmentSnapshot);
    if (telemetryPool) await telemetryPool.end().catch(() => {});
    await adminPool.query(`drop schema if exists ${quotedTelemetry} cascade`).catch(() => {});
    await adminPool.query(`drop schema if exists ${quotedCrm} cascade`).catch(() => {});
    await adminPool.query(`drop owned by ${quotedRole}`).catch(() => {});
    await adminPool.query(`drop role if exists ${quotedRole}`).catch(() => {});
    const leftovers = await adminPool.query(
      `select
         count(*) filter (where nspname = any($1::text[]))::int as schemas,
         (select count(*)::int from pg_roles where rolname = $2) as roles
       from pg_namespace`,
      [[crmSchema, telemetrySchema], telemetryRole],
    ).catch(() => ({ rows: [{ schemas: -1, roles: -1 }] }));
    await adminPool.end().catch(() => {});
    await rm(temporaryDirectory, { recursive: true, force: true });
    assert.deepEqual(leftovers.rows[0], { schemas: 0, roles: 0 });
  }
});

async function applyChecksummedMigrations(pool, schema, migrations) {
  const quotedSchema = quoteIdentifier(schema);
  const client = await pool.connect();
  let applied = 0;
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [
      `sidestream:customer-360-pipeline-migrations:${schema}`,
    ]);
    await client.query(`
      create table if not exists ${quotedSchema}.sidestream_schema_migrations (
        filename text primary key,
        checksum_sha256 text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz not null default now(),
        duration_ms bigint not null check (duration_ms >= 0)
      )
    `);
    const ledger = await client.query(
      `select filename, checksum_sha256, applied_at, duration_ms
       from ${quotedSchema}.sidestream_schema_migrations order by filename`,
    );
    const statuses = classifyMigrationState(migrations, ledger.rows);
    for (const migration of statuses.filter((candidate) => candidate.status === "pending")) {
      await client.query("begin");
      try {
        await client.query(rewritePublicSchema(
          migrationSqlForTransaction(migration.sql),
          schema,
        ));
        await client.query(
          `insert into ${quotedSchema}.sidestream_schema_migrations (
             filename, checksum_sha256, duration_ms
           ) values ($1, $2, 0)`,
          [migration.filename, migration.checksum],
        );
        await client.query("commit");
        applied += 1;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
    }
    return applied;
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [
      `sidestream:customer-360-pipeline-migrations:${schema}`,
    ]).catch(() => {});
    client.release();
  }
}

async function createTelemetryFixture(pool, schema) {
  const fixture = await readFile(fixturePath, "utf8");
  await pool.query(fixture
    .replace(
      "create table sidestream_telemetry_events",
      `create table ${quoteIdentifier(schema)}.sidestream_telemetry_events`,
    )
    .replaceAll(
      "on sidestream_telemetry_events",
      `on ${quoteIdentifier(schema)}.sidestream_telemetry_events`,
    ));
}

async function seedProfilesAndEvidence(pool, schema) {
  const older = (await pool.query(
    `insert into ${schema}.sidestream_customer_profiles (
       license_namespace, created_at, updated_at
     ) values ('test', '2026-07-10T00:00:00Z', '2026-07-10T00:00:00Z') returning id`,
  )).rows[0].id;
  const newer = (await pool.query(
    `insert into ${schema}.sidestream_customer_profiles (
       license_namespace, created_at, updated_at
     ) values ('test', '2026-07-11T00:00:00Z', '2026-07-11T00:00:00Z') returning id`,
  )).rows[0].id;
  const production = (await pool.query(
    `insert into ${schema}.sidestream_customer_profiles (
       license_namespace, created_at, updated_at
     ) values ('production', '2026-07-09T00:00:00Z', '2026-07-09T00:00:00Z') returning id`,
  )).rows[0].id;

  for (const [profileId, namespace, linkType, linkValue] of [
    [older, "test", "stripe_customer", "cus_pipeline_a"],
    [older, "test", "stripe_payment_intent", "pi_pipeline_one_time"],
    [newer, "test", "stripe_customer", "cus_pipeline_b"],
    [newer, "test", "stripe_subscription", "sub_pipeline_b"],
    [production, "production", "install_identity_hash", INSTALL_PRODUCTION],
  ]) {
    await pool.query(
      `insert into ${schema}.sidestream_customer_identity_links (
         profile_id, license_namespace, link_type, link_value
       ) values ($1, $2, $3, $4)`,
      [profileId, namespace, linkType, linkValue],
    );
  }
  for (const [profileId, namespace, installHash] of [
    [older, "test", INSTALL_A],
    [newer, "test", INSTALL_B],
    [production, "production", INSTALL_PRODUCTION],
  ]) {
    await pool.query(
      `insert into ${schema}.sidestream_customer_installs (
         profile_id, license_namespace, install_id_hash, platform, app_version,
         first_seen_at, last_seen_at
       ) values ($1, $2, $3, 'macos', '1.0.14', now(), now())`,
      [profileId, namespace, installHash],
    );
  }
  return { older, newer, production };
}

async function seedTelemetry(pool, schema) {
  const events = [
    ["pipeline-a-request", INSTALL_A, "download_requested", "2026-07-13T09:00:00Z", {
      download_id: "pipeline-download-a",
      download_trigger: "result_row",
    }],
    ["pipeline-a-complete", INSTALL_A, "download_completed", "2026-07-13T09:00:30Z", {
      download_id: "pipeline-download-a",
    }],
    ["pipeline-b-request", INSTALL_B, "download_requested", "2026-07-14T10:00:00Z", {
      download_id: "pipeline-download-b",
      download_trigger: "result_row",
    }],
    ["pipeline-b-complete", INSTALL_B, "download_completed", "2026-07-14T10:00:30Z", {
      download_id: "pipeline-download-b",
    }],
  ];
  for (const [index, [id, installHash, eventName, occurredAt, payload]] of events.entries()) {
    await pool.query(
      `insert into ${schema}.sidestream_telemetry_events (
         telemetry_event_id, install_id_hash, session_id, sequence, event_name,
         event_category, event_scope, occurred_at, received_at, app_version,
         build_channel, schema_version, payload, data_points
       ) values ($1, $2, $3, $4, $5, 'download', $6, $7, $8, '1.0.14',
         'test', '0.2.0', $9, '{}')`,
      [
        id,
        installHash,
        `session-${installHash[0]}`,
        index + 1,
        eventName,
        eventName === "download_completed" ? "download" : "app",
        occurredAt,
        `2026-07-15T10:00:0${index}Z`,
        payload,
      ],
    );
  }
}

async function loadCustomerProfilesForSchema(schema, directory, pool) {
  const symbol = Symbol.for(`sidestream.customer-360.pipeline.${schema}`);
  globalThis[symbol] = { pool };
  const postgresStubPath = join(directory, "postgres-stub.mjs");
  await writeFile(postgresStubPath, `
const runtime = globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(symbol))})];
if (!runtime) throw new Error("Customer 360 pipeline runtime is unavailable");
export function getPostgresPool() { return runtime.pool; }
`, { mode: 0o600 });
  let source = rewritePublicSchema(await readFile(customerProfilesPath, "utf8"), schema);
  source = source
    .replaceAll(
      JSON.stringify("./license-environment.js"),
      JSON.stringify(pathToFileURL(licenseEnvironmentPath).href),
    )
    .replaceAll(
      JSON.stringify("./postgres.js"),
      JSON.stringify(pathToFileURL(postgresStubPath).href),
    );
  const modulePath = join(directory, "customer-profiles-under-test.ts");
  await writeFile(modulePath, source, { mode: 0o600 });
  return import(`${pathToFileURL(modulePath).href}?schema=${schema}`);
}

function configureMergeEnvironment(databaseUrl) {
  for (const name of controlledEnvironmentNames) delete process.env[name];
  process.env.SIDESTREAM_LICENSE_NAMESPACE = "test";
  process.env.SIDESTREAM_TEST_API_HOSTS = "customer-360.test";
  process.env.SIDESTREAM_TEST_POSTGRES_URL = databaseUrl;
  process.env.VERCEL_ENV = "test";
  process.env.NODE_ENV = "test";
}

function readOnlyTransaction(pool, schema) {
  return async (callback) => {
    const client = await pool.connect();
    try {
      await client.query("begin isolation level repeatable read read only");
      const result = await callback({
        query: (sql, params = []) => client.query(
          sql.replace(/\bpublic\./g, `${schema}.`),
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
}

async function profileFacts(pool, schema, profileId) {
  const result = await pool.query(
    `select total.gross_paid_minor, total.paid_transaction_count,
       profile.download_attempt_count, profile.download_success_count,
       profile.usage_install_count
     from ${schema}.sidestream_customer_profiles profile
     join ${schema}.sidestream_customer_money_totals total
       on total.profile_id = profile.id and total.currency = 'usd'
     where profile.id = $1`,
    [profileId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

async function protectedState(pool, schema) {
  return (await pool.query(
    `select
       (select count(*)::int from ${schema}.sidestream_licenses) as licenses,
       (select count(*)::int from ${schema}.sidestream_license_tokens) as tokens,
       (select count(*)::int from ${schema}.sidestream_account_devices) as devices,
       (select count(*)::int from ${schema}.sidestream_device_transfers) as transfers`,
  )).rows[0];
}

async function pipelineSnapshot(pool, schema) {
  return (await pool.query(
    `select jsonb_build_object(
       'profiles', (select count(*) from ${schema}.sidestream_customer_profiles),
       'links', (select count(*) from ${schema}.sidestream_customer_identity_links),
       'installs', (select count(*) from ${schema}.sidestream_customer_installs),
       'merges', (select count(*) from ${schema}.sidestream_customer_profile_merges),
       'commerce', (select count(*) from ${schema}.sidestream_customer_commerce_materializations),
       'totals', (select count(*) from ${schema}.sidestream_customer_money_totals),
       'usage', (select count(*) from ${schema}.sidestream_customer_usage_daily)
     ) as snapshot`,
  )).rows[0].snapshot;
}

function stripeEvent(id, type, created, object) {
  return {
    id,
    object: "event",
    api_version: "2026-06-30.basil",
    created,
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
  };
}

function rewritePublicSchema(source, schema) {
  return source.replace(/\bpublic\./g, `${quoteIdentifier(schema)}.`);
}

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new TypeError("Unsafe identifier");
  return `"${identifier}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
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

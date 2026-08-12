import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { loadInjectedModule } from "./helpers/handler-loader.mjs";

const reportModule = await loadInjectedModule(
  new URL("../api/_lib/upgrade-pricing-report.ts", import.meta.url),
  { "./postgres.js": { withPostgresTransaction: async () => ({ rows: [] }) } },
);

const CONTROL_INTENT = "10000000-0000-4000-8000-000000000001";
const MONTHLY_INTENT = "10000000-0000-4000-8000-000000000002";
const TEST_INTENT = "10000000-0000-4000-8000-000000000003";

test("disposable Postgres proves namespace, exact lineage, nested event metadata, money isolation, and client versions", {
  timeout: 120_000,
}, async () => {
  const postgres = await startDisposablePostgres();
  const pool = new Pool({
    connectionString: postgres.connectionString,
    max: 2,
    ssl: false,
  });
  try {
    await createSchema(pool);
    await seed(pool);
    const report = await reportModule.queryUpgradePricingReport({
      namespace: "production",
      from: "2026-05-01T00:00:00Z",
      through: "2026-08-12T00:00:00Z",
      asOf: "2026-08-12T00:00:00Z",
      pageSize: 100,
    }, "postgres-upgrade-report-secret", {
      now: new Date("2026-08-12T00:00:00Z"),
      query: (sql, values = []) => pool.query(sql, values),
    });

    assert.equal(report.assignmentBalance.total, 2);
    assert.equal(report.segments.length, 2);
    const control = report.segments.find((row) => row.variant === "control_one_time");
    const monthly = report.segments.find((row) => row.variant === "monthly_half");
    assert.deepEqual(control.activation, { numerator: 1, denominator: 1, rate: 1 });
    assert.equal(control.realizedMoney.grossMinor, "1999");
    assert.equal(monthly.counts.firstSuccessfulSubscriptionPayments, 1);
    assert.equal(monthly.counts.secondInvoiceSuccess, 1);
    assert.deepEqual(monthly.retention.paymentTwo, { numerator: 1, denominator: 1, rate: 1 });
    assert.equal(monthly.realizedMoney.grossMinor, "1998");
    assert.equal(monthly.realizedMoney.mrrMinor, "999");
    assert.deepEqual(report.clientVersionSegments, [
      { variant: "control_one_time", clientVersion: "1.0.11", exactLineageActivations: 1 },
      { variant: "monthly_half", clientVersion: "1.0.12", exactLineageActivations: 1 },
    ]);
    assert.ok(report.currencyTotals.every((row) => row.currency === "usd"));
    assert.doesNotMatch(JSON.stringify(report), /buyer@example\.com|cs_test_|sub_|in_|activation-secret|raw_payload/i);

    const testNamespace = await reportModule.queryUpgradePricingReport({
      namespace: "test",
      from: "2026-05-01T00:00:00Z",
      through: "2026-08-12T00:00:00Z",
      asOf: "2026-08-12T00:00:00Z",
    }, "postgres-upgrade-report-secret", {
      now: new Date("2026-08-12T00:00:00Z"),
      query: (sql, values = []) => pool.query(sql, values),
    });
    assert.equal(testNamespace.assignmentBalance.total, 1);
    assert.equal(testNamespace.segments[0].currency, "inr");
    assert.equal(testNamespace.segments[0].counts.mature24HourNonConverters, 1);
    assert.equal(testNamespace.segments[0].counts.mature7DayNonConverters, 0);
    assert.equal(testNamespace.currencyTotals.some((row) => row.currency === "usd"), false);
  } finally {
    await pool.end();
    await postgres.stop();
  }
});

async function createSchema(pool) {
  await pool.query(`
    create table public.sidestream_acquisitions (
      id uuid primary key,
      license_namespace text not null
    );
    create table public.sidestream_upgrade_pricing_assignments (
      id uuid primary key,
      account_id uuid not null,
      variant text not null,
      billing_model text not null
    );
    create table public.sidestream_checkout_intents (
      id uuid primary key,
      account_id uuid not null,
      acquisition_id uuid not null,
      upgrade_pricing_acquisition_id uuid not null,
      upgrade_pricing_snapshot_version integer not null,
      upgrade_pricing_experiment_id text not null,
      upgrade_pricing_assignment_id uuid,
      upgrade_pricing_variant text not null,
      upgrade_pricing_billing_model text not null,
      upgrade_pricing_country text not null,
      upgrade_pricing_currency text not null,
      upgrade_pricing_amount_minor bigint not null,
      upgrade_pricing_assigned_at timestamptz,
      upgrade_pricing_activation_session_id uuid,
      stripe_checkout_session_id text,
      attempt integer not null default 0,
      state text not null,
      created_at timestamptz not null
    );
    create table public.sidestream_upgrade_pricing_exposures (
      id uuid primary key,
      checkout_intent_id uuid not null,
      experiment_id text not null,
      account_id uuid not null,
      assignment_id uuid,
      variant text not null,
      billing_model text not null,
      exposed_at timestamptz not null
    );
    create table public.sidestream_licenses (
      id uuid primary key,
      account_id uuid not null,
      stripe_checkout_session_id text,
      stripe_subscription_id text,
      features jsonb not null default '{}'::jsonb,
      status text,
      entitlement_status text,
      cancel_at_period_end boolean not null default false,
      amount_paid bigint,
      amount_refunded bigint,
      reconciled_at timestamptz,
      created_at timestamptz not null,
      updated_at timestamptz not null
    );
    create table public.sidestream_activation_sessions (
      id uuid primary key,
      account_id uuid,
      license_id uuid,
      stripe_checkout_session_id text,
      completed_at timestamptz,
      app_version text
    );
    create table public.sidestream_stripe_events (
      event_id text primary key,
      event_type text not null,
      stripe_created_at timestamptz not null,
      payload jsonb not null,
      raw_payload text
    );
  `);
}

async function seed(pool) {
  const accounts = [
    "20000000-0000-4000-8000-000000000001",
    "20000000-0000-4000-8000-000000000002",
    "20000000-0000-4000-8000-000000000003",
  ];
  const acquisitions = [
    "30000000-0000-4000-8000-000000000001",
    "30000000-0000-4000-8000-000000000002",
    "30000000-0000-4000-8000-000000000003",
  ];
  const assignments = [
    "40000000-0000-4000-8000-000000000001",
    "40000000-0000-4000-8000-000000000002",
    "40000000-0000-4000-8000-000000000003",
  ];
  const activations = [
    "50000000-0000-4000-8000-000000000001",
    "50000000-0000-4000-8000-000000000002",
  ];
  const licenses = [
    "60000000-0000-4000-8000-000000000001",
    "60000000-0000-4000-8000-000000000002",
  ];

  await pool.query(
    `insert into public.sidestream_acquisitions values
      ($1, 'production'), ($2, 'production'), ($3, 'test')`,
    acquisitions,
  );
  await pool.query(
    `insert into public.sidestream_upgrade_pricing_assignments values
      ($1, $4, 'control_one_time', 'one_time'),
      ($2, $5, 'monthly_half', 'subscription'),
      ($3, $6, 'monthly_half', 'subscription')`,
    [...assignments, ...accounts],
  );
  await pool.query(
    `insert into public.sidestream_checkout_intents (
       id, account_id, acquisition_id, upgrade_pricing_acquisition_id,
       upgrade_pricing_snapshot_version, upgrade_pricing_experiment_id,
       upgrade_pricing_assignment_id, upgrade_pricing_variant,
       upgrade_pricing_billing_model, upgrade_pricing_country,
       upgrade_pricing_currency, upgrade_pricing_amount_minor,
       upgrade_pricing_assigned_at, upgrade_pricing_activation_session_id,
       stripe_checkout_session_id, attempt, state, created_at
     ) values
      ($1,$4,$7,$7,1,'upgrade-pricing-v1',$10,'control_one_time','one_time','US','usd',1999,'2026-08-01',$13,'cs_test_private_control',0,'completed','2026-08-01'),
      ($2,$5,$8,$8,1,'upgrade-pricing-v1',$11,'monthly_half','subscription','US','usd',999,'2026-06-01',$14,'cs_test_private_monthly',0,'completed','2026-06-01'),
      ($3,$6,$9,$9,1,'upgrade-pricing-v1',$12,'monthly_half','subscription','IN','inr',25000,'2026-08-10',null,'cs_test_private_test',0,'open','2026-08-10')`,
    [CONTROL_INTENT, MONTHLY_INTENT, TEST_INTENT, ...accounts, ...acquisitions, ...assignments, ...activations],
  );
  await pool.query(
    `insert into public.sidestream_upgrade_pricing_exposures values
      ('70000000-0000-4000-8000-000000000001',$1,'upgrade-pricing-v1',$4,$7,'control_one_time','one_time','2026-08-01'),
      ('70000000-0000-4000-8000-000000000002',$2,'upgrade-pricing-v1',$5,$8,'monthly_half','subscription','2026-06-01'),
      ('70000000-0000-4000-8000-000000000003',$3,'upgrade-pricing-v1',$6,$9,'monthly_half','subscription','2026-08-10')`,
    [CONTROL_INTENT, MONTHLY_INTENT, TEST_INTENT, ...accounts, ...assignments],
  );
  await pool.query(
    `insert into public.sidestream_licenses values
      ($1,$3,'cs_test_private_control',null,'{}','active','active',false,1999,0,'2026-08-01','2026-08-01','2026-08-01'),
      ($2,$4,'cs_test_private_monthly','sub_private','{"upgrade_pricing_v1":true,"subscription":true}','active','active',false,null,null,'2026-06-01','2026-06-01','2026-08-01')`,
    [...licenses, accounts[0], accounts[1]],
  );
  await pool.query(
    `insert into public.sidestream_activation_sessions values
      ($1,$3,$5,'cs_test_private_control','2026-08-01T01:00:00Z','1.0.11'),
      ($2,$4,$6,'cs_test_private_monthly','2026-06-01T01:00:00Z','1.0.12')`,
    [...activations, accounts[0], accounts[1], ...licenses],
  );

  const invoice = (intentId, objectId, amount, periodEnd) => ({
    data: { object: {
      id: objectId,
      amount_paid: amount,
      currency: "usd",
      status: "paid",
      period_end: periodEnd,
      parent: { subscription_details: { metadata: {
        sidestream_upgrade_intent_id: intentId,
      } } },
    } },
  });
  await pool.query(
    `insert into public.sidestream_stripe_events values
      ('evt_second','invoice.paid','2026-07-01',$1,null),
      ('evt_first','invoice.paid','2026-06-01',$2,null)`,
    [
      invoice(MONTHLY_INTENT, "in_private_second", 999, 1_754_006_400),
      invoice(MONTHLY_INTENT, "in_private_first", 999, 1_751_328_000),
    ],
  );
}

async function startDisposablePostgres() {
  const bindir = execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim();
  const initdb = await executable(path.join(bindir, "initdb"));
  const pgCtl = await executable(path.join(bindir, "pg_ctl"));
  const port = await reservePort();
  const root = await mkdtemp(path.join(os.tmpdir(), "sidestream-upgrade-report-pg-"));
  const dataDirectory = path.join(root, "data");
  const logPath = path.join(root, "postgres.log");
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
      "--wait", "--timeout", "20", "start",
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
          "--wait", "--timeout", "20", "--mode", "immediate", "stop",
        ], { stdio: "pipe" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

async function executable(filename) {
  await access(filename, fsConstants.X_OK);
  return filename;
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("Unable to reserve a Postgres port");
  return port;
}

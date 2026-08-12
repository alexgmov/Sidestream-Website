#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import {
  TEST_DATABASE_ENV,
  createIsolatedTestDatabaseEnvironment,
  createTestPoolOptions,
  requireSafeTestDatabaseUrl,
} from "./run-postgres-integration.mjs";

export const CUSTOMER_360_NON_POSTGRES_TESTS = Object.freeze([
  "customer-360/acquisition-funnel.test.mjs",
  "customer-360/acquisition-integrity.test.mjs",
  "customer-360/anonymous-acquisition.test.mjs",
  "customer-360/anonymous-claim.test.mjs",
  "customer-360/backfill.test.mjs",
  "customer-360/commerce.test.mjs",
  "customer-360/core.test.mjs",
  "customer-360/harness.test.mjs",
  "customer-360/operator-safety.test.mjs",
  "customer-360/privacy-contract.test.mjs",
  "customer-360/query-api.test.mjs",
  "customer-360/readiness.test.mjs",
  "customer-360/rescan.test.mjs",
  "customer-360/summary.test.mjs",
  "customer-360/usage-sync.test.mjs",
]);

export const CUSTOMER_360_POSTGRES_TESTS = Object.freeze([
  "customer-360/acquisition-funnel-postgres.test.mjs",
  "customer-360/acquisition-integrity-pipeline-postgres.test.mjs",
  "customer-360/acquisition-integrity-postgres.test.mjs",
  "customer-360/anonymous-acquisition-journey-postgres.test.mjs",
  "customer-360/anonymous-acquisition-postgres.test.mjs",
  "customer-360/anonymous-claim-postgres.test.mjs",
  "customer-360/backfill-postgres.test.mjs",
  "customer-360/commerce-postgres.test.mjs",
  "customer-360/core-postgres.test.mjs",
  "customer-360/fresh-paid-reset-postgres.test.mjs",
  "customer-360/identity.test.mjs",
  "customer-360/paid-telemetry-handoff-postgres.test.mjs",
  "customer-360/pipeline-postgres.test.mjs",
  "customer-360/query-api-postgres.test.mjs",
  "customer-360/upgrade-pricing-postgres.test.mjs",
  "customer-360/usage-sync-postgres.test.mjs",
]);

const TESTS_DIRECTORY = path.resolve("tests");
const NETWORK_GUARD = path.resolve("tests/helpers/customer-360-network-guard.mjs");

export async function assertCustomer360TestsClassified(directory = TESTS_DIRECTORY) {
  const customerDirectory = path.join(directory, "customer-360");
  const discovered = (await readdir(customerDirectory))
    .filter((filename) => filename.endsWith(".test.mjs"))
    .map((filename) => `customer-360/${filename}`)
    .sort();
  const classified = [
    ...CUSTOMER_360_NON_POSTGRES_TESTS,
    ...CUSTOMER_360_POSTGRES_TESTS,
  ].sort();
  const missing = discovered.filter((filename) => !classified.includes(filename));
  const stale = classified.filter((filename) => !discovered.includes(filename));
  if (missing.length || stale.length) {
    throw new Error([
      missing.length ? `unclassified: ${missing.join(", ")}` : "",
      stale.length ? `missing: ${stale.join(", ")}` : "",
    ].filter(Boolean).join("; "));
  }
  return discovered;
}

export async function runCustomer360Tests({ postgres = false } = {}) {
  await assertCustomer360TestsClassified();
  let disposablePostgres;
  try {
    let selectedEnvironment = process.env;
    if (postgres && !configuredValue(process.env[TEST_DATABASE_ENV])) {
      disposablePostgres = await startDisposablePostgres();
      selectedEnvironment = {
        ...process.env,
        [TEST_DATABASE_ENV]: disposablePostgres.connectionString,
      };
    } else if (postgres) {
      requireSafeTestDatabaseUrl(process.env);
    }

    const tests = postgres ? CUSTOMER_360_POSTGRES_TESTS : CUSTOMER_360_NON_POSTGRES_TESTS;
    const childEnvironment = postgres
      ? await createCustomer360PostgresEnvironment(selectedEnvironment)
      : { ...process.env };
    for (const testFile of tests) {
      const arguments_ = ["--experimental-strip-types"];
      if (postgres) arguments_.push("--import", NETWORK_GUARD);
      arguments_.push("--test", "--test-concurrency=1", path.join(TESTS_DIRECTORY, testFile));
      const exitCode = await runChild(arguments_, childEnvironment);
      if (exitCode !== 0) {
        throw new Error(`Customer 360 suite failed: ${testFile}`);
      }
    }
  } finally {
    await disposablePostgres?.stop();
  }
}

export async function createCustomer360PostgresEnvironment(environment = process.env) {
  const childEnvironment = createIsolatedTestDatabaseEnvironment(environment);
  const connectionString = childEnvironment[TEST_DATABASE_ENV];
  const pool = new Pool(createTestPoolOptions(connectionString));
  try {
    const result = await pool.query(
      "select current_setting('createrole_self_grant', true) is not null as supported",
    );
    if (result.rows[0]?.supported) {
      // PostgreSQL 16+ CREATEROLE users otherwise receive an ADMIN-only
      // self-grant, which cannot run the suites' DROP OWNED cleanup.
      const url = new URL(connectionString);
      const existingOptions = url.searchParams.get("options")?.trim();
      const roleCleanupOption = "-c createrole_self_grant=inherit,set";
      if (!existingOptions?.includes(roleCleanupOption)) {
        url.searchParams.set(
          "options",
          [existingOptions, roleCleanupOption].filter(Boolean).join(" "),
        );
      }
      childEnvironment[TEST_DATABASE_ENV] = url.toString();
    }
    return childEnvironment;
  } finally {
    await pool.end();
  }
}

async function runChild(arguments_, environment) {
  const childEnvironment = { ...environment, TZ: "America/Los_Angeles" };
  const child = spawn(process.execPath, arguments_, {
    cwd: process.cwd(),
    env: childEnvironment,
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Customer 360 tests terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function startDisposablePostgres() {
  const initdb = await findExecutable("initdb");
  const pgCtl = await findExecutable("pg_ctl");
  const port = await reservePort();
  const root = await mkdtemp(path.join(tmpdir(), "sidestream-customer-360-pg-"));
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
    throw new Error(`Unable to start disposable Customer 360 Postgres: ${error.message}\n${log}`);
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

async function findExecutable(name) {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  throw new Error(
    `${name} is required when ${TEST_DATABASE_ENV} is absent; install local PostgreSQL or provide an approved disposable URL`,
  );
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
  if (!port) throw new Error("Unable to reserve a local Customer 360 Postgres port");
  return port;
}

function configuredValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryUrl) {
  const options = process.argv.slice(2);
  if (options.some((option) => option !== "--postgres")) {
    console.error(`Unknown Customer 360 test option: ${options.join(", ")}`);
    process.exitCode = 1;
  } else {
    runCustomer360Tests({ postgres: options.includes("--postgres") }).catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  }
}

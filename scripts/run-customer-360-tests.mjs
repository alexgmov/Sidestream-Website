#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
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
  if (postgres) requireSafeTestDatabaseUrl(process.env);
  const tests = postgres ? CUSTOMER_360_POSTGRES_TESTS : CUSTOMER_360_NON_POSTGRES_TESTS;
  const childEnvironment = postgres
    ? await createCustomer360PostgresEnvironment(process.env)
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

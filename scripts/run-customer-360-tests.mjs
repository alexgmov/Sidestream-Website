#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { requireSafeTestDatabaseUrl } from "./run-postgres-integration.mjs";

export const CUSTOMER_360_NON_POSTGRES_TESTS = Object.freeze([
  "customer-360/backfill.test.mjs",
  "customer-360/commerce.test.mjs",
  "customer-360/core.test.mjs",
  "customer-360/harness.test.mjs",
  "customer-360/query-api.test.mjs",
  "customer-360/usage-sync.test.mjs",
]);

export const CUSTOMER_360_POSTGRES_TESTS = Object.freeze([
  "customer-360/backfill-postgres.test.mjs",
  "customer-360/commerce-postgres.test.mjs",
  "customer-360/core-postgres.test.mjs",
  "customer-360/identity.test.mjs",
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
  for (const testFile of tests) {
    const arguments_ = ["--experimental-strip-types"];
    if (postgres) arguments_.push("--import", NETWORK_GUARD);
    arguments_.push("--test", "--test-concurrency=1", path.join(TESTS_DIRECTORY, testFile));
    const exitCode = await runChild(arguments_);
    if (exitCode !== 0) {
      throw new Error(`Customer 360 suite failed: ${testFile}`);
    }
  }
}

async function runChild(arguments_) {
  const child = spawn(process.execPath, arguments_, {
    cwd: process.cwd(),
    env: { ...process.env, TZ: "America/Los_Angeles" },
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

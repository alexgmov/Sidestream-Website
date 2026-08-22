#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CUSTOMER_360_NON_POSTGRES_TESTS,
  CUSTOMER_360_POSTGRES_TESTS,
} from "./run-customer-360-tests.mjs";

const TESTS_DIRECTORY = path.resolve("tests");
const REQUIRED_ROOT_TESTS = Object.freeze([
  "acquisition-journey-matrix.test.mjs",
]);
const ROOT_POSTGRES_ONLY_TESTS = new Set([
  "paid-telemetry-handoff-repair.test.mjs",
  "postgres-integration.test.mjs",
  "single-device-postgres.test.mjs",
  "upgrade-pricing-report-postgres.test.mjs",
]);
const CUSTOMER_360_POSTGRES_ONLY_TESTS = new Set([
  ...CUSTOMER_360_POSTGRES_TESTS,
]);
const CUSTOMER_360_CLASSIFIED_TESTS = new Set([
  ...CUSTOMER_360_NON_POSTGRES_TESTS,
  ...CUSTOMER_360_POSTGRES_TESTS,
]);

export async function listApiTestFiles(directory = TESTS_DIRECTORY) {
  const files = await listTestFiles(directory);
  const relativeFiles = files.map((filename) => normalizeRelativePath(
    path.relative(directory, filename),
  ));
  const customer360Files = relativeFiles.filter((filename) =>
    filename.startsWith("customer-360/")
  );
  const missingRequiredRootTests = REQUIRED_ROOT_TESTS.filter((filename) =>
    !relativeFiles.includes(filename)
  );
  if (missingRequiredRootTests.length > 0) {
    throw new Error(
      `Required API test suites are missing: ${missingRequiredRootTests.join(", ")}`,
    );
  }
  const unclassifiedCustomer360 = customer360Files.filter((filename) =>
    !CUSTOMER_360_CLASSIFIED_TESTS.has(filename)
  );
  if (unclassifiedCustomer360.length > 0) {
    throw new Error(
      `Classify new Customer 360 tests explicitly: ${unclassifiedCustomer360.join(", ")}`,
    );
  }

  const unknownPostgresTests = relativeFiles.filter((filename) =>
    path.basename(filename).includes("postgres") &&
    filename !== "postgres-config.test.mjs" &&
    filename !== "postgres-transfer.test.mjs" &&
    !ROOT_POSTGRES_ONLY_TESTS.has(filename) &&
    !CUSTOMER_360_POSTGRES_ONLY_TESTS.has(filename)
  );
  if (unknownPostgresTests.length > 0) {
    throw new Error(
      `Classify new Postgres tests explicitly: ${unknownPostgresTests.join(", ")}`,
    );
  }

  const selected = files.filter((filename, index) => {
    const relative = relativeFiles[index];
    return !ROOT_POSTGRES_ONLY_TESTS.has(relative) &&
      !CUSTOMER_360_POSTGRES_ONLY_TESTS.has(relative);
  });
  if (selected.length === 0) throw new Error("No API test suites were discovered");
  return selected;
}

async function listTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listTestFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".test.mjs")) files.push(target);
  }
  return files;
}

function normalizeRelativePath(filename) {
  return filename.split(path.sep).join("/");
}

async function main() {
  const files = await listApiTestFiles();
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    "--test",
    "--test-concurrency=1",
    ...files,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, TZ: "America/Los_Angeles" },
    stdio: "inherit",
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`API tests terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  process.exitCode = exitCode;
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

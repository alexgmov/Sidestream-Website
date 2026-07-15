#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const TEST_DATABASE_ENV = "SIDESTREAM_TEST_POSTGRES_URL";
export const RUNTIME_DATABASE_ENV_NAMES = Object.freeze([
  "SIDESTREAM_PRODUCTION_POSTGRES_URL",
  "SIDESTREAM_PRODUCTION_POSTGRES_PRISMA_URL",
  "SIDESTREAM_POSTGRES_URL",
  "SIDESTREAM_POSTGRES_PRISMA_URL",
  "SIDESTREAM_POSTGRES_URL_NON_POOLING",
  "SIDESTREAM_PREVIEW_POSTGRES_URL",
  "SIDESTREAM_PREVIEW_POSTGRES_PRISMA_URL",
  "SIDESTREAM_DEPLOYED_TEST_POSTGRES_URL",
  "SIDESTREAM_TEST_RUNTIME_POSTGRES_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
  "SIDESTREAM_TELEMETRY_POSTGRES_URL",
  "TELEMETRY_POSTGRES_URL",
  "DATABASE_URL",
  "PREVIEW_DATABASE_URL",
  "TEST_DATABASE_URL",
]);

const POSTGRES_INTEGRATION_TESTS = Object.freeze([
  "tests/postgres-integration.test.mjs",
  "tests/activation-security.test.mjs",
  "tests/checkout-abuse.test.mjs",
  "tests/maintenance.test.mjs",
  "tests/stripe-events.test.mjs",
  "tests/single-device-postgres.test.mjs",
  "tests/customer-360/usage-sync-postgres.test.mjs",
]);

export function requireSafeTestDatabaseUrl(environment = process.env) {
  const connectionString = configuredValue(environment[TEST_DATABASE_ENV]);
  if (!connectionString) {
    throw new Error(
      `${TEST_DATABASE_ENV} is required; Postgres integration tests never skip silently`,
    );
  }
  const testIdentity = databaseIdentity(connectionString, TEST_DATABASE_ENV);
  for (const name of RUNTIME_DATABASE_ENV_NAMES) {
    const runtimeConnectionString = configuredValue(environment[name]);
    if (!runtimeConnectionString) continue;
    if (databaseIdentity(runtimeConnectionString, name) === testIdentity) {
      throw new Error(`${TEST_DATABASE_ENV} must not match runtime database ${name}`);
    }
  }
  return connectionString;
}

export function createTestPoolOptions(connectionString) {
  const url = parsePostgresUrl(connectionString, TEST_DATABASE_ENV);
  if (/^(prefer|require)$/i.test(url.searchParams.get("sslmode") || "")) {
    url.searchParams.delete("sslmode");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
  const sslDisabled = /sslmode=(disable|false)/i.test(connectionString);
  return {
    connectionString: url.toString(),
    max: 12,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    ssl: local || sslDisabled ? false : { rejectUnauthorized: false },
  };
}

function databaseIdentity(connectionString, environmentName) {
  const url = parsePostgresUrl(connectionString, environmentName);
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  return `${url.hostname.toLowerCase()}:${url.port || "5432"}/${database}`;
}

function parsePostgresUrl(connectionString, environmentName) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`${environmentName} must be a valid Postgres URL`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${environmentName} must use postgres: or postgresql:`);
  }
  if (!url.hostname || !url.pathname.replace(/^\/+/, "")) {
    throw new Error(`${environmentName} must identify a Postgres host and database`);
  }
  return url;
}

function configuredValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

async function main() {
  requireSafeTestDatabaseUrl();
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    "--test",
    "--test-concurrency=1",
    ...POSTGRES_INTEGRATION_TESTS,
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Postgres integration tests terminated by ${signal}`));
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

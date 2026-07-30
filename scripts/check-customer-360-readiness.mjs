#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  RUNTIME_DATABASE_ENV_NAMES,
  createTestPoolOptions,
  requireSafeTestDatabaseUrl,
} from "./run-postgres-integration.mjs";

export const CUSTOMER_360_SOURCE_FILES = Object.freeze([
  "api/_lib/customer-admin.ts",
  "api/_lib/customer-commerce.ts",
  "api/_lib/customer-profiles.ts",
  "api/_lib/customer-query.ts",
  "api/_lib/customer-usage.ts",
  "api/internal/customer-usage/sync.ts",
  "api/internal/customers/index.ts",
  "api/internal/customers/[customerId].ts",
  "db/migrations/20260715120000_add_customer_360_core.sql",
  "db/migrations/20260715121000_add_customer_identity_links.sql",
  "db/migrations/20260715122000_add_customer_commerce_ledger.sql",
  "db/migrations/20260715123000_add_customer_usage_aggregates.sql",
  "db/migrations/20260715124000_add_customer_360_read_model.sql",
  "scripts/backfill-customer-360.mjs",
  "scripts/verify-customer-360-backfill.mjs",
]);

export const CUSTOMER_360_TABLES = Object.freeze([
  "sidestream_customer_commerce_aliases",
  "sidestream_customer_commerce_invoice_payments",
  "sidestream_customer_commerce_materializations",
  "sidestream_customer_identity_links",
  "sidestream_customer_identity_reviews",
  "sidestream_customer_installs",
  "sidestream_customer_money_totals",
  "sidestream_customer_profile_merges",
  "sidestream_customer_profiles",
  "sidestream_customer_usage_daily",
  "sidestream_customer_usage_sync_state",
]);

export const CUSTOMER_360_READ_FUNCTIONS = Object.freeze([
  "sidestream_customer_360_money_read_model",
  "sidestream_customer_360_profile_read_model",
]);

export const CUSTOMER_360_MIGRATIONS = Object.freeze([
  "20260715120000_add_customer_360_core.sql",
  "20260715121000_add_customer_identity_links.sql",
  "20260715122000_add_customer_commerce_ledger.sql",
  "20260715123000_add_customer_usage_aggregates.sql",
  "20260715124000_add_customer_360_read_model.sql",
]);

export const CONFIGURATION_SELECTORS = Object.freeze([
  "SIDESTREAM_CRM_ADMIN_SECRET",
  "CRON_SECRET",
  "SIDESTREAM_TELEMETRY_POSTGRES_URL",
  "SIDESTREAM_TEST_POSTGRES_URL",
  "SIDESTREAM_LICENSE_NAMESPACE",
  "SIDESTREAM_TEST_API_HOSTS",
  "VERCEL_ENV",
]);

const SECRET_SELECTORS = new Set([
  "SIDESTREAM_CRM_ADMIN_SECRET",
  "CRON_SECRET",
]);
const POSTGRES_SELECTORS = new Set([
  "SIDESTREAM_TELEMETRY_POSTGRES_URL",
  "SIDESTREAM_TEST_POSTGRES_URL",
]);
const MIGRATION_FILENAME_PATTERN = /^\d{14}_[a-z0-9_]+\.sql$/;

export function parseReadinessArguments(argv) {
  const parsed = {
    origin: null,
    testDatabase: false,
    requireReady: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--test-database") {
      parsed.testDatabase = true;
    } else if (argument === "--require-ready") {
      parsed.requireReady = true;
    } else if (argument === "--origin") {
      if (parsed.origin !== null || index + 1 >= argv.length) {
        throw new Error("Invalid --origin option");
      }
      parsed.origin = validateHttpsOrigin(argv[index += 1]);
    } else {
      throw new Error("Unknown Customer 360 readiness option");
    }
  }
  return Object.freeze(parsed);
}

export function validateHttpsOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("--origin must be a strict HTTPS origin");
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin === "null"
  ) {
    throw new Error("--origin must be a strict HTTPS origin");
  }
  return parsed.origin;
}

export function inspectConfiguration(environment = process.env) {
  const selectors = {};
  for (const name of CONFIGURATION_SELECTORS) {
    const rawValue = typeof environment[name] === "string" ? environment[name] : "";
    const value = SECRET_SELECTORS.has(name) ? rawValue : rawValue.trim();
    selectors[name] = Object.freeze({
      present: value.length > 0,
      valid: value.length > 0 && validateSelector(name, value),
    });
  }
  if (selectors.SIDESTREAM_TEST_POSTGRES_URL.valid) {
    try {
      requireSafeTestDatabaseUrl(environment);
    } catch {
      selectors.SIDESTREAM_TEST_POSTGRES_URL = Object.freeze({
        present: true,
        valid: false,
      });
    }
  }
  if (
    selectors.SIDESTREAM_TELEMETRY_POSTGRES_URL.valid &&
    telemetryMatchesRuntime(environment)
  ) {
    selectors.SIDESTREAM_TELEMETRY_POSTGRES_URL = Object.freeze({
      present: true,
      valid: false,
    });
  }
  return Object.freeze({
    ready: Object.values(selectors).every((selector) => selector.valid),
    selectors: Object.freeze(selectors),
  });
}

function telemetryMatchesRuntime(environment) {
  const telemetry = databaseIdentity(environment.SIDESTREAM_TELEMETRY_POSTGRES_URL);
  if (!telemetry) return false;
  return RUNTIME_DATABASE_ENV_NAMES
    .filter((name) =>
      name !== "SIDESTREAM_TELEMETRY_POSTGRES_URL" &&
      name !== "TELEMETRY_POSTGRES_URL"
    )
    .some((name) => {
      const runtime = databaseIdentity(environment[name]);
      return runtime !== null && runtime === telemetry;
    });
}

function databaseIdentity(value) {
  const configured = configuredValue(value);
  if (!configured) return null;
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return null;
    const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    if (!parsed.hostname || !database) return null;
    return `${parsed.hostname.toLowerCase()}:${parsed.port || "5432"}/${database}`;
  } catch {
    return null;
  }
}

function validateSelector(name, value) {
  if (SECRET_SELECTORS.has(name)) {
    return value.length >= 16 && value.length <= 512 && /^[\x21-\x7e]+$/.test(value);
  }
  if (POSTGRES_SELECTORS.has(name)) return isPostgresUrl(value);
  if (name === "SIDESTREAM_LICENSE_NAMESPACE") return value === "test";
  if (name === "VERCEL_ENV") {
    return value === "preview" || value === "development" || value === "test";
  }
  if (name === "SIDESTREAM_TEST_API_HOSTS") return isHostList(value);
  return false;
}

function isPostgresUrl(value) {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") &&
      Boolean(parsed.hostname) &&
      Boolean(parsed.pathname.replace(/^\/+/, ""))
    );
  } catch {
    return false;
  }
}

function isHostList(value) {
  const hosts = value.split(",");
  return hosts.length > 0 && hosts.length <= 20 && hosts.every((host) => {
    const candidate = host.trim().toLowerCase();
    if (!candidate || candidate.includes("/") || candidate.includes("@")) return false;
    try {
      const parsed = new URL(`https://${candidate}`);
      return parsed.hostname.length > 0 && parsed.pathname === "/" &&
        !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
    } catch {
      return false;
    }
  });
}

export async function inspectCustomer360Source({
  repositoryRoot = process.cwd(),
  fileAccess = access,
} = {}) {
  let presentCount = 0;
  for (const filename of CUSTOMER_360_SOURCE_FILES) {
    try {
      await fileAccess(path.join(repositoryRoot, filename));
      presentCount += 1;
    } catch {
      // Presence is reported as a count so missing paths cannot expose host details.
    }
  }
  const migrationManifest = await loadMigrationManifest(repositoryRoot).catch(() => []);
  const customerMigrationCount = migrationManifest.filter((migration) =>
    CUSTOMER_360_MIGRATIONS.includes(migration.filename)
  ).length;
  const backfillSourceReady = [
    "scripts/backfill-customer-360.mjs",
    "scripts/verify-customer-360-backfill.mjs",
  ].every((filename) => CUSTOMER_360_SOURCE_FILES.includes(filename)) &&
    presentCount === CUSTOMER_360_SOURCE_FILES.length;
  return Object.freeze({
    ready: presentCount === CUSTOMER_360_SOURCE_FILES.length &&
      customerMigrationCount === CUSTOMER_360_MIGRATIONS.length,
    expectedFileCount: CUSTOMER_360_SOURCE_FILES.length,
    presentFileCount: presentCount,
    expectedMigrationCount: CUSTOMER_360_MIGRATIONS.length,
    presentMigrationCount: customerMigrationCount,
    backfillSourceReady,
  });
}

export function classifyProtectedProbe(statusCode, code, unavailableCode) {
  if (statusCode === 401 && code === "unauthorized") {
    return Object.freeze({
      ready: true,
      configured: true,
      protected: true,
      statusCode,
    });
  }
  if (statusCode === 503 && code === unavailableCode) {
    return Object.freeze({
      ready: false,
      configured: false,
      protected: true,
      statusCode,
    });
  }
  return Object.freeze({
    ready: false,
    configured: false,
    protected: false,
    statusCode: Number.isInteger(statusCode) ? statusCode : 0,
  });
}

export async function probeCustomer360Api(origin, {
  fetchImpl = globalThis.fetch,
} = {}) {
  const strictOrigin = validateHttpsOrigin(origin);
  const list = await probeRoute(fetchImpl, new URL(
    "/api/internal/customers",
    strictOrigin,
  ), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: "{}",
    redirect: "manual",
  }, "customer_admin_unavailable");
  const usageSync = await probeRoute(fetchImpl, new URL(
    "/api/internal/customer-usage/sync",
    strictOrigin,
  ), {
    method: "GET",
    headers: { Accept: "application/json" },
    redirect: "manual",
  }, "customer_usage_sync_unavailable");
  return Object.freeze({
    requested: true,
    ready: list.ready && usageSync.ready,
    customerList: list,
    usageSync,
  });
}

async function probeRoute(fetchImpl, url, options, unavailableCode) {
  try {
    const response = await fetchImpl(url, options);
    let code = "";
    try {
      const body = await response.json();
      code = typeof body?.code === "string" ? body.code : "";
    } catch {
      // Classification intentionally uses only an exact bounded JSON code.
    }
    return classifyProtectedProbe(response.status, code, unavailableCode);
  } catch {
    return classifyProtectedProbe(0, "", unavailableCode);
  }
}

export async function inspectCustomer360Database({
  environment = process.env,
  repositoryRoot = process.cwd(),
  createPool = defaultCreatePool,
  migrationManifest,
} = {}) {
  let connectionString;
  try {
    connectionString = requireSafeTestDatabaseUrl(environment);
  } catch {
    return unavailableDatabaseReport();
  }

  let pool;
  let client;
  let transactionStarted = false;
  let rollbackSucceeded = false;
  let report = unavailableDatabaseReport();
  try {
    const expectedMigrations = migrationManifest ||
      await loadMigrationManifest(repositoryRoot);
    pool = await createPool(connectionString);
    client = await pool.connect();
    await client.query("begin read only");
    transactionStarted = true;
    const transactionState = await client.query("show transaction_read_only");
    const transactionReadOnly =
      transactionState.rows[0]?.transaction_read_only === "on";

    const relations = await client.query(
      `select class.relname as name
       from pg_class class
       join pg_namespace namespace on namespace.oid = class.relnamespace
       where namespace.nspname = 'public'
         and class.relkind = 'r'
         and (
           class.relname = 'sidestream_schema_migrations'
           or class.relname = any($1::text[])
         )
       order by class.relname`,
      [CUSTOMER_360_TABLES],
    );
    const relationNames = new Set(relations.rows.map((row) => String(row.name)));
    const presentTableCount = CUSTOMER_360_TABLES.filter((name) =>
      relationNames.has(name)
    ).length;
    const ledgerPresent = relationNames.has("sidestream_schema_migrations");

    const functions = await client.query(
      `select procedure.proname as name
       from pg_proc procedure
       join pg_namespace namespace on namespace.oid = procedure.pronamespace
       where namespace.nspname = 'public'
         and procedure.proname = any($1::text[])
       order by procedure.proname`,
      [CUSTOMER_360_READ_FUNCTIONS],
    );
    const functionNames = new Set(functions.rows.map((row) => String(row.name)));
    const presentFunctionCount = CUSTOMER_360_READ_FUNCTIONS.filter((name) =>
      functionNames.has(name)
    ).length;

    let appliedMigrationCount = 0;
    let ledgerChecksumsMatch = false;
    if (ledgerPresent) {
      const ledger = await client.query(
        `select filename, checksum_sha256
         from public.sidestream_schema_migrations
         order by filename`,
      );
      const ledgerByFilename = new Map(ledger.rows.map((row) => [
        String(row.filename),
        String(row.checksum_sha256),
      ]));
      appliedMigrationCount = expectedMigrations.filter((migration) =>
        ledgerByFilename.get(migration.filename) === migration.checksum
      ).length;
      ledgerChecksumsMatch = ledgerByFilename.size === expectedMigrations.length &&
        appliedMigrationCount === expectedMigrations.length;
    }

    const schemaReady =
      presentTableCount === CUSTOMER_360_TABLES.length &&
      presentFunctionCount === CUSTOMER_360_READ_FUNCTIONS.length;
    let backfill = Object.freeze({
      ready: false,
      inspected: false,
    });
    if (schemaReady) {
      const counts = await client.query(
        `select
           (select count(*)::int from public.sidestream_customer_profiles
             where merged_into is null) as live_profiles,
           (select count(*)::int from public.sidestream_customer_profiles
             where merged_into is not null) as merged_profiles,
           (select count(*)::int from public.sidestream_customer_identity_links)
             as identity_links,
           (select count(*)::int from public.sidestream_customer_installs)
             as installs,
           (select count(*)::int from public.sidestream_customer_identity_reviews
             where review_state = 'pending_review') as pending_identity_reviews`,
      );
      const row = counts.rows[0] || {};
      const backfillCounts = Object.freeze({
        liveProfiles: integerCount(row.live_profiles),
        mergedProfiles: integerCount(row.merged_profiles),
        identityLinks: integerCount(row.identity_links),
        installs: integerCount(row.installs),
        pendingIdentityReviews: integerCount(row.pending_identity_reviews),
      });
      backfill = Object.freeze({
        ready: ledgerChecksumsMatch && backfillCounts.pendingIdentityReviews === 0,
        inspected: true,
        counts: backfillCounts,
      });
    }

    report = Object.freeze({
      requested: true,
      ready: transactionReadOnly && schemaReady && ledgerChecksumsMatch &&
        backfill.ready,
      connected: true,
      transactionReadOnly,
      schema: Object.freeze({
        ready: schemaReady,
        expectedTableCount: CUSTOMER_360_TABLES.length,
        presentTableCount,
        expectedReadFunctionCount: CUSTOMER_360_READ_FUNCTIONS.length,
        presentReadFunctionCount: presentFunctionCount,
      }),
      migrationLedger: Object.freeze({
        ready: ledgerChecksumsMatch,
        present: ledgerPresent,
        expectedCount: expectedMigrations.length,
        appliedCount: appliedMigrationCount,
        checksumsMatch: ledgerChecksumsMatch,
      }),
      backfill,
    });
  } catch {
    report = unavailableDatabaseReport();
  } finally {
    if (client && transactionStarted) {
      try {
        await client.query("rollback");
        rollbackSucceeded = true;
      } catch {
        // The report already fails closed; never attempt commit or recovery writes.
      }
    }
    client?.release?.();
    if (pool?.end) {
      try {
        await pool.end();
      } catch {
        // Closing failure cannot make an inspection ready.
      }
    }
  }
  return transactionStarted && !rollbackSucceeded
    ? unavailableDatabaseReport()
    : report;
}

function unavailableDatabaseReport() {
  return Object.freeze({
    requested: true,
    ready: false,
    connected: false,
    transactionReadOnly: false,
    schema: Object.freeze({ ready: false }),
    migrationLedger: Object.freeze({ ready: false }),
    backfill: Object.freeze({ ready: false, inspected: false }),
  });
}

async function defaultCreatePool(connectionString) {
  const { Pool } = await import("pg");
  return new Pool({
    ...createTestPoolOptions(connectionString),
    max: 1,
    options: "-c default_transaction_read_only=on",
  });
}

export async function loadMigrationManifest(repositoryRoot = process.cwd()) {
  const directory = path.join(repositoryRoot, "db/migrations");
  const filenames = (await readdir(directory))
    .filter((filename) => MIGRATION_FILENAME_PATTERN.test(filename))
    .sort();
  return Promise.all(filenames.map(async (filename) => {
    const source = await readFile(path.join(directory, filename), "utf8");
    return Object.freeze({
      filename,
      checksum: createHash("sha256").update(source).digest("hex"),
    });
  }));
}

export async function runReadinessCheck(options, {
  environment = process.env,
  repositoryRoot = process.cwd(),
  fileAccess = access,
  fetchImpl = globalThis.fetch,
  createPool = defaultCreatePool,
  migrationManifest,
} = {}) {
  const source = await inspectCustomer360Source({ repositoryRoot, fileAccess });
  const configuration = inspectConfiguration(environment);
  const api = options.origin
    ? await probeCustomer360Api(options.origin, { fetchImpl })
    : Object.freeze({ requested: false, ready: true });
  const database = options.testDatabase
    ? await inspectCustomer360Database({
      environment,
      repositoryRoot,
      createPool,
      migrationManifest,
    })
    : Object.freeze({ requested: false, ready: true });
  const ready = source.ready && configuration.ready && api.ready && database.ready;
  return Object.freeze({
    ready,
    source,
    configuration,
    api,
    database,
  });
}

export function formatReadinessReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export async function executeReadinessCli(argv, {
  writeOutput = (value) => process.stdout.write(value),
  writeError = (value) => process.stderr.write(value),
  ...dependencies
} = {}) {
  let options;
  try {
    options = parseReadinessArguments(argv);
  } catch {
    writeError("Customer 360 readiness options are invalid.\n");
    return 2;
  }
  const report = await runReadinessCheck(options, dependencies);
  writeOutput(formatReadinessReport(report));
  return options.requireReady && !report.ready ? 1 : 0;
}

function configuredValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function integerCount(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryUrl) {
  executeReadinessCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    process.stderr.write("Customer 360 readiness inspection failed safely.\n");
    process.exitCode = 2;
  });
}

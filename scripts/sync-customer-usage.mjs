#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import ts from "typescript";
import { requireSafeTestDatabaseUrl } from "./run-postgres-integration.mjs";

export const CUSTOMER_USAGE_BATCH_SIZE = 250;
export const CUSTOMER_USAGE_SCHEMA_VERSIONS = Object.freeze(["0.2.0"]);
export const PRODUCTION_CONFIRMATION = "APPLY_PRODUCTION_CUSTOMER_USAGE";
export const CUSTOMER_USAGE_OPERATOR_INVARIANTS = Object.freeze({
  rawTelemetry: "read_only",
  targetWrites: "append_or_update_only",
  historicalRescanWrites: "usage_aggregates_only",
  deleteStatements: "forbidden",
  canonicalAcquisitionRewrite: "forbidden",
  protectedDomains: Object.freeze([
    "raw_telemetry", "profile_identity", "commerce", "entitlement", "device",
    "audit", "payment",
  ]),
});

export class CustomerUsageOperatorError extends Error {
  constructor(message) {
    super(message);
    this.name = "CustomerUsageOperatorError";
  }
}

export function parseCustomerUsageSyncArgs(argv) {
  const options = {
    apply: false,
    dryRun: true,
    target: "",
    targetUrlEnv: "",
    telemetryUrlEnv: "SIDESTREAM_TELEMETRY_POSTGRES_URL",
    confirmProduction: "",
    confirmTarget: "",
    batchSize: CUSTOMER_USAGE_BATCH_SIZE,
    maxSourceLagHours: 72,
    help: false,
  };
  let sawDryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      options.apply = true;
      options.dryRun = false;
    } else if (argument === "--dry-run") {
      sawDryRun = true;
      options.dryRun = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (hasOption(argument, "--target")) {
      [options.target, index] = readOption(argv, index, "--target");
    } else if (hasOption(argument, "--target-url-env")) {
      [options.targetUrlEnv, index] = readOption(argv, index, "--target-url-env");
    } else if (hasOption(argument, "--telemetry-url-env")) {
      [options.telemetryUrlEnv, index] = readOption(argv, index, "--telemetry-url-env");
    } else if (hasOption(argument, "--confirm-production")) {
      [options.confirmProduction, index] = readOption(argv, index, "--confirm-production");
    } else if (hasOption(argument, "--confirm-target")) {
      [options.confirmTarget, index] = readOption(argv, index, "--confirm-target");
    } else if (hasOption(argument, "--batch-size")) {
      let raw;
      [raw, index] = readOption(argv, index, "--batch-size");
      options.batchSize = boundedInteger(raw, 25, 1_000, "batch size");
    } else if (hasOption(argument, "--max-source-lag-hours")) {
      let raw;
      [raw, index] = readOption(argv, index, "--max-source-lag-hours");
      options.maxSourceLagHours = boundedInteger(
        raw,
        1,
        24 * 30,
        "source freshness hours",
      );
    } else {
      throw new CustomerUsageOperatorError(`Unknown option ${JSON.stringify(argument)}.`);
    }
  }
  if (options.apply && sawDryRun) {
    throw new CustomerUsageOperatorError("Choose either --apply or --dry-run.");
  }
  if (options.target && !["test", "production"].includes(options.target)) {
    throw new CustomerUsageOperatorError("--target must be test or production.");
  }
  if (options.apply && !options.target) {
    throw new CustomerUsageOperatorError("Apply requires an explicit --target.");
  }
  if (options.target === "test") {
    options.targetUrlEnv ||= "SIDESTREAM_TEST_POSTGRES_URL";
    if (options.targetUrlEnv !== "SIDESTREAM_TEST_POSTGRES_URL") {
      throw new CustomerUsageOperatorError(
        "Test apply may use only SIDESTREAM_TEST_POSTGRES_URL.",
      );
    }
  }
  if (options.target === "production") {
    options.targetUrlEnv ||= "SIDESTREAM_POSTGRES_URL_NON_POOLING";
    if (options.apply && options.confirmProduction !== PRODUCTION_CONFIRMATION) {
      throw new CustomerUsageOperatorError(
        `Production apply requires --confirm-production ${PRODUCTION_CONFIRMATION}.`,
      );
    }
    if (options.apply && !options.confirmTarget) {
      throw new CustomerUsageOperatorError(
        "Production apply requires the sanitized --confirm-target fingerprint.",
      );
    }
  }
  return Object.freeze(options);
}

export function sanitizedTargetFingerprint(connectionString) {
  const url = safePostgresUrl(connectionString);
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const identity = `${url.hostname.toLowerCase()}:${url.port || "5432"}/${database}`;
  return `pg-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

export function authenticatedPostgresPoolOptions(connectionString, { readOnly = false } = {}) {
  const url = safePostgresUrl(connectionString);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
  const sslMode = (url.searchParams.get("sslmode") || "").toLowerCase();
  if (!local && ["disable", "false", "allow", "prefer"].includes(sslMode)) {
    throw new CustomerUsageOperatorError("Remote Postgres requires authenticated TLS.");
  }
  url.searchParams.delete("sslmode");
  return {
    connectionString: url.toString(),
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
    options: readOnly ? "-c default_transaction_read_only=on" : undefined,
    ssl: local ? false : { rejectUnauthorized: true },
  };
}

export async function readCustomerUsageSourceFreshness({
  telemetryPool,
  telemetrySchema = "public",
  target,
  now = new Date(),
  maxSourceLagHours = 72,
}) {
  if (!/^[a-z][a-z0-9_]*$/.test(telemetrySchema)) {
    throw new CustomerUsageOperatorError("Unsafe telemetry schema.");
  }
  const channels = target === "test" ? ["test"] : ["production", "prod"];
  const result = await telemetryPool.query(
    `select max(received_at) as source_freshness_at
     from ${telemetrySchema}.sidestream_telemetry_events
     where schema_version = any($1::text[])
       and coalesce(nullif(build_channel, ''), 'production') = any($2::text[])
       and install_id_hash ~ '^[0-9a-f]{64}$'
       and occurred_at is not null`,
    [[...CUSTOMER_USAGE_SCHEMA_VERSIONS], channels],
  );
  const value = result.rows[0]?.source_freshness_at;
  const freshness = value ? new Date(value) : null;
  if (!freshness || !Number.isFinite(freshness.getTime())) {
    throw new CustomerUsageOperatorError("Telemetry source has no reportable freshness.");
  }
  const lagMs = now.getTime() - freshness.getTime();
  if (lagMs > maxSourceLagHours * 3_600_000) {
    throw new CustomerUsageOperatorError("Telemetry source freshness check failed.");
  }
  return Object.freeze({
    sourceFreshnessAt: freshness.toISOString(),
    lagHours: Math.max(0, lagMs / 3_600_000).toFixed(2),
    withinLimit: true,
  });
}

export async function runCustomerUsageSyncOperator({
  options,
  environment = process.env,
  now = new Date(),
  createPool = (poolOptions) => new Pool(poolOptions),
  runSync = null,
} = {}) {
  const parsed = options || parseCustomerUsageSyncArgs([]);
  const targetUrl = parsed.targetUrlEnv ? environment[parsed.targetUrlEnv] : "";
  const telemetryUrl = environment[parsed.telemetryUrlEnv];
  const targetFingerprint = targetUrl ? sanitizedTargetFingerprint(targetUrl) : null;
  const planned = {
    mode: parsed.apply ? "apply" : "dry_run",
    target: parsed.target || null,
    targetFingerprint,
    batchSize: parsed.batchSize,
    maxSourceLagHours: parsed.maxSourceLagHours,
    invariants: CUSTOMER_USAGE_OPERATOR_INVARIANTS,
  };
  if (!parsed.apply) return Object.freeze({ ...planned, connected: false, writes: 0 });
  if (!targetUrl || !telemetryUrl) {
    throw new CustomerUsageOperatorError("Required Postgres environment selector is not configured.");
  }
  if (parsed.target === "test") requireSafeTestDatabaseUrl(environment);
  if (parsed.target === "production" && parsed.confirmTarget !== targetFingerprint) {
    throw new CustomerUsageOperatorError("Production target fingerprint confirmation does not match.");
  }
  if (sanitizedTargetFingerprint(telemetryUrl) === targetFingerprint) {
    throw new CustomerUsageOperatorError("Telemetry source and aggregate target must be separate.");
  }

  const targetPool = createPool(authenticatedPostgresPoolOptions(targetUrl));
  const telemetryPool = createPool(authenticatedPostgresPoolOptions(
    telemetryUrl,
    { readOnly: true },
  ));
  try {
    const freshness = await readCustomerUsageSourceFreshness({
      telemetryPool,
      target: parsed.target,
      now,
      maxSourceLagHours: parsed.maxSourceLagHours,
    });
    const sync = runSync || (await loadCustomerUsageRuntime()).runCustomerUsageSync;
    const summary = await sync({
      targetPool,
      telemetryPool,
      licenseNamespace: parsed.target,
      batchSize: parsed.batchSize,
      now,
    });
    return Object.freeze({ ...planned, connected: true, freshness, summary });
  } finally {
    await Promise.allSettled([targetPool.end(), telemetryPool.end()]);
  }
}

let customerUsageRuntimePromise;
export function loadCustomerUsageRuntime() {
  customerUsageRuntimePromise ||= (async () => {
    const sourceUrl = new URL("../api/_lib/customer-usage.ts", import.meta.url);
    const source = await readFile(sourceUrl, "utf8");
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true,
      },
    }).outputText;
    const executable = transpiled
      .replaceAll('from "pg"', `from ${JSON.stringify(import.meta.resolve("pg"))}`)
      .replaceAll(
        'from "./postgres.js"',
        `from ${JSON.stringify(new URL("../api/_lib/postgres.ts", import.meta.url).href)}`,
      );
    return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(executable)}`);
  })();
  return customerUsageRuntimePromise;
}

function safePostgresUrl(connectionString) {
  try {
    const url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
      throw new Error("invalid");
    }
    return url;
  } catch {
    throw new CustomerUsageOperatorError("Postgres selector is invalid.");
  }
}

function hasOption(argument, name) {
  return argument === name || argument.startsWith(`${name}=`);
}

function readOption(argv, index, name) {
  const argument = argv[index];
  const value = argument.startsWith(`${name}=`)
    ? argument.slice(name.length + 1)
    : argv[index + 1];
  if (!value || (!argument.startsWith(`${name}=`) && value.startsWith("--"))) {
    throw new CustomerUsageOperatorError(`${name} requires a value.`);
  }
  return [value, argument.startsWith(`${name}=`) ? index : index + 1];
}

function boundedInteger(raw, minimum, maximum, label) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new CustomerUsageOperatorError(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function usage() {
  return `Usage:
  node scripts/sync-customer-usage.mjs --dry-run [--target test|production]
  node scripts/sync-customer-usage.mjs --apply --target test --batch-size 250
  node scripts/sync-customer-usage.mjs --apply --target production \\
    --confirm-production ${PRODUCTION_CONFIRMATION} --confirm-target pg-...

URLs are accepted only through named environment selectors. Dry-run performs no
network or database access. Production apply requires both exact confirmations.`;
}

async function main() {
  const options = parseCustomerUsageSyncArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  console.log(JSON.stringify(await runCustomerUsageSyncOperator({ options })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof CustomerUsageOperatorError ? error.message : "Customer usage sync failed.");
    process.exitCode = 1;
  });
}

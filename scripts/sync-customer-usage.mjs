#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  CUSTOMER_360_DATABASE_SELECTORS,
  Customer360OperatorGuardError,
  authenticatedOperatorPoolOptions,
  connectAndFingerprintOperatorDatabase,
  exactTargetSelector,
  loadOperatorPackage,
  rejectConnectedCollision,
  requireProductionConfirmations,
  resolveOperatorDatabase,
  safeOperatorCliError,
} from "./customer-360-operator-guards.mjs";

export const CUSTOMER_USAGE_BATCH_SIZE = 250;
export const CUSTOMER_USAGE_SCHEMA_VERSIONS = Object.freeze(["0.2.0"]);
export const PRODUCTION_CONFIRMATION = "APPLY_PRODUCTION_CUSTOMER_USAGE";
export const CUSTOMER_USAGE_SYNC_OPERATION = "customer_usage_sync";
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
    status: false,
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
    } else if (argument === "--status") {
      options.status = true;
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
    } else if (hasOption(argument, "--confirm-operation")) {
      [options.confirmProduction, index] = readOption(argv, index, "--confirm-operation");
    } else if (hasOption(argument, "--confirm-target")) {
      [options.confirmTarget, index] = readOption(argv, index, "--confirm-target");
    } else if (hasOption(argument, "--batch-size")) {
      let raw;
      [raw, index] = readOption(argv, index, "--batch-size");
      options.batchSize = boundedInteger(raw, 25, 10_000, "batch size");
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
  if ((options.apply && sawDryRun) || (options.apply && options.status) || (sawDryRun && options.status)) {
    throw new CustomerUsageOperatorError("Choose exactly one of --apply, --status, or --dry-run.");
  }
  if (options.target && !["test", "production"].includes(options.target)) {
    throw new CustomerUsageOperatorError("--target must be test or production.");
  }
  if ((options.apply || options.status) && !options.target) {
    throw new CustomerUsageOperatorError("Connected operations require an explicit --target.");
  }
  if (options.target === "test") {
    options.targetUrlEnv ||= exactTargetSelector("test");
    if (options.targetUrlEnv !== exactTargetSelector("test")) {
      throw new CustomerUsageOperatorError(
        "Test apply may use only SIDESTREAM_TEST_POSTGRES_URL.",
      );
    }
  }
  if (options.target === "production") {
    options.targetUrlEnv ||= exactTargetSelector("production");
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
  if (options.telemetryUrlEnv !== CUSTOMER_360_DATABASE_SELECTORS.telemetry) {
    throw new CustomerUsageOperatorError(
      "Usage sync may use only SIDESTREAM_TELEMETRY_POSTGRES_URL as its source.",
    );
  }
  return Object.freeze(options);
}

export function authenticatedPostgresPoolOptions(connectionString, { readOnly = false } = {}) {
  try {
    return authenticatedOperatorPoolOptions(connectionString, { readOnly });
  } catch (error) {
    if (error instanceof Customer360OperatorGuardError) {
      throw new CustomerUsageOperatorError(error.message);
    }
    throw error;
  }
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
  createPool = null,
  runSync = null,
} = {}) {
  const parsed = options || parseCustomerUsageSyncArgs([]);
  const planned = {
    mode: parsed.apply ? "apply" : parsed.status ? "status" : "dry_run",
    target: parsed.target || null,
    targetFingerprint: null,
    sourceFingerprint: null,
    batchSize: parsed.batchSize,
    maxSourceLagHours: parsed.maxSourceLagHours,
    invariants: CUSTOMER_USAGE_OPERATOR_INVARIANTS,
  };
  if (parsed.dryRun) return Object.freeze({ ...planned, connected: false, writes: 0 });
  let targetDescriptor;
  let sourceDescriptor;
  try {
    targetDescriptor = resolveOperatorDatabase({
      environment,
      namespace: parsed.target,
      selector: parsed.targetUrlEnv,
    });
    sourceDescriptor = resolveOperatorDatabase({
      environment,
      namespace: parsed.target,
      selector: parsed.telemetryUrlEnv,
      role: "source",
    });
  } catch (error) {
    throw new CustomerUsageOperatorError(
      error instanceof Customer360OperatorGuardError ? error.message : "Database selection failed.",
    );
  }
  if (!createPool) {
    const { Pool } = await loadOperatorPackage("pg");
    createPool = (poolOptions) => new Pool(poolOptions);
  }
  const targetPool = createPool(authenticatedPostgresPoolOptions(targetDescriptor.connectionString));
  const telemetryPool = createPool(authenticatedPostgresPoolOptions(
    sourceDescriptor.connectionString, { readOnly: true },
  ));
  let targetAttestation;
  let sourceAttestation;
  try {
    targetAttestation = await connectAndFingerprintOperatorDatabase({
      pool: targetPool,
      descriptor: targetDescriptor,
      namespace: parsed.target,
      operation: CUSTOMER_USAGE_SYNC_OPERATION,
    });
    targetAttestation.client.release();
    sourceAttestation = await connectAndFingerprintOperatorDatabase({
      pool: telemetryPool,
      descriptor: sourceDescriptor,
      namespace: parsed.target,
      operation: CUSTOMER_USAGE_SYNC_OPERATION,
      role: "source",
    });
    sourceAttestation.client.release();
    rejectConnectedCollision(sourceAttestation.fingerprint, targetAttestation.fingerprint);
    if (parsed.status) {
      return Object.freeze({
        ...planned,
        connected: true,
        targetFingerprint: targetAttestation.fingerprint,
        sourceFingerprint: sourceAttestation.fingerprint,
        writes: 0,
      });
    }
    requireProductionConfirmations({
      namespace: parsed.target,
      operation: CUSTOMER_USAGE_SYNC_OPERATION,
      expectedConfirmation: PRODUCTION_CONFIRMATION,
      fingerprint: targetAttestation.fingerprint,
      confirmOperation: parsed.confirmProduction,
      confirmTarget: parsed.confirmTarget,
    });
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
    return Object.freeze({
      ...planned,
      connected: true,
      targetFingerprint: targetAttestation.fingerprint,
      sourceFingerprint: sourceAttestation.fingerprint,
      freshness,
      summary,
    });
  } catch (error) {
    if (error instanceof CustomerUsageOperatorError) throw error;
    if (error instanceof Customer360OperatorGuardError) {
      throw new CustomerUsageOperatorError(error.message);
    }
    throw new CustomerUsageOperatorError("Customer usage sync operation failed.");
  } finally {
    await Promise.allSettled([targetPool.end(), telemetryPool.end()]);
  }
}

let customerUsageRuntimePromise;
export function loadCustomerUsageRuntime() {
  customerUsageRuntimePromise ||= (async () => {
    const ts = await loadOperatorPackage("typescript");
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
  node scripts/sync-customer-usage.mjs --status --target test|production
  node scripts/sync-customer-usage.mjs --apply --target test --batch-size 250
  node scripts/sync-customer-usage.mjs --apply --target production \\
    --confirm-operation ${PRODUCTION_CONFIRMATION} --confirm-target pg-...

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
    console.error(safeOperatorCliError(error, "Customer usage sync failed."));
    process.exitCode = 1;
  });
}

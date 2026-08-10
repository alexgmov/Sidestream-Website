#!/usr/bin/env node

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import {
  Customer360OperatorGuardError,
  authenticatedOperatorPoolOptions,
  connectAndFingerprintOperatorDatabase,
  exactTargetSelector,
  loadOperatorPackage,
  resolveOperatorDatabase,
} from "./customer-360-operator-guards.mjs";

export const REPAIR_CONFIRMATION = "RECONCILE_ONE_PAID_TELEMETRY_HANDOFF";
export const REPAIR_OPERATION = "paid_telemetry_handoff_repair";

const RUNTIME_OR_SOURCE_SELECTORS = Object.freeze([
  "SIDESTREAM_PRODUCTION_POSTGRES_URL",
  "SIDESTREAM_PRODUCTION_POSTGRES_PRISMA_URL",
  "SIDESTREAM_POSTGRES_URL",
  "SIDESTREAM_POSTGRES_PRISMA_URL",
  "SIDESTREAM_PREVIEW_POSTGRES_URL",
  "SIDESTREAM_DEPLOYED_TEST_POSTGRES_URL",
  "SIDESTREAM_TEST_RUNTIME_POSTGRES_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
  "SIDESTREAM_TELEMETRY_POSTGRES_URL",
  "TELEMETRY_POSTGRES_URL",
]);

export class PaidTelemetryRepairCliError extends Error {
  constructor(message) {
    super(message);
    this.name = "PaidTelemetryRepairCliError";
  }
}

export function parsePaidTelemetryRepairArgs(argv) {
  const options = {
    apply: false,
    dryRun: true,
    acquisitionId: "",
    namespace: "",
    targetUrlEnv: "",
    confirmOperation: "",
    confirmNamespace: "",
    confirmTarget: "",
    confirmJourney: "",
    selfTest: false,
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
    } else if (argument === "--self-test") {
      options.selfTest = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (hasOption(argument, "--acquisition")) {
      [options.acquisitionId, index] = readOption(argv, index, "--acquisition");
    } else if (hasOption(argument, "--namespace")) {
      [options.namespace, index] = readOption(argv, index, "--namespace");
    } else if (hasOption(argument, "--target-url-env")) {
      [options.targetUrlEnv, index] = readOption(argv, index, "--target-url-env");
    } else if (hasOption(argument, "--confirm-operation")) {
      [options.confirmOperation, index] = readOption(argv, index, "--confirm-operation");
    } else if (hasOption(argument, "--confirm-namespace")) {
      [options.confirmNamespace, index] = readOption(argv, index, "--confirm-namespace");
    } else if (hasOption(argument, "--confirm-target")) {
      [options.confirmTarget, index] = readOption(argv, index, "--confirm-target");
    } else if (hasOption(argument, "--confirm-journey")) {
      [options.confirmJourney, index] = readOption(argv, index, "--confirm-journey");
    } else {
      throw new PaidTelemetryRepairCliError("Unknown option.");
    }
  }
  if (options.apply && sawDryRun) {
    throw new PaidTelemetryRepairCliError("Choose exactly one of --dry-run or --apply.");
  }
  if (options.selfTest || options.help) {
    const extra = Object.entries(options).some(([key, value]) =>
      !["selfTest", "help", "dryRun", "apply"].includes(key) && Boolean(value));
    if (options.apply || sawDryRun || extra || (options.selfTest && options.help)) {
      throw new PaidTelemetryRepairCliError("Self-test and help must run without repair options.");
    }
    return Object.freeze(options);
  }
  if (!options.acquisitionId) {
    throw new PaidTelemetryRepairCliError("One canonical --acquisition UUID is required.");
  }
  if (!options.namespace || !["test", "production"].includes(options.namespace)) {
    throw new PaidTelemetryRepairCliError("--namespace must be exactly test or production.");
  }
  const expectedSelector = exactTargetSelector(options.namespace);
  if (options.targetUrlEnv !== expectedSelector) {
    throw new PaidTelemetryRepairCliError(
      `--target-url-env must be exactly ${expectedSelector}.`,
    );
  }
  if (options.apply) {
    if (options.confirmOperation !== REPAIR_CONFIRMATION) {
      throw new PaidTelemetryRepairCliError(
        `Apply requires --confirm-operation ${REPAIR_CONFIRMATION}.`,
      );
    }
    if (options.confirmNamespace !== options.namespace) {
      throw new PaidTelemetryRepairCliError(
        "Apply requires --confirm-namespace matching the selected namespace.",
      );
    }
    if (!/^pg-[0-9a-f]{20}$/.test(options.confirmTarget)) {
      throw new PaidTelemetryRepairCliError(
        "Apply requires the exact sanitized target fingerprint emitted by dry-run.",
      );
    }
    if (!/^journey-[0-9a-f]{32}$/.test(options.confirmJourney)) {
      throw new PaidTelemetryRepairCliError(
        "Apply requires the exact single-journey fingerprint emitted by dry-run.",
      );
    }
  } else if (
    options.confirmOperation || options.confirmNamespace ||
    options.confirmTarget || options.confirmJourney
  ) {
    throw new PaidTelemetryRepairCliError(
      "Confirmation options are accepted only together with --apply.",
    );
  }
  return Object.freeze(options);
}

export function assertNonPooledDirectRepairUrl(
  connectionString,
  { requireTls = false } = {},
) {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new PaidTelemetryRepairCliError("The selected repair URL is invalid.");
  }
  const hostname = parsed.hostname.toLowerCase();
  const sslMode = (parsed.searchParams.get("sslmode") || "").toLowerCase();
  const local = ["localhost", "127.0.0.1", "::1"].includes(hostname);
  if (
    hostname.includes("-pooler.") || hostname.includes("-pool.") ||
    parsed.port === "6543" || parsed.searchParams.has("pgbouncer") ||
    parsed.searchParams.has("connection_limit")
  ) {
    throw new PaidTelemetryRepairCliError(
      "Repair refuses pooled and runtime Postgres endpoints.",
    );
  }
  if (!local && !["require", "verify-ca", "verify-full"].includes(sslMode)) {
    throw new PaidTelemetryRepairCliError(
      "Remote repair requires authenticated TLS on the direct Postgres URL.",
    );
  }
  if (requireTls && local) {
    throw new PaidTelemetryRepairCliError(
      "Apply requires an authenticated TLS direct Postgres endpoint.",
    );
  }
  return Object.freeze({
    hostname,
    port: parsed.port || "5432",
    database: decodeURIComponent(parsed.pathname.replace(/^\/+/, "")),
  });
}

export function assertRepairTargetSeparation(environment, targetDescriptor) {
  const target = selectedEndpoint(targetDescriptor.connectionString);
  for (const selector of RUNTIME_OR_SOURCE_SELECTORS) {
    const value = environment?.[selector]?.trim() || "";
    if (!value) continue;
    let compared;
    try {
      compared = selectedEndpoint(value);
    } catch {
      throw new PaidTelemetryRepairCliError(
        `Configured ${selector} cannot be safely compared with the repair target.`,
      );
    }
    if (
      compared.hostname === target.hostname && compared.port === target.port &&
      compared.database === target.database
    ) {
      throw new PaidTelemetryRepairCliError(
        "Repair target must be separate from configured runtime and telemetry selectors.",
      );
    }
  }
}

export async function runPaidTelemetryRepairOperator({
  options,
  environment = process.env,
  createPool = null,
  runtime = null,
} = {}) {
  const parsed = options || parsePaidTelemetryRepairArgs([]);
  const descriptor = resolveOperatorDatabase({
    environment,
    namespace: parsed.namespace,
    selector: parsed.targetUrlEnv,
  });
  assertNonPooledDirectRepairUrl(
    descriptor.connectionString,
    { requireTls: parsed.apply },
  );
  assertRepairTargetSeparation(environment, descriptor);
  if (!createPool) {
    const { Pool } = await loadOperatorPackage("pg");
    createPool = (poolOptions) => new Pool(poolOptions);
  }
  const pool = createPool(authenticatedOperatorPoolOptions(
    descriptor.connectionString,
    { readOnly: !parsed.apply },
  ));
  let client;
  try {
    const attestation = await connectAndFingerprintOperatorDatabase({
      pool,
      descriptor,
      namespace: parsed.namespace,
      operation: REPAIR_OPERATION,
    });
    client = attestation.client;
    if (parsed.apply && parsed.confirmTarget !== attestation.fingerprint) {
      throw new PaidTelemetryRepairCliError(
        "Apply target fingerprint does not match the connected database.",
      );
    }
    runtime ||= await loadPaidTelemetryRepairRuntime();
    await client.query(parsed.apply
      ? "begin isolation level serializable"
      : "begin isolation level repeatable read read only");
    try {
      const report = parsed.apply
        ? await runtime.applyPaidTelemetryHandoffRepair(client, {
            acquisitionId: parsed.acquisitionId,
            namespace: parsed.namespace,
            confirmJourney: parsed.confirmJourney,
          })
        : await runtime.inspectPaidTelemetryHandoffRepair(client, {
            acquisitionId: parsed.acquisitionId,
            namespace: parsed.namespace,
            lock: false,
          });
      if (parsed.apply) await client.query("commit");
      else await client.query("rollback");
      return Object.freeze({
        mode: parsed.apply ? "apply" : "dry_run",
        namespace: parsed.namespace,
        connected: true,
        targetFingerprint: attestation.fingerprint,
        ...report,
      });
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  } catch (error) {
    if (
      error instanceof PaidTelemetryRepairCliError ||
      error instanceof Customer360OperatorGuardError ||
      error?.name === "PaidTelemetryRepairError"
    ) {
      throw error;
    }
    throw new PaidTelemetryRepairCliError("Paid telemetry handoff repair failed closed.");
  } finally {
    client?.release();
    await pool.end();
  }
}

export async function loadPaidTelemetryRepairRuntime() {
  return import("../api/_lib/paid-telemetry-handoff-repair.ts");
}

export function runSelfTest() {
  const uuid = "71000000-0000-4000-8000-000000000001";
  const dryRun = parsePaidTelemetryRepairArgs([
    "--dry-run",
    "--acquisition", uuid,
    "--namespace", "test",
    "--target-url-env", "SIDESTREAM_TEST_POSTGRES_URL",
  ]);
  assert.equal(dryRun.apply, false);
  assert.equal(dryRun.dryRun, true);
  const apply = parsePaidTelemetryRepairArgs([
    "--apply",
    "--acquisition", uuid,
    "--namespace", "production",
    "--target-url-env", "SIDESTREAM_POSTGRES_URL_NON_POOLING",
    "--confirm-operation", REPAIR_CONFIRMATION,
    "--confirm-namespace", "production",
    "--confirm-target", `pg-${"a".repeat(20)}`,
    "--confirm-journey", `journey-${"b".repeat(32)}`,
  ]);
  assert.equal(apply.apply, true);
  assert.throws(
    () => parsePaidTelemetryRepairArgs([
      "--apply", "--acquisition", uuid, "--namespace", "test",
      "--target-url-env", "SIDESTREAM_TEST_POSTGRES_URL",
    ]),
    /confirm-operation/,
  );
  assert.throws(
    () => assertNonPooledDirectRepairUrl(
      "postgresql://user:secret@ep-safe-pooler.example.test/db?sslmode=require",
    ),
    /pooled/,
  );
  assert.throws(
    () => assertRepairTargetSeparation(
      { SIDESTREAM_POSTGRES_URL: "postgresql://u:p@db.example.test/x?sslmode=require" },
      { connectionString: "postgresql://u:p@db.example.test/x?sslmode=verify-full" },
    ),
    /separate/,
  );
  return true;
}

function selectedEndpoint(connectionString) {
  const parsed = new URL(connectionString);
  return {
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port || "5432",
    database: decodeURIComponent(parsed.pathname.replace(/^\/+/, "")),
  };
}

function hasOption(argument, name) {
  return argument === name || argument.startsWith(`${name}=`);
}

function readOption(argv, index, name) {
  const argument = argv[index];
  const inline = argument.startsWith(`${name}=`);
  const value = inline ? argument.slice(name.length + 1) : argv[index + 1];
  if (!value || (!inline && value.startsWith("--"))) {
    throw new PaidTelemetryRepairCliError(`${name} requires a value.`);
  }
  return [value, inline ? index : index + 1];
}

function usage() {
  return `Usage:
  npm run reconcile:paid-telemetry-handoff -- --dry-run \\
    --acquisition <canonical-uuid> --namespace test \\
    --target-url-env SIDESTREAM_TEST_POSTGRES_URL

  npm run reconcile:paid-telemetry-handoff -- --apply \\
    --acquisition <same-canonical-uuid> --namespace production \\
    --target-url-env SIDESTREAM_POSTGRES_URL_NON_POOLING \\
    --confirm-operation ${REPAIR_CONFIRMATION} \\
    --confirm-namespace production --confirm-target pg-... \\
    --confirm-journey journey-...

Dry-run is the default and is read-only. Selection accepts only the canonical
acquisition UUID plus trusted namespace. Apply requires both fingerprints and
all exact confirmations. The operator never accepts email, Stripe references,
receipts, activation keys, device values, or time ranges.`;
}

async function main() {
  const options = parsePaidTelemetryRepairArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.selfTest) {
    runSelfTest();
    console.log("paid-telemetry-handoff-repair-self-test: ok");
    return;
  }
  console.log(JSON.stringify(await runPaidTelemetryRepairOperator({ options })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const safe =
      error instanceof PaidTelemetryRepairCliError ||
      error instanceof Customer360OperatorGuardError ||
      error?.name === "PaidTelemetryRepairError"
        ? error.message
        : "Paid telemetry handoff repair failed closed.";
    console.error(safe);
    process.exitCode = 1;
  });
}

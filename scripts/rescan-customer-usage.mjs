#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CUSTOMER_USAGE_BATCH_SIZE,
  CUSTOMER_USAGE_OPERATOR_INVARIANTS,
  CustomerUsageOperatorError,
  PRODUCTION_CONFIRMATION,
  authenticatedPostgresPoolOptions,
  loadCustomerUsageRuntime,
  readCustomerUsageSourceFreshness,
} from "./sync-customer-usage.mjs";
import {
  CUSTOMER_360_DATABASE_SELECTORS,
  Customer360OperatorGuardError,
  connectAndFingerprintOperatorDatabase,
  exactTargetSelector,
  loadOperatorPackage,
  rejectConnectedCollision,
  requireProductionConfirmations,
  resolveOperatorDatabase,
  safeOperatorCliError,
  writeMode600JsonAtomic,
} from "./customer-360-operator-guards.mjs";

export const RESCAN_CHECKPOINT_VERSION = 1;
export const REPLAY_CONFIRMATION = "REPLAY_SESSION_STARTED_AGGREGATES";
export const CUSTOMER_USAGE_RESCAN_OPERATION = "customer_usage_historical_rescan";

export function parseCustomerUsageRescanArgs(argv) {
  const options = {
    apply: false,
    dryRun: true,
    status: false,
    target: "",
    targetUrlEnv: "",
    telemetryUrlEnv: "SIDESTREAM_TELEMETRY_POSTGRES_URL",
    checkpointPath: "",
    confirmProduction: "",
    confirmTarget: "",
    replay: false,
    confirmReplay: "",
    batchSize: CUSTOMER_USAGE_BATCH_SIZE,
    maxBatches: 100,
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
    } else if (argument === "--replay") {
      options.replay = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (hasOption(argument, "--target")) {
      [options.target, index] = readOption(argv, index, "--target");
    } else if (hasOption(argument, "--target-url-env")) {
      [options.targetUrlEnv, index] = readOption(argv, index, "--target-url-env");
    } else if (hasOption(argument, "--telemetry-url-env")) {
      [options.telemetryUrlEnv, index] = readOption(argv, index, "--telemetry-url-env");
    } else if (hasOption(argument, "--checkpoint")) {
      [options.checkpointPath, index] = readOption(argv, index, "--checkpoint");
    } else if (hasOption(argument, "--confirm-production")) {
      [options.confirmProduction, index] = readOption(argv, index, "--confirm-production");
    } else if (hasOption(argument, "--confirm-operation")) {
      [options.confirmProduction, index] = readOption(argv, index, "--confirm-operation");
    } else if (hasOption(argument, "--confirm-target")) {
      [options.confirmTarget, index] = readOption(argv, index, "--confirm-target");
    } else if (hasOption(argument, "--confirm-replay")) {
      [options.confirmReplay, index] = readOption(argv, index, "--confirm-replay");
    } else if (hasOption(argument, "--batch-size")) {
      let raw;
      [raw, index] = readOption(argv, index, "--batch-size");
      options.batchSize = boundedInteger(raw, 25, 1_000, "batch size");
    } else if (hasOption(argument, "--max-batches")) {
      let raw;
      [raw, index] = readOption(argv, index, "--max-batches");
      options.maxBatches = boundedInteger(raw, 1, 10_000, "max batches");
    } else if (hasOption(argument, "--max-source-lag-hours")) {
      let raw;
      [raw, index] = readOption(argv, index, "--max-source-lag-hours");
      options.maxSourceLagHours = boundedInteger(raw, 1, 24 * 30, "source freshness hours");
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
  if (options.apply && (!options.target || !options.checkpointPath)) {
    throw new CustomerUsageOperatorError(
      "Apply requires explicit --target and --checkpoint values.",
    );
  }
  if (options.status && !options.target) {
    throw new CustomerUsageOperatorError("Status requires an explicit --target.");
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
      "Usage rescan may use only SIDESTREAM_TELEMETRY_POSTGRES_URL as its source.",
    );
  }
  if (options.replay && options.confirmReplay !== REPLAY_CONFIRMATION) {
    throw new CustomerUsageOperatorError(
      `Replay requires --confirm-replay ${REPLAY_CONFIRMATION}.`,
    );
  }
  return Object.freeze(options);
}

export function normalizeRescanCheckpoint(
  value,
  { target, targetFingerprint, sourceFingerprint },
) {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "object" ||
    value.version !== RESCAN_CHECKPOINT_VERSION ||
    value.target !== target ||
    value.targetFingerprint !== targetFingerprint ||
    value.sourceFingerprint !== sourceFingerprint ||
    typeof value.complete !== "boolean" ||
    !value.next ||
    typeof value.next.receivedAt !== "string" ||
    typeof value.next.telemetryEventId !== "string" ||
    !Number.isFinite(Date.parse(value.next.receivedAt)) ||
    !value.next.telemetryEventId ||
    value.next.telemetryEventId.length > 200
  ) {
    throw new CustomerUsageOperatorError(
      "Checkpoint does not match the exact target, source, or rescan version.",
    );
  }
  return Object.freeze({
    version: RESCAN_CHECKPOINT_VERSION,
    target,
    targetFingerprint,
    sourceFingerprint,
    complete: value.complete,
    next: Object.freeze({
      receivedAt: new Date(value.next.receivedAt).toISOString(),
      telemetryEventId: value.next.telemetryEventId,
    }),
  });
}

export async function runCustomerUsageRescanOperator({
  options,
  checkpoint = null,
  environment = process.env,
  now = new Date(),
  createPool = null,
  runRescan = null,
  writeCheckpoint = async () => {},
} = {}) {
  const parsed = options || parseCustomerUsageRescanArgs([]);
  const planned = {
    mode: parsed.apply ? "apply" : parsed.status ? "status" : "dry_run",
    operation: "full_historical_session_started_rescan",
    target: parsed.target || null,
    targetFingerprint: null,
    sourceFingerprint: null,
    batchSize: parsed.batchSize,
    maxBatches: parsed.maxBatches,
    replay: parsed.replay,
    invariants: CUSTOMER_USAGE_OPERATOR_INVARIANTS,
  };
  if (parsed.dryRun) {
    return Object.freeze({ ...planned, connected: false, checkpointWrites: 0, writes: 0 });
  }
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
  let checkpointWrites = 0;
  try {
    const targetAttestation = await connectAndFingerprintOperatorDatabase({
      pool: targetPool,
      descriptor: targetDescriptor,
      namespace: parsed.target,
      operation: CUSTOMER_USAGE_RESCAN_OPERATION,
    });
    targetAttestation.client.release();
    const sourceAttestation = await connectAndFingerprintOperatorDatabase({
      pool: telemetryPool,
      descriptor: sourceDescriptor,
      namespace: parsed.target,
      operation: CUSTOMER_USAGE_RESCAN_OPERATION,
      role: "source",
    });
    sourceAttestation.client.release();
    const targetFingerprint = targetAttestation.fingerprint;
    const sourceFingerprint = sourceAttestation.fingerprint;
    rejectConnectedCollision(sourceFingerprint, targetFingerprint);
    if (parsed.status) {
      return Object.freeze({
        ...planned,
        connected: true,
        targetFingerprint,
        sourceFingerprint,
        checkpointWrites: 0,
        writes: 0,
      });
    }
    requireProductionConfirmations({
      namespace: parsed.target,
      operation: CUSTOMER_USAGE_RESCAN_OPERATION,
      expectedConfirmation: PRODUCTION_CONFIRMATION,
      fingerprint: targetFingerprint,
      confirmOperation: parsed.confirmProduction,
      confirmTarget: parsed.confirmTarget,
    });
    const normalized = normalizeRescanCheckpoint(checkpoint, {
      target: parsed.target,
      targetFingerprint,
      sourceFingerprint,
    });
    if (normalized?.complete && !parsed.replay) {
      return Object.freeze({
        ...planned,
        connected: true,
        targetFingerprint,
        sourceFingerprint,
        checkpoint: normalized,
        complete: true,
      });
    }
    const startingCheckpoint = parsed.replay ? null : normalized?.next || null;
    const freshness = await readCustomerUsageSourceFreshness({
      telemetryPool,
      target: parsed.target,
      now,
      maxSourceLagHours: parsed.maxSourceLagHours,
    });
    const persist = async (next, complete = false) => {
      const nextCheckpoint = Object.freeze({
        version: RESCAN_CHECKPOINT_VERSION,
        target: parsed.target,
        targetFingerprint,
        sourceFingerprint,
        complete,
        next: Object.freeze({
          receivedAt: next.receivedAt instanceof Date
            ? next.receivedAt.toISOString()
            : new Date(next.receivedAt).toISOString(),
          telemetryEventId: next.telemetryEventId,
        }),
      });
      await writeCheckpoint(nextCheckpoint);
      checkpointWrites += 1;
      return nextCheckpoint;
    };
    const rescan = runRescan ||
      (await loadCustomerUsageRuntime()).runCustomerUsageSessionRescan;
    const summary = await rescan({
      targetPool,
      telemetryPool,
      licenseNamespace: parsed.target,
      checkpoint: startingCheckpoint ? {
        receivedAt: new Date(startingCheckpoint.receivedAt),
        telemetryEventId: startingCheckpoint.telemetryEventId,
      } : null,
      batchSize: parsed.batchSize,
      maxBatches: parsed.maxBatches,
      now,
      afterBatchCommitted: ({ checkpoint: next }) => persist(next, false),
    });
    let finalCheckpoint = null;
    if (summary.checkpoint) {
      finalCheckpoint = await persist(summary.checkpoint, summary.complete);
    }
    return Object.freeze({
      ...planned,
      connected: true,
      targetFingerprint,
      sourceFingerprint,
      freshness,
      checkpointWrites,
      checkpoint: finalCheckpoint,
      summary,
    });
  } catch (error) {
    if (error instanceof CustomerUsageOperatorError) throw error;
    if (error instanceof Customer360OperatorGuardError) {
      throw new CustomerUsageOperatorError(error.message);
    }
    throw new CustomerUsageOperatorError("Customer usage rescan operation failed.");
  } finally {
    await Promise.allSettled([targetPool.end(), telemetryPool.end()]);
  }
}

async function readCheckpointFile(filename) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new CustomerUsageOperatorError(`Unable to read checkpoint ${path.basename(filename)}.`);
  }
}

async function writeCheckpointFile(filename, checkpoint) {
  await writeMode600JsonAtomic(filename, checkpoint);
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
  node scripts/rescan-customer-usage.mjs --dry-run --target test
  node scripts/rescan-customer-usage.mjs --status --target test|production
  node scripts/rescan-customer-usage.mjs --apply --target test --checkpoint FILE
  node scripts/rescan-customer-usage.mjs --apply --target production --checkpoint FILE \\
    --confirm-operation ${PRODUCTION_CONFIRMATION} --confirm-target pg-...

Use --replay --confirm-replay ${REPLAY_CONFIRMATION} to deliberately replay
from the beginning. Replays are idempotent aggregate upserts and never delete.`;
}

async function main() {
  const options = parseCustomerUsageRescanArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const checkpoint = options.checkpointPath
    ? await readCheckpointFile(options.checkpointPath)
    : null;
  const report = await runCustomerUsageRescanOperator({
    options,
    checkpoint,
    writeCheckpoint: (next) => writeCheckpointFile(options.checkpointPath, next),
  });
  console.log(JSON.stringify(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(safeOperatorCliError(error, "Customer usage rescan failed."));
    process.exitCode = 1;
  });
}

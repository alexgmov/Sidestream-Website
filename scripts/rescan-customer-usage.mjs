#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { requireSafeTestDatabaseUrl } from "./run-postgres-integration.mjs";
import {
  CUSTOMER_USAGE_BATCH_SIZE,
  CUSTOMER_USAGE_OPERATOR_INVARIANTS,
  CustomerUsageOperatorError,
  PRODUCTION_CONFIRMATION,
  authenticatedPostgresPoolOptions,
  loadCustomerUsageRuntime,
  readCustomerUsageSourceFreshness,
  sanitizedTargetFingerprint,
} from "./sync-customer-usage.mjs";

export const RESCAN_CHECKPOINT_VERSION = 1;
export const REPLAY_CONFIRMATION = "REPLAY_SESSION_STARTED_AGGREGATES";

export function parseCustomerUsageRescanArgs(argv) {
  const options = {
    apply: false,
    dryRun: true,
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
  if (options.apply && sawDryRun) {
    throw new CustomerUsageOperatorError("Choose either --apply or --dry-run.");
  }
  if (options.target && !["test", "production"].includes(options.target)) {
    throw new CustomerUsageOperatorError("--target must be test or production.");
  }
  if (options.apply && (!options.target || !options.checkpointPath)) {
    throw new CustomerUsageOperatorError(
      "Apply requires explicit --target and --checkpoint values.",
    );
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
  createPool = (poolOptions) => new Pool(poolOptions),
  runRescan = null,
  writeCheckpoint = async () => {},
} = {}) {
  const parsed = options || parseCustomerUsageRescanArgs([]);
  const targetUrl = parsed.targetUrlEnv ? environment[parsed.targetUrlEnv] : "";
  const telemetryUrl = environment[parsed.telemetryUrlEnv];
  const targetFingerprint = targetUrl ? sanitizedTargetFingerprint(targetUrl) : null;
  const sourceFingerprint = telemetryUrl ? sanitizedTargetFingerprint(telemetryUrl) : null;
  const planned = {
    mode: parsed.apply ? "apply" : "dry_run",
    operation: "full_historical_session_started_rescan",
    target: parsed.target || null,
    targetFingerprint,
    sourceFingerprint,
    batchSize: parsed.batchSize,
    maxBatches: parsed.maxBatches,
    replay: parsed.replay,
    invariants: CUSTOMER_USAGE_OPERATOR_INVARIANTS,
  };
  if (!parsed.apply) {
    return Object.freeze({ ...planned, connected: false, checkpointWrites: 0, writes: 0 });
  }
  if (!targetUrl || !telemetryUrl) {
    throw new CustomerUsageOperatorError("Required Postgres environment selector is not configured.");
  }
  if (parsed.target === "test") requireSafeTestDatabaseUrl(environment);
  if (parsed.target === "production" && parsed.confirmTarget !== targetFingerprint) {
    throw new CustomerUsageOperatorError("Production target fingerprint confirmation does not match.");
  }
  if (sourceFingerprint === targetFingerprint) {
    throw new CustomerUsageOperatorError("Telemetry source and aggregate target must be separate.");
  }
  const normalized = normalizeRescanCheckpoint(checkpoint, {
    target: parsed.target,
    targetFingerprint,
    sourceFingerprint,
  });
  if (normalized?.complete && !parsed.replay) {
    return Object.freeze({ ...planned, connected: false, checkpoint: normalized, complete: true });
  }
  const startingCheckpoint = parsed.replay ? null : normalized?.next || null;
  const targetPool = createPool(authenticatedPostgresPoolOptions(targetUrl));
  const telemetryPool = createPool(authenticatedPostgresPoolOptions(
    telemetryUrl,
    { readOnly: true },
  ));
  let checkpointWrites = 0;
  try {
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
      freshness,
      checkpointWrites,
      checkpoint: finalCheckpoint,
      summary,
    });
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
  const temporary = `${filename}.tmp`;
  await writeFile(temporary, `${JSON.stringify(checkpoint)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, filename);
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
  node scripts/rescan-customer-usage.mjs --apply --target test --checkpoint FILE
  node scripts/rescan-customer-usage.mjs --apply --target production --checkpoint FILE \\
    --confirm-production ${PRODUCTION_CONFIRMATION} --confirm-target pg-...

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
    console.error(error instanceof CustomerUsageOperatorError ? error.message : "Customer usage rescan failed.");
    process.exitCode = 1;
  });
}

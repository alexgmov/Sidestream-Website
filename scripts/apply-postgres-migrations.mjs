import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  Customer360OperatorGuardError,
  authenticatedOperatorPoolOptions,
  connectAndFingerprintOperatorDatabase,
  connectedDatabaseFingerprint,
  exactTargetSelector,
  loadOperatorPackage,
  requireProductionConfirmations,
  resolveOperatorDatabase,
  safeOperatorCliError,
} from "./customer-360-operator-guards.mjs";
import {
  ACTIVATION_ROTATION_MIGRATION,
  KNOWN_PRE_20260713_MIGRATION_CHECKSUMS,
  formatMigrationBaselineVerification,
  verifyKnownPre20260713Schema,
} from "./verify-migration-baseline.mjs";

const MIGRATIONS_DIRECTORY = path.resolve("db/migrations");
const MIGRATION_FILENAME_PATTERN = /^\d{14}_[a-z0-9_]+\.sql$/;
const OPERATIONAL_MIGRATION = "20260713200000_add_api_operational_controls.sql";
const MIGRATION_LEDGER = "public.sidestream_schema_migrations";
const MIGRATION_LOCK_KEY = "sidestream:schema-migrations:v1";
export const MIGRATION_OPERATION = "postgres_migration_apply";
export const MIGRATION_BASELINE_OPERATION = "postgres_migration_baseline";
export const MIGRATION_STATUS_OPERATION = "postgres_migration_status";
export const MIGRATION_PRODUCTION_CONFIRMATION = "APPLY_PRODUCTION_POSTGRES_MIGRATIONS";
export const MIGRATION_BASELINE_PRODUCTION_CONFIRMATION =
  "BASELINE_PRODUCTION_POSTGRES_MIGRATIONS";

const CREATE_LEDGER_SQL = `
  create table if not exists ${MIGRATION_LEDGER} (
    filename text primary key,
    checksum_sha256 text not null,
    applied_at timestamptz not null default now(),
    duration_ms bigint not null,
    constraint sidestream_schema_migrations_filename_valid check (
      filename ~ '^[0-9]{14}_[a-z0-9_]+\\.sql$'
    ),
    constraint sidestream_schema_migrations_checksum_valid check (
      checksum_sha256 ~ '^[0-9a-f]{64}$'
    ),
    constraint sidestream_schema_migrations_duration_valid check (duration_ms >= 0)
  )
`;

export async function loadMigrationFiles(directory = MIGRATIONS_DIRECTORY) {
  const filenames = (await readdir(directory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  return Promise.all(filenames.map(async (filename) => {
    const sql = await readFile(path.join(directory, filename), "utf8");
    return Object.freeze({
      filename,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }));
}

export function validateMigrationFiles(migrations) {
  if (migrations.length === 0) throw new Error("No Postgres migrations found");
  const timestamps = new Set();
  for (const migration of migrations) {
    if (!MIGRATION_FILENAME_PATTERN.test(migration.filename)) {
      throw new Error(`Invalid migration filename: ${migration.filename}`);
    }
    const timestamp = migration.filename.slice(0, 14);
    if (timestamps.has(timestamp)) {
      throw new Error(`Duplicate migration timestamp: ${timestamp}`);
    }
    timestamps.add(timestamp);
    if (!migration.sql.trim()) throw new Error(`Migration is empty: ${migration.filename}`);
    if (/create\s+(?:unique\s+)?index\s+concurrently/i.test(migration.sql)) {
      throw new Error(`Migration cannot run transactionally: ${migration.filename}`);
    }
    if (!/^[0-9a-f]{64}$/.test(migration.checksum)) {
      throw new Error(`Invalid SHA-256 checksum: ${migration.filename}`);
    }
  }

  const filenames = migrations.map((migration) => migration.filename);
  for (const required of [ACTIVATION_ROTATION_MIGRATION, OPERATIONAL_MIGRATION]) {
    if (!filenames.includes(required)) throw new Error(`Required migration is missing: ${required}`);
  }
  for (const [filename, expectedChecksum] of Object.entries(
    KNOWN_PRE_20260713_MIGRATION_CHECKSUMS,
  )) {
    const migration = migrations.find((candidate) => candidate.filename === filename);
    if (!migration) throw new Error(`Known baseline migration is missing: ${filename}`);
    if (migration.checksum !== expectedChecksum) {
      throw new Error(`Known baseline migration checksum drift: ${filename}`);
    }
  }
  return migrations;
}

export function classifyMigrationState(migrations, ledgerRows) {
  const migrationsByName = new Map(migrations.map((migration) => [
    migration.filename,
    migration,
  ]));
  const ledgerByName = new Map();
  for (const row of ledgerRows) {
    const filename = String(row.filename);
    if (ledgerByName.has(filename)) throw new Error(`Duplicate migration ledger row: ${filename}`);
    const migration = migrationsByName.get(filename);
    if (!migration) throw new Error(`Migration ledger references a missing file: ${filename}`);
    const checksum = String(row.checksum_sha256);
    if (checksum !== migration.checksum) {
      throw new Error(`Migration checksum drift detected: ${filename}`);
    }
    ledgerByName.set(filename, row);
  }
  return migrations.map((migration) => Object.freeze({
    ...migration,
    status: ledgerByName.has(migration.filename) ? "applied" : "pending",
    ledger: ledgerByName.get(migration.filename) || null,
  }));
}

export function migrationSqlForTransaction(sql) {
  const trimmed = sql.trim();
  const wrapped = /^begin\s*;\s*([\s\S]*?)\s*commit\s*;$/i.exec(trimmed);
  return wrapped ? `${wrapped[1].trim()}\n` : sql;
}

export function selectMigrationDatabase(
  environment = process.env,
  target = "",
  selector = target ? exactTargetSelector(target) : "",
) {
  if (!target) return null;
  const descriptor = resolveOperatorDatabase({
    environment,
    namespace: target,
    selector,
  });
  return Object.freeze({
    environmentVariable: descriptor.selector,
    connectionString: descriptor.connectionString,
    direct: target === "production",
    descriptor,
  });
}

export function parseMigrationOperatorArguments(argv) {
  const valueOptions = new Set([
    "--target", "--target-url-env", "--confirm-operation", "--confirm-target",
  ]);
  const core = [];
  const options = {
    target: "",
    targetUrlEnv: "",
    confirmOperation: "",
    confirmTarget: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const name = [...valueOptions].find(
      (candidate) => argument === candidate || argument.startsWith(`${candidate}=`),
    );
    if (!name) {
      core.push(argument);
      continue;
    }
    const inline = argument.startsWith(`${name}=`);
    const value = inline ? argument.slice(name.length + 1) : argv[index + 1];
    if (!value || (!inline && value.startsWith("--"))) {
      throw new Error(`${name} requires a value`);
    }
    if (!inline) index += 1;
    if (name === "--target") options.target = value;
    if (name === "--target-url-env") options.targetUrlEnv = value;
    if (name === "--confirm-operation") options.confirmOperation = value;
    if (name === "--confirm-target") options.confirmTarget = value;
  }
  const mode = parseMigrationArguments(core);
  if (options.target && !["test", "production"].includes(options.target)) {
    throw new Error("--target must be test or production");
  }
  if (!["help", "validate", "dry-run"].includes(mode) && !options.target) {
    throw new Error("Connected migration operations require an explicit --target");
  }
  if (options.target) {
    options.targetUrlEnv ||= exactTargetSelector(options.target);
    if (options.targetUrlEnv !== exactTargetSelector(options.target)) {
      throw new Error(
        `Migration target may use only ${exactTargetSelector(options.target)}`,
      );
    }
  }
  const confirmation = mode === "baseline"
    ? MIGRATION_BASELINE_PRODUCTION_CONFIRMATION
    : MIGRATION_PRODUCTION_CONFIRMATION;
  if (
    options.target === "production" && ["apply", "baseline"].includes(mode) &&
    options.confirmOperation !== confirmation
  ) {
    throw new Error(`Production ${mode} requires --confirm-operation ${confirmation}`);
  }
  if (
    options.target === "production" && ["apply", "baseline"].includes(mode) &&
    !options.confirmTarget
  ) {
    throw new Error(`Production ${mode} requires the connected --confirm-target fingerprint`);
  }
  return Object.freeze({ ...options, mode });
}

export function parseMigrationArguments(argv) {
  const supported = new Set([
    "--baseline", "--dry-run", "--help", "--status", "--validate",
  ]);
  const unknown = argv.filter((argument) => !supported.has(argument));
  if (unknown.length) throw new Error(`Unknown migration option: ${unknown.join(", ")}`);
  const modes = ["--baseline", "--dry-run", "--status", "--validate"]
    .filter((option) => argv.includes(option));
  if (modes.length > 1) throw new Error(`Choose only one migration operation: ${modes.join(", ")}`);
  if (argv.includes("--help")) return "help";
  if (argv.includes("--baseline")) return "baseline";
  if (argv.includes("--dry-run")) return "dry-run";
  if (argv.includes("--status")) return "status";
  if (argv.includes("--validate")) return "validate";
  return "apply";
}

async function main() {
  const operator = parseMigrationOperatorArguments(process.argv.slice(2));
  const { mode } = operator;
  if (mode === "help") {
    printHelp();
    return;
  }

  const migrations = validateMigrationFiles(await loadMigrationFiles());
  if (mode === "validate") {
    console.log(`Validated ${migrations.length} ordered migration files and SHA-256 checksums.`);
    console.log(`pending-contract: ${ACTIVATION_ROTATION_MIGRATION}`);
    return;
  }
  if (mode === "dry-run") {
    for (const migration of migrations) console.log(`[dry-run] pending-check: ${migration.filename}`);
    return;
  }

  const target = selectMigrationDatabase(
    process.env,
    operator.target,
    operator.targetUrlEnv,
  );
  if (!target) {
    throw new Error("Missing exact named Postgres target selector");
  }
  const { Pool } = await loadOperatorPackage("pg");
  const pool = new Pool(createMigrationPoolOptions(target.connectionString));
  const operation = mode === "status"
    ? MIGRATION_STATUS_OPERATION
    : mode === "baseline"
      ? MIGRATION_BASELINE_OPERATION
      : MIGRATION_OPERATION;
  const attestation = await connectAndFingerprintOperatorDatabase({
    pool,
    descriptor: target.descriptor,
    namespace: operator.target,
    operation,
  });
  const { client } = attestation;
  if (["apply", "baseline"].includes(mode)) {
    requireProductionConfirmations({
      namespace: operator.target,
      operation,
      expectedConfirmation: mode === "baseline"
        ? MIGRATION_BASELINE_PRODUCTION_CONFIRMATION
        : MIGRATION_PRODUCTION_CONFIRMATION,
      fingerprint: attestation.fingerprint,
      confirmOperation: operator.confirmOperation,
      confirmTarget: operator.confirmTarget,
    });
  }
  console.log(`target-fingerprint: ${attestation.fingerprint}`);
  if (mode === "status") {
    console.log(`apply-target-fingerprint: ${connectedDatabaseFingerprint({
      hostname: target.descriptor.hostname,
      port: target.descriptor.port,
      databaseName: attestation.databaseName,
      namespace: operator.target,
      operation: MIGRATION_OPERATION,
    })}`);
    console.log(`baseline-target-fingerprint: ${connectedDatabaseFingerprint({
      hostname: target.descriptor.hostname,
      port: target.descriptor.port,
      databaseName: attestation.databaseName,
      namespace: operator.target,
      operation: MIGRATION_BASELINE_OPERATION,
    })}`);
  }
  let lockHeld = false;
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);
    lockHeld = true;
    if (mode === "status") {
      await reportStatus(client, migrations);
    } else if (mode === "baseline") {
      await baselineKnownSchema(client, migrations);
    } else {
      await applyPendingMigrations(client, migrations);
    }
  } finally {
    if (lockHeld) {
      try {
        await client.query("select pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK_KEY]);
      } catch {
        // Releasing the client also releases its session-level advisory lock.
      }
    }
    client.release();
    await pool.end();
  }
}

async function reportStatus(client, migrations) {
  if (!(await migrationLedgerExists(client))) {
    if (!(await hasSidestreamProductSchema(client))) {
      console.log("Migration ledger: missing (empty Sidestream schema)");
      printStatuses(migrations.map((migration) => ({ ...migration, status: "pending" })));
      return;
    }
    const verification = await verifyKnownPre20260713Schema(client);
    console.log("Migration ledger: missing; explicit --baseline required");
    console.log(formatMigrationBaselineVerification(verification));
    const applied = new Set(verification.appliedMigrations);
    printStatuses(migrations.map((migration) => ({
      ...migration,
      status: applied.has(migration.filename) ? "untracked-baseline" : "pending",
    })));
    return;
  }

  await validateMigrationLedgerShape(client);
  const statuses = classifyMigrationState(migrations, await readMigrationLedger(client));
  printStatuses(statuses);
}

async function applyPendingMigrations(client, migrations) {
  const ledgerExists = await migrationLedgerExists(client);
  const productSchemaExists = await hasSidestreamProductSchema(client);
  if (!ledgerExists) {
    if (productSchemaExists) {
      throw new Error(
        "Existing Sidestream schema has no migration ledger; run --status, then explicit --baseline",
      );
    }
    await createMigrationLedger(client);
  } else {
    await validateMigrationLedgerShape(client);
  }

  const ledgerRows = await readMigrationLedger(client);
  if (ledgerRows.length === 0 && productSchemaExists) {
    throw new Error(
      "Existing Sidestream schema has an empty migration ledger; explicit --baseline is required",
    );
  }
  const statuses = classifyMigrationState(migrations, ledgerRows);
  for (const migration of statuses.filter((candidate) => candidate.status === "pending")) {
    const startedAt = process.hrtime.bigint();
    await client.query("begin");
    try {
      await client.query(migrationSqlForTransaction(migration.sql));
      const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
      await client.query(
        `
          insert into ${MIGRATION_LEDGER} (
            filename, checksum_sha256, applied_at, duration_ms
          ) values ($1, $2, now(), $3)
        `,
        [migration.filename, migration.checksum, durationMs],
      );
      await client.query("commit");
      console.log(`Applied ${migration.filename} (${durationMs} ms)`);
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // Preserve the migration's original failure.
      }
      throw new Error(`Migration failed: ${migration.filename}`, { cause: error });
    }
  }
  if (statuses.every((status) => status.status === "applied")) {
    console.log("No pending migrations.");
  }
}

async function baselineKnownSchema(client, migrations) {
  if (!(await hasSidestreamProductSchema(client))) {
    throw new Error("Baseline refused: no existing Sidestream product schema was found");
  }
  const verification = await verifyKnownPre20260713Schema(client);
  const ledgerExists = await migrationLedgerExists(client);
  if (ledgerExists) {
    await validateMigrationLedgerShape(client);
    const existingRows = await readMigrationLedger(client);
    if (existingRows.length > 0) {
      throw new Error("Baseline refused: migration ledger already contains applied migrations");
    }
  } else {
    await createMigrationLedger(client);
  }

  const migrationsByName = new Map(migrations.map((migration) => [
    migration.filename,
    migration,
  ]));
  await client.query("begin");
  try {
    for (const filename of verification.appliedMigrations) {
      const migration = migrationsByName.get(filename);
      if (!migration) throw new Error(`Baseline migration file is missing: ${filename}`);
      await client.query(
        `
          insert into ${MIGRATION_LEDGER} (
            filename, checksum_sha256, applied_at, duration_ms
          ) values ($1, $2, now(), 0)
        `,
        [filename, migration.checksum],
      );
    }
    await client.query("commit");
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Preserve the baseline's original failure.
    }
    throw error;
  }

  console.log(formatMigrationBaselineVerification(verification));
  console.log(`Baseline recorded ${verification.appliedMigrations.length} verified migrations.`);
  console.log(`pending: ${ACTIVATION_ROTATION_MIGRATION}`);
}

async function createMigrationLedger(client) {
  await client.query("begin");
  try {
    await client.query(CREATE_LEDGER_SQL);
    await client.query("commit");
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Preserve the ledger bootstrap's original failure.
    }
    throw error;
  }
  await validateMigrationLedgerShape(client);
}

async function migrationLedgerExists(client) {
  const result = await client.query(
    "select to_regclass('public.sidestream_schema_migrations') is not null as exists",
  );
  return result.rows[0]?.exists === true;
}

async function hasSidestreamProductSchema(client) {
  const result = await client.query(`
    select exists (
      select 1
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and c.relname like 'sidestream\\_%' escape '\\'
        and c.relname not in ('sidestream_schema_migrations', 'sidestream_api_rate_limits')
    ) as exists
  `);
  return result.rows[0]?.exists === true;
}

async function validateMigrationLedgerShape(client) {
  const result = await client.query(`
    select column_name, udt_name, is_nullable
    from information_schema.columns
    where table_schema = 'public' and table_name = 'sidestream_schema_migrations'
    order by ordinal_position
  `);
  const actual = result.rows.map((row) =>
    `${row.column_name}:${row.udt_name}:${row.is_nullable}`
  );
  const expected = [
    "filename:text:NO",
    "checksum_sha256:text:NO",
    "applied_at:timestamptz:NO",
    "duration_ms:int8:NO",
  ];
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error("Migration ledger schema does not match the required deterministic contract");
  }
}

async function readMigrationLedger(client) {
  const result = await client.query(`
    select filename, checksum_sha256, applied_at, duration_ms
    from ${MIGRATION_LEDGER}
    order by filename
  `);
  return result.rows;
}

function printStatuses(statuses) {
  for (const status of statuses) console.log(`${status.status}: ${status.filename}`);
}

function createMigrationPoolOptions(connectionString) {
  return {
    ...authenticatedOperatorPoolOptions(connectionString),
    connectionTimeoutMillis: boundedInteger(
      "POSTGRES_CONNECTION_TIMEOUT_MS", 10_000, 250, 30_000,
    ),
    idleTimeoutMillis: 10_000,
    statement_timeout: boundedInteger(
      "POSTGRES_MIGRATION_STATEMENT_TIMEOUT_MS", 300_000, 1_000, 1_800_000,
    ),
  };
}

function boundedInteger(name, defaultValue, minimum, maximum) {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) return defaultValue;
  if (!/^\d+$/.test(rawValue)) throw new Error(`${name} must be an integer`);
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/apply-postgres-migrations.mjs [operation]

Operations:
  (none)       Apply pending migrations; requires --target test|production
  --status     Read state; requires --target test|production
  --validate   Validate local ordering and checksums without a database
  --baseline   Verify the known schema, then record only proven files
  --dry-run    List local files without connecting or mutating a database

URLs are accepted only through SIDESTREAM_TEST_POSTGRES_URL or
SIDESTREAM_POSTGRES_URL_NON_POOLING. Production mutations also require exact
--confirm-operation and connected --confirm-target values.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(safeOperatorCliError(error, "Migration operation failed."));
    process.exitCode = 1;
  });
}

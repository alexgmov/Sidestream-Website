import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { parsePostgresTarget, readConnectedPostgresFingerprint } from "../api/_lib/postgres-target.ts";
import { readRegularFile } from "./lib/safe-file.mjs";
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
const DIRECT_DATABASE_ENV_NAMES = [
  "SIDESTREAM_POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL_NON_POOLING",
];
const POOLED_DATABASE_ENV_NAMES = [
  "SIDESTREAM_TEST_POSTGRES_URL",
  "SIDESTREAM_POSTGRES_URL",
  "POSTGRES_URL",
  "SIDESTREAM_POSTGRES_PRISMA_URL",
  "POSTGRES_PRISMA_URL",
];

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
    const sql = await readRegularFile(path.join(directory, filename), {
      maximumBytes: 4 * 1024 * 1024,
    });
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

export function migrationSetFingerprint(migrations) {
  return createHash("sha256").update(
    migrations.map((migration) => `${migration.filename}\0${migration.checksum}`).join("\0"),
  ).digest("hex");
}

export function buildMigrationApprovalMessage(options) {
  return [
    "sidestream-postgres-migration-approval:v1",
    options.mode,
    "test",
    options.targetFingerprint,
    options.migrationSetFingerprint,
    options.candidateSha,
    new Date(options.expiresAt).toISOString(),
  ].join("\0");
}

export function verifyMigrationApproval(options, environment = process.env, now = Date.now()) {
  if (options.mode !== "apply" && options.mode !== "baseline") {
    throw new Error("Migration approval is mutation-only");
  }
  const expectedTarget = configuredValue(environment.SIDESTREAM_MIGRATION_TARGET_FINGERPRINT);
  const expectedSet = configuredValue(environment.SIDESTREAM_MIGRATION_SET_FINGERPRINT);
  const expectedCandidate = configuredValue(environment.SIDESTREAM_MIGRATION_CANDIDATE_SHA);
  const namespace = configuredValue(environment.SIDESTREAM_MIGRATION_NAMESPACE).toLowerCase();
  const expiresAt = Date.parse(configuredValue(environment.SIDESTREAM_MIGRATION_APPROVAL_EXPIRES_AT));
  if (
    namespace !== "test" ||
    !/^[0-9a-f]{64}$/.test(expectedTarget) ||
    expectedTarget !== options.targetFingerprint ||
    !/^[0-9a-f]{64}$/.test(expectedSet) ||
    expectedSet !== options.migrationSetFingerprint ||
    !/^[0-9a-f]{40}$/.test(expectedCandidate) ||
    expectedCandidate !== options.candidateSha
  ) {
    throw new Error("Migration approval evidence does not match the Test candidate");
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 24 * 60 * 60 * 1_000) {
    throw new Error("Migration approval is expired or exceeds 24 hours");
  }
  const approval = {
    ...options,
    expiresAt: new Date(expiresAt).toISOString(),
  };
  const confirmation = `MIGRATE_TEST:${options.mode}:${
    options.targetFingerprint.slice(0, 12)
  }:${options.migrationSetFingerprint.slice(0, 12)}:${options.candidateSha}`;
  if (environment.SIDESTREAM_MIGRATION_CONFIRM !== confirmation) {
    throw new Error("Migration approval confirmation does not match");
  }
  const secret = environment.SIDESTREAM_MIGRATION_APPROVAL_SECRET || "";
  const token = environment.SIDESTREAM_MIGRATION_APPROVAL_TOKEN || "";
  if (secret.length < 32 || !/^[0-9a-f]{64}$/.test(token)) {
    throw new Error("Migration approval credentials are unavailable");
  }
  const expectedToken = createHmac("sha256", secret)
    .update(buildMigrationApprovalMessage(approval))
    .digest();
  const actualToken = Buffer.from(token, "hex");
  if (actualToken.length !== expectedToken.length || !timingSafeEqual(actualToken, expectedToken)) {
    throw new Error("Migration approval token is invalid");
  }
}

export function selectMigrationDatabase(environment = process.env) {
  const configured = [
    ...DIRECT_DATABASE_ENV_NAMES,
    ...POOLED_DATABASE_ENV_NAMES,
  ].flatMap((environmentVariable) => {
    const connectionString = configuredValue(environment[environmentVariable]);
    return connectionString
      ? [Object.freeze({
        environmentVariable,
        connectionString,
        direct: DIRECT_DATABASE_ENV_NAMES.includes(environmentVariable),
      })]
      : [];
  });
  if (configured.length > 1) {
    throw new Error("Migration database selection is ambiguous; configure exactly one selector");
  }
  return configured[0] || null;
}

export function parseMigrationArguments(argv) {
  const supported = new Set([
    "--apply", "--baseline", "--dry-run", "--help", "--status", "--validate",
  ]);
  const unknown = argv.filter((argument) => !supported.has(argument));
  if (unknown.length) throw new Error(`Unknown migration option: ${unknown.join(", ")}`);
  const modes = ["--apply", "--baseline", "--dry-run", "--status", "--validate"]
    .filter((option) => argv.includes(option));
  if (modes.length > 1) throw new Error(`Choose only one migration operation: ${modes.join(", ")}`);
  if (argv.includes("--help")) return "help";
  if (argv.includes("--baseline")) return "baseline";
  if (argv.includes("--apply")) return "apply";
  if (argv.includes("--dry-run")) return "dry-run";
  if (argv.includes("--status")) return "status";
  if (argv.includes("--validate")) return "validate";
  return "validate";
}

async function main() {
  const mode = parseMigrationArguments(process.argv.slice(2));
  if (mode === "help") {
    printHelp();
    return;
  }

  const migrations = validateMigrationFiles(await loadMigrationFiles());
  const localMigrationSetFingerprint = migrationSetFingerprint(migrations);
  if (mode === "validate") {
    console.log(`Validated ${migrations.length} ordered migration files and SHA-256 checksums.`);
    console.log(`Migration set fingerprint: ${localMigrationSetFingerprint}`);
    console.log(`pending-contract: ${ACTIVATION_ROTATION_MIGRATION}`);
    return;
  }
  if (mode === "dry-run") {
    for (const migration of migrations) console.log(`[dry-run] pending-check: ${migration.filename}`);
    return;
  }

  await loadEnvFile(process.env.SIDESTREAM_ENV_FILE);
  await loadEnvFile(process.env.SIDESTREAM_DB_ENV_FILE);
  const target = selectMigrationDatabase();
  if (!target) {
    throw new Error(
      `Missing Postgres connection. Set one of: ${[
        ...DIRECT_DATABASE_ENV_NAMES,
        ...POOLED_DATABASE_ENV_NAMES,
      ].join(", ")}`,
    );
  }
  console.log(`Using migration database from ${target.environmentVariable}${
    target.direct ? " (direct/non-pooling preferred)" : " (pooled fallback)"
  }.`);

  const pool = new Pool(createMigrationPoolOptions(target.connectionString));
  const client = await pool.connect();
  let lockHeld = false;
  try {
    const connectedFingerprint = await readConnectedPostgresFingerprint(client);
    if (mode === "apply" || mode === "baseline") {
      const candidateSha = currentCleanCandidateSha();
      verifyMigrationApproval({
        mode,
        targetFingerprint: connectedFingerprint,
        migrationSetFingerprint: localMigrationSetFingerprint,
        candidateSha,
        expiresAt: process.env.SIDESTREAM_MIGRATION_APPROVAL_EXPIRES_AT,
      });
    } else {
      console.log(`Connected target fingerprint: ${connectedFingerprint}`);
    }
    await client.query("select pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);
    lockHeld = true;
    if (mode === "status") {
      await reportStatus(client, migrations);
    } else if (mode === "baseline") {
      await baselineKnownSchema(client, migrations);
    } else {
      await applyPendingMigrations(client, migrations, connectedFingerprint);
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

async function applyPendingMigrations(client, migrations, connectedFingerprint) {
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
      await assertPendingCreateTargetsAbsent(client, migration);
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
  await attestMigrationSet(client, migrations, connectedFingerprint);
}

async function assertPendingCreateTargetsAbsent(client, migration) {
  const tables = [...migration.sql.matchAll(
    /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z0-9_]+)/gi,
  )].map((match) => match[1])
    .filter((name) => name !== "sidestream_schema_migrations");
  for (const table of new Set(tables)) {
    const result = await client.query("select to_regclass($1) is not null as exists", [
      `public.${table}`,
    ]);
    if (result.rows[0]?.exists === true) {
      throw new Error(`Pending migration target already exists without ledger proof: ${table}`);
    }
  }
}

async function attestMigrationSet(client, migrations, connectedFingerprint) {
  const table = await client.query(
    "select to_regclass('public.sidestream_migration_attestations') is not null as exists",
  );
  if (table.rows[0]?.exists !== true) return;
  const migrationSetFingerprintValue = migrationSetFingerprint(migrations);
  await client.query("begin");
  try {
    await client.query(`
      insert into public.sidestream_migration_attestations (
        filename, target_fingerprint, migration_set_fingerprint
      )
      select filename, $1, $2 from ${MIGRATION_LEDGER}
      on conflict (filename) do nothing
    `, [connectedFingerprint, migrationSetFingerprintValue]);
    const invalid = await client.query(`
      select count(*)::int as count
      from ${MIGRATION_LEDGER} ledger
      left join public.sidestream_migration_attestations attestation using (filename)
      where attestation.filename is null
        or attestation.target_fingerprint <> $1
        or attestation.migration_set_fingerprint <> $2
    `, [connectedFingerprint, migrationSetFingerprintValue]);
    if (invalid.rows[0]?.count !== 0) {
      throw new Error("Migration attestation target or migration-set fingerprint mismatch");
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
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
  const target = parsePostgresTarget(connectionString, "Migration connection");
  return {
    connectionString: target.connectionString,
    max: 1,
    connectionTimeoutMillis: boundedInteger(
      "POSTGRES_CONNECTION_TIMEOUT_MS", 10_000, 250, 30_000,
    ),
    idleTimeoutMillis: 10_000,
    statement_timeout: boundedInteger(
      "POSTGRES_MIGRATION_STATEMENT_TIMEOUT_MS", 300_000, 1_000, 1_800_000,
    ),
    ssl: target.ssl,
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

function currentCleanCandidateSha() {
  let candidateSha;
  let status;
  try {
    candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024,
    }).trim();
    status = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch {
    throw new Error("Migration mutation requires a readable clean Git candidate");
  }
  if (!/^[0-9a-f]{40}$/.test(candidateSha) || status) {
    throw new Error("Migration mutation requires the exact clean Git candidate");
  }
  return candidateSha;
}

async function loadEnvFile(filePath) {
  if (!filePath) return;
  const absolutePath = path.resolve(filePath);
  let text;
  try {
    text = await readRegularFile(absolutePath, {
      maximumBytes: 256 * 1024,
      requirePrivate: true,
    });
  } catch {
    throw new Error(`Could not read configured migration env file: ${absolutePath}`);
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match) throw new Error(`Malformed migration env file: ${absolutePath}`);
    const [, key, rawValue] = match;
    const value = rawValue.trim().replace(/^['"]|['"]$/g, "");
    if (process.env[key] && process.env[key] !== value) {
      throw new Error(`Migration env file conflicts with inherited ${key}`);
    }
    process.env[key] = value;
  }
}

function configuredValue(value) {
  const normalized = value?.trim() || "";
  if (!normalized || normalized.includes("[YOUR-") || normalized === "changeme") return "";
  return normalized;
}

function printHelp() {
  console.log(`Usage: node scripts/apply-postgres-migrations.mjs [operation]

Operations:
  (none)       Validate local ordering/checksums without connecting
  --apply      Apply pending migrations using the checksum ledger
  --status     Read migration/ledger state without changing it
  --validate   Validate local ordering and checksums without a database
  --baseline   Verify the known pre-20260713 schema, then record only proven files
  --dry-run    List local files without connecting or mutating a database

Mutation also requires SIDESTREAM_MIGRATION_TARGET_FINGERPRINT from a reviewed
read-only --status run, SIDESTREAM_MIGRATION_SET_FINGERPRINT from --validate,
the exact clean SIDESTREAM_MIGRATION_CANDIDATE_SHA, SIDESTREAM_MIGRATION_NAMESPACE=test,
and an expiring HMAC approval plus exact printed confirmation. Configure exactly
one database selector.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(safeCliErrorMessage(error, "Migration operation failed"));
    process.exitCode = 1;
  });
}

function safeCliErrorMessage(error, fallback) {
  const message = error instanceof Error ? error.message : fallback;
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted-postgres-url]")
    .replace(/\bpassword\s*=\s*[^\s]+/gi, "password=[redacted]");
}

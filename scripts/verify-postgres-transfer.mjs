#!/usr/bin/env node

import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  authenticatedOperatorPoolOptions,
  loadOperatorPackage,
} from "./customer-360-operator-guards.mjs";

export const TRANSFER_SOURCE_ENV = "SIDESTREAM_TRANSFER_SOURCE_POSTGRES_URL";
export const TRANSFER_TARGET_ENV = "SIDESTREAM_TRANSFER_TARGET_POSTGRES_URL";
export const READ_ONLY_SNAPSHOT_SQL =
  "begin isolation level repeatable read read only";

const STRUCTURE_QUERIES = Object.freeze({
  tables: `
    select namespace.nspname::text as schema_name,
           relation.relname::text as table_name,
           relation.relkind::text as relation_kind,
           relation.relrowsecurity as row_security_enabled,
           relation.relforcerowsecurity as row_security_forced
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p')
    order by namespace.nspname, relation.relname
  `,
  columns: `
    select table_schema::text,
           table_name::text,
           ordinal_position::integer,
           column_name::text,
           data_type::text,
           udt_schema::text,
           udt_name::text,
           is_nullable::text,
           coalesce(column_default, '')::text as column_default,
           is_identity::text,
           coalesce(identity_generation, '')::text as identity_generation,
           is_generated::text,
           coalesce(generation_expression, '')::text as generation_expression,
           coalesce(collation_name, '')::text as collation_name
    from information_schema.columns
    where table_schema = 'public'
    order by table_name, ordinal_position
  `,
  constraints: `
    select relation.relname::text as table_name,
           constraint_row.conname::text as constraint_name,
           constraint_row.contype::text as constraint_type,
           pg_get_constraintdef(constraint_row.oid, true)::text as definition
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_class relation on relation.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
    order by relation.relname, constraint_row.conname
  `,
  indexes: `
    select tablename::text as table_name,
           indexname::text as index_name,
           indexdef::text as definition
    from pg_catalog.pg_indexes
    where schemaname = 'public'
    order by tablename, indexname
  `,
  triggers: `
    select relation.relname::text as table_name,
           trigger_row.tgname::text as trigger_name,
           pg_get_triggerdef(trigger_row.oid, true)::text as definition
    from pg_catalog.pg_trigger trigger_row
    join pg_catalog.pg_class relation on relation.oid = trigger_row.tgrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and not trigger_row.tgisinternal
    order by relation.relname, trigger_row.tgname
  `,
  policies: `
    select relation.relname::text as table_name,
           policy.polname::text as policy_name,
           policy.polcmd::text as command,
           policy.polpermissive as permissive,
           coalesce((
             select array_agg(role.rolname::text order by role.rolname)
             from pg_catalog.pg_roles role
             where role.oid = any(policy.polroles)
           ), array[]::text[]) as roles,
           coalesce(pg_get_expr(policy.polqual, policy.polrelid), '')::text as using_expression,
           coalesce(pg_get_expr(policy.polwithcheck, policy.polrelid), '')::text as check_expression
    from pg_catalog.pg_policy policy
    join pg_catalog.pg_class relation on relation.oid = policy.polrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
    order by relation.relname, policy.polname
  `,
  functions: `
    select procedure.proname::text as function_name,
           pg_get_function_identity_arguments(procedure.oid)::text as identity_arguments,
           pg_get_functiondef(procedure.oid)::text as definition
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
    order by procedure.proname, pg_get_function_identity_arguments(procedure.oid)
  `,
  views: `
    select relation.relname::text as view_name,
           relation.relkind::text as relation_kind,
           pg_get_viewdef(relation.oid, true)::text as definition
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('v', 'm')
    order by relation.relname
  `,
  enums: `
    select type_row.typname::text as type_name,
           enum_row.enumsortorder::real as sort_order,
           enum_row.enumlabel::text as label
    from pg_catalog.pg_type type_row
    join pg_catalog.pg_namespace namespace on namespace.oid = type_row.typnamespace
    join pg_catalog.pg_enum enum_row on enum_row.enumtypid = type_row.oid
    where namespace.nspname = 'public'
    order by type_row.typname, enum_row.enumsortorder
  `,
  sequences: `
    select schemaname::text as schema_name,
           sequencename::text as sequence_name
    from pg_catalog.pg_sequences
    where schemaname = 'public'
    order by sequencename
  `,
  exposed_table_privileges: `
    select grantee::text,
           table_name::text,
           privilege_type::text,
           is_grantable::text
    from information_schema.table_privileges
    where table_schema = 'public'
      and grantee in ('PUBLIC', 'anon', 'authenticated')
    order by grantee, table_name, privilege_type
  `,
  exposed_routine_privileges: `
    select grantee::text,
           routine_name::text,
           privilege_type::text,
           is_grantable::text
    from information_schema.routine_privileges
    where routine_schema = 'public'
      and grantee in ('PUBLIC', 'anon', 'authenticated')
    order by grantee, routine_name, privilege_type
  `,
  exposed_sequence_privileges: `
    select grantee::text,
           object_name::text as sequence_name,
           privilege_type::text,
           is_grantable::text
    from information_schema.usage_privileges
    where object_schema = 'public'
      and object_type = 'SEQUENCE'
      and grantee in ('PUBLIC', 'anon', 'authenticated')
    order by grantee, object_name, privilege_type
  `,
});

const STRUCTURE_SECTION_NAMES = Object.freeze(Object.keys(STRUCTURE_QUERIES));

export class PostgresTransferVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PostgresTransferVerificationError";
  }
}

export function parseTransferArguments(argv) {
  const supported = new Set(["--help", "--json"]);
  const unknown = argv.filter((argument) => !supported.has(argument));
  if (unknown.length > 0) {
    throw new PostgresTransferVerificationError(
      `Unknown database-transfer option: ${unknown.join(", ")}`,
    );
  }
  return Object.freeze({
    help: argv.includes("--help"),
    json: argv.includes("--json"),
  });
}

export function resolveTransferTargets(environment = process.env) {
  const source = describePostgresTarget(environment[TRANSFER_SOURCE_ENV], TRANSFER_SOURCE_ENV);
  const target = describePostgresTarget(environment[TRANSFER_TARGET_ENV], TRANSFER_TARGET_ENV);
  if (!target.local) {
    throw new PostgresTransferVerificationError(
      `${TRANSFER_TARGET_ENV} must use localhost so PostgreSQL is not exposed for migration verification.`,
    );
  }
  if (["postgres", "template0", "template1"].includes(target.database)) {
    throw new PostgresTransferVerificationError(
      `${TRANSFER_TARGET_ENV} must identify a dedicated application database.`,
    );
  }
  if (source.identity === target.identity) {
    throw new PostgresTransferVerificationError(
      "Database-transfer source and target must identify different databases.",
    );
  }
  return Object.freeze({ source, target });
}

export function createTransferPoolOptions(connectionString) {
  return {
    ...authenticatedOperatorPoolOptions(connectionString, { readOnly: true }),
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    query_timeout: 600_000,
    statement_timeout: 600_000,
  };
}

export function tableFingerprintSql(schemaName, tableName) {
  const qualified = `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
  return `
    with row_hashes as materialized (
      select md5(row_to_json(row_value)::text) as row_hash
      from ${qualified} row_value
    )
    select count(*)::text as row_count,
           coalesce(sum((('x' || substr(row_hash, 1, 16))::bit(64)::bigint)::numeric), 0)::text as digest_a,
           coalesce(sum((('x' || substr(row_hash, 17, 16))::bit(64)::bigint)::numeric), 0)::text as digest_b,
           coalesce(min(row_hash), '')::text as minimum_hash,
           coalesce(max(row_hash), '')::text as maximum_hash
    from row_hashes
  `;
}

export function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export async function collectDatabaseSnapshot(client, descriptor) {
  let transactionStarted = false;
  try {
    await client.query(READ_ONLY_SNAPSHOT_SQL);
    transactionStarted = true;
    const identity = await collectConnectedIdentity(client, descriptor);
    const structure = {};
    for (const [name, sql] of Object.entries(STRUCTURE_QUERIES)) {
      structure[name] = normalizeRows((await client.query(sql)).rows);
    }

    const tableFingerprints = [];
    for (const table of structure.tables) {
      const result = await client.query(
        tableFingerprintSql(table.schema_name, table.table_name),
      );
      const row = result.rows?.[0] || {};
      tableFingerprints.push(Object.freeze({
        name: `${table.schema_name}.${table.table_name}`,
        rowCount: String(row.row_count || "0"),
        fingerprint: stableFingerprint({
          digestA: String(row.digest_a || "0"),
          digestB: String(row.digest_b || "0"),
          minimumHash: String(row.minimum_hash || ""),
          maximumHash: String(row.maximum_hash || ""),
        }),
      }));
    }

    const sequences = [];
    for (const sequence of structure.sequences) {
      const qualified = `${quoteIdentifier(sequence.schema_name)}.${quoteIdentifier(sequence.sequence_name)}`;
      const result = await client.query(
        `select last_value::text as last_value, is_called from ${qualified}`,
      );
      const row = result.rows?.[0] || {};
      sequences.push(Object.freeze({
        name: `${sequence.schema_name}.${sequence.sequence_name}`,
        lastValue: String(row.last_value || ""),
        isCalled: Boolean(row.is_called),
      }));
    }

    const migrationLedger = structure.tables.some(
      (table) => table.schema_name === "public" &&
        table.table_name === "sidestream_schema_migrations",
    )
      ? normalizeRows((await client.query(`
          select filename::text, checksum_sha256::text
          from public.sidestream_schema_migrations
          order by filename
        `)).rows)
      : [];

    return Object.freeze({
      identity,
      structure: Object.freeze(structure),
      migrationLedger,
      tableFingerprints: Object.freeze(tableFingerprints),
      sequences: Object.freeze(sequences),
    });
  } finally {
    if (transactionStarted) {
      try {
        await client.query("rollback");
      } catch {
        // Releasing the connection below also abandons the read-only transaction.
      }
    }
  }
}

export function compareDatabaseSnapshots(source, target) {
  const structureSections = STRUCTURE_SECTION_NAMES.map((name) => {
    const sourceFingerprint = stableFingerprint(source.structure[name] || []);
    const targetFingerprint = stableFingerprint(target.structure[name] || []);
    return Object.freeze({
      name,
      matched: sourceFingerprint === targetFingerprint,
      sourceFingerprint,
      targetFingerprint,
    });
  });
  const migrationSource = stableFingerprint(source.migrationLedger || []);
  const migrationTarget = stableFingerprint(target.migrationLedger || []);
  const migrationLedger = Object.freeze({
    matched: migrationSource === migrationTarget,
    sourceCount: source.migrationLedger?.length || 0,
    targetCount: target.migrationLedger?.length || 0,
    sourceFingerprint: migrationSource,
    targetFingerprint: migrationTarget,
  });

  const sourceTables = new Map(
    (source.tableFingerprints || []).map((table) => [table.name, table]),
  );
  const targetTables = new Map(
    (target.tableFingerprints || []).map((table) => [table.name, table]),
  );
  const tableNames = [...new Set([...sourceTables.keys(), ...targetTables.keys()])].sort();
  const tables = tableNames.map((name) => {
    const sourceTable = sourceTables.get(name);
    const targetTable = targetTables.get(name);
    return Object.freeze({
      name,
      matched: Boolean(sourceTable && targetTable) &&
        sourceTable.rowCount === targetTable.rowCount &&
        sourceTable.fingerprint === targetTable.fingerprint,
      sourceRowCount: sourceTable?.rowCount ?? null,
      targetRowCount: targetTable?.rowCount ?? null,
      sourceFingerprint: sourceTable?.fingerprint ?? null,
      targetFingerprint: targetTable?.fingerprint ?? null,
    });
  });

  const sourceSequences = new Map(
    (source.sequences || []).map((sequence) => [sequence.name, sequence]),
  );
  const targetSequences = new Map(
    (target.sequences || []).map((sequence) => [sequence.name, sequence]),
  );
  const sequenceNames = [
    ...new Set([...sourceSequences.keys(), ...targetSequences.keys()]),
  ].sort();
  const sequences = sequenceNames.map((name) => {
    const sourceSequence = sourceSequences.get(name);
    const targetSequence = targetSequences.get(name);
    return Object.freeze({
      name,
      matched: Boolean(sourceSequence && targetSequence) &&
        sourceSequence.lastValue === targetSequence.lastValue &&
        sourceSequence.isCalled === targetSequence.isCalled,
      sourceLastValue: sourceSequence?.lastValue ?? null,
      targetLastValue: targetSequence?.lastValue ?? null,
      sourceIsCalled: sourceSequence?.isCalled ?? null,
      targetIsCalled: targetSequence?.isCalled ?? null,
    });
  });

  const sourceRows = sumRowCounts(source.tableFingerprints || []);
  const targetRows = sumRowCounts(target.tableFingerprints || []);
  const targetSecurity = targetSecurityPosture(target);
  const matched = structureSections.every((section) => section.matched) &&
    migrationLedger.matched &&
    tables.every((table) => table.matched) &&
    sequences.every((sequence) => sequence.matched) &&
    targetSecurity.matched;

  return Object.freeze({
    version: 1,
    status: matched ? "pass" : "fail",
    source: safeIdentityReport(source.identity),
    target: safeIdentityReport(target.identity),
    schema: Object.freeze({
      matched: structureSections.every((section) => section.matched),
      sections: Object.freeze(structureSections),
    }),
    migrationLedger,
    data: Object.freeze({
      matched: tables.every((table) => table.matched),
      tableCount: tables.length,
      sourceRows,
      targetRows,
      tables: Object.freeze(tables),
    }),
    sequences: Object.freeze({
      matched: sequences.every((sequence) => sequence.matched),
      count: sequences.length,
      items: Object.freeze(sequences),
    }),
    targetSecurity,
  });
}

export function formatTransferReport(report) {
  const lines = [
    `Database transfer parity: ${report.status.toUpperCase()}`,
    `source-target: ${report.source.fingerprint} -> ${report.target.fingerprint}`,
    `schema: ${report.schema.matched ? "matched" : "MISMATCH"} (${report.schema.sections.length} sections)`,
    `migration-ledger: ${report.migrationLedger.matched ? "matched" : "MISMATCH"} (${report.migrationLedger.sourceCount}/${report.migrationLedger.targetCount})`,
    `table-data: ${report.data.matched ? "matched" : "MISMATCH"} (${report.data.tableCount} tables, ${report.data.sourceRows}/${report.data.targetRows} rows)`,
    `sequences: ${report.sequences.matched ? "matched" : "MISMATCH"} (${report.sequences.count})`,
    `target-security: ${report.targetSecurity.matched ? "local/scram" : "MISMATCH"}`,
  ];
  for (const section of report.schema.sections.filter((candidate) => !candidate.matched)) {
    lines.push(`mismatch schema:${section.name}`);
  }
  for (const table of report.data.tables.filter((candidate) => !candidate.matched)) {
    lines.push(
      `mismatch table:${table.name} rows=${table.sourceRowCount ?? "missing"}/${table.targetRowCount ?? "missing"}`,
    );
  }
  for (const sequence of report.sequences.items.filter((candidate) => !candidate.matched)) {
    lines.push(`mismatch sequence:${sequence.name}`);
  }
  for (const reason of report.targetSecurity.reasons) lines.push(`mismatch target-security:${reason}`);
  return lines.join("\n");
}

function describePostgresTarget(value, environmentName) {
  const connectionString = typeof value === "string" ? value.trim() : "";
  if (!connectionString) {
    throw new PostgresTransferVerificationError(
      `Required selector ${environmentName} is not configured.`,
    );
  }
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new PostgresTransferVerificationError(
      `${environmentName} must be a valid Postgres URL.`,
    );
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new PostgresTransferVerificationError(
      `${environmentName} must use postgres: or postgresql:.`,
    );
  }
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!url.hostname || !database) {
    throw new PostgresTransferVerificationError(
      `${environmentName} must identify a Postgres host and database.`,
    );
  }
  const local = isLocalHostname(url.hostname);
  const normalizedHost = local ? "loopback" : url.hostname.toLowerCase();
  const port = url.port || "5432";
  return Object.freeze({
    environmentName,
    connectionString,
    database,
    hostname: url.hostname.toLowerCase(),
    port,
    local,
    identity: `${normalizedHost}:${port}/${database}`,
    fingerprint: `pg-${createHash("sha256")
      .update(`${normalizedHost}:${port}/${database}`)
      .digest("hex")
      .slice(0, 20)}`,
  });
}

async function collectConnectedIdentity(client, descriptor) {
  const result = await client.query(`
    select current_database()::text as database_name,
           coalesce(inet_server_port(), current_setting('port')::integer)::text as server_port,
           current_setting('server_version_num')::text as server_version_num,
           current_setting('transaction_read_only')::text as transaction_read_only,
           current_setting('listen_addresses')::text as listen_addresses,
           current_setting('password_encryption')::text as password_encryption
  `);
  const row = result.rows?.[0] || {};
  if (String(row.database_name || "") !== descriptor.database) {
    throw new PostgresTransferVerificationError(
      "Connected database does not match its selected database name.",
    );
  }
  if (String(row.server_port || "") !== descriptor.port) {
    throw new PostgresTransferVerificationError(
      "Connected database does not match its selected server port.",
    );
  }
  if (String(row.transaction_read_only || "") !== "on") {
    throw new PostgresTransferVerificationError(
      "Database transfer verification requires a read-only transaction.",
    );
  }
  return Object.freeze({
    databaseName: descriptor.database,
    serverVersionNum: String(row.server_version_num || "unknown"),
    listenAddresses: String(row.listen_addresses || ""),
    passwordEncryption: String(row.password_encryption || ""),
    fingerprint: descriptor.fingerprint,
  });
}

function safeIdentityReport(identity = {}) {
  return Object.freeze({
    fingerprint: String(identity.fingerprint || "pg-unknown"),
    serverVersionNum: String(identity.serverVersionNum || "unknown"),
  });
}

function targetSecurityPosture(target) {
  const reasons = [];
  const addresses = String(target.identity?.listenAddresses || "")
    .split(",")
    .map((address) => address.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
  if (
    addresses.length === 0 ||
    addresses.some((address) => !["localhost", "127.0.0.1", "::1"].includes(address))
  ) {
    reasons.push("listen-addresses-not-loopback-only");
  }
  if (String(target.identity?.passwordEncryption || "").toLowerCase() !== "scram-sha-256") {
    reasons.push("password-encryption-not-scram-sha-256");
  }
  return Object.freeze({ matched: reasons.length === 0, reasons: Object.freeze(reasons) });
}

function normalizeRows(rows = []) {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]),
  ));
}

function normalizeValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === "bigint") return value.toString();
  return value;
}

function stableFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sumRowCounts(tables) {
  let total = 0n;
  for (const table of tables) {
    if (!/^\d+$/.test(String(table.rowCount))) {
      throw new PostgresTransferVerificationError("Database row count is invalid.");
    }
    total += BigInt(table.rowCount);
  }
  return total.toString();
}

function isLocalHostname(hostname) {
  return ["localhost", "127.0.0.1", "::1"].includes(String(hostname).toLowerCase());
}

async function main() {
  const options = parseTransferArguments(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: npm run verify:database-transfer -- [--json]\n\nRead-only source/target parity verification.\nRequired environment variables:\n  ${TRANSFER_SOURCE_ENV}\n  ${TRANSFER_TARGET_ENV} (must use localhost)`);
    return;
  }
  const targets = resolveTransferTargets();
  const { Pool } = await loadOperatorPackage("pg");
  const sourcePool = new Pool(createTransferPoolOptions(targets.source.connectionString));
  const targetPool = new Pool(createTransferPoolOptions(targets.target.connectionString));
  let sourceClient;
  let targetClient;
  try {
    [sourceClient, targetClient] = await Promise.all([
      sourcePool.connect(),
      targetPool.connect(),
    ]);
    const [sourceSnapshot, targetSnapshot] = await Promise.all([
      collectDatabaseSnapshot(sourceClient, targets.source),
      collectDatabaseSnapshot(targetClient, targets.target),
    ]);
    const report = compareDatabaseSnapshots(sourceSnapshot, targetSnapshot);
    console.log(options.json ? JSON.stringify(report) : formatTransferReport(report));
    if (report.status !== "pass") process.exitCode = 1;
  } finally {
    sourceClient?.release();
    targetClient?.release();
    await Promise.allSettled([sourcePool.end(), targetPool.end()]);
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    const message = error instanceof PostgresTransferVerificationError
      ? error.message
      : "Database transfer verification failed without exposing connection details.";
    console.error(message);
    process.exitCode = 1;
  });
}

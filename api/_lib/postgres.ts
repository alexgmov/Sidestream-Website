import { attachDatabasePool } from "@vercel/functions";
import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";
import { parsePostgresTarget } from "./postgres-target.js";

export const POOLED_POSTGRES_URL_ENV_NAMES = [
  "SIDESTREAM_POSTGRES_URL",
  "SIDESTREAM_POSTGRES_PRISMA_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
] as const;

export const DIRECT_POSTGRES_URL_ENV_NAMES = [
  "SIDESTREAM_POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL_NON_POOLING",
] as const;

export const RUNTIME_POSTGRES_URL_ENV_NAMES = [
  ...POOLED_POSTGRES_URL_ENV_NAMES,
  ...DIRECT_POSTGRES_URL_ENV_NAMES,
] as const;

const DEFAULT_POOL_MAX = 4;
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_QUERY_TIMEOUT_MS = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type RuntimePostgresTarget = Readonly<{
  connectionString: string;
  environmentVariable: string;
  pooled: boolean;
}>;

export type RuntimePostgresTargetInput = Readonly<{
  connectionString: string;
  environmentVariable?: string;
  pooled?: boolean;
}>;

export type PostgresTransactionOptions = Readonly<{
  isolationLevel?: "read committed" | "repeatable read" | "serializable";
  readOnly?: boolean;
}>;

let runtimePool: Pool | null = null;
let runtimePoolTargetIdentity = "";

export function resolveRuntimePostgresTarget(
  environment: RuntimeEnvironment = process.env,
): RuntimePostgresTarget | null {
  for (const environmentVariable of POOLED_POSTGRES_URL_ENV_NAMES) {
    const connectionString = getConfiguredValue(environment[environmentVariable]);
    if (connectionString) {
      return validateRuntimePostgresTarget({
        connectionString,
        environmentVariable,
        pooled: true,
      }, environment);
    }
  }

  const directTarget = DIRECT_POSTGRES_URL_ENV_NAMES
    .map((environmentVariable) => ({
      environmentVariable,
      connectionString: getConfiguredValue(environment[environmentVariable]),
    }))
    .find((candidate) => candidate.connectionString);

  if (!directTarget) return null;
  if (isProductionRuntime(environment)) {
    throw new Error(
      "Production runtime requires a pooled Postgres URL; direct/non-pooling fallback is forbidden",
    );
  }

  return validateRuntimePostgresTarget({
    ...directTarget,
    pooled: false,
  }, environment);
}

export function requireRuntimePostgresTarget(
  environment: RuntimeEnvironment = process.env,
) {
  const target = resolveRuntimePostgresTarget(environment);
  if (!target) {
    throw new Error(
      `Missing runtime Postgres connection (${POOLED_POSTGRES_URL_ENV_NAMES.join(", ")})`,
    );
  }
  return target;
}

export function isPostgresConfigured(
  environment: RuntimeEnvironment = process.env,
) {
  return resolveRuntimePostgresTarget(environment) !== null;
}

export function getOptionalRuntimePostgresConnectionString(
  environment: RuntimeEnvironment = process.env,
) {
  return resolveRuntimePostgresTarget(environment)?.connectionString || "";
}

export function buildPostgresPoolOptions(
  target: RuntimePostgresTarget,
  environment: RuntimeEnvironment = process.env,
): PoolConfig {
  const parsedTarget = parsePostgresTarget(
    target.connectionString,
    "Runtime Postgres connection",
  );
  const connectionString = parsedTarget.connectionString;
  return {
    connectionString,
    max: readBoundedInteger(environment, "POSTGRES_POOL_MAX", DEFAULT_POOL_MAX, 2, 20),
    idleTimeoutMillis: readBoundedInteger(
      environment,
      "POSTGRES_POOL_IDLE_TIMEOUT_MS",
      DEFAULT_IDLE_TIMEOUT_MS,
      1_000,
      60_000,
    ),
    connectionTimeoutMillis: readBoundedInteger(
      environment,
      "POSTGRES_CONNECTION_TIMEOUT_MS",
      DEFAULT_CONNECTION_TIMEOUT_MS,
      250,
      30_000,
    ),
    query_timeout: readBoundedInteger(
      environment,
      "POSTGRES_QUERY_TIMEOUT_MS",
      DEFAULT_QUERY_TIMEOUT_MS,
      250,
      60_000,
    ),
    statement_timeout: readBoundedInteger(
      environment,
      "POSTGRES_STATEMENT_TIMEOUT_MS",
      DEFAULT_STATEMENT_TIMEOUT_MS,
      250,
      60_000,
    ),
    ssl: parsedTarget.ssl,
  };
}

export function getPostgresPool(
  targetInput?: RuntimePostgresTargetInput,
  environment: RuntimeEnvironment = process.env,
) {
  const target = targetInput
    ? validateRuntimePostgresTarget({
        connectionString: targetInput.connectionString,
        environmentVariable: targetInput.environmentVariable || "explicit runtime target",
        pooled: targetInput.pooled ?? !isDirectEnvironmentVariable(targetInput.environmentVariable),
      }, environment)
    : requireRuntimePostgresTarget(environment);
  const normalizedConnectionString = normalizePostgresConnectionString(target.connectionString);
  const targetIdentity = normalizedConnectionString;

  if (runtimePool) {
    if (runtimePoolTargetIdentity !== targetIdentity) {
      throw new Error("Runtime Postgres pool is already attached to a different database target");
    }
    return runtimePool;
  }

  runtimePool = new Pool(buildPostgresPoolOptions(target, environment));
  runtimePoolTargetIdentity = targetIdentity;
  runtimePool.on("error", (error) => {
    console.error("Sidestream Postgres pool error", safePostgresErrorCode(error));
  });
  attachDatabasePool(runtimePool);
  return runtimePool;
}

export async function queryPostgres<
  Row extends QueryResultRow = Record<string, unknown>,
>(text: string, params: readonly unknown[] = []): Promise<QueryResult<Row>> {
  return getPostgresPool().query<Row>(text, [...params]);
}

export async function withPostgresClient<T>(
  callback: (client: PoolClient) => Promise<T>,
) {
  const client = await getPostgresPool().connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

export async function withPostgresTransaction<T>(
  callback: (client: PoolClient) => Promise<T>,
  options: PostgresTransactionOptions = {},
) {
  return withPostgresClient(async (client) => {
    const isolationLevel = options.isolationLevel || "read committed";
    const transactionMode = options.readOnly ? " read only" : "";
    await client.query(`begin isolation level ${isolationLevel}${transactionMode}`);
    try {
      const result = await callback(client);
      await client.query("commit");
      return result;
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // Preserve the transaction's original error.
      }
      throw error;
    }
  });
}

export async function acquireTransactionAdvisoryLock(
  client: Pick<PoolClient, "query">,
  lockKey: string,
) {
  const normalizedLockKey = lockKey.trim();
  if (!normalizedLockKey || normalizedLockKey.length > 240) {
    throw new TypeError("Postgres advisory lock key must contain 1-240 characters");
  }
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [normalizedLockKey]);
}

export async function withPostgresAdvisoryTransaction<T>(
  lockKey: string,
  callback: (client: PoolClient) => Promise<T>,
  options: PostgresTransactionOptions = {},
) {
  return withPostgresTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, lockKey);
    return callback(client);
  }, options);
}

export function normalizePostgresConnectionString(connectionString: string) {
  return parsePostgresTarget(
    connectionString,
    "Runtime Postgres connection",
  ).connectionString;
}

export function shouldUsePostgresSsl(
  connectionString: string,
  _environment: RuntimeEnvironment = process.env,
) {
  return parsePostgresTarget(
    connectionString,
    "Runtime Postgres connection",
  ).ssl !== false;
}

export function safePostgresErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return "database_error";
  }
  const code = String((error as { code?: unknown }).code || "");
  return /^[A-Za-z0-9_]{1,24}$/.test(code) ? code : "database_error";
}

function validateRuntimePostgresTarget(
  target: RuntimePostgresTarget,
  environment: RuntimeEnvironment,
): RuntimePostgresTarget {
  const normalized = normalizePostgresConnectionString(target.connectionString);
  const directOnly = !target.pooled || isDirectEnvironmentVariable(target.environmentVariable);
  if (directOnly && isProductionRuntime(environment)) {
    throw new Error(
      "Production runtime requires a pooled Postgres URL; direct/non-pooling fallback is forbidden",
    );
  }
  return Object.freeze({ ...target, connectionString: normalized, pooled: !directOnly });
}

function readBoundedInteger(
  environment: RuntimeEnvironment,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
) {
  const rawValue = environment[name]?.trim();
  if (!rawValue) return defaultValue;
  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function isDirectEnvironmentVariable(name: string | undefined) {
  return Boolean(name && DIRECT_POSTGRES_URL_ENV_NAMES.includes(
    name as typeof DIRECT_POSTGRES_URL_ENV_NAMES[number],
  ));
}

function isProductionRuntime(environment: RuntimeEnvironment) {
  return environment.VERCEL_ENV?.trim().toLowerCase() === "production" ||
    environment.SIDESTREAM_LICENSE_NAMESPACE?.trim().toLowerCase() === "production";
}

function getConfiguredValue(value: string | undefined) {
  const normalized = value?.trim() || "";
  if (!normalized || normalized.includes("[YOUR-") || normalized === "changeme") return "";
  return normalized;
}

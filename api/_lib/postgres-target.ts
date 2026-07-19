import { createHash } from "node:crypto";
import type { PoolClient, PoolConfig } from "pg";

const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const TLS_ENABLE_VALUES = new Set([
  "1",
  "true",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
]);
const TLS_DISABLE_VALUES = new Set(["0", "false", "disable"]);
const ALLOWED_QUERY_PARAMETERS = new Set(["ssl", "sslmode"]);

export type ParsedPostgresTarget = Readonly<{
  connectionString: string;
  hostname: string;
  port: string;
  database: string;
  endpoint: string;
  identity: string;
  fingerprint: string;
  local: boolean;
  ssl: false | Readonly<{ rejectUnauthorized: true }>;
}>;

export function parsePostgresTarget(
  connectionString: string,
  label = "Postgres connection",
): ParsedPostgresTarget {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`${label} must be a valid Postgres URL`);
  }
  if (!POSTGRES_PROTOCOLS.has(url.protocol)) {
    throw new Error(`${label} must use postgres: or postgresql:`);
  }
  if (url.hash || !url.hostname || !url.pathname.startsWith("/") || url.pathname === "/") {
    throw new Error(`${label} must identify one Postgres host and database`);
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const database = decodeURIComponent(url.pathname.slice(1));
  if (
    !hostname ||
    !database ||
    database.includes("/") ||
    /[\u0000-\u001f\u007f]/.test(database)
  ) {
    throw new Error(`${label} must identify one Postgres host and database`);
  }

  const seen = new Set<string>();
  let requestedTls: boolean | null = null;
  for (const [rawName, rawValue] of url.searchParams.entries()) {
    const name = rawName.toLowerCase();
    if (seen.has(name)) throw new Error(`${label} contains duplicate connection parameters`);
    seen.add(name);
    if (!ALLOWED_QUERY_PARAMETERS.has(name)) {
      throw new Error(`${label} contains an unsupported connection parameter`);
    }
    const value = rawValue.trim().toLowerCase();
    const nextTls = TLS_ENABLE_VALUES.has(value)
      ? true
      : TLS_DISABLE_VALUES.has(value)
        ? false
        : null;
    if (nextTls === null || (requestedTls !== null && requestedTls !== nextTls)) {
      throw new Error(`${label} contains an unsafe TLS configuration`);
    }
    requestedTls = nextTls;
  }

  const local = LOOPBACK_HOSTS.has(hostname);
  if (!local && requestedTls === false) {
    throw new Error(`${label} requires authenticated TLS`);
  }
  for (const name of [...url.searchParams.keys()]) url.searchParams.delete(name);

  const port = url.port || "5432";
  const endpoint = `${hostname}:${port}`;
  const identity = `${endpoint}/${database}`;
  return Object.freeze({
    connectionString: url.toString(),
    hostname,
    port,
    database,
    endpoint,
    identity,
    fingerprint: createHash("sha256").update(identity).digest("hex"),
    local,
    ssl: local && requestedTls !== true ? false : Object.freeze({ rejectUnauthorized: true }),
  });
}

export function postgresPoolTargetOptions(
  connectionString: string,
  label = "Postgres connection",
): Pick<PoolConfig, "connectionString" | "ssl"> {
  const target = parsePostgresTarget(connectionString, label);
  return { connectionString: target.connectionString, ssl: target.ssl };
}

export async function readConnectedPostgresFingerprint(
  client: Pick<PoolClient, "query">,
) {
  const result = await client.query<{
    database_name: string;
    database_user: string;
    server_address: string;
    server_port: number;
  }>(`
    select current_database() as database_name,
      current_user as database_user,
      coalesce(inet_server_addr()::text, 'local') as server_address,
      coalesce(inet_server_port(), 0) as server_port
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Connected Postgres identity is unavailable");
  const identity = [
    "sidestream-connected-postgres:v1",
    row.server_address,
    String(row.server_port),
    row.database_name,
    row.database_user,
  ].join("\0");
  return createHash("sha256").update(identity).digest("hex");
}

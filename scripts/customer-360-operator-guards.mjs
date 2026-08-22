import { createHash, randomBytes } from "node:crypto";
import { chmod, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

export const CUSTOMER_360_DATABASE_SELECTORS = Object.freeze({
  test: "SIDESTREAM_TEST_POSTGRES_URL",
  production: "SIDESTREAM_POSTGRES_URL_NON_POOLING",
  telemetry: "SIDESTREAM_TELEMETRY_POSTGRES_URL",
});

export class Customer360OperatorGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = "Customer360OperatorGuardError";
  }
}

export function exactTargetSelector(namespace) {
  const selector = CUSTOMER_360_DATABASE_SELECTORS[namespace];
  if (!selector || namespace === "telemetry") {
    throw new Customer360OperatorGuardError(
      "Target namespace must be exactly test or production.",
    );
  }
  return selector;
}

export function resolveOperatorDatabase({
  environment,
  namespace,
  selector,
  role = "target",
}) {
  const expected = role === "source"
    ? CUSTOMER_360_DATABASE_SELECTORS.telemetry
    : exactTargetSelector(namespace);
  if (selector !== expected) {
    throw new Customer360OperatorGuardError(
      `${role === "source" ? "Source" : "Target"} must use the exact ${expected} selector.`,
    );
  }
  const connectionString = environment?.[expected]?.trim() || "";
  if (!connectionString) {
    throw new Customer360OperatorGuardError(`Required selector ${expected} is not configured.`);
  }
  const parsed = parseAuthenticatedPostgresUrl(connectionString);

  if (role === "target") {
    const otherNamespace = namespace === "test" ? "production" : "test";
    const otherSelector = exactTargetSelector(otherNamespace);
    const otherValue = environment?.[otherSelector]?.trim() || "";
    if (otherValue) {
      const other = parseAuthenticatedPostgresUrl(otherValue);
      if (sameSelectedEndpoint(parsed, other)) {
        throw new Customer360OperatorGuardError(
          "Test and Production selectors resolve to the same database endpoint.",
        );
      }
    }
  }

  return Object.freeze({
    selector: expected,
    connectionString,
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port || "5432",
    selectedDatabase: decodedDatabase(parsed),
    local: isLocalHostname(parsed.hostname),
  });
}

export function authenticatedOperatorPoolOptions(connectionString, { readOnly = false } = {}) {
  const url = parseAuthenticatedPostgresUrl(connectionString);
  const local = isLocalHostname(url.hostname);
  const sslMode = (url.searchParams.get("sslmode") || "").toLowerCase();
  const channelBinding = (url.searchParams.get("channel_binding") || "").toLowerCase();
  if (!local && ["", "disable", "false", "allow", "prefer"].includes(sslMode)) {
    throw new Customer360OperatorGuardError("Remote Postgres requires authenticated TLS.");
  }
  url.searchParams.delete("sslmode");
  url.searchParams.delete("channel_binding");
  return {
    connectionString: url.toString(),
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
    options: readOnly ? "-c default_transaction_read_only=on" : undefined,
    enableChannelBinding: !local && ["prefer", "require"].includes(channelBinding),
    ssl: local ? false : { rejectUnauthorized: true },
  };
}

export async function connectAndFingerprintOperatorDatabase({
  pool,
  descriptor,
  namespace,
  operation,
  role = "target",
}) {
  if (!pool || typeof pool.connect !== "function") {
    throw new Customer360OperatorGuardError("Database pool cannot establish a guarded connection.");
  }
  let client;
  try {
    client = await pool.connect();
    const identityResult = await client.query(`
      select current_database()::text as database_name,
             inet_server_port()::text as server_port
    `);
    const databaseName = String(identityResult.rows?.[0]?.database_name || "");
    const serverPort = String(identityResult.rows?.[0]?.server_port || descriptor.port);
    if (!databaseName || databaseName !== descriptor.selectedDatabase) {
      throw new Customer360OperatorGuardError(
        "Connected database does not match the selected database name.",
      );
    }
    if (serverPort !== descriptor.port) {
      throw new Customer360OperatorGuardError(
        "Connected database port does not match the selected endpoint.",
      );
    }
    if (role === "target") {
      await assertConnectedNamespace(client, namespace);
    }
    const fingerprint = connectedDatabaseFingerprint({
      hostname: descriptor.hostname,
      port: serverPort,
      databaseName,
      namespace,
      operation,
    });
    return Object.freeze({ fingerprint, databaseName, client });
  } catch (error) {
    if (client) client.release();
    if (error instanceof Customer360OperatorGuardError) throw error;
    throw new Customer360OperatorGuardError("Database identity attestation failed.");
  }
}

export function connectedDatabaseFingerprint({
  hostname,
  port,
  databaseName,
  namespace,
  operation,
}) {
  if (
    !hostname || !port || !databaseName ||
    !["test", "production"].includes(namespace) ||
    !/^[a-z][a-z0-9_]{2,80}$/.test(operation)
  ) {
    throw new Customer360OperatorGuardError("Connected database identity is incomplete.");
  }
  const identity = JSON.stringify({
    version: 1,
    hostname: String(hostname).toLowerCase(),
    port: String(port),
    database: String(databaseName),
    namespace,
    operation,
  });
  return `pg-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

export function requireProductionConfirmations({
  namespace,
  operation,
  expectedConfirmation,
  fingerprint,
  confirmOperation,
  confirmTarget,
}) {
  if (namespace !== "production") return;
  if (!operation || confirmOperation !== expectedConfirmation) {
    throw new Customer360OperatorGuardError(
      `Production apply requires exact operation confirmation ${expectedConfirmation}.`,
    );
  }
  if (!confirmTarget || confirmTarget !== fingerprint) {
    throw new Customer360OperatorGuardError(
      "Production target fingerprint confirmation does not match the connected database.",
    );
  }
}

export function rejectConnectedCollision(sourceFingerprint, targetFingerprint) {
  if (!sourceFingerprint || !targetFingerprint || sourceFingerprint === targetFingerprint) {
    throw new Customer360OperatorGuardError(
      "Telemetry source and aggregate target must be separate connected databases.",
    );
  }
}

export async function writeMode600JsonAtomic(filename, value) {
  const directory = path.dirname(filename);
  const basename = path.basename(filename);
  const temporary = path.join(
    directory,
    `.${basename}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, filename);
    await chmod(filename, 0o600);
  } catch {
    try {
      await handle?.close();
    } catch {
      // Preserve the fixed safe error below.
    }
    try {
      await unlink(temporary);
    } catch {
      // The temporary file may not have been created or may already be renamed.
    }
    throw new Customer360OperatorGuardError("Unable to persist the operator checkpoint.");
  }
}

export function safeOperatorCliError(error, fallback) {
  return error instanceof Customer360OperatorGuardError ? error.message : fallback;
}

export async function loadOperatorPackage(packageName, worktreeRoot = process.cwd()) {
  try {
    return await import(packageName);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  }
  const gitPointer = (await readFile(path.join(worktreeRoot, ".git"), "utf8")).trim();
  const match = /^gitdir:\s*(.+)$/i.exec(gitPointer);
  const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  const markerIndex = match?.[1].indexOf(marker) ?? -1;
  if (!match || markerIndex < 0) {
    throw new Customer360OperatorGuardError("Required operator dependency is unavailable.");
  }
  const baseRoot = match[1].slice(0, markerIndex);
  const requireFromBase = createRequire(path.join(baseRoot, "package.json"));
  return requireFromBase(packageName);
}

async function assertConnectedNamespace(client, expectedNamespace) {
  const presence = await client.query(`
    select to_regclass('public.sidestream_customer_profiles') is not null as profiles,
           to_regclass('public.sidestream_customer_usage_daily') is not null as usage
  `);
  const observed = new Set();
  if (presence.rows?.[0]?.profiles === true) {
    const result = await client.query(
      "select distinct license_namespace from public.sidestream_customer_profiles limit 3",
    );
    for (const row of result.rows || []) observed.add(String(row.license_namespace));
  }
  if (presence.rows?.[0]?.usage === true) {
    const result = await client.query(
      "select distinct license_namespace from public.sidestream_customer_usage_daily limit 3",
    );
    for (const row of result.rows || []) observed.add(String(row.license_namespace));
  }
  if (observed.size > 1 || (observed.size === 1 && !observed.has(expectedNamespace))) {
    throw new Customer360OperatorGuardError(
      "Connected database contains the wrong or ambiguous license namespace.",
    );
  }
}

function parseAuthenticatedPostgresUrl(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Customer360OperatorGuardError("Postgres selector is invalid.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname || !decodedDatabase(url) || !url.username || !url.password
  ) {
    throw new Customer360OperatorGuardError(
      "Postgres selector must include a host, database, and authentication secret.",
    );
  }
  const local = isLocalHostname(url.hostname);
  const sslMode = (url.searchParams.get("sslmode") || "").toLowerCase();
  if (!local && ["", "disable", "false", "allow", "prefer"].includes(sslMode)) {
    throw new Customer360OperatorGuardError("Remote Postgres requires authenticated TLS.");
  }
  return url;
}

function decodedDatabase(url) {
  try {
    return decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    throw new Customer360OperatorGuardError("Postgres selector is invalid.");
  }
}

function sameSelectedEndpoint(left, right) {
  return left.hostname.toLowerCase() === right.hostname.toLowerCase() &&
    (left.port || "5432") === (right.port || "5432") &&
    decodedDatabase(left) === decodedDatabase(right);
}

function isLocalHostname(hostname) {
  return ["localhost", "127.0.0.1", "::1"].includes(hostname.toLowerCase());
}

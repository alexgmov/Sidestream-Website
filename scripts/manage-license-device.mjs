import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_TRANSFER_LIMIT = 3;
export const MAX_TRANSFER_LIMIT = 10;
export const TRANSFER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_OVERRIDE_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
export const PRODUCTION_CONFIRMATION = "MANAGE-PRODUCTION-DEVICE";

export const SUPPORT_REASONS = Object.freeze([
  "customer_request",
  "lost_device",
  "repair_replacement",
  "support_recovery",
  "fraud_review_resolved",
]);

const POSTGRES_URL_ENV_NAMES = [
  "SIDESTREAM_POSTGRES_URL",
  "SIDESTREAM_POSTGRES_PRISMA_URL",
  "SIDESTREAM_POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
];

const DIRECT_POSTGRES_URL_ENV_NAMES = [
  "SIDESTREAM_POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL_NON_POOLING",
];

export const SUPPORT_READ_QUERIES = Object.freeze({
  account: `
    select id as account_id
    from public.sidestream_accounts
    where id = $1
  `,
  devices: `
    select
      id,
      device_id_hash,
      platform,
      activated_at,
      last_seen_at,
      revoked_at,
      revocation_reason
    from public.sidestream_account_devices
    where account_id = $1
      and license_namespace = $2
    order by activated_at asc, id asc
  `,
  transfers: `
    select from_device_id, to_device_id, transferred_at
    from public.sidestream_device_transfers
    where account_id = $1
      and license_namespace = $2
    order by transferred_at asc, id asc
  `,
  license: `
    select id, features
    from public.sidestream_licenses
    where account_id = $1
    order by
      case when status in ('active', 'trialing', 'past_due', 'unpaid') then 0 else 1 end,
      created_at desc,
      id desc
    limit 1
  `,
});

const UPDATE_DEVICE_QUERY = `
  update public.sidestream_account_devices
  set revoked_at = $2::timestamptz,
      revocation_reason = 'deactivated'
  where id = $1
    and revoked_at is null
`;

const REVOKE_DEVICE_TOKENS_QUERY = `
  update public.sidestream_license_tokens
  set revoked_at = $3::timestamptz,
      updated_at = $3::timestamptz
  where account_id = $1
    and device_id_hash = $2
    and revoked_at is null
`;

const UPDATE_LICENSE_FEATURES_QUERY = `
  update public.sidestream_licenses
  set features = $2::jsonb,
      updated_at = $3::timestamptz
  where id = $1
`;

class CliError extends Error {}

export function parseManageArgs(argv, nowMs = Date.now()) {
  const options = {
    command: "",
    accountId: "",
    namespace: "",
    target: "",
    databaseUrlEnv: "",
    reason: "",
    operatorId: "",
    expiresAt: "",
    maxMoves: null,
    confirmation: "",
    apply: false,
    selfTest: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("-") && !options.command) {
      options.command = argument;
    } else if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--self-test") {
      options.selfTest = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--account-id" || argument.startsWith("--account-id=")) {
      [options.accountId, index] = readOption(argv, index, "--account-id");
    } else if (argument === "--namespace" || argument.startsWith("--namespace=")) {
      [options.namespace, index] = readOption(argv, index, "--namespace");
    } else if (argument === "--target" || argument.startsWith("--target=")) {
      [options.target, index] = readOption(argv, index, "--target");
    } else if (
      argument === "--database-url-env" ||
      argument.startsWith("--database-url-env=")
    ) {
      [options.databaseUrlEnv, index] = readOption(argv, index, "--database-url-env");
    } else if (argument === "--reason" || argument.startsWith("--reason=")) {
      [options.reason, index] = readOption(argv, index, "--reason");
    } else if (argument === "--operator-id" || argument.startsWith("--operator-id=")) {
      [options.operatorId, index] = readOption(argv, index, "--operator-id");
    } else if (argument === "--expires-at" || argument.startsWith("--expires-at=")) {
      [options.expiresAt, index] = readOption(argv, index, "--expires-at");
    } else if (argument === "--max-moves" || argument.startsWith("--max-moves=")) {
      let rawValue;
      [rawValue, index] = readOption(argv, index, "--max-moves");
      options.maxMoves = /^\d+$/.test(rawValue) ? Number(rawValue) : Number.NaN;
    } else if (
      argument === "--confirm-production" ||
      argument.startsWith("--confirm-production=")
    ) {
      [options.confirmation, index] = readOption(argv, index, "--confirm-production");
    } else {
      throw new CliError("Unknown argument. Use --help for supported options.");
    }
  }

  if (options.selfTest || options.help) return options;
  if (!new Set(["view", "clear", "override"]).has(options.command)) {
    throw new CliError("Choose exactly one command: view, clear, or override.");
  }
  if (!isUuid(options.accountId)) {
    throw new CliError("Every command requires an explicit UUID --account-id selector.");
  }
  if (!new Set(["production", "test"]).has(options.namespace)) {
    throw new CliError("Set --namespace to production or test.");
  }
  if (!new Set(["production", "preview", "development", "test"]).has(options.target)) {
    throw new CliError(
      "Set --target to production, preview, development, or test so the database environment is explicit.",
    );
  }

  if (options.command === "view") {
    if (options.apply) throw new CliError("The view command is always read-only; remove --apply.");
    return options;
  }

  if (!options.apply) throw new CliError(`${options.command} requires --apply.`);
  if (!options.databaseUrlEnv) {
    throw new CliError("Mutations require --database-url-env with a non-pooling URL variable.");
  }
  if (!SUPPORT_REASONS.includes(options.reason)) {
    throw new CliError(`Set --reason to one of: ${SUPPORT_REASONS.join(", ")}.`);
  }
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(options.operatorId)) {
    throw new CliError(
      "Set --operator-id to a 3-64 character lowercase support identifier without an email address.",
    );
  }
  if (options.target === "production" && options.confirmation !== PRODUCTION_CONFIRMATION) {
    throw new CliError(
      `Production mutation requires --confirm-production ${PRODUCTION_CONFIRMATION}.`,
    );
  }

  if (options.command === "override") {
    validateOverrideInput(options, nowMs);
  } else if (options.maxMoves !== null || options.expiresAt) {
    throw new CliError("--max-moves and --expires-at are valid only for override.");
  }
  return options;
}

export function validateOverrideInput(options, nowMs = Date.now()) {
  if (!Number.isSafeInteger(options.maxMoves) || options.maxMoves < 1 || options.maxMoves > MAX_TRANSFER_LIMIT) {
    throw new CliError(`--max-moves must be an integer from 1 through ${MAX_TRANSFER_LIMIT}.`);
  }
  const expiresAtMs = new Date(options.expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    throw new CliError("--expires-at must be a future ISO-8601 timestamp.");
  }
  if (expiresAtMs > nowMs + MAX_OVERRIDE_DURATION_MS) {
    throw new CliError("A transfer-limit override may last at most 30 days.");
  }
  options.expiresAt = new Date(expiresAtMs).toISOString();
  return options;
}

export function resolveDatabaseSelection(environment, options) {
  const requestedName = options.databaseUrlEnv?.trim() || "";
  let name = requestedName;
  if (name && !POSTGRES_URL_ENV_NAMES.includes(name)) {
    throw new CliError("Unsupported database URL environment variable name.");
  }
  if (!name) {
    name = POSTGRES_URL_ENV_NAMES.find((candidate) => isConfiguredValue(environment[candidate])) || "";
  }
  if (!name || !isConfiguredValue(environment[name])) {
    throw new CliError(
      requestedName
        ? "The selected database URL environment variable is not configured."
        : `Missing Postgres connection string. Set one of: ${POSTGRES_URL_ENV_NAMES.join(", ")}.`,
    );
  }

  const connectionString = environment[name].trim();
  if (options.command !== "view") {
    if (!requestedName || !DIRECT_POSTGRES_URL_ENV_NAMES.includes(name)) {
      throw new CliError(
        "Mutations refuse pooled/runtime URLs; select an explicit *_URL_NON_POOLING variable.",
      );
    }
    if (isPooledConnectionString(connectionString)) {
      throw new CliError(`${name} resolves to a pooled/runtime endpoint; mutation refused.`);
    }
  }
  return { name, connectionString };
}

export function countConfirmedMoves({ devices, transfers = [], nowMs }) {
  if (!Number.isFinite(nowMs)) throw new TypeError("nowMs must be a finite timestamp");
  const orderedDevices = [...devices]
    .filter((device) => /^[0-9a-f]{64}$/.test(device.deviceIdHash || ""))
    .filter((device) => Number.isFinite(timestampMs(device.activatedAt)))
    .sort((left, right) => {
      const difference = timestampMs(left.activatedAt) - timestampMs(right.activatedAt);
      return difference || String(left.id).localeCompare(String(right.id));
    });
  const devicesById = new Map(orderedDevices.map((device) => [device.id, device]));
  const movesByDestination = new Map();

  let previousHash = null;
  for (const device of orderedDevices) {
    if (previousHash !== null && previousHash !== device.deviceIdHash) {
      movesByDestination.set(device.id, timestampMs(device.activatedAt));
    }
    previousHash = device.deviceIdHash;
  }

  for (const transfer of transfers) {
    const fromDevice = devicesById.get(transfer.fromDeviceId);
    const toDevice = devicesById.get(transfer.toDeviceId);
    const transferredAtMs = timestampMs(transfer.transferredAt);
    if (
      fromDevice &&
      toDevice &&
      fromDevice.deviceIdHash !== toDevice.deviceIdHash &&
      Number.isFinite(transferredAtMs)
    ) {
      movesByDestination.set(transfer.toDeviceId, transferredAtMs);
    }
  }

  const windowStartedAtMs = nowMs - TRANSFER_WINDOW_MS;
  const confirmedMoveCount = [...movesByDestination.values()].filter(
    (timestamp) => timestamp >= windowStartedAtMs && timestamp <= nowMs,
  ).length;
  return { confirmedMoveCount, windowStartedAtMs };
}

export function readTransferLimitOverride(features, nowMs, namespace = "production") {
  const policy = isPlainObject(features?.singleDevicePolicy)
    ? features.singleDevicePolicy
    : {};
  const overrides = isPlainObject(policy.transferLimitOverrides)
    ? policy.transferLimitOverrides
    : {};
  const override = isPlainObject(overrides[namespace])
    ? overrides[namespace]
    : null;
  if (!override) return null;

  const expiresAtMs = new Date(override.expiresAt).getTime();
  if (
    !Number.isSafeInteger(override.limit) ||
    override.limit < 1 ||
    override.limit > MAX_TRANSFER_LIMIT ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= nowMs
  ) {
    return null;
  }
  return {
    limit: override.limit,
    expiresAt: new Date(expiresAtMs).toISOString(),
    reason: SUPPORT_REASONS.includes(override.reason) ? override.reason : "support_recovery",
  };
}

export function evaluateTransferState({ devices, transfers, features, namespace = "production", nowMs }) {
  const { confirmedMoveCount, windowStartedAtMs } = countConfirmedMoves({
    devices,
    transfers,
    nowMs,
  });
  const override = readTransferLimitOverride(features, nowMs, namespace);
  const limit = override?.limit || DEFAULT_TRANSFER_LIMIT;
  return {
    allowed: confirmedMoveCount < limit,
    confirmedMoveCount,
    limit,
    remainingMoves: Math.max(0, limit - confirmedMoveCount),
    windowStartedAt: new Date(windowStartedAtMs).toISOString(),
    override,
  };
}

export function buildSupportFeatureUpdate(features, mutation, nowIso) {
  const root = normalizeFeatures(features);
  const existingPolicy = isPlainObject(root.singleDevicePolicy)
    ? root.singleDevicePolicy
    : {};
  const auditLog = Array.isArray(existingPolicy.supportAudit)
    ? [...existingPolicy.supportAudit]
    : [];
  const eventKey = supportEventKey(mutation);

  if (
    mutation.action === "clear" &&
    auditLog.some((entry) => isPlainObject(entry) && entry.eventKey === eventKey)
  ) {
    return { changed: false, features: root, eventKey };
  }

  if (mutation.action === "override") {
    const overrides = isPlainObject(existingPolicy.transferLimitOverrides)
      ? existingPolicy.transferLimitOverrides
      : {};
    const current = overrides[mutation.namespace];
    if (
      isPlainObject(current) &&
      current.limit === mutation.limit &&
      current.expiresAt === mutation.expiresAt &&
      current.reason === mutation.reason &&
      current.operatorId === mutation.operatorId
    ) {
      return { changed: false, features: root, eventKey };
    }
  }

  const event = {
    eventKey,
    action: mutation.action === "clear" ? "clear_binding" : "transfer_limit_override",
    namespace: mutation.namespace,
    reason: mutation.reason,
    operatorId: mutation.operatorId,
    recordedAt: nowIso,
  };
  if (mutation.action === "override") {
    event.limit = mutation.limit;
    event.expiresAt = mutation.expiresAt;
  }
  if (!auditLog.some((entry) => isPlainObject(entry) && entry.eventKey === eventKey)) {
    auditLog.push(event);
  }

  const nextPolicy = {
    ...existingPolicy,
    version: 1,
    supportAudit: auditLog,
  };
  if (mutation.action === "override") {
    nextPolicy.transferLimitOverrides = {
      ...(isPlainObject(existingPolicy.transferLimitOverrides)
        ? existingPolicy.transferLimitOverrides
        : {}),
      [mutation.namespace]: {
        limit: mutation.limit,
        expiresAt: mutation.expiresAt,
        reason: mutation.reason,
        operatorId: mutation.operatorId,
        recordedAt: nowIso,
        auditKey: eventKey,
      },
    };
  }

  return {
    changed: true,
    eventKey,
    features: { ...root, singleDevicePolicy: nextPolicy },
  };
}

export function buildSafeDeviceState(state, { nowMs, actionStatus = "viewed" } = {}) {
  const transferState = evaluateTransferState({
    devices: state.devices,
    transfers: state.transfers,
    features: state.license?.features || {},
    namespace: state.namespace,
    nowMs,
  });
  const activeDevice = state.devices.find((device) => !device.revokedAt) || null;
  return {
    accountRef: safeReference("account", state.accountId),
    namespace: state.namespace,
    actionStatus,
    activeDevice: activeDevice
      ? {
          deviceRef: safeReference("device", activeDevice.deviceIdHash),
          platform: activeDevice.platform,
          activatedAt: toIsoString(activeDevice.activatedAt),
          lastSeenAt: toIsoString(activeDevice.lastSeenAt),
        }
      : null,
    lifecycleRecordCount: state.devices.length,
    confirmedMoves30Days: transferState.confirmedMoveCount,
    transferLimit: transferState.limit,
    remainingMoves: transferState.remainingMoves,
    moveAllowed: transferState.allowed,
    windowStartedAt: transferState.windowStartedAt,
    transferLimitOverride: transferState.override,
    supportAuditEntries: getSupportAuditCount(state.license?.features),
  };
}

export async function withTransaction(client, { readOnly }, callback) {
  await client.query(
    readOnly
      ? "begin transaction isolation level repeatable read read only"
      : "begin transaction isolation level serializable read write",
  );
  try {
    const result = await callback();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function runSupportCommand(pool, options) {
  const client = await pool.connect();
  try {
    return await withTransaction(client, { readOnly: options.command === "view" }, async () => {
      if (options.command !== "view") {
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [
          `sidestream:device-support:${options.accountId}:${options.namespace}`,
        ]);
      }
      const nowResult = await client.query("select transaction_timestamp() as now");
      const nowIso = toIsoString(nowResult.rows[0].now);
      const nowMs = new Date(nowIso).getTime();
      const state = await loadSupportState(client, options, options.command !== "view");

      if (options.command === "view") {
        return buildSafeDeviceState(state, { nowMs });
      }
      if (!state.license) {
        throw new CliError("The selected account has no license row available for support audit metadata.");
      }
      if (options.command === "clear") {
        return clearBinding(client, state, options, nowIso, nowMs);
      }
      return recordOverride(client, state, options, nowIso, nowMs);
    });
  } finally {
    client.release();
  }
}

async function loadSupportState(client, options, lockRows) {
  const lockClause = lockRows ? " for update" : "";
  const accountResult = await client.query(`${SUPPORT_READ_QUERIES.account}${lockClause}`, [
    options.accountId,
  ]);
  if (!accountResult.rows[0]) throw new CliError("No account matches the supplied selector.");

  const deviceResult = await client.query(`${SUPPORT_READ_QUERIES.devices}${lockClause}`, [
    options.accountId,
    options.namespace,
  ]);
  const transferResult = await client.query(SUPPORT_READ_QUERIES.transfers, [
    options.accountId,
    options.namespace,
  ]);
  const licenseResult = await client.query(`${SUPPORT_READ_QUERIES.license}${lockClause}`, [
    options.accountId,
  ]);

  return {
    accountId: options.accountId,
    namespace: options.namespace,
    devices: deviceResult.rows.map(mapDeviceRow),
    transfers: transferResult.rows.map((row) => ({
      fromDeviceId: row.from_device_id,
      toDeviceId: row.to_device_id,
      transferredAt: row.transferred_at,
    })),
    license: licenseResult.rows[0]
      ? { id: licenseResult.rows[0].id, features: licenseResult.rows[0].features || {} }
      : null,
  };
}

async function clearBinding(client, state, options, nowIso, nowMs) {
  const activeDevice = state.devices.find((device) => !device.revokedAt);
  if (!activeDevice) {
    return buildSafeDeviceState(state, { nowMs, actionStatus: "already_clear" });
  }

  const featureUpdate = buildSupportFeatureUpdate(state.license.features, {
    action: "clear",
    accountId: state.accountId,
    namespace: state.namespace,
    bindingId: activeDevice.id,
    reason: options.reason,
    operatorId: options.operatorId,
  }, nowIso);
  const deviceUpdate = await client.query(UPDATE_DEVICE_QUERY, [activeDevice.id, nowIso]);
  if (deviceUpdate.rowCount !== 1) {
    throw new CliError("The binding changed concurrently; no support mutation was committed.");
  }
  await client.query(REVOKE_DEVICE_TOKENS_QUERY, [
    state.accountId,
    activeDevice.deviceIdHash,
    nowIso,
  ]);
  if (featureUpdate.changed) {
    await client.query(UPDATE_LICENSE_FEATURES_QUERY, [
      state.license.id,
      JSON.stringify(featureUpdate.features),
      nowIso,
    ]);
  }

  activeDevice.revokedAt = nowIso;
  activeDevice.revocationReason = "deactivated";
  state.license.features = featureUpdate.features;
  return buildSafeDeviceState(state, { nowMs, actionStatus: "cleared" });
}

async function recordOverride(client, state, options, nowIso, nowMs) {
  const featureUpdate = buildSupportFeatureUpdate(state.license.features, {
    action: "override",
    accountId: state.accountId,
    namespace: state.namespace,
    reason: options.reason,
    operatorId: options.operatorId,
    limit: options.maxMoves,
    expiresAt: options.expiresAt,
  }, nowIso);
  if (!featureUpdate.changed) {
    return buildSafeDeviceState(state, { nowMs, actionStatus: "override_unchanged" });
  }
  await client.query(UPDATE_LICENSE_FEATURES_QUERY, [
    state.license.id,
    JSON.stringify(featureUpdate.features),
    nowIso,
  ]);
  state.license.features = featureUpdate.features;
  return buildSafeDeviceState(state, { nowMs, actionStatus: "override_recorded" });
}

function mapDeviceRow(row) {
  return {
    id: row.id,
    deviceIdHash: row.device_id_hash,
    platform: row.platform,
    activatedAt: row.activated_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason,
  };
}

function supportEventKey(mutation) {
  const parts = mutation.action === "clear"
    ? [mutation.action, mutation.accountId, mutation.namespace, mutation.bindingId]
    : [
        mutation.action,
        mutation.accountId,
        mutation.namespace,
        mutation.limit,
        mutation.expiresAt,
        mutation.reason,
        mutation.operatorId,
      ];
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}

function normalizeFeatures(features) {
  return isPlainObject(features) ? JSON.parse(JSON.stringify(features)) : {};
}

function getSupportAuditCount(features) {
  const policy = isPlainObject(features?.singleDevicePolicy)
    ? features.singleDevicePolicy
    : {};
  return Array.isArray(policy.supportAudit) ? policy.supportAudit.length : 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeReference(kind, value) {
  const digest = createHash("sha256").update(`${kind}\0${String(value)}`).digest("hex");
  return `${kind === "account" ? "acct" : "dev"}_${digest.slice(0, 12)}`;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isPooledConnectionString(connectionString) {
  try {
    const url = new URL(connectionString);
    return url.hostname.toLowerCase().includes("pooler") ||
      url.hostname.toLowerCase().includes("-pool") ||
      url.port === "6543" ||
      /^(1|true)$/i.test(url.searchParams.get("pgbouncer") || "") ||
      url.searchParams.has("connection_limit");
  } catch {
    return true;
  }
}

function timestampMs(value) {
  return new Date(value).getTime();
}

function toIsoString(value) {
  const timestamp = timestampMs(value);
  if (!Number.isFinite(timestamp)) throw new CliError("Database state contains an invalid timestamp.");
  return new Date(timestamp).toISOString();
}

function readOption(argv, index, name) {
  const argument = argv[index];
  const inlinePrefix = `${name}=`;
  if (argument.startsWith(inlinePrefix)) {
    const value = argument.slice(inlinePrefix.length).trim();
    if (!value) throw new CliError(`${name} requires a value.`);
    return [value, index];
  }
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new CliError(`${name} requires a value.`);
  return [value, index + 1];
}

function isConfiguredValue(value) {
  return typeof value === "string" && value.trim() &&
    !value.includes("[YOUR-") && value.trim() !== "changeme";
}

function loadEnvFile(filePath) {
  if (!filePath) return;
  const absolutePath = path.resolve(filePath);
  let contents;
  try {
    contents = fs.readFileSync(absolutePath, "utf8");
  } catch {
    throw new CliError(`Could not read environment file ${absolutePath}.`);
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
}

async function createPool(connectionString) {
  const { Pool } = await import("pg");
  const normalized = normalizeConnectionString(connectionString);
  return new Pool({
    connectionString: normalized,
    max: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    ssl: shouldUseSsl(normalized) ? { rejectUnauthorized: false } : false,
  });
}

function normalizeConnectionString(connectionString) {
  try {
    const url = new URL(connectionString);
    if (/^(prefer|require)$/i.test(url.searchParams.get("sslmode") || "")) {
      url.searchParams.delete("sslmode");
    }
    return url.toString();
  } catch {
    throw new CliError("The selected database URL is invalid.");
  }
}

function shouldUseSsl(connectionString) {
  if (process.env.POSTGRES_SSL === "0") return false;
  if (/sslmode=(disable|false)/i.test(connectionString)) return false;
  return !/localhost|127\.0\.0\.1|::1/.test(connectionString);
}

export function runSelfTest() {
  const nowMs = Date.UTC(2026, 6, 14, 20);
  const accountId = "00000000-0000-4000-8000-000000000001";
  const deviceA = "a".repeat(64);
  const deviceB = "b".repeat(64);
  const devices = [
    { id: "a1", deviceIdHash: deviceA, activatedAt: nowMs - 4_000, revokedAt: nowMs - 3_000 },
    { id: "a2", deviceIdHash: deviceA, activatedAt: nowMs - 3_000, revokedAt: nowMs - 2_000 },
    { id: "b1", deviceIdHash: deviceB, activatedAt: nowMs - 1_000, revokedAt: null },
  ];
  assert.equal(countConfirmedMoves({ devices, nowMs }).confirmedMoveCount, 1);

  const mutation = {
    action: "override",
    accountId,
    namespace: "production",
    reason: "support_recovery",
    operatorId: "support.agent",
    limit: 5,
    expiresAt: new Date(nowMs + 60_000).toISOString(),
  };
  const first = buildSupportFeatureUpdate({}, mutation, new Date(nowMs).toISOString());
  const replay = buildSupportFeatureUpdate(first.features, mutation, new Date(nowMs + 1).toISOString());
  assert.equal(first.changed, true);
  assert.equal(replay.changed, false);
  assert.equal(readTransferLimitOverride(first.features, nowMs, "production").limit, 5);
  assert.equal(readTransferLimitOverride(first.features, nowMs, "test"), null);

  const safeJson = JSON.stringify(buildSafeDeviceState({
    accountId,
    namespace: "production",
    devices: [{
      ...devices[2],
      platform: "macos",
      appVersion: "1.0.14",
      lastSeenAt: nowMs,
    }],
    transfers: [],
    license: { features: first.features },
  }, { nowMs }));
  for (const secret of [accountId, deviceA, deviceB, "person@example.com", "postgres://secret"]) {
    assert.equal(safeJson.includes(secret), false);
  }
  return true;
}

function printUsage() {
  console.log(`Usage:
  node scripts/manage-license-device.mjs view --account-id <uuid> --namespace <production|test> --target <environment>
  node scripts/manage-license-device.mjs clear --account-id <uuid> --namespace <production|test> \\
    --target <environment> --reason <code> --operator-id <id> --apply --database-url-env <*_URL_NON_POOLING>
  node scripts/manage-license-device.mjs override --account-id <uuid> --namespace <production|test> \\
    --target <environment> --max-moves <1-10> --expires-at <ISO timestamp> \\
    --reason <code> --operator-id <id> --apply --database-url-env <*_URL_NON_POOLING>

Production mutations also require --confirm-production ${PRODUCTION_CONFIRMATION}.
Allowed reasons: ${SUPPORT_REASONS.join(", ")}.`);
}

async function main() {
  try {
    const options = parseManageArgs(process.argv.slice(2));
    if (options.help) {
      printUsage();
      return;
    }
    if (options.selfTest) {
      runSelfTest();
      console.log("manage-license-device self-test: ok");
      return;
    }

    loadEnvFile(process.env.SIDESTREAM_ENV_FILE);
    loadEnvFile(process.env.SIDESTREAM_DB_ENV_FILE);
    const database = resolveDatabaseSelection(process.env, options);
    const pool = await createPool(database.connectionString);
    try {
      const result = await runSupportCommand(pool, options);
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await pool.end();
    }
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`manage-license-device: ${error.message}`);
    } else {
      const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,12}$/.test(error.code)
        ? ` (${error.code})`
        : "";
      console.error(`manage-license-device: database operation failed${code}.`);
    }
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) await main();

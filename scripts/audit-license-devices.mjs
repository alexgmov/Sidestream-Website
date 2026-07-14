import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PRODUCTION_CONFIRMATION = "BACKFILL-PRODUCTION-DEVICES";

export const POSTGRES_URL_ENV_NAMES = [
  "SIDESTREAM_POSTGRES_URL",
  "SIDESTREAM_POSTGRES_PRISMA_URL",
  "SIDESTREAM_POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
];

export const DIRECT_POSTGRES_URL_ENV_NAMES = [
  "SIDESTREAM_POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL_NON_POOLING",
];

export const AUDIT_READ_QUERIES = Object.freeze({
  accounts: `
    select id as account_id
    from public.sidestream_accounts
    order by id asc
  `,
  candidates: `
    select
      t.account_id,
      t.device_id_hash,
      min(t.created_at) as activated_at,
      max(coalesce(t.last_seen_at, t.updated_at, t.created_at)) as last_seen_at,
      (array_agg(
        a.app_version
        order by coalesce(t.last_seen_at, t.updated_at, t.created_at) desc, t.id desc
      ) filter (where a.app_version is not null))[1] as app_version,
      (array_agg(
        a.build_channel
        order by coalesce(t.last_seen_at, t.updated_at, t.created_at) desc, t.id desc
      ) filter (where a.build_channel is not null))[1] as build_channel
    from public.sidestream_license_tokens t
    left join public.sidestream_activation_sessions a
      on a.id = t.activation_session_id
    where t.revoked_at is null
      and t.device_id_hash ~ '^[0-9a-f]{64}$'
    group by t.account_id, t.device_id_hash
    order by t.account_id asc, last_seen_at desc, t.device_id_hash asc
  `,
  activeBindings: `
    select account_id, id as binding_id, device_id_hash
    from public.sidestream_account_devices
    where license_namespace = 'production'
      and revoked_at is null
    order by account_id asc
  `,
});

const BACKFILL_INSERT_QUERY = `
  insert into public.sidestream_account_devices (
    account_id,
    license_namespace,
    device_id_hash,
    platform,
    app_version,
    build_channel,
    activated_at,
    last_seen_at
  )
  select
    $1,
    'production',
    $2,
    'unknown',
    $3,
    $4,
    $5::timestamptz,
    $6::timestamptz
  where not exists (
    select 1
    from public.sidestream_account_devices
    where account_id = $1
      and license_namespace = 'production'
      and revoked_at is null
  )
  on conflict do nothing
  returning id
`;

class CliError extends Error {}

export function parseAuditArgs(argv) {
  const options = {
    apply: false,
    selfTest: false,
    help: false,
    target: "",
    databaseUrlEnv: "",
    confirmation: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--self-test") {
      options.selfTest = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--target" || argument.startsWith("--target=")) {
      [options.target, index] = readOption(argv, index, "--target");
    } else if (
      argument === "--database-url-env" ||
      argument.startsWith("--database-url-env=")
    ) {
      [options.databaseUrlEnv, index] = readOption(argv, index, "--database-url-env");
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
  if (!new Set(["production", "preview", "development", "test"]).has(options.target)) {
    throw new CliError(
      "Set --target to production, preview, development, or test so the database environment is explicit.",
    );
  }
  if (options.apply && !options.databaseUrlEnv) {
    throw new CliError("Apply mode requires --database-url-env with a non-pooling URL variable.");
  }
  if (options.apply && options.target === "production" && options.confirmation !== PRODUCTION_CONFIRMATION) {
    throw new CliError(
      `Production apply requires --confirm-production ${PRODUCTION_CONFIRMATION}.`,
    );
  }
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
  if (options.apply) {
    if (!requestedName || !DIRECT_POSTGRES_URL_ENV_NAMES.includes(name)) {
      throw new CliError(
        "Apply mode refuses pooled/runtime URLs; select an explicit *_URL_NON_POOLING variable.",
      );
    }
    if (isPooledConnectionString(connectionString)) {
      throw new CliError(
        `Apply mode rejected ${name} because it resolves to a pooled/runtime endpoint.`,
      );
    }
  }

  return { name, connectionString };
}

export function isPooledConnectionString(connectionString) {
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

export function classifyAuditAccounts(accounts, { apply = false } = {}) {
  return accounts.map((account) => {
    const candidates = uniqueCandidates(account.candidates || []);
    const candidateCount = candidates.length;
    const category = candidateCount === 0 ? "zero" : candidateCount === 1 ? "one" : "multiple";
    const mayBackfill = !account.activeBinding && candidateCount > 0;
    const selectedCandidate = apply && mayBackfill
      ? [...candidates].sort(compareCandidates)[0]
      : null;

    return {
      accountId: account.accountId,
      activeBinding: account.activeBinding || null,
      candidates,
      candidateCount,
      category,
      mayBackfill,
      selectedCandidate,
      applyStatus: "not_attempted",
    };
  });
}

export function buildSafeAuditReport(classifiedAccounts, { apply = false, target = "unknown" } = {}) {
  const summary = {
    accounts: classifiedAccounts.length,
    zero: 0,
    one: 0,
    multiple: 0,
    activeBindings: 0,
    eligibleForBackfill: 0,
    inserted: 0,
  };

  const accounts = classifiedAccounts.map((account) => {
    summary[account.category] += 1;
    if (account.activeBinding) summary.activeBindings += 1;
    if (account.mayBackfill) summary.eligibleForBackfill += 1;
    if (account.applyStatus === "inserted") summary.inserted += 1;

    const safeAccount = {
      accountRef: safeReference("account", account.accountId),
      candidateState: account.category,
      candidateCount: account.candidateCount,
      activeBindingPresent: Boolean(account.activeBinding),
      eligibleForBackfill: account.mayBackfill,
    };
    if (apply) {
      safeAccount.applyStatus = account.applyStatus;
      if (account.selectedCandidate) {
        safeAccount.selectedDeviceRef = safeReference(
          "device",
          account.selectedCandidate.deviceIdHash,
        );
        safeAccount.selectedLastSeenAt = toIsoString(account.selectedCandidate.lastSeenAt);
      }
    }
    return safeAccount;
  });

  return {
    mode: apply ? "apply" : "read_only",
    target,
    licenseNamespace: "production",
    summary,
    accounts,
  };
}

export function safeReference(kind, value) {
  const digest = createHash("sha256").update(`${kind}\0${String(value)}`).digest("hex");
  return `${kind === "account" ? "acct" : "dev"}_${digest.slice(0, 12)}`;
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

async function runAudit(pool, options) {
  const client = await pool.connect();
  try {
    return await withTransaction(client, { readOnly: !options.apply }, async () => {
      if (options.apply) {
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [
          "sidestream:production-device-backfill:v1",
        ]);
      }

      const accounts = await loadAuditAccounts(client);
      const classified = classifyAuditAccounts(accounts, { apply: options.apply });

      if (options.apply) {
        for (const account of classified) {
          if (!account.selectedCandidate) {
            account.applyStatus = account.activeBinding ? "already_bound" : "no_candidate";
            continue;
          }
          const candidate = account.selectedCandidate;
          const inserted = await client.query(BACKFILL_INSERT_QUERY, [
            account.accountId,
            candidate.deviceIdHash,
            normalizeAppVersion(candidate.appVersion),
            normalizeBuildChannel(candidate.buildChannel),
            toIsoString(candidate.activatedAt),
            toIsoString(candidate.lastSeenAt),
          ]);
          account.applyStatus = inserted.rowCount === 1 ? "inserted" : "already_bound";
        }
      }

      return buildSafeAuditReport(classified, options);
    });
  } finally {
    client.release();
  }
}

async function loadAuditAccounts(client) {
  const [accountResult, candidateResult, activeResult] = await Promise.all([
    client.query(AUDIT_READ_QUERIES.accounts),
    client.query(AUDIT_READ_QUERIES.candidates),
    client.query(AUDIT_READ_QUERIES.activeBindings),
  ]);

  const byAccount = new Map(accountResult.rows.map((row) => [
    row.account_id,
    { accountId: row.account_id, candidates: [], activeBinding: null },
  ]));
  for (const row of candidateResult.rows) {
    const account = byAccount.get(row.account_id);
    if (!account) continue;
    account.candidates.push({
      deviceIdHash: row.device_id_hash,
      activatedAt: row.activated_at,
      lastSeenAt: row.last_seen_at,
      appVersion: row.app_version,
      buildChannel: row.build_channel,
    });
  }
  for (const row of activeResult.rows) {
    const account = byAccount.get(row.account_id);
    if (!account) continue;
    account.activeBinding = {
      bindingId: row.binding_id,
      deviceIdHash: row.device_id_hash,
    };
  }
  return [...byAccount.values()];
}

function uniqueCandidates(candidates) {
  const unique = new Map();
  for (const candidate of candidates) {
    if (!/^[0-9a-f]{64}$/.test(candidate.deviceIdHash || "")) continue;
    const existing = unique.get(candidate.deviceIdHash);
    if (!existing || compareCandidates(candidate, existing) < 0) {
      unique.set(candidate.deviceIdHash, candidate);
    }
  }
  return [...unique.values()];
}

function compareCandidates(left, right) {
  const timeDifference = timestampMs(right.lastSeenAt) - timestampMs(left.lastSeenAt);
  if (timeDifference !== 0) return timeDifference;
  return left.deviceIdHash.localeCompare(right.deviceIdHash);
}

function normalizeAppVersion(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(normalized) ? normalized : null;
}

function normalizeBuildChannel(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/.test(normalized) ? normalized : null;
}

function timestampMs(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function toIsoString(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw new CliError("A candidate has an invalid timestamp.");
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
  const firstHash = "a".repeat(64);
  const secondHash = "b".repeat(64);
  const accounts = [
    { accountId: "00000000-0000-4000-8000-000000000001", candidates: [] },
    {
      accountId: "00000000-0000-4000-8000-000000000002",
      candidates: [{
        deviceIdHash: firstHash,
        activatedAt: "2026-07-01T00:00:00.000Z",
        lastSeenAt: "2026-07-02T00:00:00.000Z",
      }],
    },
    {
      accountId: "00000000-0000-4000-8000-000000000003",
      candidates: [
        {
          deviceIdHash: firstHash,
          activatedAt: "2026-07-01T00:00:00.000Z",
          lastSeenAt: "2026-07-02T00:00:00.000Z",
        },
        {
          deviceIdHash: secondHash,
          activatedAt: "2026-07-03T00:00:00.000Z",
          lastSeenAt: "2026-07-04T00:00:00.000Z",
        },
      ],
    },
  ];

  const observed = classifyAuditAccounts(accounts);
  assert.deepEqual(observed.map((entry) => entry.category), ["zero", "one", "multiple"]);
  assert.ok(observed.every((entry) => entry.selectedCandidate === null));

  const applied = classifyAuditAccounts(accounts, { apply: true });
  assert.equal(applied[2].selectedCandidate.deviceIdHash, secondHash);
  const safeJson = JSON.stringify(buildSafeAuditReport(observed));
  for (const secret of [accounts[0].accountId, firstHash, secondHash, "person@example.com", "postgres://secret"]) {
    assert.equal(safeJson.includes(secret), false);
  }

  assert.throws(
    () => resolveDatabaseSelection(
      { POSTGRES_URL_NON_POOLING: "postgres://db.example:6543/app" },
      { apply: true, databaseUrlEnv: "POSTGRES_URL_NON_POOLING" },
    ),
    /pooled\/runtime endpoint/,
  );
  return true;
}

function printUsage() {
  console.log(`Usage:
  node scripts/audit-license-devices.mjs --target <environment> [--database-url-env <name>]
  node scripts/audit-license-devices.mjs --target <environment> --apply \\
    --database-url-env <*_URL_NON_POOLING> [--confirm-production ${PRODUCTION_CONFIRMATION}]

Default mode is read-only. Apply backfills one production binding per eligible account.`);
}

async function main() {
  try {
    const options = parseAuditArgs(process.argv.slice(2));
    if (options.help) {
      printUsage();
      return;
    }
    if (options.selfTest) {
      runSelfTest();
      console.log("audit-license-devices self-test: ok");
      return;
    }

    loadEnvFile(process.env.SIDESTREAM_ENV_FILE);
    loadEnvFile(process.env.SIDESTREAM_DB_ENV_FILE);
    const database = resolveDatabaseSelection(process.env, options);
    const pool = await createPool(database.connectionString);
    try {
      const report = await runAudit(pool, options);
      console.log(JSON.stringify(report, null, 2));
    } finally {
      await pool.end();
    }
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`audit-license-devices: ${error.message}`);
    } else {
      const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,12}$/.test(error.code)
        ? ` (${error.code})`
        : "";
      console.error(`audit-license-devices: database operation failed${code}.`);
    }
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) await main();

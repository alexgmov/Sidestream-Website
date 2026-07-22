#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const VERCEL_PATH = "/opt/homebrew/bin/vercel";
const NPX_PATH = "/opt/homebrew/bin/npx";
const PSQL_PATH = "/opt/homebrew/bin/psql";
const MIGRATION_RELATIVE_PATH =
  "db/migrations/20260714190000_add_single_active_account_devices.sql";
const MIGRATION_SHA256 =
  "030ba613aa8eb72ddbebdf9d431f0bc1f24efd7c3836592e611f74717821db94";
const APPLY_CONFIRMATION = "--confirm-production-device-schema";
const EXPECTED_VERCEL_PROJECT = Object.freeze({
  projectId: "prj_x9sRcnoAAfF6VPxseJYLBgxhhPyh",
  orgId: "team_ZcKImJwvlcCrE15nTEOWT2NC",
  projectName: "sidestream",
});
const EXPECTED_NEON_RESOURCE = Object.freeze({
  storeId: "store_y3hmEgLPHG5Fgb7D",
  storeName: "neon-purple-island",
  externalResourceId: "dark-butterfly-59697025",
  branchName: "main",
  roleName: "neondb_owner",
  databaseName: "neondb",
});
const NEONCTL_VERSION = "2.35.2";
const CONNECTION_SELECTORS = Object.freeze([
  "STORAGE_POSTGRES_URL_NON_POOLING",
  "STORAGE_DATABASE_URL_UNPOOLED",
  "SIDESTREAM_POSTGRES_URL",
]);
const PULLED_ENV_ALLOWLIST = new Set([
  ...CONNECTION_SELECTORS,
  "SIDESTREAM_DEVICE_POLICY_MODE",
]);

const DEVICE_COLUMNS = `[
  ["id", "uuid", true, "gen_random_uuid()"],
  ["account_id", "uuid", true, ""],
  ["license_namespace", "text", true, ""],
  ["device_id_hash", "text", true, ""],
  ["platform", "text", true, ""],
  ["app_version", "text", false, ""],
  ["build_channel", "text", false, ""],
  ["activated_at", "timestamp with time zone", true, "now()"],
  ["last_seen_at", "timestamp with time zone", true, "now()"],
  ["revoked_at", "timestamp with time zone", false, ""],
  ["revocation_reason", "text", false, ""]
]`;

const TRANSFER_COLUMNS = `[
  ["id", "uuid", true, "gen_random_uuid()"],
  ["account_id", "uuid", true, ""],
  ["license_namespace", "text", true, ""],
  ["from_device_id", "uuid", true, ""],
  ["to_device_id", "uuid", true, ""],
  ["initiated_by", "text", true, ""],
  ["transfer_reason", "text", true, ""],
  ["transferred_at", "timestamp with time zone", true, "now()"]
]`;

const DEVICE_CONSTRAINTS = `[
  ["sidestream_account_devices_account_id_fkey", "f", "FOREIGN KEY (account_id) REFERENCES sidestream_accounts(id) ON DELETE CASCADE"],
  ["sidestream_account_devices_app_version_valid", "c", "CHECK (app_version IS NULL OR app_version ~ '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$'::text)"],
  ["sidestream_account_devices_build_channel_valid", "c", "CHECK (build_channel IS NULL OR build_channel ~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$'::text)"],
  ["sidestream_account_devices_hash_valid", "c", "CHECK (device_id_hash ~ '^[0-9a-f]{64}$'::text)"],
  ["sidestream_account_devices_identity_unique", "u", "UNIQUE (id, account_id, license_namespace)"],
  ["sidestream_account_devices_namespace_valid", "c", "CHECK (license_namespace = ANY (ARRAY['production'::text, 'test'::text]))"],
  ["sidestream_account_devices_pkey", "p", "PRIMARY KEY (id)"],
  ["sidestream_account_devices_platform_valid", "c", "CHECK (platform = ANY (ARRAY['macos'::text, 'windows'::text, 'unknown'::text]))"],
  ["sidestream_account_devices_revocation_fields_together", "c", "CHECK (revoked_at IS NULL AND revocation_reason IS NULL OR revoked_at IS NOT NULL AND revocation_reason IS NOT NULL AND (revocation_reason = ANY (ARRAY['deactivated'::text, 'replaced'::text])))"],
  ["sidestream_account_devices_times_valid", "c", "CHECK (last_seen_at >= activated_at AND (revoked_at IS NULL OR revoked_at >= activated_at))"]
]`;

const TRANSFER_CONSTRAINTS = `[
  ["sidestream_device_transfers_account_id_fkey", "f", "FOREIGN KEY (account_id) REFERENCES sidestream_accounts(id) ON DELETE CASCADE"],
  ["sidestream_device_transfers_distinct_devices", "c", "CHECK (from_device_id <> to_device_id)"],
  ["sidestream_device_transfers_from_account_fk", "f", "FOREIGN KEY (from_device_id, account_id, license_namespace) REFERENCES sidestream_account_devices(id, account_id, license_namespace)"],
  ["sidestream_device_transfers_initiator_valid", "c", "CHECK (initiated_by = ANY (ARRAY['account'::text, 'support'::text, 'system'::text]))"],
  ["sidestream_device_transfers_namespace_valid", "c", "CHECK (license_namespace = ANY (ARRAY['production'::text, 'test'::text]))"],
  ["sidestream_device_transfers_pkey", "p", "PRIMARY KEY (id)"],
  ["sidestream_device_transfers_reason_valid", "c", "CHECK (transfer_reason = ANY (ARRAY['device_change'::text, 'lost_device'::text, 'support_override'::text]))"],
  ["sidestream_device_transfers_to_account_fk", "f", "FOREIGN KEY (to_device_id, account_id, license_namespace) REFERENCES sidestream_account_devices(id, account_id, license_namespace)"]
]`;

const DEVICE_INDEXES = `[
  ["sidestream_account_devices_identity_unique", true, false, ["id", "account_id", "license_namespace"], [0, 0, 0], ""],
  ["sidestream_account_devices_lookup_idx", false, false, ["account_id", "license_namespace", "device_id_hash", "activated_at"], [0, 0, 0, 3], ""],
  ["sidestream_account_devices_one_active_production", true, false, ["account_id"], [0], "((license_namespace = 'production'::text) AND (revoked_at IS NULL))"],
  ["sidestream_account_devices_one_active_test", true, false, ["account_id"], [0], "((license_namespace = 'test'::text) AND (revoked_at IS NULL))"],
  ["sidestream_account_devices_pkey", true, true, ["id"], [0], ""]
]`;

const TRANSFER_INDEXES = `[
  ["sidestream_device_transfers_limit_window_idx", false, false, ["account_id", "license_namespace", "transferred_at"], [0, 0, 3], ""],
  ["sidestream_device_transfers_pkey", true, true, ["id"], [0], ""]
]`;

export const CATALOG_SQL = `
SET TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;

WITH target_tables(name) AS (
  VALUES
    ('sidestream_account_devices'::text),
    ('sidestream_device_transfers'::text)
),
presence AS (
  SELECT name, to_regclass(format('public.%I', name)) IS NOT NULL AS present
  FROM target_tables
),
checks(name, passed) AS (
  SELECT 'devices_table_kind', COALESCE((
    SELECT c.relkind = 'r'
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'sidestream_account_devices'
  ), false)
  UNION ALL
  SELECT 'devices_rls', COALESCE((
    SELECT c.relrowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'sidestream_account_devices'
  ), false)
  UNION ALL
  SELECT 'devices_columns', COALESCE((
    SELECT COALESCE(jsonb_agg(jsonb_build_array(
      a.attname,
      format_type(a.atttypid, a.atttypmod),
      a.attnotnull,
      CASE COALESCE(pg_get_expr(d.adbin, d.adrelid), '')
        WHEN 'pg_catalog.gen_random_uuid()' THEN 'gen_random_uuid()'
        ELSE COALESCE(pg_get_expr(d.adbin, d.adrelid), '')
      END
    ) ORDER BY a.attnum), '[]'::jsonb) = $json$${DEVICE_COLUMNS}$json$::jsonb
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d
      ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = to_regclass('public.sidestream_account_devices')
      AND a.attnum > 0
      AND NOT a.attisdropped
  ), false)
  UNION ALL
  SELECT 'devices_constraints', COALESCE((
    SELECT COALESCE(jsonb_agg(jsonb_build_array(
      con.conname,
      con.contype::text,
      pg_get_constraintdef(con.oid, true)
    ) ORDER BY con.conname), '[]'::jsonb) = $json$${DEVICE_CONSTRAINTS}$json$::jsonb
    FROM pg_constraint con
    WHERE con.conrelid = to_regclass('public.sidestream_account_devices')
  ), false)
  UNION ALL
  SELECT 'devices_indexes', COALESCE((
    SELECT COALESCE(jsonb_agg(jsonb_build_array(
      index_class.relname,
      ix.indisunique,
      ix.indisprimary,
      (
        SELECT jsonb_agg(pg_get_indexdef(ix.indexrelid, position, true) ORDER BY position)
        FROM generate_series(1, ix.indnkeyatts) AS position
      ),
      to_jsonb(ix.indoption::int2[]),
      COALESCE(pg_get_expr(ix.indpred, ix.indrelid), '')
    ) ORDER BY index_class.relname), '[]'::jsonb) = $json$${DEVICE_INDEXES}$json$::jsonb
    FROM pg_index ix
    JOIN pg_class index_class ON index_class.oid = ix.indexrelid
    WHERE ix.indrelid = to_regclass('public.sidestream_account_devices')
  ), false)
  UNION ALL
  SELECT 'transfers_table_kind', COALESCE((
    SELECT c.relkind = 'r'
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'sidestream_device_transfers'
  ), false)
  UNION ALL
  SELECT 'transfers_rls', COALESCE((
    SELECT c.relrowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'sidestream_device_transfers'
  ), false)
  UNION ALL
  SELECT 'transfers_columns', COALESCE((
    SELECT COALESCE(jsonb_agg(jsonb_build_array(
      a.attname,
      format_type(a.atttypid, a.atttypmod),
      a.attnotnull,
      CASE COALESCE(pg_get_expr(d.adbin, d.adrelid), '')
        WHEN 'pg_catalog.gen_random_uuid()' THEN 'gen_random_uuid()'
        ELSE COALESCE(pg_get_expr(d.adbin, d.adrelid), '')
      END
    ) ORDER BY a.attnum), '[]'::jsonb) = $json$${TRANSFER_COLUMNS}$json$::jsonb
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d
      ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = to_regclass('public.sidestream_device_transfers')
      AND a.attnum > 0
      AND NOT a.attisdropped
  ), false)
  UNION ALL
  SELECT 'transfers_constraints', COALESCE((
    SELECT COALESCE(jsonb_agg(jsonb_build_array(
      con.conname,
      con.contype::text,
      pg_get_constraintdef(con.oid, true)
    ) ORDER BY con.conname), '[]'::jsonb) = $json$${TRANSFER_CONSTRAINTS}$json$::jsonb
    FROM pg_constraint con
    WHERE con.conrelid = to_regclass('public.sidestream_device_transfers')
  ), false)
  UNION ALL
  SELECT 'transfers_indexes', COALESCE((
    SELECT COALESCE(jsonb_agg(jsonb_build_array(
      index_class.relname,
      ix.indisunique,
      ix.indisprimary,
      (
        SELECT jsonb_agg(pg_get_indexdef(ix.indexrelid, position, true) ORDER BY position)
        FROM generate_series(1, ix.indnkeyatts) AS position
      ),
      to_jsonb(ix.indoption::int2[]),
      COALESCE(pg_get_expr(ix.indpred, ix.indrelid), '')
    ) ORDER BY index_class.relname), '[]'::jsonb) = $json$${TRANSFER_INDEXES}$json$::jsonb
    FROM pg_index ix
    JOIN pg_class index_class ON index_class.oid = ix.indexrelid
    WHERE ix.indrelid = to_regclass('public.sidestream_device_transfers')
  ), false)
)
SELECT json_build_object(
  'accountsExists', to_regclass('public.sidestream_accounts') IS NOT NULL,
  'tablesPresent', COALESCE((
    SELECT json_agg(name ORDER BY name) FILTER (WHERE present)
    FROM presence
  ), '[]'::json),
  'failedChecks', COALESCE((
    SELECT json_agg(name ORDER BY name) FILTER (WHERE NOT passed)
    FROM checks
  ), '[]'::json)
)::text;
`;

function operatorError(message) {
  const error = new Error(message);
  error.name = "ProductionDeviceSchemaError";
  return error;
}

function isInheritedPostgresSelector(name) {
  return (
    (/(?:^|_)(?:POSTGRES|DATABASE)(?:_|$)/u.test(name) &&
      /(?:^|_)URL(?:_|$)/u.test(name)) ||
    /^PG(?:HOST|PORT|DATABASE|USER|PASSWORD|SERVICE|SERVICEFILE)$/u.test(name)
  );
}

export function rejectInheritedPostgresSelectors(environment) {
  const inherited = Object.keys(environment)
    .filter((name) => environment[name] !== undefined && isInheritedPostgresSelector(name))
    .sort();
  if (inherited.length > 0) {
    throw operatorError(
      `inherited Postgres selectors are forbidden (${inherited.join(",")})`,
    );
  }
}

function decodeDoubleQuotedValue(value, key) {
  let decoded = "";
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }

    index += 1;
    const escaped = value[index];
    if (escaped === "\\" || escaped === '"') {
      decoded += escaped;
    } else if (escaped === "n") {
      decoded += "\n";
    } else if (escaped === "r") {
      decoded += "\r";
    } else if (escaped === "t") {
      decoded += "\t";
    } else {
      throw operatorError(`unsupported escape in pulled ${key}`);
    }
  }
  return decoded;
}

function parseAllowlistedValue(rawValue, key) {
  const value = rawValue.trim();
  if (value.startsWith('"')) {
    if (value.length < 2 || !value.endsWith('"')) {
      throw operatorError(`malformed pulled ${key}`);
    }
    return decodeDoubleQuotedValue(value, key);
  }
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) {
      throw operatorError(`malformed pulled ${key}`);
    }
    return value.slice(1, -1);
  }
  if (/\s/u.test(value)) {
    throw operatorError(`malformed unquoted pulled ${key}`);
  }
  return value;
}

export function parsePulledEnvironment(contents) {
  if (Buffer.byteLength(contents, "utf8") > 1024 * 1024) {
    throw operatorError("pulled Production environment file is unexpectedly large");
  }
  if (contents.includes("\0")) {
    throw operatorError("pulled Production environment file contains NUL bytes");
  }

  const selected = new Map();
  for (const line of contents.split(/\r?\n/u)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match || !PULLED_ENV_ALLOWLIST.has(match[1])) {
      continue;
    }
    const [, key, rawValue] = match;
    if (selected.has(key)) {
      throw operatorError(`duplicate pulled ${key}`);
    }
    selected.set(key, parseAllowlistedValue(rawValue, key));
  }
  return Object.fromEntries(selected);
}

function parsePostgresUrl(selector, value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw operatorError(`${selector} is not a valid Postgres URL`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw operatorError(`${selector} is not a Postgres URL`);
  }
  if (!/(?:^|\.)neon\.tech$/iu.test(parsed.hostname)) {
    throw operatorError(`${selector} does not target Neon`);
  }
  if (!parsed.username || !parsed.password || !parsed.pathname || parsed.pathname === "/") {
    throw operatorError(`${selector} is missing required connection credentials`);
  }
  if (parsed.port && !/^\d{1,5}$/u.test(parsed.port)) {
    throw operatorError(`${selector} has an invalid port`);
  }

  let username;
  let password;
  let database;
  try {
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
    database = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw operatorError(`${selector} contains invalid URL encoding`);
  }
  if (!username || !password || !database || database.includes("/")) {
    throw operatorError(`${selector} has invalid connection fields`);
  }

  const environmentTokens = [parsed.hostname, username, database]
    .flatMap((part) => part.toLowerCase().split(/[^a-z0-9]+/u))
    .filter(Boolean);
  const forbiddenTargetTokens = new Set([
    "dev",
    "develop",
    "development",
    "local",
    "localhost",
    "preview",
    "sandbox",
    "stage",
    "staging",
    "test",
    "testing",
  ]);
  if (environmentTokens.some((token) => forbiddenTargetTokens.has(token))) {
    throw operatorError(`${selector} targets a non-Production database`);
  }

  const sslMode = parsed.searchParams.get("sslmode");
  if (sslMode && !["require", "verify-ca", "verify-full"].includes(sslMode)) {
    throw operatorError(`${selector} requests an unsafe SSL mode`);
  }
  const channelBinding = parsed.searchParams.get("channel_binding");
  if (channelBinding && channelBinding !== "require") {
    throw operatorError(`${selector} requests unsafe channel binding`);
  }

  return {
    selector,
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port || "5432",
    database,
    username,
    password,
  };
}

function connectionIdentity(connection) {
  const canonicalHost = connection.hostname.replace(/^([^.]+)-pooler\./u, "$1.");
  return `${canonicalHost}:${connection.port}/${connection.database}`;
}

export function selectProductionConnection(environmentValues) {
  const candidates = CONNECTION_SELECTORS
    .filter((selector) => (environmentValues[selector] ?? "").trim() !== "")
    .map((selector) => parsePostgresUrl(selector, environmentValues[selector].trim()));
  if (candidates.length === 0) {
    throw operatorError("no allowlisted Production Neon connection selector is available");
  }
  const targetIdentities = new Set(candidates.map(connectionIdentity));
  if (targetIdentities.size !== 1) {
    throw operatorError("pulled Production Postgres selectors disagree on target");
  }
  return candidates[0];
}

function readJsonRegularFile(path, description) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw operatorError(`${description} is missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw operatorError(`${description} must be a regular file`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw operatorError(`${description} is invalid`);
  }
}

function linkMatchesExpectedProject(link) {
  return Object.entries(EXPECTED_VERCEL_PROJECT).every(
    ([key, value]) => link[key] === value,
  );
}

function resolveGitCommonRoot(repoRoot) {
  const dotGit = join(repoRoot, ".git");
  let dotGitStat;
  try {
    dotGitStat = lstatSync(dotGit);
  } catch {
    return null;
  }
  if (dotGitStat.isDirectory()) {
    return repoRoot;
  }
  if (!dotGitStat.isFile() || dotGitStat.isSymbolicLink()) {
    return null;
  }
  const gitDirMatch = /^gitdir: (.+)\s*$/u.exec(readFileSync(dotGit, "utf8"));
  if (!gitDirMatch) {
    return null;
  }
  const gitDirectory = resolve(repoRoot, gitDirMatch[1]);
  const commonDirectoryFile = join(gitDirectory, "commondir");
  let commonDirectory;
  try {
    const stat = lstatSync(commonDirectoryFile);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return null;
    }
    commonDirectory = resolve(
      gitDirectory,
      readFileSync(commonDirectoryFile, "utf8").trim(),
    );
  } catch {
    return null;
  }
  return dirname(commonDirectory);
}

export function resolveVercelProject(repoRoot) {
  const roots = [repoRoot, resolveGitCommonRoot(repoRoot)].filter(Boolean);
  for (const root of [...new Set(roots.map((value) => resolve(value)))]) {
    const projectFile = join(root, ".vercel", "project.json");
    let link;
    try {
      link = readJsonRegularFile(projectFile, "Vercel project link");
    } catch (error) {
      if (error.message.endsWith(" is missing")) {
        continue;
      }
      throw error;
    }
    if (!linkMatchesExpectedProject(link)) {
      throw operatorError("linked Vercel project is not the pinned Sidestream project");
    }
    return { root: realpathSync(root), link };
  }
  throw operatorError("the repository has no existing pinned Vercel project link");
}

function verifyMigration(repoRoot) {
  const migrationPath = join(repoRoot, MIGRATION_RELATIVE_PATH);
  let stat;
  try {
    stat = lstatSync(migrationPath);
  } catch {
    throw operatorError("checked-in device migration is missing");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw operatorError("checked-in device migration must be a regular file");
  }
  const contents = readFileSync(migrationPath);
  const digest = createHash("sha256").update(contents).digest("hex");
  if (digest !== MIGRATION_SHA256) {
    throw operatorError("checked-in device migration does not match the pinned digest");
  }
  return migrationPath;
}

function requireExecutable(path, description) {
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw operatorError(`${description} is unavailable at its pinned path`);
  }
}

function cleanVercelEnvironment(environment) {
  const clean = {
    NO_COLOR: "1",
    PATH: environment.PATH || "/opt/homebrew/bin:/usr/bin:/bin",
  };
  for (const name of ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "VERCEL_TOKEN"]) {
    if (environment[name]) {
      clean[name] = environment[name];
    }
  }
  return clean;
}

function cleanNeonEnvironment(environment) {
  return {
    HOME: environment.HOME,
    NO_COLOR: "1",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_OFFLINE: "true",
    PATH: environment.PATH || "/opt/homebrew/bin:/usr/bin:/bin",
  };
}

function runChild(spawn, command, args, options, phase) {
  const result = spawn(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 120_000,
    ...options,
  });
  if (result?.error || result?.status !== 0) {
    const code = Number.isInteger(result?.status) ? result.status : "spawn";
    throw operatorError(`${phase} failed (code=${code})`);
  }
  return result;
}

function pullProductionEnvironment({
  environment,
  linkRoot,
  spawn,
  temporaryRoot,
  vercelPath,
}) {
  const directory = mkdtempSync(join(temporaryRoot, "sidestream-device-schema-"));
  const environmentPath = join(directory, "production.env");
  closeSync(openSync(environmentPath, "wx", 0o600));
  chmodSync(environmentPath, 0o600);
  try {
    runChild(
      spawn,
      vercelPath,
      [
        "env",
        "pull",
        environmentPath,
        "--environment=production",
        "--yes",
        "--no-color",
        "--non-interactive",
      ],
      {
        cwd: linkRoot,
        env: cleanVercelEnvironment(environment),
        stdio: ["ignore", "pipe", "pipe"],
      },
      "Production environment pull",
    );
    chmodSync(environmentPath, 0o600);
    const stat = lstatSync(environmentPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
      throw operatorError("pulled Production environment file is not mode 0600");
    }
    return parsePulledEnvironment(readFileSync(environmentPath, "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function parseLinkedNeonResource(stdout) {
  let response;
  try {
    response = JSON.parse(String(stdout ?? ""));
  } catch {
    throw operatorError("linked Vercel storage inventory returned invalid output");
  }
  if (!Array.isArray(response?.stores)) {
    throw operatorError("linked Vercel storage inventory returned an invalid shape");
  }
  const matches = response.stores.filter((store) =>
    store?.id === EXPECTED_NEON_RESOURCE.storeId &&
    store?.name === EXPECTED_NEON_RESOURCE.storeName &&
    store?.type === "integration" &&
    store?.status === "available" &&
    store?.externalResourceId === EXPECTED_NEON_RESOURCE.externalResourceId &&
    store?.product?.slug === "neon" &&
    Array.isArray(store?.projectsMetadata) &&
    store.projectsMetadata.some((project) =>
      project?.projectId === EXPECTED_VERCEL_PROJECT.projectId &&
      project?.name === EXPECTED_VERCEL_PROJECT.projectName &&
      Array.isArray(project?.environments) &&
      project.environments.includes("production")
    )
  );
  if (matches.length !== 1) {
    throw operatorError("the pinned Production Neon resource binding is unavailable");
  }
  return matches[0];
}

function resolveLinkedNeonConnection({
  environment,
  linkRoot,
  npxPath,
  spawn,
  vercelPath,
}) {
  if (!environment.HOME) {
    throw operatorError("HOME is required for the authenticated Neon CLI profile");
  }
  requireExecutable(npxPath, "npx");
  const inventory = runChild(
    spawn,
    vercelPath,
    [
      "api",
      "/v1/storage/stores",
      "--raw",
      "--no-color",
      "--non-interactive",
    ],
    {
      cwd: linkRoot,
      env: cleanVercelEnvironment(environment),
      stdio: ["ignore", "pipe", "pipe"],
    },
    "linked Vercel storage inventory",
  );
  parseLinkedNeonResource(inventory.stdout);

  const connectionResult = runChild(
    spawn,
    npxPath,
    [
      "--offline",
      "--yes",
      `neonctl@${NEONCTL_VERSION}`,
      "connection-string",
      EXPECTED_NEON_RESOURCE.branchName,
      `--project-id=${EXPECTED_NEON_RESOURCE.externalResourceId}`,
      `--role-name=${EXPECTED_NEON_RESOURCE.roleName}`,
      `--database-name=${EXPECTED_NEON_RESOURCE.databaseName}`,
      "--pooled=false",
      "--ssl=verify-full",
      "--no-color",
      "--no-analytics",
    ],
    {
      env: cleanNeonEnvironment(environment),
      stdio: ["ignore", "pipe", "pipe"],
    },
    "authenticated Neon connection lookup",
  );
  const value = String(connectionResult.stdout ?? "").trim();
  if (!value || /\r|\n/u.test(value)) {
    throw operatorError("authenticated Neon connection lookup returned invalid output");
  }
  return {
    ...parsePostgresUrl("STORAGE_POSTGRES_URL_NON_POOLING", value),
    source: "linked-neon-resource",
  };
}

function psqlEnvironment(connection) {
  return {
    LANG: "C",
    LC_ALL: "C",
    PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    PGAPPNAME: "sidestream-production-device-schema",
    PGCHANNELBINDING: "require",
    PGCONNECT_TIMEOUT: "15",
    PGDATABASE: connection.database,
    PGHOST: connection.hostname,
    PGPASSWORD: connection.password,
    PGPORT: connection.port,
    PGSSLMODE: "verify-full",
    PGSSLROOTCERT: "system",
    PGTARGETSESSIONATTRS: "read-write",
    PGUSER: connection.username,
    TZ: "UTC",
  };
}

function commonPsqlArgs() {
  return [
    "--no-psqlrc",
    "--set=ON_ERROR_STOP=1",
    "--single-transaction",
    "--quiet",
  ];
}

function inspectCatalog(spawn, psqlPath, connection) {
  const result = runChild(
    spawn,
    psqlPath,
    [
      ...commonPsqlArgs(),
      "--tuples-only",
      "--no-align",
      "--file=-",
    ],
    {
      env: psqlEnvironment(connection),
      input: CATALOG_SQL,
      stdio: ["pipe", "pipe", "pipe"],
    },
    "schema catalog verification",
  );
  const jsonLine = String(result.stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .findLast((line) => line.startsWith("{"));
  if (!jsonLine) {
    throw operatorError("schema catalog verification returned no result");
  }
  let catalog;
  try {
    catalog = JSON.parse(jsonLine);
  } catch {
    throw operatorError("schema catalog verification returned invalid output");
  }
  if (
    typeof catalog.accountsExists !== "boolean" ||
    !Array.isArray(catalog.tablesPresent) ||
    !Array.isArray(catalog.failedChecks)
  ) {
    throw operatorError("schema catalog verification returned an invalid shape");
  }
  return catalog;
}

export function classifyCatalog(catalog) {
  if (!catalog.accountsExists) {
    throw operatorError("public.sidestream_accounts is missing");
  }
  const present = new Set(catalog.tablesPresent);
  const devicesPresent = present.has("sidestream_account_devices");
  const transfersPresent = present.has("sidestream_device_transfers");
  if (devicesPresent !== transfersPresent) {
    throw operatorError("target device tables are only partially present");
  }
  if (!devicesPresent) {
    return "absent";
  }
  if (catalog.failedChecks.length > 0) {
    throw operatorError(
      `target device tables conflict with the migration (${catalog.failedChecks.join(",")})`,
    );
  }
  return "present";
}

function applyMigration(spawn, psqlPath, connection, migrationPath) {
  runChild(
    spawn,
    psqlPath,
    [...commonPsqlArgs(), `--file=${migrationPath}`],
    {
      env: psqlEnvironment(connection),
      stdio: ["ignore", "pipe", "pipe"],
    },
    "device schema migration",
  );
}

function parseMode(args) {
  const verifyCount = args.filter((arg) => arg === "--verify").length;
  const applyCount = args.filter((arg) => arg === "--apply").length;
  const confirmationCount = args.filter((arg) => arg === APPLY_CONFIRMATION).length;
  const known = new Set(["--verify", "--apply", APPLY_CONFIRMATION]);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length > 0) {
    throw operatorError(`unknown argument: ${unknown[0]}`);
  }
  if (verifyCount + applyCount !== 1 || verifyCount > 1 || applyCount > 1) {
    throw operatorError("choose exactly one of --verify or --apply");
  }
  if (applyCount === 1 && confirmationCount !== 1) {
    throw operatorError(`--apply requires the literal ${APPLY_CONFIRMATION}`);
  }
  if (verifyCount === 1 && confirmationCount !== 0) {
    throw operatorError(`${APPLY_CONFIRMATION} is valid only with --apply`);
  }
  return applyCount === 1 ? "apply" : "verify";
}

function targetFingerprint(connection) {
  return createHash("sha256")
    .update(connectionIdentity(connection))
    .digest("hex")
    .slice(0, 16);
}

export function runOperator(args, dependencies = {}) {
  const mode = parseMode(args);
  const environment = dependencies.environment ?? process.env;
  const repoRoot = resolve(dependencies.repoRoot ?? DEFAULT_REPO_ROOT);
  const spawn = dependencies.spawnSyncImpl ?? spawnSync;
  const stdout = dependencies.stdout ?? process.stdout;
  const temporaryRoot = dependencies.temporaryRoot ?? tmpdir();
  const vercelPath = dependencies.vercelPath ?? VERCEL_PATH;
  const npxPath = dependencies.npxPath ?? NPX_PATH;
  const psqlPath = dependencies.psqlPath ?? PSQL_PATH;

  rejectInheritedPostgresSelectors(environment);
  requireExecutable(vercelPath, "Vercel CLI");
  requireExecutable(psqlPath, "psql");
  const migrationPath = verifyMigration(repoRoot);
  const project = resolveVercelProject(repoRoot);
  const pulled = pullProductionEnvironment({
    environment,
    linkRoot: project.root,
    spawn,
    temporaryRoot,
    vercelPath,
  });
  if ((pulled.SIDESTREAM_DEVICE_POLICY_MODE ?? "").trim().toLowerCase() === "enforce") {
    throw operatorError("SIDESTREAM_DEVICE_POLICY_MODE=enforce blocks this operation");
  }
  let connection;
  try {
    connection = {
      ...selectProductionConnection(pulled),
      source: "vercel-production-env",
    };
  } catch (error) {
    if (error.message !== "no allowlisted Production Neon connection selector is available") {
      throw error;
    }
    connection = resolveLinkedNeonConnection({
      environment,
      linkRoot: project.root,
      npxPath,
      spawn,
      vercelPath,
    });
  }
  const fingerprint = targetFingerprint(connection);
  const before = classifyCatalog(inspectCatalog(spawn, psqlPath, connection));

  if (mode === "verify") {
    if (before !== "present") {
      throw operatorError("Production device schema is absent");
    }
    stdout.write(
      `PASS mode=verify project=${project.link.projectName} projectId=${project.link.projectId} selector=${connection.selector} source=${connection.source} target=${fingerprint} schema=present\n`,
    );
    return { mode, before, after: before, migration: "not-run", fingerprint };
  }

  if (before === "absent") {
    applyMigration(spawn, psqlPath, connection, migrationPath);
  }
  const after = classifyCatalog(inspectCatalog(spawn, psqlPath, connection));
  if (after !== "present") {
    throw operatorError("Production device schema is not present after apply");
  }
  const migration = before === "absent" ? "applied" : "already-present";
  stdout.write(
    `PASS mode=apply project=${project.link.projectName} projectId=${project.link.projectId} selector=${connection.selector} source=${connection.source} target=${fingerprint} before=${before} migration=${migration} after=${after}\n`,
  );
  return { mode, before, after, migration, fingerprint };
}

function main() {
  try {
    runOperator(process.argv.slice(2));
  } catch (error) {
    const message =
      error?.name === "ProductionDeviceSchemaError"
        ? error.message
        : "unexpected operator failure";
    process.stderr.write(`FAIL ${message}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main();
}

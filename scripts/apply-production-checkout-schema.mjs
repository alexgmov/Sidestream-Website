#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  EXPECTED_NEON_RESOURCE,
  commonPsqlArgs,
  connectionIdentity,
  pullProductionEnvironment,
  rejectInheritedPostgresSelectors,
  requireExecutable,
  resolveLinkedNeonConnection,
  resolveVercelProject,
  runChild,
  psqlEnvironment,
  selectProductionConnection,
  targetFingerprint,
} from "./apply-production-device-schema.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const VERCEL_PATH = "/opt/homebrew/bin/vercel";
const NPX_PATH = "/opt/homebrew/bin/npx";
const PSQL_PATH = "/opt/homebrew/bin/psql";
const MIGRATION_RELATIVE_PATH =
  "db/migrations/20260713203000_add_checkout_intents.sql";
const MIGRATION_SHA256 =
  "2a24bc22b98b77dea44b557c34a79d78245c6532222a07af79dce7322a8415a2";
const APPLY_CONFIRMATION = "--confirm-production-checkout-intents-schema";
const PSQL_APP_NAME = "sidestream-production-checkout-schema";

const CHECKOUT_COLUMNS = `[
  ["id", "uuid", true, "gen_random_uuid()"],
  ["intent_kind", "text", true, ""],
  ["browser_token_hash", "text", true, ""],
  ["account_id", "uuid", false, ""],
  ["activation_session_id", "uuid", false, ""],
  ["state", "text", true, "'pending'::text"],
  ["attempt", "integer", true, "0"],
  ["stripe_customer_id", "text", false, ""],
  ["stripe_checkout_session_id", "text", false, ""],
  ["stripe_checkout_url", "text", false, ""],
  ["stripe_price_id", "text", false, ""],
  ["stripe_product_id", "text", false, ""],
  ["stripe_session_expires_at", "timestamp with time zone", false, ""],
  ["confirmed_at", "timestamp with time zone", false, ""],
  ["last_error_code", "text", false, ""],
  ["expires_at", "timestamp with time zone", true, ""],
  ["created_at", "timestamp with time zone", true, "now()"],
  ["updated_at", "timestamp with time zone", true, "now()"]
]`;

const CHECKOUT_CONSTRAINTS = `[
  ["sidestream_checkout_intents_account_id_fkey", "f", "FOREIGN KEY (account_id) REFERENCES sidestream_accounts(id) ON DELETE CASCADE"],
  ["sidestream_checkout_intents_activation_session_id_fkey", "f", "FOREIGN KEY (activation_session_id) REFERENCES sidestream_activation_sessions(id) ON DELETE CASCADE"],
  ["sidestream_checkout_intents_attempt_valid", "c", "CHECK (attempt >= 0)"],
  ["sidestream_checkout_intents_binding_valid", "c", "CHECK (intent_kind = 'anonymous'::text AND account_id IS NULL AND activation_session_id IS NULL OR intent_kind = 'account'::text AND account_id IS NOT NULL AND activation_session_id IS NULL OR intent_kind = 'activation'::text AND activation_session_id IS NOT NULL)"],
  ["sidestream_checkout_intents_browser_token_hash_valid", "c", "CHECK (browser_token_hash ~ '^[0-9a-f]{64}$'::text)"],
  ["sidestream_checkout_intents_expiry_valid", "c", "CHECK (expires_at > created_at)"],
  ["sidestream_checkout_intents_kind_valid", "c", "CHECK (intent_kind = ANY (ARRAY['anonymous'::text, 'account'::text, 'activation'::text]))"],
  ["sidestream_checkout_intents_pkey", "p", "PRIMARY KEY (id)"],
  ["sidestream_checkout_intents_state_valid", "c", "CHECK (state = ANY (ARRAY['pending'::text, 'open'::text, 'completed'::text, 'cancelled'::text, 'expired'::text, 'failed'::text]))"],
  ["sidestream_checkout_intents_stripe_session_fields_together", "c", "CHECK (stripe_checkout_session_id IS NULL AND stripe_checkout_url IS NULL AND stripe_price_id IS NULL AND stripe_product_id IS NULL AND stripe_session_expires_at IS NULL OR length(TRIM(BOTH FROM stripe_checkout_session_id)) > 0 AND length(TRIM(BOTH FROM stripe_checkout_url)) > 0 AND length(TRIM(BOTH FROM stripe_price_id)) > 0 AND length(TRIM(BOTH FROM stripe_product_id)) > 0 AND stripe_session_expires_at IS NOT NULL)"]
]`;

const REQUIRED_CHECKOUT_INDEXES = `[
  ["sidestream_checkout_intents_account_idx", false, false, ["account_id", "created_at"], [0, 3], "(account_id IS NOT NULL)"],
  ["sidestream_checkout_intents_activation_idx", false, false, ["activation_session_id", "created_at"], [0, 3], "(activation_session_id IS NOT NULL)"],
  ["sidestream_checkout_intents_browser_token_unique", true, false, ["browser_token_hash"], [0], ""],
  ["sidestream_checkout_intents_expiry_idx", false, false, ["expires_at"], [0], ""],
  ["sidestream_checkout_intents_pkey", true, true, ["id"], [0], ""],
  ["sidestream_checkout_intents_session_idx", false, false, ["stripe_checkout_session_id"], [0], "(stripe_checkout_session_id IS NOT NULL)"]
]`;

export const CATALOG_SQL = `
SET TRANSACTION READ ONLY;
SET LOCAL search_path = public, pg_catalog;

WITH checks(name, passed) AS (
  SELECT 'checkout_table_kind', COALESCE((
    SELECT c.relkind = 'r' AND c.relpersistence = 'p'
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'sidestream_checkout_intents'
  ), false)
  UNION ALL
  SELECT 'checkout_rls', COALESCE((
    SELECT c.relrowsecurity
      AND NOT c.relforcerowsecurity
      AND NOT EXISTS (
        SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
      )
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'sidestream_checkout_intents'
  ), false)
  UNION ALL
  SELECT 'checkout_columns', COALESCE((
    SELECT COALESCE(jsonb_agg(jsonb_build_array(
      a.attname,
      format_type(a.atttypid, a.atttypmod),
      a.attnotnull,
      CASE COALESCE(pg_get_expr(d.adbin, d.adrelid), '')
        WHEN 'pg_catalog.gen_random_uuid()' THEN 'gen_random_uuid()'
        ELSE COALESCE(pg_get_expr(d.adbin, d.adrelid), '')
      END
    ) ORDER BY a.attnum), '[]'::jsonb) = $json$${CHECKOUT_COLUMNS}$json$::jsonb
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d
      ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = to_regclass('public.sidestream_checkout_intents')
      AND a.attnum > 0
      AND NOT a.attisdropped
  ), false)
  UNION ALL
  SELECT 'checkout_constraints', COALESCE((
    SELECT COALESCE(jsonb_agg(jsonb_build_array(
      con.conname,
      con.contype::text,
      pg_get_constraintdef(con.oid, true)
    ) ORDER BY con.conname), '[]'::jsonb) = $json$${CHECKOUT_CONSTRAINTS}$json$::jsonb
    FROM pg_constraint con
    WHERE con.conrelid = to_regclass('public.sidestream_checkout_intents')
  ), false)
  UNION ALL
  SELECT 'checkout_indexes', COALESCE((
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
    ) ORDER BY index_class.relname), '[]'::jsonb) @> $json$${REQUIRED_CHECKOUT_INDEXES}$json$::jsonb
    FROM pg_index ix
    JOIN pg_class index_class ON index_class.oid = ix.indexrelid
    WHERE ix.indrelid = to_regclass('public.sidestream_checkout_intents')
  ), false)
  UNION ALL
  SELECT 'checkout_direct_role_revocations', COALESCE((
    SELECT NOT EXISTS (
      SELECT 1
      FROM aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
      WHERE acl.grantee = 0
        OR acl.grantee IN (
          SELECT r.oid FROM pg_roles r
          WHERE r.rolname IN ('anon', 'authenticated')
        )
    ) AND NOT EXISTS (
      SELECT 1
      FROM pg_attribute a
      CROSS JOIN LATERAL aclexplode(a.attacl) acl
      WHERE a.attrelid = c.oid
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND (
          acl.grantee = 0
          OR acl.grantee IN (
            SELECT r.oid FROM pg_roles r
            WHERE r.rolname IN ('anon', 'authenticated')
          )
        )
    )
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'sidestream_checkout_intents'
  ), false)
)
SELECT json_build_object(
  'accountsExists', EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'sidestream_accounts'
      AND c.relkind = 'r'
  ),
  'activationSessionsExists', EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'sidestream_activation_sessions'
      AND c.relkind = 'r'
  ),
  'tablePresent', to_regclass('public.sidestream_checkout_intents') IS NOT NULL,
  'failedChecks', COALESCE((
    SELECT json_agg(name ORDER BY name) FILTER (WHERE NOT passed)
    FROM checks
  ), '[]'::json)
)::text;
`;

function operatorError(message) {
  const error = new Error(message);
  error.name = "ProductionCheckoutSchemaError";
  return error;
}

function verifyMigration(repoRoot) {
  const migrationPath = join(repoRoot, MIGRATION_RELATIVE_PATH);
  let stat;
  try {
    stat = lstatSync(migrationPath);
  } catch {
    throw operatorError("checked-in Checkout-intent migration is missing");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw operatorError("checked-in Checkout-intent migration must be a regular file");
  }
  const contents = readFileSync(migrationPath);
  const digest = createHash("sha256").update(contents).digest("hex");
  if (digest !== MIGRATION_SHA256) {
    throw operatorError(
      "checked-in Checkout-intent migration does not match the pinned digest",
    );
  }
  return migrationPath;
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

function inspectCatalog(spawn, psqlPath, connection) {
  const result = runChild(
    spawn,
    psqlPath,
    [...commonPsqlArgs(), "--tuples-only", "--no-align", "--file=-"],
    {
      env: psqlEnvironment(connection, PSQL_APP_NAME),
      input: CATALOG_SQL,
      stdio: ["pipe", "pipe", "pipe"],
    },
    "Checkout schema catalog verification",
  );
  const jsonLine = String(result.stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .findLast((line) => line.startsWith("{"));
  if (!jsonLine) {
    throw operatorError("Checkout schema catalog verification returned no result");
  }
  let catalog;
  try {
    catalog = JSON.parse(jsonLine);
  } catch {
    throw operatorError("Checkout schema catalog verification returned invalid output");
  }
  if (
    typeof catalog.accountsExists !== "boolean" ||
    typeof catalog.activationSessionsExists !== "boolean" ||
    typeof catalog.tablePresent !== "boolean" ||
    !Array.isArray(catalog.failedChecks)
  ) {
    throw operatorError(
      "Checkout schema catalog verification returned an invalid shape",
    );
  }
  return catalog;
}

export function classifyCatalog(catalog) {
  if (!catalog.accountsExists) {
    throw operatorError("public.sidestream_accounts is missing");
  }
  if (!catalog.activationSessionsExists) {
    throw operatorError("public.sidestream_activation_sessions is missing");
  }
  if (!catalog.tablePresent) {
    return "absent";
  }
  if (catalog.failedChecks.length > 0) {
    throw operatorError(
      `Checkout-intent table conflicts with the migration (${catalog.failedChecks.join(",")})`,
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
      env: psqlEnvironment(connection, PSQL_APP_NAME),
      stdio: ["ignore", "pipe", "pipe"],
    },
    "Checkout-intent schema migration",
  );
}

function selectPinnedConnection({
  environment,
  linkRoot,
  npxPath,
  pulled,
  spawn,
  vercelPath,
}) {
  let selected = null;
  try {
    selected = selectProductionConnection(pulled);
  } catch (error) {
    if (error.message !== "no allowlisted Production Neon connection selector is available") {
      throw error;
    }
  }
  const linked = resolveLinkedNeonConnection({
    environment,
    linkRoot,
    npxPath,
    spawn,
    vercelPath,
  });
  if (selected && connectionIdentity(selected) !== connectionIdentity(linked)) {
    throw operatorError(
      "pulled Production database does not match the pinned linked Neon resource",
    );
  }
  return {
    ...linked,
    selector: selected?.selector ?? linked.selector,
    source: "pinned-linked-neon",
  };
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
    temporaryPrefix: "sidestream-checkout-schema-",
    temporaryRoot,
    vercelPath,
  });
  const connection = selectPinnedConnection({
    environment,
    linkRoot: project.root,
    npxPath,
    pulled,
    spawn,
    vercelPath,
  });
  const fingerprint = targetFingerprint(connection);
  const before = classifyCatalog(inspectCatalog(spawn, psqlPath, connection));

  if (mode === "verify") {
    if (before !== "present") {
      throw operatorError("Production Checkout-intent schema is absent");
    }
    stdout.write(
      `PASS mode=verify project=${project.link.projectName} projectId=${project.link.projectId} resource=${EXPECTED_NEON_RESOURCE.storeName} resourceId=${EXPECTED_NEON_RESOURCE.externalResourceId} selector=${connection.selector} source=${connection.source} target=${fingerprint} schema=present\n`,
    );
    return { mode, before, after: before, migration: "not-run", fingerprint };
  }

  if (before === "absent") {
    applyMigration(spawn, psqlPath, connection, migrationPath);
  }
  const after = classifyCatalog(inspectCatalog(spawn, psqlPath, connection));
  if (after !== "present") {
    throw operatorError("Production Checkout-intent schema is not present after apply");
  }
  const migration = before === "absent" ? "applied" : "already-present";
  stdout.write(
    `PASS mode=apply project=${project.link.projectName} projectId=${project.link.projectId} resource=${EXPECTED_NEON_RESOURCE.storeName} resourceId=${EXPECTED_NEON_RESOURCE.externalResourceId} selector=${connection.selector} source=${connection.source} target=${fingerprint} before=${before} migration=${migration} after=${after}\n`,
  );
  return { mode, before, after, migration, fingerprint };
}

function main() {
  try {
    runOperator(process.argv.slice(2));
  } catch (error) {
    const message = [
      "ProductionCheckoutSchemaError",
      "ProductionDeviceSchemaError",
    ].includes(error?.name)
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

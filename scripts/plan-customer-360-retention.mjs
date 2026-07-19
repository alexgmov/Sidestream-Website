#!/usr/bin/env node

import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parsePostgresTarget } from "../api/_lib/postgres-target.ts";
import { readRegularFile } from "./lib/safe-file.mjs";

export const RETENTION_POLICY_VERSION = 1;

export const RETENTION_DOMAINS = Object.freeze([
  Object.freeze({
    key: "profileRoots",
    table: "public.sidestream_customer_profiles",
    alias: "profile",
    ageExpression:
      "coalesce(profile.last_activity_at, profile.updated_at, profile.created_at)",
    predicate: "profile.merged_into is null",
    immutable: false,
  }),
  Object.freeze({
    key: "identityLinks",
    table: "public.sidestream_customer_identity_links",
    alias: "identity_link",
    ageExpression: "identity_link.created_at",
    predicate: "true",
    immutable: false,
  }),
  Object.freeze({
    key: "installMemberships",
    table: "public.sidestream_customer_installs",
    alias: "install",
    ageExpression: "install.last_seen_at",
    predicate: "true",
    immutable: false,
  }),
  Object.freeze({
    key: "dailyUsageBuckets",
    table: "public.sidestream_customer_usage_daily",
    alias: "usage_bucket",
    ageExpression: "usage_bucket.activity_day::timestamp at time zone 'UTC'",
    predicate: "true",
    immutable: false,
  }),
  Object.freeze({
    key: "usageProfiles",
    table: "public.sidestream_customer_profiles",
    alias: "usage_profile",
    ageExpression: "usage_profile.usage_synced_at",
    predicate:
      "usage_profile.merged_into is null and usage_profile.usage_synced_at is not null",
    immutable: false,
  }),
  Object.freeze({
    key: "commerceMaterializations",
    table: "public.sidestream_customer_commerce_materializations",
    alias: "commerce",
    ageExpression: "commerce.updated_at",
    predicate: "true",
    immutable: false,
  }),
  Object.freeze({
    key: "immutableMergeAudits",
    table: "public.sidestream_customer_profile_merges",
    alias: "merge_audit",
    ageExpression: "merge_audit.merged_at",
    predicate: "true",
    immutable: true,
  }),
  Object.freeze({
    key: "pendingIdentityReviews",
    table: "public.sidestream_customer_identity_reviews",
    alias: "identity_review",
    ageExpression: "identity_review.created_at",
    predicate: "identity_review.review_state = 'pending_review'",
    immutable: true,
  }),
]);

const VALID_NAMESPACES = new Set(["production", "test"]);
const VALID_ACTIONS = new Set(["preserve", "review", "delete"]);
const MAX_AGE_DAYS = 36_500;
const MAX_BUCKET_BOUNDARIES = 8;
const POLICY_TOP_LEVEL_KEYS = Object.freeze(["version", "domains"]);
const POLICY_DOMAIN_KEYS = Object.freeze([
  "action",
  "ageBucketsDays",
  "minimumAgeDays",
]);

export class Customer360RetentionError extends Error {
  constructor(message) {
    super(message);
    this.name = "Customer360RetentionError";
  }
}

export function parseRetentionArgs(argv) {
  const options = {
    dryRun: true,
    help: false,
    selfTest: false,
    namespace: "",
    policyPath: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      continue;
    }
    if (argument === "--apply" || argument.startsWith("--apply=")) {
      throw new Customer360RetentionError(
        "Retention mutation/apply is unavailable in every namespace; this command is inventory-only.",
      );
    }
    if (argument === "--self-test") {
      options.selfTest = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (
      argument === "--namespace" ||
      argument.startsWith("--namespace=") ||
      argument === "--target" ||
      argument.startsWith("--target=")
    ) {
      const name = argument.startsWith("--target") ? "--target" : "--namespace";
      [options.namespace, index] = readOption(argv, index, name);
      continue;
    }
    if (argument === "--policy" || argument.startsWith("--policy=")) {
      [options.policyPath, index] = readOption(argv, index, "--policy");
      continue;
    }
    throw new Customer360RetentionError("Unknown option. Use --help for supported options.");
  }

  if (!options.selfTest && !options.help) {
    if (!options.namespace) {
      throw new Customer360RetentionError(
        "Inventory requires an explicit --namespace production or --namespace test.",
      );
    }
    assertNamespace(options.namespace);
    if (!options.policyPath) {
      throw new Customer360RetentionError(
        "Inventory requires an explicit reviewed --policy JSON file.",
      );
    }
  }

  return Object.freeze(options);
}

export function normalizeRetentionPolicy(input) {
  if (!isRecord(input)) {
    throw new Customer360RetentionError("Retention policy must be a JSON object.");
  }
  assertExactKeys(input, POLICY_TOP_LEVEL_KEYS, "Retention policy");
  if (input.version !== RETENTION_POLICY_VERSION) {
    throw new Customer360RetentionError(
      `Retention policy version must be exactly ${RETENTION_POLICY_VERSION}.`,
    );
  }
  if (!isRecord(input.domains)) {
    throw new Customer360RetentionError("Retention policy domains must be an object.");
  }

  const domainKeys = RETENTION_DOMAINS.map(({ key }) => key);
  assertExactKeys(input.domains, domainKeys, "Retention policy domains");
  const domains = {};

  for (const domain of RETENTION_DOMAINS) {
    const rawConfig = input.domains[domain.key];
    if (!isRecord(rawConfig)) {
      throw new Customer360RetentionError(
        `Retention policy domain ${domain.key} must be an object.`,
      );
    }
    assertExactKeys(
      rawConfig,
      POLICY_DOMAIN_KEYS,
      `Retention policy domain ${domain.key}`,
    );
    if (!VALID_ACTIONS.has(rawConfig.action)) {
      throw new Customer360RetentionError(
        `Retention policy domain ${domain.key} action must be preserve, review, or delete.`,
      );
    }
    if (domain.immutable && rawConfig.action !== "preserve") {
      throw new Customer360RetentionError(
        `Retention policy domain ${domain.key} is immutable and must use action preserve.`,
      );
    }

    const ageBucketsDays = normalizeAgeBuckets(rawConfig.ageBucketsDays, domain.key);
    let minimumAgeDays = null;
    if (rawConfig.action === "preserve") {
      if (rawConfig.minimumAgeDays !== null) {
        throw new Customer360RetentionError(
          `Retention policy domain ${domain.key} must use null minimumAgeDays when preserved.`,
        );
      }
    } else {
      minimumAgeDays = normalizeAgeDays(
        rawConfig.minimumAgeDays,
        `Retention policy domain ${domain.key} minimumAgeDays`,
      );
    }

    domains[domain.key] = Object.freeze({
      action: rawConfig.action,
      ageBucketsDays,
      minimumAgeDays,
    });
  }

  return Object.freeze({
    version: RETENTION_POLICY_VERSION,
    domains: Object.freeze(domains),
  });
}

export function retentionPolicyDigest(policy) {
  const normalized = normalizeRetentionPolicy(policy);
  return `sha256:${createHash("sha256")
    .update("sidestream-customer-360-retention-policy:v1\0")
    .update(JSON.stringify(normalized))
    .digest("hex")}`;
}

export function fingerprintDatabaseTarget(databaseUrl, namespace) {
  assertNamespace(namespace);
  const parsed = parseSafeDatabaseUrl(databaseUrl);
  const normalizedTarget = JSON.stringify({
    protocol: "postgresql:",
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port,
    database: parsed.database,
    namespace,
  });
  return `sha256:${createHash("sha256")
    .update("sidestream-customer-360-retention-target:v1\0")
    .update(normalizedTarget)
    .digest("hex")}`;
}

export function buildDomainInventoryQuery(domainKey, policyConfig) {
  const domain = RETENTION_DOMAINS.find(({ key }) => key === domainKey);
  if (!domain) {
    throw new Customer360RetentionError("Unknown retention inventory domain.");
  }
  const normalizedPolicy = normalizeRetentionPolicy({
    version: RETENTION_POLICY_VERSION,
    domains: Object.fromEntries(
      RETENTION_DOMAINS.map((candidate) => [
        candidate.key,
        candidate.key === domainKey
          ? policyConfig
          : {
              action: "preserve",
              ageBucketsDays: [30],
              minimumAgeDays: null,
            },
      ]),
    ),
  });
  const config = normalizedPolicy.domains[domainKey];
  const values = [];
  const selectParts = [
    "count(*)::text as total_count",
    "count(*) filter (where age_at is null)::text as unknown_age_count",
  ];
  const boundaryParameterIndexes = [];

  for (const boundary of config.ageBucketsDays) {
    values.push(boundary);
    boundaryParameterIndexes.push(values.length + 1);
  }

  const firstParameter = boundaryParameterIndexes[0];
  selectParts.push(
    `count(*) filter (where age_at > ${ageCutoff(firstParameter)})::text as bucket_0`,
  );
  for (let index = 1; index < boundaryParameterIndexes.length; index += 1) {
    const youngerBoundary = boundaryParameterIndexes[index - 1];
    const olderBoundary = boundaryParameterIndexes[index];
    selectParts.push(
      `count(*) filter (where age_at <= ${ageCutoff(youngerBoundary)} and age_at > ${ageCutoff(olderBoundary)})::text as bucket_${index}`,
    );
  }
  const lastBucketIndex = config.ageBucketsDays.length;
  const lastParameter = boundaryParameterIndexes.at(-1);
  selectParts.push(
    `count(*) filter (where age_at <= ${ageCutoff(lastParameter)})::text as bucket_${lastBucketIndex}`,
  );

  if (config.action === "preserve") {
    selectParts.push("0::text as actionable_count");
  } else {
    values.push(config.minimumAgeDays);
    selectParts.push(
      `count(*) filter (where age_at is not null and age_at <= ${ageCutoff(values.length + 1)})::text as actionable_count`,
    );
  }

  return Object.freeze({
    domain: domain.key,
    text: `
      with scoped as (
        select ${domain.ageExpression} as age_at
        from ${domain.table} ${domain.alias}
        where ${domain.alias}.license_namespace = $1
          and ${domain.predicate}
      )
      select
        ${selectParts.join(",\n        ")}
      from scoped
    `,
    values: Object.freeze(values),
    bucketLabels: buildBucketLabels(config.ageBucketsDays),
  });
}

export async function runRetentionInventory({
  policy,
  namespace,
  databaseUrl,
  pool,
} = {}) {
  assertNamespace(namespace);
  const normalizedPolicy = normalizeRetentionPolicy(policy);
  const targetFingerprint = fingerprintDatabaseTarget(databaseUrl, namespace);
  const ownsPool = !pool;
  const activePool = pool || await createPostgresPool(databaseUrl);
  let client;
  let transactionStarted = false;

  try {
    client = await activePool.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionStarted = true;
    const domains = [];

    for (const domain of RETENTION_DOMAINS) {
      const config = normalizedPolicy.domains[domain.key];
      const query = buildDomainInventoryQuery(domain.key, config);
      const result = await client.query({
        text: query.text,
        values: [namespace, ...query.values],
      });
      if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) {
        throw new Customer360RetentionError(
          "Retention inventory aggregate query returned an invalid shape.",
        );
      }
      domains.push(buildDomainReport(domain.key, config, query, result.rows[0]));
    }

    await client.query("ROLLBACK");
    transactionStarted = false;
    return Object.freeze({
      mode: "dry_run_inventory",
      namespace,
      targetFingerprint,
      policyDigest: retentionPolicyDigest(normalizedPolicy),
      domains: Object.freeze(domains),
    });
  } catch (error) {
    if (transactionStarted && client) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The caller only receives a fixed, secret-safe failure.
      }
    }
    if (error instanceof Customer360RetentionError) throw error;
    throw new Customer360RetentionError("Retention inventory database read failed.");
  } finally {
    client?.release?.();
    if (ownsPool) await activePool.end();
  }
}

export async function runRetentionSelfTest() {
  const policy = buildSelfTestPolicy();
  const calls = [];
  let aggregateIndex = 0;
  const client = {
    async query(query) {
      calls.push(query);
      if (typeof query === "string") return { rows: [] };
      const config = policy.domains[RETENTION_DOMAINS[aggregateIndex].key];
      aggregateIndex += 1;
      const row = {
        total_count: "7",
        unknown_age_count: "1",
        actionable_count: config.action === "preserve" ? "0" : "2",
      };
      for (let index = 0; index <= config.ageBucketsDays.length; index += 1) {
        row[`bucket_${index}`] = "2";
      }
      return { rows: [row] };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
  };
  const secretUrl =
    "postgresql://retention_operator:self-test-secret@db.example.test:5432/customer360?sslmode=verify-full";
  const report = await runRetentionInventory({
    policy,
    namespace: "test",
    databaseUrl: secretUrl,
    pool,
  });

  const commandText = calls
    .map((call) => typeof call === "string" ? call : call.text)
    .join("\n");
  if (/\b(?:delete|insert|update|truncate|alter|drop|create)\b/i.test(commandText)) {
    throw new Customer360RetentionError("Retention self-test observed a write statement.");
  }
  const serialized = JSON.stringify(report);
  if (
    serialized.includes("self-test-secret") ||
    serialized.includes("db.example.test") ||
    report.domains.length !== RETENTION_DOMAINS.length ||
    aggregateIndex !== RETENTION_DOMAINS.length
  ) {
    throw new Customer360RetentionError("Retention self-test privacy assertion failed.");
  }

  return Object.freeze({
    mode: report.mode,
    domains: report.domains.length,
    databaseConnections: 0,
    simulatedPoolConnections: 1,
    writeStatements: 0,
    targetFingerprint: report.targetFingerprint,
    policyDigest: report.policyDigest,
  });
}

function buildDomainReport(domainKey, config, query, row) {
  const ageBuckets = query.bucketLabels.map((bucket, index) => Object.freeze({
    bucket,
    count: normalizeAggregateCount(row[`bucket_${index}`]),
  }));
  ageBuckets.push(Object.freeze({
    bucket: "unknown",
    count: normalizeAggregateCount(row.unknown_age_count),
  }));
  return Object.freeze({
    domain: domainKey,
    totalCount: normalizeAggregateCount(row.total_count),
    ageBuckets: Object.freeze(ageBuckets),
    proposedAction: Object.freeze({
      action: config.action,
      minimumAgeDays: config.minimumAgeDays,
      candidateCount: normalizeAggregateCount(row.actionable_count),
    }),
  });
}

function buildBucketLabels(boundaries) {
  const labels = [`under_${boundaries[0]}_days`];
  for (let index = 1; index < boundaries.length; index += 1) {
    labels.push(`from_${boundaries[index - 1]}_to_under_${boundaries[index]}_days`);
  }
  labels.push(`at_least_${boundaries.at(-1)}_days`);
  return Object.freeze(labels);
}

function buildSelfTestPolicy() {
  return normalizeRetentionPolicy({
    version: RETENTION_POLICY_VERSION,
    domains: Object.fromEntries(
      RETENTION_DOMAINS.map((domain, index) => [
        domain.key,
        domain.immutable || index % 3 === 0
          ? {
              action: "preserve",
              ageBucketsDays: [index + 2, index + 12],
              minimumAgeDays: null,
            }
          : {
              action: index % 2 === 0 ? "delete" : "review",
              ageBucketsDays: [index + 2, index + 12],
              minimumAgeDays: index + 20,
            },
      ]),
    ),
  });
}

function normalizeAgeBuckets(value, domainKey) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_BUCKET_BOUNDARIES
  ) {
    throw new Customer360RetentionError(
      `Retention policy domain ${domainKey} ageBucketsDays must contain 1-${MAX_BUCKET_BOUNDARIES} boundaries.`,
    );
  }
  const boundaries = value.map((boundary) =>
    normalizeAgeDays(
      boundary,
      `Retention policy domain ${domainKey} ageBucketsDays boundary`,
    ));
  for (let index = 1; index < boundaries.length; index += 1) {
    if (boundaries[index] <= boundaries[index - 1]) {
      throw new Customer360RetentionError(
        `Retention policy domain ${domainKey} ageBucketsDays must be strictly increasing.`,
      );
    }
  }
  return Object.freeze(boundaries);
}

function normalizeAgeDays(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_AGE_DAYS) {
    throw new Customer360RetentionError(
      `${fieldName} must be an integer from 1 to ${MAX_AGE_DAYS}.`,
    );
  }
  return value;
}

function normalizeAggregateCount(value) {
  const normalized = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Customer360RetentionError(
      "Retention inventory aggregate count was invalid or too large to report safely.",
    );
  }
  return normalized;
}

function assertExactKeys(value, expectedKeys, label) {
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Customer360RetentionError(
      `${label} must contain exactly: ${sortedExpected.join(", ")}.`,
    );
  }
}

function assertNamespace(namespace) {
  if (!VALID_NAMESPACES.has(namespace)) {
    throw new Customer360RetentionError(
      "Retention inventory namespace must be exactly production or test.",
    );
  }
}

function parseSafeDatabaseUrl(databaseUrl) {
  try {
    const target = parsePostgresTarget(databaseUrl, "Retention inventory database URL");
    const parsed = new URL(target.connectionString);
    if (!target.local && (!parsed.username || !parsed.password)) {
      throw new Error("missing credentials");
    }
    return target;
  } catch {
    throw new Customer360RetentionError("Retention inventory database URL is invalid.");
  }
}

async function createPostgresPool(databaseUrl) {
  const parsed = parseSafeDatabaseUrl(databaseUrl);
  const { Pool } = await loadPostgresModule(repositoryRootFromScript());
  return new Pool({
    connectionString: parsed.connectionString,
    application_name: "sidestream-customer-360-retention-inventory",
    max: 1,
    ssl: parsed.ssl,
  });
}

async function loadPostgresModule(worktreeRoot) {
  try {
    return await import("pg");
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  }

  const { readFile } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  let gitPointer;
  try {
    gitPointer = (await readFile(path.join(worktreeRoot, ".git"), "utf8")).trim();
  } catch {
    throw new Customer360RetentionError("The pg dependency is unavailable.");
  }
  const match = /^gitdir:\s*(.+)$/i.exec(gitPointer);
  const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  const markerIndex = match?.[1].indexOf(marker) ?? -1;
  if (!match || markerIndex < 0) {
    throw new Customer360RetentionError("The pg dependency is unavailable.");
  }
  const requireFromBase = createRequire(
    path.join(match[1].slice(0, markerIndex), "package.json"),
  );
  return requireFromBase("pg");
}

async function readPolicyFile(filename) {
  try {
    return JSON.parse(await readRegularFile(filename, { maximumBytes: 256 * 1024 }));
  } catch {
    throw new Customer360RetentionError(
      "Unable to read a valid retention policy file.",
    );
  }
}

function readOption(argv, index, name) {
  const argument = argv[index];
  if (argument.startsWith(`${name}=`)) {
    const value = argument.slice(name.length + 1);
    if (!value) throw new Customer360RetentionError(`${name} requires a value.`);
    return [value, index];
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Customer360RetentionError(`${name} requires a value.`);
  }
  return [value, index + 1];
}

function ageCutoff(parameterIndex) {
  return `(transaction_timestamp() - ($${parameterIndex}::integer * interval '1 day'))`;
}

function repositoryRootFromScript() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function printHelp() {
  console.log(`Usage:
  node scripts/plan-customer-360-retention.mjs --dry-run \\
    --namespace <production|test> --policy /path/to/reviewed-policy.json
  node scripts/plan-customer-360-retention.mjs --self-test

Inventory is read-only and dry-run by default. There is no apply mode. Test uses
SIDESTREAM_TEST_POSTGRES_URL; Production uses POSTGRES_URL. Remote targets must
use authenticated credentials and sslmode=verify-full.

The version 1 policy must contain an explicit entry for every domain. Each entry
contains action (preserve, review, or delete), ageBucketsDays, and
minimumAgeDays. Immutable merge audits and pending identity reviews must be
preserved. The report contains aggregate counts only; it never returns customer
rows, identities, target coordinates, or credentials.`);
}

async function main() {
  const options = parseRetentionArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.selfTest) {
    const result = await runRetentionSelfTest();
    console.log(`PASS: Customer 360 retention no-write self-test ${JSON.stringify(result)}`);
    return;
  }

  const policy = await readPolicyFile(options.policyPath);
  const environmentName = options.namespace === "test"
    ? "SIDESTREAM_TEST_POSTGRES_URL"
    : "POSTGRES_URL";
  const databaseUrl = process.env[environmentName];
  if (!databaseUrl) {
    throw new Customer360RetentionError(
      `Retention inventory requires ${environmentName} in the process environment.`,
    );
  }
  const report = await runRetentionInventory({
    policy,
    namespace: options.namespace,
    databaseUrl,
  });
  console.log(JSON.stringify(report, null, 2));
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedUrl) {
  main().catch((error) => {
    console.error(
      error instanceof Customer360RetentionError
        ? error.message
        : "Customer 360 retention inventory failed.",
    );
    process.exitCode = 1;
  });
}

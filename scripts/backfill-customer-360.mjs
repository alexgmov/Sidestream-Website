#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BACKFILL_CHECKPOINT_VERSION = 3;
export const DEFAULT_BACKFILL_BATCH_SIZE = 100;

export const DURABLE_EVIDENCE_FIELDS = Object.freeze({
  accountId: "account_identity",
  activationId: "activation_record",
  stripeCustomerId: "stripe_customer",
  stripeCheckoutSessionId: "stripe_checkout_session",
  stripePaymentIntentId: "stripe_payment_intent",
  stripeSubscriptionId: "stripe_subscription",
  installIdHash: "install_identity_hash",
  supportCode: "support_code",
  installerReceiptIdHash: "installer_receipt_hash",
});

// These fields may exist in reviewed historical exports, but are discarded
// before planning, hashing, checkpointing, reporting, or database access.
export const IGNORED_NON_IDENTITY_FIELDS = Object.freeze([
  "email",
  "contactEmail",
  "displayName",
  "name",
  "ip",
  "ipAddress",
  "userAgent",
  "createdAt",
  "updatedAt",
  "occurredAt",
  "receivedAt",
  "timestamp",
  "behavior",
  "searchText",
  "sourceTitle",
  "gmailCampaignHash",
  "gmailCampaignHmac",
  "installerRequestHmac",
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOWERCASE_HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const SUPPORT_CODE_PATTERN = /^SIDE-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const STRIPE_ID_PATTERNS = Object.freeze({
  stripeCustomerId: /^cus_[A-Za-z0-9_]{1,196}$/,
  stripeCheckoutSessionId: /^cs_(?:test_)?[A-Za-z0-9_]{1,191}$/,
  stripePaymentIntentId: /^pi_[A-Za-z0-9_]{1,197}$/,
  stripeSubscriptionId: /^sub_[A-Za-z0-9_]{1,196}$/,
});
const ALLOWED_RECORD_FIELDS = new Set([
  "recordId",
  ...Object.keys(DURABLE_EVIDENCE_FIELDS),
  ...IGNORED_NON_IDENTITY_FIELDS,
]);
const VALID_NAMESPACES = new Set(["production", "test"]);
const ACTIONABLE_REPORT_KEYS = Object.freeze([
  "componentRef",
  "status",
  "reason",
  "recordCount",
  "evidenceTypes",
  "writes",
]);
const RUNTIME_CONFLICT_REASONS = new Set([
  "existing_evidence_disagrees",
  "existing_account_disagrees",
]);

export class Customer360BackfillError extends Error {
  constructor(message) {
    super(message);
    this.name = "Customer360BackfillError";
  }
}

export function parseBackfillArgs(argv) {
  const options = {
    apply: false,
    dryRun: true,
    selfTest: false,
    help: false,
    namespace: "test",
    namespaceExplicit: false,
    inputPath: "",
    checkpointPath: "",
    batchSize: DEFAULT_BACKFILL_BATCH_SIZE,
  };
  let sawDryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      options.apply = true;
      options.dryRun = false;
    } else if (argument === "--dry-run") {
      sawDryRun = true;
      options.dryRun = true;
    } else if (argument === "--self-test") {
      options.selfTest = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (
      argument === "--namespace" ||
      argument.startsWith("--namespace=") ||
      argument === "--target" ||
      argument.startsWith("--target=")
    ) {
      const optionName = argument.startsWith("--target") ? "--target" : "--namespace";
      [options.namespace, index] = readOption(argv, index, optionName);
      options.namespaceExplicit = true;
    } else if (argument === "--input" || argument.startsWith("--input=")) {
      [options.inputPath, index] = readOption(argv, index, "--input");
    } else if (
      argument === "--checkpoint" ||
      argument.startsWith("--checkpoint=")
    ) {
      [options.checkpointPath, index] = readOption(argv, index, "--checkpoint");
    } else if (
      argument === "--batch-size" ||
      argument.startsWith("--batch-size=")
    ) {
      const [rawBatchSize, nextIndex] = readOption(argv, index, "--batch-size");
      index = nextIndex;
      options.batchSize = parseBatchSize(rawBatchSize);
    } else {
      throw new Customer360BackfillError(
        `Unknown option ${JSON.stringify(argument)}. Use --help for supported options.`,
      );
    }
  }

  if (options.apply && sawDryRun) {
    throw new Customer360BackfillError("Choose either --apply or --dry-run, not both.");
  }
  assertNamespace(options.namespace);
  if (options.apply && options.namespace === "production") {
    throw new Customer360BackfillError(
      "Production --apply is disabled. Customer 360 cutover requires a later human-gated action.",
    );
  }
  if (options.apply && !options.namespaceExplicit) {
    throw new Customer360BackfillError(
      "Apply requires an explicit --namespace test; the default is never apply authority.",
    );
  }
  if (options.apply && !options.inputPath) {
    throw new Customer360BackfillError("Apply requires a reviewed offline --input file.");
  }
  if (options.apply && !options.checkpointPath) {
    throw new Customer360BackfillError("Apply requires an explicit --checkpoint file.");
  }
  return Object.freeze(options);
}

export function normalizeBackfillInput(input) {
  const rawRecords = Array.isArray(input)
    ? input
    : isRecord(input) && input.version === 1 && Array.isArray(input.records)
      ? input.records
      : null;
  if (!rawRecords) {
    throw new Customer360BackfillError(
      "Backfill input must be a JSON array or {version: 1, records: [...] }.",
    );
  }

  const seenRecordIds = new Set();
  const records = rawRecords.map((record, index) => {
    const normalized = normalizeBackfillRecord(record, index);
    if (seenRecordIds.has(normalized.recordId)) {
      throw new Customer360BackfillError("Backfill input contains a duplicate recordId.");
    }
    seenRecordIds.add(normalized.recordId);
    return normalized;
  });
  return Object.freeze(records);
}

export function buildBackfillPlan(input, namespace = "test") {
  assertNamespace(namespace);
  const records = normalizeBackfillInput(input);
  const union = new UnionFind(records.length);
  const evidenceOwner = new Map();

  for (let index = 0; index < records.length; index += 1) {
    for (const evidence of records[index].evidence) {
      const key = evidenceKey(evidence);
      const previous = evidenceOwner.get(key);
      if (previous === undefined) evidenceOwner.set(key, index);
      else union.join(previous, index);
    }
  }

  const grouped = new Map();
  for (let index = 0; index < records.length; index += 1) {
    const root = union.root(index);
    const indexes = grouped.get(root) || [];
    indexes.push(index);
    grouped.set(root, indexes);
  }

  const components = [...grouped.values()]
    .map((recordIndexes) => buildComponent(records, recordIndexes, namespace))
    .sort((left, right) => left.firstRecordIndex - right.firstRecordIndex);
  if (new Set(components.map(({ componentRef }) => componentRef)).size !== components.length) {
    throw new Customer360BackfillError("Backfill component references must be unique.");
  }
  const digest = createHash("sha256")
    .update("sidestream-customer-360-backfill-input:v1\0")
    .update(namespace)
    .update("\0")
    .update(JSON.stringify(records))
    .digest("hex");

  return Object.freeze({
    version: 1,
    namespace,
    inputDigest: digest,
    records,
    components: Object.freeze(components),
  });
}

export function buildDryRunReport(input, { namespace = "test", checkpoint } = {}) {
  const plan = buildBackfillPlan(input, namespace);
  const normalizedCheckpoint = normalizeCheckpoint(checkpoint, plan);
  const pending = plan.components.slice(normalizedCheckpoint.nextComponentIndex);
  const componentReports = pending.map((component) => safePlannedComponent(component));
  return Object.freeze({
    mode: "dry_run",
    namespace,
    inputDigest: plan.inputDigest,
    checkpoint: safeCheckpointSummary(
      normalizedCheckpoint,
      plan,
      normalizedCheckpoint.outcomes.actionableReports,
    ),
    summary: summarizeComponents(plan, pending),
    components: Object.freeze(componentReports),
  });
}

export function buildBackfillQueries(schema = "public") {
  const quotedSchema = quoteIdentifier(schema);
  return Object.freeze({
    evidenceOwners: `
      select distinct link.profile_id
      from ${quotedSchema}.sidestream_customer_identity_links link
      join jsonb_to_recordset($2::jsonb) as evidence(link_type text, link_value text)
        on evidence.link_type = link.link_type
       and evidence.link_value = link.link_value
      where link.license_namespace = $1
      order by link.profile_id
    `,
    installOwners: `
      select distinct install.profile_id
      from ${quotedSchema}.sidestream_customer_installs install
      where install.license_namespace = $1
        and install.install_id_hash = any($2::text[])
      order by install.profile_id
    `,
    profileRoot: `
      with recursive profile_chain as (
        select profile.id, profile.merged_into
        from ${quotedSchema}.sidestream_customer_profiles profile
        where profile.id = $1 and profile.license_namespace = $2
        union all
        select profile.id, profile.merged_into
        from profile_chain chain
        join ${quotedSchema}.sidestream_customer_profiles profile
          on profile.id = chain.merged_into
         and profile.license_namespace = $2
      )
      select id
      from profile_chain
      where merged_into is null
    `,
    accountOwner: `
      select link.link_value
      from ${quotedSchema}.sidestream_customer_identity_links link
      where link.license_namespace = $1
        and link.profile_id = $2
        and link.link_type = 'account_identity'
    `,
    insertProfile: `
      insert into ${quotedSchema}.sidestream_customer_profiles (
        id, license_namespace
      ) values ($1, $2)
      on conflict (id) do nothing
    `,
    insertEvidence: `
      insert into ${quotedSchema}.sidestream_customer_identity_links (
        profile_id, license_namespace, link_type, link_value
      ) values ($1, $2, $3, $4)
      on conflict (license_namespace, link_type, link_value) do nothing
    `,
    insertInstall: `
      insert into ${quotedSchema}.sidestream_customer_installs (
        profile_id, license_namespace, install_id_hash
      ) values ($1, $2, $3)
      on conflict (license_namespace, install_id_hash) do nothing
    `,
  });
}

export async function runCustomer360Backfill({
  input,
  namespace = "test",
  apply = false,
  pool,
  schema = "public",
  checkpoint,
  batchSize = DEFAULT_BACKFILL_BATCH_SIZE,
  afterBatchCommitted,
  writeCheckpoint,
} = {}) {
  assertNamespace(namespace);
  const plan = buildBackfillPlan(input || [], namespace);
  const normalizedCheckpoint = normalizeCheckpoint(checkpoint, plan);
  const normalizedBatchSize = parseBatchSize(batchSize);

  if (!apply) {
    return buildDryRunReport(input || [], { namespace, checkpoint: normalizedCheckpoint });
  }
  if (namespace === "production") {
    throw new Customer360BackfillError(
      "Production --apply is disabled. Customer 360 cutover requires a later human-gated action.",
    );
  }
  if (!pool || typeof pool.connect !== "function") {
    throw new Customer360BackfillError("Test apply requires an injected disposable Postgres pool.");
  }
  if (writeCheckpoint !== undefined && typeof writeCheckpoint !== "function") {
    throw new TypeError("writeCheckpoint must be a function when provided");
  }
  if (afterBatchCommitted !== undefined && typeof afterBatchCommitted !== "function") {
    throw new TypeError("afterBatchCommitted must be a function when provided");
  }

  const queries = buildBackfillQueries(schema);
  const results = [];
  let currentCheckpoint = normalizedCheckpoint;
  for (
    let start = normalizedCheckpoint.nextComponentIndex;
    start < plan.components.length;
    start += normalizedBatchSize
  ) {
    const end = Math.min(start + normalizedBatchSize, plan.components.length);
    const batch = plan.components.slice(start, end);
    const client = await pool.connect();
    const batchResults = [];
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `sidestream_customer_profile_merge:${namespace}`,
      ]);
      for (const component of batch) {
        batchResults.push(await applyComponent(client, queries, component, namespace));
      }
      await client.query("commit");
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // Keep the original operation error.
      }
      throw error;
    } finally {
      client.release();
    }

    const processedRecords = plan.components
      .slice(0, end)
      .reduce((total, component) => total + component.recordIndexes.length, 0);
    const outcomes = accumulateCheckpointOutcomes(
      currentCheckpoint.outcomes,
      batchResults,
    );
    const nextCheckpoint = Object.freeze({
      version: BACKFILL_CHECKPOINT_VERSION,
      namespace,
      inputDigest: plan.inputDigest,
      nextComponentIndex: end,
      processedRecords,
      outcomes,
    });
    await afterBatchCommitted?.(nextCheckpoint, Object.freeze(batchResults));
    await writeCheckpoint?.(nextCheckpoint);
    currentCheckpoint = nextCheckpoint;
    results.push(...batchResults);
  }

  return Object.freeze({
    mode: "apply",
    namespace,
    inputDigest: plan.inputDigest,
    checkpoint: safeCheckpointSummary(
      currentCheckpoint,
      plan,
      normalizedCheckpoint.outcomes.actionableReports,
    ),
    summary: summarizeApplyResults(
      plan,
      results,
      normalizedCheckpoint,
      currentCheckpoint,
    ),
    components: Object.freeze(results),
  });
}

export function deterministicProfileId(namespace, recordId) {
  assertNamespace(namespace);
  const normalizedRecordId = normalizeRecordId(recordId);
  const digest = createHash("sha256")
    .update("sidestream-customer-360-backfill-profile:v1\0")
    .update(namespace)
    .update("\0")
    .update(normalizedRecordId)
    .digest("hex");
  const hex = `${digest.slice(0, 12)}5${digest.slice(13, 16)}a${digest.slice(17, 32)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function safeBackfillReference(kind, value) {
  const digest = createHash("sha256")
    .update("sidestream-customer-360-backfill-report:v1\0")
    .update(String(kind))
    .update("\0")
    .update(String(value))
    .digest("hex")
    .slice(0, 16);
  return `${kind}_${digest}`;
}

export async function loadPostgresModule(worktreeRoot = process.cwd()) {
  try {
    return await import("pg");
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  }

  // Orchestra worktrees intentionally do not duplicate the base checkout's
  // dependency tree. Resolve the Git common directory without spawning Git,
  // then require pg relative to the read-only base package when needed.
  const { readFile } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  const gitPointerPath = path.join(worktreeRoot, ".git");
  let gitPointer;
  try {
    gitPointer = (await readFile(gitPointerPath, "utf8")).trim();
  } catch {
    throw new Customer360BackfillError(
      "The pg dependency is unavailable from this checkout.",
    );
  }
  const match = /^gitdir:\s*(.+)$/i.exec(gitPointer);
  const worktreesMarker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  const markerIndex = match?.[1].indexOf(worktreesMarker) ?? -1;
  if (!match || markerIndex < 0) {
    throw new Customer360BackfillError(
      "The pg dependency is unavailable from this checkout.",
    );
  }
  const baseRoot = match[1].slice(0, markerIndex);
  const requireFromBase = createRequire(path.join(baseRoot, "package.json"));
  return requireFromBase("pg");
}

export async function runBackfillSelfTest() {
  const sharedIgnored = {
    email: "same-person@example.com",
    displayName: "Same Person",
    ipAddress: "203.0.113.9",
    occurredAt: "2026-07-15T10:00:00.000Z",
    behavior: "same-behavior",
    gmailCampaignHmac: "campaign-secret-value",
  };
  const legacyRecordA = "1".padStart(64, "0");
  const legacyRecordB = "2".padStart(64, "0");
  const isolated = [
    { recordId: legacyRecordA, ...sharedIgnored },
    { recordId: legacyRecordB, ...sharedIgnored },
  ];
  const isolatedPlan = buildBackfillPlan(isolated, "test");
  assert.equal(isolatedPlan.components.length, 2);
  assert.ok(isolatedPlan.components.every((component) => component.orphan));
  assert.notEqual(
    deterministicProfileId("test", legacyRecordA),
    deterministicProfileId("test", legacyRecordB),
  );

  const installIdHash = "a".repeat(64);
  const joinedPlan = buildBackfillPlan([
    { recordId: "3".padStart(64, "0"), installIdHash },
    { recordId: "4".padStart(64, "0"), installIdHash },
  ], "test");
  assert.equal(joinedPlan.components.length, 1);

  assert.throws(
    () => parseBackfillArgs(["--apply", "--namespace", "production"]),
    /Production --apply is disabled/,
  );

  let poolCalls = 0;
  let checkpointWrites = 0;
  const dryRun = await runCustomer360Backfill({
    input: isolated,
    namespace: "test",
    apply: false,
    pool: {
      connect() {
        poolCalls += 1;
        throw new Error("dry-run attempted a database connection");
      },
    },
    writeCheckpoint() {
      checkpointWrites += 1;
      throw new Error("dry-run attempted a checkpoint write");
    },
  });
  assert.equal(poolCalls, 0);
  assert.equal(checkpointWrites, 0);
  const serialized = JSON.stringify(dryRun);
  for (const secret of Object.values(sharedIgnored)) {
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(secret), "i"));
  }
  return Object.freeze({
    dryRunDatabaseConnections: poolCalls,
    dryRunCheckpointWrites: checkpointWrites,
    isolatedAnonymousProfiles: isolatedPlan.components.length,
    durableJoinComponents: joinedPlan.components.length,
  });
}

async function applyComponent(client, queries, component, namespace) {
  if (component.inputConflict) {
    return safeAppliedComponent(component, "conflict", "input_accounts_disagree", 0);
  }

  const ownerIds = new Set();
  if (component.evidence.length > 0) {
    const owners = await client.query(queries.evidenceOwners, [
      namespace,
      JSON.stringify(component.evidence.map((evidence) => ({
        link_type: evidence.linkType,
        link_value: evidence.linkValue,
      }))),
    ]);
    for (const row of owners.rows) ownerIds.add(row.profile_id);
  }
  if (component.installIdHashes.length > 0) {
    const installOwners = await client.query(queries.installOwners, [
      namespace,
      component.installIdHashes,
    ]);
    for (const row of installOwners.rows) ownerIds.add(row.profile_id);
  }

  const candidateId = component.deterministicProfileId;
  for (const deterministicId of component.deterministicProfileIds) {
    const deterministicRoot = await findProfileRoot(
      client,
      queries,
      deterministicId,
      namespace,
    );
    if (deterministicRoot) ownerIds.add(deterministicRoot);
  }
  if (ownerIds.size > 1) {
    return safeAppliedComponent(component, "conflict", "existing_evidence_disagrees", 0);
  }

  let profileId = ownerIds.values().next().value || null;
  const accountEvidence = component.evidence.find(
    (evidence) => evidence.linkType === "account_identity",
  );
  if (profileId && accountEvidence) {
    const accountOwner = await client.query(queries.accountOwner, [namespace, profileId]);
    if (
      accountOwner.rows.length > 1 ||
      (accountOwner.rows.length === 1 &&
        accountOwner.rows[0].link_value !== accountEvidence.linkValue)
    ) {
      return safeAppliedComponent(component, "conflict", "existing_account_disagrees", 0);
    }
  }

  let writes = 0;
  if (!profileId) {
    const inserted = await client.query(queries.insertProfile, [candidateId, namespace]);
    writes += inserted.rowCount || 0;
    profileId = await findProfileRoot(client, queries, candidateId, namespace);
    if (!profileId) {
      throw new Customer360BackfillError(
        "Deterministic profile ID collided outside the selected license namespace.",
      );
    }
  }

  for (const evidence of component.evidence) {
    const inserted = await client.query(queries.insertEvidence, [
      profileId,
      namespace,
      evidence.linkType,
      evidence.linkValue,
    ]);
    writes += inserted.rowCount || 0;
  }
  for (const installIdHash of component.installIdHashes) {
    const inserted = await client.query(queries.insertInstall, [
      profileId,
      namespace,
      installIdHash,
    ]);
    writes += inserted.rowCount || 0;
  }

  const verifiedOwners = new Set();
  if (component.evidence.length > 0) {
    const owners = await client.query(queries.evidenceOwners, [
      namespace,
      JSON.stringify(component.evidence.map((evidence) => ({
        link_type: evidence.linkType,
        link_value: evidence.linkValue,
      }))),
    ]);
    for (const row of owners.rows) verifiedOwners.add(row.profile_id);
  }
  if (component.installIdHashes.length > 0) {
    const installOwners = await client.query(queries.installOwners, [
      namespace,
      component.installIdHashes,
    ]);
    for (const row of installOwners.rows) verifiedOwners.add(row.profile_id);
  }
  if (
    verifiedOwners.size > 1 ||
    (verifiedOwners.size === 1 && !verifiedOwners.has(profileId))
  ) {
    throw new Customer360BackfillError(
      "Durable identity ownership changed inside the serialized backfill transaction.",
    );
  }

  return safeAppliedComponent(
    component,
    component.orphan ? "orphan" : writes > 0 ? "applied" : "unchanged",
    component.orphan ? "no_durable_bridge" : null,
    writes,
  );
}

async function findProfileRoot(client, queries, profileId, namespace) {
  const result = await client.query(queries.profileRoot, [profileId, namespace]);
  if (result.rows.length > 1) {
    throw new Customer360BackfillError("Customer profile merge chain has multiple roots.");
  }
  return result.rows[0]?.id || null;
}

function normalizeBackfillRecord(record, index) {
  if (!isRecord(record)) {
    throw new Customer360BackfillError(`Backfill record ${index + 1} must be an object.`);
  }
  for (const field of Object.keys(record)) {
    if (!ALLOWED_RECORD_FIELDS.has(field)) {
      throw new Customer360BackfillError(
        `Backfill record ${index + 1} contains unsupported field ${JSON.stringify(field)}.`,
      );
    }
  }

  const recordId = normalizeRecordId(record.recordId);
  const evidence = [];
  for (const [field, linkType] of Object.entries(DURABLE_EVIDENCE_FIELDS)) {
    const rawValue = record[field];
    if (rawValue === undefined || rawValue === null || rawValue === "") continue;
    const linkValue = normalizeEvidenceValue(field, rawValue);
    evidence.push(Object.freeze({ field, linkType, linkValue }));
  }
  evidence.sort((left, right) =>
    left.linkType.localeCompare(right.linkType) ||
    left.linkValue.localeCompare(right.linkValue));

  return Object.freeze({ recordId, evidence: Object.freeze(evidence) });
}

function normalizeEvidenceValue(field, value) {
  if (field === "accountId" || field === "activationId") {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
      throw new Customer360BackfillError(`${field} must be a UUID.`);
    }
    return value.toLowerCase();
  }
  if (field === "installIdHash" || field === "installerReceiptIdHash") {
    if (typeof value !== "string" || !LOWERCASE_HEX_64_PATTERN.test(value)) {
      throw new Customer360BackfillError(`${field} must be a lowercase hex64 digest.`);
    }
    return value;
  }
  if (field === "supportCode") {
    if (typeof value !== "string" || !SUPPORT_CODE_PATTERN.test(value)) {
      throw new Customer360BackfillError("supportCode must use the canonical SIDE code format.");
    }
    return value;
  }
  const stripePattern = STRIPE_ID_PATTERNS[field];
  if (!stripePattern || typeof value !== "string" || !stripePattern.test(value)) {
    throw new Customer360BackfillError(`${field} must be a canonical Stripe object ID.`);
  }
  return value;
}

function buildComponent(records, recordIndexes, namespace) {
  const evidenceByKey = new Map();
  const accountIds = new Set();
  for (const index of recordIndexes) {
    for (const evidence of records[index].evidence) {
      evidenceByKey.set(evidenceKey(evidence), evidence);
      if (evidence.linkType === "account_identity") accountIds.add(evidence.linkValue);
    }
  }
  const evidence = [...evidenceByKey.values()].sort((left, right) =>
    left.linkType.localeCompare(right.linkType) ||
    left.linkValue.localeCompare(right.linkValue));
  const seedRecordId = recordIndexes
    .map((index) => records[index].recordId)
    .sort()[0];
  const installIdHashes = evidence
    .filter((item) => item.linkType === "install_identity_hash")
    .map((item) => item.linkValue);
  const deterministicProfileIds = recordIndexes.map((index) =>
    deterministicProfileId(namespace, records[index].recordId));
  return Object.freeze({
    namespace,
    firstRecordIndex: Math.min(...recordIndexes),
    recordIndexes: Object.freeze([...recordIndexes]),
    seedRecordId,
    componentRef: safeBackfillReference("component", seedRecordId),
    evidence: Object.freeze(evidence),
    evidenceTypes: Object.freeze([...new Set(evidence.map((item) => item.linkType))]),
    installIdHashes: Object.freeze(installIdHashes),
    orphan: evidence.length === 0,
    inputConflict: accountIds.size > 1,
    deterministicProfileId: deterministicProfileId(namespace, seedRecordId),
    deterministicProfileIds: Object.freeze(deterministicProfileIds),
  });
}

function normalizeCheckpoint(checkpoint, plan) {
  if (checkpoint === undefined || checkpoint === null) {
    return Object.freeze({
      version: BACKFILL_CHECKPOINT_VERSION,
      namespace: plan.namespace,
      inputDigest: plan.inputDigest,
      nextComponentIndex: 0,
      processedRecords: 0,
      outcomes: emptyCheckpointOutcomes(),
    });
  }
  if (isRecord(checkpoint) && checkpoint.version !== BACKFILL_CHECKPOINT_VERSION) {
    throw new Customer360BackfillError(
      "Older checkpoint versions are lossy and cannot be resumed; restart from reviewed input.",
    );
  }
  if (
    !isRecord(checkpoint) ||
    checkpoint.version !== BACKFILL_CHECKPOINT_VERSION ||
    checkpoint.namespace !== plan.namespace ||
    checkpoint.inputDigest !== plan.inputDigest ||
    !Number.isSafeInteger(checkpoint.nextComponentIndex) ||
    checkpoint.nextComponentIndex < 0 ||
    checkpoint.nextComponentIndex > plan.components.length ||
    !Number.isSafeInteger(checkpoint.processedRecords) ||
    checkpoint.processedRecords < 0 ||
    checkpoint.processedRecords > plan.records.length ||
    !validCheckpointOutcomes(checkpoint.outcomes, checkpoint.nextComponentIndex, plan)
  ) {
    throw new Customer360BackfillError(
      "Checkpoint does not match this namespace, input digest, or component boundary.",
    );
  }
  const expectedProcessedRecords = plan.components
    .slice(0, checkpoint.nextComponentIndex)
    .reduce((total, component) => total + component.recordIndexes.length, 0);
  if (checkpoint.processedRecords !== expectedProcessedRecords) {
    throw new Customer360BackfillError("Checkpoint processed-record count is inconsistent.");
  }
  return Object.freeze({
    version: checkpoint.version,
    namespace: checkpoint.namespace,
    inputDigest: checkpoint.inputDigest,
    nextComponentIndex: checkpoint.nextComponentIndex,
    processedRecords: checkpoint.processedRecords,
    outcomes: freezeCheckpointOutcomes(checkpoint.outcomes),
  });
}

function safeCheckpointSummary(checkpoint, plan, resumedActionableReports) {
  return Object.freeze({
    version: checkpoint.version,
    nextComponentIndex: checkpoint.nextComponentIndex,
    componentCount: plan.components.length,
    processedRecords: checkpoint.processedRecords,
    recordCount: plan.records.length,
    complete: checkpoint.nextComponentIndex === plan.components.length,
    outcomes: safeCheckpointOutcomeCounts(checkpoint.outcomes),
    resumedActionableReports: Object.freeze([...resumedActionableReports]),
  });
}

function safePlannedComponent(component) {
  return Object.freeze({
    componentRef: component.componentRef,
    status: component.inputConflict
      ? "conflict"
      : component.orphan
        ? "orphan"
        : "candidate",
    reason: component.inputConflict
      ? "input_accounts_disagree"
      : component.orphan
        ? "no_durable_bridge"
        : null,
    recordCount: component.recordIndexes.length,
    evidenceTypes: component.evidenceTypes,
  });
}

function safeAppliedComponent(component, status, reason, writes) {
  return Object.freeze({
    componentRef: component.componentRef,
    status,
    reason,
    recordCount: component.recordIndexes.length,
    evidenceTypes: component.evidenceTypes,
    writes,
  });
}

function summarizeComponents(plan, pending) {
  return Object.freeze({
    records: plan.records.length,
    components: plan.components.length,
    pendingComponents: pending.length,
    candidateComponents: pending.filter(
      (component) => !component.inputConflict && !component.orphan,
    ).length,
    orphanComponents: pending.filter((component) => component.orphan).length,
    conflictComponents: pending.filter((component) => component.inputConflict).length,
  });
}

function summarizeApplyResults(plan, results, startingCheckpoint, currentCheckpoint) {
  const outcomes = currentCheckpoint.outcomes;
  const currentRun = summarizeCurrentRun(results);
  const actionableReports = outcomes.actionableReports;
  const checkpointedUnresolved = Object.freeze({
    scope: "checkpointedProcessedPlanPrefix",
    processedPlanPrefixComponents: currentCheckpoint.nextComponentIndex,
    orphanComponents: actionableReports.filter(({ status }) => status === "orphan").length,
    conflictComponents: actionableReports.filter(({ status }) => status === "conflict").length,
  });
  return Object.freeze({
    records: plan.records.length,
    components: plan.components.length,
    resumedAtComponent: startingCheckpoint.nextComponentIndex,
    processedThisRun: currentRun.processedComponents,
    orphanComponents: checkpointedUnresolved.orphanComponents,
    conflictComponents: checkpointedUnresolved.conflictComponents,
    writes: currentRun.writes,
    compatibilityAliasScopes: Object.freeze({
      processedThisRun: "currentRun.processedComponents",
      orphanComponents: "checkpointedUnresolved.orphanComponents",
      conflictComponents: "checkpointedUnresolved.conflictComponents",
      writes: "currentRun.writes",
    }),
    checkpointedUnresolved,
    currentRun,
  });
}

function summarizeCurrentRun(results) {
  return Object.freeze({
    processedComponents: results.length,
    appliedComponents: results.filter((result) => result.status === "applied").length,
    unchangedComponents: results.filter((result) => result.status === "unchanged").length,
    orphanComponents: results.filter((result) => result.status === "orphan").length,
    conflictComponents: results.filter((result) => result.status === "conflict").length,
    writes: results.reduce((total, result) => total + result.writes, 0),
  });
}

function emptyCheckpointOutcomes() {
  return Object.freeze({
    processedComponents: 0,
    appliedComponents: 0,
    unchangedComponents: 0,
    orphanComponents: 0,
    conflictComponents: 0,
    writes: 0,
    actionableReports: Object.freeze([]),
  });
}

function accumulateCheckpointOutcomes(previous, results) {
  return Object.freeze({
    processedComponents: previous.processedComponents + results.length,
    appliedComponents: previous.appliedComponents +
      results.filter((result) => result.status === "applied").length,
    unchangedComponents: previous.unchangedComponents +
      results.filter((result) => result.status === "unchanged").length,
    orphanComponents: previous.orphanComponents +
      results.filter((result) => result.status === "orphan").length,
    conflictComponents: previous.conflictComponents +
      results.filter((result) => result.status === "conflict").length,
    writes: previous.writes +
      results.reduce((total, result) => total + result.writes, 0),
    actionableReports: Object.freeze([
      ...previous.actionableReports,
      ...results
        .filter(({ status }) => status === "conflict" || status === "orphan")
        .map((report) => freezeActionableReport(report)),
    ]),
  });
}

function validCheckpointOutcomes(outcomes, nextComponentIndex, plan) {
  if (!isRecord(outcomes)) return false;
  const countKeys = [
    "processedComponents",
    "appliedComponents",
    "unchangedComponents",
    "orphanComponents",
    "conflictComponents",
    "writes",
  ];
  if (
    Object.keys(outcomes).length !== countKeys.length + 1 ||
    !Object.hasOwn(outcomes, "actionableReports") ||
    countKeys.some((key) => !Number.isSafeInteger(outcomes[key]) || outcomes[key] < 0) ||
    !Array.isArray(outcomes.actionableReports)
  ) {
    return false;
  }
  const statusTotal = outcomes.appliedComponents + outcomes.unchangedComponents +
    outcomes.orphanComponents + outcomes.conflictComponents;
  if (
    outcomes.processedComponents !== nextComponentIndex ||
    statusTotal !== outcomes.processedComponents
  ) {
    return false;
  }

  const processedComponents = plan.components.slice(0, nextComponentIndex);
  const seenComponentRefs = new Set();
  for (const report of outcomes.actionableReports) {
    if (!validActionableReport(report)) return false;
    const matches = processedComponents.filter(
      ({ componentRef }) => componentRef === report.componentRef,
    );
    if (matches.length !== 1 || seenComponentRefs.has(report.componentRef)) return false;
    seenComponentRefs.add(report.componentRef);
    const [component] = matches;
    if (
      report.recordCount !== component.recordIndexes.length ||
      !sameStringArray(report.evidenceTypes, component.evidenceTypes) ||
      !reportMatchesComponentOutcome(report, component)
    ) {
      return false;
    }
  }

  if (
    outcomes.actionableReports.filter(({ status }) => status === "orphan").length !==
      outcomes.orphanComponents ||
    outcomes.actionableReports.filter(({ status }) => status === "conflict").length !==
      outcomes.conflictComponents ||
    outcomes.actionableReports.reduce((total, report) => total + report.writes, 0) >
      outcomes.writes
  ) {
    return false;
  }
  return processedComponents
    .filter(({ inputConflict, orphan }) => inputConflict || orphan)
    .every(({ componentRef }) => seenComponentRefs.has(componentRef));
}

function freezeCheckpointOutcomes(outcomes) {
  return Object.freeze({
    processedComponents: outcomes.processedComponents,
    appliedComponents: outcomes.appliedComponents,
    unchangedComponents: outcomes.unchangedComponents,
    orphanComponents: outcomes.orphanComponents,
    conflictComponents: outcomes.conflictComponents,
    writes: outcomes.writes,
    actionableReports: Object.freeze(
      outcomes.actionableReports.map((report) => freezeActionableReport(report)),
    ),
  });
}

function safeCheckpointOutcomeCounts(outcomes) {
  // A commit can survive without its following checkpoint. These counters are
  // checkpointed observations, not a claim about cumulative physical writes.
  return Object.freeze({
    processedComponents: outcomes.processedComponents,
    appliedComponents: outcomes.appliedComponents,
    unchangedComponents: outcomes.unchangedComponents,
    orphanComponents: outcomes.orphanComponents,
    conflictComponents: outcomes.conflictComponents,
    writes: outcomes.writes,
  });
}

function validActionableReport(report) {
  if (
    !isRecord(report) ||
    Object.keys(report).length !== ACTIONABLE_REPORT_KEYS.length ||
    ACTIONABLE_REPORT_KEYS.some((key) => !Object.hasOwn(report, key)) ||
    typeof report.componentRef !== "string" ||
    !/^component_[0-9a-f]{16}$/.test(report.componentRef) ||
    (report.status !== "conflict" && report.status !== "orphan") ||
    typeof report.reason !== "string" ||
    !Number.isSafeInteger(report.recordCount) ||
    report.recordCount < 1 ||
    !Array.isArray(report.evidenceTypes) ||
    !report.evidenceTypes.every((value) =>
      Object.values(DURABLE_EVIDENCE_FIELDS).includes(value)) ||
    !Number.isSafeInteger(report.writes) ||
    report.writes < 0 ||
    (report.status === "conflict" && report.writes !== 0)
  ) {
    return false;
  }
  return true;
}

function reportMatchesComponentOutcome(report, component) {
  if (component.inputConflict) {
    return report.status === "conflict" && report.reason === "input_accounts_disagree";
  }
  if (component.orphan) {
    return report.status === "orphan" && report.reason === "no_durable_bridge";
  }
  return report.status === "conflict" && RUNTIME_CONFLICT_REASONS.has(report.reason);
}

function freezeActionableReport(report) {
  return Object.freeze({
    componentRef: report.componentRef,
    status: report.status,
    reason: report.reason,
    recordCount: report.recordCount,
    evidenceTypes: Object.freeze([...report.evidenceTypes]),
    writes: report.writes,
  });
}

function sameStringArray(left, right) {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function evidenceKey(evidence) {
  return `${evidence.linkType}\0${evidence.linkValue}`;
}

function assertNamespace(namespace) {
  if (!VALID_NAMESPACES.has(namespace)) {
    throw new Customer360BackfillError(
      "Customer 360 backfill namespace must be exactly production or test.",
    );
  }
}

function assertExactString(value, fieldName, maxLength) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Customer360BackfillError(
      `${fieldName} must contain 1-${maxLength} exact printable characters.`,
    );
  }
  return value;
}

function normalizeRecordId(value) {
  const recordId = assertExactString(value, "recordId", 64);
  if (UUID_PATTERN.test(recordId)) return recordId.toLowerCase();
  if (LOWERCASE_HEX_64_PATTERN.test(recordId)) return recordId;
  throw new Customer360BackfillError(
    "recordId must be an opaque UUID or lowercase hex64 idempotency token.",
  );
}

function parseBatchSize(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000) {
    throw new Customer360BackfillError("--batch-size must be an integer from 1 to 1000.");
  }
  return parsed;
}

function readOption(argv, index, name) {
  const argument = argv[index];
  if (argument.startsWith(`${name}=`)) {
    const value = argument.slice(name.length + 1);
    if (!value) throw new Customer360BackfillError(`${name} requires a value.`);
    return [value, index];
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Customer360BackfillError(`${name} requires a value.`);
  }
  return [value, index + 1];
}

function quoteIdentifier(identifier) {
  if (typeof identifier !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(identifier)) {
    throw new Customer360BackfillError("Unsafe Postgres schema identifier.");
  }
  return `"${identifier}"`;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class UnionFind {
  constructor(size) {
    this.parents = Array.from({ length: size }, (_, index) => index);
  }

  root(index) {
    let current = index;
    while (this.parents[current] !== current) {
      this.parents[current] = this.parents[this.parents[current]];
      current = this.parents[current];
    }
    return current;
  }

  join(left, right) {
    const leftRoot = this.root(left);
    const rightRoot = this.root(right);
    if (leftRoot === rightRoot) return;
    if (leftRoot < rightRoot) this.parents[rightRoot] = leftRoot;
    else this.parents[leftRoot] = rightRoot;
  }
}

async function readJsonFile(filename) {
  const { readFile } = await import("node:fs/promises");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    throw new Customer360BackfillError(
      `Unable to read valid JSON from ${path.basename(filename)}: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  return parsed;
}

async function readCheckpointFile(filename) {
  const { readFile } = await import("node:fs/promises");
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Customer360BackfillError(
      `Unable to read checkpoint ${path.basename(filename)}.`,
    );
  }
}

async function writeCheckpointFile(filename, checkpoint) {
  const { rename, writeFile } = await import("node:fs/promises");
  const temporaryPath = `${filename}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(checkpoint)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, filename);
}

function printHelp() {
  console.log(`Usage:
  node scripts/backfill-customer-360.mjs [--dry-run] [--input FILE]
  node scripts/backfill-customer-360.mjs --apply --namespace test \\
    --input FILE --checkpoint FILE [--batch-size N]
  node scripts/backfill-customer-360.mjs --self-test --dry-run

Dry-run is the default and never opens a database connection or writes a
checkpoint. Apply is restricted to the disposable test database selected by
SIDESTREAM_TEST_POSTGRES_URL. Production apply is intentionally unavailable.

Input is a reviewed JSON array (or {"version":1,"records":[]}). Each record
requires an opaque UUID or lowercase hex64 recordId and may contain only the
documented durable identity fields. Email, name, IP, timing, behavior, and Gmail
campaign fields are ignored.`);
}

async function main() {
  const options = parseBackfillArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.selfTest) {
    const result = await runBackfillSelfTest();
    console.log(`PASS: Customer 360 backfill self-test ${JSON.stringify(result)}`);
    return;
  }

  const input = options.inputPath ? await readJsonFile(options.inputPath) : [];
  if (!options.apply) {
    const checkpoint = options.checkpointPath
      ? await readCheckpointFile(options.checkpointPath)
      : null;
    console.log(JSON.stringify(buildDryRunReport(input, {
      namespace: options.namespace,
      checkpoint,
    }), null, 2));
    return;
  }

  const { createTestPoolOptions, requireSafeTestDatabaseUrl } = await import(
    "./run-postgres-integration.mjs"
  );
  const { Pool } = await loadPostgresModule(repositoryRootFromScript());
  const databaseUrl = requireSafeTestDatabaseUrl(process.env);
  const pool = new Pool(createTestPoolOptions(databaseUrl));
  try {
    const checkpoint = await readCheckpointFile(options.checkpointPath);
    const result = await runCustomer360Backfill({
      input,
      namespace: options.namespace,
      apply: true,
      pool,
      checkpoint,
      batchSize: options.batchSize,
      writeCheckpoint: (nextCheckpoint) =>
        writeCheckpointFile(options.checkpointPath, nextCheckpoint),
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}

function repositoryRootFromScript() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Customer 360 backfill failed");
    process.exitCode = 1;
  });
}

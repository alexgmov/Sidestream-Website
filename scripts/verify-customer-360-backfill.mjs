#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DURABLE_EVIDENCE_FIELDS,
  IGNORED_NON_IDENTITY_FIELDS,
  buildBackfillPlan,
  buildBackfillQueries,
  buildDryRunReport,
  parseBackfillArgs,
  runBackfillSelfTest,
  runCustomer360Backfill,
} from "./backfill-customer-360.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const backfillPath = path.join(repositoryRoot, "scripts", "backfill-customer-360.mjs");
const EXPECTED_DURABLE_FIELDS = Object.freeze({
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
const FORBIDDEN_SQL_SIGNALS = [
  "email",
  "display_name",
  "name",
  "ip_address",
  "user_agent",
  "occurred_at",
  "received_at",
  "behavior",
  "gmail",
  "campaign",
  "installer_request",
];

export async function verifyCustomer360Backfill() {
  assert.deepEqual(DURABLE_EVIDENCE_FIELDS, EXPECTED_DURABLE_FIELDS);
  for (const field of [
    "email",
    "displayName",
    "ipAddress",
    "occurredAt",
    "behavior",
    "gmailCampaignHmac",
    "installerRequestHmac",
  ]) {
    assert.ok(IGNORED_NON_IDENTITY_FIELDS.includes(field), `${field} must be discarded`);
  }

  const queries = buildBackfillQueries("verification_schema");
  for (const [name, sql] of Object.entries(queries)) {
    const normalized = sql.trim().toLowerCase();
    assert.match(normalized, /^(select|with recursive|insert)\b/, name);
    assert.doesNotMatch(
      normalized,
      /\b(create|alter|drop|truncate|grant|revoke|comment)\b/,
      `${name} must not contain schema or privilege mutation`,
    );
    assert.doesNotMatch(normalized, /\b(update|delete)\b/, `${name} must be append-only`);
    for (const signal of FORBIDDEN_SQL_SIGNALS) {
      assert.doesNotMatch(
        normalized,
        new RegExp(`\\b${signal}\\b`),
        `${name} must not read or join on ${signal}`,
      );
    }
  }

  const source = await readFile(backfillPath, "utf8");
  assert.doesNotMatch(
    source,
    /\b(?:create|alter|drop|truncate)\s+(?:table|schema|index|function|trigger|extension)\b/i,
    "backfill implementation must not own schema mutation",
  );
  assert.doesNotMatch(source, /from\s+["']node:(?:http|https|net|dns|tls)["']/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);

  assert.throws(
    () => parseBackfillArgs(["--apply", "--namespace", "production"]),
    /Production --apply is disabled/,
  );
  await assert.rejects(
    runCustomer360Backfill({
      input: [],
      namespace: "production",
      apply: true,
      pool: { connect: () => Promise.reject(new Error("must not connect")) },
    }),
    /Production --apply is disabled/,
  );

  const ignoredSecrets = Object.freeze({
    email: "private.customer@example.com",
    displayName: "Private Customer Name",
    ipAddress: "198.51.100.77",
    occurredAt: "2026-07-15T17:45:00.000Z",
    behavior: "private exact behavior",
    gmailCampaignHmac: "private-gmail-campaign-hash",
    installerRequestHmac: "private-installer-request-hash",
  });
  const orphanInput = [
    { recordId: "orphan-source-a", ...ignoredSecrets },
    { recordId: "orphan-source-b", ...ignoredSecrets },
  ];
  const orphanPlan = buildBackfillPlan(orphanInput, "test");
  assert.equal(orphanPlan.components.length, 2);
  assert.ok(orphanPlan.components.every((component) => component.orphan));

  const durableHash = "d".repeat(64);
  const joinedPlan = buildBackfillPlan([
    { recordId: "durable-source-a", installIdHash: durableHash, ...ignoredSecrets },
    { recordId: "durable-source-b", installIdHash: durableHash, ...ignoredSecrets },
  ], "test");
  assert.equal(joinedPlan.components.length, 1);

  const accountA = "11111111-1111-4111-8111-111111111111";
  const accountB = "22222222-2222-4222-8222-222222222222";
  const conflictInput = [
    {
      recordId: "conflict-source-a",
      accountId: accountA,
      supportCode: "SIDE-A1B2-C3D4-E5F6",
      ...ignoredSecrets,
    },
    {
      recordId: "conflict-source-b",
      accountId: accountB,
      supportCode: "SIDE-A1B2-C3D4-E5F6",
      ...ignoredSecrets,
    },
  ];
  const conflictReport = buildDryRunReport(conflictInput, { namespace: "test" });
  assert.equal(conflictReport.summary.conflictComponents, 1);
  assertPrivacySafeReport(conflictReport, Object.values(ignoredSecrets));

  let databaseConnections = 0;
  let checkpointWrites = 0;
  const dryRun = await runCustomer360Backfill({
    input: orphanInput,
    namespace: "test",
    apply: false,
    pool: {
      connect() {
        databaseConnections += 1;
        throw new Error("dry-run connected to Postgres");
      },
    },
    writeCheckpoint() {
      checkpointWrites += 1;
      throw new Error("dry-run wrote a checkpoint");
    },
  });
  assert.equal(databaseConnections, 0);
  assert.equal(checkpointWrites, 0);
  assertPrivacySafeReport(dryRun, Object.values(ignoredSecrets));

  const embedded = await runBackfillSelfTest();
  assert.equal(embedded.dryRunDatabaseConnections, 0);
  assert.equal(embedded.dryRunCheckpointWrites, 0);

  return Object.freeze({
    durableEvidenceFields: Object.keys(DURABLE_EVIDENCE_FIELDS).length,
    sqlStatements: Object.keys(queries).length,
    dryRunDatabaseConnections: databaseConnections,
    dryRunCheckpointWrites: checkpointWrites,
    anonymousOrphans: orphanPlan.components.length,
    durableComponents: joinedPlan.components.length,
    privacySafeConflictComponents: conflictReport.summary.conflictComponents,
  });
}

export function assertPrivacySafeReport(report, forbiddenValues = []) {
  const serialized = JSON.stringify(report);
  for (const value of forbiddenValues) {
    assert.equal(
      serialized.toLowerCase().includes(String(value).toLowerCase()),
      false,
      "report leaked a forbidden input value",
    );
  }
  assert.doesNotMatch(serialized, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  assert.doesNotMatch(serialized, /\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  assertReportKeys(report);
}

function assertReportKeys(report) {
  assert.deepEqual(
    Object.keys(report).sort(),
    ["checkpoint", "components", "inputDigest", "mode", "namespace", "summary"],
  );
  for (const component of report.components) {
    const allowed = new Set([
      "componentRef",
      "status",
      "reason",
      "recordCount",
      "evidenceTypes",
      "writes",
    ]);
    for (const key of Object.keys(component)) {
      assert.ok(allowed.has(key), `unsafe report component key: ${key}`);
    }
    assert.match(component.componentRef, /^component_[0-9a-f]{16}$/);
    assert.ok(Array.isArray(component.evidenceTypes));
    for (const evidenceType of component.evidenceTypes) {
      assert.ok(Object.values(DURABLE_EVIDENCE_FIELDS).includes(evidenceType));
    }
  }
}

function parseVerifierArgs(argv) {
  const options = { selfTest: false, help: false };
  for (const argument of argv) {
    if (argument === "--self-test") options.selfTest = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown option ${JSON.stringify(argument)}`);
  }
  return options;
}

async function main() {
  const options = parseVerifierArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/verify-customer-360-backfill.mjs --self-test");
    return;
  }
  if (!options.selfTest) {
    throw new Error("Use --self-test to run the Customer 360 backfill verifier.");
  }
  const result = await verifyCustomer360Backfill();
  console.log(`PASS: Customer 360 backfill verification ${JSON.stringify(result)}`);
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

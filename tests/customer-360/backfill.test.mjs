import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  Customer360BackfillError,
  buildBackfillApprovalMessage,
  buildBackfillPlan,
  buildDryRunReport,
  deterministicProfileId,
  normalizeBackfillInput,
  parseBackfillArgs,
  runCustomer360Backfill,
  verifyBackfillApproval,
} from "../../scripts/backfill-customer-360.mjs";
import {
  readRegularFile,
  writeRegularFileAtomically,
} from "../../scripts/lib/safe-file.mjs";
import { assertPrivacySafeReport } from "../../scripts/verify-customer-360-backfill.mjs";

const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
const ACTIVATION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INSTALL_A = "a".repeat(64);
const RECEIPT_A = "b".repeat(64);
const SUPPORT_A = "SIDE-A1B2-C3D4-E5F6";
const PRIVATE_FIELDS = Object.freeze({
  email: "customer.private@example.com",
  contactEmail: "second.private@example.com",
  displayName: "Customer Private",
  name: "Private Name",
  ip: "203.0.113.4",
  ipAddress: "198.51.100.8",
  userAgent: "Private Browser 1.0",
  createdAt: "2026-07-15T01:02:03.000Z",
  updatedAt: "2026-07-15T04:05:06.000Z",
  occurredAt: "2026-07-15T07:08:09.000Z",
  receivedAt: "2026-07-15T10:11:12.000Z",
  timestamp: "2026-07-15T13:14:15.000Z",
  behavior: "private behavior segment",
  searchText: "private exact query",
  sourceTitle: "private source title",
  gmailCampaignHash: "gmail-private-hash",
  gmailCampaignHmac: "gmail-private-hmac",
  installerRequestHmac: "installer-private-hmac",
});

test("normalization retains exact durable evidence and rejects PII", () => {
  for (const [field, value] of Object.entries(PRIVATE_FIELDS)) {
    assert.throws(
      () => normalizeBackfillInput([{ recordId: opaqueRecordId(99), [field]: value }]),
      new RegExp(`prohibited field "${field}"`),
    );
  }
  const records = normalizeBackfillInput({
    version: 1,
    records: [{
      recordId: opaqueRecordId(1),
      accountId: ACCOUNT_A.toUpperCase(),
      activationId: ACTIVATION_A,
      stripeCustomerId: "cus_Customer360A",
      stripeCheckoutSessionId: "cs_test_Customer360A",
      stripePaymentIntentId: "pi_Customer360A",
      stripeSubscriptionId: "sub_Customer360A",
      installIdHash: INSTALL_A,
      supportCode: SUPPORT_A,
      installerReceiptIdHash: RECEIPT_A,
    }],
  });

  assert.equal(records.length, 1);
  assert.deepEqual(Object.keys(records[0]), ["recordId", "evidence"]);
  assert.deepEqual(
    records[0].evidence.map(({ linkType, linkValue }) => [linkType, linkValue]),
    [
      ["account_identity", ACCOUNT_A],
      ["activation_record", ACTIVATION_A],
      ["install_identity_hash", INSTALL_A],
      ["installer_receipt_hash", RECEIPT_A],
      ["stripe_checkout_session", "cs_test_Customer360A"],
      ["stripe_customer", "cus_Customer360A"],
      ["stripe_payment_intent", "pi_Customer360A"],
      ["stripe_subscription", "sub_Customer360A"],
      ["support_code", SUPPORT_A],
    ],
  );
  const normalizedJson = JSON.stringify(records);
  for (const privateValue of Object.values(PRIVATE_FIELDS)) {
    assert.equal(normalizedJson.includes(privateValue), false);
  }

  assert.throws(
    () => normalizeBackfillInput([{ recordId: opaqueRecordId(2), emailHash: "not-allowed" }]),
    /unsupported field "emailHash"/,
  );
  assert.throws(
    () => normalizeBackfillInput([
      { recordId: opaqueRecordId(3) },
      { recordId: opaqueRecordId(3) },
    ]),
    /duplicate recordId/,
  );
  for (const [field, value, expected] of [
    ["accountId", "not-a-uuid", /accountId must be a UUID/],
    ["installIdHash", "A".repeat(64), /lowercase hex64/],
    ["installerReceiptIdHash", "b".repeat(63), /lowercase hex64/],
    ["supportCode", "side-A1B2-C3D4-E5F6", /canonical SIDE/],
    ["stripeCustomerId", "customer_123", /canonical Stripe/],
  ]) {
    assert.throws(
      () => normalizeBackfillInput([{ recordId: opaqueRecordId(4), [field]: value }]),
      expected,
    );
  }
});

test("recordId accepts only canonical opaque idempotency tokens", () => {
  for (const recordId of [
    "customer.private@example.com",
    "198.51.100.44",
    "2026-07-15T14:15:16.000Z",
    "Private Customer Name",
    "downloaded-seven-times",
  ]) {
    assert.throws(
      () => normalizeBackfillInput([{ recordId }]),
      /opaque UUID or lowercase hex64/,
    );
    assert.throws(
      () => deterministicProfileId("test", recordId),
      /opaque UUID or lowercase hex64/,
    );
  }

  const canonicalUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.deepEqual(
    normalizeBackfillInput([
      { recordId: canonicalUuid.toUpperCase() },
      { recordId: opaqueRecordId(5) },
    ]).map(({ recordId }) => recordId),
    [canonicalUuid, opaqueRecordId(5)],
  );
});

test("only durable evidence joins records; unbridged historical rows remain separate", () => {
  const ignoredOnly = [
    { recordId: opaqueRecordId(10) },
    { recordId: opaqueRecordId(11) },
  ];
  const orphanPlan = buildBackfillPlan(ignoredOnly, "test");
  assert.equal(orphanPlan.components.length, 2);
  assert.ok(orphanPlan.components.every((component) => component.orphan));
  assert.notEqual(
    orphanPlan.components[0].deterministicProfileId,
    orphanPlan.components[1].deterministicProfileId,
  );

  for (const durableField of [
    ["accountId", ACCOUNT_A],
    ["activationId", ACTIVATION_A],
    ["stripeCustomerId", "cus_DurableJoin"],
    ["stripeCheckoutSessionId", "cs_test_DurableJoin"],
    ["stripePaymentIntentId", "pi_DurableJoin"],
    ["stripeSubscriptionId", "sub_DurableJoin"],
    ["installIdHash", INSTALL_A],
    ["supportCode", SUPPORT_A],
    ["installerReceiptIdHash", RECEIPT_A],
  ]) {
    const [field, value] = durableField;
    const plan = buildBackfillPlan([
      { recordId: opaqueRecordId(20), [field]: value },
      { recordId: opaqueRecordId(21), [field]: value },
    ], "test");
    assert.equal(plan.components.length, 1, field);
    assert.equal(plan.components[0].recordIndexes.length, 2, field);
  }

  const transitive = buildBackfillPlan([
    { recordId: opaqueRecordId(30), installIdHash: INSTALL_A },
    { recordId: opaqueRecordId(31), installIdHash: INSTALL_A, supportCode: SUPPORT_A },
    { recordId: opaqueRecordId(32), supportCode: SUPPORT_A },
  ], "test");
  assert.equal(transitive.components.length, 1);
  assert.equal(transitive.components[0].recordIndexes.length, 3);
});

test("conflict and orphan reports are privacy-safe and contain no identity values", () => {
  const conflictRecordA = opaqueRecordId(40);
  const conflictRecordB = opaqueRecordId(41);
  const orphanRecord = opaqueRecordId(42);
  const conflictInput = [
    {
      recordId: conflictRecordA,
      accountId: ACCOUNT_A,
      installIdHash: INSTALL_A,
    },
    {
      recordId: conflictRecordB,
      accountId: ACCOUNT_B,
      installIdHash: INSTALL_A,
    },
    { recordId: orphanRecord },
  ];
  const report = buildDryRunReport(conflictInput, { namespace: "test" });
  assert.equal(report.summary.conflictComponents, 1);
  assert.equal(report.summary.orphanComponents, 1);
  assertPrivacySafeReport(report, [
    ...Object.values(PRIVATE_FIELDS),
    ACCOUNT_A,
    ACCOUNT_B,
    INSTALL_A,
    conflictRecordA,
    conflictRecordB,
    orphanRecord,
  ]);
  assert.deepEqual(
    report.components.map(({ status, reason }) => [status, reason]),
    [
      ["conflict", "input_accounts_disagree"],
      ["orphan", "no_durable_bridge"],
    ],
  );
});

test("dry-run performs no database, checkpoint, or batch-callback side effects", async () => {
  let databaseConnections = 0;
  let checkpointWrites = 0;
  let batchCallbacks = 0;
  const report = await runCustomer360Backfill({
    input: [{ recordId: opaqueRecordId(50), installIdHash: INSTALL_A }],
    namespace: "test",
    apply: false,
    pool: {
      connect() {
        databaseConnections += 1;
        throw new Error("database call in dry-run");
      },
    },
    writeCheckpoint() {
      checkpointWrites += 1;
      throw new Error("checkpoint write in dry-run");
    },
    afterBatchCommitted() {
      batchCallbacks += 1;
      throw new Error("batch callback in dry-run");
    },
  });
  assert.equal(report.mode, "dry_run");
  assert.equal(databaseConnections, 0);
  assert.equal(checkpointWrites, 0);
  assert.equal(batchCallbacks, 0);
});

test("Production apply is rejected before any connection and CLI apply is explicit", async () => {
  assert.equal(parseBackfillArgs([]).dryRun, true);
  assert.equal(parseBackfillArgs(["--self-test", "--dry-run"]).selfTest, true);
  assert.throws(
    () => parseBackfillArgs(["--apply", "--target", "production"]),
    /Production --apply is disabled/,
  );
  assert.throws(
    () => parseBackfillArgs(["--apply", "--namespace", "test"]),
    /reviewed offline --input/,
  );
  assert.throws(
    () => parseBackfillArgs([
      "--apply",
      "--namespace",
      "test",
      "--input",
      "fixture.json",
    ]),
    /explicit --checkpoint/,
  );

  let connections = 0;
  await assert.rejects(
    runCustomer360Backfill({
      input: [{ recordId: opaqueRecordId(60), accountId: ACCOUNT_A }],
      namespace: "production",
      apply: true,
      pool: {
        connect() {
          connections += 1;
          throw new Error("Production connection attempted");
        },
      },
    }),
    /Production --apply is disabled/,
  );
  assert.equal(connections, 0);
});

test("Test apply approval is expiring and binds every reviewed artifact", () => {
  const secret = "backfill-approval-secret-with-at-least-32-bytes";
  const evidence = {
    inputDigest: "1".repeat(64),
    targetFingerprint: "2".repeat(64),
    candidateSha: "4".repeat(40),
    migrationDigest: "5".repeat(64),
  };
  const unsigned = {
    apply: true,
    expectedInputDigest: evidence.inputDigest,
    expectedTargetFingerprint: evidence.targetFingerprint,
    expectedConnectedFingerprint: "3".repeat(64),
    expectedCandidateSha: evidence.candidateSha,
    expectedMigrationDigest: evidence.migrationDigest,
    batchSize: 100,
    approvalExpiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    approvalToken: "",
  };
  const options = {
    ...unsigned,
    approvalToken: createHmac("sha256", secret)
      .update(buildBackfillApprovalMessage(unsigned))
      .digest("hex"),
  };

  assert.doesNotThrow(() => verifyBackfillApproval(options, evidence, {
    SIDESTREAM_C360_BACKFILL_APPROVAL_SECRET: secret,
  }));
  assert.throws(
    () => verifyBackfillApproval({
      ...options,
      expectedConnectedFingerprint: "6".repeat(64),
    }, evidence, { SIDESTREAM_C360_BACKFILL_APPROVAL_SECRET: secret }),
    /token is invalid/,
  );
  assert.throws(
    () => verifyBackfillApproval({ ...options, approvalToken: "0".repeat(64) }, evidence, {
      SIDESTREAM_C360_BACKFILL_APPROVAL_SECRET: secret,
    }),
    /token is invalid/,
  );
  assert.throws(
    () => verifyBackfillApproval({
      ...options,
      approvalExpiresAt: new Date(Date.now() + 25 * 60 * 60 * 1_000).toISOString(),
    }, evidence, { SIDESTREAM_C360_BACKFILL_APPROVAL_SECRET: secret }),
    /expired or exceeds 24 hours/,
  );
});

test("operator files reject symlinks, special files, and oversized inputs", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "sidestream-safe-file-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const regular = path.join(directory, "input.json");
  const link = path.join(directory, "input-link.json");
  const checkpoint = path.join(directory, "checkpoint.json");
  await writeFile(regular, "123456789", { mode: 0o600 });
  await symlink(regular, link);

  assert.equal(await readRegularFile(regular, { maximumBytes: 9 }), "123456789");
  await assert.rejects(readRegularFile(regular, { maximumBytes: 8 }));
  await assert.rejects(readRegularFile(link));
  await assert.rejects(readRegularFile("/dev/null"), /operator_file_rejected/);
  await chmod(regular, 0o644);
  await assert.rejects(readRegularFile(regular, { requirePrivate: true }), /operator_file_rejected/);
  await writeRegularFileAtomically(checkpoint, "checkpoint");
  assert.equal(await readRegularFile(checkpoint), "checkpoint");
});

test("deterministic profile IDs and checkpoints bind resume to exact normalized input", () => {
  const stableRecordId = opaqueRecordId(70);
  assert.equal(
    deterministicProfileId("test", stableRecordId),
    deterministicProfileId("test", stableRecordId),
  );
  assert.notEqual(
    deterministicProfileId("test", stableRecordId),
    deterministicProfileId("production", stableRecordId),
  );
  assert.match(deterministicProfileId("test", stableRecordId), /^[0-9a-f-]{36}$/);

  const input = [{ recordId: opaqueRecordId(80), activationId: ACTIVATION_A }];
  const plan = buildBackfillPlan(input, "test");
  const checkpoint = {
    version: 3,
    namespace: "test",
    inputDigest: plan.inputDigest,
    nextComponentIndex: 1,
    processedRecords: 1,
    outcomes: {
      processedComponents: 1,
      appliedComponents: 1,
      unchangedComponents: 0,
      orphanComponents: 0,
      conflictComponents: 0,
      writes: 2,
      actionableReports: [],
    },
  };
  const complete = buildDryRunReport(input, { namespace: "test", checkpoint });
  assert.equal(complete.checkpoint.complete, true);
  assert.equal(complete.summary.pendingComponents, 0);

  assert.throws(
    () => buildDryRunReport(input, {
      namespace: "test",
      checkpoint: {
        ...checkpoint,
        outcomes: {
          ...checkpoint.outcomes,
          conflictComponents: 1,
        },
      },
    }),
    /Checkpoint does not match/,
  );
  assert.throws(
    () => buildDryRunReport(input, {
      namespace: "test",
      checkpoint: {
        version: 2,
        namespace: "test",
        inputDigest: plan.inputDigest,
        nextComponentIndex: 1,
        processedRecords: 1,
      },
    }),
    /lossy/,
  );

  assert.throws(
    () => buildDryRunReport([{ recordId: opaqueRecordId(81), activationId: ACTIVATION_A }], {
      namespace: "test",
      checkpoint,
    }),
    Customer360BackfillError,
  );
});

test("v3 checkpoints retain only validated actionable prefix reports", () => {
  const input = [
    {
      recordId: opaqueRecordId(90),
      accountId: ACCOUNT_A,
      installIdHash: INSTALL_A,
    },
    {
      recordId: opaqueRecordId(91),
      accountId: ACCOUNT_B,
      installIdHash: INSTALL_A,
    },
    { recordId: opaqueRecordId(92) },
  ];
  const plan = buildBackfillPlan(input, "test");
  const [conflict, orphan] = buildDryRunReport(input, { namespace: "test" }).components;
  const reports = [
    { ...conflict, writes: 0 },
    { ...orphan, writes: 1 },
  ];
  const checkpoint = {
    version: 3,
    namespace: "test",
    inputDigest: plan.inputDigest,
    nextComponentIndex: 2,
    processedRecords: 3,
    outcomes: {
      processedComponents: 2,
      appliedComponents: 0,
      unchangedComponents: 0,
      orphanComponents: 1,
      conflictComponents: 1,
      writes: 1,
      actionableReports: reports,
    },
  };

  const complete = buildDryRunReport(input, { namespace: "test", checkpoint });
  assert.deepEqual(complete.checkpoint.resumedActionableReports, reports);
  assert.deepEqual(complete.components, []);
  assertPrivacySafeReport(complete, [
    ACCOUNT_A,
    ACCOUNT_B,
    INSTALL_A,
    ...input.map(({ recordId }) => recordId),
  ]);

  for (const actionableReports of [
    [],
    [reports[0], reports[0]],
    [{ ...reports[0], writes: 1 }, reports[1]],
    [{ ...reports[0], recordCount: 1 }, reports[1]],
    [{ ...reports[0], evidenceTypes: ["activation_record"] }, reports[1]],
    [{ ...reports[0], componentRef: reports[1].componentRef }, reports[1]],
    [{ ...reports[0], reason: "private@example.com" }, reports[1]],
    [{ ...reports[0], email: "private@example.com" }, reports[1]],
  ]) {
    assert.throws(
      () => buildDryRunReport(input, {
        namespace: "test",
        checkpoint: {
          ...checkpoint,
          outcomes: { ...checkpoint.outcomes, actionableReports },
        },
      }),
      /Checkpoint does not match/,
    );
  }
});

function opaqueRecordId(value) {
  return value.toString(16).padStart(64, "0");
}

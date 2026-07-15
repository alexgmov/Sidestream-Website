import assert from "node:assert/strict";
import test from "node:test";
import {
  Customer360BackfillError,
  buildBackfillPlan,
  buildDryRunReport,
  deterministicProfileId,
  normalizeBackfillInput,
  parseBackfillArgs,
  runCustomer360Backfill,
} from "../../scripts/backfill-customer-360.mjs";
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

test("normalization retains only exact durable evidence and discards PII", () => {
  const records = normalizeBackfillInput({
    version: 1,
    records: [{
      recordId: "reviewed-source-row-1",
      accountId: ACCOUNT_A.toUpperCase(),
      activationId: ACTIVATION_A,
      stripeCustomerId: "cus_Customer360A",
      stripeCheckoutSessionId: "cs_test_Customer360A",
      stripePaymentIntentId: "pi_Customer360A",
      stripeSubscriptionId: "sub_Customer360A",
      installIdHash: INSTALL_A,
      supportCode: SUPPORT_A,
      installerReceiptIdHash: RECEIPT_A,
      ...PRIVATE_FIELDS,
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
    () => normalizeBackfillInput([{ recordId: "row", emailHash: "not-allowed" }]),
    /unsupported field "emailHash"/,
  );
  assert.throws(
    () => normalizeBackfillInput([
      { recordId: "duplicate" },
      { recordId: "duplicate" },
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
      () => normalizeBackfillInput([{ recordId: `invalid-${field}`, [field]: value }]),
      expected,
    );
  }
});

test("only durable evidence joins records; unbridged historical rows remain separate", () => {
  const ignoredOnly = [
    { recordId: "legacy-install-a", ...PRIVATE_FIELDS },
    { recordId: "legacy-install-b", ...PRIVATE_FIELDS },
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
      { recordId: `${field}-a`, [field]: value },
      { recordId: `${field}-b`, [field]: value },
    ], "test");
    assert.equal(plan.components.length, 1, field);
    assert.equal(plan.components[0].recordIndexes.length, 2, field);
  }

  const transitive = buildBackfillPlan([
    { recordId: "chain-a", installIdHash: INSTALL_A },
    { recordId: "chain-b", installIdHash: INSTALL_A, supportCode: SUPPORT_A },
    { recordId: "chain-c", supportCode: SUPPORT_A },
  ], "test");
  assert.equal(transitive.components.length, 1);
  assert.equal(transitive.components[0].recordIndexes.length, 3);
});

test("conflict and orphan reports are privacy-safe and contain no identity values", () => {
  const conflictInput = [
    {
      recordId: "conflict-a",
      accountId: ACCOUNT_A,
      installIdHash: INSTALL_A,
      ...PRIVATE_FIELDS,
    },
    {
      recordId: "conflict-b",
      accountId: ACCOUNT_B,
      installIdHash: INSTALL_A,
      ...PRIVATE_FIELDS,
    },
    { recordId: "orphan-private", ...PRIVATE_FIELDS },
  ];
  const report = buildDryRunReport(conflictInput, { namespace: "test" });
  assert.equal(report.summary.conflictComponents, 1);
  assert.equal(report.summary.orphanComponents, 1);
  assertPrivacySafeReport(report, [
    ...Object.values(PRIVATE_FIELDS),
    ACCOUNT_A,
    ACCOUNT_B,
    INSTALL_A,
    "conflict-a",
    "conflict-b",
    "orphan-private",
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
    input: [{ recordId: "dry-run-row", installIdHash: INSTALL_A }],
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
      input: [{ recordId: "production-row", accountId: ACCOUNT_A }],
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

test("deterministic profile IDs and checkpoints bind resume to exact normalized input", () => {
  assert.equal(
    deterministicProfileId("test", "stable-record"),
    deterministicProfileId("test", "stable-record"),
  );
  assert.notEqual(
    deterministicProfileId("test", "stable-record"),
    deterministicProfileId("production", "stable-record"),
  );
  assert.match(deterministicProfileId("test", "stable-record"), /^[0-9a-f-]{36}$/);

  const input = [{ recordId: "checkpoint-row", activationId: ACTIVATION_A }];
  const plan = buildBackfillPlan(input, "test");
  const checkpoint = {
    version: 1,
    namespace: "test",
    inputDigest: plan.inputDigest,
    nextComponentIndex: 1,
    processedRecords: 1,
  };
  const complete = buildDryRunReport(input, { namespace: "test", checkpoint });
  assert.equal(complete.checkpoint.complete, true);
  assert.equal(complete.summary.pendingComponents, 0);

  assert.throws(
    () => buildDryRunReport([{ recordId: "changed-row", activationId: ACTIVATION_A }], {
      namespace: "test",
      checkpoint,
    }),
    Customer360BackfillError,
  );
});

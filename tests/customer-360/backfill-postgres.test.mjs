import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildBackfillPlan,
  deterministicProfileId,
  loadPostgresModule,
  runCustomer360Backfill,
} from "../../scripts/backfill-customer-360.mjs";
import { assertPrivacySafeReport } from "../../scripts/verify-customer-360-backfill.mjs";
import {
  createTestPoolOptions,
  requireSafeTestDatabaseUrl,
} from "../../scripts/run-postgres-integration.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { Pool } = await loadPostgresModule(repositoryRoot);
const migrationsDirectory = join(repositoryRoot, "db", "migrations");
const targetMigrations = [
  "20260715120000_add_customer_360_core.sql",
  "20260715121000_add_customer_identity_links.sql",
];
const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
const ACTIVATION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTIVATION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACTIVATION_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const INSTALL_A = "a".repeat(64);
const INSTALL_BRIDGE = "c".repeat(64);
const RECEIPT_A = "b".repeat(64);
const PRIVATE_FIELDS = Object.freeze({
  email: "backfill.private@example.com",
  displayName: "Backfill Private Customer",
  ipAddress: "198.51.100.44",
  occurredAt: "2026-07-15T14:15:16.000Z",
  behavior: "private behavior history",
  gmailCampaignHmac: "private-gmail-campaign-hash",
});

test("test-only Customer 360 apply is atomic, resumable, idempotent, and private", {
  timeout: 120_000,
}, async (t) => {
  const databaseUrl = requireSafeTestDatabaseUrl(process.env);
  const schema = `sidestream_c360_backfill_${randomBytes(8).toString("hex")}`;
  const quotedSchema = quoteIdentifier(schema);
  const pool = new Pool(createTestPoolOptions(databaseUrl));
  let schemaCreated = false;

  try {
    await pool.query(`create schema ${quotedSchema}`);
    schemaCreated = true;
    for (const migrationName of targetMigrations) {
      const sql = await readFile(join(migrationsDirectory, migrationName), "utf8");
      await pool.query(rewritePublicSchema(sql, schema));
    }

    const initialInput = [
      { recordId: opaqueRecordId(101), ...PRIVATE_FIELDS },
      { recordId: opaqueRecordId(102), ...PRIVATE_FIELDS },
      {
        recordId: opaqueRecordId(103),
        accountId: ACCOUNT_A,
        activationId: ACTIVATION_A,
        stripeCustomerId: "cus_C360BackfillA",
        stripePaymentIntentId: "pi_C360BackfillA",
        installIdHash: INSTALL_A,
        supportCode: "SIDE-A1B2-C3D4-E5F6",
        ...PRIVATE_FIELDS,
      },
      {
        recordId: opaqueRecordId(104),
        activationId: ACTIVATION_B,
        stripeCheckoutSessionId: "cs_test_C360BackfillA",
        stripeSubscriptionId: "sub_C360BackfillA",
        installIdHash: INSTALL_A,
        installerReceiptIdHash: RECEIPT_A,
        ...PRIVATE_FIELDS,
      },
    ];

    await t.test("unbridged rows stay separate and durable records converge", async () => {
      const checkpoints = [];
      const applied = await runCustomer360Backfill({
        input: initialInput,
        namespace: "test",
        apply: true,
        pool,
        schema,
        batchSize: 1,
        writeCheckpoint(checkpoint) {
          checkpoints.push(checkpoint);
        },
      });
      assert.equal(applied.summary.currentRun.processedComponents, 3);
      assert.equal(applied.summary.orphanComponents, 2);
      assert.equal(applied.summary.currentRun.appliedComponents, 1);
      assert.equal(applied.summary.conflictComponents, 0);
      assert.equal(applied.summary.writes, applied.summary.currentRun.writes);
      assert.equal(checkpoints.length, 3);
      assert.equal(checkpoints.at(-1).nextComponentIndex, 3);
      assert.equal(checkpoints.at(-1).processedRecords, 4);
      assertPrivacySafeReport(applied, [
        ...Object.values(PRIVATE_FIELDS),
        ACCOUNT_A,
        ACTIVATION_A,
        ACTIVATION_B,
        INSTALL_A,
        RECEIPT_A,
        ...initialInput.map(({ recordId }) => recordId),
      ]);

      const snapshot = await databaseSnapshot(pool, quotedSchema);
      assert.equal(snapshot.profiles.length, 3);
      assert.equal(snapshot.installs.length, 1);
      const installProfileId = snapshot.installs[0].profile_id;
      const linkedProfileIds = new Set(
        snapshot.links
          .filter((link) => [
            "account_identity",
            "activation_record",
            "stripe_customer",
            "stripe_checkout_session",
            "stripe_payment_intent",
            "stripe_subscription",
            "install_identity_hash",
            "support_code",
            "installer_receipt_hash",
          ].includes(link.link_type))
          .map((link) => link.profile_id),
      );
      assert.deepEqual([...linkedProfileIds], [installProfileId]);
      assert.equal(
        snapshot.links.filter((link) => link.link_type === "activation_record").length,
        2,
      );
    });

    await t.test("a full duplicate rerun is a zero-write no-op", async () => {
      const before = await databaseSnapshot(pool, quotedSchema);
      const replay = await runCustomer360Backfill({
        input: initialInput,
        namespace: "test",
        apply: true,
        pool,
        schema,
        batchSize: 2,
      });
      const after = await databaseSnapshot(pool, quotedSchema);
      assert.deepEqual(after, before);
      assert.equal(replay.summary.currentRun.writes, 0);
      assert.equal(replay.summary.currentRun.unchangedComponents, 1);
      assert.equal(replay.summary.currentRun.orphanComponents, 2);
    });

    await t.test("existing durable-owner conflict is quarantined with no writes or PII", async () => {
      const conflictInput = [{
        recordId: opaqueRecordId(110),
        accountId: ACCOUNT_B,
        activationId: ACTIVATION_C,
        installIdHash: INSTALL_A,
        ...PRIVATE_FIELDS,
      }];
      const before = await databaseSnapshot(pool, quotedSchema);
      const report = await runCustomer360Backfill({
        input: conflictInput,
        namespace: "test",
        apply: true,
        pool,
        schema,
      });
      const after = await databaseSnapshot(pool, quotedSchema);
      assert.deepEqual(after, before);
      assert.equal(report.summary.conflictComponents, 1);
      assert.equal(report.summary.currentRun.writes, 0);
      assert.deepEqual(
        report.components.map(({ status, reason }) => [status, reason]),
        [["conflict", "existing_account_disagrees"]],
      );
      assertPrivacySafeReport(report, [
        ...Object.values(PRIVATE_FIELDS),
        ACCOUNT_B,
        ACTIVATION_C,
        INSTALL_A,
        conflictInput[0].recordId,
      ]);
    });

    await t.test("resume preserves checkpointed conflict outcomes after a later crash", async () => {
      const conflictReplayInput = [
        {
          recordId: opaqueRecordId(111),
          accountId: ACCOUNT_B,
          installIdHash: INSTALL_A,
        },
        {
          recordId: opaqueRecordId(112),
          activationId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        },
      ];
      let persistedCheckpoint = null;
      await assert.rejects(
        runCustomer360Backfill({
          input: conflictReplayInput,
          namespace: "test",
          apply: true,
          pool,
          schema,
          batchSize: 1,
          afterBatchCommitted(checkpoint) {
            if (checkpoint.nextComponentIndex === 2) {
              throw new Error("simulated crash after later commit before checkpoint");
            }
          },
          writeCheckpoint(checkpoint) {
            persistedCheckpoint = checkpoint;
          },
        }),
        /simulated crash after later commit before checkpoint/,
      );

      assert.equal(persistedCheckpoint.nextComponentIndex, 1);
      assert.equal(persistedCheckpoint.outcomes.processedComponents, 1);
      assert.equal(persistedCheckpoint.outcomes.conflictComponents, 1);
      const resumed = await runCustomer360Backfill({
        input: conflictReplayInput,
        namespace: "test",
        apply: true,
        pool,
        schema,
        checkpoint: persistedCheckpoint,
        batchSize: 1,
        writeCheckpoint(checkpoint) {
          persistedCheckpoint = checkpoint;
        },
      });

      assert.equal(resumed.summary.currentRun.processedComponents, 1);
      assert.equal(resumed.summary.processedThisRun, 1);
      assert.equal(resumed.summary.conflictComponents, 1);
      assert.equal(resumed.summary.currentRun.conflictComponents, 0);
      assert.equal(resumed.summary.currentRun.unchangedComponents, 1);
      assert.deepEqual(resumed.summary.compatibilityAliasScopes, {
        processedThisRun: "currentRun.processedComponents",
        orphanComponents: "checkpointedUnresolved.orphanComponents",
        conflictComponents: "checkpointedUnresolved.conflictComponents",
        writes: "currentRun.writes",
      });
      assert.deepEqual(resumed.summary.checkpointedUnresolved, {
        scope: "checkpointedProcessedPlanPrefix",
        processedPlanPrefixComponents: 2,
        orphanComponents: 0,
        conflictComponents: 1,
      });
      assert.equal(persistedCheckpoint.outcomes.conflictComponents, 1);
      assert.deepEqual(
        resumed.checkpoint.resumedActionableReports,
        persistedCheckpoint.outcomes.actionableReports,
      );
      assertPrivacySafeReport(resumed, conflictReplayInput.map(({ recordId }) => recordId));
    });

    await t.test("resume replays a committed uncheckpointed batch without duplication", async () => {
      const resumeInput = [
        { recordId: opaqueRecordId(120), ...PRIVATE_FIELDS },
        {
          recordId: opaqueRecordId(121),
          activationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        },
        {
          recordId: opaqueRecordId(122),
          activationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          supportCode: "SIDE-Z9Y8-X7W6-V5U4",
        },
      ];
      let persistedCheckpoint = null;
      await assert.rejects(
        runCustomer360Backfill({
          input: resumeInput,
          namespace: "test",
          apply: true,
          pool,
          schema,
          batchSize: 1,
          afterBatchCommitted(checkpoint) {
            if (checkpoint.nextComponentIndex === 1) {
              throw new Error("simulated crash after commit before checkpoint");
            }
          },
          writeCheckpoint(checkpoint) {
            persistedCheckpoint = checkpoint;
          },
        }),
        /simulated crash after commit before checkpoint/,
      );
      assert.equal(persistedCheckpoint, null);
      const afterCrash = await databaseSnapshot(pool, quotedSchema);
      assert.equal(afterCrash.profiles.length, 5);

      const resumed = await runCustomer360Backfill({
        input: resumeInput,
        namespace: "test",
        apply: true,
        pool,
        schema,
        checkpoint: persistedCheckpoint,
        batchSize: 1,
        writeCheckpoint(checkpoint) {
          persistedCheckpoint = checkpoint;
        },
      });
      assert.equal(resumed.summary.currentRun.processedComponents, 3);
      assert.equal(resumed.summary.currentRun.writes, 5);
      assert.equal(persistedCheckpoint.nextComponentIndex, 3);
      assert.equal(persistedCheckpoint.processedRecords, 3);

      const completed = await databaseSnapshot(pool, quotedSchema);
      const completedCheckpointRun = await runCustomer360Backfill({
        input: resumeInput,
        namespace: "test",
        apply: true,
        pool: {
          connect() {
            throw new Error("completed checkpoint must not reconnect");
          },
        },
        schema,
        checkpoint: persistedCheckpoint,
      });
      assert.equal(completedCheckpointRun.summary.currentRun.processedComponents, 0);
      assert.equal(completedCheckpointRun.summary.processedThisRun, 0);

      const fullReplay = await runCustomer360Backfill({
        input: resumeInput,
        namespace: "test",
        apply: true,
        pool,
        schema,
      });
      assert.equal(fullReplay.summary.currentRun.writes, 0);
      assert.deepEqual(await databaseSnapshot(pool, quotedSchema), completed);
    });

    await t.test("later durable evidence quarantines previously separate orphan roots", async () => {
      const orphanInput = [
        { recordId: opaqueRecordId(130), ...PRIVATE_FIELDS },
        { recordId: opaqueRecordId(131), ...PRIVATE_FIELDS },
      ];
      const orphanApply = await runCustomer360Backfill({
        input: orphanInput,
        namespace: "test",
        apply: true,
        pool,
        schema,
      });
      assert.equal(orphanApply.summary.orphanComponents, 2);
      assert.equal(orphanApply.summary.currentRun.writes, 2);

      const beforeBridge = await databaseSnapshot(pool, quotedSchema);
      const orphanProfileIds = orphanInput.map(({ recordId }) =>
        deterministicProfileId("test", recordId));
      assert.deepEqual(
        beforeBridge.profiles
          .filter((profile) => orphanProfileIds.includes(profile.id))
          .map(({ id, merged_into: mergedInto }) => [id, mergedInto])
          .sort(([left], [right]) => left.localeCompare(right)),
        orphanProfileIds
          .map((profileId) => [profileId, null])
          .sort(([left], [right]) => left.localeCompare(right)),
      );

      const bridgeInput = orphanInput.map((record) => ({
        ...record,
        installIdHash: INSTALL_BRIDGE,
      }));
      const bridgeReport = await runCustomer360Backfill({
        input: bridgeInput,
        namespace: "test",
        apply: true,
        pool,
        schema,
      });

      assert.deepEqual(await databaseSnapshot(pool, quotedSchema), beforeBridge);
      assert.equal(bridgeReport.summary.currentRun.appliedComponents, 0);
      assert.equal(bridgeReport.summary.conflictComponents, 1);
      assert.equal(bridgeReport.summary.currentRun.writes, 0);
      assert.deepEqual(
        bridgeReport.components.map(({ status, reason, writes }) => [status, reason, writes]),
        [["conflict", "existing_evidence_disagrees", 0]],
      );
      assertPrivacySafeReport(bridgeReport, [
        ...Object.values(PRIVATE_FIELDS),
        INSTALL_BRIDGE,
        ...orphanInput.map(({ recordId }) => recordId),
      ]);
    });

    await t.test("checkpoint digest rejects changed or reordered work", async () => {
      const input = [
        { recordId: opaqueRecordId(140) },
        { recordId: opaqueRecordId(141) },
      ];
      const plan = buildBackfillPlan(input, "test");
      const checkpoint = {
        version: 3,
        namespace: "test",
        inputDigest: plan.inputDigest,
        nextComponentIndex: 1,
        processedRecords: 1,
        outcomes: {
          processedComponents: 1,
          appliedComponents: 0,
          unchangedComponents: 0,
          orphanComponents: 1,
          conflictComponents: 0,
          writes: 1,
          actionableReports: [{
            componentRef: plan.components[0].componentRef,
            status: "orphan",
            reason: "no_durable_bridge",
            recordCount: 1,
            evidenceTypes: [],
            writes: 1,
          }],
        },
      };
      await assert.rejects(
        runCustomer360Backfill({
          input: [...input].reverse(),
          namespace: "test",
          apply: true,
          pool,
          schema,
          checkpoint,
        }),
        /Checkpoint does not match/,
      );
    });
  } finally {
    if (schemaCreated) {
      await pool.query(`drop schema if exists ${quotedSchema} cascade`);
    }
    await pool.end();
  }
});

async function databaseSnapshot(pool, quotedSchema) {
  const profiles = await pool.query(
    `select id, license_namespace, merged_into
     from ${quotedSchema}.sidestream_customer_profiles
     order by id`,
  );
  const links = await pool.query(
    `select profile_id, license_namespace, link_type, link_value
     from ${quotedSchema}.sidestream_customer_identity_links
     order by profile_id, link_type, link_value`,
  );
  const installs = await pool.query(
    `select profile_id, license_namespace, install_id_hash, platform, app_version
     from ${quotedSchema}.sidestream_customer_installs
     order by profile_id, install_id_hash`,
  );
  return {
    profiles: profiles.rows,
    links: links.rows,
    installs: installs.rows,
  };
}

function rewritePublicSchema(source, schema) {
  return source.replace(/\bpublic\./g, `${quoteIdentifier(schema)}.`);
}

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
    throw new TypeError("Unsafe Postgres schema");
  }
  return `"${identifier}"`;
}

function opaqueRecordId(value) {
  return value.toString(16).padStart(64, "0");
}

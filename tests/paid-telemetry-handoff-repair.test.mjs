import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";

import * as repair from "../api/_lib/paid-telemetry-handoff-repair.ts";
import * as customerCommerce from "../api/_lib/customer-commerce.ts";
import {
  loadMigrationFiles,
  migrationSqlForTransaction,
  validateMigrationFiles,
} from "../scripts/apply-postgres-migrations.mjs";
import {
  assertNonPooledDirectRepairUrl,
  assertRepairTargetSeparation,
  parsePaidTelemetryRepairArgs,
  REPAIR_CONFIRMATION,
} from "../scripts/reconcile-paid-telemetry-handoff.mjs";
import {
  createTestPoolOptions,
  requireSafeTestDatabaseUrl,
} from "../scripts/run-postgres-integration.mjs";
import "./helpers/customer-360-network-guard.mjs";

const IDS = Object.freeze({
  acquisition: "81000000-0000-4000-8000-000000000001",
  account: "82000000-0000-4000-8000-000000000001",
  license: "83000000-0000-4000-8000-000000000001",
  activation: "84000000-0000-4000-8000-000000000001",
  checkoutIntent: "85000000-0000-4000-8000-000000000001",
  entry: "86000000-0000-4000-8000-000000000001",
  paidCheckout: "87000000-0000-4000-8000-000000000001",
  claim: "88000000-0000-4000-8000-000000000001",
  idempotency: "89000000-0000-4000-8000-000000000001",
  paidProfile: "8a000000-0000-4000-8000-000000000001",
  telemetryProfile: "8b000000-0000-4000-8000-000000000001",
});

const HASHES = Object.freeze({
  currentInstall: "a".repeat(64),
  historicalInstall: "b".repeat(64),
  nativeReceipt: "c".repeat(64),
  browserReceipt: "d".repeat(64),
  browserToken: "e".repeat(64),
  assignment: "f".repeat(64),
  assignmentSignature: "1".repeat(64),
  entryToken: "2".repeat(64),
  attribution: "3".repeat(64),
  requestFingerprint: "4".repeat(64),
  device: "5".repeat(64),
});

const PROVIDER = Object.freeze({
  customer: "cus_repair_fixture",
  olderCustomer: "cus_repair_fixture_older",
  checkoutSession: "cs_repair_fixture",
  paymentIntent: "pi_repair_fixture",
  charge: "ch_repair_fixture",
  product: "prod_repair_fixture",
  price: "price_repair_fixture",
});

const TIME = Object.freeze({
  firstObserved: "2026-08-08T10:00:00.000Z",
  checkoutStarted: "2026-08-08T10:01:00.000Z",
  checkoutCompleted: "2026-08-08T10:02:00.000Z",
  paymentSettled: "2026-08-08T10:03:00.000Z",
  telemetryProfile: "2026-08-09T09:00:00.000Z",
  paidProfile: "2026-08-09T10:00:00.000Z",
  identityReview: "2026-08-09T10:05:00.000Z",
  expiry: "2030-01-01T00:00:00.000Z",
});

const EXACT_REVIEWED_BOUNDARY = Object.freeze({
  review_id: "8c000000-0000-4000-8000-000000000001",
  activation_id: IDS.activation,
  account_id: IDS.account,
  candidate_profile_id: IDS.telemetryProfile,
  existing_profile_id: IDS.paidProfile,
  candidate_root_id: IDS.telemetryProfile,
  existing_root_id: IDS.paidProfile,
  activation_profile_id: IDS.telemetryProfile,
  direct_account_or_stripe_count: 0,
  existing_account_owner_count: 1,
  exact_account_owner_count: 1,
  exact_binding_count: 0,
});

const EXACT_REVIEWED_IDENTITY = Object.freeze({
  review_kind: "account_bridge",
  review_id: EXACT_REVIEWED_BOUNDARY.review_id,
  candidate_profile_id: IDS.telemetryProfile,
  existing_profile_id: IDS.paidProfile,
  candidate_root_id: IDS.telemetryProfile,
  existing_root_id: IDS.paidProfile,
  review_created_at: TIME.identityReview,
  install_membership_id: "8d000000-0000-4000-8000-000000000001",
  install_profile_id: IDS.telemetryProfile,
  install_id_hash: HASHES.currentInstall,
  install_identity_link_id: "8e000000-0000-4000-8000-000000000001",
  activation_identity_link_id: "8e000000-0000-4000-8000-000000000002",
  activation_profile_id: IDS.telemetryProfile,
  account_identity_link_id: "8e000000-0000-4000-8000-000000000003",
  receipt_identity_link_id: "8e000000-0000-4000-8000-000000000004",
  receipt_id_hash: HASHES.nativeReceipt,
  receipt_created_at: TIME.identityReview,
  candidate_account_count: 0,
  existing_account_count: 1,
});

function legacyEntitlementPath(overrides = {}) {
  return {
    acquisition_id: IDS.acquisition,
    integrity_state: "intact",
    checkout_intent_id: IDS.checkoutIntent,
    checkout_created_at: TIME.checkoutStarted,
    checkout_state: "completed",
    checkout_account_id: IDS.account,
    checkout_session_id: PROVIDER.checkoutSession,
    checkout_price_id: PROVIDER.price,
    checkout_product_id: PROVIDER.product,
    paid_checkout_id: IDS.paidCheckout,
    paid_environment: "test",
    paid_payment_state: "active",
    paid_claim_state: "unclaimed",
    paid_completed: true,
    paid_completed_at: TIME.checkoutCompleted,
    paid_authorization_active: true,
    paid_checkout_session_ref: PROVIDER.checkoutSession,
    paid_payment_ref: PROVIDER.paymentIntent,
    paid_product_ref: PROVIDER.product,
    paid_price_ref: PROVIDER.price,
    paid_quantity: 1,
    paid_amount_minor: "1999",
    paid_currency: "usd",
    paid_email: "repair-fixture@example.invalid",
    claim_id: IDS.claim,
    claim_state: "unclaimed",
    claim_active: true,
    claim_payment_ref: PROVIDER.paymentIntent,
    claim_activation_ref: IDS.activation,
    claim_account_ref: IDS.account,
    claim_entitlement_ref: IDS.license,
    claim_email: null,
    account_id: IDS.account,
    account_email: "repair-fixture@example.invalid",
    entitlement_id: IDS.license,
    entitlement_account_id: IDS.account,
    entitlement_status: "active",
    entitlement_plan_key: "sidestream_unlimited",
    entitlement_checkout_session_id: PROVIDER.checkoutSession,
    entitlement_payment_intent_id: PROVIDER.paymentIntent,
    entitlement_product_id: null,
    entitlement_price_id: null,
    entitlement_amount_paid: "0",
    entitlement_amount_refunded: "0",
    entitlement_currency: "usd",
    activation_id: IDS.activation,
    activation_account_id: IDS.account,
    activation_entitlement_id: IDS.license,
    activation_source: "paid-acquisition-mc-v1",
    activation_status: "completed",
    activation_completed: true,
    activation_active: true,
    ...overrides,
  };
}

async function inspectReviewedPath(path, {
  identityRows = [],
  mutableCounts = [],
  commerceState = [],
} = {}) {
  const statements = [];
  const client = {
    async query(sql, params = []) {
      statements.push(sql);
      if (/select id, integrity_state\s+from public\.sidestream_acquisitions/.test(sql)) {
        return { rows: [{ id: IDS.acquisition, integrity_state: "intact" }] };
      }
      if (/as exact_binding_count/.test(sql)) return { rows: [EXACT_REVIEWED_BOUNDARY] };
      if (/paid\.verified_amount_minor::text as paid_amount_minor/.test(sql)) {
        assert.equal(params[3], IDS.activation);
        return { rows: [path] };
      }
      if (/as review_kind/.test(sql)) return { rows: identityRows };
      if (/as "lifecycleStops"/.test(sql)) return { rows: mutableCounts };
      if (/with exact_payment_keys as/.test(sql)) return { rows: commerceState };
      return { rows: [] };
    },
  };
  const report = await repair.inspectPaidTelemetryHandoffRepair(client, {
    acquisitionId: IDS.acquisition,
    namespace: "test",
  });
  return { report, statements };
}

test("CLI accepts only the canonical UUID and exact guarded selectors", () => {
  const parsed = parsePaidTelemetryRepairArgs([
    "--dry-run",
    "--acquisition", IDS.acquisition,
    "--namespace", "test",
    "--target-url-env", "SIDESTREAM_TEST_POSTGRES_URL",
  ]);
  assert.equal(parsed.apply, false);
  assert.equal(parsed.targetUrlEnv, "SIDESTREAM_TEST_POSTGRES_URL");
  assert.throws(
    () => parsePaidTelemetryRepairArgs([
      "--dry-run", "--email", "someone@example.invalid",
    ]),
    /Unknown option/,
  );
  assert.throws(
    () => parsePaidTelemetryRepairArgs([
      "--apply", "--acquisition", IDS.acquisition, "--namespace", "test",
      "--target-url-env", "SIDESTREAM_TEST_POSTGRES_URL",
      "--confirm-operation", REPAIR_CONFIRMATION,
      "--confirm-namespace", "production",
      "--confirm-target", `pg-${"a".repeat(20)}`,
      "--confirm-journey", `journey-${"b".repeat(32)}`,
    ]),
    /confirm-namespace/,
  );
});

test("connection guards reject pooling, weak TLS, and runtime/source collisions", () => {
  assert.throws(
    () => assertNonPooledDirectRepairUrl(
      "postgresql://user:secret@ep-one-pooler.example.test/db?sslmode=require",
    ),
    /pooled/,
  );
  assert.throws(
    () => assertNonPooledDirectRepairUrl(
      "postgresql://user:secret@ep-one.example.test/db?sslmode=prefer",
    ),
    /authenticated TLS/,
  );
  assert.throws(
    () => assertRepairTargetSeparation(
      { SIDESTREAM_TELEMETRY_POSTGRES_URL:
        "postgresql://telemetry:secret@ep-one.example.test/db?sslmode=require" },
      { connectionString:
        "postgresql://operator:secret@ep-one.example.test/db?sslmode=verify-full" },
    ),
    /separate/,
  );
});

test("two discovered direct paid paths fail closed before identity reads or writes", async () => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (/select id, integrity_state\s+from public\.sidestream_acquisitions/.test(sql)) {
        return { rows: [{ id: IDS.acquisition, integrity_state: "intact" }] };
      }
      if (/as exact_binding_count/.test(sql)) return { rows: [] };
      if (/from public\.sidestream_acquisitions acquisition/.test(sql)) {
        return { rows: [{}, {}] };
      }
      throw new Error("Ambiguous paid-path discovery should stop before later reads");
    },
  };

  const report = await repair.inspectPaidTelemetryHandoffRepair(client, {
    acquisitionId: IDS.acquisition,
    namespace: "test",
  });
  assert.deepEqual(report, {
    reasonCode: "paid_path_missing_or_ambiguous",
    eligible: false,
    wouldMutate: false,
    journeyFingerprint: null,
    booleans: {
      canonicalAcquisition: true,
      exactPaidPath: false,
      activePayment: false,
      exactIdentity: false,
      profilesConverged: false,
      authenticationRecorded: false,
      installationRecorded: false,
      immutableBinding: false,
      commerceConsistent: true,
    },
    counts: {
      authenticationStages: 0,
      installationStages: 0,
      bindings: 0,
      mergeAudits: 0,
      acquisitionConflicts: 0,
      lifecycleStops: 0,
      commerceFacts: 0,
      commerceProfiles: 0,
      commerceConflicts: 0,
    },
  });
  assert.equal(statements.length, 3);
  assert.ok(statements.every((sql) => /^\s*select\b/i.test(sql)));
});

test("ambiguous reviewed boundaries fail closed before paid-path reads or writes", async () => {
  const exactBoundary = {
    review_id: "8c000000-0000-4000-8000-000000000001",
    activation_id: IDS.activation,
    account_id: IDS.account,
    candidate_profile_id: IDS.telemetryProfile,
    existing_profile_id: IDS.paidProfile,
    candidate_root_id: IDS.telemetryProfile,
    existing_root_id: IDS.paidProfile,
    activation_profile_id: IDS.telemetryProfile,
    direct_account_or_stripe_count: 0,
    existing_account_owner_count: 1,
    exact_account_owner_count: 1,
    exact_binding_count: 0,
  };
  const cases = [
    [exactBoundary, { ...exactBoundary, review_id: "8c000000-0000-4000-8000-000000000002" }],
    [{ ...exactBoundary, direct_account_or_stripe_count: 1 }],
    [{ ...exactBoundary, exact_account_owner_count: 2 }],
    [{ ...exactBoundary, candidate_root_id: IDS.paidProfile }],
    [{ ...exactBoundary, existing_account_owner_count: 0 }],
  ];

  for (const reviewedRows of cases) {
    const statements = [];
    const client = {
      async query(sql) {
        statements.push(sql);
        if (/select id, integrity_state\s+from public\.sidestream_acquisitions/.test(sql)) {
          return { rows: [{ id: IDS.acquisition, integrity_state: "intact" }] };
        }
        if (/as exact_binding_count/.test(sql)) return { rows: reviewedRows };
        throw new Error("Ambiguous reviewed-boundary discovery should stop before path reads");
      },
    };

    const report = await repair.inspectPaidTelemetryHandoffRepair(client, {
      acquisitionId: IDS.acquisition,
      namespace: "test",
    });
    assert.equal(report.reasonCode, "paid_path_missing_or_ambiguous");
    assert.equal(report.eligible, false);
    assert.equal(report.wouldMutate, false);
    assert.equal(report.journeyFingerprint, null);
    assert.equal(statements.length, 2);
    assert.ok(statements.every((sql) => /^\s*select\b/i.test(sql)));
  }
});

test("the exact reviewed legacy entitlement placeholder reaches identity validation", async () => {
  const { report, statements } = await inspectReviewedPath(legacyEntitlementPath());
  assert.equal(report.reasonCode, "exact_identity_missing_or_ambiguous");
  assert.equal(report.booleans.canonicalAcquisition, true);
  assert.equal(report.booleans.exactPaidPath, true);
  assert.equal(report.booleans.activePayment, false);
  assert.equal(statements.length, 4);
  assert.ok(statements.every((sql) => /^\s*select\b/i.test(sql)));
});

test("an exact unowned zero-total Checkout fact is the only recoverable commerce pre-state", async () => {
  const counts = {
    authenticationStages: 1,
    installationStages: 1,
    bindings: 0,
    mergeAudits: 0,
    acquisitionConflicts: 0,
    lifecycleStops: 0,
  };
  const commerceState = {
    payment_key_count: 1,
    fact_count: 1,
    profile_count: 0,
    unowned_fact_count: 1,
    base_conflict_count: 0,
    recoverable_fact_count: 1,
    recoverable_fact_id: "8f000000-0000-4000-8000-000000000001",
    recoverable_payment_key: `payment_intent:${PROVIDER.paymentIntent}`,
    attached_positive: false,
  };
  const { report, statements } = await inspectReviewedPath(
    legacyEntitlementPath(),
    {
      identityRows: [EXACT_REVIEWED_IDENTITY],
      mutableCounts: [counts],
      commerceState: [commerceState],
    },
  );
  assert.equal(report.reasonCode, "repair_ready");
  assert.equal(report.eligible, true);
  assert.equal(report.wouldMutate, true);
  assert.match(report.journeyFingerprint, /^journey-[0-9a-f]{32}$/);
  assert.equal(report.booleans.canonicalAcquisition, true);
  assert.equal(report.booleans.exactPaidPath, true);
  assert.deepEqual(report.counts, {
    ...counts,
    commerceFacts: 1,
    commerceProfiles: 0,
    commerceConflicts: 0,
  });
  assert.equal(statements.length, 7);
  assert.ok(statements.every((sql) =>
    !/^\s*(?:insert|update|delete)\b/i.test(sql)));
});

test("nearby unowned commerce shapes remain fail closed", async () => {
  const base = {
    payment_key_count: 1,
    fact_count: 1,
    profile_count: 0,
    unowned_fact_count: 1,
    base_conflict_count: 0,
    recoverable_fact_count: 1,
    recoverable_fact_id: "8f000000-0000-4000-8000-000000000001",
    recoverable_payment_key: `payment_intent:${PROVIDER.paymentIntent}`,
    attached_positive: false,
  };
  const cases = [
    ["second payment key", { payment_key_count: 2 }],
    ["second fact", { fact_count: 2, unowned_fact_count: 2 }],
    ["wrong source, currency, or evidence", { recoverable_fact_count: 0 }],
    ["nonzero mismatch", { recoverable_fact_count: 0 }],
    ["different owner", {
      profile_count: 1,
      unowned_fact_count: 0,
      base_conflict_count: 1,
      recoverable_fact_count: 0,
    }],
    ["conflict or lifecycle money stop", {
      base_conflict_count: 1,
      recoverable_fact_count: 0,
    }],
  ];
  for (const [label, override] of cases) {
    const { report } = await inspectReviewedPath(legacyEntitlementPath(), {
      identityRows: [EXACT_REVIEWED_IDENTITY],
      mutableCounts: [{
        authenticationStages: 1,
        installationStages: 1,
        bindings: 0,
        mergeAudits: 0,
        acquisitionConflicts: 0,
        lifecycleStops: 0,
      }],
      commerceState: [{ ...base, ...override }],
    });
    assert.equal(report.reasonCode, "commerce_conflict", label);
    assert.equal(report.eligible, false, label);
    assert.equal(report.wouldMutate, false, label);
    assert.equal(report.journeyFingerprint, null, label);
  }
});

test("partial or mismatched legacy entitlement and claim tuples fail before identity reads", async () => {
  const otherAccount = "82000000-0000-4000-8000-000000000002";
  const otherLicense = "83000000-0000-4000-8000-000000000002";
  const cases = [
    ["only product restored", { entitlement_product_id: PROVIDER.product }],
    ["only price restored", { entitlement_price_id: PROVIDER.price }],
    ["nonzero mismatched entitlement amount", { entitlement_amount_paid: "1" }],
    ["zero verified payment", { paid_amount_minor: "0" }],
    ["negative verified payment", { paid_amount_minor: "-1" }],
    ["missing verified payment", { paid_amount_minor: null }],
    ["missing verified Product", {
      paid_product_ref: null,
      checkout_product_id: null,
    }],
    ["missing verified Price", {
      paid_price_ref: null,
      checkout_price_id: null,
    }],
    ["missing verified currency", {
      paid_currency: null,
      entitlement_currency: null,
    }],
    ["missing verified Checkout Session", {
      paid_checkout_session_ref: null,
      checkout_session_id: null,
      entitlement_checkout_session_id: null,
    }],
    ["core Product mismatch", { checkout_product_id: "prod_other" }],
    ["core Price mismatch", { checkout_price_id: "price_other" }],
    ["Checkout Session mismatch", { checkout_session_id: "cs_other" }],
    ["canonical payment mismatch", { claim_payment_ref: "pi_other" }],
    ["nonzero refund", { entitlement_amount_refunded: "1" }],
    ["Checkout account conflict", { checkout_account_id: otherAccount }],
    ["claim account conflict", { claim_account_ref: otherAccount }],
    ["claim entitlement conflict", { claim_entitlement_ref: otherLicense }],
    ["null claim activation", { claim_activation_ref: null }],
    ["mismatched claim email", { claim_email: "other@example.invalid" }],
    ["non-null blank claim email", { claim_email: " " }],
  ];

  for (const [label, overrides] of cases) {
    const { report, statements } = await inspectReviewedPath(
      legacyEntitlementPath(overrides),
    );
    assert.equal(report.reasonCode, "payment_or_account_conflict", label);
    assert.equal(report.eligible, false, label);
    assert.equal(report.wouldMutate, false, label);
    assert.equal(report.journeyFingerprint, null, label);
    assert.equal(report.booleans.activePayment, false, label);
    assert.equal(statements.length, 3, label);
    assert.ok(statements.every((sql) => /^\s*select\b/i.test(sql)), label);
  }
});

test("disposable Postgres repair is dry-run first, exact, private, and idempotent", async () => {
  const databaseUrl = requireSafeTestDatabaseUrl();
  const schema = `sidestream_paid_repair_${randomBytes(8).toString("hex")}`;
  const quoted = quoteIdentifier(schema);
  const pool = new Pool(createTestPoolOptions(databaseUrl));
  let created = false;
  try {
    await pool.query(`create schema ${quoted}`);
    created = true;
    await applyMigrations(pool, schema);
    await seedFailedJourney(pool, quoted);

    const beforeRows = await repairCounts(pool, quoted);
    const dryRun = await inTransaction(pool, quoted, true, (client) =>
      repair.inspectPaidTelemetryHandoffRepair(client, {
        acquisitionId: IDS.acquisition,
        namespace: "test",
      }));
    assert.equal(dryRun.reasonCode, "repair_ready");
    assert.equal(dryRun.eligible, true);
    assert.equal(dryRun.wouldMutate, true);
    assert.match(dryRun.journeyFingerprint, /^journey-[0-9a-f]{32}$/);
    assert.deepEqual(await repairCounts(pool, quoted), beforeRows);

    await assert.rejects(
      () => inTransaction(pool, quoted, false, (client) =>
        repair.applyPaidTelemetryHandoffRepair(client, {
          acquisitionId: IDS.acquisition,
          namespace: "test",
          confirmJourney: `journey-${"0".repeat(32)}`,
        })),
      /exact single-journey fingerprint/,
    );
    assert.deepEqual(await repairCounts(pool, quoted), beforeRows);

    const serialized = JSON.stringify(dryRun);
    for (const excluded of [
      ...Object.values(IDS),
      ...Object.values(HASHES),
      ...Object.values(PROVIDER),
      "repair-fixture@example.invalid",
    ]) {
      assert.equal(serialized.includes(excluded), false);
    }

    await inTransaction(pool, quoted, false, async (client) => {
      await client.query(
        `update ${quoted}.sidestream_customer_commerce_materializations
         set refunded_minor = gross_paid_minor, net_paid_minor = 0
         where source_object_id = $1`,
        [PROVIDER.paymentIntent],
      );
      const stopped = await repair.inspectPaidTelemetryHandoffRepair(client, {
        acquisitionId: IDS.acquisition,
        namespace: "test",
      });
      assert.equal(stopped.eligible, false);
      assert.equal(stopped.reasonCode, "commerce_conflict");
      throw new RollbackScenario();
    }).catch((error) => {
      if (!(error instanceof RollbackScenario)) throw error;
    });

    await inTransaction(pool, quoted, false, async (client) => {
      await client.query(
        `update ${quoted}.sidestream_paid_acquisition_checkouts
         set payment_state = 'refunded' where id = $1`,
        [IDS.paidCheckout],
      );
      const stopped = await repair.inspectPaidTelemetryHandoffRepair(client, {
        acquisitionId: IDS.acquisition,
        namespace: "test",
      });
      assert.equal(stopped.eligible, false);
      assert.equal(stopped.reasonCode, "payment_or_account_conflict");
      await assert.rejects(
        () => repair.applyPaidTelemetryHandoffRepair(client, {
          acquisitionId: IDS.acquisition,
          namespace: "test",
          confirmJourney: dryRun.journeyFingerprint,
        }),
        /fingerprint|not eligible/,
      );
      throw new RollbackScenario();
    }).catch((error) => {
      if (!(error instanceof RollbackScenario)) throw error;
    });

    const applied = await inTransaction(pool, quoted, false, (client) =>
      repair.applyPaidTelemetryHandoffRepair(client, {
        acquisitionId: IDS.acquisition,
        namespace: "test",
        confirmJourney: dryRun.journeyFingerprint,
      }));
    assert.equal(applied.reasonCode, "already_repaired");
    assert.equal(applied.wouldMutate, false);
    assert.equal(applied.journeyFingerprint, dryRun.journeyFingerprint);
    assert.deepEqual(applied.counts, {
      authenticationStages: 1,
      installationStages: 1,
      bindings: 1,
      mergeAudits: 1,
      acquisitionConflicts: 0,
      lifecycleStops: 0,
      commerceFacts: 1,
      commerceProfiles: 1,
      commerceConflicts: 0,
    });

    const firstAppliedRows = await repairCounts(pool, quoted);
    assert.equal(firstAppliedRows.liveProfiles, 1);
    assert.equal(firstAppliedRows.mergedProfiles, 1);
    assert.equal(firstAppliedRows.bindings, 1);
    assert.equal(firstAppliedRows.mergeAudits, 1);
    assert.equal(firstAppliedRows.authenticationStages, 1);
    assert.equal(firstAppliedRows.installationStages, 1);
    assert.equal(firstAppliedRows.commerceProfiles, 1);

    const replay = await inTransaction(pool, quoted, false, (client) =>
      repair.applyPaidTelemetryHandoffRepair(client, {
        acquisitionId: IDS.acquisition,
        namespace: "test",
        confirmJourney: dryRun.journeyFingerprint,
      }));
    assert.equal(replay.reasonCode, "already_repaired");
    assert.equal(replay.journeyFingerprint, dryRun.journeyFingerprint);
    assert.deepEqual(await repairCounts(pool, quoted), firstAppliedRows);

    const missingCurrentCustomer = await inTransaction(
      pool,
      quoted,
      false,
      async (client) => {
        const removed = await client.query(
          `delete from public.sidestream_customer_identity_links
           where license_namespace = 'test'
             and link_type = 'stripe_customer'
             and link_value = $1
           returning profile_id`,
          [PROVIDER.customer],
        );
        assert.equal(removed.rowCount, 1);
        await client.query(
          `insert into public.sidestream_customer_identity_links (
             profile_id, license_namespace, link_type, link_value, created_at
           ) values ($1::uuid, 'test', 'stripe_customer', $2, $3)`,
          [removed.rows[0].profile_id, PROVIDER.olderCustomer, TIME.firstObserved],
        );
        const exactLinkState = await client.query(
          `select
             core.stripe_customer_id = account.stripe_customer_id
               as exact_server_customer_agreement,
             (select count(*)::int
              from public.sidestream_customer_identity_links link
              where link.license_namespace = 'test'
                and link.link_type = 'stripe_customer'
                and link.link_value = $2) as exact_current_links,
             (select count(*)::int
              from public.sidestream_customer_identity_links link
              where link.license_namespace = 'test'
                and link.profile_id = $3::uuid
                and link.link_type = 'stripe_customer'
                and link.link_value = $4) as older_links
           from public.sidestream_checkout_intents core
           join public.sidestream_paid_acquisition_checkouts paid
             on paid.checkout_intent_ref = core.id
           join public.sidestream_paid_acquisition_claims claim
             on claim.checkout_id = paid.id
           join public.sidestream_accounts account
             on account.id = claim.account_ref
           where core.id = $1::uuid`,
          [
            IDS.checkoutIntent,
            PROVIDER.customer,
            removed.rows[0].profile_id,
            PROVIDER.olderCustomer,
          ],
        );
        const report = await repair.inspectPaidTelemetryHandoffRepair(client, {
          acquisitionId: IDS.acquisition,
          namespace: "test",
        });
        return { report, exactLinkState: exactLinkState.rows[0] };
      },
    );
    assert.equal(
      missingCurrentCustomer.exactLinkState.exact_server_customer_agreement,
      true,
    );
    assert.equal(missingCurrentCustomer.exactLinkState.exact_current_links, 0);
    assert.equal(missingCurrentCustomer.exactLinkState.older_links, 1);
    assert.equal(missingCurrentCustomer.report.reasonCode, "already_repaired");
    assert.equal(missingCurrentCustomer.report.eligible, true);
    assert.equal(missingCurrentCustomer.report.wouldMutate, false);
  } finally {
    if (created) await pool.query(`drop schema if exists ${quoted} cascade`).catch(() => {});
    await pool.end().catch(() => {});
  }
});

class RollbackScenario extends Error {}

async function applyMigrations(pool, schema) {
  const migrations = validateMigrationFiles(await loadMigrationFiles());
  const client = await pool.connect();
  try {
    for (const migration of migrations) {
      await client.query("begin");
      try {
        await client.query(rewritePublicSchema(
          migrationSqlForTransaction(migration.sql),
          schema,
        ));
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
    }
  } finally {
    client.release();
  }
}

async function seedFailedJourney(pool, schema) {
  await pool.query(
    `insert into ${schema}.sidestream_acquisitions (
       id, license_namespace, first_observed_source, first_observed_medium,
       first_observed_campaign, first_observed_content_creative, entry_channel,
       first_observed_at, external_referrer_category, experiment_id,
       experiment_cohort, attribution_confidence, integrity_state,
       trusted_delivery_evidence
     ) values (
       $1, 'test', 'meta', 'social', 'sidestream_direct_offer_test', 'paid',
       'website', $2, 'social', 'meta-direct-links-v1', 'paid',
       'exact_trusted_delivery', 'intact',
       array['website_entry','authenticated_account','checkout_intent','stripe_checkout_session']
     )`,
    [IDS.acquisition, TIME.firstObserved],
  );
  await pool.query(
    `insert into ${schema}.sidestream_accounts (
       id, google_sub, email, display_name, stripe_customer_id, last_login_at,
       created_at, updated_at
     ) values ($1, 'google_repair_fixture', 'repair-fixture@example.invalid',
       'Repair Fixture', $2, $3, $3, $3)`,
    [IDS.account, PROVIDER.customer, TIME.checkoutCompleted],
  );
  await pool.query(
    `insert into ${schema}.sidestream_licenses (
       id, account_id, stripe_customer_id, stripe_subscription_id,
       stripe_checkout_session_id, stripe_payment_intent_id, stripe_charge_id,
       stripe_price_id, stripe_product_id, amount_paid, amount_refunded, currency,
       plan_key, status, entitlement_status, status_reason, reconciled_at,
       features, created_at, updated_at
     ) values (
       $1, $2, $3, null, $4, $5, $6, $7, $8, 1999, 0, 'usd',
       'sidestream_unlimited', 'active', 'active', 'checkout_fulfilled', $9,
       '{}'::jsonb, $9, $9
     )`,
    [
      IDS.license, IDS.account, PROVIDER.customer, PROVIDER.checkoutSession,
      PROVIDER.paymentIntent, PROVIDER.charge, PROVIDER.price, PROVIDER.product,
      TIME.paymentSettled,
    ],
  );
  await pool.query(
    `insert into ${schema}.sidestream_activation_sessions (
       id, activation_key, account_id, license_id, device_id_hash, app_version,
       build_channel, source, status, expires_at, completed_at, created_at, updated_at
     ) values (
       $1, 'activation_repair_fixture', $2, $3, $4, '1.0.18', 'production',
       'paid-acquisition-mc-v1', 'completed', $5, $6, $6, $6
     )`,
    [
      IDS.activation, IDS.account, IDS.license, HASHES.device,
      TIME.expiry, TIME.paidProfile,
    ],
  );
  await pool.query(
    `insert into ${schema}.sidestream_checkout_intents (
       id, acquisition_id, intent_kind, browser_token_hash, state,
       stripe_customer_id, stripe_checkout_session_id, stripe_checkout_url,
       stripe_price_id, stripe_product_id, stripe_session_expires_at,
       confirmed_at, expires_at, created_at, updated_at
     ) values (
       $1, $2, 'anonymous', $3, 'completed', $4, $5,
       'https://checkout.stripe.test/repair-fixture', $6, $7, $8,
       $9, $8, $10, $9
     )`,
    [
      IDS.checkoutIntent, IDS.acquisition, HASHES.browserToken, PROVIDER.customer,
      PROVIDER.checkoutSession, PROVIDER.price, PROVIDER.product, TIME.expiry,
      TIME.checkoutCompleted, TIME.checkoutStarted,
    ],
  );
  await pool.query(
    `insert into ${schema}.sidestream_paid_acquisition_entries (
       id, contract_version, environment, experiment_id, cohort,
       assignment_id_hash, assignment_cookie_signature_hash, entry_path,
       entry_token_hash, attribution_hash, utm_medium, utm_campaign,
       expires_at, created_at, updated_at
     ) values (
       $1, 1, 'test', 'mc-mobile-paid-v1', 'mc-paid-v1', $2, $3, '/mc',
       $4, $5, 'social', 'sidestream_direct_offer_test', $6, $7, $7
     )`,
    [
      IDS.entry, HASHES.assignment, HASHES.assignmentSignature,
      HASHES.entryToken, HASHES.attribution, TIME.expiry, TIME.firstObserved,
    ],
  );
  await pool.query(
    `insert into ${schema}.sidestream_paid_acquisition_checkouts (
       id, entry_id, contract_version, environment, experiment_id, cohort,
       assignment_id_hash, entry_token_hash, attribution_hash,
       checkout_intent_ref, idempotency_key, request_fingerprint,
       verified_checkout_session_ref, canonical_payment_ref,
       checkout_email_normalized, verified_product_ref, verified_price_ref,
       verified_quantity, verified_amount_minor, verified_currency,
       installer_receipt_hash, payment_state, claim_state, receipt_expires_at,
       completed_at, expires_at, created_at, updated_at
     ) values (
       $1, $2, 1, 'test', 'mc-mobile-paid-v1', 'mc-paid-v1', $3, $4, $5,
       $6, $7, $8, $9, $10, 'repair-fixture@example.invalid', $11, $12,
       1, 1999, 'usd', $13, 'active', 'claimed', $14, $15, $14, $16, $15
     )`,
    [
      IDS.paidCheckout, IDS.entry, HASHES.assignment, HASHES.entryToken,
      HASHES.attribution, IDS.checkoutIntent, IDS.idempotency,
      HASHES.requestFingerprint, PROVIDER.checkoutSession, PROVIDER.paymentIntent,
      PROVIDER.product, PROVIDER.price, HASHES.browserReceipt, TIME.expiry,
      TIME.checkoutCompleted, TIME.checkoutStarted,
    ],
  );
  await pool.query(
    `insert into ${schema}.sidestream_paid_acquisition_claims (
       id, checkout_id, environment, canonical_payment_ref, activation_ref,
       account_ref, entitlement_ref, google_email_normalized, claim_state,
       created_at, updated_at, expires_at
     ) values (
       $1, $2, 'test', $3, $4, $5, $6, 'repair-fixture@example.invalid',
       'claimed', $7, $7, $8
     )`,
    [
      IDS.claim, IDS.paidCheckout, PROVIDER.paymentIntent, IDS.activation,
      IDS.account, IDS.license, TIME.paidProfile, TIME.expiry,
    ],
  );

  await pool.query(
    `insert into ${schema}.sidestream_customer_profiles (
       id, license_namespace, created_at, updated_at, contact_email, display_name
     ) values
       ($1, 'test', $3, $3, null, null),
       ($2, 'test', $4, $4, 'repair-fixture@example.invalid', 'Repair Fixture')`,
    [IDS.telemetryProfile, IDS.paidProfile, TIME.telemetryProfile, TIME.paidProfile],
  );
  await pool.query(
    `insert into ${schema}.sidestream_customer_installs (
       profile_id, license_namespace, install_id_hash, platform, app_version,
       first_seen_at, last_seen_at
     ) values
       ($1, 'test', $3, 'macos', '1.0.18', $5, $5),
       ($2, 'test', $4, 'macos', '1.0.18', $6, $6)`,
    [
      IDS.telemetryProfile, IDS.paidProfile, HASHES.currentInstall,
      HASHES.historicalInstall, TIME.telemetryProfile, TIME.paidProfile,
    ],
  );
  await pool.query(
    `insert into ${schema}.sidestream_customer_identity_links (
       profile_id, license_namespace, link_type, link_value, created_at
     ) values
       ($1, 'test', 'install_identity_hash', $3, $9),
       ($2, 'test', 'install_identity_hash', $4, $10),
       ($2, 'test', 'activation_record', $5, $11),
       ($2, 'test', 'account_identity', $6, $11),
       ($2, 'test', 'installer_receipt_hash', $7, $11),
       ($2, 'test', 'stripe_customer', $8, $10),
       ($2, 'test', 'stripe_checkout_session', $12, $10),
       ($2, 'test', 'stripe_payment_intent', $13, $10)`,
    [
      IDS.telemetryProfile, IDS.paidProfile, HASHES.currentInstall,
      HASHES.historicalInstall, IDS.activation, IDS.account, HASHES.nativeReceipt,
      PROVIDER.customer, TIME.telemetryProfile, TIME.paidProfile,
      TIME.identityReview, PROVIDER.checkoutSession, PROVIDER.paymentIntent,
    ],
  );
  await pool.query(
    `insert into ${schema}.sidestream_customer_identity_reviews (
       license_namespace, candidate_profile_id, existing_profile_id,
       evidence_type, evidence_value_hash, evidence_trust, attachment_source,
       review_state, created_at
     ) values (
       'test', $1, $2, 'install_identity_hash', $3, 'client_association',
       'activation_claim', 'pending_review', $4
     )`,
    [
      IDS.paidProfile,
      IDS.telemetryProfile,
      sha256(`install_identity_hash:${HASHES.currentInstall}`),
      TIME.identityReview,
    ],
  );

  await customerCommerce.materializeCustomerCommerceEvent(
    paymentIntentEvent(),
    (sql, params = []) => pool.query(
      sql.replace(/\bpublic\./g, `${schema}.`),
      params,
    ),
    "test",
  );
}

function paymentIntentEvent() {
  const created = Math.floor(Date.parse(TIME.paymentSettled) / 1_000);
  return {
    id: "evt_repair_fixture",
    object: "event",
    api_version: "2026-06-30.basil",
    created,
    data: {
      object: {
        id: PROVIDER.paymentIntent,
        created,
        customer: PROVIDER.customer,
        latest_charge: PROVIDER.charge,
        status: "succeeded",
        amount: 1999,
        amount_received: 1999,
        currency: "usd",
        metadata: { sidestream_commerce_model: "one_time" },
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: "payment_intent.succeeded",
  };
}

async function inTransaction(pool, schema, readOnly, callback) {
  const client = await pool.connect();
  const scoped = {
    query: (sql, params = []) => client.query(
      sql.replace(/\bpublic\./g, `${schema}.`),
      params,
    ),
  };
  try {
    await client.query(readOnly
      ? "begin isolation level repeatable read read only"
      : "begin isolation level serializable");
    const result = await callback(scoped);
    if (readOnly) await client.query("rollback");
    else await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function repairCounts(pool, schema) {
  const result = await pool.query(
    `select
       (select count(*)::int from ${schema}.sidestream_customer_profiles
        where license_namespace = 'test' and merged_into is null) as live_profiles,
       (select count(*)::int from ${schema}.sidestream_customer_profiles
        where license_namespace = 'test' and merged_into is not null) as merged_profiles,
       (select count(*)::int from ${schema}.sidestream_paid_telemetry_profile_bindings)
         as bindings,
       (select count(*)::int from ${schema}.sidestream_customer_profile_merges)
         as merge_audits,
       (select count(*)::int from ${schema}.sidestream_acquisition_stages
        where stage = 'authentication_completed') as authentication_stages,
       (select count(*)::int from ${schema}.sidestream_acquisition_stages
        where stage = 'installation_claimed') as installation_stages,
       (select count(distinct profile_id)::int
        from ${schema}.sidestream_customer_commerce_materializations
        where profile_id is not null) as commerce_profiles`,
  );
  const row = result.rows[0];
  return {
    liveProfiles: row.live_profiles,
    mergedProfiles: row.merged_profiles,
    bindings: row.bindings,
    mergeAudits: row.merge_audits,
    authenticationStages: row.authentication_stages,
    installationStages: row.installation_stages,
    commerceProfiles: row.commerce_profiles,
  };
}

function rewritePublicSchema(source, schema) {
  return source.replace(/\bpublic\./g, `${quoteIdentifier(schema)}.`);
}

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
    throw new TypeError("Unsafe disposable schema identifier");
  }
  return `"${identifier}"`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import * as paidTelemetryRepair from "../../api/_lib/paid-telemetry-handoff-repair.ts";

import "./customer-360-network-guard.mjs";
import {
  loadMigrationFiles,
  migrationSqlForTransaction,
  validateMigrationFiles,
} from "../../scripts/apply-postgres-migrations.mjs";
import {
  createTestPoolOptions,
  requireSafeTestDatabaseUrl,
} from "../../scripts/run-postgres-integration.mjs";
import { loadInjectedModule } from "./handler-loader.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const telemetryFixturePath = join(
  repositoryRoot,
  "tests/customer-360/fixtures/usage-telemetry.sql",
);

const IDS = Object.freeze({
  acquisition: "71000000-0000-4000-8000-000000000001",
  account: "72000000-0000-4000-8000-000000000001",
  license: "73000000-0000-4000-8000-000000000001",
  activation: "74000000-0000-4000-8000-000000000001",
  checkoutIntent: "75000000-0000-4000-8000-000000000001",
  entry: "76000000-0000-4000-8000-000000000001",
  paidCheckout: "77000000-0000-4000-8000-000000000001",
  claim: "78000000-0000-4000-8000-000000000001",
  idempotency: "79000000-0000-4000-8000-000000000001",
});

const HISTORICAL_PAID_REPLAYS = Object.freeze([
  Object.freeze({
    license: "73000000-0000-4000-8000-000000000002",
    activation: "74000000-0000-4000-8000-000000000002",
    checkoutIntent: "75000000-0000-4000-8000-000000000002",
    entry: "76000000-0000-4000-8000-000000000002",
    paidCheckout: "77000000-0000-4000-8000-000000000002",
    claim: "78000000-0000-4000-8000-000000000002",
    idempotency: "79000000-0000-4000-8000-000000000002",
    checkoutSession: "cs_fixture_paid_handoff_history_1",
    paymentIntent: "pi_fixture_paid_handoff_history_1",
    entryToken: "5".repeat(64),
    browserToken: "6".repeat(64),
    requestFingerprint: "7".repeat(64),
    installerReceipt: "8".repeat(64),
  }),
  Object.freeze({
    activation: "74000000-0000-4000-8000-000000000003",
    checkoutIntent: "75000000-0000-4000-8000-000000000003",
    entry: "76000000-0000-4000-8000-000000000003",
    paidCheckout: "77000000-0000-4000-8000-000000000003",
    claim: "78000000-0000-4000-8000-000000000003",
    idempotency: "79000000-0000-4000-8000-000000000003",
    checkoutSession: "cs_fixture_paid_handoff_history_2",
    paymentIntent: "pi_fixture_paid_handoff_history_2",
    entryToken: "9".repeat(64),
    browserToken: "0".repeat(64),
    requestFingerprint: "a".repeat(64),
    installerReceipt: "b".repeat(64),
  }),
]);

const HASHES = Object.freeze({
  currentInstall: "a".repeat(64),
  historicalInstall: "b".repeat(64),
  nativeReceipt: "c".repeat(64),
  directNativeReceipt: "7".repeat(64),
  browserToken: "d".repeat(64),
  assignment: "e".repeat(64),
  assignmentSignature: "f".repeat(64),
  entryToken: "1".repeat(64),
  attribution: "2".repeat(64),
  requestFingerprint: "3".repeat(64),
  device: "4".repeat(64),
});

const PROVIDER = Object.freeze({
  customer: "cus_fixture_paid_handoff",
  checkoutSession: "cs_fixture_paid_handoff",
  paymentIntent: "pi_fixture_paid_handoff",
  charge: "ch_fixture_paid_handoff",
  product: "prod_fixture_paid_handoff",
  price: "price_fixture_paid_handoff",
});

const FIXTURE_TIME = Object.freeze({
  firstObserved: "2026-08-08T10:00:00.000Z",
  checkoutStarted: "2026-08-08T10:01:00.000Z",
  checkoutCompleted: "2026-08-08T10:02:00.000Z",
  paymentSettled: "2026-08-08T10:03:00.000Z",
  telemetryStarted: "2026-08-09T09:00:00.000Z",
  telemetryReceived: "2026-08-09T09:10:00.000Z",
  activationCompleted: "2026-08-09T10:00:00.000Z",
  installationClaimed: "2026-08-09T10:05:00.000Z",
  postClaimTelemetryStarted: "2026-08-09T10:30:00.000Z",
  postClaimTelemetryReceived: "2026-08-09T10:40:00.000Z",
  syncNow: "2026-08-09T12:00:00.000Z",
  cohortStart: "2026-08-08T00:00:00.000Z",
  cohortEnd: "2026-08-10T00:00:00.000Z",
  observationEnd: "2026-08-11T00:00:00.000Z",
  expiry: "2030-01-01T00:00:00.000Z",
});

const ADMIN_SECRET = "fixture-paid-telemetry-handoff-cursor-secret";
const RECEIPT_SECRET = "fixture-paid-telemetry-handoff-receipt-secret";
const EXPECTED_JOURNEY_STAGES = Object.freeze([
  "landing_observed",
  "email_handoff_created",
  "installer_requested",
  "installation_claimed",
  "authentication_completed",
  "checkout_started",
  "checkout_completed",
  "payment_settled",
]);

const acquisitionIntegrity = await loadInjectedModule(
  new URL("../../api/_lib/acquisition-integrity.ts", import.meta.url),
  {},
);
const customerIdentity = await loadInjectedModule(
  new URL("../../api/_lib/customer-identity.ts", import.meta.url),
  {},
);
const customerProfiles = await loadInjectedModule(
  new URL("../../api/_lib/customer-profiles.ts", import.meta.url),
  {},
);
const customerCommerce = await loadInjectedModule(
  new URL("../../api/_lib/customer-commerce.ts", import.meta.url),
  {},
);
const customerUsage = await loadInjectedModule(
  new URL("../../api/_lib/customer-usage.ts", import.meta.url),
  {
    pg: { Pool },
    "./postgres.js": {
      getPostgresPool() {
        throw new Error("Paid telemetry handoff fixture injects disposable Postgres");
      },
      RUNTIME_POSTGRES_URL_ENV_NAMES: [],
    },
  },
);
const customerQuery = await loadInjectedModule(
  new URL("../../api/_lib/customer-query.ts", import.meta.url),
  {
    "./postgres.js": {
      withPostgresTransaction() {
        throw new Error("Paid telemetry handoff fixture injects a schema transaction");
      },
    },
  },
);
const acquisitionFunnel = await loadInjectedModule(
  new URL("../../api/_lib/acquisition-funnel.ts", import.meta.url),
  {
    "./postgres.js": {
      withPostgresTransaction() {
        throw new Error("Paid telemetry handoff fixture injects a schema transaction");
      },
    },
  },
);
const paidAcquisition = await loadInjectedModule(
  new URL("../../api/_lib/paid-acquisition.ts", import.meta.url),
  {},
);

export async function runPaidTelemetryHandoffFixture({
  expectation = "repaired",
  environment = process.env,
} = {}) {
  if (![
    "repaired",
    "broken",
    "pending-review-repaired",
    "reviewed-path-repaired",
  ].includes(expectation)) {
    throw new TypeError(
      "Paid telemetry handoff expectation must be repaired, broken, pending-review-repaired, or reviewed-path-repaired",
    );
  }

  const databaseUrl = requireSafeTestDatabaseUrl(environment);
  const suffix = randomBytes(8).toString("hex");
  const crmSchema = `sidestream_paid_handoff_${suffix}`;
  const telemetrySchema = `sidestream_paid_handoff_telemetry_${suffix}`;
  const quotedCrm = quoteIdentifier(crmSchema);
  const quotedTelemetry = quoteIdentifier(telemetrySchema);
  const pool = new Pool(createTestPoolOptions(databaseUrl));
  let crmCreated = false;
  let telemetryCreated = false;

  try {
    await pool.query(`create schema ${quotedCrm}`);
    crmCreated = true;
    await applyMigrations(pool, crmSchema);
    await pool.query(`create schema ${quotedTelemetry}`);
    telemetryCreated = true;
    await createTelemetrySchema(pool, telemetrySchema);

    const writeTransaction = schemaTransaction(pool, quotedCrm);
    const readTransaction = schemaTransaction(pool, quotedCrm, { readOnly: true });
    const integrityDependencies = {
      transaction: writeTransaction,
      namespace: "test",
    };

    if (
      expectation === "pending-review-repaired" ||
      expectation === "reviewed-path-repaired"
    ) {
      const summary = await runPendingReviewRepairedScenario({
        pool,
        quotedCrm,
        quotedTelemetry,
        crmSchema,
        telemetrySchema,
        writeTransaction,
        readTransaction,
        integrityDependencies,
        repairUniqueReviewedPath: expectation === "reviewed-path-repaired",
      });
      if (expectation === "reviewed-path-repaired") {
        assertReviewedPathRepairedExpectation(summary);
      } else {
        assertPendingReviewRepairedExpectation(summary);
      }
      return summary;
    }

    await acquisitionIntegrity.createCanonicalAcquisitionRoot({
      acquisitionId: IDS.acquisition,
      firstObservedAt: FIXTURE_TIME.firstObserved,
      landingDeduplicationReference: "fixture-meta-paid-landing",
      source: "meta",
      medium: "social",
      campaign: "sidestream_direct_offer_test",
      contentCreative: "paid",
      entryChannel: "website",
      externalReferrerCategory: "social",
      experiment: { id: "meta-direct-links-v1", cohort: "paid" },
      attributionConfidence: "exact_trusted_delivery",
      trustedDeliveryEvidence: ["website_entry", "checkout_intent"],
    }, integrityDependencies);

    const browserReceipt = paidAcquisition.createPaidAcquisitionReceipt({
      environment: "test",
      verifiedCheckoutSessionRef: PROVIDER.checkoutSession,
      secret: RECEIPT_SECRET,
    });
    await seedAuthenticatedPaidJourney(pool, quotedCrm, browserReceipt);

    await acquisitionIntegrity.addTrustedDeliveryEvidence({
      acquisitionId: IDS.acquisition,
      evidence: "authenticated_account",
    }, integrityDependencies);
    await acquisitionIntegrity.recordAcquisitionStage({
      acquisitionId: IDS.acquisition,
      stage: "authentication_completed",
      stableServerReference: `google-account:${IDS.acquisition}:${IDS.account}`,
      occurredAt: FIXTURE_TIME.checkoutStarted,
    }, integrityDependencies);

    for (const [stage, stableServerReference, occurredAt, evidence] of [
      ["email_handoff_created", "paid-handoff:fixture", FIXTURE_TIME.checkoutCompleted,
        "signed_email_handoff"],
      ["installer_requested", "installer-request:fixture", FIXTURE_TIME.checkoutCompleted,
        "installer_redirect"],
    ]) {
      await acquisitionIntegrity.recordAcquisitionStage({
        acquisitionId: IDS.acquisition,
        stage,
        stableServerReference,
        occurredAt,
      }, integrityDependencies);
      await acquisitionIntegrity.addTrustedDeliveryEvidence({
        acquisitionId: IDS.acquisition,
        evidence,
      }, integrityDependencies);
    }

    for (const [stage, stableServerReference, occurredAt] of [
      ["checkout_started", `checkout-intent:${IDS.checkoutIntent}`, FIXTURE_TIME.checkoutStarted],
      ["checkout_completed", `checkout-session:${PROVIDER.checkoutSession}`, FIXTURE_TIME.checkoutCompleted],
      ["payment_settled", `payment:${PROVIDER.paymentIntent}`, FIXTURE_TIME.paymentSettled],
    ]) {
      await acquisitionIntegrity.recordAcquisitionStage({
        acquisitionId: IDS.acquisition,
        stage,
        stableServerReference,
        occurredAt,
      }, integrityDependencies);
    }

    await seedTelemetry(pool, quotedTelemetry);
    const usageSummary = await customerUsage.runCustomerUsageSync({
      targetPool: pool,
      telemetryPool: pool,
      targetSchema: crmSchema,
      telemetrySchema,
      licenseNamespace: "test",
      overlapMs: 48 * 60 * 60 * 1_000,
      batchSize: 50,
      now: new Date(FIXTURE_TIME.syncNow),
    });

    const telemetryOwner = await installOwner(pool, quotedCrm, HASHES.currentInstall);
    if (!telemetryOwner) throw new Error("Telemetry did not materialize a current-install profile");

    const historicalAttachment = await writeTransaction((client) =>
      customerIdentity.attachCustomerIdentity(client, {
        environment: { namespace: "test" },
        identity: { installIdHash: HASHES.historicalInstall },
        activationId: IDS.activation,
        accountId: IDS.account,
        platform: "macos",
        appVersion: "1.0.18",
        source: "activation_status",
      }));
    if (!historicalAttachment.profileId) {
      throw new Error("Paid activation did not materialize an authenticated profile");
    }

    await pool.query(
      `update ${quotedCrm}.sidestream_customer_installs
       set first_seen_at = $2, last_seen_at = $2
       where profile_id = $1 and install_id_hash = $3`,
      [
        historicalAttachment.profileId,
        FIXTURE_TIME.activationCompleted,
        HASHES.historicalInstall,
      ],
    );

    const exactIdentityAttachment = await writeTransaction((client) =>
      customerIdentity.attachCustomerIdentity(client, {
        environment: { namespace: "test" },
        identity: {
          installIdHash: HASHES.currentInstall,
          installerReceiptIdHash: HASHES.nativeReceipt,
        },
        activationId: IDS.activation,
        accountId: IDS.account,
        platform: "macos",
        appVersion: "1.0.18",
        source: "activation_claim",
      }));

    const firstCommerceResult = await customerCommerce.materializeCustomerCommerceEvent(
      paymentIntentEvent(),
      schemaQuery(pool, quotedCrm),
      "test",
    );

    const linkageInput = {
      environment: "test",
      activationKey: "activation_fixture_paid_handoff",
      expectedAccountId: IDS.account,
      receipt: browserReceipt,
      installIdHash: HASHES.currentInstall,
      installerReceiptIdHash: HASHES.nativeReceipt,
      occurredAt: new Date(FIXTURE_TIME.installationClaimed),
    };
    const linkageDependencies = {
      transaction: writeTransaction,
      recordStage: (input, options) =>
        acquisitionIntegrity.recordAcquisitionStage(input, options),
      addEvidence: (input, options) =>
        acquisitionIntegrity.addTrustedDeliveryEvidence(input, options),
      mergeProfiles: customerProfiles.mergeCustomerProfilesInTransaction,
    };
    const linkageAttempts = await Promise.all([
      paidAcquisition.associatePaidAcquisitionActivationWithOutcome(
        linkageInput,
        linkageDependencies,
      ),
      paidAcquisition.associatePaidAcquisitionActivationWithOutcome(
        linkageInput,
        linkageDependencies,
      ),
    ]);
    linkageAttempts.push(
      await paidAcquisition.associatePaidAcquisitionActivationWithOutcome(
        linkageInput,
        linkageDependencies,
      ),
      await paidAcquisition.associatePaidAcquisitionActivationWithOutcome(
        linkageInput,
        linkageDependencies,
      ),
    );

    await Promise.all([
      replayExpectedJourneyStages(integrityDependencies),
      replayExpectedJourneyStages(integrityDependencies),
    ]);

    const commerceReplayResults = await Promise.all([
      customerCommerce.materializeCustomerCommerceEvent(
        paymentIntentEvent(), schemaQuery(pool, quotedCrm), "test",
      ),
      customerCommerce.materializeCustomerCommerceEvent(
        paymentIntentEvent(), schemaQuery(pool, quotedCrm), "test",
      ),
      customerCommerce.materializeCustomerCommerceEvent(
        checkoutSessionEvent(), schemaQuery(pool, quotedCrm), "test",
      ),
      customerCommerce.materializeCustomerCommerceEvent(
        checkoutSessionEvent(), schemaQuery(pool, quotedCrm), "test",
      ),
    ]);

    await seedTelemetry(pool, quotedTelemetry, {
      phase: "post-claim",
      startedAt: FIXTURE_TIME.postClaimTelemetryStarted,
      receivedBaseAt: FIXTURE_TIME.postClaimTelemetryReceived,
    });
    const replayUsageSummaries = [];
    for (let replay = 0; replay < 2; replay += 1) {
      replayUsageSummaries.push(await customerUsage.runCustomerUsageSync({
        targetPool: pool,
        telemetryPool: pool,
        targetSchema: crmSchema,
        telemetrySchema,
        licenseNamespace: "test",
        overlapMs: 48 * 60 * 60 * 1_000,
        batchSize: 50,
        now: new Date(
          Date.parse(FIXTURE_TIME.syncNow) + (replay + 1) * 24 * 60 * 60 * 1_000,
        ),
      }));
    }

    const negativeFixtures = await runNegativeFixtures({
      pool,
      quotedCrm,
      linkageInput,
      linkageDependencies,
    });

    const summary = await privacySafeSummary({
      pool,
      quotedCrm,
      quotedTelemetry,
      readTransaction,
      telemetryOwner,
      exactIdentityAttachment,
      usageSummaries: [usageSummary, ...replayUsageSummaries],
      commerceResults: [firstCommerceResult, ...commerceReplayResults],
      linkageAttempts,
      negativeFixtures,
    });
    assertExpectation(summary, expectation);
    return summary;
  } finally {
    if (telemetryCreated) {
      await pool.query(`drop schema if exists ${quotedTelemetry} cascade`).catch(() => {});
    }
    if (crmCreated) {
      await pool.query(`drop schema if exists ${quotedCrm} cascade`).catch(() => {});
    }
    await pool.end().catch(() => {});
  }
}

async function runPendingReviewRepairedScenario({
  pool,
  quotedCrm,
  quotedTelemetry,
  crmSchema,
  telemetrySchema,
  writeTransaction,
  readTransaction,
  integrityDependencies,
  repairUniqueReviewedPath,
}) {
  await acquisitionIntegrity.createCanonicalAcquisitionRoot({
    acquisitionId: IDS.acquisition,
    firstObservedAt: FIXTURE_TIME.firstObserved,
    landingDeduplicationReference: "fixture-meta-paid-pending-review",
    source: "meta",
    medium: "social",
    campaign: "sidestream_direct_offer_test",
    contentCreative: "paid",
    entryChannel: "website",
    externalReferrerCategory: "social",
    experiment: { id: "meta-direct-links-v1", cohort: "paid" },
    attributionConfidence: "exact_trusted_delivery",
    trustedDeliveryEvidence: ["website_entry", "checkout_intent"],
  }, integrityDependencies);

  const browserReceipt = paidAcquisition.createPaidAcquisitionReceipt({
    environment: "test",
    verifiedCheckoutSessionRef: PROVIDER.checkoutSession,
    secret: RECEIPT_SECRET,
  });
  await seedAuthenticatedPaidJourney(pool, quotedCrm, browserReceipt);
  await pool.query(
    `update ${quotedCrm}.sidestream_checkout_intents
     set account_id = $2, intent_kind = 'account' where id = $1`,
    [IDS.checkoutIntent, IDS.account],
  );
  await pool.query(
    `update ${quotedCrm}.sidestream_paid_acquisition_checkouts
     set claim_state = 'unclaimed' where id = $1`,
    [IDS.paidCheckout],
  );
  await pool.query(
    `update ${quotedCrm}.sidestream_paid_acquisition_claims
     set activation_ref = $2, claim_state = 'unclaimed'
     where id = $1`,
    [IDS.claim, IDS.activation],
  );
  await seedHistoricalPaidReplays(pool, quotedCrm, {
    replayCount: repairUniqueReviewedPath ? 1 : HISTORICAL_PAID_REPLAYS.length,
    independentEntitlement: repairUniqueReviewedPath,
  });

  for (const [stage, stableServerReference, occurredAt] of [
    ["email_handoff_created", "pending-review-paid-handoff", FIXTURE_TIME.checkoutCompleted],
    ["installer_requested", "pending-review-installer-request", FIXTURE_TIME.checkoutCompleted],
    ["installation_claimed", `installation:${HASHES.currentInstall}`,
      FIXTURE_TIME.installationClaimed],
    ["checkout_started", `checkout-intent:${IDS.checkoutIntent}`,
      FIXTURE_TIME.checkoutStarted],
    ["checkout_completed", `checkout-session:${PROVIDER.checkoutSession}`,
      FIXTURE_TIME.checkoutCompleted],
    ["payment_settled", `payment:${PROVIDER.paymentIntent}`,
      FIXTURE_TIME.paymentSettled],
  ]) {
    await acquisitionIntegrity.recordAcquisitionStage({
      acquisitionId: IDS.acquisition,
      stage,
      stableServerReference,
      occurredAt,
    }, integrityDependencies);
  }
  await acquisitionIntegrity.addTrustedDeliveryEvidence({
    acquisitionId: IDS.acquisition,
    evidence: "verified_installation_claim",
  }, integrityDependencies);

  await seedTelemetry(pool, quotedTelemetry, { phase: "pending-review" });
  await customerUsage.runCustomerUsageSync({
    targetPool: pool,
    telemetryPool: pool,
    targetSchema: crmSchema,
    telemetrySchema,
    licenseNamespace: "test",
    overlapMs: 48 * 60 * 60 * 1_000,
    batchSize: 50,
    now: new Date(FIXTURE_TIME.syncNow),
  });
  const telemetryOwner = await installOwner(pool, quotedCrm, HASHES.currentInstall);
  if (!telemetryOwner) throw new Error("Pending-review telemetry profile was not materialized");

  const accountAttachment = await writeTransaction((client) =>
    customerIdentity.attachCustomerIdentity(client, {
      environment: { namespace: "test" },
      identity: {
        installIdHash: HASHES.historicalInstall,
        ...(repairUniqueReviewedPath
          ? { installerReceiptIdHash: HASHES.directNativeReceipt }
          : {}),
      },
      activationId: HISTORICAL_PAID_REPLAYS[0].activation,
      accountId: IDS.account,
      platform: "macos",
      appVersion: "1.0.18",
      source: "activation_claim",
    }));
  if (!accountAttachment.profileId) {
    throw new Error("Pending-review account profile was not materialized");
  }

  await writeTransaction((client) => customerIdentity.attachCustomerIdentity(client, {
    environment: { namespace: "test" },
    identity: {
      installIdHash: HASHES.currentInstall,
      installerReceiptIdHash: HASHES.nativeReceipt,
    },
    activationId: IDS.activation,
    platform: "macos",
    appVersion: "1.0.18",
    source: "activation_claim",
  }));
  const pendingAttachment = await writeTransaction((client) =>
    customerIdentity.attachCustomerIdentity(client, {
      environment: { namespace: "test" },
      identity: {
        installIdHash: HASHES.currentInstall,
        installerReceiptIdHash: HASHES.nativeReceipt,
      },
      activationId: IDS.activation,
      accountId: IDS.account,
      platform: "macos",
      appVersion: "1.0.18",
      source: "activation_claim",
    }));
  if (pendingAttachment.profileId !== telemetryOwner || !pendingAttachment.reviewRequired) {
    throw new Error("Pending-review verified account conflict was not reproduced");
  }

  await customerCommerce.materializeCustomerCommerceEvent(
    paymentIntentEvent(),
    schemaQuery(pool, quotedCrm),
    "test",
  );

  if (repairUniqueReviewedPath) {
    const mutableBefore = await paidTelemetryAmbiguityMutationCounts(pool, quotedCrm);
    const guardedDryRun = await readTransaction((client) =>
      paidTelemetryRepair.inspectPaidTelemetryHandoffRepair(client, {
        acquisitionId: IDS.acquisition,
        namespace: "test",
      }));
    const mutableAfterDryRun = await paidTelemetryAmbiguityMutationCounts(pool, quotedCrm);
    const boundary = await reviewedPathSelectionPrivacySafeSummary({
      pool,
      quotedCrm,
      telemetryOwner,
      accountOwner: accountAttachment.profileId,
    });
    const guardedFirstApply = await writeTransaction((client) =>
      paidTelemetryRepair.applyPaidTelemetryHandoffRepair(client, {
        acquisitionId: IDS.acquisition,
        namespace: "test",
        confirmJourney: guardedDryRun.journeyFingerprint,
      }));
    const mutableAfterFirstApply = await paidTelemetryAmbiguityMutationCounts(
      pool,
      quotedCrm,
    );
    const guardedReplay = await writeTransaction((client) =>
      paidTelemetryRepair.applyPaidTelemetryHandoffRepair(client, {
        acquisitionId: IDS.acquisition,
        namespace: "test",
        confirmJourney: guardedDryRun.journeyFingerprint,
      }));
    const mutableAfterReplay = await paidTelemetryAmbiguityMutationCounts(pool, quotedCrm);
    const guardedAfterReplay = await readTransaction((client) =>
      paidTelemetryRepair.inspectPaidTelemetryHandoffRepair(client, {
        acquisitionId: IDS.acquisition,
        namespace: "test",
      }));
    return reviewedPathRepairedPrivacySafeSummary({
      boundary,
      guardedDryRun,
      guardedFirstApply,
      guardedReplay,
      guardedAfterReplay,
      mutableBefore,
      mutableAfterDryRun,
      mutableAfterFirstApply,
      mutableAfterReplay,
    });
  }

  const linkageInput = {
    environment: "test",
    activationKey: "activation_fixture_paid_handoff",
    expectedAccountId: IDS.account,
    receipt: browserReceipt,
    installIdHash: HASHES.currentInstall,
    installerReceiptIdHash: HASHES.nativeReceipt,
    occurredAt: new Date(FIXTURE_TIME.installationClaimed),
  };
  const linkageDependencies = {
    transaction: writeTransaction,
    recordStage: (input, options) =>
      acquisitionIntegrity.recordAcquisitionStage(input, options),
    addEvidence: (input, options) =>
      acquisitionIntegrity.addTrustedDeliveryEvidence(input, options),
    mergeProfiles: customerProfiles.mergeCustomerProfilesInTransaction,
  };
  const guardedDryRun = await readTransaction((client) =>
    paidTelemetryRepair.inspectPaidTelemetryHandoffRepair(client, {
      acquisitionId: IDS.acquisition,
      namespace: "test",
    }));
  const guardedApplyProbe = await rollbackScenario(
    pool,
    quotedCrm,
    (client) => paidTelemetryRepair.applyPaidTelemetryHandoffRepair(client, {
      acquisitionId: IDS.acquisition,
      namespace: "test",
      confirmJourney: guardedDryRun.journeyFingerprint,
    }),
  );

  const currentFinalizer = await paidAcquisition.associatePaidAcquisitionActivationWithOutcome(
    linkageInput,
    linkageDependencies,
  );
  const finalizerReplay = await paidAcquisition.associatePaidAcquisitionActivationWithOutcome(
    linkageInput,
    linkageDependencies,
  );
  const guardedAfterRuntime = await readTransaction((client) =>
    paidTelemetryRepair.inspectPaidTelemetryHandoffRepair(client, {
      acquisitionId: IDS.acquisition,
      namespace: "test",
    }));

  return pendingReviewPrivacySafeSummary({
    pool,
    quotedCrm,
    quotedTelemetry,
    readTransaction,
    telemetryOwner,
    accountOwner: accountAttachment.profileId,
    currentFinalizer,
    finalizerReplay,
    guardedDryRun,
    guardedApplyProbe,
    guardedAfterRuntime,
  });
}

async function seedHistoricalPaidReplays(pool, schema, {
  replayCount = HISTORICAL_PAID_REPLAYS.length,
  independentEntitlement = false,
} = {}) {
  for (const [index, replay] of HISTORICAL_PAID_REPLAYS.slice(0, replayCount).entries()) {
    const createdAt = new Date(
      Date.parse(FIXTURE_TIME.checkoutStarted) - (index + 1) * 60 * 60 * 1_000,
    ).toISOString();
    const entitlementId = independentEntitlement && index === 0
      ? replay.license
      : IDS.license;
    if (independentEntitlement && index === 0) {
      await pool.query(
        `insert into ${schema}.sidestream_licenses (
           id, account_id, stripe_customer_id, stripe_subscription_id,
           stripe_checkout_session_id, stripe_payment_intent_id, stripe_charge_id,
           stripe_price_id, stripe_product_id, amount_paid, amount_refunded, currency,
           plan_key, status, entitlement_status, status_reason, reconciled_at,
           features, created_at, updated_at
         ) values (
           $1, $2, $3, null, $4, $5, null, $6, $7, 1999, 0, 'usd',
           'sidestream_unlimited', 'active', 'active', 'checkout_fulfilled', $8,
           '{}'::jsonb, $8, $8
         )`,
        [
          entitlementId,
          IDS.account,
          PROVIDER.customer,
          replay.checkoutSession,
          replay.paymentIntent,
          PROVIDER.price,
          PROVIDER.product,
          createdAt,
        ],
      );
    }
    await pool.query(
      `insert into ${schema}.sidestream_activation_sessions (
         id, activation_key, account_id, license_id, device_id_hash, app_version,
         build_channel, source, status, expires_at, completed_at, created_at, updated_at
       ) values (
         $1, $2, $3, $4, $5, '1.0.18', 'production',
         'paid-acquisition-mc-v1', 'completed', $6, $7, $7, $7
       )`,
      [
        replay.activation,
        `activation_fixture_paid_handoff_history_${index + 1}`,
        IDS.account,
        entitlementId,
        createHash("sha256").update(`historical-device-${index}`).digest("hex"),
        FIXTURE_TIME.expiry,
        createdAt,
      ],
    );
    await pool.query(
      `insert into ${schema}.sidestream_checkout_intents (
         id, acquisition_id, account_id, intent_kind, browser_token_hash, state,
         stripe_customer_id, stripe_checkout_session_id, stripe_checkout_url,
         stripe_price_id, stripe_product_id, stripe_session_expires_at,
         confirmed_at, expires_at, created_at, updated_at
       ) values (
         $1, $2, $3, 'account', $4, 'completed', $5, $6,
         'https://checkout.stripe.test/fixture-paid-handoff-history', $7, $8, $9,
         $10, $9, $11, $10
       )`,
      [
        replay.checkoutIntent,
        IDS.acquisition,
        IDS.account,
        replay.browserToken,
        PROVIDER.customer,
        replay.checkoutSession,
        PROVIDER.price,
        PROVIDER.product,
        FIXTURE_TIME.expiry,
        createdAt,
        createdAt,
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
        replay.entry,
        HASHES.assignment,
        HASHES.assignmentSignature,
        replay.entryToken,
        HASHES.attribution,
        FIXTURE_TIME.expiry,
        createdAt,
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
         $6, $7, $8, $9, $10, 'paid-handoff@example.invalid', $11, $12,
         1, 1999, 'usd', $13, 'active', 'claimed', $14, $15, $14, $16, $15
       )`,
      [
        replay.paidCheckout,
        replay.entry,
        HASHES.assignment,
        replay.entryToken,
        HASHES.attribution,
        replay.checkoutIntent,
        replay.idempotency,
        replay.requestFingerprint,
        replay.checkoutSession,
        replay.paymentIntent,
        PROVIDER.product,
        PROVIDER.price,
        replay.installerReceipt,
        FIXTURE_TIME.expiry,
        createdAt,
        createdAt,
      ],
    );
    await pool.query(
      `insert into ${schema}.sidestream_paid_acquisition_claims (
         id, checkout_id, environment, canonical_payment_ref, activation_ref,
         account_ref, entitlement_ref, google_email_normalized, claim_state,
         created_at, updated_at, expires_at
       ) values (
         $1, $2, 'test', $3, $4, $5, $6, 'paid-handoff@example.invalid',
         'claimed', $7, $7, $8
       )`,
      [
        replay.claim,
        replay.paidCheckout,
        replay.paymentIntent,
        replay.activation,
        IDS.account,
        entitlementId,
        createdAt,
        FIXTURE_TIME.expiry,
      ],
    );
  }
}

async function markCurrentClaimClaimed(client) {
  await client.query(
    `update public.sidestream_paid_acquisition_checkouts
     set claim_state = 'claimed' where id = $1::uuid`,
    [IDS.paidCheckout],
  );
  await client.query(
    `update public.sidestream_paid_acquisition_claims
     set claim_state = 'claimed' where id = $1::uuid`,
    [IDS.claim],
  );
}

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

async function createTelemetrySchema(pool, schema) {
  const fixture = await readFile(telemetryFixturePath, "utf8");
  const quoted = quoteIdentifier(schema);
  await pool.query(fixture
    .replace(
      "create table sidestream_telemetry_events",
      `create table ${quoted}.sidestream_telemetry_events`,
    )
    .replaceAll(
      "on sidestream_telemetry_events",
      `on ${quoted}.sidestream_telemetry_events`,
    ));
}

async function seedAuthenticatedPaidJourney(pool, schema, browserReceipt) {
  const browserReceiptHash = createHash("sha256").update(browserReceipt).digest("hex");
  await pool.query(
    `insert into ${schema}.sidestream_accounts (
       id, google_sub, email, display_name, stripe_customer_id, last_login_at,
       created_at, updated_at
     ) values ($1, $2, $3, $4, $5, $6, $6, $6)`,
    [
      IDS.account,
      "google_fixture_paid_handoff",
      "paid-handoff@example.invalid",
      "Synthetic Paid Customer",
      PROVIDER.customer,
      FIXTURE_TIME.checkoutCompleted,
    ],
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
      IDS.license,
      IDS.account,
      PROVIDER.customer,
      PROVIDER.checkoutSession,
      PROVIDER.paymentIntent,
      PROVIDER.charge,
      PROVIDER.price,
      PROVIDER.product,
      FIXTURE_TIME.paymentSettled,
    ],
  );
  await pool.query(
    `insert into ${schema}.sidestream_activation_sessions (
       id, activation_key, account_id, license_id, device_id_hash, app_version,
       build_channel, source, status, expires_at, completed_at, created_at, updated_at
     ) values (
       $1, 'activation_fixture_paid_handoff', $2, $3, $4, '1.0.18',
       'production', 'paid-acquisition-mc-v1', 'completed', $5, $6, $6, $6
     )`,
    [
      IDS.activation,
      IDS.account,
      IDS.license,
      HASHES.device,
      FIXTURE_TIME.expiry,
      FIXTURE_TIME.activationCompleted,
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
       'https://checkout.stripe.test/fixture-paid-handoff', $6, $7, $8,
       $9, $8, $10, $9
     )`,
    [
      IDS.checkoutIntent,
      IDS.acquisition,
      HASHES.browserToken,
      PROVIDER.customer,
      PROVIDER.checkoutSession,
      PROVIDER.price,
      PROVIDER.product,
      FIXTURE_TIME.expiry,
      FIXTURE_TIME.checkoutCompleted,
      FIXTURE_TIME.checkoutStarted,
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
      IDS.entry,
      HASHES.assignment,
      HASHES.assignmentSignature,
      HASHES.entryToken,
      HASHES.attribution,
      FIXTURE_TIME.expiry,
      FIXTURE_TIME.firstObserved,
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
       $6, $7, $8, $9, $10, 'paid-handoff@example.invalid', $11, $12,
       1, 1999, 'usd', $13, 'active', 'claimed', $14, $15, $14, $16, $15
     )`,
    [
      IDS.paidCheckout,
      IDS.entry,
      HASHES.assignment,
      HASHES.entryToken,
      HASHES.attribution,
      IDS.checkoutIntent,
      IDS.idempotency,
      HASHES.requestFingerprint,
      PROVIDER.checkoutSession,
      PROVIDER.paymentIntent,
      PROVIDER.product,
      PROVIDER.price,
      browserReceiptHash,
      FIXTURE_TIME.expiry,
      FIXTURE_TIME.checkoutCompleted,
      FIXTURE_TIME.checkoutStarted,
    ],
  );
  await pool.query(
    `insert into ${schema}.sidestream_paid_acquisition_claims (
       id, checkout_id, environment, canonical_payment_ref, account_ref,
       entitlement_ref, google_email_normalized, claim_state,
       created_at, updated_at, expires_at
     ) values (
       $1, $2, 'test', $3, $4, $5, 'paid-handoff@example.invalid', 'claimed',
       $6, $6, $7
     )`,
    [
      IDS.claim,
      IDS.paidCheckout,
      PROVIDER.paymentIntent,
      IDS.account,
      IDS.license,
      FIXTURE_TIME.activationCompleted,
      FIXTURE_TIME.expiry,
    ],
  );
}

async function seedTelemetry(pool, schema, {
  phase = "initial",
  startedAt = FIXTURE_TIME.telemetryStarted,
  receivedBaseAt = FIXTURE_TIME.telemetryReceived,
} = {}) {
  const events = [
    [`telemetry-session-${phase}`, "session_started", "app", "app", {}, {
      runtime: { osPlatform: "macos" },
    }],
    [`telemetry-search-${phase}`, "search_submitted", "search", "app", {}, {}],
    [`telemetry-download-request-${phase}`, "download_requested", "download", "download", {
      download_id: `download-fixture-paid-handoff-${phase}`,
      download_trigger: "result_row",
    }, {}],
    [`telemetry-download-success-${phase}`, "download_attempt_finalized", "download", "download", {
      download_id: `download-fixture-paid-handoff-${phase}`,
      file_delivered: true,
      user_outcome: "got_file",
      import_result: "success",
    }, {}],
  ];
  for (const [index, [id, eventName, category, scope, payload, dataPoints]] of events.entries()) {
    const occurredAt = new Date(
      Date.parse(startedAt) + index * 30_000,
    ).toISOString();
    const eventReceivedAt = new Date(
      Date.parse(receivedBaseAt) + index * 30_000,
    ).toISOString();
    await pool.query(
      `insert into ${schema}.sidestream_telemetry_events (
         telemetry_event_id, install_id_hash, session_id, sequence, event_name,
         event_category, event_scope, occurred_at, received_at, app_version,
         build_channel, schema_version, payload, data_points
       ) values ($1, $2, $3, $4, $5, $6, $7,
         $8, $9, '1.0.18', 'test', '0.2.0', $10::jsonb, $11::jsonb)`,
      [
        id,
        HASHES.currentInstall,
        `session-fixture-paid-handoff-${phase}`,
        phase === "initial" ? index + 1 : index + 101,
        eventName,
        category,
        scope,
        occurredAt,
        eventReceivedAt,
        JSON.stringify(payload),
        JSON.stringify(dataPoints),
      ],
    );
  }
}

function paymentIntentEvent() {
  const created = Math.floor(Date.parse(FIXTURE_TIME.paymentSettled) / 1_000);
  return {
    id: "evt_fixture_paid_handoff",
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

function checkoutSessionEvent() {
  const created = Math.floor(Date.parse(FIXTURE_TIME.checkoutCompleted) / 1_000);
  return {
    id: "evt_fixture_paid_handoff_checkout",
    object: "event",
    api_version: "2026-06-30.basil",
    created,
    data: {
      object: {
        id: PROVIDER.checkoutSession,
        created,
        customer: PROVIDER.customer,
        payment_intent: PROVIDER.paymentIntent,
        payment_status: "paid",
        mode: "payment",
        amount_total: 1999,
        currency: "usd",
        total_details: { amount_discount: 0, amount_tax: 0 },
        metadata: { sidestream_commerce_model: "one_time" },
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: "checkout.session.completed",
  };
}

async function replayExpectedJourneyStages(integrityDependencies) {
  for (const [stage, stableServerReference, occurredAt] of [
    ["landing_observed", "fixture-meta-paid-landing", FIXTURE_TIME.firstObserved],
    ["email_handoff_created", "paid-handoff:fixture", FIXTURE_TIME.checkoutCompleted],
    ["installer_requested", "installer-request:fixture", FIXTURE_TIME.checkoutCompleted],
    ["installation_claimed", `installation:${HASHES.currentInstall}`,
      FIXTURE_TIME.installationClaimed],
    ["authentication_completed", `google-account:${IDS.acquisition}:${IDS.account}`,
      FIXTURE_TIME.checkoutStarted],
    ["checkout_started", `checkout-intent:${IDS.checkoutIntent}`,
      FIXTURE_TIME.checkoutStarted],
    ["checkout_completed", `checkout-session:${PROVIDER.checkoutSession}`,
      FIXTURE_TIME.checkoutCompleted],
    ["payment_settled", `payment:${PROVIDER.paymentIntent}`,
      FIXTURE_TIME.paymentSettled],
  ]) {
    const result = await acquisitionIntegrity.recordAcquisitionStage({
      acquisitionId: IDS.acquisition,
      stage,
      stableServerReference,
      occurredAt,
    }, integrityDependencies);
    if (result.ownerConflict) {
      throw new Error("Acquisition stage replay produced an ownership conflict");
    }
  }
}

async function runNegativeFixtures({
  pool,
  quotedCrm,
  linkageInput,
  linkageDependencies,
}) {
  const attempt = (input, mutation = null) => rollbackScenario(
    pool,
    quotedCrm,
    async (client) => paidAcquisition.associatePaidAcquisitionActivationWithOutcome(
      input,
      {
        ...linkageDependencies,
        transaction: (callback) => callback(client),
      },
    ),
    mutation,
  );
  const differentAccount = await attempt({
    ...linkageInput,
    expectedAccountId: "72000000-0000-4000-8000-000000000099",
  });
  const forwardedInstaller = await attempt({
    ...linkageInput,
    receipt: paidAcquisition.createPaidAcquisitionReceipt({
      environment: "test",
      verifiedCheckoutSessionRef: "cs_fixture_forwarded_installer",
      secret: RECEIPT_SECRET,
    }),
  });
  const { installerReceiptIdHash: _missingReceipt, ...missingReceiptInput } = linkageInput;
  const missingReceipt = await attempt(missingReceiptInput);
  const expiredAuthorization = await attempt(linkageInput, (client) => client.query(`
    update public.sidestream_paid_acquisition_checkouts
    set receipt_expires_at = now() - interval '1 minute'
    where id = $1::uuid
  `, [IDS.paidCheckout]));
  const refund = await attempt(linkageInput, (client) => client.query(`
    update public.sidestream_paid_acquisition_checkouts
    set payment_state = 'refunded'
    where id = $1::uuid
  `, [IDS.paidCheckout]));
  const dispute = await attempt(linkageInput, (client) => client.query(`
    update public.sidestream_paid_acquisition_checkouts
    set payment_state = 'disputed'
    where id = $1::uuid
  `, [IDS.paidCheckout]));
  const namespaceConflict = await attempt({
    ...linkageInput,
    environment: "production",
  });
  const ambiguousExactOwner = await rollbackScenario(
    pool,
    quotedCrm,
    async (client) => {
      await client.query(`
        update public.sidestream_customer_commerce_materializations
        set identity_conflict = true
        where license_namespace = 'test'
      `);
      try {
        await customerQuery.queryCustomerLookup({
          licenseNamespace: "test",
          stripeReference: PROVIDER.checkoutSession,
        }, { transaction: (callback) => callback(client) });
        return false;
      } catch (error) {
        return error?.code === "conflicting_lookup_ownership";
      }
    },
  );

  return Object.freeze({
    differentAccount: differentAccount.outcome === "claim_binding_conflict",
    forwardedInstaller: forwardedInstaller.outcome === "receipt_activation_no_match",
    ambiguousExactOwner,
    missingReceipt: missingReceipt.outcome === "installation_identity_missing",
    expiredAuthorization: expiredAuthorization.outcome === "receipt_activation_no_match",
    refund: refund.outcome === "receipt_activation_no_match",
    dispute: dispute.outcome === "receipt_activation_no_match",
    namespaceConflict: namespaceConflict.outcome === "receipt_activation_no_match",
  });
}

async function rollbackScenario(pool, quotedSchema, callback, mutation = null) {
  const client = await pool.connect();
  const scopedClient = {
    query: (sql, params = []) => client.query(
      sql.replace(/\bpublic\./g, `${quotedSchema}.`),
      [...params],
    ),
  };
  try {
    await client.query("begin");
    if (mutation) await mutation(scopedClient);
    return await callback(scopedClient);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

async function paidTelemetryAmbiguityMutationCounts(pool, quotedCrm) {
  const result = await pool.query(
    `select
       (select count(*)::int
        from ${quotedCrm}.sidestream_acquisition_stages
        where acquisition_id = $1::uuid
          and stage = 'authentication_completed') as authentication_stages,
       (select count(*)::int
        from ${quotedCrm}.sidestream_acquisition_stages
        where acquisition_id = $1::uuid
          and stage = 'installation_claimed') as installation_stages,
       (select count(*)::int
        from ${quotedCrm}.sidestream_paid_telemetry_profile_bindings
        where acquisition_id = $1::uuid) as bindings,
       (select count(*)::int
        from ${quotedCrm}.sidestream_customer_profile_merges) as merge_audits,
       (select count(*)::int
        from ${quotedCrm}.sidestream_paid_acquisition_checkouts paid
        join ${quotedCrm}.sidestream_checkout_intents core
          on core.id = paid.checkout_intent_ref
        where core.acquisition_id = $1::uuid and paid.claim_state = 'claimed')
         as claimed_checkouts,
       (select count(*)::int
        from ${quotedCrm}.sidestream_paid_acquisition_checkouts paid
        join ${quotedCrm}.sidestream_checkout_intents core
          on core.id = paid.checkout_intent_ref
        where core.acquisition_id = $1::uuid and paid.claim_state = 'unclaimed')
         as unclaimed_checkouts,
       (select count(*)::int
        from ${quotedCrm}.sidestream_paid_acquisition_claims claim
        join ${quotedCrm}.sidestream_paid_acquisition_checkouts paid
          on paid.id = claim.checkout_id
        join ${quotedCrm}.sidestream_checkout_intents core
          on core.id = paid.checkout_intent_ref
        where core.acquisition_id = $1::uuid and claim.claim_state = 'claimed')
         as claimed_claims,
       (select count(*)::int
        from ${quotedCrm}.sidestream_paid_acquisition_claims claim
        join ${quotedCrm}.sidestream_paid_acquisition_checkouts paid
          on paid.id = claim.checkout_id
        join ${quotedCrm}.sidestream_checkout_intents core
          on core.id = paid.checkout_intent_ref
        where core.acquisition_id = $1::uuid and claim.claim_state = 'unclaimed')
         as unclaimed_claims`,
    [IDS.acquisition],
  );
  const row = result.rows[0];
  return Object.freeze({
    authenticationStages: row.authentication_stages,
    installationStages: row.installation_stages,
    bindings: row.bindings,
    mergeAudits: row.merge_audits,
    claimedCheckouts: row.claimed_checkouts,
    unclaimedCheckouts: row.unclaimed_checkouts,
    claimedClaims: row.claimed_claims,
    unclaimedClaims: row.unclaimed_claims,
  });
}

async function reviewedPathSelectionPrivacySafeSummary({
  pool,
  quotedCrm,
  telemetryOwner,
  accountOwner,
}) {
  const paths = await pool.query(
    `select
       count(*)::int as paid_paths,
       count(*) filter (
         where acquisition.integrity_state = 'intact'
           and paid.environment = 'test'
           and core.state = 'completed'
           and core.account_id = account.id
           and paid.payment_state = 'active'
           and paid.claim_state = claim.claim_state
           and paid.claim_state in ('unclaimed', 'claimed')
           and paid.completed_at is not null
           and paid.receipt_expires_at > now()
           and claim.expires_at > now()
           and claim.account_ref = account.id
           and claim.entitlement_ref = entitlement.id
           and claim.activation_ref = activation.id
           and entitlement.account_id = account.id
           and entitlement.entitlement_status = 'active'
           and entitlement.plan_key in ('sidestream_pro', 'sidestream_unlimited')
           and activation.account_id = account.id
           and activation.license_id = entitlement.id
           and activation.source = 'paid-acquisition-mc-v1'
           and activation.status in ('paid', 'linked', 'restored', 'completed')
           and activation.completed_at is not null
           and activation.expires_at > now()
           and paid.verified_checkout_session_ref = core.stripe_checkout_session_id
           and paid.verified_checkout_session_ref = entitlement.stripe_checkout_session_id
           and paid.canonical_payment_ref = claim.canonical_payment_ref
           and paid.canonical_payment_ref = entitlement.stripe_payment_intent_id
           and paid.verified_product_ref = core.stripe_product_id
           and paid.verified_product_ref = entitlement.stripe_product_id
           and paid.verified_price_ref = core.stripe_price_id
           and paid.verified_price_ref = entitlement.stripe_price_id
           and paid.verified_quantity = 1
           and paid.verified_amount_minor = entitlement.amount_paid
           and entitlement.amount_refunded = 0
           and paid.verified_currency = entitlement.currency
           and lower(trim(paid.checkout_email_normalized)) = lower(trim(account.email))
           and lower(trim(claim.google_email_normalized)) = lower(trim(account.email))
       )::int as active_consistent_paths,
       count(distinct activation.id)::int as activation_paths
     from ${quotedCrm}.sidestream_acquisitions acquisition
     join ${quotedCrm}.sidestream_checkout_intents core
       on core.acquisition_id = acquisition.id
     join ${quotedCrm}.sidestream_paid_acquisition_checkouts paid
       on paid.checkout_intent_ref = core.id
     join ${quotedCrm}.sidestream_paid_acquisition_claims claim
       on claim.checkout_id = paid.id and claim.environment = paid.environment
     join ${quotedCrm}.sidestream_accounts account
       on account.id = claim.account_ref
     join ${quotedCrm}.sidestream_licenses entitlement
       on entitlement.id = claim.entitlement_ref
     join ${quotedCrm}.sidestream_activation_sessions activation
       on activation.id = claim.activation_ref
     where acquisition.id = $1::uuid and acquisition.license_namespace = 'test'`,
    [IDS.acquisition],
  );
  const bridges = await pool.query(
    `select
       (select count(*)::int
        from ${quotedCrm}.sidestream_customer_installs install
        where install.profile_id = $1::uuid and install.install_id_hash = $3)
         as direct_install_memberships,
       (select count(*)::int
        from ${quotedCrm}.sidestream_customer_identity_links link
        where link.profile_id = $1::uuid
          and link.link_type = 'activation_record' and link.link_value = $4::text)
         as direct_activation_links,
       (select count(*)::int
        from ${quotedCrm}.sidestream_customer_identity_links link
        where link.profile_id = $1::uuid
          and link.link_type = 'installer_receipt_hash' and link.link_value = $5)
         as direct_receipt_links,
       (select count(*)::int
        from ${quotedCrm}.sidestream_customer_identity_links link
        where link.profile_id = $1::uuid
          and link.link_type = 'account_identity' and link.link_value = $6::text)
         as direct_account_links,
       (select count(*)::int
        from ${quotedCrm}.sidestream_customer_identity_reviews review
        where review.license_namespace = 'test'
          and review.candidate_profile_id = $1::uuid
          and review.evidence_type = 'account_identity'
          and review.review_state = 'pending_review') as direct_candidate_reviews,
       (select count(*)::int
        from ${quotedCrm}.sidestream_customer_installs install
        where install.profile_id = $2::uuid and install.install_id_hash = $7)
         as reviewed_install_memberships,
       (select count(*)::int
        from ${quotedCrm}.sidestream_customer_identity_links link
        where link.profile_id = $2::uuid
          and link.link_type = 'activation_record' and link.link_value = $8::text)
         as reviewed_activation_links,
       (select count(*)::int
        from ${quotedCrm}.sidestream_customer_identity_links link
        where link.profile_id = $2::uuid
          and link.link_type = 'installer_receipt_hash' and link.link_value = $9)
         as reviewed_receipt_links,
       (select count(*)::int
        from ${quotedCrm}.sidestream_customer_identity_links link
        where link.profile_id = $2::uuid
          and (link.link_type = 'account_identity' or link.link_type like 'stripe_%'))
         as reviewed_direct_account_or_stripe_links,
       (select count(*)::int
        from ${quotedCrm}.sidestream_customer_identity_reviews review
        where review.license_namespace = 'test'
          and review.candidate_profile_id = $2::uuid
          and review.existing_profile_id = $1::uuid
          and review.evidence_type = 'account_identity'
          and review.evidence_trust = 'verified_server'
          and review.attachment_source = 'activation_claim'
          and review.review_state = 'pending_review') as reviewed_account_reviews,
       (select count(*)::int
        from ${quotedCrm}.sidestream_customer_identity_links link
        join ${quotedCrm}.sidestream_customer_profiles profile
          on profile.id = link.profile_id
          and profile.license_namespace = link.license_namespace
          and profile.merged_into is null
        where link.license_namespace = 'test'
          and link.link_type = 'account_identity' and link.link_value = $6::text)
         as unique_account_owner_links`,
    [
      accountOwner,
      telemetryOwner,
      HASHES.historicalInstall,
      HISTORICAL_PAID_REPLAYS[0].activation,
      HASHES.directNativeReceipt,
      IDS.account,
      HASHES.currentInstall,
      IDS.activation,
      HASHES.nativeReceipt,
    ],
  );
  const pathRow = paths.rows[0];
  const bridgeRow = bridges.rows[0];
  const bridgeKindsNonOverlapping =
    bridgeRow.direct_account_links === 1 &&
    bridgeRow.direct_candidate_reviews === 0 &&
    bridgeRow.reviewed_direct_account_or_stripe_links === 0 &&
    bridgeRow.reviewed_account_reviews === 1;
  return Object.freeze({
    acquisitionShape: Object.freeze({
      paidPaths: pathRow.paid_paths,
      activeConsistentPaths: pathRow.active_consistent_paths,
      activationPaths: pathRow.activation_paths,
    }),
    directPath: Object.freeze({
      currentInstallMemberships: bridgeRow.direct_install_memberships,
      activationLinks: bridgeRow.direct_activation_links,
      exactVerifiedReceiptLinks: bridgeRow.direct_receipt_links,
      directAccountLinks: bridgeRow.direct_account_links,
      pendingAccountReviewsAsCandidate: bridgeRow.direct_candidate_reviews,
    }),
    reviewedPath: Object.freeze({
      currentInstallMemberships: bridgeRow.reviewed_install_memberships,
      activationLinks: bridgeRow.reviewed_activation_links,
      exactVerifiedReceiptLinks: bridgeRow.reviewed_receipt_links,
      directAccountOrStripeLinks: bridgeRow.reviewed_direct_account_or_stripe_links,
      verifiedAccountReviews: bridgeRow.reviewed_account_reviews,
      uniqueExactAccountOwnerLinks: bridgeRow.unique_account_owner_links,
    }),
    bridgeKindsNonOverlapping,
  });
}

function reviewedPathRepairedPrivacySafeSummary({
  boundary,
  guardedDryRun,
  guardedFirstApply,
  guardedReplay,
  guardedAfterReplay,
  mutableBefore,
  mutableAfterDryRun,
  mutableAfterFirstApply,
  mutableAfterReplay,
}) {
  return Object.freeze({
    observedContract: "unique-reviewed-paid-path-repaired",
    ...boundary,
    guardedOperator: Object.freeze({
      beforeReasonCode: guardedDryRun.reasonCode,
      beforeEligible: guardedDryRun.eligible,
      beforeWouldMutate: guardedDryRun.wouldMutate,
      hasJourneyFingerprint: guardedDryRun.journeyFingerprint !== null,
      firstApplyReasonCode: guardedFirstApply.reasonCode,
      replayReasonCode: guardedReplay.reasonCode,
      afterReplayReasonCode: guardedAfterReplay.reasonCode,
      afterReplayWouldMutate: guardedAfterReplay.wouldMutate,
    }),
    mutationBoundary: Object.freeze({
      dryRunStateUnchanged:
        JSON.stringify(mutableBefore) === JSON.stringify(mutableAfterDryRun),
      applyChangedState:
        JSON.stringify(mutableBefore) !== JSON.stringify(mutableAfterFirstApply),
      replayWasNoOp:
        JSON.stringify(mutableAfterFirstApply) === JSON.stringify(mutableAfterReplay),
      before: mutableBefore,
      afterFirstApply: mutableAfterFirstApply,
      afterReplay: mutableAfterReplay,
    }),
  });
}

function assertReviewedPathRepairedExpectation(summary) {
  const expectedMutationCounts = {
    authenticationStages: 0,
    installationStages: 1,
    bindings: 0,
    mergeAudits: 0,
    claimedCheckouts: 1,
    unclaimedCheckouts: 1,
    claimedClaims: 1,
    unclaimedClaims: 1,
  };
  const expectedRepairedCounts = {
    authenticationStages: 1,
    installationStages: 1,
    bindings: 1,
    mergeAudits: 1,
    claimedCheckouts: 2,
    unclaimedCheckouts: 0,
    claimedClaims: 2,
    unclaimedClaims: 0,
  };
  const observed =
    summary.observedContract === "unique-reviewed-paid-path-repaired" &&
    summary.acquisitionShape.paidPaths === 2 &&
    summary.acquisitionShape.activeConsistentPaths === 2 &&
    summary.acquisitionShape.activationPaths === 2 &&
    summary.directPath.currentInstallMemberships === 1 &&
    summary.directPath.activationLinks === 1 &&
    summary.directPath.exactVerifiedReceiptLinks === 1 &&
    summary.directPath.directAccountLinks === 1 &&
    summary.directPath.pendingAccountReviewsAsCandidate === 0 &&
    summary.reviewedPath.currentInstallMemberships === 1 &&
    summary.reviewedPath.activationLinks === 1 &&
    summary.reviewedPath.exactVerifiedReceiptLinks === 1 &&
    summary.reviewedPath.directAccountOrStripeLinks === 0 &&
    summary.reviewedPath.verifiedAccountReviews === 1 &&
    summary.reviewedPath.uniqueExactAccountOwnerLinks === 1 &&
    summary.bridgeKindsNonOverlapping === true &&
    summary.guardedOperator.beforeReasonCode === "repair_ready" &&
    summary.guardedOperator.beforeEligible === true &&
    summary.guardedOperator.beforeWouldMutate === true &&
    summary.guardedOperator.hasJourneyFingerprint === true &&
    summary.guardedOperator.firstApplyReasonCode === "already_repaired" &&
    summary.guardedOperator.replayReasonCode === "already_repaired" &&
    summary.guardedOperator.afterReplayReasonCode === "already_repaired" &&
    summary.guardedOperator.afterReplayWouldMutate === false &&
    summary.mutationBoundary.dryRunStateUnchanged === true &&
    summary.mutationBoundary.applyChangedState === true &&
    summary.mutationBoundary.replayWasNoOp === true &&
    JSON.stringify(summary.mutationBoundary.before) ===
      JSON.stringify(expectedMutationCounts) &&
    JSON.stringify(summary.mutationBoundary.afterFirstApply) ===
      JSON.stringify(expectedRepairedCounts) &&
    JSON.stringify(summary.mutationBoundary.afterReplay) ===
      JSON.stringify(expectedRepairedCounts);
  if (!observed) {
    throw new Error(
      `Expected reviewed-path-repaired paid telemetry handoff contract; observed ${JSON.stringify(summary)}`,
    );
  }
}

async function pendingReviewPrivacySafeSummary({
  pool,
  quotedCrm,
  quotedTelemetry,
  readTransaction,
  telemetryOwner,
  accountOwner,
  currentFinalizer,
  finalizerReplay,
  guardedDryRun,
  guardedApplyProbe,
  guardedAfterRuntime,
}) {
  const shape = await pool.query(
    `select
       (select count(*)::int
        from ${quotedCrm}.sidestream_checkout_intents
        where acquisition_id = $1::uuid) as checkout_intents,
       (select count(*)::int
        from ${quotedCrm}.sidestream_paid_acquisition_checkouts paid
        join ${quotedCrm}.sidestream_checkout_intents core
          on core.id = paid.checkout_intent_ref
        where core.acquisition_id = $1::uuid) as paid_checkouts,
       (select count(*)::int
        from ${quotedCrm}.sidestream_paid_acquisition_claims claim
        join ${quotedCrm}.sidestream_paid_acquisition_checkouts paid
          on paid.id = claim.checkout_id
        join ${quotedCrm}.sidestream_checkout_intents core
          on core.id = paid.checkout_intent_ref
        where core.acquisition_id = $1::uuid
          and claim.activation_ref is not null
          and claim.activation_ref <> $2::uuid) as historical_activation_claims,
       (select count(*)::int
        from ${quotedCrm}.sidestream_paid_acquisition_claims claim
        join ${quotedCrm}.sidestream_paid_acquisition_checkouts paid
          on paid.id = claim.checkout_id and paid.environment = claim.environment
        join ${quotedCrm}.sidestream_licenses entitlement
          on entitlement.id = claim.entitlement_ref
        join ${quotedCrm}.sidestream_activation_sessions activation
          on activation.id = claim.activation_ref
        where claim.id = $3::uuid
          and claim.claim_state = 'claimed'
          and paid.claim_state = 'claimed'
          and claim.expires_at > now()
          and claim.activation_ref = $2::uuid
          and claim.account_ref = $4::uuid
          and claim.entitlement_ref = $5::uuid
          and paid.payment_state = 'active'
          and paid.completed_at is not null
          and paid.receipt_expires_at > now()
          and entitlement.account_id = $4::uuid
          and entitlement.entitlement_status = 'active'
          and activation.account_id = $4::uuid
          and activation.license_id = $5::uuid
          and activation.completed_at is not null
          and activation.expires_at > now()) as active_current_claim,
       (select count(*)::int
        from ${quotedCrm}.sidestream_acquisitions acquisition
        where acquisition.id = $1::uuid
          and acquisition.license_namespace = 'test'
          and acquisition.integrity_state = 'intact'
          and acquisition.first_observed_source = 'meta'
          and acquisition.first_observed_medium = 'social'
          and acquisition.first_observed_content_creative = 'paid') as intact_meta_paid_roots`,
    [IDS.acquisition, IDS.activation, IDS.claim, IDS.account, IDS.license],
  );
  const identity = await pool.query(
    `select
       (select count(*)::int
        from ${quotedCrm}.sidestream_customer_installs install
        where install.profile_id = $1::uuid
          and install.install_id_hash = $3) as current_install_memberships,
       (select count(*)::int
        from ${quotedCrm}.sidestream_customer_identity_links link
        where link.profile_id = $1::uuid
          and link.link_type = 'activation_record'
          and link.link_value = $4::text) as current_activation_links,
       (select count(*)::int
        from ${quotedCrm}.sidestream_customer_identity_links link
        where link.profile_id = $1::uuid
          and link.link_type = 'installer_receipt_hash'
          and link.link_value = $5) as current_receipt_links,
       (select count(*)::int
        from ${quotedCrm}.sidestream_customer_identity_links link
        where link.profile_id = $1::uuid
          and (link.link_type = 'account_identity' or link.link_type like 'stripe_%'))
         as current_account_or_stripe_links,
       (select count(*)::int
        from ${quotedCrm}.sidestream_customer_identity_links link
        join ${quotedCrm}.sidestream_customer_profiles profile
          on profile.id = link.profile_id
          and profile.license_namespace = link.license_namespace
          and profile.merged_into is null
        where link.license_namespace = 'test'
          and link.link_type = 'account_identity'
          and link.link_value = $6::text) as exact_account_owner_links,
       (select count(*)::int
        from ${quotedCrm}.sidestream_customer_identity_reviews review
        where review.license_namespace = 'test'
          and review.candidate_profile_id = $1::uuid
          and review.existing_profile_id = $2::uuid
          and review.evidence_type = 'account_identity'
          and review.evidence_trust = 'verified_server'
          and review.attachment_source = 'activation_claim'
          and review.review_state = 'pending_review') as verified_account_reviews,
       (select count(*)::int
        from ${quotedCrm}.sidestream_customer_identity_reviews review
        where review.license_namespace = 'test'
          and review.candidate_profile_id = $1::uuid
          and review.existing_profile_id = $2::uuid
          and review.evidence_type like 'stripe_%'
          and review.evidence_trust = 'verified_server'
          and review.attachment_source = 'activation_claim'
          and review.review_state = 'pending_review') as verified_stripe_reviews`,
    [
      telemetryOwner,
      accountOwner,
      HASHES.currentInstall,
      IDS.activation,
      HASHES.nativeReceipt,
      IDS.account,
    ],
  );
  const stages = await pool.query(
    `select
       count(*) filter (where stage = 'installation_claimed')::int
         as installation_claimed,
       count(*) filter (where stage = 'authentication_completed')::int
         as authentication_completed
     from ${quotedCrm}.sidestream_acquisition_stages
     where acquisition_id = $1::uuid`,
    [IDS.acquisition],
  );
  const telemetry = await pool.query(
    `select
       count(*) filter (where event_name = 'search_submitted')::int as searches,
       count(*) filter (
         where event_name = 'download_attempt_finalized'
           and payload->>'file_delivered' = 'true'
       )::int as successful_downloads
     from ${quotedTelemetry}.sidestream_telemetry_events
     where install_id_hash = $1`,
    [HASHES.currentInstall],
  );
  const convergence = await pool.query(
    `select
       (select count(*)::int
        from ${quotedCrm}.sidestream_paid_telemetry_profile_bindings
        where acquisition_id = $1::uuid) as immutable_bindings,
       (select count(*)::int
        from ${quotedCrm}.sidestream_customer_commerce_materializations
        where license_namespace = 'test') as commerce_facts,
       (select count(*)::int
        from ${quotedCrm}.sidestream_customer_commerce_materializations
        where license_namespace = 'test' and profile_id = $2::uuid)
         as commerce_on_telemetry_profile`,
    [IDS.acquisition, telemetryOwner],
  );

  let lookupResolved = false;
  let lookupOwnsTelemetryProfile = false;
  try {
    const lookup = await customerQuery.queryCustomerLookup({
      licenseNamespace: "test",
      stripeReference: PROVIDER.checkoutSession,
    }, { transaction: readTransaction });
    lookupResolved = Boolean(lookup);
    lookupOwnsTelemetryProfile = lookup?.customerId === telemetryOwner;
  } catch {
    lookupResolved = false;
  }

  let funnelOwnsExactPaidTelemetryProfile = false;
  try {
    const funnel = await acquisitionFunnel.queryAcquisitionFunnel({
      licenseNamespace: "test",
      cohortBasis: "first_install",
      cohortStart: FIXTURE_TIME.cohortStart,
      cohortEnd: FIXTURE_TIME.cohortEnd,
      observationEnd: FIXTURE_TIME.observationEnd,
      journeyLimit: 10,
    }, ADMIN_SECRET, { transaction: readTransaction });
    const journey = funnel.journeys.find((item) => item.customerId === telemetryOwner);
    funnelOwnsExactPaidTelemetryProfile = Boolean(
      journey?.attributionConfidence === "exact_paid_checkout" && journey?.paidCustomer,
    );
  } catch {
    funnelOwnsExactPaidTelemetryProfile = false;
  }

  const shapeRow = shape.rows[0];
  const identityRow = identity.rows[0];
  const stageRow = stages.rows[0];
  const telemetryRow = telemetry.rows[0];
  const convergenceRow = convergence.rows[0];
  return Object.freeze({
    observedContract: "pending-review-account-bridge-repaired",
    acquisitionShape: Object.freeze({
      intactMetaPaidRoots: shapeRow.intact_meta_paid_roots,
      replayedCheckoutIntents: shapeRow.checkout_intents,
      replayedPaidCheckouts: shapeRow.paid_checkouts,
      historicalActivationLinkedClaims: shapeRow.historical_activation_claims,
      activeCurrentClaim: shapeRow.active_current_claim,
    }),
    pendingReviewShape: Object.freeze({
      currentInstallMemberships: identityRow.current_install_memberships,
      currentActivationLinks: identityRow.current_activation_links,
      currentVerifiedReceiptLinks: identityRow.current_receipt_links,
      currentAccountOrStripeLinks: identityRow.current_account_or_stripe_links,
      uniqueExactAccountOwnerLinks: identityRow.exact_account_owner_links,
      verifiedAccountReviews: identityRow.verified_account_reviews,
      verifiedStripeReviews: identityRow.verified_stripe_reviews,
    }),
    stageAndBindingState: Object.freeze({
      installationClaimed: stageRow.installation_claimed,
      authenticationCompleted: stageRow.authentication_completed,
      immutableBindings: convergenceRow.immutable_bindings,
    }),
    anonymousTelemetry: Object.freeze({
      searches: telemetryRow.searches,
      successfulDownloads: telemetryRow.successful_downloads,
      commerceFacts: convergenceRow.commerce_facts,
      commerceOnTelemetryProfile: convergenceRow.commerce_on_telemetry_profile,
      lookupResolved,
      lookupOwnsTelemetryProfile,
      funnelOwnsExactPaidTelemetryProfile,
    }),
    runtimeConvergence: Object.freeze({
      firstOutcome: currentFinalizer.outcome,
      replayOutcome: finalizerReplay.outcome,
    }),
    guardedOperator: Object.freeze({
      beforeReasonCode: guardedDryRun.reasonCode,
      beforeEligible: guardedDryRun.eligible,
      beforeWouldMutate: guardedDryRun.wouldMutate,
      applyProbeReasonCode: guardedApplyProbe.reasonCode,
      afterReasonCode: guardedAfterRuntime.reasonCode,
      afterEligible: guardedAfterRuntime.eligible,
      afterWouldMutate: guardedAfterRuntime.wouldMutate,
    }),
  });
}

function assertPendingReviewRepairedExpectation(summary) {
  const observed =
    summary.observedContract === "pending-review-account-bridge-repaired" &&
    summary.acquisitionShape.intactMetaPaidRoots === 1 &&
    summary.acquisitionShape.replayedCheckoutIntents === 3 &&
    summary.acquisitionShape.replayedPaidCheckouts === 3 &&
    summary.acquisitionShape.historicalActivationLinkedClaims === 2 &&
    summary.acquisitionShape.activeCurrentClaim === 1 &&
    summary.pendingReviewShape.currentInstallMemberships === 1 &&
    summary.pendingReviewShape.currentActivationLinks === 1 &&
    summary.pendingReviewShape.currentVerifiedReceiptLinks === 1 &&
    summary.pendingReviewShape.currentAccountOrStripeLinks >= 4 &&
    summary.pendingReviewShape.uniqueExactAccountOwnerLinks === 1 &&
    summary.pendingReviewShape.verifiedAccountReviews === 1 &&
    summary.pendingReviewShape.verifiedStripeReviews >= 3 &&
    summary.stageAndBindingState.installationClaimed === 1 &&
    summary.stageAndBindingState.authenticationCompleted === 1 &&
    summary.stageAndBindingState.immutableBindings === 1 &&
    summary.anonymousTelemetry.searches === 1 &&
    summary.anonymousTelemetry.successfulDownloads === 1 &&
    summary.anonymousTelemetry.commerceFacts >= 1 &&
    summary.anonymousTelemetry.commerceOnTelemetryProfile >= 1 &&
    summary.anonymousTelemetry.lookupOwnsTelemetryProfile === true &&
    summary.anonymousTelemetry.funnelOwnsExactPaidTelemetryProfile === true &&
    summary.runtimeConvergence.firstOutcome === "installation_claimed_recorded" &&
    summary.runtimeConvergence.replayOutcome === "installation_claimed_recorded" &&
    summary.guardedOperator.beforeReasonCode === "repair_ready" &&
    summary.guardedOperator.beforeEligible === true &&
    summary.guardedOperator.beforeWouldMutate === true &&
    summary.guardedOperator.applyProbeReasonCode === "already_repaired" &&
    summary.guardedOperator.afterReasonCode === "already_repaired" &&
    summary.guardedOperator.afterEligible === true &&
    summary.guardedOperator.afterWouldMutate === false;
  if (!observed) {
    throw new Error(
      `Expected pending-review-repaired paid telemetry handoff contract; observed ${JSON.stringify(summary)}`,
    );
  }
}

async function privacySafeSummary({
  pool,
  quotedCrm,
  quotedTelemetry,
  readTransaction,
  telemetryOwner,
  exactIdentityAttachment,
  usageSummaries,
  commerceResults,
  linkageAttempts,
  negativeFixtures,
}) {
  const exactLookups = await Promise.all([
    PROVIDER.customer,
    PROVIDER.checkoutSession,
    PROVIDER.paymentIntent,
    PROVIDER.charge,
  ].map((stripeReference) => customerQuery.queryCustomerLookup({
    licenseNamespace: "test",
    stripeReference,
  }, { transaction: readTransaction })));
  const checkoutLookup = exactLookups[1];
  const currentDetail = await customerQuery.queryCustomerDetail(
    telemetryOwner,
    { licenseNamespace: "test" },
    { transaction: readTransaction },
  );
  if (!checkoutLookup || !currentDetail || exactLookups.some((lookup) => !lookup)) {
    throw new Error("Customer 360 omitted an exact fixture lookup");
  }

  const funnel = await acquisitionFunnel.queryAcquisitionFunnel({
    licenseNamespace: "test",
    cohortBasis: "first_install",
    cohortStart: FIXTURE_TIME.cohortStart,
    cohortEnd: FIXTURE_TIME.cohortEnd,
    observationEnd: FIXTURE_TIME.observationEnd,
    journeyLimit: 10,
  }, ADMIN_SECRET, { transaction: readTransaction });
  const currentJourney = funnel.journeys.find(
    (journey) => journey.customerId === telemetryOwner,
  );
  if (!currentJourney) throw new Error("Funnel omitted the current-install profile");

  const liveProfiles = await pool.query(
    `select
       count(*) filter (where merged_into is null)::int as live,
       count(*) filter (where merged_into is not null)::int as merged
     from ${quotedCrm}.sidestream_customer_profiles
     where license_namespace = 'test'`,
  );
  const exactPairOwners = await pool.query(
    `select count(distinct profile_id)::int as count
     from ${quotedCrm}.sidestream_customer_identity_links
     where license_namespace = 'test'
       and (
         (link_type = 'install_identity_hash' and link_value = $1)
         or (link_type = 'installer_receipt_hash' and link_value = $2)
       )`,
    [HASHES.currentInstall, HASHES.nativeReceipt],
  );
  const accountLinks = await pool.query(
    `select count(*)::int as count
     from ${quotedCrm}.sidestream_customer_identity_links
     where license_namespace = 'test' and profile_id = $1
       and link_type = 'account_identity'`,
    [telemetryOwner],
  );
  const installMemberships = await pool.query(
    `select
       count(*)::int as total,
       count(*) filter (where install_id_hash = $2)::int as current_install
     from ${quotedCrm}.sidestream_customer_installs
     where license_namespace = 'test' and profile_id = $1`,
    [telemetryOwner, HASHES.currentInstall],
  );
  const rawTelemetry = await pool.query(
    `select
       count(*) filter (where event_name = 'search_submitted')::int as searches,
       count(*) filter (
         where event_name = 'download_attempt_finalized'
           and payload->>'file_delivered' = 'true'
       )::int as successful_downloads
     from ${quotedTelemetry}.sidestream_telemetry_events
     where install_id_hash = $1`,
    [HASHES.currentInstall],
  );
  const stageRows = await pool.query(
    `select stage, count(distinct deduplication_key)::int as count
     from ${quotedCrm}.sidestream_acquisition_stages
     where acquisition_id = $1
     group by stage`,
    [IDS.acquisition],
  );
  const stageCounts = Object.fromEntries(
    stageRows.rows.map((row) => [row.stage, row.count]),
  );
  const currentInstallationKey =
    acquisitionIntegrity.deriveAcquisitionStageDeduplicationKey({
      licenseNamespace: "test",
      stage: "installation_claimed",
      stableServerReference: `installation:${HASHES.currentInstall}`,
    });
  const historicalInstallationKey =
    acquisitionIntegrity.deriveAcquisitionStageDeduplicationKey({
      licenseNamespace: "test",
      stage: "installation_claimed",
      stableServerReference: `installation:${HASHES.historicalInstall}`,
    });
  const installationBindings = await pool.query(
    `select
       count(*) filter (where deduplication_key = $2)::int as current_install,
       count(*) filter (where deduplication_key = $3)::int as historical_install
     from ${quotedCrm}.sidestream_acquisition_stages
     where acquisition_id = $1 and stage = 'installation_claimed'`,
    [IDS.acquisition, currentInstallationKey, historicalInstallationKey],
  );
  const lineageRows = await pool.query(
    `select
       (select count(*)::int
        from ${quotedCrm}.sidestream_paid_telemetry_profile_bindings) as bindings,
       (select count(*)::int
        from ${quotedCrm}.sidestream_customer_profile_merges
        where merge_evidence_type = 'installer_receipt_hash') as merge_audits,
       (select count(*)::int
        from ${quotedCrm}.sidestream_acquisition_conflicts) as ownership_conflicts`,
  );
  const acquisitionRows = await pool.query(
    `select
       count(*)::int as roots,
       count(*) filter (
         where 'verified_installation_claim' = any(trusted_delivery_evidence)
       )::int as verified_installation_claims
     from ${quotedCrm}.sidestream_acquisitions
     where license_namespace = 'test'`,
  );
  const commerceRows = await pool.query(
    `select
       count(*)::int as facts,
       count(*) filter (where identity_conflict)::int as conflicts,
       count(distinct profile_id) filter (
         where profile_id is not null and not identity_conflict
       )::int as owner_profiles
     from ${quotedCrm}.sidestream_customer_commerce_materializations
     where license_namespace = 'test'`,
  );
  const commerceAliases = await pool.query(
    `select count(*)::int as aliases,
       count(distinct payment_key)::int as payment_keys
     from ${quotedCrm}.sidestream_customer_commerce_aliases
     where license_namespace = 'test'`,
  );

  const currentMoneyRows = currentDetail.money.filter(
    (money) => BigInt(money.netPaidMinor) > 0n,
  ).length;
  const currentPaid = currentJourney.paidCustomer === true && currentMoneyRows > 0;
  const currentAttributed = currentJourney.attributionConfidence === "exact_paid_checkout";
  const currentMissing = currentJourney.attributionConfidence === "unattributed" &&
    currentJourney.integrityState === "missing_internal_linkage";
  const funnelStageCounts = Object.fromEntries(
    funnel.stageCounts.map((row) => [row.stage, Number(row.count)]),
  );
  const lookupOwnerCount = new Set(exactLookups.map((lookup) => lookup.customerId)).size;
  const acquisition = checkoutLookup.acquisition;

  return Object.freeze({
    observedContract: checkoutLookup.customerId === telemetryOwner
      ? "repaired-single-profile-handoff"
      : "split-profile-defect",
    profileCounts: Object.freeze({
      live: liveProfiles.rows[0].live,
      merged: liveProfiles.rows[0].merged,
      currentInstallOwners: installMemberships.rows[0].current_install,
      exactCheckoutOwners: lookupOwnerCount,
      exactIdentityPairProfiles: exactPairOwners.rows[0].count,
      splitCheckoutFromCurrentInstall: checkoutLookup.customerId === telemetryOwner ? 0 : 1,
      installMemberships: installMemberships.rows[0].total,
    }),
    stageCounts: Object.freeze({
      landingObserved: stageCounts.landing_observed || 0,
      emailHandoffCreated: stageCounts.email_handoff_created || 0,
      installerRequested: stageCounts.installer_requested || 0,
      checkoutStarted: stageCounts.checkout_started || 0,
      checkoutCompleted: stageCounts.checkout_completed || 0,
      paymentSettled: stageCounts.payment_settled || 0,
      authenticationCompleted: stageCounts.authentication_completed || 0,
      installationClaimed: stageCounts.installation_claimed || 0,
      refunded: stageCounts.refunded || 0,
      disputed: stageCounts.disputed || 0,
    }),
    acquisitionLineage: Object.freeze({
      roots: acquisitionRows.rows[0].roots,
      source: acquisition.source,
      medium: acquisition.medium,
      campaign: acquisition.campaign,
      content: acquisition.creative,
      experiment: acquisition.experiment,
      cohort: acquisition.cohort,
      integrityState: acquisition.integrityState,
      verifiedInstallationClaimEvidence:
        acquisitionRows.rows[0].verified_installation_claims,
      expectedStagesExactlyOnce: EXPECTED_JOURNEY_STAGES.every(
        (stage) => stageCounts[stage] === 1 && funnelStageCounts[stage] === 1,
      ),
      ownershipConflicts: lineageRows.rows[0].ownership_conflicts,
    }),
    installationBindingCounts: Object.freeze({
      currentInstall: installationBindings.rows[0].current_install,
      historicalInstall: installationBindings.rows[0].historical_install,
    }),
    telemetryCounts: Object.freeze({
      searches: rawTelemetry.rows[0].searches,
      successfulDownloads: rawTelemetry.rows[0].successful_downloads,
      usageSyncRuns: usageSummaries.length,
      sourceRowsScanned: usageSummaries.map((summary) => summary.sourceRowsScanned),
      dailyBucketsWritten: usageSummaries.map((summary) => summary.dailyBucketsWritten),
      usageProfilesRefreshed: Math.max(
        ...usageSummaries.map((summary) => summary.profilesRefreshed),
      ),
      currentProfileSuccessfulDownloads:
        Number(currentDetail.usage.downloadOutcomeNumerator || 0),
      funnelDayZeroDownloadAttempts: Number(currentJourney.dayZeroDownloadAttempts),
    }),
    commerceLineage: Object.freeze({
      exactLookups: exactLookups.length,
      exactLookupOwnerProfiles: lookupOwnerCount,
      facts: commerceRows.rows[0].facts,
      aliases: commerceAliases.rows[0].aliases,
      paymentKeys: commerceAliases.rows[0].payment_keys,
      ownerProfiles: commerceRows.rows[0].owner_profiles,
      conflicts: commerceRows.rows[0].conflicts,
      observationsApplied: commerceResults.reduce(
        (total, result) => total + result.applied, 0,
      ),
      staleReplays: commerceResults.reduce(
        (total, result) => total + result.stale, 0,
      ),
    }),
    funnelCoverage: Object.freeze({
      exactPaidCheckout: `${funnel.coverage.exactPaidCheckout.numerator}/${funnel.coverage.exactPaidCheckout.denominator}`,
      attributed: `${funnel.coverage.attributed.numerator}/${funnel.coverage.attributed.denominator}`,
      unknown: `${funnel.coverage.unknown.numerator}/${funnel.coverage.unknown.denominator}`,
      paidCustomer: currentJourney.paidCustomer,
      integrityState: currentJourney.integrityState,
    }),
    paidActivation: Object.freeze({
      outcome: linkageAttempts[0].outcome,
      successfulReplayAttempts: linkageAttempts.filter(
        (attempt) => attempt.outcome === "installation_claimed_recorded",
      ).length,
      immutableBindings: lineageRows.rows[0].bindings,
      mergeAudits: lineageRows.rows[0].merge_audits,
      exactIdentityReviewRequired: exactIdentityAttachment.reviewRequired === true,
      commerceObservationsApplied: commerceResults.reduce(
        (total, result) => total + result.applied, 0,
      ),
    }),
    customer360CurrentInstallCounts: Object.freeze({
      knownAccount: accountLinks.rows[0].count > 0 ? 1 : 0,
      paid: currentPaid ? 1 : 0,
      exactPaidAttribution: currentAttributed ? 1 : 0,
      unattributedMissingInternalLinkage: currentMissing ? 1 : 0,
    }),
    negativeFixtures,
  });
}

function assertExpectation(summary, expectation) {
  const common = summary.paidActivation.outcome === "installation_claimed_recorded" &&
    summary.paidActivation.successfulReplayAttempts === 4 &&
    summary.stageCounts.landingObserved === 1 &&
    summary.stageCounts.emailHandoffCreated === 1 &&
    summary.stageCounts.installerRequested === 1 &&
    summary.stageCounts.checkoutStarted === 1 &&
    summary.stageCounts.checkoutCompleted === 1 &&
    summary.stageCounts.paymentSettled === 1 &&
    summary.stageCounts.installationClaimed === 1 &&
    summary.stageCounts.refunded === 0 &&
    summary.stageCounts.disputed === 0 &&
    summary.telemetryCounts.searches === 2 &&
    summary.telemetryCounts.successfulDownloads === 2 &&
    summary.telemetryCounts.currentProfileSuccessfulDownloads === 2 &&
    summary.telemetryCounts.funnelDayZeroDownloadAttempts === 2 &&
    summary.paidActivation.commerceObservationsApplied === 2;
  const broken = common &&
    summary.observedContract === "split-profile-defect" &&
    summary.profileCounts.splitCheckoutFromCurrentInstall === 1 &&
    summary.profileCounts.exactIdentityPairProfiles === 2 &&
    summary.stageCounts.authenticationCompleted === 0 &&
    summary.installationBindingCounts.currentInstall === 0 &&
    summary.installationBindingCounts.historicalInstall === 1 &&
    summary.customer360CurrentInstallCounts.knownAccount === 0 &&
    summary.customer360CurrentInstallCounts.paid === 0 &&
    summary.customer360CurrentInstallCounts.exactPaidAttribution === 0 &&
    summary.customer360CurrentInstallCounts.unattributedMissingInternalLinkage === 1;
  const repaired = common &&
    summary.observedContract === "repaired-single-profile-handoff" &&
    summary.profileCounts.live === 1 &&
    summary.profileCounts.merged === 1 &&
    summary.profileCounts.splitCheckoutFromCurrentInstall === 0 &&
    summary.profileCounts.exactIdentityPairProfiles === 1 &&
    summary.profileCounts.installMemberships === 2 &&
    summary.profileCounts.currentInstallOwners === 1 &&
    summary.profileCounts.exactCheckoutOwners === 1 &&
    summary.paidActivation.immutableBindings === 1 &&
    summary.paidActivation.mergeAudits === 1 &&
    summary.stageCounts.authenticationCompleted === 1 &&
    summary.installationBindingCounts.currentInstall === 1 &&
    summary.installationBindingCounts.historicalInstall === 0 &&
    summary.customer360CurrentInstallCounts.knownAccount === 1 &&
    summary.customer360CurrentInstallCounts.paid === 1 &&
    summary.customer360CurrentInstallCounts.exactPaidAttribution === 1 &&
    summary.customer360CurrentInstallCounts.unattributedMissingInternalLinkage === 0 &&
    summary.acquisitionLineage.roots === 1 &&
    summary.acquisitionLineage.source === "meta" &&
    summary.acquisitionLineage.medium === "social" &&
    summary.acquisitionLineage.campaign === "sidestream_direct_offer_test" &&
    summary.acquisitionLineage.content === "paid" &&
    summary.acquisitionLineage.experiment === "meta-direct-links-v1" &&
    summary.acquisitionLineage.cohort === "paid" &&
    summary.acquisitionLineage.integrityState === "intact" &&
    summary.acquisitionLineage.verifiedInstallationClaimEvidence === 1 &&
    summary.acquisitionLineage.expectedStagesExactlyOnce === true &&
    summary.acquisitionLineage.ownershipConflicts === 0 &&
    summary.commerceLineage.exactLookups === 4 &&
    summary.commerceLineage.exactLookupOwnerProfiles === 1 &&
    summary.commerceLineage.facts === 2 &&
    summary.commerceLineage.aliases === 3 &&
    summary.commerceLineage.paymentKeys === 1 &&
    summary.commerceLineage.ownerProfiles === 1 &&
    summary.commerceLineage.conflicts === 0 &&
    summary.commerceLineage.observationsApplied === 2 &&
    summary.commerceLineage.staleReplays === 3 &&
    summary.funnelCoverage.exactPaidCheckout === "1/1" &&
    summary.funnelCoverage.attributed === "1/1" &&
    summary.funnelCoverage.unknown === "0/1" &&
    summary.funnelCoverage.paidCustomer === true &&
    summary.funnelCoverage.integrityState === "intact" &&
    Object.values(summary.negativeFixtures).every((passed) => passed === true);
  const observed = expectation === "broken" ? broken : repaired;
  if (!observed) {
    throw new Error(
      `Expected ${expectation} paid telemetry handoff contract; observed ${JSON.stringify(summary)}`,
    );
  }
}

async function installOwner(pool, schema, installIdHash) {
  const result = await pool.query(
    `select profile_id
     from ${schema}.sidestream_customer_installs
     where license_namespace = 'test' and install_id_hash = $1`,
    [installIdHash],
  );
  return result.rows[0]?.profile_id || null;
}

function schemaQuery(pool, quotedSchema) {
  return (sql, params = []) => pool.query(
    sql.replace(/\bpublic\./g, `${quotedSchema}.`),
    [...params],
  );
}

function schemaTransaction(pool, quotedSchema, { readOnly = false } = {}) {
  return async (callback) => {
    const client = await pool.connect();
    try {
      await client.query(readOnly
        ? "begin isolation level repeatable read read only"
        : "begin isolation level read committed");
      const result = await callback({
        query: (sql, params = []) => client.query(
          sql.replace(/\bpublic\./g, `${quotedSchema}.`),
          [...params],
        ),
      });
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };
}

function rewritePublicSchema(source, schema) {
  return source.replace(/\bpublic\./g, `${quoteIdentifier(schema)}.`);
}

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
    throw new TypeError("Unsafe fixture schema identifier");
  }
  return `"${identifier}"`;
}

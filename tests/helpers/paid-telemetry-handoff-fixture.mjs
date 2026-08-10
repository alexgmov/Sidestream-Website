import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

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

const HASHES = Object.freeze({
  currentInstall: "a".repeat(64),
  historicalInstall: "b".repeat(64),
  nativeReceipt: "c".repeat(64),
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
  syncNow: "2026-08-09T12:00:00.000Z",
  cohortStart: "2026-08-08T00:00:00.000Z",
  cohortEnd: "2026-08-10T00:00:00.000Z",
  observationEnd: "2026-08-11T00:00:00.000Z",
  expiry: "2030-01-01T00:00:00.000Z",
});

const ADMIN_SECRET = "fixture-paid-telemetry-handoff-cursor-secret";
const RECEIPT_SECRET = "fixture-paid-telemetry-handoff-receipt-secret";

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
  if (expectation !== "repaired" && expectation !== "broken") {
    throw new TypeError("Paid telemetry handoff expectation must be repaired or broken");
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

    const commerceResult = await customerCommerce.materializeCustomerCommerceEvent(
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

    const summary = await privacySafeSummary({
      pool,
      quotedCrm,
      quotedTelemetry,
      readTransaction,
      telemetryOwner,
      exactIdentityAttachment,
      usageSummary,
      commerceResult,
      linkageAttempts,
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

async function seedTelemetry(pool, schema) {
  const events = [
    ["telemetry-session", "session_started", "app", "app", {}, {
      runtime: { osPlatform: "macos" },
    }],
    ["telemetry-search", "search_submitted", "search", "app", {}, {}],
    ["telemetry-download-request", "download_requested", "download", "download", {
      download_id: "download-fixture-paid-handoff",
      download_trigger: "result_row",
    }, {}],
    ["telemetry-download-success", "download_attempt_finalized", "download", "download", {
      download_id: "download-fixture-paid-handoff",
      file_delivered: true,
      user_outcome: "got_file",
      import_result: "success",
    }, {}],
  ];
  for (const [index, [id, eventName, category, scope, payload, dataPoints]] of events.entries()) {
    const occurredAt = new Date(
      Date.parse(FIXTURE_TIME.telemetryStarted) + index * 30_000,
    ).toISOString();
    const receivedAt = new Date(
      Date.parse(FIXTURE_TIME.telemetryReceived) + index * 30_000,
    ).toISOString();
    await pool.query(
      `insert into ${schema}.sidestream_telemetry_events (
         telemetry_event_id, install_id_hash, session_id, sequence, event_name,
         event_category, event_scope, occurred_at, received_at, app_version,
         build_channel, schema_version, payload, data_points
       ) values ($1, $2, 'session-fixture-paid-handoff', $3, $4, $5, $6,
         $7, $8, '1.0.18', 'test', '0.2.0', $9::jsonb, $10::jsonb)`,
      [
        id,
        HASHES.currentInstall,
        index + 1,
        eventName,
        category,
        scope,
        occurredAt,
        receivedAt,
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

async function privacySafeSummary({
  pool,
  quotedCrm,
  quotedTelemetry,
  readTransaction,
  telemetryOwner,
  exactIdentityAttachment,
  usageSummary,
  commerceResult,
  linkageAttempts,
}) {
  const checkoutLookup = await customerQuery.queryCustomerLookup({
    licenseNamespace: "test",
    stripeReference: PROVIDER.checkoutSession,
  }, { transaction: readTransaction });
  const currentDetail = await customerQuery.queryCustomerDetail(
    telemetryOwner,
    { licenseNamespace: "test" },
    { transaction: readTransaction },
  );
  if (!checkoutLookup || !currentDetail) {
    throw new Error("Customer 360 did not return both fixture profiles");
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
    `select count(*)::int as count
     from ${quotedCrm}.sidestream_customer_profiles
     where license_namespace = 'test' and merged_into is null`,
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
        where merge_evidence_type = 'installer_receipt_hash') as merge_audits`,
  );

  const currentMoneyRows = currentDetail.money.filter(
    (money) => BigInt(money.netPaidMinor) > 0n,
  ).length;
  const currentPaid = currentJourney.paidCustomer === true && currentMoneyRows > 0;
  const currentAttributed = currentJourney.attributionConfidence === "exact_paid_checkout";
  const currentMissing = currentJourney.attributionConfidence === "unattributed" &&
    currentJourney.integrityState === "missing_internal_linkage";

  return Object.freeze({
    observedContract: checkoutLookup.customerId === telemetryOwner
      ? "repaired-single-profile-handoff"
      : "split-profile-defect",
    profileCounts: Object.freeze({
      live: liveProfiles.rows[0].count,
      currentInstallOwners: 1,
      exactCheckoutOwners: 1,
      exactIdentityPairProfiles: exactPairOwners.rows[0].count,
      splitCheckoutFromCurrentInstall: checkoutLookup.customerId === telemetryOwner ? 0 : 1,
    }),
    stageCounts: Object.freeze({
      landingObserved: stageCounts.landing_observed || 0,
      checkoutStarted: stageCounts.checkout_started || 0,
      checkoutCompleted: stageCounts.checkout_completed || 0,
      paymentSettled: stageCounts.payment_settled || 0,
      authenticationCompleted: stageCounts.authentication_completed || 0,
      installationClaimed: stageCounts.installation_claimed || 0,
    }),
    installationBindingCounts: Object.freeze({
      currentInstall: installationBindings.rows[0].current_install,
      historicalInstall: installationBindings.rows[0].historical_install,
    }),
    telemetryCounts: Object.freeze({
      searches: rawTelemetry.rows[0].searches,
      successfulDownloads: rawTelemetry.rows[0].successful_downloads,
      usageProfilesRefreshed: usageSummary.profilesRefreshed,
      currentProfileSuccessfulDownloads:
        Number(currentDetail.usage.downloadOutcomeNumerator || 0),
    }),
    paidActivation: Object.freeze({
      outcome: linkageAttempts[0].outcome,
      successfulReplayAttempts: linkageAttempts.filter(
        (attempt) => attempt.outcome === "installation_claimed_recorded",
      ).length,
      immutableBindings: lineageRows.rows[0].bindings,
      mergeAudits: lineageRows.rows[0].merge_audits,
      exactIdentityReviewRequired: exactIdentityAttachment.reviewRequired === true,
      commerceObservationsApplied: commerceResult.applied,
    }),
    customer360CurrentInstallCounts: Object.freeze({
      knownAccount: accountLinks.rows[0].count > 0 ? 1 : 0,
      paid: currentPaid ? 1 : 0,
      exactPaidAttribution: currentAttributed ? 1 : 0,
      unattributedMissingInternalLinkage: currentMissing ? 1 : 0,
    }),
  });
}

function assertExpectation(summary, expectation) {
  const common = summary.paidActivation.outcome === "installation_claimed_recorded" &&
    summary.paidActivation.successfulReplayAttempts === 2 &&
    summary.stageCounts.checkoutStarted === 1 &&
    summary.stageCounts.checkoutCompleted === 1 &&
    summary.stageCounts.paymentSettled === 1 &&
    summary.stageCounts.installationClaimed === 1 &&
    summary.telemetryCounts.searches === 1 &&
    summary.telemetryCounts.successfulDownloads === 1 &&
    summary.telemetryCounts.currentProfileSuccessfulDownloads === 1 &&
    summary.paidActivation.commerceObservationsApplied === 1;
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
    summary.profileCounts.splitCheckoutFromCurrentInstall === 0 &&
    summary.profileCounts.exactIdentityPairProfiles === 1 &&
    summary.paidActivation.immutableBindings === 1 &&
    summary.paidActivation.mergeAudits === 1 &&
    summary.stageCounts.authenticationCompleted === 1 &&
    summary.installationBindingCounts.currentInstall === 1 &&
    summary.installationBindingCounts.historicalInstall === 0 &&
    summary.customer360CurrentInstallCounts.knownAccount === 1 &&
    summary.customer360CurrentInstallCounts.paid === 1 &&
    summary.customer360CurrentInstallCounts.exactPaidAttribution === 1 &&
    summary.customer360CurrentInstallCounts.unattributedMissingInternalLinkage === 0;
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

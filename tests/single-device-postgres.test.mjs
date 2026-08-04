import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";
import {
  getConfirmedDeviceMoveTimestamps,
  getDeviceTransferLimitOverride,
} from "../api/_lib/device-policy.ts";
import { verifyPaidCheckoutSession } from "../api/_lib/entitlement.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = join(repositoryRoot, "db", "migrations");
const accountSourcePath = join(repositoryRoot, "api", "_lib", "account.ts");
const TEST_DATABASE_ENV = "SIDESTREAM_TEST_POSTGRES_URL";
const RUNTIME_DATABASE_ENV_NAMES = [
  "SIDESTREAM_POSTGRES_URL",
  "SIDESTREAM_POSTGRES_PRISMA_URL",
  "SIDESTREAM_POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
];
const CONTROLLED_ENV_NAMES = [
  TEST_DATABASE_ENV,
  ...RUNTIME_DATABASE_ENV_NAMES,
  "SIDESTREAM_LICENSE_NAMESPACE",
  "SIDESTREAM_PRODUCTION_API_HOSTS",
  "SIDESTREAM_TEST_API_HOSTS",
  "VERCEL_ENV",
  "POSTGRES_POOL_MAX",
  "SIDESTREAM_LICENSE_HASH_SECRET",
  "SIDESTREAM_DEVICE_POLICY_MODE",
  "SIDESTREAM_LEGACY_SUBSCRIPTION_PRICE_IDS",
  "SIDESTREAM_LEGACY_SUBSCRIPTION_PRODUCT_IDS",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "VERCEL_OIDC_TOKEN",
  "BLOB_READ_WRITE_TOKEN",
];
const TEST_SECRET = "sidestream-single-device-postgres-integration";
const DAY_MS = 24 * 60 * 60 * 1000;
const SINGLE_DEVICE_BASELINE_TABLES = [
  "sidestream_account_devices",
  "sidestream_account_sessions",
  "sidestream_accounts",
  "sidestream_activation_sessions",
  "sidestream_api_rate_limits",
  "sidestream_billing_resources",
  "sidestream_checkout_intents",
  "sidestream_device_transfers",
  "sidestream_download_lead_idempotency",
  "sidestream_download_lead_replay_receipts",
  "sidestream_download_leads",
  "sidestream_installer_requests",
  "sidestream_license_tokens",
  "sidestream_licenses",
  "sidestream_schema_migrations",
  "sidestream_stripe_events",
];

test("single-device entitlement transactions hold in disposable Postgres", {
  timeout: 120_000,
}, async (t) => {
  const testDatabaseUrl = requireSafeTestDatabaseUrl(process.env);
  const schema = `sidestream_it_${randomBytes(10).toString("hex")}`;
  const quotedSchema = quoteIdentifier(schema);
  const environmentSnapshot = snapshotEnvironment(CONTROLLED_ENV_NAMES);
  const originalFetch = globalThis.fetch;
  const networkAttempts = [];
  let databasePool;
  let accountModule;
  let temporaryModuleDirectory = "";

  try {
    databasePool = new Pool(createPoolOptions(testDatabaseUrl));
    await databasePool.query(`create schema ${quotedSchema}`);
    const migrations = await applyFullMigrationChain(databasePool, schema);

    configureRuntimeForDisposableDatabase(testDatabaseUrl);
    globalThis.fetch = async (input) => {
      networkAttempts.push(String(input));
      throw new Error("External network access is forbidden in the Postgres integration harness");
    };
    ({ accountModule, temporaryModuleDirectory } = await loadAccountModuleForSchema(schema));

    const production = licenseEnvironment("production", testDatabaseUrl);
    const testNamespace = licenseEnvironment("test", testDatabaseUrl);

    await t.test("the full migration chain is isolated and RLS protected", async () => {
      const expectedMigrations = (await readdir(migrationsDirectory))
        .filter((name) => name.endsWith(".sql"))
        .sort();
      assert.deepEqual(migrations, expectedMigrations);

      const tables = await databasePool.query(
        `select table_name from information_schema.tables where table_schema = $1 order by table_name`,
        [schema],
      );
      const tableNames = tables.rows.map((row) => row.table_name);
      for (const tableName of SINGLE_DEVICE_BASELINE_TABLES) {
        assert.ok(tableNames.includes(tableName), `missing single-device baseline table ${tableName}`);
      }

      const rls = await databasePool.query(
        `
          select relname, relrowsecurity
          from pg_class
          join pg_namespace on pg_namespace.oid = pg_class.relnamespace
          where nspname = $1 and relkind = 'r'
          order by relname
        `,
        [schema],
      );
      assert.deepEqual(rls.rows.map((row) => row.relname), tableNames);
      assert.equal(rls.rows.every((row) => row.relrowsecurity), true);
    });

    await t.test("the harness rejects every matching runtime database target", () => {
      for (const name of RUNTIME_DATABASE_ENV_NAMES) {
        assert.throws(
          () => requireSafeTestDatabaseUrl({
            [TEST_DATABASE_ENV]: testDatabaseUrl,
            [name]: addHarmlessConnectionOption(testDatabaseUrl),
          }),
          new RegExp(name),
        );
      }
    });

    await t.test("active slots permit two devices and reject a third concurrent seat", async () => {
      const fixture = await seedAccount(databasePool, schema);
      const devices = [
        { hash: privateIdentifierHash("db-race-a"), slot: 1 },
        { hash: privateIdentifierHash("db-race-b"), slot: 2 },
        { hash: privateIdentifierHash("db-race-c"), slot: 2 },
      ];
      const inserts = await Promise.allSettled(devices.map((device) =>
        databasePool.query(
          `
            insert into ${quotedSchema}.sidestream_account_devices (
              account_id, license_namespace, device_id_hash, platform, active_slot
            ) values ($1, 'production', $2, 'unknown', $3)
          `,
          [fixture.accountId, device.hash, device.slot],
        )
      ));
      assert.equal(inserts.filter((result) => result.status === "fulfilled").length, 2);
      const rejected = inserts.find((result) => result.status === "rejected");
      assert.equal(rejected?.reason?.code, "23505");

      await databasePool.query(
        `
          insert into ${quotedSchema}.sidestream_account_devices (
            account_id, license_namespace, device_id_hash, platform
          ) values ($1, 'test', $2, 'unknown')
        `,
        [fixture.accountId, privateIdentifierHash("db-race-test")],
      );
      const active = await databasePool.query(
        `
          select license_namespace, count(*)::int as count
          from ${quotedSchema}.sidestream_account_devices
          where account_id = $1 and revoked_at is null
          group by license_namespace
          order by license_namespace
        `,
        [fixture.accountId],
      );
      assert.deepEqual(active.rows, [
        { license_namespace: "production", count: 2 },
        { license_namespace: "test", count: 1 },
      ]);
    });

    await t.test("CRM identity on account paths cannot change device or entitlement decisions", async () => {
      const anchor = await seedAccount(databasePool, schema);
      const anchorActivation = await seedActivation(databasePool, schema, anchor, {
        deviceId: "identity-anchor-device",
        appVersion: "1.0.14",
      });
      const conflictingInstallHashes = ["a", "b", "c", "d"].map((value) =>
        value.repeat(64)
      );
      for (const installIdHash of conflictingInstallHashes) {
        assert.deepEqual(
          await accountModule.claimActivationToAccount(
            anchorActivation.activationKey,
            anchor.accountId,
            { environment: production, identity: { installIdHash } },
          ),
          { claimed: true },
        );
      }

      const fixture = await seedAccount(databasePool, schema, {
        features: { identityProofPolicy: "must-remain-unchanged" },
      });
      const activation = await seedActivation(databasePool, schema, fixture, {
        deviceId: "identity-proof-device",
        appVersion: "1.0.14",
      });
      const associatedInstallHashes = ["5", "6", "7", "8"].map((value) =>
        value.repeat(64)
      );

      const claimWithoutIdentity = await accountModule.claimActivationToAccount(
        activation.activationKey,
        fixture.accountId,
        { environment: production },
      );
      const claimProtectedState = await snapshotIdentityProtectedState(
        databasePool,
        schema,
        fixture.accountId,
        activation.activationId,
      );
      const claimWithIdentity = await accountModule.claimActivationToAccount(
        activation.activationKey,
        fixture.accountId,
        {
          environment: production,
          identity: { installIdHash: associatedInstallHashes[0] },
        },
      );
      assert.deepEqual(claimWithIdentity, claimWithoutIdentity);
      assert.deepEqual(
        await snapshotIdentityProtectedState(
          databasePool,
          schema,
          fixture.accountId,
          activation.activationId,
        ),
        claimProtectedState,
      );
      let reviewCount = await customerIdentityReviewCount(databasePool, schema);
      let identityState = await snapshotCustomerIdentityState(databasePool, schema);
      const claimWithConflict = await accountModule.claimActivationToAccount(
        activation.activationKey,
        fixture.accountId,
        {
          environment: production,
          identity: { installIdHash: conflictingInstallHashes[0] },
        },
      );
      assert.deepEqual(claimWithConflict, claimWithoutIdentity);
      assert.deepEqual(
        await snapshotIdentityProtectedState(
          databasePool,
          schema,
          fixture.accountId,
          activation.activationId,
        ),
        claimProtectedState,
      );
      assert.deepEqual(
        await snapshotCustomerIdentityState(databasePool, schema),
        identityState,
      );
      assert.equal(await customerIdentityReviewCount(databasePool, schema), ++reviewCount);

      const statusWithoutIdentity = await accountModule.getActivationStatus(
        activation.activationKey,
        "identity-proof-device",
        { skipReconciliation: true, environment: production, platform: "macos" },
      );
      assert.equal(statusWithoutIdentity.status, "active");
      const statusProtectedState = await snapshotIdentityProtectedState(
        databasePool,
        schema,
        fixture.accountId,
        activation.activationId,
      );
      const statusWithIdentity = await accountModule.getActivationStatus(
        activation.activationKey,
        "identity-proof-device",
        {
          skipReconciliation: true,
          environment: production,
          platform: "macos",
          identity: { installIdHash: associatedInstallHashes[1] },
        },
      );
      assert.deepEqual(statusWithIdentity, statusWithoutIdentity);
      assert.deepEqual(
        await snapshotIdentityProtectedState(
          databasePool,
          schema,
          fixture.accountId,
          activation.activationId,
        ),
        statusProtectedState,
      );
      identityState = await snapshotCustomerIdentityState(databasePool, schema);
      const statusWithConflict = await accountModule.getActivationStatus(
        activation.activationKey,
        "identity-proof-device",
        {
          skipReconciliation: true,
          environment: production,
          platform: "macos",
          identity: { installIdHash: conflictingInstallHashes[1] },
        },
      );
      assert.deepEqual(statusWithConflict, statusWithoutIdentity);
      assert.deepEqual(
        await snapshotIdentityProtectedState(
          databasePool,
          schema,
          fixture.accountId,
          activation.activationId,
        ),
        statusProtectedState,
      );
      assert.deepEqual(
        await snapshotCustomerIdentityState(databasePool, schema),
        identityState,
      );
      assert.equal(await customerIdentityReviewCount(databasePool, schema), ++reviewCount);

      const verifyWithoutIdentity = await accountModule.verifyLicenseToken(
        statusWithoutIdentity.licenseToken,
        "identity-proof-device",
        production,
      );
      const verifyProtectedState = await snapshotIdentityProtectedState(
        databasePool,
        schema,
        fixture.accountId,
        activation.activationId,
      );
      const verifyWithIdentity = await accountModule.verifyLicenseToken(
        statusWithoutIdentity.licenseToken,
        "identity-proof-device",
        production,
        { installIdHash: associatedInstallHashes[2] },
      );
      assert.deepEqual(verifyWithIdentity, verifyWithoutIdentity);
      assert.deepEqual(
        await snapshotIdentityProtectedState(
          databasePool,
          schema,
          fixture.accountId,
          activation.activationId,
        ),
        verifyProtectedState,
      );
      identityState = await snapshotCustomerIdentityState(databasePool, schema);
      const verifyWithConflict = await accountModule.verifyLicenseToken(
        statusWithoutIdentity.licenseToken,
        "identity-proof-device",
        production,
        { installIdHash: conflictingInstallHashes[2] },
      );
      assert.deepEqual(verifyWithConflict, verifyWithoutIdentity);
      assert.deepEqual(
        await snapshotIdentityProtectedState(
          databasePool,
          schema,
          fixture.accountId,
          activation.activationId,
        ),
        verifyProtectedState,
      );
      assert.deepEqual(
        await snapshotCustomerIdentityState(databasePool, schema),
        identityState,
      );
      assert.equal(await customerIdentityReviewCount(databasePool, schema), ++reviewCount);

      const refreshWithoutIdentity = await accountModule.refreshLicenseToken(
        statusWithoutIdentity.refreshToken,
        "identity-proof-device",
        production,
      );
      const refreshProtectedState = await snapshotIdentityProtectedState(
        databasePool,
        schema,
        fixture.accountId,
        activation.activationId,
      );
      const refreshWithIdentity = await accountModule.refreshLicenseToken(
        statusWithoutIdentity.refreshToken,
        "identity-proof-device",
        production,
        { installIdHash: associatedInstallHashes[3] },
      );
      assert.deepEqual(refreshWithIdentity, refreshWithoutIdentity);
      assert.deepEqual(
        await snapshotIdentityProtectedState(
          databasePool,
          schema,
          fixture.accountId,
          activation.activationId,
        ),
        refreshProtectedState,
      );
      identityState = await snapshotCustomerIdentityState(databasePool, schema);
      const refreshWithConflict = await accountModule.refreshLicenseToken(
        statusWithoutIdentity.refreshToken,
        "identity-proof-device",
        production,
        { installIdHash: conflictingInstallHashes[3] },
      );
      assert.deepEqual(refreshWithConflict, refreshWithoutIdentity);
      assert.deepEqual(
        await snapshotIdentityProtectedState(
          databasePool,
          schema,
          fixture.accountId,
          activation.activationId,
        ),
        refreshProtectedState,
      );
      assert.deepEqual(
        await snapshotCustomerIdentityState(databasePool, schema),
        identityState,
      );
      assert.equal(await customerIdentityReviewCount(databasePool, schema), ++reviewCount);

      const reviews = await databasePool.query(
        `
          select attachment_source, evidence_type, evidence_trust, review_state
          from ${quotedSchema}.sidestream_customer_identity_reviews
          order by attachment_source
        `,
      );
      assert.deepEqual(reviews.rows, [
        {
          attachment_source: "activation_claim",
          evidence_type: "install_identity_hash",
          evidence_trust: "client_association",
          review_state: "pending_review",
        },
        {
          attachment_source: "activation_status",
          evidence_type: "install_identity_hash",
          evidence_trust: "client_association",
          review_state: "pending_review",
        },
        {
          attachment_source: "license_refresh",
          evidence_type: "install_identity_hash",
          evidence_trust: "client_association",
          review_state: "pending_review",
        },
        {
          attachment_source: "license_verify",
          evidence_type: "install_identity_hash",
          evidence_trust: "client_association",
          review_state: "pending_review",
        },
      ]);
    });

    let primaryFixture;
    let initialCredentials;
    await t.test("concurrent status polling makes one idempotent initial claim", async () => {
      primaryFixture = await seedAccount(databasePool, schema, {
        activeUpdatedAt: new Date(Date.now() - DAY_MS),
      });
      await seedLicense(databasePool, schema, primaryFixture.accountId, {
        status: "canceled",
        updatedAt: new Date(),
      });
      const activation = await seedActivation(databasePool, schema, primaryFixture, {
        deviceId: "primary-a",
        appVersion: "1.0.14",
      });

      const results = await Promise.all([
        accountModule.getActivationStatus(activation.activationKey, "primary-a", {
          skipReconciliation: true,
          environment: production,
          platform: "macos",
        }),
        accountModule.getActivationStatus(activation.activationKey, "primary-a", {
          skipReconciliation: true,
          environment: production,
          platform: "macos",
        }),
      ]);
      assert.equal(results.every((result) => result.status === "active"), true);
      assert.equal(results[0].license.status, "active");
      assert.equal(results[0].licenseToken, results[1].licenseToken);
      assert.equal(results[0].refreshToken, results[1].refreshToken);
      initialCredentials = results[0];

      const counts = await databasePool.query(
        `
          select
            (select count(*)::int from ${quotedSchema}.sidestream_account_devices
              where account_id = $1 and license_namespace = 'production' and revoked_at is null)
              as active_devices,
            (select count(*)::int from ${quotedSchema}.sidestream_license_tokens
              where account_id = $1) as token_families
        `,
        [primaryFixture.accountId],
      );
      assert.deepEqual(counts.rows[0], { active_devices: 1, token_families: 1 });

      const replay = await accountModule.getActivationStatus(
        activation.activationKey,
        "primary-a",
        { skipReconciliation: true, environment: production, platform: "macos" },
      );
      assert.equal(replay.status, "active");
      assert.equal(replay.licenseToken, initialCredentials.licenseToken);
      assert.equal(replay.refreshToken, initialCredentials.refreshToken);
      primaryFixture.activation = activation;
    });

    await t.test("second device is active while a third in enforce mode requires transfer", async () => {
      const fixture = await seedAccount(databasePool, schema);
      const first = await seedActivation(databasePool, schema, fixture, {
        deviceId: "observe-a",
        appVersion: "1.0.14",
      });
      const claimed = await accountModule.getActivationStatus(first.activationKey, "observe-a", {
        skipReconciliation: true,
        environment: production,
      });
      assert.equal(claimed.status, "active");

      const observedActivation = await seedActivation(databasePool, schema, fixture, {
        deviceId: "observe-b",
        appVersion: "1.0.14",
      });
      const warnings = [];
      const originalWarn = console.warn;
      process.env.SIDESTREAM_DEVICE_POLICY_MODE = "observe";
      console.warn = (...values) => warnings.push(values);
      let observed;
      try {
        observed = await accountModule.getActivationStatus(
          observedActivation.activationKey,
          "observe-b",
          { skipReconciliation: true, environment: production },
        );
      } finally {
        console.warn = originalWarn;
        process.env.SIDESTREAM_DEVICE_POLICY_MODE = "enforce";
      }
      assert.equal(observed.status, "active");
      assert.equal(warnings.length, 0);

      const active = await databasePool.query(
        `
          select device_id_hash
          from ${quotedSchema}.sidestream_account_devices
          where account_id = $1
            and license_namespace = 'production'
            and revoked_at is null
          order by active_slot
        `,
        [fixture.accountId],
      );
      assert.deepEqual(
        active.rows.map((row) => row.device_id_hash),
        [privateIdentifierHash("observe-a"), privateIdentifierHash("observe-b")],
      );
      assert.deepEqual(
        await accountModule.authorizeLicenseDownload({
          licenseToken: observed.licenseToken,
          deviceId: "observe-b",
          environment: production,
        }),
        { active: true },
      );

      const enforcedActivation = await seedActivation(databasePool, schema, fixture, {
        deviceId: "observe-c",
        appVersion: "1.0.14",
      });
      const enforced = await accountModule.getActivationStatus(
        enforcedActivation.activationKey,
        "observe-c",
        { skipReconciliation: true, environment: production },
      );
      assert.equal(enforced.status, "transfer_required");
      assert.equal(enforced.code, "transfer_required");
      assert.equal(enforced.licenseToken, undefined);
    });

    let rotatedCredentials;
    await t.test("lost-response refresh replay returns one rotated family", async () => {
      const refreshes = await Promise.all([
        accountModule.refreshLicenseToken(
          initialCredentials.refreshToken,
          "primary-a",
          production,
        ),
        accountModule.refreshLicenseToken(
          initialCredentials.refreshToken,
          "primary-a",
          production,
        ),
      ]);
      assert.equal(refreshes.every((result) => result.active), true);
      assert.equal(refreshes[0].licenseToken, refreshes[1].licenseToken);
      assert.equal(refreshes[0].refreshToken, refreshes[1].refreshToken);
      rotatedCredentials = refreshes[0];

      assert.equal((await accountModule.verifyLicenseToken(
        rotatedCredentials.licenseToken,
        "primary-a",
        production,
      )).active, true);
      assert.deepEqual(
        await accountModule.authorizeLicenseDownload({
          licenseToken: rotatedCredentials.licenseToken,
          deviceId: "primary-a",
          environment: production,
        }),
        { active: true },
      );
    });

    let replacementCredentials;
    await t.test("confirmed transfer is one-winner CAS and revokes old access and refresh", async () => {
      const prior = await activeDevice(
        databasePool,
        schema,
        primaryFixture.accountId,
        "production",
      );
      const transferOptions = {
        accountId: primaryFixture.accountId,
        environment: production,
        expectedPriorDeviceId: prior.id,
        expectedPriorDeviceIdHash: prior.device_id_hash,
        newDeviceIdHash: privateIdentifierHash("primary-b"),
        platform: "windows",
        appVersion: "1.0.14",
        buildChannel: "stable",
        initiatedBy: "account",
        transferReason: "device_change",
      };
      const transfers = await Promise.all([
        accountModule.confirmAccountDeviceTransfer(transferOptions),
        accountModule.confirmAccountDeviceTransfer(transferOptions),
      ]);
      assert.equal(transfers.filter((result) => result.transferred).length, 1);
      assert.equal(
        transfers.filter((result) => !result.transferred && result.reason === "binding_changed").length,
        1,
      );
      assert.equal(transfers.find((result) => result.transferred).deviceGeneration, "2");

      const audit = await databasePool.query(
        `select count(*)::int as count from ${quotedSchema}.sidestream_device_transfers where account_id = $1`,
        [primaryFixture.accountId],
      );
      assert.equal(audit.rows[0].count, 1);
      const liveTokens = await databasePool.query(
        `select count(*)::int as count from ${quotedSchema}.sidestream_license_tokens where account_id = $1 and revoked_at is null`,
        [primaryFixture.accountId],
      );
      assert.equal(liveTokens.rows[0].count, 0);

      assert.equal((await accountModule.verifyLicenseToken(
        rotatedCredentials.licenseToken,
        "primary-a",
        production,
      )).code, "device_replaced");
      assert.equal((await accountModule.refreshLicenseToken(
        rotatedCredentials.refreshToken,
        "primary-a",
        production,
      )).code, "device_replaced");
      assert.deepEqual(
        await accountModule.authorizeLicenseDownload({
          licenseToken: rotatedCredentials.licenseToken,
          deviceId: "primary-a",
          environment: production,
        }),
        { active: false, code: "device_replaced" },
      );
      assert.equal((await accountModule.getActivationStatus(
        primaryFixture.activation.activationKey,
        "primary-a",
        { skipReconciliation: true, environment: production },
      )).code, "device_replaced");

      const replacement = await seedActivation(databasePool, schema, primaryFixture, {
        deviceId: "primary-b",
        appVersion: "1.0.14",
      });
      replacementCredentials = await accountModule.getActivationStatus(
        replacement.activationKey,
        "primary-b",
        { skipReconciliation: true, environment: production, platform: "windows" },
      );
      assert.equal(replacementCredentials.status, "active");
      primaryFixture.replacementActivation = replacement;
    });

    await t.test("read-only status and deactivation expose stable outcomes", async () => {
      const before = await snapshotAccountDeviceRows(
        databasePool,
        schema,
        primaryFixture.accountId,
      );
      const status = await accountModule.getAccountDeviceStatus(
        primaryFixture.accountId,
        production,
      );
      const after = await snapshotAccountDeviceRows(
        databasePool,
        schema,
        primaryFixture.accountId,
      );
      assert.equal(status.active, true);
      assert.deepEqual(after, before);

      assert.deepEqual(
        await accountModule.deactivateAccountDevice({
          accountId: primaryFixture.accountId,
          environment: production,
        }),
        { active: false, deactivated: true },
      );
      assert.deepEqual(
        await accountModule.deactivateAccountDevice({
          accountId: primaryFixture.accountId,
          environment: production,
        }),
        { active: false, deactivated: false },
      );
      assert.equal((await accountModule.verifyLicenseToken(
        replacementCredentials.licenseToken,
        "primary-b",
        production,
      )).code, "device_deactivated");
      assert.equal((await accountModule.refreshLicenseToken(
        replacementCredentials.refreshToken,
        "primary-b",
        production,
      )).code, "device_deactivated");
      assert.equal((await accountModule.getActivationStatus(
        primaryFixture.replacementActivation.activationKey,
        "primary-b",
        { skipReconciliation: true, environment: production },
      )).code, "device_deactivated");
    });

    await t.test("deactivate-then-activate permits unlimited moves without an override", async () => {
      for (const deviceId of ["primary-c", "primary-d", "primary-e", "primary-f"]) {
        const activation = await seedActivation(databasePool, schema, primaryFixture, {
          deviceId,
          appVersion: "1.0.14",
        });
        const activated = await accountModule.getActivationStatus(
          activation.activationKey,
          deviceId,
          { skipReconciliation: true, environment: production },
        );
        assert.equal(activated.status, "active");
        await accountModule.deactivateAccountDevice({
          accountId: primaryFixture.accountId,
          environment: production,
        });
      }

      const history = await deviceHistory(databasePool, schema, primaryFixture.accountId);
      assert.ok(getConfirmedDeviceMoveTimestamps(history).length >= 4);

      const testActivation = await seedActivation(databasePool, schema, primaryFixture, {
        deviceId: "primary-test",
        appVersion: "1.0.14",
      });
      const testResult = await accountModule.getActivationStatus(
        testActivation.activationKey,
        "primary-test",
        { skipReconciliation: true, environment: testNamespace },
      );
      assert.equal(testResult.status, "active");
      assert.equal(
        (await databasePool.query(
          `
            select count(*)::int as count
            from ${quotedSchema}.sidestream_account_devices
            where account_id = $1
              and license_namespace = 'production'
              and revoked_at is null
          `,
          [primaryFixture.accountId],
        )).rows[0].count,
        0,
      );
      assert.equal((await activeDevice(
        databasePool,
        schema,
        primaryFixture.accountId,
        "test",
      )).device_id_hash, privateIdentifierHash("primary-test"));
    });

    await t.test("legacy 1.0.12 replays and rolls access with historical licenses", async () => {
      const fixture = await seedAccount(databasePool, schema, {
        activeUpdatedAt: new Date(Date.now() - 2 * DAY_MS),
      });
      await seedLicense(databasePool, schema, fixture.accountId, {
        status: "canceled",
        updatedAt: new Date(),
      });
      const activation = await seedActivation(databasePool, schema, fixture, {
        deviceId: "legacy-1.0.12",
        appVersion: "1.0.12",
      });
      const first = await accountModule.getActivationStatus(
        activation.activationKey,
        "legacy-1.0.12",
        { skipReconciliation: true, environment: production },
      );
      assert.equal(first.status, "active");
      assert.equal(first.license.status, "active");
      await databasePool.query(
        `
          update ${quotedSchema}.sidestream_account_devices
          set activated_at = now() - interval '2 hours'
          where account_id = $1 and license_namespace = 'production' and revoked_at is null
        `,
        [fixture.accountId],
      );
      await databasePool.query(
        `update ${quotedSchema}.sidestream_activation_sessions set completed_at = now() - interval '1 hour' where id = $1`,
        [activation.activationId],
      );
      const replay = await accountModule.getActivationStatus(
        activation.activationKey,
        "legacy-1.0.12",
        { skipReconciliation: true, environment: production },
      );
      assert.equal(replay.status, "active");
      assert.equal(replay.licenseToken, first.licenseToken);
      const verified = await accountModule.verifyLicenseToken(
        first.licenseToken,
        "legacy-1.0.12",
        production,
      );
      assert.equal(verified.active, true);
      assert.ok(new Date(verified.tokenExpiresAt).getTime() > Date.now() + 300 * DAY_MS);
    });

    await t.test("exact Checkout truth and entitlement upserts preserve support state", async () => {
      const exactSession = {
        id: "cs_exact",
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        metadata: {
          sidestream_plan: "sidestream_pro",
          sidestream_price_id: "price_exact",
          sidestream_activation_key: "activation_exact",
        },
        line_items: {
          data: [{
            quantity: 1,
            price: { id: "price_exact", product: { id: "prod_exact" } },
          }],
          has_more: false,
        },
      };
      const expectation = {
        sessionId: "cs_exact",
        activationKey: "activation_exact",
        priceId: "price_exact",
        productId: "prod_exact",
        paidPlanKeys: ["sidestream_pro"],
      };
      assert.deepEqual(verifyPaidCheckoutSession(exactSession, expectation), { ok: true });
      assert.equal(
        verifyPaidCheckoutSession({ ...exactSession, id: "cs_wrong" }, expectation).reason,
        "session_id_mismatch",
      );

      const fulfillmentFixture = await seedAccount(databasePool, schema);
      const fulfillmentIntentId = "55555555-5555-4555-8555-555555555555";
      const fulfillmentAcquisitionId = "66666666-6666-4666-8666-666666666666";
      await databasePool.query(
        `
          insert into ${quotedSchema}.sidestream_acquisitions (
            id, license_namespace, first_observed_source, entry_channel,
            first_observed_at, attribution_confidence
          ) values (
            $1::uuid, 'production', 'website_direct_or_unknown', 'website',
            now(), 'exact_sidestream_entry'
          )
        `,
        [fulfillmentAcquisitionId],
      );
      const fulfillmentSession = {
        id: "cs_exact_fulfillment",
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        customer: "cus_exact_fulfillment",
        payment_intent: "pi_exact_fulfillment",
        amount_subtotal: 999,
        amount_total: 999,
        currency: "usd",
        total_details: {
          amount_discount: 0,
          amount_shipping: 0,
          amount_tax: 0,
        },
        subscription: null,
        customer_details: {
          email: fulfillmentFixture.email,
          name: "Exact Checkout Fixture",
        },
        metadata: {
          sidestream_plan: "sidestream_pro",
          sidestream_price_id: "price_exact_fulfillment",
          sidestream_product_id: "prod_UpwXh6oO1OmPyQ",
          sidestream_checkout_intent_id: fulfillmentIntentId,
          sidestream_account_id: fulfillmentFixture.accountId,
          sidestream_offer_id: "sidestream-unlimited-global",
          sidestream_offer_country: "US",
          sidestream_offer_currency: "usd",
          sidestream_offer_amount_minor: "999",
          sidestream_activation_key: "activation_exact_fulfillment",
          sidestream_acquisition_id: fulfillmentAcquisitionId,
        },
        line_items: {
          data: [{
            quantity: 1,
            price: {
              id: "price_exact_fulfillment",
              product: { id: "prod_UpwXh6oO1OmPyQ" },
            },
          }],
          has_more: false,
        },
      };
      const fulfillmentActivation = await databasePool.query(
        `
          insert into ${quotedSchema}.sidestream_activation_sessions (
            activation_key,
            device_id_hash,
            app_version,
            build_channel,
            source,
            status,
            expires_at,
            stripe_checkout_session_id,
            stripe_checkout_price_id,
            stripe_checkout_product_id,
            stripe_checkout_expires_at,
            checkout_attached_at,
            checkout_claim_grace_until
          ) values (
            'activation_exact_fulfillment', $1, '1.0.14', 'stable', 'integration',
            'pending', now() + interval '1 day', 'cs_exact_fulfillment',
            'price_exact_fulfillment', 'prod_UpwXh6oO1OmPyQ', now() + interval '1 hour',
            now(), now() + interval '70 minutes'
          )
          returning id
        `,
        [privateIdentifierHash("exact-checkout-device")],
      );
      await databasePool.query(
        `
          insert into ${quotedSchema}.sidestream_checkout_intents (
            id, acquisition_id, intent_kind, browser_token_hash, account_id,
            activation_session_id, state, attempt, stripe_customer_id,
            stripe_checkout_session_id, stripe_checkout_url, stripe_price_id,
            stripe_product_id, stripe_session_expires_at, offer_id,
            offer_country, offer_currency, offer_amount_minor,
            offer_stripe_product_id, offer_stripe_price_id, expires_at
          ) values (
            $1::uuid, $2::uuid, 'activation', $3, $4::uuid, $5::uuid, 'open', 0,
            'cus_exact_fulfillment', 'cs_exact_fulfillment',
            'https://checkout.stripe.test/cs_exact_fulfillment',
            'price_exact_fulfillment', 'prod_UpwXh6oO1OmPyQ',
            now() + interval '1 hour', 'sidestream-unlimited-global',
            'US', 'usd', 999, 'prod_UpwXh6oO1OmPyQ',
            'price_exact_fulfillment', now() + interval '1 day'
          )
        `,
        [
          fulfillmentIntentId,
          fulfillmentAcquisitionId,
          "f".repeat(64),
          fulfillmentFixture.accountId,
          fulfillmentActivation.rows[0].id,
        ],
      );
      accountModule.__setIntegrationStripeClient({
        checkout: {
          sessions: {
            async retrieve(sessionId) {
              assert.equal(sessionId, "cs_exact_fulfillment");
              return fulfillmentSession;
            },
          },
        },
        paymentIntents: {
          async retrieve(paymentIntentId) {
            assert.equal(paymentIntentId, "pi_exact_fulfillment");
            return {
              id: paymentIntentId,
              customer: "cus_exact_fulfillment",
              amount_received: 999,
              currency: "usd",
              status: "succeeded",
              latest_charge: "ch_exact_fulfillment",
              metadata: { sidestream_acquisition_id: fulfillmentAcquisitionId },
            };
          },
        },
        charges: {
          async retrieve(chargeId) {
            assert.equal(chargeId, "ch_exact_fulfillment");
            return {
              id: chargeId,
              customer: "cus_exact_fulfillment",
              payment_intent: "pi_exact_fulfillment",
              currency: "usd",
              amount_refunded: 0,
              paid: true,
              disputed: false,
              metadata: { sidestream_acquisition_id: fulfillmentAcquisitionId },
            };
          },
        },
        disputes: {
          async list() {
            return { data: [], has_more: false };
          },
        },
      });
      process.env.SIDESTREAM_LICENSE_NAMESPACE = "production";
      process.env.VERCEL_ENV = "production";
      process.env.SIDESTREAM_POSTGRES_URL = testDatabaseUrl;
      let fulfilled;
      let fulfilledReplay;
      try {
        fulfilled = await accountModule.fulfillCheckoutSession(
          "cs_exact_fulfillment",
          "activation_exact_fulfillment",
        );
        fulfilledReplay = await accountModule.fulfillCheckoutSession(
          "cs_exact_fulfillment",
          "activation_exact_fulfillment",
        );
      } finally {
        accountModule.__setIntegrationStripeClient(null);
        delete process.env.SIDESTREAM_LICENSE_NAMESPACE;
        delete process.env.VERCEL_ENV;
        delete process.env.SIDESTREAM_POSTGRES_URL;
      }
      assert.deepEqual(fulfilled, {
        fulfilled: true,
        activationBound: true,
        paidAcquisition: false,
      });
      assert.deepEqual(fulfilledReplay, {
        fulfilled: true,
        activationBound: true,
        paidAcquisition: false,
      });
      const fulfillmentState = await databasePool.query(
        `
          select a.account_id, a.status,
            (select count(*)::int from ${quotedSchema}.sidestream_licenses l
              where l.stripe_checkout_session_id = 'cs_exact_fulfillment') as licenses
          from ${quotedSchema}.sidestream_activation_sessions a
          where a.activation_key = 'activation_exact_fulfillment'
        `,
      );
      assert.deepEqual(fulfillmentState.rows[0], {
        account_id: fulfillmentFixture.accountId,
        status: "paid",
        licenses: 1,
      });

      const supportPolicy = {
        transferLimitOverrides: {
          production: { limit: 5, expiresAt: new Date(Date.now() + DAY_MS).toISOString() },
        },
        supportAudit: [{ action: "override", reason: "support_recovery" }],
      };
      const subscriptionFixture = await seedAccount(databasePool, schema, {
        features: { singleDevicePolicy: supportPolicy },
      });
      process.env.SIDESTREAM_LEGACY_SUBSCRIPTION_PRICE_IDS = "price_LegacyIntegration";
      process.env.SIDESTREAM_LEGACY_SUBSCRIPTION_PRODUCT_IDS = "prod_LegacyIntegration";
      accountModule.__setIntegrationStripeClient({
        prices: {
          async retrieve(priceId) {
            assert.equal(priceId, "price_LegacyIntegration");
            return {
              id: priceId,
              active: true,
              type: "recurring",
              product: "prod_LegacyIntegration",
              recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
              currency: "usd",
              unit_amount: 999,
            };
          },
        },
        products: {
          async retrieve(productId) {
            assert.equal(productId, "prod_LegacyIntegration");
            return { id: productId, active: true, deleted: false };
          },
        },
      });
      await accountModule.upsertLicenseFromSubscription({
        id: subscriptionFixture.subscriptionId,
        customer: "cus_subscription_replay",
        status: "active",
        items: {
          data: [{ price: "price_LegacyIntegration", quantity: 1 }],
          has_more: false,
        },
      }, subscriptionFixture.accountId);
      accountModule.__setIntegrationStripeClient(null);
      const subscriptionFeatures = await licenseFeatures(
        databasePool,
        schema,
        subscriptionFixture.licenseId,
      );
      assert.deepEqual(subscriptionFeatures.singleDevicePolicy, supportPolicy);
      assert.equal(subscriptionFeatures.unlimited_downloads, true);

      const checkoutFixture = await seedAccount(databasePool, schema);
      const checkoutLicense = await seedLicense(
        databasePool,
        schema,
        checkoutFixture.accountId,
        {
          checkoutSessionId: "cs_support_replay",
          paymentIntentId: "pi_support_replay",
          features: { singleDevicePolicy: supportPolicy },
        },
      );
      const oneTimeUpsert = await accountModule.__upsertLicenseFromOneTimeCheckoutSession({
        accountId: checkoutFixture.accountId,
        customerId: checkoutLicense.customerId,
        checkoutSessionId: "cs_support_replay",
        paymentFacts: {
          paymentIntentId: "pi_support_replay",
          chargeId: "ch_support_replay",
          customerId: checkoutLicense.customerId,
          amountPaid: 999,
          amountRefunded: 0,
          currency: "usd",
          paymentProven: true,
          disputeStatus: "none",
        },
        noPaymentRequired: false,
        currency: "usd",
        eventWatermark: null,
      }, databasePool);
      assert.equal(oneTimeUpsert.fulfilled, true);
      const checkoutFeatures = await licenseFeatures(
        databasePool,
        schema,
        checkoutLicense.licenseId,
      );
      assert.deepEqual(checkoutFeatures.singleDevicePolicy, supportPolicy);
      assert.equal(checkoutFeatures.one_time_purchase, true);
      assert.equal(networkAttempts.length, 0);
    });
  } finally {
    if (accountModule?.__closeIntegrationPool) {
      await accountModule.__closeIntegrationPool();
    }
    if (temporaryModuleDirectory) {
      await rm(temporaryModuleDirectory, { recursive: true, force: true });
    }
    if (databasePool) {
      await databasePool.query(`drop schema if exists ${quotedSchema} cascade`);
      const remaining = await databasePool.query(
        `select to_regnamespace($1) is not null as exists`,
        [schema],
      );
      assert.equal(remaining.rows[0].exists, false);
      await databasePool.end();
    }
    restoreEnvironment(environmentSnapshot);
    if (originalFetch === undefined) {
      delete globalThis.fetch;
    } else {
      globalThis.fetch = originalFetch;
    }
  }
});

function requireSafeTestDatabaseUrl(environment) {
  const candidate = configuredValue(environment[TEST_DATABASE_ENV]);
  if (!candidate) {
    throw new Error(`${TEST_DATABASE_ENV} is required for disposable Postgres tests`);
  }
  const testTarget = databaseTargetIdentity(candidate, TEST_DATABASE_ENV);
  for (const name of RUNTIME_DATABASE_ENV_NAMES) {
    const runtimeUrl = configuredValue(environment[name]);
    if (!runtimeUrl) continue;
    if (databaseTargetIdentity(runtimeUrl, name) === testTarget) {
      throw new Error(`${TEST_DATABASE_ENV} must not target the same database as ${name}`);
    }
  }
  return candidate;
}

function databaseTargetIdentity(connectionString, environmentName) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`${environmentName} must be a valid Postgres URL`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${environmentName} must use postgres: or postgresql:`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!url.hostname || !database) {
    throw new Error(`${environmentName} must identify a Postgres host and database`);
  }
  return `${url.hostname.toLowerCase()}:${url.port || "5432"}/${database}`;
}

function configuredValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function addHarmlessConnectionOption(connectionString) {
  const url = new URL(connectionString);
  url.searchParams.set("application_name", "single-device-safety-proof");
  return url.toString();
}

function createPoolOptions(connectionString) {
  const normalized = normalizeConnectionString(connectionString);
  return {
    connectionString: normalized,
    max: 12,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    ssl: shouldUseSsl(normalized) ? { rejectUnauthorized: false } : false,
  };
}

function normalizeConnectionString(connectionString) {
  const url = new URL(connectionString);
  if (/^(prefer|require)$/i.test(url.searchParams.get("sslmode") || "")) {
    url.searchParams.delete("sslmode");
  }
  return url.toString();
}

function shouldUseSsl(connectionString) {
  if (/sslmode=(disable|false)/i.test(connectionString)) return false;
  return !/localhost|127\.0\.0\.1|::1/.test(connectionString);
}

async function applyFullMigrationChain(pool, schema) {
  const migrations = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const migration of migrations) {
    const sql = await readFile(join(migrationsDirectory, migration), "utf8");
    await pool.query(rewritePublicSchema(sql, schema));
  }
  return migrations;
}

async function loadAccountModuleForSchema(schema) {
  const temporaryModuleDirectory = await mkdtemp(
    join(repositoryRoot, "tests", ".single-device-postgres-"),
  );
  const postgresUrl = pathToFileURL(
    join(repositoryRoot, "api", "_lib", "postgres.ts"),
  ).href;
  let maintenanceSource = rewritePublicSchema(
    await readFile(join(repositoryRoot, "api", "_lib", "maintenance.ts"), "utf8"),
    schema,
  );
  maintenanceSource = maintenanceSource.replaceAll(
    JSON.stringify("./postgres.js"),
    JSON.stringify(postgresUrl),
  );
  const maintenancePath = join(temporaryModuleDirectory, "maintenance-under-test.ts");
  await writeFile(maintenancePath, maintenanceSource, { mode: 0o600 });
  const customerIdentityPath = join(
    temporaryModuleDirectory,
    "customer-identity-under-test.ts",
  );
  await writeFile(
    customerIdentityPath,
    rewritePublicSchema(
      await readFile(
        join(repositoryRoot, "api", "_lib", "customer-identity.ts"),
        "utf8",
      ),
      schema,
    ),
    { mode: 0o600 },
  );
  const acquisitionIntegrityPath = join(
    temporaryModuleDirectory,
    "acquisition-integrity-under-test.ts",
  );
  let acquisitionIntegritySource = rewritePublicSchema(
    await readFile(
      join(repositoryRoot, "api", "_lib", "acquisition-integrity.ts"),
      "utf8",
    ),
    schema,
  );
  acquisitionIntegritySource = acquisitionIntegritySource
    .replaceAll(
      JSON.stringify("./license-environment.js"),
      JSON.stringify(pathToFileURL(
        join(repositoryRoot, "api", "_lib", "license-environment.ts"),
      ).href),
    )
    .replaceAll(
      JSON.stringify("./postgres.js"),
      JSON.stringify(postgresUrl),
    );
  await writeFile(acquisitionIntegrityPath, acquisitionIntegritySource, { mode: 0o600 });
  const sourceImports = {
    "./entitlement.js": pathToFileURL(join(repositoryRoot, "api", "_lib", "entitlement.ts")).href,
    "./checkout-offers.js": pathToFileURL(join(repositoryRoot, "api", "_lib", "checkout-offers.ts")).href,
    "./device-policy.js": pathToFileURL(join(repositoryRoot, "api", "_lib", "device-policy.ts")).href,
    "./license-environment.js": pathToFileURL(join(repositoryRoot, "api", "_lib", "license-environment.ts")).href,
    "./license-entitlement-sql.js": pathToFileURL(join(repositoryRoot, "api", "_lib", "license-entitlement-sql.ts")).href,
    "./acquisition-cookie.js": pathToFileURL(join(repositoryRoot, "api", "_lib", "acquisition-cookie.ts")).href,
    "./acquisition-handoff.js": pathToFileURL(join(repositoryRoot, "api", "_lib", "acquisition-handoff.ts")).href,
    "./acquisition-integrity.js": pathToFileURL(acquisitionIntegrityPath).href,
    "./customer-identity.js": pathToFileURL(customerIdentityPath).href,
    "./maintenance.js": pathToFileURL(maintenancePath).href,
    "./paid-acquisition.js": pathToFileURL(
      join(repositoryRoot, "api", "_lib", "paid-acquisition.ts"),
    ).href,
    "./postgres.js": postgresUrl,
  };
  // Runtime SQL deliberately qualifies `public`; rewrite only a disposable
  // source copy so the real transaction functions target this run's schema.
  let source = await readFile(accountSourcePath, "utf8");
  source = rewritePublicSchema(source, schema);
  for (const [original, replacement] of Object.entries(sourceImports)) {
    assert.match(source, new RegExp(escapeRegExp(original)));
    source = source.replaceAll(JSON.stringify(original), JSON.stringify(replacement));
  }
  source += `
export async function __closeIntegrationPool() {
  await getPostgresPool().end();
}
export function __setIntegrationStripeClient(value: Stripe | null) {
  stripeClient = value;
}
export { upsertLicenseFromOneTimeCheckoutSession as __upsertLicenseFromOneTimeCheckoutSession };
`;

  const modulePath = join(temporaryModuleDirectory, "account-under-test.ts");
  await writeFile(modulePath, source, { mode: 0o600 });
  const accountModule = await import(`${pathToFileURL(modulePath).href}?schema=${schema}`);
  return { accountModule, temporaryModuleDirectory };
}

function rewritePublicSchema(source, schema) {
  return source.replace(/\bpublic\./g, `${quoteIdentifier(schema)}.`);
}

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
    throw new TypeError("Unsafe Postgres identifier");
  }
  return `"${identifier}"`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function configureRuntimeForDisposableDatabase(connectionString) {
  for (const name of CONTROLLED_ENV_NAMES) delete process.env[name];
  process.env.POSTGRES_URL = connectionString;
  process.env.POSTGRES_POOL_MAX = "12";
  process.env.SIDESTREAM_LICENSE_HASH_SECRET = TEST_SECRET;
  process.env.SIDESTREAM_DEVICE_POLICY_MODE = "enforce";
}

function snapshotEnvironment(names) {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(snapshot) {
  for (const [name, value] of snapshot) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function licenseEnvironment(namespace, connectionString) {
  return {
    namespace,
    apiHost: namespace === "production" ? "sidestream.tv" : "test.sidestream.invalid",
    allowedApiHosts: [namespace === "production" ? "sidestream.tv" : "test.sidestream.invalid"],
    database: {
      environmentVariable: "POSTGRES_URL",
      connectionString,
    },
    credentialNamespaceRequired: true,
  };
}

async function seedAccount(pool, schema, options = {}) {
  const suffix = randomBytes(8).toString("hex");
  const email = `fixture-${suffix}@example.invalid`;
  const account = await pool.query(
    `
      insert into ${quoteIdentifier(schema)}.sidestream_accounts (email, display_name)
      values ($1, 'Integration Fixture')
      returning id
    `,
    [email],
  );
  const accountId = account.rows[0].id;
  const license = await seedLicense(pool, schema, accountId, {
    status: "active",
    updatedAt: options.activeUpdatedAt,
    features: options.features,
  });
  return { accountId, email, ...license };
}

async function seedLicense(pool, schema, accountId, options = {}) {
  const suffix = randomBytes(8).toString("hex");
  const customerId = `cus_${suffix}`;
  const subscriptionId = options.subscriptionId === null
    ? null
    : options.subscriptionId || `sub_${suffix}`;
  const result = await pool.query(
    `
      insert into ${quoteIdentifier(schema)}.sidestream_licenses (
        account_id,
        stripe_customer_id,
        stripe_subscription_id,
        stripe_checkout_session_id,
        stripe_payment_intent_id,
        plan_key,
        status,
        entitlement_status,
        status_reason,
        revoked_at,
        features,
        created_at,
        updated_at
      ) values (
        $1, $2, $3, $4, $5, 'sidestream_pro', $6, $7,
        'integration_fixture', case when $7 = 'revoked' then now() else null end,
        $8::jsonb, now(), $9::timestamptz
      )
      returning id
    `,
    [
      accountId,
      customerId,
      subscriptionId,
      options.checkoutSessionId || null,
      options.paymentIntentId || null,
      options.status || "active",
      options.entitlementStatus || (options.status === "canceled" ? "revoked" : "active"),
      JSON.stringify(options.features || {}),
      (options.updatedAt || new Date()).toISOString(),
    ],
  );
  return { licenseId: result.rows[0].id, subscriptionId, customerId };
}

async function seedActivation(pool, schema, fixture, options) {
  const suffix = randomBytes(8).toString("hex");
  const activationKey = `activation_${suffix}`;
  const result = await pool.query(
    `
      insert into ${quoteIdentifier(schema)}.sidestream_activation_sessions (
        activation_key,
        account_id,
        license_id,
        device_id_hash,
        app_version,
        build_channel,
        source,
        status,
        expires_at
      ) values ($1, $2, $3, $4, $5, 'stable', 'integration', 'restored', now() + interval '1 day')
      returning id
    `,
    [
      activationKey,
      fixture.accountId,
      fixture.licenseId,
      privateIdentifierHash(options.deviceId),
      options.appVersion,
    ],
  );
  return { activationId: result.rows[0].id, activationKey };
}

async function activeDevice(pool, schema, accountId, namespace) {
  const result = await pool.query(
    `
      select id, device_id_hash, activated_at, revoked_at, revocation_reason
      from ${quoteIdentifier(schema)}.sidestream_account_devices
      where account_id = $1 and license_namespace = $2 and revoked_at is null
      order by activated_at desc, id desc
      limit 1
    `,
    [accountId, namespace],
  );
  assert.ok(result.rows[0], `expected an active ${namespace} device`);
  return result.rows[0];
}

async function snapshotAccountDeviceRows(pool, schema, accountId) {
  const result = await pool.query(
    `
      select id, license_namespace, device_id_hash, platform, app_version, build_channel,
        activated_at, last_seen_at, revoked_at, revocation_reason
      from ${quoteIdentifier(schema)}.sidestream_account_devices
      where account_id = $1
      order by activated_at, id
    `,
    [accountId],
  );
  return result.rows;
}

async function deviceHistory(pool, schema, accountId) {
  const [devices, transfers] = await Promise.all([
    pool.query(
      `
        select id, device_id_hash, activated_at
        from ${quoteIdentifier(schema)}.sidestream_account_devices
        where account_id = $1 and license_namespace = 'production'
        order by activated_at, id
      `,
      [accountId],
    ),
    pool.query(
      `
        select from_device_id, to_device_id, transferred_at
        from ${quoteIdentifier(schema)}.sidestream_device_transfers
        where account_id = $1 and license_namespace = 'production'
        order by transferred_at, id
      `,
      [accountId],
    ),
  ]);
  return {
    devices: devices.rows.map((device) => ({
      id: device.id,
      deviceIdHash: device.device_id_hash,
      activatedAt: device.activated_at,
    })),
    transfers: transfers.rows.map((transfer) => ({
      fromDeviceId: transfer.from_device_id,
      toDeviceId: transfer.to_device_id,
      transferredAt: transfer.transferred_at,
    })),
  };
}

async function licenseFeatures(pool, schema, licenseId) {
  const result = await pool.query(
    `select features from ${quoteIdentifier(schema)}.sidestream_licenses where id = $1`,
    [licenseId],
  );
  return result.rows[0].features;
}

async function snapshotIdentityProtectedState(
  pool,
  schema,
  accountId,
  activationId,
) {
  const quotedSchema = quoteIdentifier(schema);
  const [account, devices, transfers, credentials, licenses, activation] =
    await Promise.all([
      pool.query(
        `
          select id, email, display_name, stripe_customer_id
          from ${quotedSchema}.sidestream_accounts
          where id = $1
        `,
        [accountId],
      ),
      pool.query(
        `
          select id, license_namespace, device_id_hash, platform, app_version,
            build_channel, revoked_at is not null as revoked, revocation_reason
          from ${quotedSchema}.sidestream_account_devices
          where account_id = $1
          order by activated_at, id
        `,
        [accountId],
      ),
      pool.query(
        `
          select id, license_namespace, from_device_id, to_device_id,
            initiated_by, transfer_reason
          from ${quotedSchema}.sidestream_device_transfers
          where account_id = $1
          order by transferred_at, id
        `,
        [accountId],
      ),
      pool.query(
        `
          select id, license_id, activation_session_id, device_id_hash,
            token_hash, refresh_token_hash, previous_refresh_token_hash,
            revoked_at is not null as revoked
          from ${quotedSchema}.sidestream_license_tokens
          where account_id = $1
          order by created_at, id
        `,
        [accountId],
      ),
      pool.query(
        `
          select id, plan_key, status, entitlement_status, status_reason,
            revoked_at is not null as revoked, features
          from ${quotedSchema}.sidestream_licenses
          where account_id = $1
          order by created_at, id
        `,
        [accountId],
      ),
      pool.query(
        `
          select id, account_id, license_id, device_id_hash, status,
            completed_at is not null as completed
          from ${quotedSchema}.sidestream_activation_sessions
          where id = $1
        `,
        [activationId],
      ),
    ]);
  return {
    policyMode: process.env.SIDESTREAM_DEVICE_POLICY_MODE,
    account: account.rows,
    devices: devices.rows,
    deviceGeneration: devices.rows.length,
    activeDeviceBindings: devices.rows.filter((row) => !row.revoked).length,
    transfers: transfers.rows,
    transferCount: transfers.rows.length,
    credentials: credentials.rows,
    credentialGeneration: credentials.rows.length,
    liveCredentialCount: credentials.rows.filter((row) => !row.revoked).length,
    licenses: licenses.rows,
    activation: activation.rows,
  };
}

async function snapshotCustomerIdentityState(pool, schema) {
  const quotedSchema = quoteIdentifier(schema);
  const [profiles, links, installs, merges] = await Promise.all([
    pool.query(
      `
        select id, license_namespace, merged_into, contact_email, display_name,
          platform_summary, app_version_summary, download_success_count,
          download_failure_count, entitlement_status
        from ${quotedSchema}.sidestream_customer_profiles
        order by id
      `,
    ),
    pool.query(
      `
        select profile_id, license_namespace, link_type, link_value
        from ${quotedSchema}.sidestream_customer_identity_links
        order by profile_id, link_type, link_value
      `,
    ),
    pool.query(
      `
        select profile_id, license_namespace, install_id_hash, platform, app_version
        from ${quotedSchema}.sidestream_customer_installs
        order by profile_id, install_id_hash
      `,
    ),
    pool.query(
      `
        select source_profile_id, target_profile_id, license_namespace,
          merge_evidence_type, merge_evidence_value_hash, initiated_by
        from ${quotedSchema}.sidestream_customer_profile_merges
        order by source_profile_id
      `,
    ),
  ]);
  return {
    profiles: profiles.rows,
    links: links.rows,
    installs: installs.rows,
    merges: merges.rows,
  };
}

async function customerIdentityReviewCount(pool, schema) {
  const result = await pool.query(
    `select count(*)::int as count from ${quoteIdentifier(schema)}.sidestream_customer_identity_reviews`,
  );
  return result.rows[0].count;
}

function privateIdentifierHash(value) {
  return createHmac("sha256", TEST_SECRET).update(value).digest("hex");
}

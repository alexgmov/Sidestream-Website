import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";
import {
  CustomerIdentityInputError,
  attachCustomerIdentity,
  normalizeCustomerIdentityInput,
} from "../../api/_lib/customer-identity.ts";
import {
  createTestPoolOptions,
  requireSafeTestDatabaseUrl,
} from "../../scripts/run-postgres-integration.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDirectory = join(repositoryRoot, "db", "migrations");
const customerIdentityPath = join(
  repositoryRoot,
  "api",
  "_lib",
  "customer-identity.ts",
);
const identityMigrationPath = join(
  migrationsDirectory,
  "20260715121000_add_customer_identity_links.sql",
);
const requiredMigrationNames = [
  "20260703120000_add_sidestream_accounts_billing.sql",
  "20260704130000_allow_stripe_first_accounts.sql",
  "20260704150000_allow_one_time_checkout_licenses.sql",
  "20260715120000_add_customer_360_core.sql",
  "20260715121000_add_customer_identity_links.sql",
];

test("optional Customer 360 identity fields are exact, bounded, and backward compatible", async () => {
  assert.deepEqual(normalizeCustomerIdentityInput(undefined), {});
  assert.deepEqual(normalizeCustomerIdentityInput(null), {});
  assert.deepEqual(normalizeCustomerIdentityInput({
    installIdHash: "",
    supportCode: null,
    installerReceiptIdHash: undefined,
  }), {});

  const valid = normalizeCustomerIdentityInput({
    installIdHash: "a".repeat(64),
    supportCode: "SIDE-A1B2-C3D4-E5F6",
    installerReceiptIdHash: "b".repeat(64),
    email: "attacker@example.com",
    displayName: "Attacker",
    ipAddress: "203.0.113.9",
    gmailCampaignHmac: "not-identity",
  });
  assert.deepEqual(valid, {
    installIdHash: "a".repeat(64),
    supportCode: "SIDE-A1B2-C3D4-E5F6",
    installerReceiptIdHash: "b".repeat(64),
  });
  assert.equal(Object.isFrozen(valid), true);

  for (const [field, value] of [
    ["installIdHash", "A".repeat(64)],
    ["installIdHash", "a".repeat(63)],
    ["installIdHash", "a".repeat(65)],
    ["installIdHash", 42],
    ["installerReceiptIdHash", "g".repeat(64)],
    ["supportCode", "side-A1B2-C3D4-E5F6"],
    ["supportCode", "SIDE-A1B2-C3D4-E5F6 "],
    ["supportCode", "SIDE-A1B2-C3D4-E5F"],
  ]) {
    assert.throws(
      () => normalizeCustomerIdentityInput({ [field]: value }),
      (error) => {
        assert.ok(error instanceof CustomerIdentityInputError);
        assert.match(error.message, new RegExp(field));
        return true;
      },
    );
  }

  const unusedClient = {
    query() {
      throw new Error("account-only input must not select or create a profile");
    },
  };
  assert.deepEqual(
    await attachCustomerIdentity(unusedClient, {
      environment: { namespace: "test" },
      accountId: randomUUID(),
      source: "license_verify",
    }),
    { profileId: null, attached: false, reviewRequired: false },
  );
  await assert.rejects(
    attachCustomerIdentity(unusedClient, {
      environment: { namespace: "preview" },
      activationId: randomUUID(),
      source: "activation_start",
    }),
    /trusted license namespace/,
  );

  const missingSchemaQueries = [];
  const missingSchemaClient = {
    query(sql) {
      missingSchemaQueries.push(String(sql));
      return {
        rows: [{ profiles: null, links: null, installs: null, reviews: null }],
      };
    },
  };
  assert.deepEqual(
    await attachCustomerIdentity(missingSchemaClient, {
      environment: { namespace: "production" },
      activationId: randomUUID(),
      identity: {
        installIdHash: "c".repeat(64),
        supportCode: "SIDE-A1B2-C3D4-E5F6",
      },
      source: "activation_start",
    }),
    { profileId: null, attached: false, reviewRequired: false },
  );
  assert.equal(missingSchemaQueries.length, 1);
  assert.match(missingSchemaQueries[0], /to_regclass/);
  assert.match(missingSchemaQueries[0], /sidestream_customer_identity_links/);
});

test("routes inject optional identity into account methods without owning database access", async () => {
  const routeFiles = [
    "api/activation/start.ts",
    "api/activation/status.ts",
    "api/activation/claim.ts",
    "api/license/verify.ts",
    "api/license/refresh.ts",
  ];
  for (const relativePath of routeFiles) {
    const source = await readFile(join(repositoryRoot, relativePath), "utf8");
    for (const field of [
      "installIdHash",
      "supportCode",
      "installerReceiptIdHash",
    ]) {
      assert.match(source, new RegExp(`\\b${field}\\b`), relativePath);
    }
    assert.doesNotMatch(source, /customer-identity/, relativePath);
    assert.doesNotMatch(source, /_lib\/postgres|\.\.\/_lib\/postgres/, relativePath);
    assert.match(source, /resolveRequestLicenseEnvironment\(request\)/, relativePath);
  }

  const accountSource = await readFile(
    join(repositoryRoot, "api", "_lib", "account.ts"),
    "utf8",
  );
  assert.match(accountSource, /from "\.\/customer-identity\.js"/);
  assert.match(accountSource, /requireMatchingLicenseEnvironment/);

  const identitySource = await readFile(customerIdentityPath, "utf8");
  for (const forbiddenTable of [
    "sidestream_account_devices",
    "sidestream_device_transfers",
    "sidestream_license_tokens",
    "sidestream_device_policy",
  ]) {
    assert.doesNotMatch(identitySource, new RegExp(forbiddenTable));
  }
  assert.doesNotMatch(identitySource, /update public\.sidestream_licenses/i);
  assert.doesNotMatch(identitySource, /update public\.sidestream_accounts/i);
  assert.doesNotMatch(
    identitySource,
    /gmail_campaign_hmac|installer_request_hmac|user_agent|ip_address|time_proximity/i,
  );
});

test("identity migration enforces canonical input and immutable explicit review state", async () => {
  const sql = await readFile(identityMigrationPath, "utf8");
  assert.match(sql, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(sql, /\^SIDE-\[A-Z0-9\]\{4\}-\[A-Z0-9\]\{4\}-\[A-Z0-9\]\{4\}\$/);
  assert.match(sql, /sidestream_customer_identity_links_profile_account_unique/);
  assert.match(sql, /where link_type = 'account_identity'/);
  assert.match(sql, /review_state text not null default 'pending_review'/);
  assert.match(sql, /before update or delete/);
  assert.match(sql, /enable row level security/);
});

test("Customer 360 attachment is atomic, convergent, conflict-audited, and namespace isolated", {
  timeout: 120_000,
}, async (t) => {
  const testDatabaseUrl = requireSafeTestDatabaseUrl(process.env);
  const schema = `sidestream_c360_identity_${randomBytes(8).toString("hex")}`;
  const quotedSchema = quoteIdentifier(schema);
  const pool = new Pool(createTestPoolOptions(testDatabaseUrl));
  const temporaryDirectory = await mkdtemp(
    join(dirname(fileURLToPath(import.meta.url)), ".identity-"),
  );
  let schemaCreated = false;

  try {
    await pool.query(`create schema ${quotedSchema}`);
    schemaCreated = true;
    for (const migrationName of requiredMigrationNames) {
      const sql = await readFile(join(migrationsDirectory, migrationName), "utf8");
      await pool.query(rewritePublicSchema(sql, schema));
    }
    const identity = await loadCustomerIdentityForSchema(schema, temporaryDirectory);
    const testEnvironment = { namespace: "test" };

    await t.test("old clients create sparse anonymous profiles and stable installs converge", async () => {
      const oldActivationId = randomUUID();
      const oldResult = await attachCommitted(pool, identity, {
        environment: testEnvironment,
        activationId: oldActivationId,
        identity: {},
        source: "activation_start",
      });
      assert.equal(oldResult.attached, true);
      assert.equal(oldResult.reviewRequired, false);

      const oldProfile = await profileById(pool, quotedSchema, oldResult.profileId);
      assert.equal(oldProfile.license_namespace, "test");
      assert.equal(oldProfile.contact_email, null);
      assert.equal(oldProfile.display_name, null);

      const installIdHash = "1".repeat(64);
      const receiptHash = "2".repeat(64);
      const supportCode = "SIDE-A1B2-C3D4-E5F6";
      const firstActivationId = randomUUID();
      const first = await attachCommitted(pool, identity, {
        environment: testEnvironment,
        activationId: firstActivationId,
        identity: {
          installIdHash,
          installerReceiptIdHash: receiptHash,
          supportCode,
          licenseNamespace: "production",
          email: "spoofed@example.com",
        },
        platform: "darwin",
        appVersion: "1.0.14",
        source: "activation_start",
      });
      const secondActivationId = randomUUID();
      const second = await attachCommitted(pool, identity, {
        environment: testEnvironment,
        activationId: secondActivationId,
        identity: { installIdHash, installerReceiptIdHash: receiptHash, supportCode },
        platform: "macos",
        appVersion: "1.0.15",
        source: "activation_status",
      });
      assert.equal(second.profileId, first.profileId);
      assert.equal(second.reviewRequired, false);

      const stableProfile = await profileById(pool, quotedSchema, first.profileId);
      assert.equal(stableProfile.license_namespace, "test");
      assert.equal(stableProfile.contact_email, null);
      assert.equal(stableProfile.display_name, null);
      const links = await pool.query(
        `
          select link_type, link_value
          from ${quotedSchema}.sidestream_customer_identity_links
          where profile_id = $1
          order by link_type, link_value
        `,
        [first.profileId],
      );
      for (const [linkType, linkValue] of [
        ["activation_record", firstActivationId],
        ["activation_record", secondActivationId],
        ["install_identity_hash", installIdHash],
        ["installer_receipt_hash", receiptHash],
        ["support_code", supportCode],
      ]) {
        assert.ok(
          links.rows.some((row) =>
            row.link_type === linkType && row.link_value === linkValue
          ),
          `${linkType}:${linkValue}`,
        );
      }
      const install = await pool.query(
        `
          select profile_id, license_namespace, platform, app_version
          from ${quotedSchema}.sidestream_customer_installs
          where install_id_hash = $1
        `,
        [installIdHash],
      );
      assert.deepEqual(install.rows, [{
        profile_id: first.profileId,
        license_namespace: "test",
        platform: "macos",
        app_version: "1.0.15",
      }]);

    });

    const stable = await findInstall(pool, quotedSchema, "test", "1".repeat(64));
    const accountA = await seedVerifiedAccount(pool, quotedSchema, "a", {
      duplicateLicenseCustomer: true,
    });

    await t.test("verified server rows materialize contact and purchase evidence", async () => {
      const result = await attachCommitted(pool, identity, {
        environment: testEnvironment,
        activationId: await latestActivationForProfile(pool, quotedSchema, stable.profile_id),
        accountId: accountA.id,
        identity: {
          installIdHash: "1".repeat(64),
          email: "attacker@example.com",
          displayName: "Attacker",
          ip: "198.51.100.4",
          gmailCampaignHmac: "campaign-not-identity",
        },
        source: "activation_claim",
      });
      assert.equal(result.profileId, stable.profile_id);
      assert.equal(result.reviewRequired, false);

      const profile = await profileById(pool, quotedSchema, stable.profile_id);
      assert.equal(profile.contact_email, accountA.email);
      assert.equal(profile.display_name, accountA.displayName);
      const values = await identityValues(pool, quotedSchema, stable.profile_id);
      for (const expected of [
        ["account_identity", accountA.id],
        ["stripe_customer", accountA.accountStripeCustomerId],
        ["stripe_customer", accountA.licenseStripeCustomerId],
        ["stripe_checkout_session", accountA.checkoutSessionId],
        ["stripe_payment_intent", accountA.paymentIntentId],
        ["stripe_subscription", accountA.subscriptionId],
      ]) {
        assert.ok(
          values.some((row) =>
            row.link_type === expected[0] && row.link_value === expected[1]
          ),
          expected.join(":"),
        );
      }
      const duplicateLicenseRows = await pool.query(
        `
          select count(*)::int as count
          from ${quotedSchema}.sidestream_licenses
          where account_id = $1 and stripe_customer_id = $2
        `,
        [accountA.id, accountA.licenseStripeCustomerId],
      );
      assert.equal(duplicateLicenseRows.rows[0].count, 2);
      assert.deepEqual(
        values.filter((row) => row.link_type === "stripe_customer"),
        [
          {
            link_type: "stripe_customer",
            link_value: accountA.accountStripeCustomerId,
          },
          {
            link_type: "stripe_customer",
            link_value: accountA.licenseStripeCustomerId,
          },
        ],
      );
      assert.ok(values.every((row) => row.link_value !== "attacker@example.com"));
      assert.ok(values.every((row) => row.link_value !== "campaign-not-identity"));
    });

    let reviewId;
    await t.test("a second account is rejected without partial evidence or contact overwrite", async () => {
      const accountB = await seedVerifiedAccount(pool, quotedSchema, "b");
      const conflictActivationId = randomUUID();
      const result = await attachCommitted(pool, identity, {
        environment: testEnvironment,
        activationId: conflictActivationId,
        accountId: accountB.id,
        identity: { installIdHash: "1".repeat(64) },
        source: "license_verify",
      });
      assert.equal(result.profileId, stable.profile_id);
      assert.equal(result.reviewRequired, true);

      const profile = await profileById(pool, quotedSchema, stable.profile_id);
      assert.equal(profile.contact_email, accountA.email);
      assert.equal(profile.display_name, accountA.displayName);
      const values = await identityValues(pool, quotedSchema, stable.profile_id);
      assert.deepEqual(
        values.filter((row) => row.link_type === "account_identity"),
        [{ link_type: "account_identity", link_value: accountA.id }],
      );
      for (const rejectedValue of [
        accountB.id,
        accountB.accountStripeCustomerId,
        accountB.licenseStripeCustomerId,
        accountB.checkoutSessionId,
        accountB.paymentIntentId,
        accountB.subscriptionId,
      ]) {
        assert.ok(!values.some((row) => row.link_value === rejectedValue));
      }

      const reviews = await pool.query(
        `
          select id, candidate_profile_id, existing_profile_id, evidence_type,
            evidence_value_hash, evidence_trust, attachment_source, review_state
          from ${quotedSchema}.sidestream_customer_identity_reviews
          where candidate_profile_id = $1
            and evidence_type = 'account_identity'
          order by created_at, id
        `,
        [stable.profile_id],
      );
      const rejectedAccountReview = reviews.rows.find((row) =>
        row.evidence_value_hash === evidenceHash("account_identity", accountB.id)
      );
      assert.ok(rejectedAccountReview);
      assert.equal(rejectedAccountReview.existing_profile_id, stable.profile_id);
      assert.equal(rejectedAccountReview.evidence_trust, "verified_server");
      assert.equal(rejectedAccountReview.attachment_source, "license_verify");
      assert.equal(rejectedAccountReview.review_state, "pending_review");
      reviewId = rejectedAccountReview.id;
    });

    await t.test("concurrent verified contenders have one winner and one review", async () => {
      const installIdHash = "3".repeat(64);
      const activationId = randomUUID();
      const anonymous = await attachCommitted(pool, identity, {
        environment: testEnvironment,
        activationId,
        identity: { installIdHash },
        source: "activation_start",
      });
      const accountC = await seedVerifiedAccount(pool, quotedSchema, "c");
      const accountD = await seedVerifiedAccount(pool, quotedSchema, "d");
      const contenders = await Promise.all([
        attachCommitted(pool, identity, {
          environment: testEnvironment,
          activationId,
          accountId: accountC.id,
          identity: { installIdHash },
          source: "license_verify",
        }),
        attachCommitted(pool, identity, {
          environment: testEnvironment,
          activationId,
          accountId: accountD.id,
          identity: { installIdHash },
          source: "license_refresh",
        }),
      ]);
      assert.deepEqual(
        contenders.map((result) => result.reviewRequired).sort(),
        [false, true],
      );

      const values = await identityValues(pool, quotedSchema, anonymous.profileId);
      const accountLinks = values.filter((row) => row.link_type === "account_identity");
      assert.equal(accountLinks.length, 1);
      const winner = accountLinks[0].link_value === accountC.id ? accountC : accountD;
      const loser = winner.id === accountC.id ? accountD : accountC;
      const profile = await profileById(pool, quotedSchema, anonymous.profileId);
      assert.equal(profile.contact_email, winner.email);
      assert.equal(profile.display_name, winner.displayName);
      for (const rejectedValue of [
        loser.id,
        loser.accountStripeCustomerId,
        loser.licenseStripeCustomerId,
        loser.checkoutSessionId,
        loser.paymentIntentId,
        loser.subscriptionId,
      ]) {
        assert.ok(!values.some((row) => row.link_value === rejectedValue));
      }
      const review = await pool.query(
        `
          select count(*)::int as count
          from ${quotedSchema}.sidestream_customer_identity_reviews
          where candidate_profile_id = $1
            and evidence_type = 'account_identity'
            and evidence_value_hash = $2
            and review_state = 'pending_review'
        `,
        [anonymous.profileId, evidenceHash("account_identity", loser.id)],
      );
      assert.equal(review.rows[0].count, 1);
    });

    await t.test("caller rollback removes both the profile and verified attachment", async () => {
      const accountE = await seedVerifiedAccount(pool, quotedSchema, "e");
      const activationId = randomUUID();
      const installIdHash = "4".repeat(64);
      const before = await profileCount(pool, quotedSchema);
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await identity.attachCustomerIdentity(client, {
          environment: testEnvironment,
          activationId,
          accountId: accountE.id,
          identity: { installIdHash },
          source: "activation_claim",
        });
        assert.equal(result.reviewRequired, false);
        await client.query("rollback");
      } finally {
        client.release();
      }
      assert.equal(await profileCount(pool, quotedSchema), before);
      const leaked = await pool.query(
        `
          select count(*)::int as count
          from ${quotedSchema}.sidestream_customer_identity_links
          where link_value in ($1, $2)
        `,
        [activationId, accountE.id],
      );
      assert.equal(leaked.rows[0].count, 0);
      const leakedInstall = await pool.query(
        `
          select count(*)::int as count
          from ${quotedSchema}.sidestream_customer_installs
          where install_id_hash = $1
        `,
        [installIdHash],
      );
      assert.equal(leakedInstall.rows[0].count, 0);
    });

    await t.test("the same association remains isolated across trusted namespaces", async () => {
      const installIdHash = "5".repeat(64);
      const testResult = await attachCommitted(pool, identity, {
        environment: testEnvironment,
        activationId: randomUUID(),
        identity: { installIdHash, namespace: "production" },
        source: "activation_start",
      });
      const productionResult = await attachCommitted(pool, identity, {
        environment: { namespace: "production" },
        activationId: randomUUID(),
        identity: { installIdHash, namespace: "test" },
        source: "activation_start",
      });
      assert.notEqual(testResult.profileId, productionResult.profileId);
      const installs = await pool.query(
        `
          select license_namespace, profile_id
          from ${quotedSchema}.sidestream_customer_installs
          where install_id_hash = $1
          order by license_namespace
        `,
        [installIdHash],
      );
      assert.deepEqual(installs.rows, [
        { license_namespace: "production", profile_id: productionResult.profileId },
        { license_namespace: "test", profile_id: testResult.profileId },
      ]);
    });

    await t.test("database guards reject malformed support codes, second accounts, and review mutation", async () => {
      await assert.rejects(
        pool.query(
          `
            insert into ${quotedSchema}.sidestream_customer_identity_links (
              profile_id, license_namespace, link_type, link_value
            ) values ($1, 'test', 'support_code', 'side-A1B2-C3D4-E5F6')
          `,
          [stable.profile_id],
        ),
        postgresError("23514"),
      );
      await assert.rejects(
        pool.query(
          `
            insert into ${quotedSchema}.sidestream_customer_identity_links (
              profile_id, license_namespace, link_type, link_value
            ) values ($1, 'test', 'account_identity', $2)
          `,
          [stable.profile_id, randomUUID()],
        ),
        postgresError("23505"),
      );
      await assert.rejects(
        pool.query(
          `
            update ${quotedSchema}.sidestream_customer_identity_reviews
            set review_state = 'pending_review'
            where id = $1
          `,
          [reviewId],
        ),
        postgresError("55000"),
      );
      await assert.rejects(
        pool.query(
          `delete from ${quotedSchema}.sidestream_customer_identity_reviews where id = $1`,
          [reviewId],
        ),
        postgresError("55000"),
      );
    });
  } finally {
    if (schemaCreated) {
      await pool.query(`drop schema if exists ${quotedSchema} cascade`);
    }
    await pool.end();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

async function loadCustomerIdentityForSchema(schema, temporaryDirectory) {
  let source = rewritePublicSchema(await readFile(customerIdentityPath, "utf8"), schema);
  source = source.replaceAll(
    JSON.stringify("./license-environment.js"),
    JSON.stringify(pathToFileURL(
      join(repositoryRoot, "api", "_lib", "license-environment.ts"),
    ).href),
  );
  const modulePath = join(temporaryDirectory, "customer-identity-under-test.ts");
  await writeFile(modulePath, source, { mode: 0o600 });
  return import(`${pathToFileURL(modulePath).href}?schema=${schema}`);
}

async function attachCommitted(pool, identity, options) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await identity.attachCustomerIdentity(client, options);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function seedVerifiedAccount(pool, quotedSchema, label, options = {}) {
  const email = `${label}@example.com`;
  const displayName = `Verified ${label.toUpperCase()}`;
  const accountStripeCustomerId = `cus_identity_account_${label}`;
  const licenseStripeCustomerId = `cus_identity_license_${label}`;
  const checkoutSessionId = `cs_identity_${label}`;
  const paymentIntentId = `pi_identity_${label}`;
  const subscriptionId = `sub_identity_${label}`;
  const account = await pool.query(
    `
      insert into ${quotedSchema}.sidestream_accounts (
        google_sub, email, display_name, stripe_customer_id, created_at, updated_at
      ) values ($1, $2, $3, $4, now(), now())
      returning id
    `,
    [`google-identity-${label}`, email, displayName, accountStripeCustomerId],
  );
  const id = account.rows[0].id;
  await pool.query(
    `
      insert into ${quotedSchema}.sidestream_licenses (
        account_id, stripe_customer_id, stripe_subscription_id,
        stripe_checkout_session_id, stripe_payment_intent_id,
        plan_key, status, created_at, updated_at
      ) values ($1, $2, $3, $4, $5, 'sidestream_pro', 'active', now(), now())
    `,
    [
      id,
      licenseStripeCustomerId,
      subscriptionId,
      checkoutSessionId,
      paymentIntentId,
    ],
  );
  if (options.duplicateLicenseCustomer) {
    await pool.query(
      `
        insert into ${quotedSchema}.sidestream_licenses (
          account_id, stripe_customer_id, stripe_subscription_id,
          stripe_checkout_session_id, stripe_payment_intent_id,
          plan_key, status, created_at, updated_at
        ) values ($1, $2, $3, $4, $5, 'sidestream_pro', 'active', now(), now())
      `,
      [
        id,
        licenseStripeCustomerId,
        `sub_identity_${label}_duplicate`,
        `cs_identity_${label}_duplicate`,
        `pi_identity_${label}_duplicate`,
      ],
    );
  }
  return {
    id,
    email,
    displayName,
    accountStripeCustomerId,
    licenseStripeCustomerId,
    checkoutSessionId,
    paymentIntentId,
    subscriptionId,
  };
}

async function profileById(pool, quotedSchema, profileId) {
  const result = await pool.query(
    `
      select id, license_namespace, contact_email, display_name
      from ${quotedSchema}.sidestream_customer_profiles
      where id = $1
    `,
    [profileId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

async function identityValues(pool, quotedSchema, profileId) {
  const result = await pool.query(
    `
      select link_type, link_value
      from ${quotedSchema}.sidestream_customer_identity_links
      where profile_id = $1
      order by link_type, link_value
    `,
    [profileId],
  );
  return result.rows;
}

async function findInstall(pool, quotedSchema, namespace, installIdHash) {
  const result = await pool.query(
    `
      select profile_id
      from ${quotedSchema}.sidestream_customer_installs
      where license_namespace = $1 and install_id_hash = $2
    `,
    [namespace, installIdHash],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

async function latestActivationForProfile(pool, quotedSchema, profileId) {
  const result = await pool.query(
    `
      select link_value
      from ${quotedSchema}.sidestream_customer_identity_links
      where profile_id = $1 and link_type = 'activation_record'
      order by created_at desc, id desc
      limit 1
    `,
    [profileId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0].link_value;
}

async function profileCount(pool, quotedSchema) {
  const result = await pool.query(
    `select count(*)::int as count from ${quotedSchema}.sidestream_customer_profiles`,
  );
  return result.rows[0].count;
}

function evidenceHash(type, value) {
  return createHash("sha256").update(`${type}:${value}`).digest("hex");
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

function postgresError(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import {
  AnonymousInstallationClaimError,
  completeAnonymousInstallationClaim,
  createAnonymousInstallationClaim,
  getAnonymousInstallationClaimStatus,
  markAnonymousInstallationClaimBrowserOpened,
} from "../../api/_lib/anonymous-install-claim.ts";
import { createBrowserAcquisitionCookie } from "../../api/_lib/acquisition-cookie.ts";
import {
  addTrustedDeliveryEvidence,
  createCanonicalAcquisitionRoot,
  recordAcquisitionStage,
} from "../../api/_lib/acquisition-integrity.ts";
import {
  createAnonymousAcquisitionSession,
  recordAnonymousAcquisitionInstallerRequest,
} from "../../api/_lib/anonymous-acquisition.ts";
import { attachCustomerIdentity } from "../../api/_lib/customer-identity.ts";
import {
  createTestPoolOptions,
  requireSafeTestDatabaseUrl,
} from "../../scripts/run-postgres-integration.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migrations = [
  "20260715120000_add_customer_360_core.sql",
  "20260715121000_add_customer_identity_links.sql",
  "20260731120000_add_anonymous_acquisition_sessions.sql",
];
const acquisitionMigrations = [
  "20260713203000_add_checkout_intents.sql",
  "20260803120000_add_acquisition_integrity.sql",
];
const SECRET = "anonymous-install-claim-postgres-secret-minimum-32-bytes";
const INSTALL = "1".repeat(64);
const RECEIPT = "2".repeat(64);
const CONFLICT_INSTALL = "3".repeat(64);
const CONFLICT_RECEIPT = "4".repeat(64);
const UNKNOWN_INSTALL = "5".repeat(64);
const UNKNOWN_RECEIPT = "6".repeat(64);
const EXPIRED_INSTALL = "7".repeat(64);
const EXPIRED_RECEIPT = "8".repeat(64);
const LOST_INSTALL = "9".repeat(64);
const LOST_RECEIPT = "a".repeat(64);
const PROFILE_A = "00000000-0000-4000-8000-00000000000a";
const PROFILE_B = "00000000-0000-4000-8000-00000000000b";
const ACCOUNT = "10000000-0000-4000-8000-000000000001";
const LICENSE = "20000000-0000-4000-8000-000000000001";
const ACTIVATION = "30000000-0000-4000-8000-000000000001";
const DEVICE = "40000000-0000-4000-8000-000000000001";
const PAYMENT = "50000000-0000-4000-8000-000000000001";
const ENVIRONMENT = Object.freeze({ namespace: "test" });
const ACQUISITION_INTEGRITY = Object.freeze({
  addTrustedDeliveryEvidence,
  recordAcquisitionStage,
});

test("one-time anonymous installation claims are atomic, idempotent, private, and continuity-safe", {
  timeout: 120_000,
}, async () => {
  const databaseUrl = requireSafeTestDatabaseUrl(process.env);
  const schema = `sidestream_anonymous_claim_${randomBytes(8).toString("hex")}`;
  const quotedSchema = quoteIdentifier(schema);
  const pool = new Pool(createTestPoolOptions(databaseUrl));
  const transaction = createTransaction(pool, quotedSchema);
  let schemaCreated = false;

  try {
    await pool.query(`create schema ${quotedSchema}`);
    schemaCreated = true;
    for (const filename of migrations) {
      const sql = await readFile(join(repositoryRoot, "db/migrations", filename), "utf8");
      await pool.query(sql.replace(/\bpublic\./g, `${quotedSchema}.`));
    }
    await seedProtectedFixtures(pool, quotedSchema);
    await pool.query(`create table ${quotedSchema}.sidestream_activation_sessions (id uuid primary key)`);
    for (const filename of acquisitionMigrations) {
      const sql = await readFile(join(repositoryRoot, "db/migrations", filename), "utf8");
      await pool.query(sql.replace(/\bpublic\./g, `${quotedSchema}.`));
    }
    const protectedBefore = await protectedState(pool, quotedSchema);
    const now = new Date();

    const browser = await createCanonicalBrowser({
      transaction,
      firstSeenAt: now,
      attribution: {
        source: "reddit",
        medium: "social",
        campaign: "continuity",
      },
      reference: "primary-browser",
    });
    const browserToken = browser.token;
    await createAnonymousAcquisitionSession({
      token: browserToken,
      attribution: {
        source: "reddit",
        medium: "social",
        campaign: "continuity",
      },
      firstSeenAt: now,
    }, { transaction, namespace: "test" });
    await recordAnonymousAcquisitionInstallerRequest({
      token: browserToken,
      platform: "macos",
      requestedAt: new Date(now.getTime() + 1_000),
    }, { transaction, namespace: "test" });

    const claim = await createAnonymousInstallationClaim({
      installIdHash: INSTALL,
      installerReceiptIdHash: RECEIPT,
    }, {
      transaction,
      namespace: "test",
      secret: SECRET,
      now,
    });
    assert.equal(claim.nonce.includes(INSTALL), false);
    assert.equal(claim.nonce.includes(RECEIPT), false);
    assert.equal(claim.acknowledgmentHandle.includes(claim.nonce), false);
    assert.equal(claim.acknowledgmentHandle.includes(INSTALL), false);
    assert.equal(claim.acknowledgmentHandle.includes(RECEIPT), false);
    assert.deepEqual(await getAnonymousInstallationClaimStatus({
      acknowledgmentHandle: claim.acknowledgmentHandle,
    }, {
      transaction,
      namespace: "test",
      secret: SECRET,
      now: new Date(now.getTime() + 500),
    }), { state: "pending" });

    await markAnonymousInstallationClaimBrowserOpened({ nonce: claim.nonce }, {
      transaction,
      namespace: "test",
      secret: SECRET,
      now: new Date(now.getTime() + 1_000),
    });
    assert.deepEqual(await getAnonymousInstallationClaimStatus({
      acknowledgmentHandle: claim.acknowledgmentHandle,
    }, {
      transaction,
      namespace: "test",
      secret: SECRET,
      now: new Date(now.getTime() + 1_500),
    }), { state: "browser_opened" });

    const completed = await completeAnonymousInstallationClaim({
      nonce: claim.nonce,
      acquisitionId: browser.acquisitionId,
      acquisitionToken: browserToken,
    }, {
      transaction,
      namespace: "test",
      secret: SECRET,
      acquisitionIntegrity: ACQUISITION_INTEGRITY,
      now: new Date(now.getTime() + 2_000),
    });
    assert.equal(completed.outcome, "connected");
    assert.equal(completed.idempotent, false);
    assert.match(completed.profileId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(await getAnonymousInstallationClaimStatus({
      acknowledgmentHandle: claim.acknowledgmentHandle,
    }, {
      transaction,
      namespace: "test",
      secret: SECRET,
      now: new Date(now.getTime() + 2_500),
    }), { state: "claim_completed" });

    const duplicate = await completeAnonymousInstallationClaim({
      nonce: claim.nonce,
      acquisitionId: browser.acquisitionId,
      acquisitionToken: browserToken,
    }, {
      transaction,
      namespace: "test",
      secret: SECRET,
      acquisitionIntegrity: ACQUISITION_INTEGRITY,
      now: new Date(now.getTime() + 3_000),
    });
    assert.deepEqual(duplicate, {
      outcome: "connected",
      profileId: completed.profileId,
      idempotent: true,
    });
    assert.deepEqual(await Promise.all([
      getAnonymousInstallationClaimStatus({
        acknowledgmentHandle: claim.acknowledgmentHandle,
      }, {
        transaction,
        namespace: "test",
        secret: SECRET,
        now: new Date(now.getTime() + 3_500),
      }),
      getAnonymousInstallationClaimStatus({
        acknowledgmentHandle: claim.acknowledgmentHandle,
      }, {
        transaction,
        namespace: "test",
        secret: SECRET,
        now: new Date(now.getTime() + 3_600),
      }),
    ]), [
      { state: "claim_completed" },
      { state: "claim_completed" },
    ]);
    const canonicalClaim = await pool.query(
      `
        select stage, counting_grain, count(*)::int as count
        from ${quotedSchema}.sidestream_acquisition_stages
        where acquisition_id = $1 and stage = 'installation_claimed'
        group by stage, counting_grain
      `,
      [browser.acquisitionId],
    );
    assert.deepEqual(canonicalClaim.rows, [{
      stage: "installation_claimed",
      counting_grain: "installation",
      count: 1,
    }]);
    const canonicalEvidence = await pool.query(
      `select trusted_delivery_evidence from ${quotedSchema}.sidestream_acquisitions where id = $1`,
      [browser.acquisitionId],
    );
    assert.ok(canonicalEvidence.rows[0].trusted_delivery_evidence.includes(
      "verified_installation_claim",
    ));

    const linked = await pool.query(
      `
        select link_type, link_value
        from ${quotedSchema}.sidestream_customer_identity_links
        where profile_id = $1
        order by link_type
      `,
      [completed.profileId],
    );
    assert.deepEqual(linked.rows, [
      { link_type: "install_identity_hash", link_value: INSTALL },
      { link_type: "installer_receipt_hash", link_value: RECEIPT },
    ]);
    const anonymousProfile = await pool.query(
      `select contact_email, display_name from ${quotedSchema}.sidestream_customer_profiles where id = $1`,
      [completed.profileId],
    );
    assert.deepEqual(anonymousProfile.rows[0], { contact_email: null, display_name: null });

    const secondBrowser = await createCanonicalBrowser({
      transaction,
      firstSeenAt: now,
      reference: "second-browser",
    });
    const secondBrowserToken = secondBrowser.token;
    await createAnonymousAcquisitionSession({ token: secondBrowserToken, firstSeenAt: now }, {
      transaction,
      namespace: "test",
    });
    const reusedElsewhere = await completeAnonymousInstallationClaim({
      nonce: claim.nonce,
      acquisitionId: secondBrowser.acquisitionId,
      acquisitionToken: secondBrowserToken,
    }, {
      transaction,
      namespace: "test",
      secret: SECRET,
      acquisitionIntegrity: ACQUISITION_INTEGRITY,
      now: new Date(now.getTime() + 4_000),
    });
    assert.equal(reusedElsewhere.outcome, "conflict");
    const secondBrowserState = await acquisitionByToken(
      pool,
      quotedSchema,
      secondBrowserToken,
    );
    assert.equal(secondBrowserState.claim_state, "quarantined");
    assert.equal(secondBrowserState.claimed_profile_id, null);
    assert.deepEqual(await getAnonymousInstallationClaimStatus({
      acknowledgmentHandle: claim.acknowledgmentHandle,
    }, {
      transaction,
      namespace: "test",
      secret: SECRET,
      now: new Date(now.getTime() + 4_500),
    }), { state: "conflict" });

    const unknownClaim = await createAnonymousInstallationClaim({
      installIdHash: UNKNOWN_INSTALL,
      installerReceiptIdHash: UNKNOWN_RECEIPT,
    }, {
      transaction,
      namespace: "test",
      secret: SECRET,
      acquisitionIntegrity: ACQUISITION_INTEGRITY,
      now,
    });
    const unknown = await completeAnonymousInstallationClaim({
      nonce: unknownClaim.nonce,
      acquisitionId: browser.acquisitionId,
      acquisitionToken: "C".repeat(43),
    }, { transaction, namespace: "test", secret: SECRET, now });
    assert.deepEqual(unknown, { outcome: "unknown", profileId: null, idempotent: false });
    assert.equal(
      (await claimRowByMarker(pool, quotedSchema, UNKNOWN_INSTALL, UNKNOWN_RECEIPT)).claim_state,
      "unclaimed",
    );

    const expiredClaim = await createAnonymousInstallationClaim({
      installIdHash: EXPIRED_INSTALL,
      installerReceiptIdHash: EXPIRED_RECEIPT,
    }, { transaction, namespace: "test", secret: SECRET, now });
    await assert.rejects(
      completeAnonymousInstallationClaim({
        nonce: expiredClaim.nonce,
        acquisitionId: browser.acquisitionId,
        acquisitionToken: browserToken,
      }, {
        transaction,
        namespace: "test",
        secret: SECRET,
        acquisitionIntegrity: ACQUISITION_INTEGRITY,
        now: new Date(now.getTime() + 15 * 60 * 1000),
      }),
      (error) => error instanceof AnonymousInstallationClaimError &&
        error.code === "claim_expired",
    );
    assert.equal(
      (await claimRowByMarker(pool, quotedSchema, EXPIRED_INSTALL, EXPIRED_RECEIPT)).claim_state,
      "unclaimed",
    );
    assert.deepEqual(await getAnonymousInstallationClaimStatus({
      acknowledgmentHandle: expiredClaim.acknowledgmentHandle,
    }, {
      transaction,
      namespace: "test",
      secret: SECRET,
      now: new Date(now.getTime() + 15 * 60 * 1000),
    }), { state: "expired" });

    const lostClaim = await createAnonymousInstallationClaim({
      installIdHash: LOST_INSTALL,
      installerReceiptIdHash: LOST_RECEIPT,
    }, {
      transaction,
      namespace: "test",
      secret: SECRET,
      acquisitionIntegrity: ACQUISITION_INTEGRITY,
      now,
    });
    await pool.query(`
      delete from ${quotedSchema}.sidestream_anonymous_acquisition_sessions
      where id = (
        select id
        from ${quotedSchema}.sidestream_anonymous_acquisition_sessions
        where license_namespace = 'test'
          and first_touch_medium = 'installation_claim'
          and claim_state = 'unclaimed'
        order by created_at desc, id desc
        limit 1
      )
    `);
    assert.deepEqual(await getAnonymousInstallationClaimStatus({
      acknowledgmentHandle: lostClaim.acknowledgmentHandle,
    }, { transaction, namespace: "test", secret: SECRET, now }), {
      state: "terminal_unknown",
    });

    await seedConflictingIdentityOwners(pool, quotedSchema);
    const conflictCookie = await createCanonicalBrowser({
      transaction,
      firstSeenAt: now,
      reference: "conflict-browser",
    });
    const conflictBrowser = conflictCookie.token;
    await createAnonymousAcquisitionSession({ token: conflictBrowser, firstSeenAt: now }, {
      transaction,
      namespace: "test",
    });
    const conflictClaim = await createAnonymousInstallationClaim({
      installIdHash: CONFLICT_INSTALL,
      installerReceiptIdHash: CONFLICT_RECEIPT,
    }, { transaction, namespace: "test", secret: SECRET, now });
    const conflict = await completeAnonymousInstallationClaim({
      nonce: conflictClaim.nonce,
      acquisitionId: conflictCookie.acquisitionId,
      acquisitionToken: conflictBrowser,
    }, { transaction, namespace: "test", secret: SECRET, now });
    assert.equal(conflict.outcome, "conflict");
    assert.equal((await acquisitionByToken(pool, quotedSchema, conflictBrowser)).claim_state, "quarantined");
    assert.deepEqual(await getAnonymousInstallationClaimStatus({
      acknowledgmentHandle: conflictClaim.acknowledgmentHandle,
    }, { transaction, namespace: "test", secret: SECRET, now }), { state: "conflict" });
    const conflictEvidence = await pool.query(
      `select count(*)::int as count from ${quotedSchema}.sidestream_anonymous_acquisition_conflicts`,
    );
    assert.ok(conflictEvidence.rows[0].count >= 3);

    for (const source of ["activation_claim", "license_verify", "license_refresh"]) {
      const attached = await transaction((client) => attachCustomerIdentity(client, {
        environment: ENVIRONMENT,
        identity: {
          installIdHash: INSTALL,
          installerReceiptIdHash: RECEIPT,
        },
        activationId: ACTIVATION,
        accountId: ACCOUNT,
        source,
      }));
      assert.deepEqual(attached, {
        profileId: completed.profileId,
        attached: true,
        reviewRequired: false,
      });
    }
    const continuousProfile = await pool.query(
      `
        select contact_email, display_name
        from ${quotedSchema}.sidestream_customer_profiles
        where id = $1 and merged_into is null
      `,
      [completed.profileId],
    );
    assert.deepEqual(continuousProfile.rows[0], {
      contact_email: "customer@example.com",
      display_name: "Customer",
    });
    const verifiedLinks = await pool.query(
      `
        select link_type, link_value
        from ${quotedSchema}.sidestream_customer_identity_links
        where profile_id = $1
          and link_type in (
            'account_identity', 'activation_record', 'stripe_customer',
            'stripe_checkout_session', 'stripe_payment_intent'
          )
        order by link_type
      `,
      [completed.profileId],
    );
    assert.deepEqual(verifiedLinks.rows, [
      { link_type: "account_identity", link_value: ACCOUNT },
      { link_type: "activation_record", link_value: ACTIVATION },
      { link_type: "stripe_checkout_session", link_value: "cs_verified_continuity" },
      { link_type: "stripe_customer", link_value: "cus_verified_continuity" },
      { link_type: "stripe_payment_intent", link_value: "pi_verified_continuity" },
    ]);

    assert.deepEqual(await protectedState(pool, quotedSchema), protectedBefore);
    const claimRows = await pool.query(
      `
        select token_hash, first_touch_source, first_touch_medium
        from ${quotedSchema}.sidestream_anonymous_acquisition_sessions
        where first_touch_medium = 'installation_claim'
      `,
    );
    assert.ok(claimRows.rows.length >= 4);
    assert.equal(JSON.stringify(claimRows.rows).includes(INSTALL), false);
    assert.equal(JSON.stringify(claimRows.rows).includes(RECEIPT), false);
  } finally {
    if (schemaCreated) await pool.query(`drop schema if exists ${quotedSchema} cascade`);
    await pool.end();
  }
});

async function seedProtectedFixtures(pool, quotedSchema) {
  await pool.query(`
    create table ${quotedSchema}.sidestream_accounts (
      id uuid primary key,
      email text not null,
      display_name text,
      stripe_customer_id text
    );
    create table ${quotedSchema}.sidestream_licenses (
      id uuid primary key,
      account_id uuid not null,
      stripe_customer_id text,
      stripe_checkout_session_id text,
      stripe_payment_intent_id text,
      stripe_subscription_id text,
      entitlement_status text not null,
      created_at timestamptz not null
    );
    create table ${quotedSchema}.sidestream_account_devices (
      id uuid primary key,
      account_id uuid not null,
      device_state text not null
    );
    create table ${quotedSchema}.sidestream_payment_guard (
      id uuid primary key,
      account_id uuid not null,
      amount_minor integer not null,
      state text not null
    );
    insert into ${quotedSchema}.sidestream_accounts values
      ('${ACCOUNT}', 'customer@example.com', 'Customer', 'cus_verified_continuity');
    insert into ${quotedSchema}.sidestream_licenses values (
      '${LICENSE}', '${ACCOUNT}', 'cus_verified_continuity',
      'cs_verified_continuity', 'pi_verified_continuity', null,
      'active', now()
    );
    insert into ${quotedSchema}.sidestream_account_devices values
      ('${DEVICE}', '${ACCOUNT}', 'active');
    insert into ${quotedSchema}.sidestream_payment_guard values
      ('${PAYMENT}', '${ACCOUNT}', 1999, 'paid');
  `);
}

async function seedConflictingIdentityOwners(pool, quotedSchema) {
  await pool.query(`
    insert into ${quotedSchema}.sidestream_customer_profiles (
      id, license_namespace, created_at, updated_at
    ) values
      ('${PROFILE_A}', 'test', now(), now()),
      ('${PROFILE_B}', 'test', now(), now());
    insert into ${quotedSchema}.sidestream_customer_identity_links (
      profile_id, license_namespace, link_type, link_value
    ) values
      ('${PROFILE_A}', 'test', 'install_identity_hash', '${CONFLICT_INSTALL}'),
      ('${PROFILE_B}', 'test', 'installer_receipt_hash', '${CONFLICT_RECEIPT}');
    insert into ${quotedSchema}.sidestream_customer_installs (
      profile_id, license_namespace, install_id_hash
    ) values ('${PROFILE_A}', 'test', '${CONFLICT_INSTALL}');
  `);
}

async function protectedState(pool, quotedSchema) {
  const result = await pool.query(`
    select
      (select json_agg(row_to_json(account) order by account.id)
        from ${quotedSchema}.sidestream_accounts account) as accounts,
      (select json_agg(row_to_json(license) order by license.id)
        from ${quotedSchema}.sidestream_licenses license) as licenses,
      (select json_agg(row_to_json(device) order by device.id)
        from ${quotedSchema}.sidestream_account_devices device) as devices,
      (select json_agg(row_to_json(payment) order by payment.id)
        from ${quotedSchema}.sidestream_payment_guard payment) as payments
  `);
  return result.rows[0];
}

async function acquisitionByToken(pool, quotedSchema, token) {
  const { createHash } = await import("node:crypto");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const result = await pool.query(
    `
      select claim_state, claimed_profile_id
      from ${quotedSchema}.sidestream_anonymous_acquisition_sessions
      where license_namespace = 'test' and token_hash = $1
    `,
    [tokenHash],
  );
  return result.rows[0];
}

async function createCanonicalBrowser({
  transaction,
  firstSeenAt,
  reference,
  attribution = undefined,
}) {
  const cookie = createBrowserAcquisitionCookie({ attribution }, {
    secret: SECRET,
    now: firstSeenAt,
  });
  const direct = !attribution || attribution.source === "direct";
  await createCanonicalAcquisitionRoot({
    acquisitionId: cookie.acquisitionId,
    firstObservedAt: firstSeenAt,
    landingDeduplicationReference: reference,
    ...(direct ? {} : {
      source: attribution.source,
      medium: attribution.medium ?? null,
      campaign: attribution.campaign ?? null,
      externalReferrerCategory: "social",
    }),
  }, { transaction, namespace: "test" });
  return cookie;
}

async function claimRowByMarker(pool, quotedSchema, installIdHash, receiptIdHash) {
  // The opaque claim row intentionally stores neither hash. Selecting the most
  // recent unclaimed marker is sufficient here because each fixture is created
  // and inspected before another unclaimed claim is added.
  void installIdHash;
  void receiptIdHash;
  const result = await pool.query(`
    select claim_state
    from ${quotedSchema}.sidestream_anonymous_acquisition_sessions
    where license_namespace = 'test'
      and first_touch_source = 'direct'
      and first_touch_medium = 'installation_claim'
    order by created_at desc, id desc
    limit 1
  `);
  return result.rows[0];
}

function createTransaction(pool, quotedSchema) {
  return async (callback) => {
    const client = await pool.connect();
    const scoped = {
      query: (sql, params = []) => client.query(
        sql.replace(/\bpublic\./g, `${quotedSchema}.`),
        params,
      ),
    };
    try {
      await client.query("begin");
      const result = await callback(scoped);
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

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new TypeError("Unsafe schema");
  return `"${identifier}"`;
}

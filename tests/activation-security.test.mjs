import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";
import {
  createClaimCsrfToken,
  getStripeCheckoutWindow,
  verifyPaidCheckoutSession,
} from "../api/_lib/entitlement.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationsDirectory = join(repositoryRoot, "db", "migrations");
const accountSourcePath = join(repositoryRoot, "api", "_lib", "account.ts");
const TEST_SECRET = "activation-security-test-secret-with-32-bytes";
const CONTROLLED_ENVIRONMENT = [
  "SIDESTREAM_POSTGRES_URL",
  "SIDESTREAM_POSTGRES_PRISMA_URL",
  "SIDESTREAM_POSTGRES_URL_NON_POOLING",
  "SIDESTREAM_TEST_POSTGRES_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
  "SIDESTREAM_LICENSE_HASH_SECRET",
  "SIDESTREAM_LICENSE_NAMESPACE",
  "SIDESTREAM_PRODUCTION_API_HOSTS",
  "SIDESTREAM_TEST_API_HOSTS",
  "SIDESTREAM_DEVICE_POLICY_MODE",
  "SIDESTREAM_BASE_URL",
  "PUBLIC_BASE_URL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "POSTGRES_SSL",
  "POSTGRES_POOL_MAX",
];

test("activation, claim, Checkout, and credential invariants execute against Postgres", {
  timeout: 120_000,
}, async (t) => {
  const environmentSnapshot = snapshotEnvironment(CONTROLLED_ENVIRONMENT);
  const postgres = await startEphemeralPostgres();
  const databasePool = new Pool({
    connectionString: postgres.connectionString,
    max: 12,
    ssl: false,
  });
  let runtimeModules;

  try {
    await applyMigrations(databasePool);
    configureRuntime(postgres.connectionString);
    runtimeModules = await loadRuntimeModules();
    const { account, claimHandler, startHandler, statusHandler } = runtimeModules;
    const environment = account.resolveRequestLicenseEnvironment({
      headers: { host: "sidestream.tv" },
    });
    assert.equal(environment?.namespace, "production");

    const checkoutSessions = new Map();
    let checkoutRetrievals = 0;
    account.__setActivationSecurityStripeClient({
      checkout: {
        sessions: {
          async retrieve(sessionId) {
            checkoutRetrievals += 1;
            const session = checkoutSessions.get(sessionId);
            if (!session) throw new Error(`Unexpected Checkout retrieval: ${sessionId}`);
            return session;
          },
        },
      },
      paymentIntents: {
        async retrieve(paymentIntentId) {
          const session = [...checkoutSessions.values()].find(
            (candidate) => candidate.payment_intent === paymentIntentId,
          );
          if (!session) throw new Error(`Unexpected PaymentIntent retrieval: ${paymentIntentId}`);
          return {
            id: paymentIntentId,
            customer: session.customer,
            amount_received: 999,
            currency: "usd",
            status: "succeeded",
            latest_charge: `ch_${paymentIntentId.slice(3)}`,
          };
        },
      },
      charges: {
        async retrieve(chargeId) {
          const paymentIntentId = `pi_${chargeId.slice(3)}`;
          const session = [...checkoutSessions.values()].find(
            (candidate) => candidate.payment_intent === paymentIntentId,
          );
          if (!session) throw new Error(`Unexpected Charge retrieval: ${chargeId}`);
          return {
            id: chargeId,
            customer: session.customer,
            payment_intent: paymentIntentId,
            currency: "usd",
            amount_refunded: 0,
            paid: true,
            disputed: false,
          };
        },
      },
      disputes: {
        async list() {
          return { data: [], has_more: false };
        },
      },
    });

    await t.test("attacker-link and signed-in restore GETs are strictly read-only", async () => {
      const owner = await seedAccount(databasePool, "claim-get-owner");
      const attacker = await seedAccount(databasePool, "claim-get-attacker");
      const activation = await seedActivation(databasePool, {
        label: "claim-get",
        deviceId: "claim-get-device",
      });

      const anonymous = await invokeHandler(claimHandler, {
        method: "GET",
        url: `/api/activation/claim?activation=${activation.activationKey}`,
        headers: requestHeaders(),
      });
      assert.equal(anonymous.statusCode, 302);
      assert.match(
        anonymous.headers.location,
        /^https:\/\/sidestream\.tv\/api\/auth\/google\/start\?next=/,
      );
      assert.match(
        decodeURIComponent(anonymous.headers.location),
        /\/api\/activation\/claim\?activation=activation-claim-get/,
      );

      const signedIn = await invokeHandler(claimHandler, {
        method: "GET",
        url: `/api/activation/claim?activation=${activation.activationKey}`,
        headers: requestHeaders({ cookie: sessionCookie(owner) }),
      });
      assert.equal(signedIn.statusCode, 200);
      assert.equal(signedIn.headers["cache-control"], "no-store");
      assert.match(signedIn.body, /Connect Sidestream Unlimited to this device/);
      assert.match(signedIn.body, /name="csrf"/);

      const afterGets = await activationState(databasePool, activation.activationKey);
      assert.deepEqual(afterGets, { account_id: null, status: "pending" });

      await databasePool.query(
        `update public.sidestream_activation_sessions set account_id = $2 where activation_key = $1`,
        [activation.activationKey, owner.accountId],
      );
      const crossAccountGet = await invokeHandler(claimHandler, {
        method: "GET",
        url: `/api/activation/claim?activation=${activation.activationKey}`,
        headers: requestHeaders({ cookie: sessionCookie(attacker) }),
      });
      assert.equal(crossAccountGet.statusCode, 409);
      assert.deepEqual(await activationState(databasePool, activation.activationKey), {
        account_id: owner.accountId,
        status: "pending",
      });
    });

    await t.test("claim POST rejects origin, media type, malformed, expired, and wrong-account tokens", async () => {
      const owner = await seedAccount(databasePool, "claim-post-owner");
      const other = await seedAccount(databasePool, "claim-post-other");
      const activation = await seedActivation(databasePool, {
        label: "claim-post",
        deviceId: "claim-post-device",
      });
      const validToken = account.createActivationClaimCsrf(
        activation.activationKey,
        owner.accountId,
      );
      const nowSeconds = Math.floor(Date.now() / 1000);
      const invalidTokens = [
        "malformed",
        createClaimCsrfToken({
          activationKey: activation.activationKey,
          accountId: owner.accountId,
          expiresAtSeconds: nowSeconds - 1,
          secret: TEST_SECRET,
        }),
        createClaimCsrfToken({
          activationKey: activation.activationKey,
          accountId: other.accountId,
          expiresAtSeconds: nowSeconds + 300,
          secret: TEST_SECRET,
        }),
      ];

      const rejectedRequests = [
        {
          origin: "https://attacker.example",
          contentType: "application/x-www-form-urlencoded",
          token: validToken,
        },
        {
          origin: "https://sidestream.tv",
          contentType: "application/json",
          token: validToken,
        },
        {
          origin: "https://sidestream.tv",
          contentType: "application/x-www-form-urlencoded.attacker",
          token: validToken,
        },
        ...invalidTokens.map((token) => ({
          origin: "https://sidestream.tv",
          contentType: "application/x-www-form-urlencoded",
          token,
        })),
      ];

      for (const rejected of rejectedRequests) {
        const response = await invokeHandler(claimHandler, {
          method: "POST",
          url: "/api/activation/claim",
          headers: requestHeaders({
            cookie: sessionCookie(owner),
            origin: rejected.origin,
            contentType: rejected.contentType,
          }),
          body: claimForm(activation.activationKey, rejected.token),
        });
        assert.equal(response.statusCode, 403);
        assert.equal(JSON.parse(response.body).code, "csrf_rejected");
        assert.deepEqual(await activationState(databasePool, activation.activationKey), {
          account_id: null,
          status: "pending",
        });
      }

      const accepted = await invokeHandler(claimHandler, {
        method: "POST",
        url: "/api/activation/claim",
        headers: requestHeaders({
          cookie: sessionCookie(owner),
          origin: "https://sidestream.tv",
          contentType: "application/x-www-form-urlencoded; charset=UTF-8",
        }),
        body: claimForm(activation.activationKey, validToken),
      });
      assert.equal(accepted.statusCode, 303);
      assert.match(accepted.headers.location, /connection=restored/);
      assert.deepEqual(await activationState(databasePool, activation.activationKey), {
        account_id: owner.accountId,
        status: "restored",
      });
    });

    await t.test("concurrent cross-account claims elect one winner and never overwrite it", async () => {
      const accountA = await seedAccount(databasePool, "claim-race-a");
      const accountB = await seedAccount(databasePool, "claim-race-b");
      const activation = await seedActivation(databasePool, {
        label: "claim-race",
        deviceId: "claim-race-device",
      });

      const attempts = await Promise.all([
        account.claimActivationToAccount(activation.activationKey, accountA.accountId),
        account.claimActivationToAccount(activation.activationKey, accountB.accountId),
      ]);
      assert.equal(attempts.filter((attempt) => attempt.claimed).length, 1);
      const winnerIndex = attempts.findIndex((attempt) => attempt.claimed);
      const winner = winnerIndex === 0 ? accountA : accountB;
      const loser = winnerIndex === 0 ? accountB : accountA;
      assert.deepEqual(await activationState(databasePool, activation.activationKey), {
        account_id: winner.accountId,
        status: "restored",
      });

      const overwrite = await account.claimActivationToAccount(
        activation.activationKey,
        loser.accountId,
      );
      assert.equal(overwrite.claimed, false);
      assert.equal(
        (await activationState(databasePool, activation.activationKey)).account_id,
        winner.accountId,
      );
    });

    await t.test("Checkout attachment is an immutable exact tuple under retries and races", async () => {
      const activation = await seedActivation(databasePool, {
        label: "checkout-attachment",
        deviceId: "checkout-attachment-device",
        expiresInSeconds: 7_200,
      });
      const attachment = checkoutAttachment("attachment-a", activation.activationKey);
      assert.equal(await account.attachCheckoutSessionToActivation(attachment), true);
      assert.equal(await account.attachCheckoutSessionToActivation(attachment), true);
      assert.equal(await account.attachCheckoutSessionToActivation({
        ...attachment,
        priceId: "price_overwrite",
      }), false);
      assert.equal(await account.attachCheckoutSessionToActivation({
        ...attachment,
        productId: "prod_overwrite",
      }), false);
      assert.equal(await account.attachCheckoutSessionToActivation({
        ...attachment,
        checkoutExpiresAt: attachment.checkoutExpiresAt + 1,
      }), false);
      assert.equal(await account.attachCheckoutSessionToActivation({
        ...attachment,
        claimGraceUntil: new Date(
          new Date(attachment.claimGraceUntil).getTime() + 1_000,
        ).toISOString(),
      }), false);
      assert.equal(await account.attachCheckoutSessionToActivation({
        ...attachment,
        checkoutSessionId: "cs_overwrite",
      }), false);
      assert.deepEqual(await attachedCheckout(databasePool, activation.activationKey), {
        stripe_checkout_session_id: attachment.checkoutSessionId,
        stripe_checkout_price_id: attachment.priceId,
        stripe_checkout_product_id: attachment.productId,
        stripe_checkout_expires_at: new Date(attachment.checkoutExpiresAt * 1_000),
        checkout_claim_grace_until: new Date(attachment.claimGraceUntil),
      });

      const racedActivation = await seedActivation(databasePool, {
        label: "checkout-attachment-race",
        deviceId: "checkout-attachment-race-device",
        expiresInSeconds: 7_200,
      });
      const candidates = [
        checkoutAttachment("attachment-race-a", racedActivation.activationKey),
        checkoutAttachment("attachment-race-b", racedActivation.activationKey),
      ];
      const results = await Promise.all(
        candidates.map((candidate) => account.attachCheckoutSessionToActivation(candidate)),
      );
      assert.equal(results.filter(Boolean).length, 1);
      const winningAttachment = candidates[results.findIndex(Boolean)];
      assert.equal(
        (await attachedCheckout(databasePool, racedActivation.activationKey))
          .stripe_checkout_session_id,
        winningAttachment.checkoutSessionId,
      );
    });

    await t.test("paid Checkout verification is exact and grace expiry cannot bind an activation", async () => {
      const exactSession = checkoutSession("exact", "activation-exact");
      const expected = {
        sessionId: exactSession.id,
        activationKey: "activation-exact",
        priceId: "price_exact",
        productId: "prod_exact",
        paidPlanKeys: ["sidestream_pro", "sidestream_unlimited"],
      };
      assert.deepEqual(verifyPaidCheckoutSession(exactSession, expected), { ok: true });
      const rejected = [
        [{ ...exactSession, mode: "subscription" }, "invalid_checkout_mode"],
        [{ ...exactSession, status: "open" }, "checkout_incomplete"],
        [{
          ...exactSession,
          metadata: { ...exactSession.metadata, sidestream_plan: "wrong" },
        }, "invalid_plan"],
        [{
          ...exactSession,
          metadata: { ...exactSession.metadata, sidestream_price_id: "price_wrong" },
        }, "metadata_price_mismatch"],
        [{
          ...exactSession,
          line_items: { data: [{ quantity: 2, price: { id: "price_exact", product: "prod_exact" } }] },
        }, "invalid_quantity"],
        [{
          ...exactSession,
          line_items: { data: [{ quantity: 1, price: { id: "price_wrong", product: "prod_exact" } }] },
        }, "line_item_price_mismatch"],
        [{
          ...exactSession,
          line_items: { data: [{ quantity: 1, price: { id: "price_exact", product: "prod_wrong" } }] },
        }, "line_item_product_mismatch"],
      ];
      for (const [session, reason] of rejected) {
        assert.equal(verifyPaidCheckoutSession(session, expected).reason, reason);
      }

      const activationExpiry = Date.now() + 7_200_999;
      const checkoutWindow = getStripeCheckoutWindow(activationExpiry, 600);
      assert.equal(
        new Date(checkoutWindow.claimGraceUntil).getTime() -
          checkoutWindow.checkoutExpiresAt * 1_000,
        600_000,
      );
      assert.ok(new Date(checkoutWindow.claimGraceUntil).getTime() <= activationExpiry);

      const buyer = await seedAccount(databasePool, "checkout-grace-buyer");
      const liveActivation = await seedActivation(databasePool, {
        label: "checkout-grace-live",
        deviceId: "checkout-grace-live-device",
        expiresInSeconds: 7_200,
      });
      const liveAttachment = checkoutAttachment("grace-live", liveActivation.activationKey);
      assert.equal(await account.attachCheckoutSessionToActivation(liveAttachment), true);
      const liveIntentId = await seedCheckoutOfferIntent(databasePool, {
        label: "grace-live",
        accountId: buyer.accountId,
        activationId: liveActivation.activationId,
        checkoutSessionId: liveAttachment.checkoutSessionId,
        priceId: liveAttachment.priceId,
        productId: liveAttachment.productId,
      });
      checkoutSessions.set(
        liveAttachment.checkoutSessionId,
        checkoutSession(
          "grace-live",
          liveActivation.activationKey,
          buyer,
          liveIntentId,
        ),
      );
      assert.deepEqual(
        await account.fulfillCheckoutSession(
          liveAttachment.checkoutSessionId,
          liveActivation.activationKey,
        ),
        { fulfilled: true, activationBound: true, paidAcquisition: false },
      );
      assert.equal(
        (await activationState(databasePool, liveActivation.activationKey)).account_id,
        buyer.accountId,
      );

      const expiredActivation = await seedExpiredCheckoutActivation(databasePool, {
        label: "checkout-grace-expired",
        deviceId: "checkout-grace-expired-device",
      });
      const expiredBuyer = await seedAccount(databasePool, "checkout-grace-expired-buyer");
      const expiredIntentId = await seedCheckoutOfferIntent(databasePool, {
        label: "checkout-grace-expired",
        accountId: expiredBuyer.accountId,
        activationId: expiredActivation.activationId,
        checkoutSessionId: expiredActivation.checkoutSessionId,
        priceId: "price_checkout-grace-expired",
        productId: "prod_checkout-grace-expired",
      });
      checkoutSessions.set(
        expiredActivation.checkoutSessionId,
        checkoutSession(
          "checkout-grace-expired",
          expiredActivation.activationKey,
          expiredBuyer,
          expiredIntentId,
        ),
      );
      assert.deepEqual(
        await account.fulfillCheckoutSession(
          expiredActivation.checkoutSessionId,
          expiredActivation.activationKey,
        ),
        { fulfilled: true, activationBound: false, paidAcquisition: false },
      );
      assert.equal(
        (await activationState(databasePool, expiredActivation.activationKey)).account_id,
        null,
      );
    });

    await t.test("device identity is checked before any status reconciliation attempt", async () => {
      const activation = await seedActivation(databasePool, {
        label: "reconciliation-device-check",
        deviceId: "expected-reconciliation-device",
        expiresInSeconds: 7_200,
      });
      const attachment = checkoutAttachment(
        "reconciliation-device-check",
        activation.activationKey,
      );
      assert.equal(await account.attachCheckoutSessionToActivation(attachment), true);
      checkoutSessions.set(
        attachment.checkoutSessionId,
        checkoutSession("reconciliation-device-check", activation.activationKey),
      );
      const beforeRetrievals = checkoutRetrievals;
      const result = await account.getActivationStatus(
        activation.activationKey,
        "attacker-reconciliation-device",
        { environment },
      );
      assert.deepEqual(result, { status: "device_mismatch" });
      assert.equal(checkoutRetrievals, beforeRetrievals);
      const reconciliation = await databasePool.query(
        `select reconciliation_last_attempt_at from public.sidestream_activation_sessions where id = $1`,
        [activation.activationId],
      );
      assert.equal(reconciliation.rows[0].reconciliation_last_attempt_at, null);
    });

    let currentCredentials;
    let currentFixture;
    await t.test("concurrent current-client polls mint one family and replay it for ten minutes", async () => {
      const buyer = await seedAccount(databasePool, "current-status-buyer");
      const activation = await seedActivation(databasePool, {
        label: "current-status",
        deviceId: "current-status-device",
        accountId: buyer.accountId,
        licenseId: buyer.licenseId,
        status: "paid",
        appVersion: "1.0.14",
      });
      const polls = await Promise.all([
        account.getActivationStatus(activation.activationKey, "current-status-device", {
          skipReconciliation: true,
          environment,
          platform: "macos",
        }),
        account.getActivationStatus(activation.activationKey, "current-status-device", {
          skipReconciliation: true,
          environment,
          platform: "macos",
        }),
      ]);
      assert.equal(polls.every((poll) => poll.status === "active"), true);
      assert.equal(polls[0].licenseToken, polls[1].licenseToken);
      assert.equal(polls[0].refreshToken, polls[1].refreshToken);
      assert.equal(typeof polls[0].tokenExpiresAt, "string");
      assert.equal(typeof polls[0].refreshExpiresAt, "string");
      assert.equal(await liveCredentialFamilies(databasePool, activation.activationId), 1);
      currentCredentials = polls[0];
      currentFixture = { buyer, activation };

      await assert.rejects(
        databasePool.query(
          `
            insert into public.sidestream_license_tokens (
              account_id, license_id, activation_session_id, device_id_hash,
              token_hash, expires_at, refresh_token_hash, refresh_expires_at
            ) values ($1, $2, $3, $4, $5, now() + interval '7 days', $6, now() + interval '365 days')
          `,
          [
            buyer.accountId,
            buyer.licenseId,
            activation.activationId,
            privateIdentifierHash("current-status-device"),
            tokenHash("duplicate-access-family"),
            tokenHash("duplicate-refresh-family"),
          ],
        ),
        (error) => error?.code === "23505",
      );

      await databasePool.query(
        `
          update public.sidestream_account_devices
          set activated_at = now() - interval '20 minutes'
          where account_id = $1 and license_namespace = 'production' and revoked_at is null
        `,
        [buyer.accountId],
      );
      await databasePool.query(
        `update public.sidestream_activation_sessions set completed_at = now() - interval '9 minutes' where id = $1`,
        [activation.activationId],
      );
      const replay = await account.getActivationStatus(
        activation.activationKey,
        "current-status-device",
        { skipReconciliation: true, environment, platform: "macos" },
      );
      assert.equal(replay.status, "active");
      assert.equal(replay.licenseToken, polls[0].licenseToken);
      assert.equal(replay.refreshToken, polls[0].refreshToken);

      await databasePool.query(
        `update public.sidestream_activation_sessions set completed_at = now() - interval '11 minutes' where id = $1`,
        [activation.activationId],
      );
      const terminal = await account.getActivationStatus(
        activation.activationKey,
        "current-status-device",
        { skipReconciliation: true, environment, platform: "macos" },
      );
      assert.equal(terminal.status, "completed");
      assert.equal("licenseToken" in terminal, false);

      const index = await databasePool.query(
        `select indexdef from pg_indexes where schemaname = 'public' and indexname = 'sidestream_license_tokens_one_live_activation_device'`,
      );
      assert.match(index.rows[0].indexdef, /UNIQUE INDEX/);
      assert.match(index.rows[0].indexdef, /revoked_at IS NULL/);
    });

    await t.test("the installed legacy activation URL and stable response fields remain compatible", async () => {
      const started = await invokeHandler(startHandler, {
        method: "POST",
        url: "/api/activation/start",
        headers: requestHeaders({
          host: "sidestream-xi.vercel.app",
          contentType: "application/json",
        }),
        body: JSON.stringify({
          deviceId: "legacy-route-device",
          appVersion: "1.0.12",
          buildChannel: "stable",
          source: "plugin",
        }),
      });
      assert.equal(started.statusCode, 200);
      const activationResponse = JSON.parse(started.body);
      assert.deepEqual(Object.keys(activationResponse).sort(), [
        "activationKey",
        "expiresAt",
        "restoreUrl",
        "upgradeUrl",
      ]);
      assert.equal(
        activationResponse.upgradeUrl,
        `https://sidestream-xi.vercel.app/api/checkout/start?activation=${activationResponse.activationKey}`,
      );
      assert.equal(
        activationResponse.restoreUrl,
        `https://sidestream-xi.vercel.app/api/activation/claim?activation=${activationResponse.activationKey}`,
      );

      const buyer = await seedAccount(databasePool, "legacy-route-buyer");
      await databasePool.query(
        `
          update public.sidestream_activation_sessions
          set account_id = $2, license_id = $3, status = 'paid'
          where activation_key = $1
        `,
        [activationResponse.activationKey, buyer.accountId, buyer.licenseId],
      );
      const first = await invokeHandler(statusHandler, {
        method: "POST",
        url: "/api/activation/status",
        headers: requestHeaders({
          host: "sidestream-xi.vercel.app",
          contentType: "application/json",
        }),
        body: JSON.stringify({
          activationKey: activationResponse.activationKey,
          deviceId: "legacy-route-device",
        }),
      });
      assert.equal(first.statusCode, 200);
      const firstStatus = JSON.parse(first.body);
      for (const field of [
        "status",
        "license",
        "licenseToken",
        "refreshToken",
        "tokenExpiresAt",
        "refreshExpiresAt",
      ]) {
        assert.equal(field in firstStatus, true, `missing legacy response field ${field}`);
      }
      assert.equal(firstStatus.status, "active");

      await databasePool.query(
        `
          update public.sidestream_account_devices
          set activated_at = now() - interval '3 hours'
          where account_id = $1 and license_namespace = 'production' and revoked_at is null
        `,
        [buyer.accountId],
      );
      await databasePool.query(
        `update public.sidestream_activation_sessions set completed_at = now() - interval '2 hours' where activation_key = $1`,
        [activationResponse.activationKey],
      );
      const replay = await invokeHandler(statusHandler, {
        method: "POST",
        url: "/api/activation/status",
        headers: requestHeaders({
          host: "sidestream-xi.vercel.app",
          contentType: "application/json",
        }),
        body: JSON.stringify({
          activationKey: activationResponse.activationKey,
          deviceId: "legacy-route-device",
        }),
      });
      const replayStatus = JSON.parse(replay.body);
      assert.equal(replayStatus.status, "active");
      assert.equal(replayStatus.licenseToken, firstStatus.licenseToken);
      assert.equal(replayStatus.refreshToken, firstStatus.refreshToken);
    });

    await t.test("verify and refresh stay device-bound and rotation has one replay-safe live family", async () => {
      assert.ok(currentCredentials && currentFixture);
      const wrongVerify = await account.verifyLicenseToken(
        currentCredentials.licenseToken,
        "wrong-current-device",
        environment,
      );
      assert.equal(wrongVerify.code, "device_mismatch");
      const wrongRefresh = await account.refreshLicenseToken(
        currentCredentials.refreshToken,
        "wrong-current-device",
        environment,
      );
      assert.equal(wrongRefresh.code, "device_mismatch");

      const rotated = await Promise.all([
        account.refreshLicenseToken(
          currentCredentials.refreshToken,
          "current-status-device",
          environment,
        ),
        account.refreshLicenseToken(
          currentCredentials.refreshToken,
          "current-status-device",
          environment,
        ),
      ]);
      assert.equal(rotated.every((result) => result.active), true);
      assert.equal(rotated[0].licenseToken, rotated[1].licenseToken);
      assert.equal(rotated[0].refreshToken, rotated[1].refreshToken);
      assert.equal(
        await liveCredentialFamilies(
          databasePool,
          currentFixture.activation.activationId,
        ),
        1,
      );

      const replay = await account.refreshLicenseToken(
        currentCredentials.refreshToken,
        "current-status-device",
        environment,
      );
      assert.equal(replay.active, true);
      assert.equal(replay.licenseToken, rotated[0].licenseToken);
      assert.equal(replay.refreshToken, rotated[0].refreshToken);

      const revokedAccess = await account.verifyLicenseToken(
        currentCredentials.licenseToken,
        "current-status-device",
        environment,
      );
      assert.equal(revokedAccess.code, "revoked");
      await databasePool.query(
        `
          update public.sidestream_license_tokens
          set created_at = now() - interval '5 minutes',
              refresh_rotated_at = now() - interval '4 minutes',
              previous_refresh_valid_until = now() - interval '3 minutes'
          where activation_session_id = $1
            and previous_refresh_token_hash = $2
            and revoked_at is null
        `,
        [
          currentFixture.activation.activationId,
          tokenHash(currentCredentials.refreshToken),
        ],
      );
      const expiredPredecessor = await account.refreshLicenseToken(
        currentCredentials.refreshToken,
        "current-status-device",
        environment,
      );
      assert.equal(expiredPredecessor.active, false);
      assert.equal(expiredPredecessor.code, "revoked");
      assert.equal(
        await liveCredentialFamilies(
          databasePool,
          currentFixture.activation.activationId,
        ),
        1,
      );
      const liveRows = await databasePool.query(
        `
          select count(*)::int as count
          from public.sidestream_license_tokens
          where activation_session_id = $1 and revoked_at is null
        `,
        [currentFixture.activation.activationId],
      );
      assert.equal(liveRows.rows[0].count, 1);
    });
  } finally {
    if (runtimeModules) {
      const postgresModule = await import(
        pathToFileURL(join(repositoryRoot, "api", "_lib", "postgres.ts")).href
      );
      await postgresModule.getPostgresPool().end();
      await rm(runtimeModules.temporaryModuleDirectory, { recursive: true, force: true });
    }
    await databasePool.end().catch(() => {});
    restoreEnvironment(environmentSnapshot);
    await postgres.stop();
  }
});

async function applyMigrations(pool) {
  const migrations = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const migration of migrations) {
    await pool.query(await readFile(join(migrationsDirectory, migration), "utf8"));
  }
  assert.ok(
    migrations.includes("20260713201000_enforce_activation_credential_invariants.sql"),
  );
}

async function loadRuntimeModules() {
  const temporaryModuleDirectory = await mkdtemp(
    join(repositoryRoot, "tests", ".activation-security-modules-"),
  );
  try {
    const helperImports = {
      "./entitlement.js": pathToFileURL(
        join(repositoryRoot, "api", "_lib", "entitlement.ts"),
      ).href,
      "./checkout-offers.js": pathToFileURL(
        join(repositoryRoot, "api", "_lib", "checkout-offers.ts"),
      ).href,
      "./device-policy.js": pathToFileURL(
        join(repositoryRoot, "api", "_lib", "device-policy.ts"),
      ).href,
      "./license-environment.js": pathToFileURL(
        join(repositoryRoot, "api", "_lib", "license-environment.ts"),
      ).href,
      "./customer-identity.js": pathToFileURL(
        join(repositoryRoot, "api", "_lib", "customer-identity.ts"),
      ).href,
      "./postgres.js": pathToFileURL(
        join(repositoryRoot, "api", "_lib", "postgres.ts"),
      ).href,
    };
    helperImports["./maintenance.js"] = await writeRouteModule(
      temporaryModuleDirectory,
      "maintenance",
      join(repositoryRoot, "api", "_lib", "maintenance.ts"),
      { "./postgres.js": helperImports["./postgres.js"] },
    );
    helperImports["./paid-acquisition.js"] = await writeRouteModule(
      temporaryModuleDirectory,
      "paid-acquisition",
      join(repositoryRoot, "api", "_lib", "paid-acquisition.ts"),
      { "./postgres.js": helperImports["./postgres.js"] },
    );
    let accountSource = await readFile(accountSourcePath, "utf8");
    accountSource = replaceImports(accountSource, helperImports);
    accountSource += `
export function __setActivationSecurityStripeClient(value: Stripe | null) {
  stripeClient = value;
}
`;
    const accountModulePath = join(temporaryModuleDirectory, "account-under-test.ts");
    await writeFile(accountModulePath, accountSource, { mode: 0o600 });
    const accountModuleUrl = pathToFileURL(accountModulePath).href;

    const claimModuleUrl = await writeRouteModule(
    temporaryModuleDirectory,
    "claim",
    join(repositoryRoot, "api", "activation", "claim.ts"),
    {
      "../_lib/account.js": accountModuleUrl,
      "../_lib/device-policy.js": helperImports["./device-policy.js"],
      "../_lib/entitlement.js": helperImports["./entitlement.js"],
      "../_lib/paid-onboarding-claim-page.js": pathToFileURL(
        join(
          repositoryRoot,
          "api",
          "_lib",
          "paid-onboarding-claim-page.ts",
        ),
      ).href,
    },
  );
    const startModuleUrl = await writeRouteModule(
    temporaryModuleDirectory,
    "start",
    join(repositoryRoot, "api", "activation", "start.ts"),
    { "../_lib/account.js": accountModuleUrl },
  );
    const statusModuleUrl = await writeRouteModule(
    temporaryModuleDirectory,
    "status",
    join(repositoryRoot, "api", "activation", "status.ts"),
    {
      "../_lib/account.js": accountModuleUrl,
      "../_lib/paid-acquisition.js":
        helperImports["./paid-acquisition.js"],
    },
  );

    const nonce = randomUUID();
    const [account, claim, start, status] = await Promise.all([
      import(`${accountModuleUrl}?test=${nonce}`),
      import(`${claimModuleUrl}?test=${nonce}`),
      import(`${startModuleUrl}?test=${nonce}`),
      import(`${statusModuleUrl}?test=${nonce}`),
    ]);
    return {
      account,
      claimHandler: claim.default,
      startHandler: start.default,
      statusHandler: status.default,
      temporaryModuleDirectory,
    };
  } catch (error) {
    await rm(temporaryModuleDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function writeRouteModule(directory, name, sourcePath, imports) {
  const source = replaceImports(await readFile(sourcePath, "utf8"), imports);
  const modulePath = join(directory, `${name}-under-test.ts`);
  await writeFile(modulePath, source, { mode: 0o600 });
  return pathToFileURL(modulePath).href;
}

function replaceImports(source, imports) {
  let replaced = source;
  for (const [original, replacement] of Object.entries(imports)) {
    assert.match(replaced, new RegExp(escapeRegExp(JSON.stringify(original))));
    replaced = replaced.replaceAll(JSON.stringify(original), JSON.stringify(replacement));
  }
  return replaced;
}

async function seedAccount(pool, label) {
  const account = await pool.query(
    `
      insert into public.sidestream_accounts (
        google_sub, email, display_name, stripe_customer_id
      ) values ($1, $2, $3, $4)
      returning id
    `,
    [`google-${label}`, `${label}@example.com`, label, `cus_${label}`],
  );
  const accountId = account.rows[0].id;
  const license = await pool.query(
    `
      insert into public.sidestream_licenses (
        account_id, stripe_customer_id, stripe_subscription_id,
        stripe_checkout_session_id, plan_key, status, entitlement_status, features
      ) values ($1, $2, null, $3, 'sidestream_pro', 'active', 'active', '{}'::jsonb)
      returning id
    `,
    [accountId, `cus_${label}`, `cs_license_${label}`],
  );
  const sessionToken = `session-${label}`;
  await pool.query(
    `
      insert into public.sidestream_account_sessions (
        account_id, session_token_hash, expires_at
      ) values ($1, $2, now() + interval '1 day')
    `,
    [accountId, tokenHash(sessionToken)],
  );
  return {
    accountId,
    licenseId: license.rows[0].id,
    sessionToken,
    email: `${label}@example.com`,
    stripeCustomerId: `cus_${label}`,
  };
}

async function seedActivation(pool, options) {
  const activationKey = `activation-${options.label}`;
  const result = await pool.query(
    `
      insert into public.sidestream_activation_sessions (
        activation_key, account_id, license_id, device_id_hash, app_version,
        build_channel, source, status, expires_at, completed_at
      ) values (
        $1, $2, $3, $4, $5, 'stable', 'activation-security-test', $6,
        now() + ($7 * interval '1 second'), $8
      )
      returning id
    `,
    [
      activationKey,
      options.accountId || null,
      options.licenseId || null,
      privateIdentifierHash(options.deviceId),
      options.appVersion || "1.0.14",
      options.status || "pending",
      options.expiresInSeconds || 86_400,
      options.completedAt || null,
    ],
  );
  return { activationId: result.rows[0].id, activationKey };
}

async function seedExpiredCheckoutActivation(pool, options) {
  const activationKey = `activation-${options.label}`;
  const checkoutSessionId = `cs_${options.label}`;
  const result = await pool.query(
    `
      insert into public.sidestream_activation_sessions (
        activation_key, device_id_hash, app_version, build_channel, source,
        status, expires_at, stripe_checkout_session_id,
        stripe_checkout_price_id, stripe_checkout_product_id,
        stripe_checkout_expires_at, checkout_attached_at,
        checkout_claim_grace_until
      ) values (
        $1, $2, '1.0.14', 'stable', 'activation-security-test', 'pending',
        now() + interval '1 hour', $3, $4, $5,
        now() - interval '1 minute', now() - interval '2 minutes',
        now() - interval '30 seconds'
      )
      returning id
    `,
    [
      activationKey,
      privateIdentifierHash(options.deviceId),
      checkoutSessionId,
      `price_${options.label}`,
      `prod_${options.label}`,
    ],
  );
  return {
    activationId: result.rows[0].id,
    activationKey,
    checkoutSessionId,
  };
}

function checkoutAttachment(label, activationKey) {
  const checkoutExpiresAt = Math.floor(Date.now() / 1_000) + 3_600;
  return {
    activationKey,
    checkoutSessionId: `cs_${label}`,
    priceId: `price_${label}`,
    productId: `prod_${label}`,
    checkoutExpiresAt,
    claimGraceUntil: new Date((checkoutExpiresAt + 600) * 1_000).toISOString(),
  };
}

function checkoutSession(label, activationKey, buyer = null, checkoutIntentId = "") {
  return {
    id: `cs_${label}`,
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    customer: buyer?.stripeCustomerId || `cus_${label}`,
    customer_details: {
      email: buyer?.email || `${label}@example.com`,
      name: label,
    },
    payment_intent: `pi_${label}`,
    amount_subtotal: 999,
    amount_total: 999,
    currency: "usd",
    total_details: {
      amount_discount: 0,
      amount_shipping: 0,
      amount_tax: 0,
    },
    subscription: null,
    metadata: {
      sidestream_plan: "sidestream_pro",
      sidestream_price_id: `price_${label}`,
      sidestream_product_id: `prod_${label}`,
      sidestream_checkout_intent_id: checkoutIntentId,
      sidestream_account_id: buyer?.accountId || "",
      sidestream_offer_id: "sidestream-unlimited-global",
      sidestream_offer_country: "US",
      sidestream_offer_currency: "usd",
      sidestream_offer_amount_minor: "999",
      sidestream_activation_key: activationKey,
    },
    line_items: {
      data: [{
        quantity: 1,
        price: { id: `price_${label}`, product: { id: `prod_${label}` } },
      }],
      has_more: false,
    },
  };
}

async function seedCheckoutOfferIntent(pool, options) {
  const result = await pool.query(
    `
      insert into public.sidestream_checkout_intents (
        intent_kind, browser_token_hash, account_id, activation_session_id,
        state, attempt, stripe_customer_id, stripe_checkout_session_id,
        stripe_checkout_url, stripe_price_id, stripe_product_id,
        stripe_session_expires_at, offer_id, offer_country, offer_currency,
        offer_amount_minor, offer_stripe_product_id, offer_stripe_price_id,
        expires_at
      ) values (
        'activation', $1, $2::uuid, $3::uuid, 'open', 0, $4, $5,
        $6, $7, $8, now() + interval '1 hour',
        'sidestream-unlimited-global', 'US', 'usd', 999, $8, $7,
        now() + interval '1 day'
      )
      returning id
    `,
    [
      privateIdentifierHash(`checkout-intent-${options.label}`),
      options.accountId,
      options.activationId,
      `cus_${options.label}`,
      options.checkoutSessionId,
      `https://checkout.stripe.test/${options.checkoutSessionId}`,
      options.priceId,
      options.productId,
    ],
  );
  return result.rows[0].id;
}

async function activationState(pool, activationKey) {
  const result = await pool.query(
    `select account_id, status from public.sidestream_activation_sessions where activation_key = $1`,
    [activationKey],
  );
  return result.rows[0];
}

async function attachedCheckout(pool, activationKey) {
  const result = await pool.query(
    `
      select stripe_checkout_session_id, stripe_checkout_price_id,
        stripe_checkout_product_id, stripe_checkout_expires_at,
        checkout_claim_grace_until
      from public.sidestream_activation_sessions
      where activation_key = $1
    `,
    [activationKey],
  );
  return result.rows[0];
}

async function liveCredentialFamilies(pool, activationId) {
  const result = await pool.query(
    `
      select count(*)::int as count
      from public.sidestream_license_tokens
      where activation_session_id = $1
        and refresh_token_hash is not null
        and revoked_at is null
    `,
    [activationId],
  );
  return result.rows[0].count;
}

function privateIdentifierHash(value) {
  return createHmac("sha256", TEST_SECRET).update(value).digest("hex");
}

function tokenHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sessionCookie(account) {
  return `sidestream_session=${account.sessionToken}`;
}

function claimForm(activationKey, csrfToken) {
  return new URLSearchParams({
    activation: activationKey,
    csrf: csrfToken,
    intent: "restore",
  }).toString();
}

function requestHeaders(options = {}) {
  return {
    host: options.host || "sidestream.tv",
    "x-forwarded-proto": "https",
    ...(options.cookie ? { cookie: options.cookie } : {}),
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.contentType ? { "content-type": options.contentType } : {}),
  };
}

async function invokeHandler(handler, options) {
  const request = Readable.from(options.body ? [options.body] : []);
  request.method = options.method;
  request.url = options.url;
  request.headers = options.headers || {};
  const headers = {};
  const response = {
    statusCode: 200,
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return headers[name.toLowerCase()];
    },
    end(value = "") {
      this.body = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
    },
    body: "",
  };
  await handler(request, response);
  return { statusCode: response.statusCode, headers, body: response.body };
}

function configureRuntime(connectionString) {
  for (const name of CONTROLLED_ENVIRONMENT) delete process.env[name];
  process.env.SIDESTREAM_POSTGRES_URL = connectionString;
  process.env.SIDESTREAM_LICENSE_HASH_SECRET = TEST_SECRET;
  process.env.SIDESTREAM_DEVICE_POLICY_MODE = "enforce";
  process.env.VERCEL_ENV = "production";
  process.env.POSTGRES_SSL = "0";
  process.env.POSTGRES_POOL_MAX = "12";
}

async function startEphemeralPostgres() {
  const initdb = await findExecutable("initdb");
  const pgCtl = await findExecutable("pg_ctl");
  const root = await mkdtemp(join(tmpdir(), "sidestream-activation-security-pg-"));
  const dataDirectory = join(root, "data");
  const socketDirectory = "/tmp";
  const logPath = join(root, "postgres.log");
  const port = await reservePort();
  try {
    execFileSync(initdb, [
      "--pgdata", dataDirectory,
      "--username", "postgres",
      "--auth", "trust",
      "--encoding", "UTF8",
      "--no-locale",
      "--no-sync",
    ], { stdio: "pipe" });
    execFileSync(pgCtl, [
      "--pgdata", dataDirectory,
      "--log", logPath,
      "--options",
      `-F -p ${port} -h 127.0.0.1 -k ${socketDirectory}`,
      "--wait",
      "--timeout", "20",
      "start",
    ], { stdio: "pipe" });
  } catch (error) {
    const log = await readFile(logPath, "utf8").catch(() => "");
    await rm(root, { recursive: true, force: true });
    throw new Error(`Unable to start disposable Postgres: ${error.message}\n${log}`);
  }

  let stopped = false;
  return {
    connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`,
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        execFileSync(pgCtl, [
          "--pgdata", dataDirectory,
          "--wait",
          "--timeout", "20",
          "--mode", "immediate",
          "stop",
        ], { stdio: "pipe" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

async function findExecutable(name) {
  for (const directory of (process.env.PATH || "").split(":")) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  throw new Error(`${name} is required for the self-contained activation security test`);
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => {
    if (error) reject(error);
    else resolve();
  }));
  if (!port) throw new Error("Unable to reserve a local Postgres port");
  return port;
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

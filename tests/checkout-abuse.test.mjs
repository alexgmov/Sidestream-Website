import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";
import {
  getActivationCheckoutIdempotencyKey,
  validateCheckoutIntentPost,
} from "../api/_lib/entitlement.ts";
import { loadInjectedHandler } from "./helpers/handler-loader.mjs";
import { invokeHandler } from "./helpers/http.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationsDirectory = join(repositoryRoot, "db", "migrations");
const TEST_SECRET = "checkout-abuse-test-secret-with-at-least-32-bytes";
const BASE_URL = "https://sidestream.test";
const VALID_INTENT_ID = "11111111-1111-4111-8111-111111111111";
const CONTROLLED_ENVIRONMENT = [
  "SIDESTREAM_POSTGRES_URL",
  "SIDESTREAM_POSTGRES_PRISMA_URL",
  "SIDESTREAM_POSTGRES_URL_NON_POOLING",
  "SIDESTREAM_TEST_POSTGRES_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
  "SIDESTREAM_LICENSE_HASH_SECRET",
  "SIDESTREAM_RATE_LIMIT_HASH_SECRET",
  "SIDESTREAM_PRO_PRODUCT_ID",
  "SIDESTREAM_PRO_PRICE_ID",
  "SIDESTREAM_BASE_URL",
  "PUBLIC_BASE_URL",
  "STRIPE_SECRET_KEY",
  "VERCEL_ENV",
  "VERCEL_URL",
  "POSTGRES_SSL",
  "POSTGRES_POOL_MAX",
];

test("anonymous GET surfaces stay read-only while activation GET resumes attached Stripe Checkout", async () => {
  let stripeWrites = 0;
  let confirmationSequence = 0;
  let activationResumes = 0;
  const confirmation = (activationKey = "", hasCheckoutSession = false) => ({
    intentId: VALID_INTENT_ID,
    browserToken: "browser-capability",
    signedToken: "v1.signed",
    signedTokenExpiresAt: "2026-07-14T12:10:00.000Z",
    intentExpiresAt: "2026-07-15T12:00:00.000Z",
    kind: activationKey ? "activation" : "anonymous",
    activationKey,
    state: hasCheckoutSession ? "open" : "pending",
    hasCheckoutSession,
  });
  const start = await loadInjectedHandler(
    new URL("../api/checkout/start.ts", import.meta.url),
    {
      "../_lib/account.js": {
        cleanString,
        async createCheckoutIntentConfirmation(options) {
          confirmationSequence += 1;
          return confirmation(options.activationKey || "");
        },
        async createOrResumeActivationCheckout(options) {
          activationResumes += 1;
          assert.equal(options.activationKey, "activation-shipped-panel");
          assert.equal(options.baseUrl, BASE_URL);
          return { ok: true, url: "https://checkout.stripe.test/shipped-panel" };
        },
        getBaseUrl: () => BASE_URL,
        getSession: async () => null,
        methodNotAllowed,
        redirect,
        async resumeCheckoutIntentConfirmation() {
          confirmationSequence += 1;
          return confirmation("activation-legacy-1.0.13", true);
        },
        sendJson,
      },
      "../_lib/entitlement.js": {
        isLegacyVercelHost: (host) => String(host || "").split(":", 1)[0] ===
          "sidestream-xi.vercel.app",
      },
    },
  );

  const previews = [
    "/api/checkout/start",
    "/api/checkout/start?intent=browser-capability&checkout=cancelled",
  ];
  for (const url of previews) {
    const { response } = await invokeHandler(start, {
      method: "GET",
      url,
      headers: { host: "sidestream.test", "x-forwarded-proto": "https" },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /<form method="post" action="\/api\/checkout\/create">/);
  }
  const activation = await invokeHandler(start, {
    method: "GET",
    url: "/api/checkout/start?activation=activation-shipped-panel",
    headers: { host: "sidestream.test", "x-forwarded-proto": "https" },
  });
  assert.equal(activation.response.statusCode, 303);
  assert.equal(
    activation.response.getHeader("location"),
    "https://checkout.stripe.test/shipped-panel",
  );
  const legacyBare = await invokeHandler(start, {
    method: "GET",
    url: "/api/checkout/start",
    headers: { host: "sidestream-xi.vercel.app", "x-forwarded-proto": "https" },
  });
  assert.equal(legacyBare.response.statusCode, 302);
  assert.match(legacyBare.response.getHeader("location"), /activation_required/);
  const legacyActivation = await invokeHandler(start, {
    method: "GET",
    url: "/api/checkout/start?activation=activation-legacy-1.0.13",
    headers: { host: "sidestream-xi.vercel.app", "x-forwarded-proto": "https" },
  });
  assert.equal(legacyActivation.response.statusCode, 302);
  assert.equal(
    legacyActivation.response.getHeader("location"),
    `${BASE_URL}/api/checkout/start?activation=activation-legacy-1.0.13`,
  );
  assert.equal(confirmationSequence, 2);
  assert.equal(activationResumes, 1);
  assert.equal(stripeWrites, 0);

  const complete = await loadInjectedHandler(
    new URL("../api/checkout/complete.ts", import.meta.url),
    {
      "../_lib/account.js": {
        cleanString,
        async fulfillCheckoutSession() {
          // Completion may retrieve Stripe truth and write the license ledger,
          // but it never creates a Customer, Price, or Checkout Session.
          return { fulfilled: true };
        },
        getBaseUrl: () => BASE_URL,
        methodNotAllowed,
        redirect,
        sendJson,
      },
    },
  );
  const callbackPreview = await invokeHandler(complete, {
    method: "GET",
    url: "/api/checkout/complete?session_id=cs_paid",
  });
  assert.equal(callbackPreview.response.statusCode, 303);
  assert.equal(stripeWrites, 0);

  const [index, account, upgrade, llms, startSource] = await Promise.all([
    readFile(join(repositoryRoot, "index.html"), "utf8"),
    readFile(join(repositoryRoot, "account.html"), "utf8"),
    readFile(join(repositoryRoot, "upgrade.html"), "utf8"),
    readFile(join(repositoryRoot, "public", "llms.txt"), "utf8"),
    readFile(join(repositoryRoot, "api", "checkout", "start.ts"), "utf8"),
  ]);
  assert.doesNotMatch(index, /href="\/api\/checkout\/start"/);
  assert.doesNotMatch(index, /"url": "https:\/\/sidestream\.tv\/api\/checkout\/start"/);
  assert.doesNotMatch(account, /href="\/api\/checkout\/start"/);
  assert.doesNotMatch(llms, /Checkout endpoint:.*api\/checkout\/start/);
  assert.match(upgrade, /href="\/api\/checkout\/start"/);
  assert.doesNotMatch(stripComments(startSource), /\bgetStripe\s*\(/);
});

test("Checkout POST rejects CSRF, throttling, and active owners before Stripe work", async () => {
  let session = null;
  let coreCalls = 0;
  let limiterCalls = 0;
  let allowed = true;
  const create = await loadInjectedHandler(
    new URL("../api/checkout/create.ts", import.meta.url),
    {
      "../_lib/account.js": {
        cleanString,
        async createOrReuseCheckoutSession() {
          coreCalls += 1;
          return { ok: true, url: "https://checkout.stripe.test/session", reused: false };
        },
        getBaseUrl: () => BASE_URL,
        getClientIp: () => "127.0.0.1",
        getSession: async () => session,
        methodNotAllowed,
        readRequestBody,
        redirect,
        sendJson,
        validateCheckoutIntentConfirmation: ({ signedToken }) => signedToken === "valid-token",
      },
      "../_lib/entitlement.js": { validateCheckoutIntentPost },
      "../_lib/rate-limit.js": {
        applyRateLimitHeaders,
        async consumeRateLimit() {
          limiterCalls += 1;
          return rateLimitResult(allowed);
        },
        sendRateLimitExceeded,
      },
    },
  );

  const missingOrigin = await invokeHandler(create, validPost({ origin: "" }));
  assert.equal(missingOrigin.response.statusCode, 403);
  assert.equal(missingOrigin.response.json.code, "csrf_rejected");

  const crossOrigin = await invokeHandler(create, validPost({
    origin: "https://attacker.example",
  }));
  assert.equal(crossOrigin.response.statusCode, 403);
  assert.equal(crossOrigin.response.json.code, "csrf_rejected");

  const crossSiteMetadata = await invokeHandler(create, validPost({
    fetchSite: "cross-site",
  }));
  assert.equal(crossSiteMetadata.response.statusCode, 403);

  const missingToken = await invokeHandler(create, validPost({ token: "" }));
  assert.equal(missingToken.response.statusCode, 403);
  assert.equal(missingToken.response.json.code, "csrf_rejected");
  assert.equal(limiterCalls, 0);
  assert.equal(coreCalls, 0);

  const legacyClaimForm = await invokeHandler(create, {
    ...validPost(),
    body: new URLSearchParams({
      activationKey: "activation-legacy-1.0.13",
      intent: "purchase",
    }).toString(),
  });
  assert.equal(legacyClaimForm.response.statusCode, 303);
  assert.equal(
    legacyClaimForm.response.getHeader("location"),
    `${BASE_URL}/api/checkout/start?activation=activation-legacy-1.0.13`,
  );
  assert.equal(limiterCalls, 0);
  assert.equal(coreCalls, 0);

  allowed = false;
  const throttled = await invokeHandler(create, validPost());
  assert.equal(throttled.response.statusCode, 429);
  assert.equal(throttled.response.getHeader("retry-after"), "47");
  assert.equal(coreCalls, 0);

  allowed = true;
  session = accountSession({ active: true });
  const owner = await invokeHandler(create, validPost());
  assert.equal(owner.response.statusCode, 409);
  assert.equal(owner.response.json.code, "active_license");
  assert.equal(owner.response.json.accountUrl, "/account.html");
  assert.equal(coreCalls, 0);

  session = accountSession({ active: false });
  const accepted = await invokeHandler(create, validPost());
  assert.equal(accepted.response.statusCode, 303);
  assert.equal(accepted.response.getHeader("location"), "https://checkout.stripe.test/session");
  assert.equal(coreCalls, 1);
});

test("database-backed intents serialize retries, rotate deliberately, and fulfill once", {
  timeout: 120_000,
}, async () => {
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
    const { account } = runtimeModules;
    const stripe = new RecordingStripe();
    account.__setCheckoutAbuseStripeClient(stripe);

    const buyer = await seedFreeAccount(databasePool, "concurrent-buyer");
    const buyerSession = accountSession({
      accountId: buyer.accountId,
      email: buyer.email,
      active: false,
    });
    const confirmation = await account.createCheckoutIntentConfirmation({
      session: buyerSession,
    });
    assert.ok(confirmation);

    const [first, second] = await Promise.all([
      account.createOrReuseCheckoutSession({
        intentId: confirmation.intentId,
        browserToken: confirmation.browserToken,
        session: buyerSession,
        baseUrl: BASE_URL,
      }),
      account.createOrReuseCheckoutSession({
        intentId: confirmation.intentId,
        browserToken: confirmation.browserToken,
        session: buyerSession,
        baseUrl: BASE_URL,
      }),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.url, second.url);
    assert.equal(stripe.countWrites("customers.create"), 1);
    assert.equal(stripe.countWrites("checkout.sessions.create"), 1);

    const persistedCustomer = await databasePool.query(
      "select stripe_customer_id from public.sidestream_accounts where id = $1",
      [buyer.accountId],
    );
    buyerSession.stripeCustomerId = persistedCustomer.rows[0].stripe_customer_id;
    const rotated = await account.createOrReuseCheckoutSession({
      intentId: confirmation.intentId,
      browserToken: confirmation.browserToken,
      session: buyerSession,
      baseUrl: BASE_URL,
      rotateCancelledSession: true,
    });
    assert.equal(rotated.ok, true);
    assert.notEqual(rotated.url, first.url);
    assert.equal(stripe.countWrites("checkout.sessions.expire"), 1);
    assert.equal(stripe.countWrites("checkout.sessions.create"), 2);
    assert.notEqual(
      stripe.sessionCreateWrites[0].options.idempotencyKey,
      stripe.sessionCreateWrites[1].options.idempotencyKey,
    );

    const anonymous = await account.createCheckoutIntentConfirmation({ session: null });
    const anonymousFirst = await account.createOrReuseCheckoutSession({
      intentId: anonymous.intentId,
      browserToken: anonymous.browserToken,
      session: null,
      baseUrl: BASE_URL,
    });
    assert.equal(anonymousFirst.ok, true);
    await databasePool.query(
      `
        update public.sidestream_checkout_intents
        set stripe_session_expires_at = now() - interval '1 second'
        where id = $1
      `,
      [anonymous.intentId],
    );
    const anonymousRotated = await account.createOrReuseCheckoutSession({
      intentId: anonymous.intentId,
      browserToken: anonymous.browserToken,
      session: null,
      baseUrl: BASE_URL,
    });
    assert.equal(anonymousRotated.ok, true);
    assert.notEqual(anonymousRotated.url, anonymousFirst.url);

    const activationKey = "activation-checkout-intent-exact";
    await seedActivation(databasePool, activationKey);
    const activationConfirmation = await account.createCheckoutIntentConfirmation({
      activationKey,
      session: null,
    });
    assert.ok(activationConfirmation);
    const activationCheckout = await account.createOrReuseCheckoutSession({
      intentId: activationConfirmation.intentId,
      browserToken: activationConfirmation.browserToken,
      session: null,
      baseUrl: BASE_URL,
    });
    assert.equal(activationCheckout.ok, true);
    const activationWrite = stripe.sessionCreateWrites.at(-1);
    assert.equal(
      activationWrite.options.idempotencyKey,
      getActivationCheckoutIdempotencyKey(activationKey),
    );
    assert.equal(
      activationWrite.params.metadata.sidestream_activation_key,
      activationKey,
    );
    const attached = await databasePool.query(
      `
        select stripe_checkout_session_id
        from public.sidestream_activation_sessions
        where activation_key = $1
      `,
      [activationKey],
    );
    assert.equal(attached.rows[0].stripe_checkout_session_id, activationWrite.session.id);

    stripe.complete(activationWrite.session.id, {
      email: "activation-paid@example.com",
      name: "Activation Buyer",
    });
    const deliveries = await Promise.all([
      account.fulfillCheckoutSession(activationWrite.session.id, activationKey),
      account.upsertLicenseFromCheckoutSession({ id: activationWrite.session.id }),
    ]);
    assert.ok(deliveries.every((delivery) => delivery.fulfilled));
    const licenseCount = await databasePool.query(
      `
        select count(*)::integer as count
        from public.sidestream_licenses
        where stripe_checkout_session_id = $1
      `,
      [activationWrite.session.id],
    );
    assert.equal(licenseCount.rows[0].count, 1);
    const fulfilledActivation = await databasePool.query(
      `
        select account_id, stripe_checkout_session_id
        from public.sidestream_activation_sessions
        where activation_key = $1
      `,
      [activationKey],
    );
    assert.ok(fulfilledActivation.rows[0].account_id);
    assert.equal(
      fulfilledActivation.rows[0].stripe_checkout_session_id,
      activationWrite.session.id,
    );
    const fulfilledIntent = await databasePool.query(
      `
        select state, stripe_customer_id
        from public.sidestream_checkout_intents
        where id = $1
      `,
      [activationConfirmation.intentId],
    );
    assert.deepEqual(fulfilledIntent.rows[0], {
      state: "completed",
      stripe_customer_id: activationWrite.session.customer,
    });

    const accountSource = await readFile(
      join(repositoryRoot, "api", "_lib", "account.ts"),
      "utf8",
    );
    const migration = await readFile(
      join(
        repositoryRoot,
        "db",
        "migrations",
        "20260713203000_add_checkout_intents.sql",
      ),
      "utf8",
    );
    assert.match(accountSource, /Anonymous Checkout cannot safely infer prior ownership/);
    assert.match(accountSource, /does not prevent cross-browser purchases/);
    assert.match(migration, /email Stripe has not collected and verified/);
  } finally {
    if (runtimeModules) {
      await runtimeModules.postgres.getPostgresPool().end();
      await rm(runtimeModules.temporaryModuleDirectory, { recursive: true, force: true });
    }
    await databasePool.end().catch(() => {});
    restoreEnvironment(environmentSnapshot);
    await postgres.stop();
  }
});

test("shipped activation checkout remains complete on the pre-hardening Production schema", {
  timeout: 120_000,
}, async () => {
  const environmentSnapshot = snapshotEnvironment(CONTROLLED_ENVIRONMENT);
  const postgres = await startEphemeralPostgres();
  const databasePool = new Pool({
    connectionString: postgres.connectionString,
    max: 12,
    ssl: false,
  });
  let runtimeModules;

  try {
    await applyMigrations(
      databasePool,
      "20260713180000_add_activation_checkout_and_refresh_rotation.sql",
    );
    const schema = await databasePool.query(
      `
        select
          to_regclass('public.sidestream_checkout_intents') as checkout_intents,
          to_regclass('public.sidestream_account_devices') as account_devices
      `,
    );
    assert.deepEqual(schema.rows[0], {
      checkout_intents: null,
      account_devices: null,
    });

    configureRuntime(postgres.connectionString);
    runtimeModules = await loadRuntimeModules();
    const { account } = runtimeModules;
    const stripe = new RecordingStripe();
    account.__setCheckoutAbuseStripeClient(stripe);
    const request = {
      headers: {
        host: "sidestream.tv",
        "x-forwarded-proto": "https",
        "user-agent": "Sidestream/1.0.14",
      },
      socket: { remoteAddress: "127.0.0.1" },
    };
    const deviceId = "shipped-panel-device";
    const activation = await account.createActivationSession(request, {
      deviceId,
      appVersion: "1.0.14",
      buildChannel: "production",
      source: "download_history",
    });
    assert.equal(activation.restoreUrl, activation.upgradeUrl);
    assert.match(activation.upgradeUrl, /^https:\/\/sidestream\.test\/api\/checkout\/start\?activation=/);
    const accountActivation = await account.createActivationSession(request, {
      deviceId: `${deviceId}-account`,
      appVersion: "1.0.14",
      buildChannel: "production",
      source: "settings_account",
    });
    assert.match(accountActivation.restoreUrl, /^https:\/\/sidestream\.test\/api\/activation\/claim\?activation=/);
    const checkout = await account.createOrResumeActivationCheckout({
      activationKey: activation.activationKey,
      baseUrl: BASE_URL,
    });
    assert.equal(checkout.ok, true);
    assert.match(checkout.url, /^https:\/\/checkout\.stripe\.test\//);
    assert.equal(stripe.countWrites("checkout.sessions.create"), 1);

    const checkoutSession = stripe.sessionCreateWrites[0].session;
    stripe.complete(checkoutSession.id, {
      email: "shipped-panel-buyer@example.com",
      name: "Shipped Panel Buyer",
    });
    const fulfillment = await account.fulfillCheckoutSession(
      checkoutSession.id,
      activation.activationKey,
    );
    assert.deepEqual(fulfillment, {
      fulfilled: true,
      activationBound: true,
    });

    const status = await account.getActivationStatus(
      activation.activationKey,
      deviceId,
    );
    assert.equal(status.status, "active");
    assert.ok(status.licenseToken);
    assert.ok(status.refreshToken);

    const verified = await account.verifyLicenseToken(
      status.licenseToken,
      deviceId,
    );
    assert.equal(verified.active, true);
    const environment = account.resolveRequestLicenseEnvironment(request);
    assert.ok(environment);
    const authorized = await account.authorizeLicenseDownload({
      licenseToken: status.licenseToken,
      deviceId,
      environment,
    });
    assert.equal(authorized.active, true);

    const refreshed = await account.refreshLicenseToken(
      status.refreshToken,
      deviceId,
    );
    assert.equal(refreshed.active, true);
    assert.notEqual(refreshed.licenseToken, status.licenseToken);
    const refreshedVerification = await account.verifyLicenseToken(
      refreshed.licenseToken,
      deviceId,
    );
    assert.equal(refreshedVerification.active, true);
  } finally {
    if (runtimeModules) {
      await runtimeModules.postgres.getPostgresPool().end();
      await rm(runtimeModules.temporaryModuleDirectory, { recursive: true, force: true });
    }
    await databasePool.end().catch(() => {});
    restoreEnvironment(environmentSnapshot);
    await postgres.stop();
  }
});

class RecordingStripe {
  #customersByKey = new Map();
  #sessionsByKey = new Map();
  #sessions = new Map();

  constructor() {
    this.writes = [];
    this.reads = [];
    this.customers = {
      retrieve: async (customerId) => {
        this.reads.push({ operation: "customers.retrieve", customerId });
        return { id: customerId, email: null, name: null };
      },
      create: async (params, options = {}) => {
        const key = options.idempotencyKey || `unkeyed-${this.writes.length}`;
        if (this.#customersByKey.has(key)) return this.#customersByKey.get(key);
        const customer = { id: `cus_recorded_${this.#customersByKey.size + 1}`, ...params };
        this.#customersByKey.set(key, customer);
        this.writes.push({ operation: "customers.create", params, options, customer });
        await Promise.resolve();
        return customer;
      },
    };
    this.prices = {
      retrieve: async (priceId) => {
        this.reads.push({ operation: "prices.retrieve", priceId });
        return {
          id: priceId,
          active: true,
          product: "prod_checkout_test",
          unit_amount: 999,
          currency: "usd",
          recurring: null,
          lookup_key: "sidestream_pro_once_999",
        };
      },
      list: async () => ({ data: [] }),
      create: async () => {
        throw new Error("Configured Checkout test Price should prevent Price creation");
      },
    };
    this.products = {
      retrieve: async () => ({
        id: "prod_checkout_test",
        active: true,
        default_price: "price_checkout_test",
      }),
    };
    this.paymentIntents = {
      retrieve: async (paymentIntentId) => {
        this.reads.push({ operation: "paymentIntents.retrieve", paymentIntentId });
        const session = [...this.#sessions.values()].find(
          (candidate) => candidate.payment_intent === paymentIntentId,
        );
        if (!session) throw new Error(`Unknown Stripe test PaymentIntent ${paymentIntentId}`);
        return {
          id: paymentIntentId,
          customer: session.customer,
          amount_received: 999,
          currency: "usd",
          status: "succeeded",
          latest_charge: `ch_${paymentIntentId.slice(3)}`,
        };
      },
    };
    this.charges = {
      retrieve: async (chargeId) => {
        this.reads.push({ operation: "charges.retrieve", chargeId });
        const paymentIntentId = `pi_${chargeId.slice(3)}`;
        const session = [...this.#sessions.values()].find(
          (candidate) => candidate.payment_intent === paymentIntentId,
        );
        if (!session) throw new Error(`Unknown Stripe test Charge ${chargeId}`);
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
    };
    this.disputes = {
      list: async () => ({ data: [], has_more: false }),
    };
    this.checkout = {
      sessions: {
        create: async (params, options = {}) => {
          const key = options.idempotencyKey || `unkeyed-${this.writes.length}`;
          if (this.#sessionsByKey.has(key)) return clone(this.#sessionsByKey.get(key));
          const id = `cs_recorded_${this.#sessionsByKey.size + 1}`;
          const customer = params.customer || `cus_checkout_${this.#sessionsByKey.size + 1}`;
          const expiresAt = params.expires_at || Math.floor(Date.now() / 1_000) + 86_400;
          const session = {
            id,
            url: `https://checkout.stripe.test/${id}`,
            mode: "payment",
            status: "open",
            payment_status: "unpaid",
            customer,
            customer_details: null,
            customer_email: null,
            payment_intent: `pi_${id}`,
            amount_total: 999,
            currency: "usd",
            subscription: null,
            expires_at: expiresAt,
            metadata: { ...(params.metadata || {}) },
            line_items: {
              data: [{
                quantity: 1,
                price: {
                  id: params.line_items[0].price,
                  product: "prod_checkout_test",
                },
              }],
              has_more: false,
            },
          };
          this.#sessionsByKey.set(key, session);
          this.#sessions.set(id, session);
          this.writes.push({
            operation: "checkout.sessions.create",
            params,
            options,
            session,
          });
          await Promise.resolve();
          return clone(session);
        },
        retrieve: async (sessionId) => {
          this.reads.push({ operation: "checkout.sessions.retrieve", sessionId });
          const session = this.#sessions.get(sessionId);
          if (!session) throw new Error(`Unknown Stripe test Session ${sessionId}`);
          return clone(session);
        },
        expire: async (sessionId, _params, options = {}) => {
          const session = this.#sessions.get(sessionId);
          if (!session) throw new Error(`Unknown Stripe test Session ${sessionId}`);
          session.status = "expired";
          this.writes.push({
            operation: "checkout.sessions.expire",
            sessionId,
            options,
          });
          return clone(session);
        },
      },
    };
  }

  complete(sessionId, profile) {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`Unknown Stripe test Session ${sessionId}`);
    session.status = "complete";
    session.payment_status = "paid";
    session.customer_details = { email: profile.email, name: profile.name };
    session.customer_email = profile.email;
  }

  countWrites(operation) {
    return this.writes.filter((entry) => entry.operation === operation).length;
  }

  get sessionCreateWrites() {
    return this.writes.filter((entry) => entry.operation === "checkout.sessions.create");
  }
}

function validPost(options = {}) {
  const origin = options.origin === undefined ? BASE_URL : options.origin;
  const fetchSite = options.fetchSite || "same-origin";
  const token = options.token === undefined ? "valid-token" : options.token;
  return {
    method: "POST",
    url: "/api/checkout/create",
    headers: {
      host: "sidestream.test",
      "x-forwarded-proto": "https",
      origin,
      "sec-fetch-site": fetchSite,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      checkoutIntentId: VALID_INTENT_ID,
      checkoutIntent: "browser-capability",
      intentToken: token,
      intent: "purchase",
    }).toString(),
  };
}

function rateLimitResult(allowed) {
  return {
    allowed,
    limit: 8,
    remaining: allowed ? 7 : 0,
    retryAfterSeconds: allowed ? 0 : 47,
    resetAt: "2026-07-14T12:15:00.000Z",
  };
}

function accountSession(options = {}) {
  return {
    accountId: options.accountId || "22222222-2222-4222-8222-222222222222",
    email: options.email || "buyer@example.com",
    name: "Checkout Buyer",
    avatarUrl: "",
    stripeCustomerId: options.stripeCustomerId || "",
    license: {
      active: Boolean(options.active),
      plan: options.active ? "sidestream_pro" : "free",
      status: options.active ? "active" : "free",
      currentPeriodEnd: "",
      cancelAtPeriodEnd: false,
      graceUntil: "",
      features: {},
    },
  };
}

async function seedFreeAccount(pool, label) {
  const result = await pool.query(
    `
      insert into public.sidestream_accounts (
        google_sub, email, display_name, stripe_customer_id
      ) values ($1, $2, $3, null)
      returning id, email
    `,
    [`google-${label}`, `${label}@example.com`, label],
  );
  return { accountId: result.rows[0].id, email: result.rows[0].email };
}

async function seedActivation(pool, activationKey) {
  await pool.query(
    `
      insert into public.sidestream_activation_sessions (
        activation_key, device_id_hash, app_version, build_channel,
        source, status, expires_at, created_at, updated_at
      ) values (
        $1, $2, '1.0.13', 'stable', 'checkout-abuse-test',
        'pending', now() + interval '3 hours', now(), now()
      )
    `,
    [activationKey, "a".repeat(64)],
  );
}

async function applyMigrations(pool, through = "") {
  const migrations = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) => !through || name <= through);
  for (const migration of migrations) {
    await pool.query(await readFile(join(migrationsDirectory, migration), "utf8"));
  }
  if (!through || through >= "20260713203000_add_checkout_intents.sql") {
    assert.ok(migrations.includes("20260713203000_add_checkout_intents.sql"));
  }
}

async function loadRuntimeModules() {
  const temporaryModuleDirectory = await mkdtemp(
    join(repositoryRoot, "tests", ".checkout-abuse-modules-"),
  );
  try {
    const imports = {
      "./entitlement.js": pathToFileURL(
        join(repositoryRoot, "api", "_lib", "entitlement.ts"),
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
    };
    const postgresPath = await writeAdaptedModule(
      temporaryModuleDirectory,
      "postgres",
      join(repositoryRoot, "api", "_lib", "postgres.ts"),
      {
        "./postgres-target.js": pathToFileURL(
          join(repositoryRoot, "api", "_lib", "postgres-target.ts"),
        ).href,
      },
    );
    imports["./postgres.js"] = pathToFileURL(postgresPath).href;
    imports["./maintenance.js"] = pathToFileURL(await writeAdaptedModule(
      temporaryModuleDirectory,
      "maintenance",
      join(repositoryRoot, "api", "_lib", "maintenance.ts"),
      { "./postgres.js": imports["./postgres.js"] },
    )).href;
    let source = await readFile(
      join(repositoryRoot, "api", "_lib", "account.ts"),
      "utf8",
    );
    source = replaceImports(source, imports);
    source += `
export function __setCheckoutAbuseStripeClient(value: Stripe | null) {
  stripeClient = value;
}
`;
    const modulePath = join(temporaryModuleDirectory, "account-under-test.ts");
    await writeFile(modulePath, source, { mode: 0o600 });
    const account = await import(`${pathToFileURL(modulePath).href}?checkout-abuse=1`);
    const postgres = await import(pathToFileURL(postgresPath).href);
    return { account, postgres, temporaryModuleDirectory };
  } catch (error) {
    await rm(temporaryModuleDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function writeAdaptedModule(directory, name, sourcePath, replacements) {
  const source = replaceImports(await readFile(sourcePath, "utf8"), replacements);
  const destination = join(directory, `${name}-under-test.ts`);
  await writeFile(destination, source, { mode: 0o600 });
  return destination;
}

function replaceImports(source, imports) {
  let replaced = source;
  for (const [original, replacement] of Object.entries(imports)) {
    assert.match(replaced, new RegExp(escapeRegExp(JSON.stringify(original))));
    replaced = replaced.replaceAll(JSON.stringify(original), JSON.stringify(replacement));
  }
  return replaced;
}

function configureRuntime(connectionString) {
  for (const name of CONTROLLED_ENVIRONMENT) delete process.env[name];
  process.env.SIDESTREAM_POSTGRES_URL = connectionString;
  process.env.SIDESTREAM_LICENSE_HASH_SECRET = TEST_SECRET;
  process.env.SIDESTREAM_RATE_LIMIT_HASH_SECRET = TEST_SECRET;
  process.env.SIDESTREAM_PRO_PRODUCT_ID = "prod_checkout_test";
  process.env.SIDESTREAM_PRO_PRICE_ID = "price_checkout_test";
  process.env.SIDESTREAM_BASE_URL = BASE_URL;
  process.env.STRIPE_SECRET_KEY = "sk_test_checkout_abuse";
  process.env.VERCEL_ENV = "production";
  process.env.POSTGRES_SSL = "0";
  process.env.POSTGRES_POOL_MAX = "12";
}

async function startEphemeralPostgres() {
  const initdb = await findExecutable("initdb");
  const pgCtl = await findExecutable("pg_ctl");
  const root = await mkdtemp(join(tmpdir(), "sidestream-checkout-abuse-pg-"));
  const dataDirectory = join(root, "data");
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
      "--options", `-F -p ${port} -h 127.0.0.1 -k /tmp`,
      "--wait", "--timeout", "20", "start",
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
          "--wait", "--timeout", "20", "--mode", "immediate", "stop",
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
  throw new Error(`${name} is required for the self-contained Checkout abuse test`);
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

function cleanString(value, maxLength = 240) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function methodNotAllowed(response, allowedMethods) {
  response.setHeader("Allow", allowedMethods);
  return sendJson(response, 405, { error: "Method not allowed" });
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

function applyRateLimitHeaders(response, result) {
  response.setHeader("RateLimit-Limit", String(result.limit));
  response.setHeader("RateLimit-Remaining", String(result.remaining));
  response.setHeader("RateLimit-Reset", result.resetAt);
  if (!result.allowed) response.setHeader("Retry-After", String(result.retryAfterSeconds));
}

function sendRateLimitExceeded(response, result) {
  applyRateLimitHeaders(response, result);
  return sendJson(response, 429, {
    error: "Too many requests",
    code: "rate_limited",
    retryAfterSeconds: result.retryAfterSeconds,
  });
}

function redirect(response, location, statusCode = 303) {
  response.statusCode = statusCode;
  response.setHeader("Location", location);
  response.setHeader("Cache-Control", "no-store");
  response.end();
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function clone(value) {
  return structuredClone(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

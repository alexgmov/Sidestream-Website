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
  getCheckoutParametersFingerprint,
  getCheckoutSessionIdempotencyKey,
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
  "SIDESTREAM_PRO_INDIA_PRICE_ID",
  "SIDESTREAM_BASE_URL",
  "PUBLIC_BASE_URL",
  "STRIPE_SECRET_KEY",
  "VERCEL_ENV",
  "VERCEL_URL",
  "POSTGRES_SSL",
  "POSTGRES_POOL_MAX",
];

test("Upgrade authenticates and then redirects the signed-in buyer to Stripe", async () => {
  let session = null;
  let intentCalls = 0;
  let checkoutCalls = 0;
  let limiterCalls = 0;
  let allowed = true;
  let selectedCountry = "";
  const start = await loadInjectedHandler(
    new URL("../api/checkout/start.ts", import.meta.url),
    {
      "../_lib/account.js": {
        cleanString,
        async createCheckoutIntent(options) {
          intentCalls += 1;
          selectedCountry = options.buyerCountry;
          return {
            intentId: VALID_INTENT_ID,
            browserToken: "browser-capability",
            intentExpiresAt: "2026-07-15T12:00:00.000Z",
            kind: options.activationKey ? "activation" : "account",
            activationKey: options.activationKey || "",
          };
        },
        async createOrReuseCheckoutSession() {
          checkoutCalls += 1;
          return {
            ok: true,
            url: "https://checkout.stripe.test/session",
            reused: false,
          };
        },
        getBaseUrl: () => BASE_URL,
        getClientIp: () => "127.0.0.1",
        getSession: async () => session,
        getTrustedCheckoutCountry(headers) {
          const country = headers["x-vercel-ip-country"];
          return typeof country === "string" && /^[A-Za-z]{2}$/.test(country)
            ? country.toUpperCase()
            : "ZZ";
        },
        methodNotAllowed,
        redirect,
        sendJson,
      },
      "../_lib/entitlement.js": {
        isLegacyVercelHost: (host) => String(host || "").split(":", 1)[0] ===
          "sidestream-xi.vercel.app",
      },
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

  const signedOut = await invokeHandler(start, {
    method: "GET",
    url: "/api/checkout/start?activation=activation-bound",
    headers: { host: "sidestream.test", "x-forwarded-proto": "https" },
  });
  assert.equal(signedOut.response.statusCode, 302);
  const authUrl = new URL(signedOut.response.getHeader("location"));
  assert.equal(authUrl.pathname, "/api/auth/google/start");
  assert.equal(
    authUrl.searchParams.get("next"),
    "/api/checkout/start?activation=activation-bound",
  );
  assert.equal(intentCalls, 0);
  assert.equal(checkoutCalls, 0);

  const legacyBare = await invokeHandler(start, {
    method: "GET",
    url: "/api/checkout/start",
    headers: { host: "sidestream-xi.vercel.app", "x-forwarded-proto": "https" },
  });
  assert.equal(legacyBare.response.statusCode, 302);
  assert.equal(
    legacyBare.response.getHeader("location"),
    `${BASE_URL}/api/checkout/start`,
  );
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

  session = accountSession({ active: false });
  const accepted = await invokeHandler(start, {
    method: "GET",
    url: "/api/checkout/start?activation=activation-bound",
    headers: { host: "sidestream.test", "x-forwarded-proto": "https" },
  });
  assert.equal(accepted.response.statusCode, 303);
  assert.equal(
    accepted.response.getHeader("location"),
    "https://checkout.stripe.test/session",
  );
  assert.equal(intentCalls, 1);
  assert.equal(checkoutCalls, 1);
  assert.equal(limiterCalls, 1);
  assert.equal(selectedCountry, "ZZ");

  const trustedIndia = await invokeHandler(start, {
    method: "GET",
    url: "/api/checkout/start?country=US&currency=USD&amount=1&offer=forged",
    headers: {
      host: "sidestream.test",
      "x-forwarded-proto": "https",
      "x-vercel-ip-country": "in",
    },
  });
  assert.equal(trustedIndia.response.statusCode, 303);
  assert.equal(selectedCountry, "IN");
  assert.equal(intentCalls, 2);
  assert.equal(checkoutCalls, 2);

  allowed = false;
  const throttled = await invokeHandler(start, {
    method: "GET",
    url: "/api/checkout/start",
    headers: { host: "sidestream.test", "x-forwarded-proto": "https" },
  });
  assert.equal(throttled.response.statusCode, 429);
  assert.equal(throttled.response.getHeader("retry-after"), "47");
  assert.equal(checkoutCalls, 2);

  allowed = true;
  session = accountSession({ active: true });
  const owner = await invokeHandler(start, {
    method: "GET",
    url: "/api/checkout/start",
    headers: { host: "sidestream.test", "x-forwarded-proto": "https" },
  });
  assert.equal(owner.response.statusCode, 302);
  assert.match(owner.response.getHeader("location"), /checkout=already_owned/);
  assert.equal(intentCalls, 2);
  assert.equal(checkoutCalls, 2);

  const [index, account, startSource] = await Promise.all([
    readFile(join(repositoryRoot, "index.html"), "utf8"),
    readFile(join(repositoryRoot, "account.html"), "utf8"),
    readFile(join(repositoryRoot, "api", "checkout", "start.ts"), "utf8"),
  ]);
  assert.match(index, /href="\/api\/checkout\/start"/);
  assert.match(account, /href="\/api\/checkout\/start"/);
  assert.doesNotMatch(startSource, /text\/html|<form|<button/);
  assert.doesNotMatch(stripComments(startSource), /\bgetStripe\s*\(/);
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
    const intent = await account.createCheckoutIntent({
      session: buyerSession,
    });
    assert.ok(intent);

    const [first, second] = await Promise.all([
      account.createOrReuseCheckoutSession({
        intentId: intent.intentId,
        browserToken: intent.browserToken,
        session: buyerSession,
        baseUrl: BASE_URL,
      }),
      account.createOrReuseCheckoutSession({
        intentId: intent.intentId,
        browserToken: intent.browserToken,
        session: buyerSession,
        baseUrl: BASE_URL,
      }),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.url, second.url);
    assert.equal(stripe.countWrites("customers.create"), 1);
    assert.equal(stripe.countWrites("checkout.sessions.create"), 1);

    process.env.SIDESTREAM_PRO_PRICE_ID = "price_checkout_changed_after_open";
    const stillOpen = await account.createOrReuseCheckoutSession({
      intentId: intent.intentId,
      browserToken: intent.browserToken,
      session: buyerSession,
      baseUrl: BASE_URL,
    });
    assert.equal(stillOpen.ok, true);
    assert.equal(stillOpen.url, first.url);
    assert.equal(stripe.countWrites("checkout.sessions.create"), 1);

    await databasePool.query(
      `
        update public.sidestream_checkout_intents
        set stripe_price_id = 'price_previous_catalog'
        where id = $1
      `,
      [intent.intentId],
    );
    const repriced = await account.createOrReuseCheckoutSession({
      intentId: intent.intentId,
      browserToken: intent.browserToken,
      session: buyerSession,
      baseUrl: BASE_URL,
    });
    assert.equal(repriced.ok, true);
    assert.notEqual(repriced.url, first.url);
    assert.equal(stripe.countWrites("checkout.sessions.expire"), 1);
    assert.equal(stripe.countWrites("checkout.sessions.create"), 2);

    const persistedCustomer = await databasePool.query(
      "select stripe_customer_id from public.sidestream_accounts where id = $1",
      [buyer.accountId],
    );
    buyerSession.stripeCustomerId = persistedCustomer.rows[0].stripe_customer_id;
    const rotated = await account.createOrReuseCheckoutSession({
      intentId: intent.intentId,
      browserToken: intent.browserToken,
      session: buyerSession,
      baseUrl: BASE_URL,
      rotateCancelledSession: true,
    });
    assert.equal(rotated.ok, true);
    assert.notEqual(rotated.url, repriced.url);
    assert.equal(stripe.countWrites("checkout.sessions.expire"), 2);
    assert.equal(stripe.countWrites("checkout.sessions.create"), 3);
    assert.notEqual(
      stripe.sessionCreateWrites[1].options.idempotencyKey,
      stripe.sessionCreateWrites[2].options.idempotencyKey,
    );

    stripe.expireExternally(stripe.sessionCreateWrites[2].session.id);
    await databasePool.query(
      `
        update public.sidestream_checkout_intents
        set stripe_price_id = 'price_previous_catalog'
        where id = $1
      `,
      [intent.intentId],
    );
    const replacedExpired = await account.createOrReuseCheckoutSession({
      intentId: intent.intentId,
      browserToken: intent.browserToken,
      session: buyerSession,
      baseUrl: BASE_URL,
    });
    assert.equal(replacedExpired.ok, true);
    assert.notEqual(replacedExpired.url, rotated.url);
    assert.equal(stripe.countWrites("checkout.sessions.expire"), 2);

    const activationKey = "activation-checkout-intent-exact";
    await seedActivation(databasePool, activationKey);
    const activationIntent = await account.createCheckoutIntent({
      activationKey,
      session: buyerSession,
    });
    assert.ok(activationIntent);
    const activationCheckout = await account.createOrReuseCheckoutSession({
      intentId: activationIntent.intentId,
      browserToken: activationIntent.browserToken,
      session: buyerSession,
      baseUrl: BASE_URL,
    });
    assert.equal(activationCheckout.ok, true);
    let activationWrite = stripe.sessionCreateWrites.at(-1);
    assert.equal(
      activationWrite.options.idempotencyKey,
      getCheckoutSessionIdempotencyKey({
        kind: "activation",
        intentId: activationIntent.intentId,
        activationKey,
        attempt: 0,
        parametersFingerprint: getCheckoutParametersFingerprint(
          activationWrite.params,
        ),
      }),
    );
    assert.notEqual(
      activationWrite.options.idempotencyKey,
      getActivationCheckoutIdempotencyKey(activationKey),
    );
    assert.equal(
      activationWrite.params.metadata.sidestream_activation_key,
      activationKey,
    );
    await databasePool.query(
      `
        update public.sidestream_checkout_intents
        set stripe_price_id = 'price_previous_catalog'
        where id = $1
      `,
      [activationIntent.intentId],
    );
    const repricedActivation = await account.createOrReuseCheckoutSession({
      intentId: activationIntent.intentId,
      browserToken: activationIntent.browserToken,
      session: buyerSession,
      baseUrl: BASE_URL,
    });
    assert.equal(repricedActivation.ok, true);
    assert.notEqual(repricedActivation.url, activationCheckout.url);
    assert.equal(stripe.countWrites("checkout.sessions.expire"), 3);
    activationWrite = stripe.sessionCreateWrites.at(-1);
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
      email: buyerSession.email,
      name: "Activation Buyer",
    });
    const deliveries = await Promise.all([
      account.fulfillCheckoutSession(activationWrite.session.id, activationKey),
      account.upsertLicenseFromCheckoutSession({ id: activationWrite.session.id }),
    ]);
    assert.ok(
      deliveries.every((delivery) => delivery.fulfilled),
      JSON.stringify(deliveries),
    );
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
      [activationIntent.intentId],
    );
    assert.deepEqual(fulfilledIntent.rows[0], {
      state: "completed",
      stripe_customer_id: activationWrite.session.customer,
    });

    const indiaBuyer = await seedFreeAccount(databasePool, "india-buyer");
    const indiaBuyerSession = accountSession({
      accountId: indiaBuyer.accountId,
      email: indiaBuyer.email,
      active: false,
    });
    process.env.SIDESTREAM_PRO_INDIA_PRICE_ID =
      "price_checkout_india_wrong_amount";
    await assert.rejects(
      account.createCheckoutIntent({
        buyerCountry: "IN",
        session: indiaBuyerSession,
      }),
      /does not match approved Checkout offer sidestream-unlimited-india/,
    );

    process.env.SIDESTREAM_PRO_INDIA_PRICE_ID = "price_checkout_india";
    const indiaIntent = await account.createCheckoutIntent({
      buyerCountry: "IN",
      session: indiaBuyerSession,
    });
    assert.ok(indiaIntent);
    const indiaCheckout = await account.createOrReuseCheckoutSession({
      intentId: indiaIntent.intentId,
      browserToken: indiaIntent.browserToken,
      session: indiaBuyerSession,
      baseUrl: BASE_URL,
    });
    assert.equal(indiaCheckout.ok, true);
    const indiaWrite = stripe.sessionCreateWrites.at(-1);
    assert.equal(indiaWrite.params.line_items[0].price, "price_checkout_india");
    assert.equal(
      indiaWrite.params.metadata.sidestream_offer_id,
      "sidestream-unlimited-india",
    );
    assert.equal(indiaWrite.params.metadata.sidestream_offer_country, "IN");
    assert.equal(indiaWrite.params.metadata.sidestream_offer_currency, "inr");
    assert.equal(indiaWrite.params.metadata.sidestream_offer_amount_minor, "79900");
    const indiaSnapshot = await databasePool.query(
      `
        select offer_id, offer_country, offer_currency, offer_amount_minor,
          offer_stripe_product_id, offer_stripe_price_id
        from public.sidestream_checkout_intents
        where id = $1
      `,
      [indiaIntent.intentId],
    );
    assert.deepEqual(indiaSnapshot.rows[0], {
      offer_id: "sidestream-unlimited-india",
      offer_country: "IN",
      offer_currency: "inr",
      offer_amount_minor: 79900,
      offer_stripe_product_id: "prod_checkout_test",
      offer_stripe_price_id: "price_checkout_india",
    });
    stripe.complete(indiaWrite.session.id, {
      email: indiaBuyer.email,
      name: "India Buyer",
    });
    assert.deepEqual(
      await account.fulfillCheckoutSession(indiaWrite.session.id),
      { fulfilled: true, activationBound: false },
    );

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
        const india = priceId.startsWith("price_checkout_india");
        return {
          id: priceId,
          active: true,
          product: "prod_checkout_test",
          unit_amount: priceId.endsWith("_wrong_amount")
            ? 79901
            : india ? 79900 : 2499,
          currency: india ? "inr" : "usd",
          recurring: null,
          lookup_key: india ? null : "sidestream_pro_once_2499",
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
          amount_received: session.amount_total,
          currency: session.currency,
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
          currency: session.currency,
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
          const india = params.line_items[0].price === "price_checkout_india";
          const amount = india ? 79900 : 2499;
          const currency = india ? "inr" : "usd";
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
            amount_subtotal: amount,
            amount_total: amount,
            currency,
            total_details: {
              amount_discount: 0,
              amount_shipping: 0,
              amount_tax: 0,
            },
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

  expireExternally(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`Unknown Stripe test Session ${sessionId}`);
    session.status = "expired";
  }

  countWrites(operation) {
    return this.writes.filter((entry) => entry.operation === operation).length;
  }

  get sessionCreateWrites() {
    return this.writes.filter((entry) => entry.operation === "checkout.sessions.create");
  }
}

test("a stale configured Price falls through to the current exact lookup Price", async () => {
  const environmentSnapshot = snapshotEnvironment(CONTROLLED_ENVIRONMENT);
  let runtimeModules;
  try {
    configureRuntime("postgresql://unused.invalid/sidestream");
    const stripe = new RecordingStripe();
    stripe.prices.retrieve = async (priceId) => ({
      id: priceId,
      active: true,
      product: "prod_checkout_test",
      unit_amount: 1499,
      currency: "usd",
      recurring: null,
      lookup_key: "sidestream_pro_once_1499",
    });
    stripe.prices.list = async (params) => ({
      data: params.lookup_keys
        ? [{
            id: "price_checkout_current",
            active: true,
            product: "prod_checkout_test",
            unit_amount: 2499,
            currency: "usd",
            recurring: null,
            lookup_key: "sidestream_pro_once_2499",
          }]
        : [],
    });
    runtimeModules = await loadRuntimeModules();
    runtimeModules.account.__setCheckoutAbuseStripeClient(stripe);

    assert.equal(
      await runtimeModules.account.getSidestreamProPriceId(),
      "price_checkout_current",
    );
  } finally {
    if (runtimeModules) {
      runtimeModules.account.__setCheckoutAbuseStripeClient(null);
      await rm(runtimeModules.temporaryModuleDirectory, {
        recursive: true,
        force: true,
      });
    }
    restoreEnvironment(environmentSnapshot);
  }
});

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

async function applyMigrations(pool) {
  const migrations = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const migration of migrations) {
    await pool.query(await readFile(join(migrationsDirectory, migration), "utf8"));
  }
  assert.ok(migrations.includes("20260713203000_add_checkout_intents.sql"));
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
    imports["./maintenance.js"] = pathToFileURL(await writeAdaptedModule(
      temporaryModuleDirectory,
      "maintenance",
      join(repositoryRoot, "api", "_lib", "maintenance.ts"),
      { "./postgres.js": imports["./postgres.js"] },
    )).href;
    imports["./paid-acquisition.js"] = pathToFileURL(await writeAdaptedModule(
      temporaryModuleDirectory,
      "paid-acquisition",
      join(repositoryRoot, "api", "_lib", "paid-acquisition.ts"),
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
    return { account, temporaryModuleDirectory };
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

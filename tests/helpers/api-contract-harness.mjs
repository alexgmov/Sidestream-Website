import { createHash } from "node:crypto";
import {
  createClaimCsrfToken,
  deriveActivationTokenPair,
  deriveRefreshRotationTokens,
  isActivationClaimReplay,
  sanitizeAccountNextPath,
  validateActivationClaimPost,
  validateClaimCsrfToken,
  verifyPaidCheckoutSession,
} from "../../api/_lib/entitlement.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const CLAIM_CSRF_TTL_SECONDS = 10 * 60;
const ACCESS_TOKEN_TTL_MS = 7 * DAY_MS;
const REFRESH_TOKEN_TTL_MS = 365 * DAY_MS;
const BASE_URL = "https://sidestream.test";

export class ControlledClock {
  #nowMs;

  constructor(initialTime = "2026-07-14T12:00:00.000Z") {
    this.set(initialTime);
  }

  now() {
    return this.#nowMs;
  }

  date() {
    return new Date(this.#nowMs);
  }

  set(value) {
    const next = typeof value === "number" ? value : new Date(value).getTime();
    if (!Number.isFinite(next)) throw new TypeError("Clock time must be finite");
    this.#nowMs = next;
    return this.#nowMs;
  }

  advance(milliseconds) {
    return this.set(this.#nowMs + milliseconds);
  }
}

export class DeterministicRandom {
  #values;
  #index = 0;

  constructor(values = []) {
    this.#values = [...values];
  }

  next(label = "value") {
    const supplied = this.#values[this.#index];
    const sequence = String(this.#index + 1).padStart(4, "0");
    this.#index += 1;
    return supplied ?? `${label}-${sequence}`;
  }

  get calls() {
    return this.#index;
  }
}

export class FakeStripeClient {
  #sessions = new Map();

  constructor(sessions = []) {
    this.calls = [];
    for (const session of sessions) this.setSession(session);
    this.checkout = {
      sessions: {
        retrieve: async (sessionId, options) => {
          this.calls.push({ operation: "checkout.sessions.retrieve", sessionId, options });
          await Promise.resolve();
          const session = this.#sessions.get(sessionId);
          if (!session) throw new Error(`No fake Stripe Session ${sessionId}`);
          return structuredClone(session);
        },
      },
    };
  }

  setSession(session) {
    if (!session?.id) throw new TypeError("Fake Stripe Sessions require an id");
    this.#sessions.set(session.id, structuredClone(session));
  }

  resetCalls() {
    this.calls.length = 0;
  }
}

export class MemoryPersistence {
  constructor(clock) {
    this.clock = clock;
    this.activations = new Map();
    this.credentialsByAccessToken = new Map();
    this.credentialsByRefreshToken = new Map();
    this.activeDevices = new Map();
    this.claimCasWinners = 0;
    this.fulfillmentCasWinners = 0;
  }

  seedActivation(options) {
    const activationKey = options.activationKey;
    if (!activationKey) throw new TypeError("Activation key is required");
    const activation = {
      id: options.id || `activation-row-${this.activations.size + 1}`,
      activationKey,
      deviceId: options.deviceId || "device-1",
      deviceIdHash: hashDeviceId(options.deviceId || "device-1"),
      accountId: options.accountId ?? null,
      licenseId: options.licenseId ?? null,
      licenseActive: options.licenseActive ?? false,
      status: options.status || "pending",
      appVersion: options.appVersion || "1.0.14",
      buildChannel: options.buildChannel || "stable",
      createdAt: options.createdAt ?? this.clock.now(),
      expiresAt: options.expiresAt ?? this.clock.now() + DAY_MS,
      completedAt: options.completedAt ?? null,
      checkout: options.checkout ? { ...options.checkout } : null,
    };
    this.activations.set(activationKey, activation);
    return activation;
  }

  getActivation(activationKey) {
    return this.activations.get(activationKey) || null;
  }

  attachCheckout(activationKey, checkout) {
    const activation = this.getActivation(activationKey);
    if (!activation) throw new Error(`Unknown activation ${activationKey}`);
    activation.checkout = { ...checkout };
    return activation;
  }

  compareAndSetActivationAccount(activationKey, accountId, source) {
    const activation = this.getActivation(activationKey);
    if (!activation) return { accepted: false, won: false, reason: "unavailable" };
    const expired = source === "checkout"
      ? activation.expiresAt < this.clock.now()
      : activation.expiresAt <= this.clock.now();
    if (expired) {
      return { accepted: false, won: false, reason: "unavailable" };
    }
    if (activation.accountId === accountId) {
      return { accepted: true, won: false };
    }
    if (activation.accountId !== null || activation.status !== "pending") {
      return { accepted: false, won: false, reason: "account_conflict" };
    }

    activation.accountId = accountId;
    activation.status = source === "checkout" ? "paid" : "restored";
    if (source === "checkout") this.fulfillmentCasWinners += 1;
    else this.claimCasWinners += 1;
    return { accepted: true, won: true };
  }

  issueCredential(activation, secret) {
    const existing = [...this.credentialsByAccessToken.values()].find(
      (credential) => credential.activationKey === activation.activationKey,
    );
    if (existing) return existing;

    const pair = deriveActivationTokenPair(
      activation.activationKey,
      activation.deviceId,
      secret,
      { licenseNamespace: "production", deviceGeneration: 1 },
    );
    const credential = {
      activationKey: activation.activationKey,
      accountId: activation.accountId,
      deviceId: activation.deviceId,
      licenseToken: pair.licenseToken,
      refreshToken: pair.refreshToken,
      tokenExpiresAt: this.clock.now() + ACCESS_TOKEN_TTL_MS,
      refreshExpiresAt: this.clock.now() + REFRESH_TOKEN_TTL_MS,
      active: true,
    };
    this.#indexCredential(credential);
    activation.completedAt ??= this.clock.now();
    activation.status = "linked";
    return credential;
  }

  rotateCredential(credential, secret) {
    const pair = deriveRefreshRotationTokens(
      credential.refreshToken,
      secret,
      { licenseNamespace: "production", deviceGeneration: 1 },
    );
    this.credentialsByAccessToken.delete(credential.licenseToken);
    this.credentialsByRefreshToken.delete(credential.refreshToken);
    const rotated = {
      ...credential,
      licenseToken: pair.licenseToken,
      refreshToken: pair.refreshToken,
      tokenExpiresAt: this.clock.now() + ACCESS_TOKEN_TTL_MS,
      refreshExpiresAt: this.clock.now() + REFRESH_TOKEN_TTL_MS,
    };
    this.#indexCredential(rotated);
    return rotated;
  }

  #indexCredential(credential) {
    this.credentialsByAccessToken.set(credential.licenseToken, credential);
    this.credentialsByRefreshToken.set(credential.refreshToken, credential);
  }
}

export function createApiContractHarness(options = {}) {
  const clock = options.clock || new ControlledClock();
  const random = options.random || new DeterministicRandom([
    "activation-deterministic",
    "oauth-state-deterministic",
  ]);
  const stripe = options.stripe || new FakeStripeClient();
  const store = options.store || new MemoryPersistence(clock);
  const secret = options.secret || "contract-harness-secret-at-least-32-bytes";
  const environment = Object.freeze({
    namespace: "production",
    deployment: "production",
    databaseUrl: "memory://sidestream-contracts",
  });
  const oauth = {
    state: "",
    nextPath: "/account.html",
    cleared: 0,
    sessionsCreated: 0,
    authUrlError: null,
    prompt: null,
  };

  const dependencies = {
    cleanString,
    methodNotAllowed(response, allowed) {
      response.setHeader("Allow", allowed);
      return dependencies.sendJson(response, 405, { error: "Method not allowed" });
    },
    sendJson(response, statusCode, payload) {
      response.statusCode = statusCode;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify(payload));
    },
    sendGoogleSignInError(response, statusCode, kind) {
      response.statusCode = statusCode;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end(`<title>Sidestream sign-in</title><a href="/api/auth/google/start?next=%2Faccount.html">Continue with Google</a><p>${kind}</p>`);
    },
    redirect(response, location, statusCode = 303) {
      response.statusCode = statusCode;
      response.setHeader("Location", location);
      response.setHeader("Cache-Control", "no-store");
      response.end();
    },
    async readRequestBody(request) {
      return request.contractBody || "";
    },
    async readJsonBody(request) {
      const body = request.contractBody || "";
      return body.trim() ? JSON.parse(body) : {};
    },
    getBaseUrl() {
      return BASE_URL;
    },
    resolveRequestLicenseEnvironment(request) {
      if (request.licenseEnvironment === null) return null;
      return request.licenseEnvironment || environment;
    },
    async resolveRequiredCheckoutAcquisition(_request, _response, resolution = {}) {
      return {
        acquisitionId: "70000000-0000-4000-8000-000000000001",
        browserCookieValue: "contract-browser-acquisition-cookie",
        acceptedHandoffToken: cleanString(resolution.handoffToken, 2_048),
      };
    },
    async createActivationSession(_request, payload) {
      const activationKey = random.next("activation");
      const activation = store.seedActivation({
        activationKey,
        deviceId: cleanString(payload.deviceId, 240),
        appVersion: cleanString(payload.appVersion, 80),
        buildChannel: cleanString(payload.buildChannel, 80),
      });
      return {
        activationKey,
        expiresAt: new Date(activation.expiresAt).toISOString(),
        upgradeUrl: `${BASE_URL}/api/checkout/start?activation=${encodeURIComponent(activationKey)}`,
        restoreUrl: `${BASE_URL}/api/activation/claim?activation=${encodeURIComponent(activationKey)}`,
      };
    },
    async getActivationStatus(activationKey, deviceId, statusOptions = {}) {
      const activation = store.getActivation(activationKey);
      if (!activation) return { status: "not_found" };
      if (activation.deviceIdHash !== hashDeviceId(deviceId)) {
        return { status: "device_mismatch", code: "device_mismatch" };
      }
      if (activation.expiresAt <= clock.now()) {
        activation.status = "expired";
        return { status: "expired" };
      }

      if (
        !statusOptions.skipReconciliation &&
        !activation.licenseId &&
        activation.checkout?.sessionId
      ) {
        await dependencies.fulfillCheckoutSession(
          activation.checkout.sessionId,
          activation.activationKey,
        );
      }
      if (!activation.accountId) return { status: "pending", license: inactiveLicense() };
      if (!activation.licenseId || !activation.licenseActive) {
        return { status: "pending_payment", license: inactiveLicense() };
      }

      const credential = store.issueCredential(activation, secret);
      return {
        status: "active",
        license: activeLicense(),
        licenseToken: credential.licenseToken,
        refreshToken: credential.refreshToken,
        tokenExpiresAt: new Date(credential.tokenExpiresAt).toISOString(),
        refreshExpiresAt: new Date(credential.refreshExpiresAt).toISOString(),
      };
    },
    async verifyLicenseToken(licenseToken, deviceId) {
      const credential = store.credentialsByAccessToken.get(licenseToken);
      if (!credential || !credential.active || credential.tokenExpiresAt <= clock.now()) {
        return { active: false, status: "invalid", code: "invalid_token" };
      }
      if (credential.deviceId !== deviceId) {
        return { active: false, status: "invalid", code: "device_mismatch" };
      }
      return {
        active: true,
        status: "active",
        license: activeLicense(),
        tokenExpiresAt: new Date(credential.tokenExpiresAt).toISOString(),
      };
    },
    async refreshLicenseToken(refreshToken, deviceId) {
      const credential = store.credentialsByRefreshToken.get(refreshToken);
      if (!credential || !credential.active || credential.refreshExpiresAt <= clock.now()) {
        return { active: false, status: "invalid", code: "invalid_token" };
      }
      if (credential.deviceId !== deviceId) {
        return { active: false, status: "invalid", code: "device_mismatch" };
      }
      const rotated = store.rotateCredential(credential, secret);
      return {
        active: true,
        status: "active",
        license: activeLicense(),
        licenseToken: rotated.licenseToken,
        refreshToken: rotated.refreshToken,
        tokenExpiresAt: new Date(rotated.tokenExpiresAt).toISOString(),
        refreshExpiresAt: new Date(rotated.refreshExpiresAt).toISOString(),
      };
    },
    async fulfillCheckoutSession(checkoutSessionId, expectedActivationKey = "") {
      const session = await stripe.checkout.sessions.retrieve(checkoutSessionId, {
        expand: ["line_items.data.price.product"],
      });
      const activationKey = cleanString(session.metadata?.sidestream_activation_key, 160);
      if (expectedActivationKey && activationKey !== expectedActivationKey) {
        return { fulfilled: false, reason: "activation_mismatch" };
      }

      const activation = store.getActivation(activationKey);
      const checkout = activation?.checkout;
      if (!activation || !checkout || checkout.sessionId !== checkoutSessionId) {
        return { fulfilled: false, reason: "unattached_session" };
      }
      const windowFailure = validateCheckoutWindow({ activation, checkout, session, nowMs: clock.now() });
      if (windowFailure) return { fulfilled: false, reason: windowFailure };

      const verification = verifyPaidCheckoutSession(session, {
        sessionId: checkoutSessionId,
        activationKey,
        priceId: checkout.priceId,
        productId: checkout.productId,
        paidPlanKeys: ["sidestream_pro", "sidestream_unlimited"],
      });
      if (!verification.ok) return { fulfilled: false, reason: verification.reason };

      const accountId = cleanString(session.metadata?.sidestream_account_id, 80) ||
        cleanString(session.contract_account_id, 80);
      if (!accountId) return { fulfilled: false, reason: "missing_account" };

      const claimed = store.compareAndSetActivationAccount(activationKey, accountId, "checkout");
      if (!claimed.accepted) {
        return { fulfilled: false, reason: claimed.reason };
      }
      activation.licenseId ||= `license-${checkoutSessionId}`;
      activation.licenseActive = true;
      return { fulfilled: true, activationBound: claimed.won };
    },
    async getSession(request) {
      return request.session || null;
    },
    createActivationClaimCsrf(activationKey, accountId) {
      return createClaimCsrfToken({
        activationKey,
        accountId,
        expiresAtSeconds: Math.floor(clock.now() / 1000) + CLAIM_CSRF_TTL_SECONDS,
        secret,
      });
    },
    validateActivationClaimRequest(request, claim) {
      const nowSeconds = Math.floor(clock.now() / 1000);
      return validateActivationClaimPost({
        requestOrigin: headerValue(request.headers.origin),
        expectedOrigin: BASE_URL,
        contentType: headerValue(request.headers["content-type"]),
        submittedToken: claim.csrfToken,
        expectedToken: claim.csrfToken,
      }) && validateClaimCsrfToken({
        token: claim.csrfToken,
        activationKey: claim.activationKey,
        accountId: claim.accountId,
        nowSeconds,
        secret,
      });
    },
    async claimActivationToAccount(activationKey, accountId) {
      const activation = store.getActivation(activationKey);
      if (!activation) return { claimed: false, reason: "unavailable" };
      if (isActivationClaimReplay({
        existingAccountId: activation.accountId,
        requestedAccountId: accountId,
        status: activation.status,
        expired: activation.expiresAt <= clock.now(),
      })) {
        return { claimed: true };
      }
      const claimed = store.compareAndSetActivationAccount(activationKey, accountId, "restore");
      return claimed.accepted
        ? { claimed: true }
        : { claimed: false, reason: claimed.reason };
    },
    async confirmAccountDeviceTransfer() {
      throw new Error("Device transfer is outside this restore-only baseline harness");
    },
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim().toLowerCase();
      if (normalized.includes("from public.sidestream_activation_sessions a")) {
        const activation = store.getActivation(params[0]);
        if (!activation) return { rows: [] };
        const activeDevice = store.activeDevices.get(params[1]) || null;
        return {
          rows: [{
            activation_account_id: activation.accountId,
            status: activation.status,
            completed_at: activation.completedAt === null
              ? null
              : new Date(activation.completedAt),
            expired: activation.expiresAt <= clock.now(),
            device_id_hash: activation.deviceIdHash,
            app_version: activation.appVersion,
            build_channel: activation.buildChannel,
            active_device_id: activeDevice?.id || null,
            active_device_id_hash: activeDevice?.deviceIdHash || null,
            active_device_platform: activeDevice?.platform || null,
            active_device_activated_at: activeDevice?.activatedAt || null,
            latest_device_id_hash: activeDevice?.deviceIdHash || null,
          }],
        };
      }
      if (
        normalized.includes("from public.sidestream_account_devices") ||
        normalized.includes("from public.sidestream_device_transfers")
      ) {
        return { rows: [] };
      }
      throw new Error(`Unexpected in-memory query: ${normalized.slice(0, 120)}`);
    },
    randomToken() {
      return random.next("token");
    },
    sanitizeNextPath(value) {
      return sanitizeAccountNextPath(value);
    },
    setOAuthCookies(_request, response, values) {
      oauth.state = values.state;
      oauth.nextPath = sanitizeAccountNextPath(values.nextPath);
      response.setHeader("Set-Cookie", ["sidestream_oauth_state=fake", "sidestream_oauth_next=fake"]);
    },
    clearOAuthCookies(_request, response) {
      oauth.cleared += 1;
      response.setHeader("Set-Cookie", ["sidestream_oauth_state=; Max-Age=0", "sidestream_oauth_next=; Max-Age=0"]);
    },
    getOAuthState(request) {
      return request.contractOAuthState ?? oauth.state;
    },
    getOAuthNextPath(request) {
      return sanitizeAccountNextPath(request.contractOAuthNextPath ?? oauth.nextPath);
    },
    getOAuthAcquisitionCookie(request) {
      return request.contractOAuthAcquisitionCookie || "contract-browser-acquisition-cookie";
    },
    async completeGoogleAuthenticationAcquisition() {
      return {
        acquisitionId: "70000000-0000-4000-8000-000000000001",
        possibleForwardedHandoff: false,
      };
    },
    getGoogleAuthUrl(_request, values) {
      if (oauth.authUrlError) throw oauth.authUrlError;
      const url = new URL("https://accounts.google.test/o/oauth2/auth");
      url.searchParams.set("state", values.state);
      oauth.prompt = values.prompt ?? null;
      if (values.prompt) url.searchParams.set("prompt", values.prompt);
      return url.toString();
    },
    async exchangeGoogleCode(_request, code) {
      return { sub: `google-${code}`, email: "owner@example.test", email_verified: true };
    },
    async upsertGoogleAccount() {
      return "account-owner";
    },
    async createWebSession() {
      oauth.sessionsCreated += 1;
      return "web-session-contract";
    },
  };

  return {
    baseUrl: BASE_URL,
    clock,
    random,
    stripe,
    store,
    oauth,
    environment,
    dependencies,
    activeSession(accountId = "account-owner") {
      return {
        accountId,
        email: `${accountId}@example.test`,
        license: activeLicense(),
      };
    },
    seedPaidActivation(options = {}) {
      const activationKey = options.activationKey || "activation-paid";
      const deviceId = options.deviceId || "device-owner";
      const sessionId = options.sessionId || "cs_paid_contract";
      const priceId = options.priceId || "price_contract";
      const productId = options.productId || "prod_contract";
      const accountId = options.accountId || "account-owner";
      const stripeExpiresAt = options.stripeExpiresAt ?? clock.now() + 30 * 60 * 1000;
      const graceUntil = options.graceUntil ?? stripeExpiresAt + 10 * 60 * 1000;
      const activation = store.seedActivation({
        activationKey,
        deviceId,
        expiresAt: options.activationExpiresAt ?? graceUntil,
      });
      store.attachCheckout(activationKey, {
        sessionId,
        priceId,
        productId,
        attachedAt: options.attachedAt ?? clock.now(),
        stripeExpiresAt,
        graceUntil,
      });
      const session = createPaidCheckoutSession({
        sessionId,
        activationKey,
        priceId,
        productId,
        accountId,
        expiresAt: stripeExpiresAt,
        ...options.session,
      });
      stripe.setSession(session);
      return { activation, session, accountId };
    },
  };
}

export function createPaidCheckoutSession(options = {}) {
  const sessionId = options.sessionId || "cs_paid_contract";
  const activationKey = options.activationKey || "activation-paid";
  const priceId = options.priceId || "price_contract";
  const productId = options.productId || "prod_contract";
  const accountId = options.accountId || "account-owner";
  const expiresAt = options.expiresAt ?? Date.now() + 30 * 60 * 1000;
  return {
    id: sessionId,
    mode: options.mode ?? "payment",
    status: options.status ?? "complete",
    payment_status: options.paymentStatus ?? "paid",
    expires_at: Math.floor(expiresAt / 1000),
    customer: options.customer ?? "cus_contract",
    contract_account_id: accountId,
    metadata: {
      sidestream_plan: "sidestream_pro",
      sidestream_price_id: priceId,
      sidestream_activation_key: activationKey,
      sidestream_account_id: accountId,
      ...(options.metadata || {}),
    },
    line_items: {
      data: [{
        quantity: options.quantity ?? 1,
        price: {
          id: options.lineItemPriceId ?? priceId,
          product: options.lineItemProductId ?? productId,
        },
      }],
      has_more: options.hasMore ?? false,
    },
  };
}

export function hashDeviceId(deviceId) {
  return createHash("sha256").update(`contract-device:${deviceId}`).digest("hex");
}

function validateCheckoutWindow({ activation, checkout, session, nowMs }) {
  if (
    checkout.attachedAt > checkout.stripeExpiresAt ||
    checkout.stripeExpiresAt > checkout.graceUntil ||
    checkout.graceUntil > activation.expiresAt
  ) {
    return "invalid_checkout_window";
  }
  if (Number(session.expires_at) * 1000 !== checkout.stripeExpiresAt) {
    return "checkout_expiry_mismatch";
  }
  if (nowMs > checkout.graceUntil) return "checkout_claim_expired";
  return "";
}

function cleanString(value, maxLength = 240) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function headerValue(value) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function activeLicense() {
  return {
    active: true,
    status: "active",
    planKey: "sidestream_pro",
    features: { unlimited_downloads: true },
  };
}

function inactiveLicense() {
  return {
    active: false,
    status: "inactive",
    planKey: "free",
    features: {},
  };
}

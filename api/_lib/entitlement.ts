import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const CHECKOUT_SESSION_PLACEHOLDER = "{CHECKOUT_SESSION_ID}";
export const REFRESH_RETRY_GRACE_SECONDS = 120;
// The original Windows 1.0.13 beta shipped before refresh-token support.
// Keep all 1.0.13 clients on the rolling compatibility token until 1.0.14.
export const LEGACY_LICENSE_CLIENT_MAX_VERSION = "1.0.13";
export const LEGACY_VERCEL_HOST = "sidestream-xi.vercel.app";

export type CredentialDeviceScope = Readonly<{
  licenseNamespace: "production" | "test";
  deviceGeneration: number | string;
}>;

export type CheckoutIntentKind = "anonymous" | "account" | "activation";

export type CheckoutSessionLike = {
  id?: unknown;
  mode?: unknown;
  status?: unknown;
  payment_status?: unknown;
  metadata?: Record<string, unknown> | null;
  line_items?: {
    data?: Array<{
      quantity?: unknown;
      price?: {
        id?: unknown;
        product?: unknown;
      } | null;
    }>;
    has_more?: unknown;
  } | null;
};

export type CheckoutPaymentLike = {
  payment_intent?: unknown;
  payment_status?: unknown;
  amount_total?: unknown;
  currency?: unknown;
};

export type CheckoutPaymentSource =
  | Readonly<{
      ok: true;
      paymentIntentId: string;
      noPaymentRequired: false;
    }>
  | Readonly<{
      ok: true;
      paymentIntentId: "";
      noPaymentRequired: true;
      currency: string;
    }>
  | Readonly<{
      ok: false;
      reason: "missing_payment_intent";
    }>;

export type CheckoutVerification =
  | { ok: true }
  | { ok: false; reason: string };

export const CANONICAL_PAID_PLAN_KEYS = [
  "sidestream_pro",
  "sidestream_unlimited",
] as const;

export type EntitlementStatus = "active" | "suspended" | "revoked" | "unknown";

export type CanonicalOneTimePaymentFacts = Readonly<{
  paymentIntentId: string;
  chargeId: string;
  customerId: string;
  amountPaid: number;
  amountRefunded: number;
  currency: string;
  paymentProven: boolean;
  disputeStatus: string;
  fullRefundRecoveryProven?: boolean;
  reactivationProven?: boolean;
}>;

export type StoredOneTimeEntitlementState = Readonly<{
  paymentIntentId?: string | null;
  chargeId?: string | null;
  customerId?: string | null;
  entitlementStatus?: EntitlementStatus | null;
  statusReason?: string | null;
  stripeEventCreatedAtMs?: number | null;
  stripeEventId?: string | null;
}>;

export type StripeLifecycleEventWatermark = Readonly<{
  createdAtMs: number;
  eventId: string;
}>;

export type OneTimeEntitlementTransition =
  | Readonly<{ apply: false; reason: string }>
  | Readonly<{
      apply: true;
      entitlementStatus: Exclude<EntitlementStatus, "unknown">;
      statusReason: string;
      revokeCredentials: boolean;
    }>;

export type LegacySubscriptionLike = Readonly<{
  items?: {
    data?: readonly Readonly<{
      quantity?: unknown;
      price?: unknown;
    }>[];
    has_more?: unknown;
  } | null;
}>;

export type LegacyPriceLike = Readonly<{
  id?: unknown;
  active?: unknown;
  type?: unknown;
  currency?: unknown;
  unit_amount?: unknown;
  product?: unknown;
  recurring?: {
    interval?: unknown;
    interval_count?: unknown;
    usage_type?: unknown;
  } | null;
}>;

export type LegacyProductLike = Readonly<{
  id?: unknown;
  active?: unknown;
  deleted?: unknown;
}>;

export type LegacySubscriptionVerification =
  | Readonly<{ ok: true; priceId: string; productId: string }>
  | Readonly<{ ok: false; reason: string }>;

export function buildCheckoutCompletionUrl(
  baseUrl: string,
  activationKey = "",
) {
  const url = new URL("/api/checkout/complete", baseUrl);
  url.searchParams.set("session_id", CHECKOUT_SESSION_PLACEHOLDER);
  if (activationKey) url.searchParams.set("activation", activationKey);

  return url.toString().replace(
    encodeURIComponent(CHECKOUT_SESSION_PLACEHOLDER),
    CHECKOUT_SESSION_PLACEHOLDER,
  );
}

export function getActivationCheckoutIdempotencyKey(activationKey: string) {
  const digest = createHash("sha256").update(activationKey).digest("hex");
  return `sidestream_activation_${digest}`;
}

export function getCheckoutSessionIdempotencyKey(options: {
  kind: CheckoutIntentKind;
  intentId: string;
  activationKey?: string;
  attempt: number;
}) {
  if (!Number.isSafeInteger(options.attempt) || options.attempt < 0) {
    throw new TypeError("Checkout attempt must be a non-negative integer");
  }

  if (options.kind === "activation") {
    if (!options.activationKey) {
      throw new TypeError("Activation Checkout requires an activation key");
    }
    const base = getActivationCheckoutIdempotencyKey(options.activationKey);
    return options.attempt === 0 ? base : `${base}_retry_${options.attempt}`;
  }

  const digest = createHash("sha256").update(options.intentId).digest("hex");
  return `sidestream_${options.kind}_intent_${digest}_attempt_${options.attempt}`;
}

export function getStripeCustomerIdempotencyKey(accountId: string) {
  const digest = createHash("sha256").update(accountId).digest("hex");
  return `sidestream_customer_${digest}`;
}

export function getStripePriceIdempotencyKey(productId: string) {
  const digest = createHash("sha256").update(productId).digest("hex");
  return `sidestream_pro_price_${digest}`;
}

export function createCheckoutIntentToken(options: {
  intentId: string;
  browserToken: string;
  expiresAtSeconds: number;
  secret: string;
}) {
  const payload = [
    "v1",
    options.expiresAtSeconds,
    options.intentId,
    options.browserToken,
  ].join(".");
  const signature = createHmac("sha256", options.secret)
    .update(`checkout-intent:${payload}`)
    .digest("base64url");
  return `v1.${options.expiresAtSeconds}.${signature}`;
}

export function validateCheckoutIntentToken(options: {
  token: string;
  intentId: string;
  browserToken: string;
  nowSeconds: number;
  secret: string;
}) {
  const [version, rawExpiresAt, signature, ...rest] = options.token.split(".");
  const expiresAtSeconds = Number(rawExpiresAt);
  if (
    version !== "v1" ||
    rest.length ||
    !signature ||
    !Number.isSafeInteger(expiresAtSeconds) ||
    expiresAtSeconds < options.nowSeconds ||
    expiresAtSeconds > options.nowSeconds + 15 * 60
  ) {
    return false;
  }

  return safeEqual(options.token, createCheckoutIntentToken({
    intentId: options.intentId,
    browserToken: options.browserToken,
    expiresAtSeconds,
    secret: options.secret,
  }));
}

export function validateCheckoutIntentPost(options: {
  requestOrigin: string;
  expectedOrigin: string;
  fetchSite: string;
  contentType: string;
}) {
  let requestOrigin = "";
  let expectedOrigin = "";
  try {
    requestOrigin = new URL(options.requestOrigin).origin;
    expectedOrigin = new URL(options.expectedOrigin).origin;
  } catch {
    return false;
  }

  const mediaType = options.contentType.split(";", 1)[0].trim().toLowerCase();
  return requestOrigin === expectedOrigin &&
    options.fetchSite.trim().toLowerCase() === "same-origin" &&
    ["application/json", "application/x-www-form-urlencoded"].includes(mediaType);
}

export function getStripeCheckoutWindow(
  activationExpiresAtMs: number,
  claimGraceSeconds: number,
) {
  const checkoutExpiresAt = Math.floor(
    (activationExpiresAtMs - claimGraceSeconds * 1000) / 1000,
  );
  return {
    checkoutExpiresAt,
    claimGraceUntil: new Date(
      checkoutExpiresAt * 1000 + claimGraceSeconds * 1000,
    ).toISOString(),
  };
}

export function verifyPaidCheckoutSession(
  session: CheckoutSessionLike,
  expected: {
    sessionId: string;
    activationKey?: string;
    priceId: string;
    productId: string;
    paidPlanKeys: readonly string[];
  },
): CheckoutVerification {
  if (stringId(session.id) !== expected.sessionId) {
    return { ok: false, reason: "session_id_mismatch" };
  }
  if (session.mode !== "payment") {
    return { ok: false, reason: "invalid_checkout_mode" };
  }
  if (session.status !== "complete") {
    return { ok: false, reason: "checkout_incomplete" };
  }
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
    return { ok: false, reason: "payment_incomplete" };
  }

  const metadata = session.metadata || {};
  if (!expected.paidPlanKeys.includes(stringId(metadata.sidestream_plan))) {
    return { ok: false, reason: "invalid_plan" };
  }
  if (stringId(metadata.sidestream_price_id) !== expected.priceId) {
    return { ok: false, reason: "metadata_price_mismatch" };
  }
  if (
    expected.activationKey &&
    stringId(metadata.sidestream_activation_key) !== expected.activationKey
  ) {
    return { ok: false, reason: "activation_mismatch" };
  }

  const lineItems = session.line_items?.data || [];
  if (lineItems.length !== 1 || session.line_items?.has_more === true) {
    return { ok: false, reason: "invalid_line_items" };
  }

  const lineItem = lineItems[0];
  if (lineItem.quantity !== 1) {
    return { ok: false, reason: "invalid_quantity" };
  }
  if (stringId(lineItem.price?.id) !== expected.priceId) {
    return { ok: false, reason: "line_item_price_mismatch" };
  }
  if (stringId(lineItem.price?.product) !== expected.productId) {
    return { ok: false, reason: "line_item_product_mismatch" };
  }

  return { ok: true };
}

export function classifyCheckoutPaymentSource(
  session: CheckoutPaymentLike,
): CheckoutPaymentSource {
  const paymentIntentId = stringId(session.payment_intent).trim();
  if (paymentIntentId) {
    return { ok: true, paymentIntentId, noPaymentRequired: false };
  }

  const currency = typeof session.currency === "string"
    ? session.currency.trim().toLowerCase()
    : "";
  if (
    (session.payment_status === "paid" || session.payment_status === "no_payment_required") &&
    session.amount_total === 0 &&
    /^[a-z]{3}$/.test(currency)
  ) {
    return {
      ok: true,
      paymentIntentId: "",
      noPaymentRequired: true,
      currency,
    };
  }

  return { ok: false, reason: "missing_payment_intent" };
}

export function parseStripeIdAllowlist(value: unknown, prefix: "price" | "prod") {
  const raw = typeof value === "string" ? value : "";
  const ids = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(entry));
  return Object.freeze([...new Set(ids)]);
}

export function verifyLegacySubscriptionEntitlement(
  subscription: LegacySubscriptionLike,
  price: LegacyPriceLike,
  product: LegacyProductLike,
  allowlist: {
    priceIds: readonly string[];
    productIds: readonly string[];
  },
): LegacySubscriptionVerification {
  const items = subscription.items?.data || [];
  if (items.length !== 1 || subscription.items?.has_more !== false) {
    return { ok: false, reason: "invalid_subscription_items" };
  }
  if (items[0].quantity !== 1) {
    return { ok: false, reason: "invalid_subscription_quantity" };
  }

  const itemPriceId = stringId(items[0].price);
  const priceId = stringId(price.id);
  const productId = stringId(product.id);
  const priceProductId = stringId(price.product);
  if (!priceId || itemPriceId !== priceId) {
    return { ok: false, reason: "subscription_price_mismatch" };
  }
  if (!productId || priceProductId !== productId) {
    return { ok: false, reason: "subscription_product_mismatch" };
  }
  if (!allowlist.priceIds.includes(priceId)) {
    return { ok: false, reason: "price_not_allowed" };
  }
  if (!allowlist.productIds.includes(productId)) {
    return { ok: false, reason: "product_not_allowed" };
  }
  if (price.active !== true || product.active !== true || product.deleted === true) {
    return { ok: false, reason: "inactive_billing_resource" };
  }
  if (
    price.type !== "recurring" ||
    price.recurring?.interval !== "month" ||
    price.recurring?.interval_count !== 1 ||
    price.recurring?.usage_type !== "licensed"
  ) {
    return { ok: false, reason: "invalid_recurring_shape" };
  }
  if (
    typeof price.currency !== "string" ||
    !/^[a-z]{3}$/.test(price.currency) ||
    typeof price.unit_amount !== "number" ||
    !Number.isSafeInteger(price.unit_amount) ||
    price.unit_amount <= 0
  ) {
    return { ok: false, reason: "invalid_price_terms" };
  }

  return { ok: true, priceId, productId };
}

export function isCanonicalLicenseEntitlementUsable(options: {
  planKey?: string | null;
  entitlementStatus?: string | null;
}) {
  return options.entitlementStatus === "active" &&
    CANONICAL_PAID_PLAN_KEYS.includes(
      (options.planKey || "") as typeof CANONICAL_PAID_PLAN_KEYS[number],
    );
}

export function canonicalLicenseEntitlementRank(options: {
  planKey?: string | null;
  entitlementStatus?: string | null;
}) {
  return isCanonicalLicenseEntitlementUsable(options) ? 0 : 1;
}

export function shouldApplyStripeEventWatermark(
  current: StripeLifecycleEventWatermark | null,
  next: StripeLifecycleEventWatermark,
) {
  if (
    !Number.isFinite(next.createdAtMs) ||
    next.createdAtMs < 0 ||
    !next.eventId
  ) {
    return false;
  }
  if (!current) return true;
  if (next.createdAtMs !== current.createdAtMs) {
    return next.createdAtMs > current.createdAtMs;
  }
  // Stripe IDs are idempotency keys, not causal clocks. Distinct events in the
  // same Stripe second must both run fresh canonical convergence under the
  // payment fence; only the exact duplicate is stale here.
  return next.eventId !== current.eventId;
}

export function planOneTimeEntitlementTransition(options: {
  stored: StoredOneTimeEntitlementState;
  facts: CanonicalOneTimePaymentFacts;
  event: StripeLifecycleEventWatermark | null;
}): OneTimeEntitlementTransition {
  const paymentIntentId = options.facts.paymentIntentId.trim();
  const chargeId = options.facts.chargeId.trim();
  const customerId = options.facts.customerId.trim();
  if (
    !paymentIntentId ||
    !chargeId ||
    !customerId ||
    !Number.isSafeInteger(options.facts.amountPaid) ||
    options.facts.amountPaid < 0 ||
    !Number.isSafeInteger(options.facts.amountRefunded) ||
    options.facts.amountRefunded < 0 ||
    !/^[a-z]{3}$/.test(options.facts.currency)
  ) {
    return { apply: false, reason: "invalid_payment_facts" };
  }
  if (
    options.stored.paymentIntentId &&
    options.stored.paymentIntentId !== paymentIntentId
  ) {
    return { apply: false, reason: "payment_intent_mismatch" };
  }
  if (options.stored.chargeId && options.stored.chargeId !== chargeId) {
    return { apply: false, reason: "charge_mismatch" };
  }
  if (options.stored.customerId && options.stored.customerId !== customerId) {
    return { apply: false, reason: "payment_customer_mismatch" };
  }

  const currentWatermark = options.stored.stripeEventCreatedAtMs !== null &&
      options.stored.stripeEventCreatedAtMs !== undefined &&
      options.stored.stripeEventId
    ? {
        createdAtMs: options.stored.stripeEventCreatedAtMs,
        eventId: options.stored.stripeEventId,
      }
    : null;
  if (
    options.event &&
    !shouldApplyStripeEventWatermark(currentWatermark, options.event)
  ) {
    return { apply: false, reason: "stale_event" };
  }

  const previousReason = options.stored.statusReason || "";
  const disputeStatus = options.facts.disputeStatus.trim().toLowerCase();
  const openDispute = [
    "warning_needs_response",
    "warning_under_review",
    "needs_response",
    "under_review",
  ].includes(disputeStatus);
  const closedDispute = ["warning_closed", "prevented", "won"].includes(
    disputeStatus,
  );
  const noBlockingDispute = disputeStatus === "none" || closedDispute;

  if (previousReason === "dispute_lost" || disputeStatus === "lost") {
    return inactiveOneTimeTransition("dispute_lost", "revoked");
  }
  if (
    options.facts.amountPaid > 0 &&
    options.facts.amountRefunded >= options.facts.amountPaid
  ) {
    return inactiveOneTimeTransition("full_refund", "revoked");
  }
  if (previousReason === "full_refund") {
    if (
      options.facts.fullRefundRecoveryProven !== true ||
      !options.facts.paymentProven ||
      options.facts.amountPaid <= 0 ||
      !noBlockingDispute
    ) {
      return inactiveOneTimeTransition("full_refund", "revoked");
    }
  }

  if (openDispute || (disputeStatus && !noBlockingDispute)) {
    return inactiveOneTimeTransition("dispute_open", "suspended");
  }
  if (previousReason === "dispute_open" && !closedDispute) {
    return inactiveOneTimeTransition("dispute_open", "suspended");
  }
  if (!options.facts.paymentProven) {
    return inactiveOneTimeTransition("payment_not_paid", "revoked");
  }
  if (
    options.stored.entitlementStatus &&
    options.stored.entitlementStatus !== "active" &&
    options.facts.reactivationProven !== true
  ) {
    return inactiveOneTimeTransition(
      previousReason || "reactivation_unproven",
      options.stored.entitlementStatus === "suspended" ? "suspended" : "revoked",
    );
  }

  const statusReason = closedDispute
    ? `dispute_${disputeStatus}`
    : options.facts.amountRefunded > 0
    ? "partial_refund"
    : "payment_paid";
  return {
    apply: true,
    entitlementStatus: "active",
    statusReason,
    revokeCredentials: false,
  };
}

function inactiveOneTimeTransition(
  statusReason: string,
  entitlementStatus: "suspended" | "revoked",
): OneTimeEntitlementTransition {
  return {
    apply: true,
    entitlementStatus,
    statusReason,
    revokeCredentials: true,
  };
}

export function sanitizeAccountNextPath(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.length > 500 || /[\\\r\n]/.test(raw)) return "/account.html";

  let decoded = "";
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return "/account.html";
  }
  if (decoded.startsWith("//") || /[\\\r\n]/.test(decoded)) return "/account.html";

  try {
    const parsed = new URL(raw, "https://sidestream.invalid");
    if (parsed.origin !== "https://sidestream.invalid") return "/account.html";
    if (parsed.pathname === "/account.html") return `${parsed.pathname}${parsed.search}`;
    if (
      parsed.pathname === "/api/activation/claim" &&
      parsed.searchParams.has("activation")
    ) {
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch {
    // Fall through to the safe account route.
  }

  return "/account.html";
}

export function hasSameOrigin(firstUrl: string, secondUrl: string) {
  try {
    return new URL(firstUrl).origin === new URL(secondUrl).origin;
  } catch {
    return false;
  }
}

export function validateActivationClaimPost(options: {
  requestOrigin: string;
  expectedOrigin: string;
  contentType: string;
}) {
  let requestOrigin = "";
  let expectedOrigin = "";
  try {
    requestOrigin = new URL(options.requestOrigin).origin;
    expectedOrigin = new URL(options.expectedOrigin).origin;
  } catch {
    return false;
  }

  const mediaType = options.contentType.split(";", 1)[0].trim().toLowerCase();
  return requestOrigin === expectedOrigin &&
    mediaType === "application/x-www-form-urlencoded";
}

export function createClaimCsrfToken(options: {
  activationKey: string;
  accountId: string;
  expiresAtSeconds: number;
  secret: string;
}) {
  const payload = `${options.expiresAtSeconds}.${options.accountId}.${options.activationKey}`;
  const signature = createHmac("sha256", options.secret)
    .update(`activation-claim:${payload}`)
    .digest("base64url");
  return `${options.expiresAtSeconds}.${signature}`;
}

export function validateClaimCsrfToken(options: {
  token: string;
  activationKey: string;
  accountId: string;
  nowSeconds: number;
  secret: string;
}) {
  const [rawExpiresAt, signature, ...rest] = options.token.split(".");
  const expiresAtSeconds = Number(rawExpiresAt);
  if (
    rest.length ||
    !Number.isSafeInteger(expiresAtSeconds) ||
    expiresAtSeconds < options.nowSeconds ||
    expiresAtSeconds > options.nowSeconds + 15 * 60 ||
    !signature
  ) {
    return false;
  }

  const expected = createClaimCsrfToken({
    activationKey: options.activationKey,
    accountId: options.accountId,
    expiresAtSeconds,
    secret: options.secret,
  });
  return safeEqual(options.token, expected);
}

export function deriveRefreshRotationTokens(
  refreshToken: string,
  secret: string,
  deviceScope?: CredentialDeviceScope,
) {
  const normalizedScope = normalizeCredentialDeviceScope(deviceScope);
  const seed = createHmac("sha256", secret)
    .update(normalizedScope
      ? [
          "refresh-rotation:v2",
          normalizedScope.licenseNamespace,
          normalizedScope.deviceGeneration,
          refreshToken,
        ].join("\0")
      : `refresh-rotation:${refreshToken}`)
    .digest("base64url");
  return {
    licenseToken: createHmac("sha256", secret)
      .update(`license-token:${seed}`)
      .digest("base64url"),
    refreshToken: createHmac("sha256", secret)
      .update(`refresh-token:${seed}`)
      .digest("base64url"),
  };
}

export function deriveActivationTokenPair(
  activationKey: string,
  deviceId: string,
  secret: string,
  deviceScope?: CredentialDeviceScope,
) {
  const normalizedScope = normalizeCredentialDeviceScope(deviceScope);
  const seed = createHmac("sha256", secret)
    .update(normalizedScope
      ? [
          "activation-token:v2",
          normalizedScope.licenseNamespace,
          normalizedScope.deviceGeneration,
          activationKey,
          deviceId,
        ].join("\0")
      : `activation-token:${activationKey}:${deviceId}`)
    .digest("base64url");
  return {
    licenseToken: createHmac("sha256", secret)
      .update(`activation-license:${seed}`)
      .digest("base64url"),
    refreshToken: createHmac("sha256", secret)
      .update(`activation-refresh:${seed}`)
      .digest("base64url"),
  };
}

export function normalizeCredentialDeviceScope(
  deviceScope: CredentialDeviceScope | undefined,
) {
  if (!deviceScope) return null;
  if (
    deviceScope.licenseNamespace !== "production" &&
    deviceScope.licenseNamespace !== "test"
  ) {
    throw new TypeError("Invalid credential license namespace");
  }

  const deviceGeneration = typeof deviceScope.deviceGeneration === "number"
    ? String(deviceScope.deviceGeneration)
    : deviceScope.deviceGeneration.trim();
  if (!/^[1-9][0-9]*$/.test(deviceGeneration)) {
    throw new TypeError("Invalid credential device generation");
  }

  return {
    licenseNamespace: deviceScope.licenseNamespace,
    deviceGeneration,
  } as const;
}

export function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function matchesDeviceHash(storedHash: string | null, candidateHash: string) {
  return Boolean(storedHash && candidateHash && safeEqual(storedHash, candidateHash));
}

export function canBindActivationAccount(
  existingAccountId: string | null,
  requestedAccountId: string,
) {
  return !existingAccountId || safeEqual(existingAccountId, requestedAccountId);
}

export function isActivationClaimReplay(options: {
  existingAccountId: string | null;
  requestedAccountId: string;
  status: string;
  expired: boolean;
}) {
  return !options.expired &&
    Boolean(options.existingAccountId) &&
    ["restored", "paid", "linked"].includes(options.status) &&
    safeEqual(options.existingAccountId || "", options.requestedAccountId);
}

export function isActivationTokenReplayAllowed(
  completedAtMs: number | null,
  nowMs: number,
  replaySeconds: number,
) {
  return completedAtMs === null || completedAtMs + replaySeconds * 1000 >= nowMs;
}

export function needsLegacyLicenseCompatibility(value: unknown) {
  const version = parseNumericVersion(value);
  const maximum = parseNumericVersion(LEGACY_LICENSE_CLIENT_MAX_VERSION);
  if (!version || !maximum) return false;

  for (let index = 0; index < maximum.length; index += 1) {
    if (version[index] < maximum[index]) return true;
    if (version[index] > maximum[index]) return false;
  }
  return true;
}

export function isLegacyVercelHost(value: unknown) {
  const host = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!host) return false;

  try {
    return new URL(`https://${host}`).hostname === LEGACY_VERCEL_HOST;
  } catch {
    return false;
  }
}

function parseNumericVersion(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  const match = raw.match(/^v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:[-+].*)?$/i);
  if (!match) return null;

  return match.slice(1).map((part) => Number(part));
}

function stringId(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    return typeof value.id === "string" ? value.id : "";
  }
  return "";
}

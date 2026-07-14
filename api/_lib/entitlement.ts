import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const CHECKOUT_SESSION_PLACEHOLDER = "{CHECKOUT_SESSION_ID}";
export const REFRESH_RETRY_GRACE_SECONDS = 120;
// The original Windows 1.0.13 beta shipped before refresh-token support.
// Keep all 1.0.13 clients on the rolling compatibility token until 1.0.14.
export const LEGACY_LICENSE_CLIENT_MAX_VERSION = "1.0.13";
export const LEGACY_VERCEL_HOST = "sidestream-xi.vercel.app";

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

export type CheckoutVerification =
  | { ok: true }
  | { ok: false; reason: string };

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

export function validateActivationClaimPost(options: {
  requestOrigin: string;
  expectedOrigin: string;
  contentType: string;
  submittedToken: string;
  expectedToken: string;
}) {
  let requestOrigin = "";
  let expectedOrigin = "";
  try {
    requestOrigin = new URL(options.requestOrigin).origin;
    expectedOrigin = new URL(options.expectedOrigin).origin;
  } catch {
    return false;
  }

  return requestOrigin === expectedOrigin &&
    options.contentType.toLowerCase().startsWith("application/x-www-form-urlencoded") &&
    safeEqual(options.submittedToken, options.expectedToken);
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

export function deriveRefreshRotationTokens(refreshToken: string, secret: string) {
  const seed = createHmac("sha256", secret)
    .update(`refresh-rotation:${refreshToken}`)
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
) {
  const seed = createHmac("sha256", secret)
    .update(`activation-token:${activationKey}:${deviceId}`)
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

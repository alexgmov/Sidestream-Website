import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { Pool, PoolClient } from "pg";
import Stripe from "stripe";
import {
  buildCheckoutCompletionUrl,
  CANONICAL_PAID_PLAN_KEYS,
  canBindActivationAccount,
  CHECKOUT_SESSION_PLACEHOLDER,
  type CanonicalOneTimePaymentFacts,
  type CheckoutIntentKind,
  type CredentialDeviceScope,
  createClaimCsrfToken,
  deriveActivationTokenPair,
  deriveRefreshRotationTokens,
  getCheckoutSessionIdempotencyKey,
  getCheckoutParametersFingerprint,
  getStripeCustomerIdempotencyKey,
  getStripeCheckoutWindow,
  getStripePriceIdempotencyKey,
  getStripeRecurringPriceIdempotencyKey,
  hasSameOrigin,
  isActivationClaimReplay,
  isCanonicalLicenseEntitlementUsable,
  isZeroTotalCheckoutWithoutPaymentIntent,
  needsLegacyLicenseCompatibility,
  isActivationTokenReplayAllowed,
  parseStripeIdAllowlist,
  planOneTimeEntitlementTransition,
  planUpgradePricingSubscriptionTransition,
  REFRESH_RETRY_GRACE_SECONDS,
  matchesDeviceHash,
  safeEqual,
  sanitizeAccountNextPath,
  shouldApplyStripeEventWatermark,
  validateActivationClaimPost,
  validateClaimCsrfToken,
  verifyApprovedCheckoutPurchase,
  verifyLegacySubscriptionEntitlement,
  verifyUpgradePricingSubscriptionTruth,
} from "./entitlement.js";
import {
  getTrustedCheckoutCountry,
  selectAnnualCheckoutPrice,
  selectMonthlyCheckoutPrice,
  SIDESTREAM_CHECKOUT_OFFER_CATALOG,
  SIDESTREAM_GLOBAL_CHECKOUT_OFFER,
  selectCheckoutOffer,
} from "./checkout-offers.js";
import {
  decideUpgradePricing,
  UPGRADE_PRICING_ANNUAL_VARIANT,
  UPGRADE_PRICING_EXPERIMENT_ID,
  UPGRADE_PRICING_LEGACY_EXPERIMENT_ID,
  UPGRADE_PRICING_MONTHLY_VARIANT,
  type UpgradePricingBillingModel,
  type UpgradePricingDecision,
  type UpgradePricingDecisionReason,
  type UpgradePricingPersistedAssignment,
  type UpgradePricingVariant,
} from "./upgrade-pricing-experiment.js";
import {
  DEVICE_POLICY_ERROR_CODES,
  MAX_ACTIVE_DEVICES,
  applyDevicePolicyMode,
  decideDeviceActivation,
  evaluateDeviceCredentialBinding,
  getDeviceRevocationErrorCode,
  normalizeDevicePlatform,
  resolveDevicePolicyMode,
  type DeviceNamespace,
  type DevicePlatform,
  type DevicePolicyErrorCode,
  type DeviceRevocationReason,
} from "./device-policy.js";
import {
  getLicenseDiagnosticMetadata,
  resolveLicenseEnvironment,
  type ResolvedLicenseEnvironment,
} from "./license-environment.js";
import { LICENSE_ENTITLEMENT_STATUS_SQL } from "./license-entitlement-sql.js";
import {
  attachCustomerIdentity,
  normalizeCustomerIdentityInput,
  type CustomerIdentityInput,
} from "./customer-identity.js";
import { loadLicenseWriteConfiguration } from "./maintenance.js";
import {
  getOptionalRuntimePostgresConnectionString,
  getPostgresPool,
  normalizePostgresConnectionString,
  requireRuntimePostgresTarget,
} from "./postgres.js";
import {
  PAID_ACQUISITION_EXPERIMENT_ID,
  PAID_ACQUISITION_SOURCE,
  completePaidAcquisitionCheckout,
  recordPaidAcquisitionLifecycle,
} from "./paid-acquisition.js";
import {
  ACQUISITION_SECRET_NAME,
  createBrowserAcquisitionCookie,
  readBrowserAcquisitionCookie,
  resolveBrowserAcquisitionCookie,
  serializeBrowserAcquisitionCookie,
  type BrowserAcquisitionCookie,
} from "./acquisition-cookie.js";
import {
  evaluateForwardedDeliveryHandoff,
  verifyServerOwnedDeliveryHandoff,
  type ServerOwnedDeliveryHandoff,
} from "./acquisition-handoff.js";
import {
  AcquisitionIntegrityError,
  addTrustedDeliveryEvidence,
  createCanonicalAcquisitionRoot,
  findCanonicalAcquisition,
  recordAcquisitionStage,
  requireCanonicalAcquisition,
  type CanonicalAcquisition,
} from "./acquisition-integrity.js";

const SESSION_COOKIE = "sidestream_session";
const OAUTH_STATE_COOKIE = "sidestream_oauth_state";
const OAUTH_NEXT_COOKIE = "sidestream_oauth_next";
const OAUTH_ACQUISITION_COOKIE = "sidestream_oauth_acquisition";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const OAUTH_MAX_AGE_SECONDS = 60 * 10;
const ACTIVATION_TTL_HOURS = 24;
const CHECKOUT_CLAIM_GRACE_SECONDS = 10 * 60;
const LICENSE_TOKEN_TTL_DAYS = 7;
const LEGACY_LICENSE_TOKEN_TTL_DAYS = 365;
const REFRESH_TOKEN_TTL_DAYS = 365;
const ACTIVATION_RECONCILIATION_COOLDOWN_SECONDS = 5;
const ACTIVATION_CLAIM_CSRF_TTL_SECONDS = 10 * 60;
const CHECKOUT_INTENT_TTL_HOURS = 24;
const ACTIVATION_TOKEN_REPLAY_SECONDS = 10 * 60;
const MAX_BODY_BYTES = 64 * 1024;
const DEVICE_POLICY_MODE_ENV = "SIDESTREAM_DEVICE_POLICY_MODE";
const ACCOUNT_DEVICE_LOCK_PREFIX = "sidestream:device-support";
const PAID_ELIGIBILITY_LOCK_PREFIX = "sidestream:paid-eligibility";
const ACQUISITION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DEVICE_DEACTIVATION_INTENT = "deactivate_active_device";
export const SIDESTREAM_PRO_PLAN_KEY = "sidestream_pro";
const SIDESTREAM_LEGACY_UNLIMITED_PLAN_KEY = "sidestream_unlimited";
const SIDESTREAM_PAID_PLAN_KEYS = CANONICAL_PAID_PLAN_KEYS;
const LEGACY_SUBSCRIPTION_PRODUCT_IDS_ENV =
  "SIDESTREAM_LEGACY_SUBSCRIPTION_PRODUCT_IDS";
const LEGACY_SUBSCRIPTION_PRICE_IDS_ENV =
  "SIDESTREAM_LEGACY_SUBSCRIPTION_PRICE_IDS";
const SIDESTREAM_PRO_DEFAULT_PRODUCT_ID = "prod_UpwXh6oO1OmPyQ";
// Stripe Prices are immutable. Resolve the active approved global Price by
// lookup key, creating it once if this deployment is the first to use it.
const SIDESTREAM_PRO_DEFAULT_PRICE_ID = "";
const SIDESTREAM_PRO_PRICE = {
  lookupKey: SIDESTREAM_GLOBAL_CHECKOUT_OFFER.lookupKey!,
  name: "Sidestream Unlimited",
  description: "Lifetime Sidestream Unlimited access for one editor.",
  unitAmount: SIDESTREAM_GLOBAL_CHECKOUT_OFFER.amountMinor,
  currency: SIDESTREAM_GLOBAL_CHECKOUT_OFFER.currency,
};
const UPGRADE_PRICING_MONTHLY_INTERVAL = "month";
const UPGRADE_PRICING_MONTHLY_INTERVAL_COUNT = 1;
const UPGRADE_PRICING_MONTHLY_USAGE_TYPE = "licensed";
const UPGRADE_PRICING_ANNUAL_INTERVAL = "year";
const UPGRADE_PRICING_ANNUAL_INTERVAL_COUNT = 1;
const UPGRADE_PRICING_ANNUAL_USAGE_TYPE = "licensed";
const BASIC_SUBSCRIPTION_RESOURCE_KEY_BASE = "basic_subscription";
const BASIC_SUBSCRIPTION_PRODUCT = {
  name: "Basic subscription",
  description: "A basic subscription to our service",
  taxCode: "txcd_10103100",
  unitAmount: 499,
  currency: "usd",
  interval: "month",
};
let stripeClient: Stripe | null = null;

export type AccountRequest = IncomingMessage & {
  method?: string;
};

export { getTrustedCheckoutCountry };

export type AccountSession = {
  accountId: string;
  email: string;
  name: string;
  avatarUrl: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  license: LicenseSummary;
};

export type LicenseSummary = {
  active: boolean;
  plan: string;
  status: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  graceUntil: string;
  features: Record<string, unknown>;
};

export type CheckoutIntent = {
  intentId: string;
  browserToken: string;
  intentExpiresAt: string;
  kind: CheckoutIntentKind;
  activationKey: string;
};

export type CheckoutIntentResult =
  | {
      ok: true;
      url: string;
      reused: boolean;
    }
  | {
      ok: false;
      statusCode: number;
      error: string;
      code: string;
    };

export type ConfirmAccountDeviceTransferOptions = {
  accountId: string;
  environment: ResolvedLicenseEnvironment;
  expectedPriorDeviceId: string;
  expectedPriorDeviceIdHash: string;
  newDeviceIdHash: string;
  platform?: unknown;
  appVersion?: unknown;
  buildChannel?: unknown;
  initiatedBy: "account" | "support" | "system";
  transferReason: "device_change" | "lost_device" | "support_override";
};

type GoogleProfile = {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};

type BillingResource = {
  stripe_product_id: string;
  stripe_price_id: string;
  unit_amount: number;
  currency: string;
  recurring_interval: string;
};

export function methodNotAllowed(
  response: ServerResponse,
  allowed: string,
) {
  response.setHeader("Allow", allowed);
  return sendJson(response, 405, { error: "Method not allowed" });
}

export function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

export function sendGoogleSignInError(
  response: ServerResponse,
  statusCode: number,
  kind: "invalid_state" | "unavailable" | "failed",
) {
  const content = kind === "invalid_state"
    ? {
      title: "Let's try that again.",
      message: "The secure Google sign-in check expired or no longer matches this browser.",
    }
    : kind === "unavailable"
    ? {
      title: "Sign-in is temporarily unavailable.",
      message: "Sidestream could not start Google sign-in. Please try again in a moment.",
    }
    : {
      title: "Google sign-in did not finish.",
      message: "No account was changed. You can safely restart the sign-in flow.",
    };

  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <title>${content.title} | Sidestream</title>
    <style>
      :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Arial, sans-serif; }
      * { box-sizing: border-box; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: #0b0b0d; color: #e2e8f0; }
      main { width: min(100%, 560px); padding: clamp(28px, 6vw, 52px); border: 1px solid #303038; border-radius: 24px; background: #111114; }
      .eyebrow { margin: 0 0 14px; color: #8f9099; font-size: 13px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
      h1 { margin: 0; font-size: clamp(34px, 7vw, 58px); line-height: .98; letter-spacing: -.04em; }
      p { margin: 22px 0 28px; color: #afb0b8; font-size: 17px; line-height: 1.55; }
      .actions { display: flex; flex-wrap: wrap; gap: 12px; }
      a { display: inline-flex; min-height: 48px; align-items: center; justify-content: center; padding: 0 20px; border-radius: 999px; font-weight: 700; text-decoration: none; }
      .primary { background: #f8fafc; color: #09090b; }
      .secondary { border: 1px solid #393941; color: #e2e8f0; }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Sidestream account</p>
      <h1>${content.title}</h1>
      <p>${content.message}</p>
      <div class="actions">
        <a class="primary" href="/api/auth/google/start?next=%2Faccount.html">Continue with Google</a>
        <a class="secondary" href="/">Back to site</a>
      </div>
    </main>
  </body>
</html>`);
}

export function redirect(
  response: ServerResponse,
  location: string,
  statusCode = 303,
) {
  response.statusCode = statusCode;
  response.setHeader("Location", location);
  response.setHeader("Cache-Control", "no-store");
  response.end();
}

export async function readRequestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error("Request body too large");
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

export async function readJsonBody<T>(
  request: IncomingMessage,
): Promise<T> {
  const body = await readRequestBody(request);
  if (!body.trim()) return {} as T;
  return JSON.parse(body) as T;
}

export function getBaseUrl(request: IncomingMessage) {
  const configured = process.env.SIDESTREAM_BASE_URL || process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/+$/g, "");

  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`.replace(/\/+$/g, "");
  }

  const host = firstHeaderValue(request.headers.host) || "127.0.0.1:3000";
  const proto = firstHeaderValue(request.headers["x-forwarded-proto"]) || "http";
  return `${proto}://${host}`.replace(/\/+$/g, "");
}

export function validateSameOriginJsonMutation(request: IncomingMessage) {
  const contentType = firstHeaderValue(request.headers["content-type"])
    .trim()
    .toLowerCase();
  if (!contentType.startsWith("application/json")) return false;

  try {
    const requestOrigin = new URL(
      firstHeaderValue(request.headers.origin),
    ).origin;
    const expectedOrigin = new URL(getBaseUrl(request)).origin;
    return requestOrigin === expectedOrigin;
  } catch {
    return false;
  }
}

export function resolveRequestLicenseEnvironment(request: IncomingMessage) {
  // `Host` is the platform routing authority here. Client JSON and diagnostic
  // build metadata never participate in namespace selection.
  return resolveLicenseEnvironment({
    serverEnv: process.env,
    trustedRequestHost: firstHeaderValue(request.headers.host),
  });
}

export type RequiredCheckoutAcquisition = Readonly<{
  acquisitionId: string;
  browserCookieValue: string;
  acceptedHandoffToken: string;
  origin: "browser_cookie" | "server_delivery_handoff" | "website_direct_or_unknown";
}>;

/**
 * Checkout is a fail-closed acquisition boundary. Browser attribution is used
 * only after its server signature verifies; delivery attribution is used only
 * after its encrypted server envelope verifies. Everything else becomes a new
 * truthful Sidestream website entry before any Checkout intent is inserted.
 */
export async function resolveRequiredCheckoutAcquisition(
  request: IncomingMessage,
  response: ServerResponse,
  options: Readonly<{ handoffToken?: unknown; now?: Date }> = {},
): Promise<RequiredCheckoutAcquisition> {
  const secret = process.env[ACQUISITION_SECRET_NAME]?.trim() || "";
  const now = options.now || new Date();
  const cookieValue = readBrowserAcquisitionCookie(request.headers.cookie);
  if (cookieValue) {
    let resolved: ReturnType<typeof resolveBrowserAcquisitionCookie> | null = null;
    try {
      resolved = resolveBrowserAcquisitionCookie(cookieValue, { secret, now });
    } catch {
      // A forged, expired, duplicated, or malformed browser value has no
      // authority. A valid server handoff may still restore exact continuity.
    }
    if (resolved) {
      await ensureBrowserCheckoutAcquisition(resolved.cookie);
      if (resolved.promoted) {
        appendSetCookies(response, [serializeBrowserAcquisitionCookie(resolved.cookie)]);
      }
      return Object.freeze({
        acquisitionId: resolved.cookie.acquisitionId,
        browserCookieValue: resolved.cookie.value,
        acceptedHandoffToken: "",
        origin: "browser_cookie" as const,
      });
    }
  }

  if (typeof options.handoffToken === "string" && options.handoffToken) {
    let handoff: ServerOwnedDeliveryHandoff | null = null;
    try {
      handoff = verifyServerOwnedDeliveryHandoff(options.handoffToken, {
        secret,
        now,
      });
    } catch {
      // Browser input never selects a trusted delivery channel. Invalid
      // envelopes fall through to a new direct/unknown website root.
    }
    if (handoff) {
      await ensureDeliveryCheckoutAcquisition(handoff, now);
      const restoredCookie = createBrowserAcquisitionCookie({
        acquisitionId: handoff.acquisitionId,
        attribution: {
          source: handoff.source,
          medium: "email",
          campaign: handoff.campaign,
          content: null,
        },
        externalReferrerCategory: handoff.externalReferrerCategory,
      }, { secret, now });
      appendSetCookies(response, [serializeBrowserAcquisitionCookie(restoredCookie)]);
      return Object.freeze({
        acquisitionId: handoff.acquisitionId,
        browserCookieValue: restoredCookie.value,
        acceptedHandoffToken: options.handoffToken,
        origin: "server_delivery_handoff" as const,
      });
    }
  }

  const directCookie = createBrowserAcquisitionCookie({}, { secret, now });
  await ensureBrowserCheckoutAcquisition(directCookie);
  appendSetCookies(response, [serializeBrowserAcquisitionCookie(directCookie)]);
  return Object.freeze({
    acquisitionId: directCookie.acquisitionId,
    browserCookieValue: directCookie.value,
    acceptedHandoffToken: "",
    origin: "website_direct_or_unknown" as const,
  });
}

export async function completeGoogleAuthenticationAcquisition(options: Readonly<{
  oauthAcquisitionCookieValue: string;
  nextPath: string;
  exactVerifiedEmail: string;
  accountId: string;
  response: ServerResponse;
  now?: Date;
}>) {
  const secret = process.env[ACQUISITION_SECRET_NAME]?.trim() || "";
  const now = options.now || new Date();
  const resolved = resolveBrowserAcquisitionCookie(
    options.oauthAcquisitionCookieValue,
    { secret, now },
  );
  await ensureBrowserCheckoutAcquisition(resolved.cookie);
  await recordAuthenticatedAccountAcquisition({
    acquisitionId: resolved.cookie.acquisitionId,
    accountId: options.accountId,
    occurredAt: now,
  });

  let possibleForwardedHandoff = false;
  const handoffToken = readCheckoutHandoffFromNextPath(options.nextPath);
  if (handoffToken) {
    try {
      const handoff = verifyServerOwnedDeliveryHandoff(handoffToken, { secret, now });
      if (handoff.acquisitionId === resolved.cookie.acquisitionId) {
        possibleForwardedHandoff = evaluateForwardedDeliveryHandoff(
          handoff,
          options.exactVerifiedEmail,
          { secret },
        ).possibleForwardedHandoff;
      }
    } catch {
      // The verified OAuth acquisition remains authoritative. An invalid query
      // envelope cannot select or rewrite its first-touch channel.
    }
  }
  appendSetCookies(options.response, [serializeBrowserAcquisitionCookie(resolved.cookie)]);
  return Object.freeze({
    acquisitionId: resolved.cookie.acquisitionId,
    possibleForwardedHandoff,
  });
}

/**
 * Records one exact authenticated account against one canonical acquisition.
 * OAuth callbacks and already-signed-in Checkout entries share the same
 * acquisition/account-scoped key, so retries remain durable and idempotent.
 */
export async function recordAuthenticatedAccountAcquisition(options: Readonly<{
  acquisitionId: string;
  accountId: string;
  occurredAt?: Date;
}>) {
  const acquisitionId = requiredAcquisitionId(options.acquisitionId);
  const accountId = cleanString(options.accountId, 36);
  if (!ACQUISITION_ID.test(accountId)) {
    throw new AcquisitionIntegrityError(
      "authenticated_account_invalid",
      "Authenticated account identity is invalid.",
    );
  }
  const occurredAt = options.occurredAt || new Date();
  assertCheckoutAcquisitionIntact(
    await requireCanonicalAcquisition(acquisitionId),
  );
  await addTrustedDeliveryEvidence({
    acquisitionId,
    evidence: "authenticated_account",
  });
  const stage = await recordAcquisitionStage({
    acquisitionId,
    stage: "authentication_completed",
    stableServerReference:
      `google-account:${acquisitionId}:${accountId}`,
    occurredAt,
  });
  if (stage.ownerConflict) {
    throw new AcquisitionIntegrityError(
      "authentication_acquisition_conflict",
      "Authentication acquisition ownership conflicted.",
    );
  }
  return stage;
}

function readCheckoutHandoffFromNextPath(nextPath: string) {
  try {
    const url = new URL(nextPath, "https://sidestream.tv");
    if (url.pathname !== "/api/checkout/start") return "";
    const values = url.searchParams.getAll("handoff");
    return values.length === 1 ? values[0] : "";
  } catch {
    return "";
  }
}

async function ensureBrowserCheckoutAcquisition(cookie: BrowserAcquisitionCookie) {
  const existing = await findCanonicalAcquisition(cookie.acquisitionId);
  if (existing) return assertCheckoutAcquisitionIntact(existing);
  const hasExternalReferrer = cookie.externalReferrerCategory !== null;
  return assertCheckoutAcquisitionIntact(await createCanonicalAcquisitionRoot({
    acquisitionId: cookie.acquisitionId,
    firstObservedAt: new Date(cookie.issuedAt * 1_000),
    landingDeduplicationReference: `browser-entry:${cookie.acquisitionId}`,
    source: cookie.attribution.source === "direct"
      ? hasExternalReferrer ? "external_referrer" : "website_direct_or_unknown"
      : cookie.attribution.source,
    medium: cookie.attribution.source === "direct" && hasExternalReferrer
      ? cookie.externalReferrerCategory
      : cookie.attribution.medium,
    campaign: cookie.attribution.campaign,
    contentCreative: cookie.attribution.content,
    entryChannel: "website",
    externalReferrerCategory: cookie.externalReferrerCategory,
    experiment: cookie.experiment
      ? {
          id: cookie.experiment.experimentId.toLowerCase(),
          cohort: cookie.experiment.cohort,
        }
      : null,
    attributionConfidence: "exact_sidestream_entry",
    integrityState: "intact",
    trustedDeliveryEvidence: ["website_entry"],
  }));
}

async function ensureDeliveryCheckoutAcquisition(
  handoff: ServerOwnedDeliveryHandoff,
  landingObservedAt: Date,
) {
  const acquisition = await createCanonicalAcquisitionRoot({
    acquisitionId: handoff.acquisitionId,
    firstObservedAt: new Date(handoff.issuedAt * 1_000),
    landingDeduplicationReference:
      `delivery-entry:${handoff.entryChannel}:${handoff.acquisitionId}`,
    source: handoff.source,
    medium: "email",
    campaign: handoff.campaign,
    contentCreative: null,
    entryChannel: handoff.canonicalEntryChannel,
    externalReferrerCategory: handoff.externalReferrerCategory,
    attributionConfidence: "exact_trusted_delivery",
    integrityState: "intact",
    trustedDeliveryEvidence: ["signed_email_handoff"],
    recordLandingObserved: false,
  });
  assertCheckoutAcquisitionIntact(acquisition);
  await recordAcquisitionStage({
    acquisitionId: handoff.acquisitionId,
    stage: "email_handoff_created",
    stableServerReference:
      `delivery-handoff:${handoff.entryChannel}:${handoff.acquisitionId}`,
    occurredAt: new Date(handoff.issuedAt * 1_000),
  });
  await recordAcquisitionStage({
    acquisitionId: handoff.acquisitionId,
    stage: "landing_observed",
    stableServerReference:
      `delivery-checkout:${handoff.entryChannel}:${handoff.acquisitionId}`,
    occurredAt: landingObservedAt,
  });
  return acquisition;
}

export function getGoogleRedirectUri(request: IncomingMessage) {
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ||
    `${getBaseUrl(request)}/api/auth/google/callback`;
  const requestOrigin = getOAuthRequestOrigin(request);

  if (!hasSameOrigin(redirectUri, requestOrigin)) {
    const configuredOrigin = safeUrlOrigin(redirectUri) || "invalid";
    throw new Error(
      `GOOGLE_REDIRECT_URI origin ${configuredOrigin} must match OAuth request origin ${requestOrigin}`,
    );
  }

  return redirectUri;
}

export function getGoogleAuthUrl(
  request: IncomingMessage,
  options: { state: string; prompt?: "select_account" },
) {
  const clientId = requireEnv("GOOGLE_CLIENT_ID");
  const redirectUri = getGoogleRedirectUri(request);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: options.state,
    include_granted_scopes: "true",
  });
  if (options.prompt) params.set("prompt", options.prompt);

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function setOAuthCookies(
  request: IncomingMessage,
  response: ServerResponse,
  options: { state: string; nextPath: string; acquisitionCookieValue: string },
) {
  appendSetCookies(response, [
    serializeCookie(OAUTH_STATE_COOKIE, options.state, {
      httpOnly: true,
      maxAge: OAUTH_MAX_AGE_SECONDS,
      path: "/",
      sameSite: "Lax",
      secure: shouldUseSecureCookies(request),
    }),
    serializeCookie(OAUTH_NEXT_COOKIE, encodeBase64Url(options.nextPath), {
      httpOnly: true,
      maxAge: OAUTH_MAX_AGE_SECONDS,
      path: "/",
      sameSite: "Lax",
      secure: shouldUseSecureCookies(request),
    }),
    serializeCookie(OAUTH_ACQUISITION_COOKIE, options.acquisitionCookieValue, {
      httpOnly: true,
      maxAge: OAUTH_MAX_AGE_SECONDS,
      path: "/",
      sameSite: "Lax",
      secure: shouldUseSecureCookies(request),
    }),
  ]);
}

export function clearOAuthCookies(
  request: IncomingMessage,
  response: ServerResponse,
) {
  appendSetCookies(response, [
    serializeCookie(OAUTH_STATE_COOKIE, "", {
      httpOnly: true,
      maxAge: 0,
      path: "/",
      sameSite: "Lax",
      secure: shouldUseSecureCookies(request),
    }),
    serializeCookie(OAUTH_NEXT_COOKIE, "", {
      httpOnly: true,
      maxAge: 0,
      path: "/",
      sameSite: "Lax",
      secure: shouldUseSecureCookies(request),
    }),
    serializeCookie(OAUTH_ACQUISITION_COOKIE, "", {
      httpOnly: true,
      maxAge: 0,
      path: "/",
      sameSite: "Lax",
      secure: shouldUseSecureCookies(request),
    }),
  ]);
}

export function getOAuthState(request: IncomingMessage) {
  return getCookie(request, OAUTH_STATE_COOKIE);
}

export function getOAuthNextPath(request: IncomingMessage) {
  const encoded = getCookie(request, OAUTH_NEXT_COOKIE);
  if (!encoded) return "/account.html";

  try {
    return sanitizeNextPath(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return "/account.html";
  }
}

export function getOAuthAcquisitionCookie(request: IncomingMessage) {
  return getCookie(request, OAUTH_ACQUISITION_COOKIE);
}

export async function exchangeGoogleCode(
  request: IncomingMessage,
  code: string,
) {
  const clientId = requireEnv("GOOGLE_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_CLIENT_SECRET");
  const redirectUri = getGoogleRedirectUri(request);
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error(`Google token exchange failed with ${tokenResponse.status}`);
  }

  const tokenPayload = await tokenResponse.json() as { access_token?: string };
  if (!tokenPayload.access_token) {
    throw new Error("Google token exchange returned no access token");
  }

  const profileResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
  });

  if (!profileResponse.ok) {
    throw new Error(`Google profile lookup failed with ${profileResponse.status}`);
  }

  const profile = await profileResponse.json() as GoogleProfile;
  const email = normalizeEmail(profile.email);

  if (!profile.sub || !email || profile.email_verified === false) {
    throw new Error("Google account did not return a verified email");
  }

  return {
    googleSub: profile.sub,
    email,
    name: cleanString(profile.name, 180),
    avatarUrl: cleanString(profile.picture, 500),
  };
}

export async function upsertGoogleAccount(profile: {
  googleSub: string;
  email: string;
  name: string;
  avatarUrl: string;
}) {
  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `sidestream_account:${profile.email}`,
      ]);

      const linked = await client.query<{ id: string }>(
        `
          update public.sidestream_accounts
          set google_sub = $2,
              display_name = $3,
              avatar_url = $4,
              last_login_at = now(),
              updated_at = now()
          where id = (
            select id
            from public.sidestream_accounts
            where email = $1
              and google_sub is null
            order by updated_at desc
            limit 1
          )
          returning id
        `,
        [profile.email, profile.googleSub, profile.name || null, profile.avatarUrl || null],
      );

      if (linked.rows[0]?.id) {
        await client.query("commit");
        return linked.rows[0].id;
      }

      const inserted = await client.query<{ id: string }>(
        `
          insert into public.sidestream_accounts (
            google_sub,
            email,
            display_name,
            avatar_url,
            last_login_at,
            created_at,
            updated_at
          )
          values ($1, $2, $3, $4, now(), now(), now())
          on conflict (google_sub) do update set
            email = excluded.email,
            display_name = excluded.display_name,
            avatar_url = excluded.avatar_url,
            last_login_at = now(),
            updated_at = now()
          returning id
        `,
        [profile.googleSub, profile.email, profile.name || null, profile.avatarUrl || null],
      );

      await client.query("commit");
      return inserted.rows[0].id;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function createWebSession(
  request: IncomingMessage,
  response: ServerResponse,
  accountId: string,
) {
  const token = randomToken(32);
  const tokenHash = hashToken(token);
  const expiresAt = addSeconds(new Date(), SESSION_MAX_AGE_SECONDS);

  await query(
    `
      insert into public.sidestream_account_sessions (
        account_id,
        session_token_hash,
        user_agent,
        ip_address,
        expires_at,
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4::inet, $5::timestamptz, now(), now())
    `,
    [
      accountId,
      tokenHash,
      cleanString(request.headers["user-agent"], 500) || null,
      getClientIp(request) || null,
      expiresAt.toISOString(),
    ],
  );

  appendSetCookies(response, [
    serializeCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      maxAge: SESSION_MAX_AGE_SECONDS,
      path: "/",
      sameSite: "Lax",
      secure: shouldUseSecureCookies(request),
    }),
  ]);
}

export async function clearWebSession(
  request: IncomingMessage,
  response: ServerResponse,
) {
  const token = getCookie(request, SESSION_COOKIE);
  if (token) {
    await query(
      `
        update public.sidestream_account_sessions
        set revoked_at = now(), updated_at = now()
        where session_token_hash = $1
      `,
      [hashToken(token)],
    );
  }

  appendSetCookies(response, [
    serializeCookie(SESSION_COOKIE, "", {
      httpOnly: true,
      maxAge: 0,
      path: "/",
      sameSite: "Lax",
      secure: shouldUseSecureCookies(request),
    }),
  ]);
}

export async function getSession(
  request: IncomingMessage,
  _options: { reconcileStripeEvents?: boolean } = {},
): Promise<AccountSession | null> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;

  const result = await query<{
    account_id: string;
    email: string;
    display_name: string | null;
    avatar_url: string | null;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    license_status: string | null;
    plan_key: string | null;
    entitlement_status: string | null;
    current_period_end: Date | string | null;
    cancel_at_period_end: boolean | null;
    grace_until: Date | string | null;
    features: Record<string, unknown> | null;
  }>(
    `
      select
        a.id as account_id,
        a.email,
        a.display_name,
        a.avatar_url,
        a.stripe_customer_id,
        l.stripe_subscription_id,
        l.status as license_status,
        l.plan_key,
        license_state.entitlement_status,
        l.current_period_end,
        l.cancel_at_period_end,
        l.grace_until,
        l.features
      from public.sidestream_account_sessions s
      join public.sidestream_accounts a on a.id = s.account_id
      left join public.sidestream_licenses l on l.account_id = a.id
      left join lateral (
        select ${LICENSE_ENTITLEMENT_STATUS_SQL} as entitlement_status
      ) license_state on true
      where s.session_token_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()
      -- Only canonically reconciled paid rows may outrank another license.
      order by (case
          when license_state.entitlement_status = 'active'
            and l.plan_key in ('sidestream_pro', 'sidestream_unlimited') then 0
          else 1
        end),
        l.updated_at desc nulls last
      limit 1
    `,
    [hashToken(token)],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    accountId: row.account_id,
    email: row.email,
    name: row.display_name || "",
    avatarUrl: row.avatar_url || "",
    stripeCustomerId: row.stripe_customer_id || "",
    stripeSubscriptionId: row.stripe_subscription_id || "",
    license: buildLicenseSummary({
      status: row.license_status,
      planKey: row.plan_key,
      entitlementStatus: row.entitlement_status,
      currentPeriodEnd: row.current_period_end,
      cancelAtPeriodEnd: row.cancel_at_period_end,
      graceUntil: row.grace_until,
      features: row.features,
    }),
  };
}

export async function requireSession(
  request: IncomingMessage,
  response: ServerResponse,
) {
  const session = await getSession(request);
  if (!session) {
    sendJson(response, 401, { error: "Authentication required" });
    return null;
  }
  return session;
}

export function publicSessionPayload(session: AccountSession | null) {
  if (!session) {
    return { authenticated: false };
  }

  return {
    authenticated: true,
    user: {
      email: session.email,
      name: session.name,
      avatarUrl: session.avatarUrl,
    },
    license: session.license,
    billing: {
      hasCustomer: Boolean(session.stripeCustomerId),
      hasSubscription: Boolean(session.stripeSubscriptionId),
      canCancelSubscription: canCancelAccountSubscription(session),
    },
  };
}

export function canCancelAccountSubscription(session: AccountSession) {
  return Boolean(
    session.stripeSubscriptionId &&
    session.license.active &&
    !session.license.cancelAtPeriodEnd
  );
}

type CheckoutIntentRow = {
  id: string;
  acquisition_id: string | null;
  intent_kind: CheckoutIntentKind;
  account_id: string | null;
  activation_session_id: string | null;
  state: string;
  attempt: number;
  stripe_customer_id: string | null;
  stripe_checkout_session_id: string | null;
  stripe_checkout_url: string | null;
  stripe_price_id: string | null;
  stripe_product_id: string | null;
  offer_id: string | null;
  offer_country: string | null;
  offer_currency: string | null;
  offer_amount_minor: number | null;
  offer_stripe_product_id: string | null;
  offer_stripe_price_id: string | null;
  stripe_session_expires_at: Date | string | null;
  expires_at: Date | string;
  activation_key: string | null;
  activation_expires_at: Date | string | null;
  activation_checkout_session_id: string | null;
  upgrade_pricing_snapshot_version: number | null;
  upgrade_pricing_experiment_id: string | null;
  upgrade_pricing_decision_reason: string | null;
  upgrade_pricing_assignment_id: string | null;
  upgrade_pricing_assignment_bucket: number | null;
  upgrade_pricing_rollout_basis_points: number | null;
  upgrade_pricing_assigned_at: Date | string | null;
  upgrade_pricing_variant: string | null;
  upgrade_pricing_billing_model: string | null;
  upgrade_pricing_country: string | null;
  upgrade_pricing_currency: string | null;
  upgrade_pricing_amount_minor: number | null;
  upgrade_pricing_stripe_product_id: string | null;
  upgrade_pricing_stripe_price_id: string | null;
  upgrade_pricing_account_id: string | null;
  upgrade_pricing_acquisition_id: string | null;
  upgrade_pricing_checkout_intent_id: string | null;
  upgrade_pricing_activation_session_id: string | null;
};

type CheckoutOfferSnapshot = Readonly<{
  offerId: string;
  country: string;
  currency: string;
  amountMinor: number;
  productId: string;
  priceId: string;
}>;

type UpgradePricingIntentSnapshot = Readonly<{
  snapshotVersion: 1 | 2;
  experimentId: "upgrade-pricing-v1" | "upgrade-pricing-v2";
  decisionReason: UpgradePricingDecisionReason;
  assignmentId: string | null;
  assignmentBucket: number | null;
  rolloutBasisPoints: number;
  assignedAt: string | null;
  variant: UpgradePricingVariant;
  billingModel: UpgradePricingBillingModel;
  country: string;
  currency: string;
  amountMinor: number;
  productId: string;
  priceId: string;
  accountId: string;
  acquisitionId: string;
  intentId: string;
  activationSessionId: string | null;
}>;

type ResolvedUpgradePricingCheckout = Readonly<{
  offer: CheckoutOfferSnapshot;
  snapshot: UpgradePricingIntentSnapshot;
}>;

function readCheckoutOfferSnapshot(
  row: {
    offer_id?: unknown;
    offer_country?: unknown;
    offer_currency?: unknown;
    offer_amount_minor?: unknown;
    offer_stripe_product_id?: unknown;
    offer_stripe_price_id?: unknown;
  },
): CheckoutOfferSnapshot | null {
  const offerId = cleanString(row.offer_id, 120);
  const country = cleanString(row.offer_country, 2).toUpperCase();
  const currency = cleanString(row.offer_currency, 3).toLowerCase();
  const amountMinor = Number(row.offer_amount_minor);
  const productId = cleanString(row.offer_stripe_product_id, 160);
  const priceId = cleanString(row.offer_stripe_price_id, 160);
  if (
    !offerId ||
    !/^[A-Z]{2}$/.test(country) ||
    !/^[a-z]{3}$/.test(currency) ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0 ||
    !productId ||
    !priceId
  ) {
    return null;
  }
  return { offerId, country, currency, amountMinor, productId, priceId };
}

function readUpgradePricingIntentSnapshot(
  row: Partial<CheckoutIntentRow>,
): UpgradePricingIntentSnapshot | null {
  const snapshotVersion = Number(row.upgrade_pricing_snapshot_version);
  const experimentId = cleanString(row.upgrade_pricing_experiment_id, 80);
  const historicalMonthly =
    snapshotVersion === 1 && experimentId === UPGRADE_PRICING_LEGACY_EXPERIMENT_ID;
  const currentAnnual =
    snapshotVersion === 2 && experimentId === UPGRADE_PRICING_EXPERIMENT_ID;
  if (!historicalMonthly && !currentAnnual) return null;
  const decisionReason = cleanString(row.upgrade_pricing_decision_reason, 80) as
    UpgradePricingDecisionReason;
  const variant = cleanString(row.upgrade_pricing_variant, 40) as
    UpgradePricingVariant;
  const billingModel = cleanString(row.upgrade_pricing_billing_model, 40) as
    UpgradePricingBillingModel;
  const country = cleanString(row.upgrade_pricing_country, 2).toUpperCase();
  const currency = cleanString(row.upgrade_pricing_currency, 3).toLowerCase();
  const amountMinor = Number(row.upgrade_pricing_amount_minor);
  const productId = cleanString(row.upgrade_pricing_stripe_product_id, 160);
  const priceId = cleanString(row.upgrade_pricing_stripe_price_id, 160);
  const accountId = cleanString(row.upgrade_pricing_account_id, 80);
  const acquisitionId = cleanString(row.upgrade_pricing_acquisition_id, 80);
  const intentId = cleanString(row.upgrade_pricing_checkout_intent_id, 80);
  if (
    ![
      "existing_assignment", "rollout_control", "rollout_monthly", "rollout_annual",
      "rollout_zero", "kill_switch", "assignment_unavailable", "unsupported_currency",
    ].includes(decisionReason) ||
    (
      historicalMonthly
        ? !["control_one_time", "monthly_half"].includes(variant)
        : !["control_one_time", "annual_same_price"].includes(variant)
    ) ||
    !["one_time", "subscription"].includes(billingModel) ||
    (variant === "control_one_time" ? billingModel !== "one_time" : billingModel !== "subscription") ||
    !/^[A-Z]{2}$/.test(country) ||
    !/^[a-z]{3}$/.test(currency) ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0 ||
    !productId ||
    !priceId ||
    !accountId ||
    !acquisitionId ||
    !intentId
  ) return null;
  return {
    snapshotVersion: snapshotVersion as 1 | 2,
    experimentId: experimentId as "upgrade-pricing-v1" | "upgrade-pricing-v2",
    decisionReason,
    assignmentId: cleanString(row.upgrade_pricing_assignment_id, 80) || null,
    assignmentBucket: row.upgrade_pricing_assignment_bucket === null
      ? null
      : Number(row.upgrade_pricing_assignment_bucket),
    rolloutBasisPoints: Number(row.upgrade_pricing_rollout_basis_points),
    assignedAt: row.upgrade_pricing_assigned_at
      ? new Date(row.upgrade_pricing_assigned_at).toISOString()
      : null,
    variant,
    billingModel,
    country,
    currency,
    amountMinor,
    productId,
    priceId,
    accountId,
    acquisitionId,
    intentId,
    activationSessionId:
      cleanString(row.upgrade_pricing_activation_session_id, 80) || null,
  };
}

async function loadUpgradePricingAssignment(
  accountId: string,
  runner: Pick<Pool | PoolClient, "query"> = getPool(),
): Promise<UpgradePricingPersistedAssignment | null> {
  const result = await runner.query<{
    id: string;
    assignment_version: number;
    experiment_id: string;
    account_id: string;
    variant: UpgradePricingVariant;
    billing_model: UpgradePricingBillingModel;
    assignment_bucket: number;
    rollout_basis_points: number;
    assigned_at: Date | string;
  }>(
    `
      select id, assignment_version, experiment_id, account_id, variant, billing_model,
        assignment_bucket, rollout_basis_points, assigned_at
      from public.sidestream_upgrade_pricing_assignments
      where account_id = $1
        and experiment_id in ($2, $3)
      order by
        case when experiment_id = $2 then 0 else 1 end,
        assigned_at asc
      limit 1
    `,
    [
      accountId,
      UPGRADE_PRICING_LEGACY_EXPERIMENT_ID,
      UPGRADE_PRICING_EXPERIMENT_ID,
    ],
  );
  const row = result.rows[0];
  return row
    ? {
        assignmentId: row.id,
        assignmentVersion: Number(row.assignment_version) as 1 | 2,
        experimentId: row.experiment_id as "upgrade-pricing-v1" | "upgrade-pricing-v2",
        accountId: row.account_id,
        variant: row.variant,
        billingModel: row.billing_model,
        bucket: Number(row.assignment_bucket),
        rolloutBasisPoints: Number(row.rollout_basis_points),
        assignedAt: row.assigned_at,
      }
    : null;
}

async function persistUpgradePricingAssignment(
  decision: UpgradePricingDecision,
  runner: Pick<Pool | PoolClient, "query"> = getPool(),
): Promise<Readonly<{
  assignment: UpgradePricingPersistedAssignment | null;
  inserted: boolean;
}>> {
  if (!decision.shouldPersistAssignment || decision.bucket === null) {
    return {
      assignment: await loadUpgradePricingAssignment(decision.accountId, runner),
      inserted: false,
    };
  }
  const assignmentId = randomUUID();
  const inserted = await runner.query<{ id: string }>(
    `
      insert into public.sidestream_upgrade_pricing_assignments (
        id, assignment_version, experiment_id, account_id, variant,
        billing_model, assignment_bucket, rollout_basis_points, assigned_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, now())
      on conflict (experiment_id, account_id) do nothing
      returning id
    `,
    [
      assignmentId,
      decision.assignmentVersion,
      decision.experimentId,
      decision.accountId,
      decision.variant,
      decision.billingModel,
      decision.bucket,
      decision.rolloutBasisPoints,
    ],
  );
  return {
    assignment: await loadUpgradePricingAssignment(decision.accountId, runner),
    inserted: inserted.rows[0]?.id === assignmentId,
  };
}

function attachUpgradePricingAssignment(
  decision: UpgradePricingDecision,
  assignment: UpgradePricingPersistedAssignment,
): UpgradePricingDecision {
  return Object.freeze({
    ...decision,
    assignmentId: assignment.assignmentId,
    assignedAt: new Date(assignment.assignedAt).toISOString(),
    shouldPersistAssignment: false,
  });
}

function fallbackUpgradePricingDecision(
  decision: UpgradePricingDecision,
): UpgradePricingDecision {
  return Object.freeze({
    ...decision,
    variant: "control_one_time" as const,
    billingModel: "one_time" as const,
    bucket: null,
    recurringAmountMinor: null,
    recurringInterval: null,
    reason: "assignment_unavailable" as const,
    assignmentId: null,
    assignedAt: null,
    shouldPersistAssignment: false,
    recurringCohortEligible: false,
  });
}

function upgradePricingOfferForAssignment(
  oneTimeOffer: CheckoutOfferSnapshot,
  assignment: UpgradePricingPersistedAssignment | null,
): CheckoutOfferSnapshot {
  if (
    !assignment ||
    assignment.experimentId !== UPGRADE_PRICING_EXPERIMENT_ID ||
    assignment.variant !== UPGRADE_PRICING_ANNUAL_VARIANT
  ) {
    return oneTimeOffer;
  }
  return upgradePricingAnnualOfferBasis(oneTimeOffer);
}

function upgradePricingAnnualOfferBasis(
  oneTimeOffer: CheckoutOfferSnapshot,
): CheckoutOfferSnapshot {
  return {
    ...oneTimeOffer,
    offerId: SIDESTREAM_GLOBAL_CHECKOUT_OFFER.offerId,
    currency: SIDESTREAM_GLOBAL_CHECKOUT_OFFER.currency,
    amountMinor: SIDESTREAM_GLOBAL_CHECKOUT_OFFER.amountMinor,
  };
}

function upgradePricingRecurringOfferBasis(
  oneTimeOffer: CheckoutOfferSnapshot,
  decision: UpgradePricingDecision,
) {
  return decision.variant === UPGRADE_PRICING_ANNUAL_VARIANT
    ? upgradePricingAnnualOfferBasis(oneTimeOffer)
    : oneTimeOffer;
}

async function resolveUpgradePricingCheckout(options: {
  accountId: string;
  acquisitionId: string;
  intentId: string;
  activationSessionId: string | null;
  oneTimeOffer: CheckoutOfferSnapshot;
  runner?: Pick<Pool | PoolClient, "query">;
}): Promise<ResolvedUpgradePricingCheckout> {
  const runner = options.runner || getPool();
  const existingAssignment = await loadUpgradePricingAssignment(options.accountId, runner);
  const decisionOffer = upgradePricingOfferForAssignment(
    options.oneTimeOffer,
    existingAssignment,
  );
  let decision = decideUpgradePricing({
    accountId: options.accountId,
    currency: decisionOffer.currency,
    oneTimeAmountMinor: decisionOffer.amountMinor,
    existingAssignment,
  });
  let offer = options.oneTimeOffer;
  if (decision.billingModel === "subscription") {
    try {
      // Prove the immutable provider Price before persisting a new recurring
      // assignment. A provider/config failure must not contaminate assignment
      // balance with an account that could only receive control.
      offer = await resolveRecurringCheckoutOfferSnapshot(
        upgradePricingRecurringOfferBasis(options.oneTimeOffer, decision),
        decision,
      );
    } catch (error) {
      console.error("[sidestream checkout] recurring Price unavailable", {
        code: "upgrade_pricing_recurring_price_unavailable",
        cause: error instanceof Error ? error.name : "unknown",
      });
      decision = fallbackUpgradePricingDecision(decision);
    }
  }
  if (decision.shouldPersistAssignment) {
    const persisted = await persistUpgradePricingAssignment(decision, runner);
    decision = persisted.assignment
      ? persisted.inserted
        ? attachUpgradePricingAssignment(decision, persisted.assignment)
        : decideUpgradePricing({
          accountId: options.accountId,
          currency: upgradePricingOfferForAssignment(
            options.oneTimeOffer,
            persisted.assignment,
          ).currency,
          oneTimeAmountMinor: upgradePricingOfferForAssignment(
            options.oneTimeOffer,
            persisted.assignment,
          ).amountMinor,
          existingAssignment: persisted.assignment,
        })
      : fallbackUpgradePricingDecision(decision);
  }
  if (decision.billingModel === "one_time") {
    offer = options.oneTimeOffer;
  } else if (offer === options.oneTimeOffer) {
    try {
      offer = await resolveRecurringCheckoutOfferSnapshot(
        upgradePricingRecurringOfferBasis(options.oneTimeOffer, decision),
        decision,
      );
    } catch (error) {
      console.error("[sidestream checkout] recurring Price unavailable", {
        code: "upgrade_pricing_recurring_price_unavailable",
        cause: error instanceof Error ? error.name : "unknown",
      });
      decision = fallbackUpgradePricingDecision(decision);
    }
  }

  return {
    offer,
    snapshot: {
      snapshotVersion: decision.assignmentVersion,
      experimentId: decision.experimentId,
      decisionReason: decision.reason,
      assignmentId: decision.assignmentId,
      assignmentBucket: decision.bucket,
      rolloutBasisPoints: decision.rolloutBasisPoints,
      assignedAt: decision.assignedAt,
      variant: decision.variant,
      billingModel: decision.billingModel,
      country: offer.country,
      currency: offer.currency,
      amountMinor: offer.amountMinor,
      productId: offer.productId,
      priceId: offer.priceId,
      accountId: options.accountId,
      acquisitionId: options.acquisitionId,
      intentId: options.intentId,
      activationSessionId: options.activationSessionId,
    },
  };
}

export async function createCheckoutIntent(options: {
  acquisitionId: string;
  activationKey?: string;
  buyerCountry?: string;
  session: AccountSession;
  now?: Date;
}): Promise<CheckoutIntent | null> {
  if (options.session.license.active) return null;

  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      await lockPaidEligibility(client, options.session.accountId);
      if (await hasCanonicalActivePaidLicense(options.session.accountId, client)) {
        await client.query("rollback");
        return null;
      }

  const now = options.now || new Date();
  const acquisitionId = requiredAcquisitionId(options.acquisitionId);
  assertCheckoutAcquisitionIntact(
    await requireCanonicalAcquisition(
      acquisitionId,
      acquisitionTransactionDependencies(client),
    ),
  );
  const activationKey = cleanString(options.activationKey, 160);
  const kind: CheckoutIntentKind = activationKey
    ? "activation"
    : "account";
  const intentId = randomUUID();
  const browserToken = randomToken(32);
  const expiresAt = addHours(now, CHECKOUT_INTENT_TTL_HOURS);
  const accountId = options.session.accountId;
  const activationSessionId = activationKey
    ? (await client.query<{ id: string }>(
        `
          select id
          from public.sidestream_activation_sessions
          where activation_key = $1
            and expires_at > $2::timestamptz
            and completed_at is null
            and device_id_hash is not null
            and account_id is null
            and status = 'pending'
          limit 1
        `,
        [activationKey, now.toISOString()],
      )).rows[0]?.id || null
    : null;
  if (activationKey && !activationSessionId) return null;
  const oneTimeOffer = await resolveCheckoutOfferSnapshot(options.buyerCountry);
  const upgradePricing = await resolveUpgradePricingCheckout({
    accountId,
    acquisitionId,
    intentId,
    activationSessionId,
    oneTimeOffer,
    runner: client,
  });
  const { offer, snapshot } = upgradePricing;
  const snapshotParameters = [
    snapshot.experimentId,
    snapshot.decisionReason,
    snapshot.assignmentId,
    snapshot.assignmentBucket,
    snapshot.rolloutBasisPoints,
    snapshot.assignedAt,
    snapshot.variant,
    snapshot.billingModel,
    snapshot.country,
    snapshot.currency,
    snapshot.amountMinor,
    snapshot.productId,
    snapshot.priceId,
    snapshot.accountId,
    snapshot.acquisitionId,
    snapshot.intentId,
    snapshot.activationSessionId,
  ];
  const result = activationKey
    ? await client.query<{ id: string }>(
        `
          insert into public.sidestream_checkout_intents (
            id, acquisition_id, intent_kind, browser_token_hash, account_id,
            activation_session_id, state, attempt, expires_at,
            offer_id, offer_country, offer_currency, offer_amount_minor,
            offer_stripe_product_id, offer_stripe_price_id,
            upgrade_pricing_snapshot_version, upgrade_pricing_experiment_id,
            upgrade_pricing_decision_reason, upgrade_pricing_assignment_id,
            upgrade_pricing_assignment_bucket,
            upgrade_pricing_rollout_basis_points, upgrade_pricing_assigned_at,
            upgrade_pricing_variant, upgrade_pricing_billing_model,
            upgrade_pricing_country, upgrade_pricing_currency,
            upgrade_pricing_amount_minor, upgrade_pricing_stripe_product_id,
            upgrade_pricing_stripe_price_id, upgrade_pricing_account_id,
            upgrade_pricing_acquisition_id,
            upgrade_pricing_checkout_intent_id,
            upgrade_pricing_activation_session_id,
            created_at, updated_at
          )
          select $1::uuid, $2::uuid, 'activation', $3, $4::uuid, a.id,
            'pending', 0, $5::timestamptz,
            $8, $9, $10, $11, $12, $13,
            ${snapshot.snapshotVersion}, $14, $15, $16::uuid, $17, $18, $19::timestamptz,
            $20, $21, $22, $23, $24, $25, $26, $27::uuid,
            $28::uuid, $29::uuid, $30::uuid,
            $6::timestamptz, $6::timestamptz
          from public.sidestream_activation_sessions a
          where a.activation_key = $7
            and a.id = $30::uuid
            and a.expires_at > $6::timestamptz
            and a.completed_at is null
            and a.device_id_hash is not null
            and a.account_id is null
            and a.status = 'pending'
          returning id
        `,
        [
          intentId,
          acquisitionId,
          hashToken(browserToken),
          accountId,
          expiresAt.toISOString(),
          now.toISOString(),
          activationKey,
          offer.offerId,
          offer.country,
          offer.currency,
          offer.amountMinor,
          offer.productId,
          offer.priceId,
          ...snapshotParameters,
        ],
      )
    : await client.query<{ id: string }>(
        `
          insert into public.sidestream_checkout_intents (
            id, acquisition_id, intent_kind, browser_token_hash, account_id,
            activation_session_id, state, attempt, expires_at,
            offer_id, offer_country, offer_currency, offer_amount_minor,
            offer_stripe_product_id, offer_stripe_price_id,
            upgrade_pricing_snapshot_version, upgrade_pricing_experiment_id,
            upgrade_pricing_decision_reason, upgrade_pricing_assignment_id,
            upgrade_pricing_assignment_bucket,
            upgrade_pricing_rollout_basis_points, upgrade_pricing_assigned_at,
            upgrade_pricing_variant, upgrade_pricing_billing_model,
            upgrade_pricing_country, upgrade_pricing_currency,
            upgrade_pricing_amount_minor, upgrade_pricing_stripe_product_id,
            upgrade_pricing_stripe_price_id, upgrade_pricing_account_id,
            upgrade_pricing_acquisition_id,
            upgrade_pricing_checkout_intent_id,
            upgrade_pricing_activation_session_id,
            created_at, updated_at
          ) values (
            $1::uuid, $2::uuid, $3, $4, $5::uuid, null, 'pending', 0,
            $6::timestamptz, $8, $9, $10, $11, $12, $13,
            ${snapshot.snapshotVersion}, $14, $15, $16::uuid, $17, $18, $19::timestamptz,
            $20, $21, $22, $23, $24, $25, $26, $27::uuid,
            $28::uuid, $29::uuid, $30::uuid,
            $7::timestamptz, $7::timestamptz
          )
          returning id
        `,
        [
          intentId,
          acquisitionId,
          kind,
          hashToken(browserToken),
          accountId,
          expiresAt.toISOString(),
          now.toISOString(),
          offer.offerId,
          offer.country,
          offer.currency,
          offer.amountMinor,
          offer.productId,
          offer.priceId,
          ...snapshotParameters,
        ],
      );
  if (!result.rows[0]) {
    await client.query("rollback");
    return null;
  }

  const intent = buildCheckoutIntent({
    intentId,
    browserToken,
    intentExpiresAt: expiresAt,
    kind,
    activationKey,
  });
      await client.query("commit");
      return intent;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

/**
 * Creates the anonymous core intent used only by the paid-acquisition POST
 * boundary. Ordinary Upgrade traffic continues to require an authenticated
 * session through createCheckoutIntent().
 */
export async function createCheckoutIntentConfirmation(options: {
  acquisitionId?: string;
  buyerCountry?: string;
  now?: Date;
  request?: IncomingMessage;
  response?: ServerResponse;
}): Promise<CheckoutIntent | null> {
  const now = options.now || new Date();
  const acquisitionId = options.acquisitionId
    ? requiredAcquisitionId(options.acquisitionId)
    : options.request && options.response
      ? (await resolveRequiredCheckoutAcquisition(
          options.request,
          options.response,
          { now },
        )).acquisitionId
      : requiredAcquisitionId("");
  assertCheckoutAcquisitionIntact(
    await requireCanonicalAcquisition(acquisitionId),
  );
  const offer = await resolveCheckoutOfferSnapshot(options.buyerCountry);
  const intentId = randomUUID();
  const browserToken = randomToken(32);
  const expiresAt = addHours(now, CHECKOUT_INTENT_TTL_HOURS);
  const result = await query<{ id: string }>(
    `
      insert into public.sidestream_checkout_intents (
        id, acquisition_id, intent_kind, browser_token_hash, account_id,
        activation_session_id, state, attempt, expires_at,
        offer_id, offer_country, offer_currency, offer_amount_minor,
        offer_stripe_product_id, offer_stripe_price_id,
        created_at, updated_at
      ) values (
        $1::uuid, $2::uuid, 'anonymous', $3, null, null, 'pending', 0,
        $4::timestamptz, $6, $7, $8, $9, $10, $11,
        $5::timestamptz, $5::timestamptz
      )
      returning id
    `,
    [
      intentId,
      acquisitionId,
      hashToken(browserToken),
      expiresAt.toISOString(),
      now.toISOString(),
      offer.offerId,
      offer.country,
      offer.currency,
      offer.amountMinor,
      offer.productId,
      offer.priceId,
    ],
  );
  if (!result.rows[0]) return null;

  return buildCheckoutIntent({
    intentId,
    browserToken,
    intentExpiresAt: expiresAt,
    kind: "anonymous",
    activationKey: "",
  });
}

export function buildUpgradeCheckoutSessionParameters(options: {
  billingModel: UpgradePricingBillingModel;
  variant?: UpgradePricingVariant;
  stripeCustomerId: string;
  stripePriceId: string;
  successUrl: string;
  cancelUrl: string;
  expiresAt?: number;
  clientReferenceId: string;
  metadata: Record<string, string>;
}): Stripe.Checkout.SessionCreateParams {
  const metadata = options.metadata;
  const common = {
    ...(options.stripeCustomerId ? { customer: options.stripeCustomerId } : {}),
    line_items: [{ price: options.stripePriceId, quantity: 1 }],
    payment_method_types: ["card" as const],
    billing_address_collection: "auto" as const,
    success_url: options.successUrl,
    cancel_url: options.cancelUrl,
    ...(options.expiresAt ? { expires_at: options.expiresAt } : {}),
    client_reference_id: options.clientReferenceId,
    metadata,
  };
  if (options.billingModel === "subscription") {
    if (!options.stripeCustomerId) {
      throw new Error("Subscription Checkout requires the authenticated account Customer");
    }
    return {
      mode: "subscription",
      ...common,
      allow_promotion_codes: true,
      ...(options.variant === UPGRADE_PRICING_ANNUAL_VARIANT
        ? {
            custom_text: {
              submit: {
                message:
                  "$19.99 per year. Renews automatically each year until canceled. We'll email you 30 days before renewal, before you're billed again. Cancel anytime from your Sidestream account; access continues through your paid year.",
              },
            },
          }
        : {}),
      subscription_data: { metadata },
    };
  }
  return {
    mode: "payment",
    ...common,
    ...(!options.stripeCustomerId ? { customer_creation: "always" as const } : {}),
    allow_promotion_codes: true,
    custom_text: {
      submit: {
        message:
          "We'll email your Sidestream download link to the address you enter above. One-time payment. No subscription.",
      },
    },
    invoice_creation: {
      enabled: true,
      invoice_data: { metadata },
    },
    payment_intent_data: { metadata },
  };
}

export async function createOrReuseCheckoutSession(options: {
  intentId: string;
  browserToken: string;
  session: AccountSession | null;
  baseUrl: string;
  rotateCancelledSession?: boolean;
  paidAcquisition?: boolean;
}): Promise<CheckoutIntentResult> {
  const now = new Date();
  const browserTokenHash = hashToken(options.browserToken);
  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      const selected = await client.query<CheckoutIntentRow>(
        `
          select ci.id, ci.acquisition_id, ci.intent_kind, ci.account_id,
            ci.activation_session_id, ci.state, ci.attempt,
            ci.stripe_customer_id, ci.stripe_checkout_session_id,
            ci.stripe_checkout_url, ci.stripe_price_id,
            ci.stripe_product_id, ci.offer_id, ci.offer_country,
            ci.offer_currency, ci.offer_amount_minor,
            ci.offer_stripe_product_id, ci.offer_stripe_price_id,
            ci.upgrade_pricing_snapshot_version,
            ci.upgrade_pricing_experiment_id,
            ci.upgrade_pricing_decision_reason,
            ci.upgrade_pricing_assignment_id,
            ci.upgrade_pricing_assignment_bucket,
            ci.upgrade_pricing_rollout_basis_points,
            ci.upgrade_pricing_assigned_at,
            ci.upgrade_pricing_variant,
            ci.upgrade_pricing_billing_model,
            ci.upgrade_pricing_country,
            ci.upgrade_pricing_currency,
            ci.upgrade_pricing_amount_minor,
            ci.upgrade_pricing_stripe_product_id,
            ci.upgrade_pricing_stripe_price_id,
            ci.upgrade_pricing_account_id,
            ci.upgrade_pricing_acquisition_id,
            ci.upgrade_pricing_checkout_intent_id,
            ci.upgrade_pricing_activation_session_id,
            ci.stripe_session_expires_at,
            ci.expires_at, a.activation_key,
            a.expires_at as activation_expires_at,
            a.stripe_checkout_session_id as activation_checkout_session_id
          from public.sidestream_checkout_intents ci
          left join public.sidestream_activation_sessions a
            on a.id = ci.activation_session_id
          where ci.id = $1::uuid
            and ci.browser_token_hash = $2
          for update of ci
        `,
        [options.intentId, browserTokenHash],
      );
      const row = selected.rows[0];
      if (!row) {
        return commitCheckoutIntentResult(client, checkoutIntentError(
          409,
          "Checkout request expired",
          "intent_expired",
        ));
      }
      if (!row.acquisition_id || !ACQUISITION_ID.test(row.acquisition_id)) {
        console.error("[sidestream checkout] acquisition linkage missing", {
          code: "acquisition_linkage_missing",
          intentId: row.id,
        });
        return commitCheckoutIntentResult(client, checkoutIntentError(
          503,
          "Checkout acquisition linkage is unavailable",
          "acquisition_linkage_missing",
        ));
      }
      assertCheckoutAcquisitionIntact(await requireCanonicalAcquisition(
        row.acquisition_id,
        acquisitionTransactionDependencies(client),
      ));
      if (new Date(row.expires_at).getTime() <= now.getTime()) {
        await client.query(
          `
            update public.sidestream_checkout_intents
            set state = 'expired', updated_at = $2::timestamptz
            where id = $1
          `,
          [row.id, now.toISOString()],
        );
        return commitCheckoutIntentResult(client, checkoutIntentError(
          409,
          "Checkout request expired",
          "intent_expired",
        ));
      }
      if (row.account_id && row.account_id !== options.session?.accountId) {
        return commitCheckoutIntentResult(client, checkoutIntentError(
          403,
          "Checkout request does not belong to this account",
          "intent_account_mismatch",
        ));
      }
      if (row.account_id) {
        // Serialize the eligibility check with every paid-entitlement grant so
        // a concurrent webhook cannot make an already-paid owner chargeable.
        await lockPaidEligibility(client, row.account_id);
      }
      if (options.session?.license.active) {
        return commitCheckoutIntentResult(client, checkoutIntentError(
          409,
          "Sidestream Unlimited is already active. Open your account or use Restore Purchase.",
          "active_license",
        ));
      }
      if (
        row.account_id &&
        await hasCanonicalActivePaidLicense(row.account_id, client)
      ) {
        return commitCheckoutIntentResult(client, checkoutIntentError(
          409,
          "Sidestream Unlimited is already active. Open your account or use Restore Purchase.",
          "active_license",
        ));
      }

      let attempt = Number(row.attempt) || 0;
      let replacementSessionId = "";
      let activationKey = row.activation_key || "";
      let activationExpiresAt = row.activation_expires_at
        ? new Date(row.activation_expires_at)
        : null;
      let checkoutOffer = readCheckoutOfferSnapshot(row);
      if (!checkoutOffer) {
        return commitCheckoutIntentResult(client, checkoutIntentError(
          409,
          "Checkout offer snapshot is unavailable",
          "offer_snapshot_missing",
        ));
      }
      const upgradePricingSnapshot = readUpgradePricingIntentSnapshot(row);
      if (
        row.upgrade_pricing_snapshot_version !== null &&
        (!upgradePricingSnapshot ||
          upgradePricingSnapshot.intentId !== row.id ||
          upgradePricingSnapshot.accountId !== row.account_id ||
          upgradePricingSnapshot.acquisitionId !== row.acquisition_id ||
          upgradePricingSnapshot.activationSessionId !== row.activation_session_id ||
          upgradePricingSnapshot.country !== checkoutOffer.country ||
          upgradePricingSnapshot.currency !== checkoutOffer.currency ||
          upgradePricingSnapshot.amountMinor !== checkoutOffer.amountMinor ||
          upgradePricingSnapshot.productId !== checkoutOffer.productId ||
          upgradePricingSnapshot.priceId !== checkoutOffer.priceId)
      ) {
        return commitCheckoutIntentResult(client, checkoutIntentError(
          409,
          "Checkout experiment snapshot is unavailable",
          "upgrade_pricing_snapshot_missing",
        ));
      }
      let stripePriceId = checkoutOffer.priceId;
      let stripeProductId = checkoutOffer.productId;

      if (row.activation_session_id) {
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [
          `checkout_activation:${row.activation_session_id}`,
        ]);
        const activation = await client.query<{
          activation_key: string;
          expires_at: Date | string;
          stripe_checkout_session_id: string | null;
          stripe_checkout_price_id: string | null;
          stripe_checkout_product_id: string | null;
        }>(
          `
            select activation_key, expires_at, stripe_checkout_session_id,
              stripe_checkout_price_id, stripe_checkout_product_id
            from public.sidestream_activation_sessions
            where id = $1
              and expires_at > $2::timestamptz
              and completed_at is null
              and device_id_hash is not null
              and account_id is null
              and status = 'pending'
            for update
          `,
          [row.activation_session_id, now.toISOString()],
        );
        const lockedActivation = activation.rows[0];
        if (!lockedActivation) {
          return commitCheckoutIntentResult(client, checkoutIntentError(
            409,
            "Activation expired or unavailable",
            "activation_unavailable",
          ));
        }
        activationKey = lockedActivation.activation_key;
        activationExpiresAt = new Date(lockedActivation.expires_at);

        const attachedSessionId = lockedActivation.stripe_checkout_session_id || "";
        if (attachedSessionId) {
          const attachedIntent = await client.query<{
            acquisition_id: string | null;
            state: string;
            attempt: number;
            stripe_customer_id: string | null;
            stripe_checkout_url: string | null;
            stripe_price_id: string | null;
            stripe_product_id: string | null;
            offer_id: string | null;
            offer_country: string | null;
            offer_currency: string | null;
            offer_amount_minor: number | null;
            offer_stripe_product_id: string | null;
            offer_stripe_price_id: string | null;
            stripe_session_expires_at: Date | string | null;
          }>(
            `
              select acquisition_id, state, attempt, stripe_customer_id, stripe_checkout_url,
                stripe_price_id, stripe_product_id, offer_id, offer_country,
                offer_currency, offer_amount_minor, offer_stripe_product_id,
                offer_stripe_price_id, stripe_session_expires_at
              from public.sidestream_checkout_intents
              where stripe_checkout_session_id = $1
              order by updated_at desc
              limit 1
            `,
            [attachedSessionId],
          );
          const attached = attachedIntent.rows[0];
          if (attached && attached.acquisition_id !== row.acquisition_id) {
            return commitCheckoutIntentResult(client, checkoutIntentError(
              409,
              "Checkout acquisition owner does not match",
              "acquisition_owner_mismatch",
            ));
          }
          attempt = Math.max(attempt, Number(attached?.attempt) || 0);
          if (attached?.state === "completed") {
            const completionUrl = buildCheckoutCompletionUrl(
              options.baseUrl,
              activationKey,
            ).replace(CHECKOUT_SESSION_PLACEHOLDER, attachedSessionId);
            return commitCheckoutIntentResult(client, {
              ok: true,
              url: completionUrl,
              reused: true,
            }, checkoutStartedStage(row, now));
          }

          const attachedExpiresAt = attached?.stripe_session_expires_at
            ? new Date(attached.stripe_session_expires_at).getTime()
            : 0;
          const attachedOffer = attached
            ? readCheckoutOfferSnapshot(attached)
            : null;
          let attachedUsesStoredOffer = Boolean(
            attachedOffer &&
            attached?.stripe_price_id === attachedOffer.priceId &&
            attached?.stripe_product_id === attachedOffer.productId,
          );
          if (
            !options.rotateCancelledSession &&
            attachedUsesStoredOffer &&
            attached?.stripe_checkout_url &&
            attachedExpiresAt > now.getTime()
          ) {
            const candidateSession = await getStripe().checkout.sessions.retrieve(
              attachedSessionId,
              {},
              getStripeRequestOptions(),
            );
            if (
              candidateSession.status === "open" &&
              candidateSession.url &&
              candidateSession.allow_promotion_codes === true
            ) {
              checkoutOffer = attachedOffer!;
              stripePriceId = checkoutOffer.priceId;
              stripeProductId = checkoutOffer.productId;
              await attachExistingSessionToCheckoutIntent(client, row.id, {
                sessionId: attachedSessionId,
                url: candidateSession.url,
                customerId: normalizeStripeId(candidateSession.customer) ||
                  attached.stripe_customer_id || "",
                priceId: attached.stripe_price_id || "",
                productId: attached.stripe_product_id || "",
                expiresAt: new Date(candidateSession.expires_at * 1_000),
                attempt,
                offer: checkoutOffer,
              });
              return commitCheckoutIntentResult(client, {
                ok: true,
                url: candidateSession.url,
                reused: true,
              }, checkoutStartedStage(row, now));
            }
            if (candidateSession.status === "complete") {
              const completionUrl = buildCheckoutCompletionUrl(
                options.baseUrl,
                activationKey,
              ).replace(CHECKOUT_SESSION_PLACEHOLDER, attachedSessionId);
              return commitCheckoutIntentResult(client, {
                ok: true,
                url: completionUrl,
                reused: true,
              }, checkoutStartedStage(row, now));
            }
            if (candidateSession.status === "open") {
              await expireCheckoutSession(candidateSession.id, row.id, attempt);
            }
            attachedUsesStoredOffer = false;
          }

          if (!attached?.stripe_checkout_url || attachedExpiresAt <= now.getTime()) {
            const stripeSession = await getStripe().checkout.sessions.retrieve(
              attachedSessionId,
              {},
              getStripeRequestOptions(),
            );
            if (stripeSession.status === "complete") {
              const completionUrl = buildCheckoutCompletionUrl(
                options.baseUrl,
                activationKey,
              ).replace(CHECKOUT_SESSION_PLACEHOLDER, attachedSessionId);
              return commitCheckoutIntentResult(client, {
                ok: true,
                url: completionUrl,
                reused: true,
              }, checkoutStartedStage(row, now));
            }
            if (
              !options.rotateCancelledSession &&
              stripeSession.status === "open" &&
              stripeSession.url &&
              stripeSession.allow_promotion_codes === true &&
              attachedOffer &&
              (
                lockedActivation.stripe_checkout_price_id ||
                cleanString(stripeSession.metadata?.sidestream_price_id, 160)
              ) === attachedOffer.priceId &&
              (
                lockedActivation.stripe_checkout_product_id ||
                attachedOffer.productId
              ) === attachedOffer.productId
            ) {
              checkoutOffer = attachedOffer;
              stripePriceId = checkoutOffer.priceId;
              stripeProductId = checkoutOffer.productId;
              await attachExistingSessionToCheckoutIntent(client, row.id, {
                sessionId: stripeSession.id,
                url: stripeSession.url,
                customerId: normalizeStripeId(stripeSession.customer),
                priceId: attachedOffer.priceId,
                productId: attachedOffer.productId,
                expiresAt: new Date(stripeSession.expires_at * 1_000),
                attempt,
                offer: checkoutOffer,
              });
              return commitCheckoutIntentResult(client, {
                ok: true,
                url: stripeSession.url,
                reused: true,
              }, checkoutStartedStage(row, now));
            }
            if (stripeSession.status === "open") {
              await expireCheckoutSession(stripeSession.id, row.id, attempt);
            }
          } else if (options.rotateCancelledSession || !attachedUsesStoredOffer) {
            const replacementStatus = await prepareCheckoutSessionReplacement(
              attachedSessionId,
              row.id,
              attempt,
            );
            if (replacementStatus === "complete") {
              const completionUrl = buildCheckoutCompletionUrl(
                options.baseUrl,
                activationKey,
              ).replace(CHECKOUT_SESSION_PLACEHOLDER, attachedSessionId);
              return commitCheckoutIntentResult(client, {
                ok: true,
                url: completionUrl,
                reused: true,
              }, checkoutStartedStage(row, now));
            }
          }
          replacementSessionId = attachedSessionId;
          attempt += 1;
        }
      } else if (row.stripe_checkout_session_id) {
        const sessionExpiresAt = row.stripe_session_expires_at
          ? new Date(row.stripe_session_expires_at).getTime()
          : 0;
        if (
          row.state === "open" &&
          row.stripe_checkout_url &&
          sessionExpiresAt > now.getTime() &&
          !options.rotateCancelledSession &&
          row.stripe_price_id === stripePriceId &&
          row.stripe_product_id === stripeProductId
        ) {
          return commitCheckoutIntentResult(client, {
            ok: true,
            url: row.stripe_checkout_url,
            reused: true,
          }, checkoutStartedStage(row, now));
        }
        if (row.state === "completed") {
          const completionUrl = buildCheckoutCompletionUrl(options.baseUrl)
            .replace(CHECKOUT_SESSION_PLACEHOLDER, row.stripe_checkout_session_id);
          return commitCheckoutIntentResult(client, {
            ok: true,
            url: completionUrl,
            reused: true,
          }, checkoutStartedStage(row, now));
        }
        if (
          sessionExpiresAt > now.getTime() &&
          (
            options.rotateCancelledSession ||
            row.stripe_price_id !== stripePriceId ||
            row.stripe_product_id !== stripeProductId
          )
        ) {
          const replacementStatus = await prepareCheckoutSessionReplacement(
            row.stripe_checkout_session_id,
            row.id,
            attempt,
          );
          if (replacementStatus === "complete") {
            const completionUrl = buildCheckoutCompletionUrl(options.baseUrl)
              .replace(CHECKOUT_SESSION_PLACEHOLDER, row.stripe_checkout_session_id);
            return commitCheckoutIntentResult(client, {
              ok: true,
              url: completionUrl,
              reused: true,
            }, checkoutStartedStage(row, now));
          }
        }
        replacementSessionId = row.stripe_checkout_session_id;
        attempt += 1;
      }

      if (row.intent_kind === "account" && !options.session) {
        return commitCheckoutIntentResult(client, checkoutIntentError(
          401,
          "Authentication required",
          "authentication_required",
        ));
      }

      const stripeCustomerId = row.account_id && options.session
        ? await findOrCreateStripeCustomer(options.session, client)
        : "";
      const cancelUrl = new URL(
        options.paidAcquisition ? "/mc" : "/account.html",
        options.baseUrl,
      );
      cancelUrl.searchParams.set("checkout", "cancelled");
      const metadata: Record<string, string> = {
        sidestream_acquisition_id: row.acquisition_id,
        sidestream_plan: SIDESTREAM_PRO_PLAN_KEY,
        sidestream_price_id: stripePriceId,
        sidestream_product_id: stripeProductId,
        sidestream_checkout_intent_id: row.id,
        sidestream_offer_id: checkoutOffer.offerId,
        sidestream_offer_country: checkoutOffer.country,
        sidestream_offer_currency: checkoutOffer.currency,
        sidestream_offer_amount_minor: String(checkoutOffer.amountMinor),
      };
      if (options.paidAcquisition) {
        metadata.sidestream_paid_acquisition =
          PAID_ACQUISITION_EXPERIMENT_ID;
      }
      if (row.account_id && options.session) {
        metadata.sidestream_account_id = options.session.accountId;
      }
      if (activationKey) metadata.sidestream_activation_key = activationKey;
      if (upgradePricingSnapshot) {
        Object.assign(metadata, {
          sidestream_upgrade_snapshot_version:
            String(upgradePricingSnapshot.snapshotVersion),
          sidestream_upgrade_experiment_id:
            upgradePricingSnapshot.experimentId,
          sidestream_upgrade_decision_reason:
            upgradePricingSnapshot.decisionReason,
          sidestream_upgrade_rollout_bps:
            String(upgradePricingSnapshot.rolloutBasisPoints),
          sidestream_upgrade_variant: upgradePricingSnapshot.variant,
          sidestream_upgrade_billing_model:
            upgradePricingSnapshot.billingModel,
          sidestream_upgrade_country: upgradePricingSnapshot.country,
          sidestream_upgrade_currency: upgradePricingSnapshot.currency,
          sidestream_upgrade_amount_minor:
            String(upgradePricingSnapshot.amountMinor),
          sidestream_upgrade_product_id: upgradePricingSnapshot.productId,
          sidestream_upgrade_price_id: upgradePricingSnapshot.priceId,
          sidestream_upgrade_account_id: upgradePricingSnapshot.accountId,
          sidestream_upgrade_acquisition_id:
            upgradePricingSnapshot.acquisitionId,
          sidestream_upgrade_intent_id:
            upgradePricingSnapshot.intentId,
        });
        if (upgradePricingSnapshot.assignmentId) {
          metadata.sidestream_upgrade_assignment_id =
            upgradePricingSnapshot.assignmentId;
        }
        if (upgradePricingSnapshot.assignmentBucket !== null) {
          metadata.sidestream_upgrade_assignment_bucket =
            String(upgradePricingSnapshot.assignmentBucket);
        }
        if (upgradePricingSnapshot.assignedAt) {
          metadata.sidestream_upgrade_assigned_at =
            upgradePricingSnapshot.assignedAt;
        }
        if (upgradePricingSnapshot.activationSessionId) {
          metadata.sidestream_upgrade_activation_id =
            upgradePricingSnapshot.activationSessionId;
        }
      }

      const checkoutWindow = activationExpiresAt
        ? getStripeCheckoutWindow(
            activationExpiresAt.getTime(),
            CHECKOUT_CLAIM_GRACE_SECONDS,
          )
        : null;
      if (
        checkoutWindow &&
        checkoutWindow.checkoutExpiresAt * 1_000 < now.getTime() + 31 * 60 * 1_000
      ) {
        return commitCheckoutIntentResult(client, checkoutIntentError(
          409,
          "Activation does not have enough time remaining for Checkout",
          "activation_window_too_short",
        ));
      }
      const checkoutParams = buildUpgradeCheckoutSessionParameters({
        billingModel: upgradePricingSnapshot?.billingModel || "one_time",
        variant: upgradePricingSnapshot?.variant,
        stripeCustomerId,
        stripePriceId,
        successUrl: buildCheckoutCompletionUrl(options.baseUrl, activationKey),
        cancelUrl: cancelUrl.toString(),
        expiresAt: checkoutWindow?.checkoutExpiresAt,
        clientReferenceId: activationKey || options.session?.accountId || row.id,
        metadata,
      });
      const checkoutSession = await getStripe().checkout.sessions.create(
        checkoutParams,
        {
          ...getStripeRequestOptions(),
          idempotencyKey: getCheckoutSessionIdempotencyKey({
            kind: row.intent_kind,
            intentId: row.id,
            activationKey,
            attempt,
            parametersFingerprint: getCheckoutParametersFingerprint(checkoutParams),
          }),
        },
      );
      if (!checkoutSession.url) {
        throw new Error("Stripe did not return a Checkout URL");
      }

      if (activationKey && checkoutWindow) {
        const attached = await attachCheckoutSessionToActivation({
          activationKey,
          checkoutSessionId: checkoutSession.id,
          priceId: stripePriceId,
          productId: stripeProductId,
          checkoutExpiresAt: checkoutSession.expires_at || checkoutWindow.checkoutExpiresAt,
          claimGraceUntil: checkoutWindow.claimGraceUntil,
          replaceCheckoutSessionId: replacementSessionId || undefined,
          runner: client,
        });
        if (!attached) throw new Error("Could not attach Checkout to activation");
      }

      await client.query(
        `
          update public.sidestream_checkout_intents
          set state = 'open', attempt = $2, stripe_customer_id = $3,
            stripe_checkout_session_id = $4, stripe_checkout_url = $5,
            stripe_price_id = $6, stripe_product_id = $7,
            stripe_session_expires_at = to_timestamp($8),
            confirmed_at = coalesce(confirmed_at, $9::timestamptz),
            last_error_code = null, updated_at = $9::timestamptz
          where id = $1
        `,
        [
          row.id,
          attempt,
          stripeCustomerId || null,
          checkoutSession.id,
          checkoutSession.url,
          stripePriceId,
          stripeProductId,
          checkoutSession.expires_at,
          now.toISOString(),
        ],
      );
      await recordCheckoutStarted(
        client,
        checkoutStartedStage(row, now),
      );
      await recordUpgradePricingExposure(
        client,
        checkoutStartedStage(row, now),
      );
      await client.query("commit");
      return { ok: true, url: checkoutSession.url, reused: false };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

function buildCheckoutIntent(options: {
  intentId: string;
  browserToken: string;
  intentExpiresAt: Date;
  kind: CheckoutIntentKind;
  activationKey: string;
}): CheckoutIntent {
  return {
    intentId: options.intentId,
    browserToken: options.browserToken,
    intentExpiresAt: options.intentExpiresAt.toISOString(),
    kind: options.kind,
    activationKey: options.activationKey,
  };
}

async function attachExistingSessionToCheckoutIntent(
  client: PoolClient,
  intentId: string,
  session: {
    sessionId: string;
    url: string;
    customerId: string;
    priceId: string;
    productId: string;
    expiresAt: Date;
    attempt: number;
    offer: CheckoutOfferSnapshot;
  },
) {
  await client.query(
    `
      update public.sidestream_checkout_intents
      set state = 'open', attempt = $2, stripe_customer_id = $3,
        stripe_checkout_session_id = $4, stripe_checkout_url = $5,
        stripe_price_id = $6, stripe_product_id = $7,
        stripe_session_expires_at = $8::timestamptz,
        offer_id = $9, offer_country = $10, offer_currency = $11,
        offer_amount_minor = $12, offer_stripe_product_id = $13,
        offer_stripe_price_id = $14,
        updated_at = now()
      where id = $1
    `,
    [
      intentId,
      session.attempt,
      session.customerId || null,
      session.sessionId,
      session.url,
      session.priceId,
      session.productId,
      session.expiresAt.toISOString(),
      session.offer.offerId,
      session.offer.country,
      session.offer.currency,
      session.offer.amountMinor,
      session.offer.productId,
      session.offer.priceId,
    ],
  );
}

async function expireCheckoutSession(
  sessionId: string,
  intentId: string,
  attempt: number,
) {
  await getStripe().checkout.sessions.expire(
    sessionId,
    {},
    {
      ...getStripeRequestOptions(),
      idempotencyKey: `sidestream_expire_${createHash("sha256")
        .update(`${intentId}:${attempt}:${sessionId}`)
        .digest("hex")}`,
    },
  );
}

async function prepareCheckoutSessionReplacement(
  sessionId: string,
  intentId: string,
  attempt: number,
) {
  const session = await getStripe().checkout.sessions.retrieve(
    sessionId,
    {},
    getStripeRequestOptions(),
  );
  if (session.status === "open") {
    await expireCheckoutSession(session.id, intentId, attempt);
  }
  return session.status;
}

async function commitCheckoutIntentResult(
  client: PoolClient,
  result: CheckoutIntentResult,
  acquisition?: CheckoutStartedStage,
) {
  if (result.ok && acquisition) {
    await recordCheckoutStarted(client, acquisition);
    await recordUpgradePricingExposure(client, acquisition);
  }
  await client.query("commit");
  return result;
}

function checkoutStartedStage(
  row: CheckoutIntentRow,
  occurredAt: Date,
): CheckoutStartedStage {
  return {
    acquisitionId: requiredAcquisitionId(row.acquisition_id),
    intentId: row.id,
    occurredAt,
    upgradePricing: readUpgradePricingIntentSnapshot(row),
  };
}

type CheckoutStartedStage = Readonly<{
  acquisitionId: string;
  intentId: string;
  occurredAt: Date;
  upgradePricing: UpgradePricingIntentSnapshot | null;
}>;

async function recordUpgradePricingExposure(
  client: PoolClient,
  input: CheckoutStartedStage,
) {
  const snapshot = input.upgradePricing;
  if (
    !snapshot ||
    (
      snapshot.experimentId === UPGRADE_PRICING_EXPERIMENT_ID &&
      !snapshot.assignmentId
    )
  ) return;
  await client.query(
    `
      insert into public.sidestream_upgrade_pricing_exposures (
        assignment_id, experiment_id, account_id, variant, billing_model,
        checkout_intent_id, exposed_at
      ) values ($1::uuid, $2, $3::uuid, $4, $5, $6::uuid, $7::timestamptz)
      on conflict (experiment_id, checkout_intent_id) do nothing
    `,
    [
      snapshot.assignmentId,
      snapshot.experimentId,
      snapshot.accountId,
      snapshot.variant,
      snapshot.billingModel,
      snapshot.intentId,
      input.occurredAt.toISOString(),
    ],
  );
}

async function recordCheckoutStarted(
  client: PoolClient,
  input: Readonly<{
    acquisitionId: string;
    intentId: string;
    occurredAt: Date;
  }>,
) {
  const dependencies = acquisitionTransactionDependencies(client);
  await addTrustedDeliveryEvidence({
    acquisitionId: input.acquisitionId,
    evidence: "checkout_intent",
  }, dependencies);
  const stage = await recordAcquisitionStage({
    acquisitionId: input.acquisitionId,
    stage: "checkout_started",
    stableServerReference: `checkout-intent:${input.intentId}`,
    occurredAt: input.occurredAt,
  }, dependencies);
  if (stage.ownerConflict) {
    throw new AcquisitionIntegrityError(
      "checkout_acquisition_conflict",
      "Checkout acquisition ownership conflicted.",
    );
  }
}

function acquisitionTransactionDependencies(client: PoolClient) {
  const namespace = requireMatchingLicenseEnvironment().namespace;
  return {
    namespace,
    transaction: async <T>(callback: (runner: PoolClient) => Promise<T>) =>
      callback(client),
  } as const;
}

function checkoutIntentError(
  statusCode: number,
  error: string,
  code: string,
): CheckoutIntentResult {
  return { ok: false, statusCode, error, code };
}

export async function findOrCreateStripeCustomer(
  session: AccountSession,
  runner: Pick<Pool | PoolClient, "query"> = getPool(),
) {
  if (session.stripeCustomerId) {
    try {
      const customer = await getStripe().customers.retrieve(
        session.stripeCustomerId,
        {},
        getStripeRequestOptions(),
      );
      if (!("deleted" in customer && customer.deleted)) {
        return customer.id;
      }
    } catch (error) {
      if (!isStripeResourceMissing(error)) throw error;
    }
  }

  return createStripeCustomerForSession(session, runner);
}

async function createStripeCustomerForSession(
  session: AccountSession,
  runner: Pick<Pool | PoolClient, "query">,
) {
  const stripe = getStripe();
  const customer = await stripe.customers.create(
    {
      email: session.email,
      name: session.name || undefined,
      metadata: {
        sidestream_account_id: session.accountId,
      },
    },
    {
      ...getStripeRequestOptions(),
      idempotencyKey: getStripeCustomerIdempotencyKey(session.accountId),
    },
  );

  await runner.query(
    `
      update public.sidestream_accounts
      set stripe_customer_id = $2, updated_at = now()
      where id = $1
    `,
    [session.accountId, customer.id],
  );

  return customer.id;
}

export function getStripe() {
  if (!stripeClient) {
    stripeClient = new Stripe(getStripeSecretKey());
  }
  return stripeClient;
}

export function getStripeRequestOptions(): Stripe.RequestOptions {
  return {
    apiVersion: Stripe.API_VERSION,
  } as Stripe.RequestOptions;
}

async function resolveCheckoutOfferSnapshot(
  buyerCountry: unknown,
): Promise<CheckoutOfferSnapshot> {
  const selection = selectCheckoutOffer(buyerCountry);
  const productId = getSidestreamProProductId();
  const priceId = selection.entry.priceSource.kind === "default"
    ? await getSidestreamProPriceId()
    : selection.configuredPriceId;
  if (!priceId) {
    throw new Error(
      `Approved Checkout offer ${selection.entry.offerId} has no Stripe Price ID`,
    );
  }

  const price = await getStripe().prices.retrieve(
    priceId,
    {},
    getStripeRequestOptions(),
  );
  if (
    price.id !== priceId ||
    !price.active ||
    normalizeStripeId(price.product) !== productId ||
    price.currency !== selection.entry.currency ||
    !Number.isSafeInteger(price.unit_amount) ||
    price.unit_amount !== selection.entry.amountMinor ||
    price.recurring
  ) {
    throw new Error(
      `Stripe Price ${priceId} does not match approved Checkout offer ${selection.entry.offerId}`,
    );
  }

  return {
    offerId: selection.entry.offerId,
    country: selection.country,
    currency: selection.entry.currency,
    amountMinor: price.unit_amount!,
    productId,
    priceId: price.id,
  };
}

async function resolveRecurringCheckoutOfferSnapshot(
  oneTimeOffer: CheckoutOfferSnapshot,
  decision: UpgradePricingDecision,
): Promise<CheckoutOfferSnapshot> {
  if (decision.variant === UPGRADE_PRICING_MONTHLY_VARIANT) {
    return resolveMonthlyCheckoutOfferSnapshot(
      oneTimeOffer,
      decision.recurringAmountMinor,
    );
  }
  if (decision.variant === UPGRADE_PRICING_ANNUAL_VARIANT) {
    return resolveAnnualCheckoutOfferSnapshot(
      oneTimeOffer,
      decision.recurringAmountMinor,
    );
  }
  throw new Error("Upgrade pricing recurring variant is unavailable");
}

async function resolveMonthlyCheckoutOfferSnapshot(
  oneTimeOffer: CheckoutOfferSnapshot,
  monthlyAmountMinor: number | null,
): Promise<CheckoutOfferSnapshot> {
  if (!Number.isSafeInteger(monthlyAmountMinor) || (monthlyAmountMinor || 0) <= 0) {
    throw new Error("Upgrade pricing monthly amount is unavailable");
  }
  const catalogEntry = SIDESTREAM_CHECKOUT_OFFER_CATALOG.find(
    (entry) => entry.offerId === oneTimeOffer.offerId,
  );
  if (!catalogEntry) throw new Error("Upgrade pricing offer is not in the catalog");
  const monthlySelection = selectMonthlyCheckoutPrice(catalogEntry);
  const productId = oneTimeOffer.productId;
  const lookupKey = upgradePricingMonthlyLookupKey(
    oneTimeOffer.currency,
    monthlyAmountMinor!,
  );
  const priceId = monthlySelection.kind === "lookup"
    ? await getSidestreamUpgradeMonthlyPriceId({
        productId,
        currency: oneTimeOffer.currency,
        amountMinor: monthlyAmountMinor!,
        configuredPriceId: monthlySelection.configuredPriceId,
      })
    : monthlySelection.configuredPriceId;
  if (!priceId) {
    throw new Error(`Approved monthly offer ${catalogEntry.offerId} has no configured Price`);
  }

  const [price, product] = await Promise.all([
    getStripe().prices.retrieve(priceId, {}, getStripeRequestOptions()),
    getStripe().products.retrieve(productId, {}, getStripeRequestOptions()),
  ]);
  if (
    "deleted" in product ||
    product.id !== productId ||
    product.active !== true ||
    product.livemode !== isLiveStripeMode()
  ) {
    throw new Error("Monthly Checkout Product is not the active Sidestream Unlimited Product");
  }
  if (!isUpgradePricingMonthlyPriceShape(price, {
    productId,
    currency: oneTimeOffer.currency,
    amountMinor: monthlyAmountMinor!,
    lookupKey,
  })) {
    throw new Error(`Stripe Price ${priceId} does not match the approved monthly offer`);
  }
  return {
    offerId: `${oneTimeOffer.offerId}-monthly`,
    country: oneTimeOffer.country,
    currency: price.currency,
    amountMinor: price.unit_amount!,
    productId,
    priceId: price.id,
  };
}

async function resolveAnnualCheckoutOfferSnapshot(
  oneTimeOffer: CheckoutOfferSnapshot,
  annualAmountMinor: number | null,
): Promise<CheckoutOfferSnapshot> {
  if (!Number.isSafeInteger(annualAmountMinor) || (annualAmountMinor || 0) <= 0) {
    throw new Error("Upgrade pricing annual amount is unavailable");
  }
  const catalogEntry = SIDESTREAM_CHECKOUT_OFFER_CATALOG.find(
    (entry) => entry.offerId === oneTimeOffer.offerId,
  );
  if (!catalogEntry) throw new Error("Upgrade pricing offer is not in the catalog");
  const annualSelection = selectAnnualCheckoutPrice(catalogEntry);
  if (!annualSelection) {
    throw new Error(`Approved offer ${catalogEntry.offerId} has no annual contract`);
  }
  const productId = oneTimeOffer.productId;
  const lookupKey = upgradePricingAnnualLookupKey(
    oneTimeOffer.currency,
    annualAmountMinor!,
  );
  const priceId = annualSelection.kind === "lookup"
    ? await getSidestreamUpgradeAnnualPriceId({
        productId,
        currency: oneTimeOffer.currency,
        amountMinor: annualAmountMinor!,
        configuredPriceId: annualSelection.configuredPriceId,
      })
    : annualSelection.configuredPriceId;
  if (!priceId) {
    throw new Error(`Approved annual offer ${catalogEntry.offerId} has no configured Price`);
  }

  const [price, product] = await Promise.all([
    getStripe().prices.retrieve(priceId, {}, getStripeRequestOptions()),
    getStripe().products.retrieve(productId, {}, getStripeRequestOptions()),
  ]);
  if (
    "deleted" in product ||
    product.id !== productId ||
    product.active !== true ||
    product.livemode !== isLiveStripeMode()
  ) {
    throw new Error("Annual Checkout Product is not the active Sidestream Unlimited Product");
  }
  if (!isUpgradePricingAnnualPriceShape(price, {
    productId,
    currency: oneTimeOffer.currency,
    amountMinor: annualAmountMinor!,
    lookupKey,
  })) {
    throw new Error(`Stripe Price ${priceId} does not match the approved annual offer`);
  }
  return {
    offerId: `${oneTimeOffer.offerId}-annual`,
    country: oneTimeOffer.country,
    currency: price.currency,
    amountMinor: price.unit_amount!,
    productId,
    priceId: price.id,
  };
}

export async function getSidestreamUpgradeMonthlyPriceId(options: {
  productId: string;
  currency: string;
  amountMinor: number;
  configuredPriceId?: string;
}) {
  const lookupKey = upgradePricingMonthlyLookupKey(
    options.currency,
    options.amountMinor,
  );
  const expected = {
    productId: options.productId,
    currency: options.currency,
    amountMinor: options.amountMinor,
    lookupKey,
  };
  if (options.configuredPriceId) {
    try {
      const configured = await getStripe().prices.retrieve(
        options.configuredPriceId,
        {},
        getStripeRequestOptions(),
      );
      if (isUpgradePricingMonthlyPriceShape(configured, expected)) {
        return configured.id;
      }
    } catch (error) {
      if (!isStripeResourceMissing(error)) throw error;
    }
  }

  const product = await retrieveSidestreamProProduct(options.productId);
  if (product.livemode !== isLiveStripeMode()) {
    throw new Error("Sidestream Unlimited Product belongs to the wrong Stripe namespace");
  }
  const lookupPrices = await getStripe().prices.list({
    active: true,
    lookup_keys: [lookupKey],
    product: options.productId,
    limit: 10,
  }, getStripeRequestOptions());
  const lookupMatch = lookupPrices.data.find((price) =>
    price.lookup_key === lookupKey &&
    isUpgradePricingMonthlyPriceShape(price, expected)
  );
  if (lookupMatch) return lookupMatch.id;
  if (lookupPrices.data.length > 0) {
    throw new Error(`Stripe lookup key ${lookupKey} has conflicting monthly terms`);
  }

  const recurring = {
    interval: UPGRADE_PRICING_MONTHLY_INTERVAL,
    interval_count: UPGRADE_PRICING_MONTHLY_INTERVAL_COUNT,
    usage_type: UPGRADE_PRICING_MONTHLY_USAGE_TYPE,
  } as const;
  try {
    const created = await getStripe().prices.create({
      product: options.productId,
      currency: options.currency,
      unit_amount: options.amountMinor,
      lookup_key: lookupKey,
      recurring,
      metadata: {
        sidestream_plan: SIDESTREAM_PRO_PLAN_KEY,
        sidestream_upgrade_experiment_id: UPGRADE_PRICING_EXPERIMENT_ID,
      },
    }, {
      ...getStripeRequestOptions(),
      idempotencyKey: getStripeRecurringPriceIdempotencyKey({
        ...expected,
        interval: UPGRADE_PRICING_MONTHLY_INTERVAL,
        intervalCount: UPGRADE_PRICING_MONTHLY_INTERVAL_COUNT,
        usageType: UPGRADE_PRICING_MONTHLY_USAGE_TYPE,
        livemode: isLiveStripeMode(),
      }),
    });
    if (!isUpgradePricingMonthlyPriceShape(created, expected)) {
      throw new Error("Stripe created a monthly Price with unexpected terms");
    }
    return created.id;
  } catch (error) {
    const converged = await getStripe().prices.list({
      active: true,
      lookup_keys: [lookupKey],
      product: options.productId,
      limit: 10,
    }, getStripeRequestOptions());
    const match = converged.data.find((price) =>
      price.lookup_key === lookupKey &&
      isUpgradePricingMonthlyPriceShape(price, expected)
    );
    if (match) return match.id;
    throw error;
  }
}

export async function getSidestreamUpgradeAnnualPriceId(options: {
  productId: string;
  currency: string;
  amountMinor: number;
  configuredPriceId?: string;
}) {
  const lookupKey = upgradePricingAnnualLookupKey(
    options.currency,
    options.amountMinor,
  );
  const expected = {
    productId: options.productId,
    currency: options.currency,
    amountMinor: options.amountMinor,
    lookupKey,
  };
  if (options.configuredPriceId) {
    try {
      const configured = await getStripe().prices.retrieve(
        options.configuredPriceId,
        {},
        getStripeRequestOptions(),
      );
      if (isUpgradePricingAnnualPriceShape(configured, expected)) {
        return configured.id;
      }
    } catch (error) {
      if (!isStripeResourceMissing(error)) throw error;
    }
  }

  const product = await retrieveSidestreamProProduct(options.productId);
  if (product.livemode !== isLiveStripeMode()) {
    throw new Error("Sidestream Unlimited Product belongs to the wrong Stripe namespace");
  }
  const lookupPrices = await getStripe().prices.list({
    active: true,
    lookup_keys: [lookupKey],
    product: options.productId,
    limit: 10,
  }, getStripeRequestOptions());
  const lookupMatch = lookupPrices.data.find((price) =>
    price.lookup_key === lookupKey &&
    isUpgradePricingAnnualPriceShape(price, expected)
  );
  if (lookupMatch) return lookupMatch.id;
  if (lookupPrices.data.length > 0) {
    throw new Error(`Stripe lookup key ${lookupKey} has conflicting annual terms`);
  }

  const recurring = {
    interval: UPGRADE_PRICING_ANNUAL_INTERVAL,
    interval_count: UPGRADE_PRICING_ANNUAL_INTERVAL_COUNT,
    usage_type: UPGRADE_PRICING_ANNUAL_USAGE_TYPE,
  } as const;
  try {
    const created = await getStripe().prices.create({
      product: options.productId,
      currency: options.currency,
      unit_amount: options.amountMinor,
      lookup_key: lookupKey,
      recurring,
      metadata: {
        sidestream_plan: SIDESTREAM_PRO_PLAN_KEY,
        sidestream_upgrade_experiment_id: UPGRADE_PRICING_EXPERIMENT_ID,
      },
    }, {
      ...getStripeRequestOptions(),
      idempotencyKey: getStripeRecurringPriceIdempotencyKey({
        ...expected,
        interval: UPGRADE_PRICING_ANNUAL_INTERVAL,
        intervalCount: UPGRADE_PRICING_ANNUAL_INTERVAL_COUNT,
        usageType: UPGRADE_PRICING_ANNUAL_USAGE_TYPE,
        livemode: isLiveStripeMode(),
      }),
    });
    if (!isUpgradePricingAnnualPriceShape(created, expected)) {
      throw new Error("Stripe created an annual Price with unexpected terms");
    }
    return created.id;
  } catch (error) {
    const converged = await getStripe().prices.list({
      active: true,
      lookup_keys: [lookupKey],
      product: options.productId,
      limit: 10,
    }, getStripeRequestOptions());
    const match = converged.data.find((price) =>
      price.lookup_key === lookupKey &&
      isUpgradePricingAnnualPriceShape(price, expected)
    );
    if (match) return match.id;
    throw error;
  }
}

export function upgradePricingMonthlyLookupKey(currency: string, amountMinor: number) {
  const normalizedCurrency = cleanString(currency, 3).toLowerCase();
  if (!/^[a-z]{3}$/.test(normalizedCurrency) || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new TypeError("Monthly lookup key requires a currency and positive minor amount");
  }
  return `sidestream_pro_monthly_${normalizedCurrency}_${amountMinor}`;
}

export function upgradePricingAnnualLookupKey(currency: string, amountMinor: number) {
  const normalizedCurrency = cleanString(currency, 3).toLowerCase();
  if (!/^[a-z]{3}$/.test(normalizedCurrency) || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new TypeError("Annual lookup key requires a currency and positive minor amount");
  }
  return `sidestream_pro_annual_${normalizedCurrency}_${amountMinor}`;
}

function isUpgradePricingMonthlyPriceShape(
  price: Stripe.Price,
  expected: {
    productId: string;
    currency: string;
    amountMinor: number;
    lookupKey: string;
  },
) {
  return Boolean(
    price.id &&
    price.active === true &&
    price.livemode === isLiveStripeMode() &&
    price.lookup_key === expected.lookupKey &&
    normalizeStripeId(price.product) === expected.productId &&
    price.currency === expected.currency &&
    price.unit_amount === expected.amountMinor &&
    price.type === "recurring" &&
    price.recurring?.interval === UPGRADE_PRICING_MONTHLY_INTERVAL &&
    price.recurring?.interval_count === UPGRADE_PRICING_MONTHLY_INTERVAL_COUNT &&
    price.recurring?.usage_type === UPGRADE_PRICING_MONTHLY_USAGE_TYPE,
  );
}

function isUpgradePricingAnnualPriceShape(
  price: Stripe.Price,
  expected: {
    productId: string;
    currency: string;
    amountMinor: number;
    lookupKey: string;
  },
) {
  return Boolean(
    price.id &&
    price.active === true &&
    price.livemode === isLiveStripeMode() &&
    price.lookup_key === expected.lookupKey &&
    normalizeStripeId(price.product) === expected.productId &&
    price.currency === expected.currency &&
    price.unit_amount === expected.amountMinor &&
    price.type === "recurring" &&
    price.recurring?.interval === UPGRADE_PRICING_ANNUAL_INTERVAL &&
    price.recurring?.interval_count === UPGRADE_PRICING_ANNUAL_INTERVAL_COUNT &&
    price.recurring?.usage_type === UPGRADE_PRICING_ANNUAL_USAGE_TYPE,
  );
}

export async function getSidestreamProPriceId() {
  const productId = getSidestreamProProductId();
  const configuredPriceId = await getConfiguredSidestreamProPriceId(productId);
  if (configuredPriceId) return configuredPriceId;

  const product = await retrieveSidestreamProProduct(productId);
  const defaultPriceId = await getValidDefaultSidestreamProPriceId(product, productId);
  if (defaultPriceId) return defaultPriceId;

  const lookupPriceId = await findSidestreamProLookupPriceId(productId);
  if (lookupPriceId) return lookupPriceId;

  const activeProductPriceId = await findSidestreamProProductPriceId(productId);
  if (activeProductPriceId) return activeProductPriceId;

  return createSidestreamProPriceId(productId);
}

export async function getSidestreamUnlimitedPriceId() {
  return getSidestreamProPriceId();
}

export function getSidestreamProProductId() {
  return getValidEnvValue("SIDESTREAM_PRO_PRODUCT_ID") ||
    SIDESTREAM_PRO_DEFAULT_PRODUCT_ID;
}

async function getConfiguredSidestreamProPriceId(productId: string) {
  const configuredPriceId = getValidEnvValue("SIDESTREAM_PRO_PRICE_ID");
  if (configuredPriceId) {
    try {
      const price = await getStripe().prices.retrieve(
        configuredPriceId,
        {},
        getStripeRequestOptions(),
      );
      if (isSidestreamProPriceShape(price, productId)) return price.id;
    } catch (error) {
      if (!isStripeResourceMissing(error)) throw error;
    }
  }

  const defaultPriceId = await getDefaultSidestreamProPriceId(productId);
  if (defaultPriceId) return defaultPriceId;

  const legacyPriceId = getValidEnvValue("SIDESTREAM_UNLIMITED_PRICE_ID");
  if (!legacyPriceId) return "";

  try {
    const price = await getStripe().prices.retrieve(
      legacyPriceId,
      {},
      getStripeRequestOptions(),
    );
    if (isSidestreamProPriceShape(price, productId)) return price.id;
  } catch (error) {
    if (!isStripeResourceMissing(error)) throw error;
  }

  return "";
}

async function getDefaultSidestreamProPriceId(productId: string) {
  if (!SIDESTREAM_PRO_DEFAULT_PRICE_ID) return "";

  try {
    const price = await getStripe().prices.retrieve(
      SIDESTREAM_PRO_DEFAULT_PRICE_ID,
      {},
      getStripeRequestOptions(),
    );
    if (isSidestreamProPriceShape(price, productId)) return price.id;

    return "";
  } catch (error) {
    if (isStripeResourceMissing(error) && !isLiveStripeMode()) return "";
    throw error;
  }
}

async function retrieveSidestreamProProduct(productId: string) {
  const product = await getStripe().products.retrieve(
    productId,
    { expand: ["default_price"] },
    getStripeRequestOptions(),
  );

  if ("deleted" in product) {
    throw new Error(`Configured Sidestream Unlimited product ${productId} was deleted in Stripe`);
  }

  if (!product.active) {
    throw new Error(`Configured Sidestream Unlimited product ${productId} is not active in Stripe`);
  }

  return product;
}

async function getValidDefaultSidestreamProPriceId(
  product: Stripe.Product,
  productId: string,
) {
  const defaultPrice = product.default_price;
  if (!defaultPrice) return "";

  if (typeof defaultPrice !== "string") {
    return isSidestreamProPriceShape(defaultPrice, productId) ? defaultPrice.id : "";
  }

  try {
    const price = await getStripe().prices.retrieve(
      defaultPrice,
      {},
      getStripeRequestOptions(),
    );
    return isSidestreamProPriceShape(price, productId) ? price.id : "";
  } catch (error) {
    if (isStripeResourceMissing(error)) return "";
    throw error;
  }
}

async function findSidestreamProLookupPriceId(productId: string) {
  const prices = await getStripe().prices.list(
    {
      active: true,
      lookup_keys: [SIDESTREAM_PRO_PRICE.lookupKey],
      product: productId,
      limit: 10,
    },
    getStripeRequestOptions(),
  );

  const matchingPrice = prices.data.find((price) =>
    isSidestreamProLookupPrice(price, productId),
  );
  if (matchingPrice) return matchingPrice.id;

  const conflictingPrice = prices.data[0];
  if (conflictingPrice) {
    throw new Error(
      `Stripe lookup key ${SIDESTREAM_PRO_PRICE.lookupKey} points to a price that is not the active approved one-time Sidestream Unlimited price for product ${productId}`,
    );
  }

  return "";
}

async function findSidestreamProProductPriceId(productId: string) {
  const prices = await getStripe().prices.list(
    {
      active: true,
      product: productId,
      limit: 100,
    },
    getStripeRequestOptions(),
  );

  return prices.data.find((price) => isSidestreamProPriceShape(price, productId))?.id || "";
}

async function createSidestreamProPriceId(productId: string) {
  try {
    const price = await getStripe().prices.create(
      {
        product: productId,
        unit_amount: SIDESTREAM_PRO_PRICE.unitAmount,
        currency: SIDESTREAM_PRO_PRICE.currency,
        lookup_key: SIDESTREAM_PRO_PRICE.lookupKey,
        metadata: {
          sidestream_plan: SIDESTREAM_PRO_PLAN_KEY,
        },
      },
      {
        ...getStripeRequestOptions(),
        idempotencyKey: getStripePriceIdempotencyKey(productId),
      },
    );

    return price.id;
  } catch (error) {
    const existingPriceId = await findSidestreamProLookupPriceId(productId);
    if (existingPriceId) return existingPriceId;
    throw error;
  }
}

function isSidestreamProLookupPrice(price: Stripe.Price, productId: string) {
  return price.lookup_key === SIDESTREAM_PRO_PRICE.lookupKey &&
    isSidestreamProPriceShape(price, productId);
}

function isSidestreamProPriceShape(price: Stripe.Price, productId: string) {
  return Boolean(
    price.active &&
    normalizeStripeId(price.product) === productId &&
    price.unit_amount === SIDESTREAM_PRO_PRICE.unitAmount &&
    price.currency === SIDESTREAM_PRO_PRICE.currency &&
    !price.recurring,
  );
}

export async function getOrCreateBasicSubscriptionPriceId() {
  const resourceKey = getBasicSubscriptionResourceKey();
  const existing = await findBillingResource(resourceKey);
  if (billingResourceMatchesBasicSubscription(existing)) {
    return existing.stripe_price_id;
  }

  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [resourceKey]);

      const lockedExisting = await findBillingResource(resourceKey, client);
      if (billingResourceMatchesBasicSubscription(lockedExisting)) {
        await client.query("commit");
        return lockedExisting.stripe_price_id;
      }

      const billingResource = lockedExisting
        ? await createReplacementBasicSubscriptionPrice(lockedExisting, resourceKey)
        : await createBasicSubscriptionProduct(resourceKey);

      await upsertBillingResource(client, resourceKey, billingResource);

      await client.query("commit");
      return billingResource.priceId;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

function getStripeSecretKey() {
  return requireEnv("STRIPE_SECRET_KEY");
}

function isLiveStripeMode() {
  return getStripeSecretKey().startsWith("sk_live_");
}

function getBasicSubscriptionResourceKey() {
  const mode = isLiveStripeMode() ? "live" : "sandbox";
  return `${BASIC_SUBSCRIPTION_RESOURCE_KEY_BASE}_${mode}`;
}

function billingResourceMatchesBasicSubscription(
  resource: BillingResource | null | undefined,
) {
  return Boolean(
    resource?.stripe_price_id &&
    resource.unit_amount === BASIC_SUBSCRIPTION_PRODUCT.unitAmount &&
    resource.currency === BASIC_SUBSCRIPTION_PRODUCT.currency &&
    resource.recurring_interval === BASIC_SUBSCRIPTION_PRODUCT.interval,
  );
}

async function createBasicSubscriptionProduct(resourceKey: string) {
  const product = await getStripe().products.create(
    {
      name: BASIC_SUBSCRIPTION_PRODUCT.name,
      description: BASIC_SUBSCRIPTION_PRODUCT.description,
      tax_code: BASIC_SUBSCRIPTION_PRODUCT.taxCode,
      default_price_data: {
        unit_amount: BASIC_SUBSCRIPTION_PRODUCT.unitAmount,
        currency: BASIC_SUBSCRIPTION_PRODUCT.currency,
        recurring: {
          interval: BASIC_SUBSCRIPTION_PRODUCT.interval,
        },
      },
      metadata: {
        sidestream_resource_key: resourceKey,
      },
    } as Stripe.ProductCreateParams,
    getStripeRequestOptions(),
  );
  const priceId = normalizeStripeId(product.default_price);
  if (!priceId) {
    throw new Error("Stripe product was created without a default price");
  }

  return { productId: product.id, priceId };
}

async function createReplacementBasicSubscriptionPrice(
  resource: BillingResource,
  resourceKey: string,
) {
  try {
    const price = await getStripe().prices.create(
      {
        product: resource.stripe_product_id,
        unit_amount: BASIC_SUBSCRIPTION_PRODUCT.unitAmount,
        currency: BASIC_SUBSCRIPTION_PRODUCT.currency,
        recurring: {
          interval: BASIC_SUBSCRIPTION_PRODUCT.interval,
        },
        metadata: {
          sidestream_resource_key: resourceKey,
          sidestream_replaces_price_id: resource.stripe_price_id,
        },
      } as Stripe.PriceCreateParams,
      getStripeRequestOptions(),
    );

    await getStripe().products.update(
      resource.stripe_product_id,
      {
        name: BASIC_SUBSCRIPTION_PRODUCT.name,
        description: BASIC_SUBSCRIPTION_PRODUCT.description,
        tax_code: BASIC_SUBSCRIPTION_PRODUCT.taxCode,
        default_price: price.id,
        metadata: {
          sidestream_resource_key: resourceKey,
        },
      } as Stripe.ProductUpdateParams,
      getStripeRequestOptions(),
    );

    if (resource.stripe_price_id !== price.id) {
      await getStripe().prices.update(
        resource.stripe_price_id,
        { active: false },
        getStripeRequestOptions(),
      );
    }

    return { productId: resource.stripe_product_id, priceId: price.id };
  } catch (error) {
    if (isStripeResourceMissing(error)) {
      return createBasicSubscriptionProduct(resourceKey);
    }
    throw error;
  }
}

async function upsertBillingResource(
  client: PoolClient,
  resourceKey: string,
  resource: { productId: string; priceId: string },
) {
  await client.query(
    `
      insert into public.sidestream_billing_resources (
        resource_key,
        stripe_product_id,
        stripe_price_id,
        product_name,
        product_description,
        tax_code,
        unit_amount,
        currency,
        recurring_interval,
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())
      on conflict (resource_key) do update set
        stripe_product_id = excluded.stripe_product_id,
        stripe_price_id = excluded.stripe_price_id,
        product_name = excluded.product_name,
        product_description = excluded.product_description,
        tax_code = excluded.tax_code,
        unit_amount = excluded.unit_amount,
        currency = excluded.currency,
        recurring_interval = excluded.recurring_interval,
        updated_at = now()
    `,
    [
      resourceKey,
      resource.productId,
      resource.priceId,
      BASIC_SUBSCRIPTION_PRODUCT.name,
      BASIC_SUBSCRIPTION_PRODUCT.description,
      BASIC_SUBSCRIPTION_PRODUCT.taxCode,
      BASIC_SUBSCRIPTION_PRODUCT.unitAmount,
      BASIC_SUBSCRIPTION_PRODUCT.currency,
      BASIC_SUBSCRIPTION_PRODUCT.interval,
    ],
  );
}

export function getStripeWebhookSecret() {
  return requireEnv("STRIPE_WEBHOOK_SECRET");
}

export async function createActivationSession(
  request: IncomingMessage,
  payload: {
    deviceId?: unknown;
    appVersion?: unknown;
    buildChannel?: unknown;
    source?: unknown;
    installIdHash?: unknown;
    supportCode?: unknown;
    installerReceiptIdHash?: unknown;
  },
  environmentInput?: ResolvedLicenseEnvironment,
) {
  const environment = requireMatchingLicenseEnvironment(environmentInput);
  const identity = normalizeCustomerIdentityInput(payload);
  const activationKey = randomToken(24);
  const expiresAt = addHours(new Date(), ACTIVATION_TTL_HOURS);
  const deviceId = cleanString(payload.deviceId, 240);
  if (!deviceId) throw new Error("Missing device ID");

  const requestedSource = cleanString(payload.source, 120);
  const paidOnboardingSource =
    typeof payload.source === "string" &&
    payload.source === PAID_ACQUISITION_SOURCE;
  const activationSource = paidOnboardingSource
    ? PAID_ACQUISITION_SOURCE
    : requestedSource === PAID_ACQUISITION_SOURCE
      ? "plugin"
      : requestedSource || "plugin";
  await withPgClient(async (client) => {
    await client.query("begin");
    try {
      const inserted = await client.query<{ id: string }>(
        `
          insert into public.sidestream_activation_sessions (
            activation_key,
            device_id_hash,
            app_version,
            build_channel,
            source,
            ip_address,
            user_agent,
            status,
            expires_at,
            created_at,
            updated_at
          )
          values ($1, $2, $3, $4, $5, $6::inet, $7, 'pending', $8::timestamptz, now(), now())
          returning id
        `,
        [
          activationKey,
          hashPrivateIdentifier(deviceId),
          cleanString(payload.appVersion, 80) || null,
          cleanString(payload.buildChannel, 80) || null,
          activationSource,
          getClientIp(request) || null,
          cleanString(request.headers["user-agent"], 500) || null,
          expiresAt.toISOString(),
        ],
      );
      const activationId = inserted.rows[0]?.id;
      if (!activationId) throw new Error("Activation insert did not return an ID");

      await attachCustomerIdentity(client, {
        environment,
        identity,
        activationId,
        appVersion: payload.appVersion,
        source: "activation_start",
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });

  return {
    activationKey,
    expiresAt: expiresAt.toISOString(),
    upgradeUrl: `${getBaseUrl(request)}/api/checkout/start?activation=${encodeURIComponent(activationKey)}`,
    restoreUrl: `${getBaseUrl(request)}${
      paidOnboardingSource
        ? "/api/activation/paid-claim"
        : "/api/activation/claim"
    }?activation=${encodeURIComponent(activationKey)}`,
  };
}

export async function getActivationCheckoutContext(activationKey: string) {
  const result = await query<{
    expires_at: Date | string;
    stripe_checkout_session_id: string | null;
    stripe_checkout_price_id: string | null;
    stripe_checkout_product_id: string | null;
    stripe_checkout_expires_at: Date | string | null;
    checkout_claim_grace_until: Date | string | null;
  }>(
    `
      select
        expires_at,
        stripe_checkout_session_id,
        stripe_checkout_price_id,
        stripe_checkout_product_id,
        stripe_checkout_expires_at,
        checkout_claim_grace_until
      from public.sidestream_activation_sessions
      where activation_key = $1
        and expires_at > now()
        and completed_at is null
        and device_id_hash is not null
        and account_id is null
        and status = 'pending'
      limit 1
    `,
    [activationKey],
  );

  const row = result.rows[0];
  if (!row) return null;

  const activationExpiresAt = new Date(row.expires_at);
  if (
    row.stripe_checkout_session_id &&
    row.stripe_checkout_price_id &&
    row.stripe_checkout_product_id &&
    row.stripe_checkout_expires_at &&
    row.checkout_claim_grace_until
  ) {
    return {
      checkoutSessionId: row.stripe_checkout_session_id,
      priceId: row.stripe_checkout_price_id,
      productId: row.stripe_checkout_product_id,
      checkoutExpiresAt: Math.floor(new Date(row.stripe_checkout_expires_at).getTime() / 1000),
      claimGraceUntil: toIsoString(row.checkout_claim_grace_until),
    };
  }

  const checkoutWindow = getStripeCheckoutWindow(
    activationExpiresAt.getTime(),
    CHECKOUT_CLAIM_GRACE_SECONDS,
  );
  if (checkoutWindow.checkoutExpiresAt * 1000 < Date.now() + 31 * 60 * 1000) return null;

  return {
    checkoutSessionId: "",
    priceId: "",
    productId: "",
    ...checkoutWindow,
  };
}

export async function attachCheckoutSessionToActivation(options: {
  activationKey: string;
  checkoutSessionId: string;
  priceId: string;
  productId: string;
  checkoutExpiresAt: number;
  claimGraceUntil: string;
  // Supplying this is reserved for the Checkout-intent worker while it holds
  // the activation advisory lock and only after Stripe reports terminal/expired
  // or the worker has explicitly expired the prior Session.
  replaceCheckoutSessionId?: string;
  runner?: Pick<Pool | PoolClient, "query">;
}) {
  const runner = options.runner || getPool();
  const result = await runner.query<{ id: string }>(
    `
      update public.sidestream_activation_sessions
      set stripe_checkout_session_id = $2,
          stripe_checkout_price_id = $3,
          stripe_checkout_product_id = $4,
          checkout_attached_at = case
            when stripe_checkout_session_id = $2 then coalesce(checkout_attached_at, now())
            else now()
          end,
          reconciliation_last_attempt_at = case
            when stripe_checkout_session_id = $2 then reconciliation_last_attempt_at
            else null
          end,
          stripe_checkout_expires_at = to_timestamp($5),
          checkout_claim_grace_until = $6::timestamptz,
          updated_at = now()
      where activation_key = $1
        and expires_at > now()
        and completed_at is null
        and device_id_hash is not null
        and account_id is null
        and status = 'pending'
        and (
          stripe_checkout_session_id is null
          or (
            stripe_checkout_session_id = $2
            and stripe_checkout_price_id = $3
            and stripe_checkout_product_id = $4
            and stripe_checkout_expires_at = to_timestamp($5)
            and checkout_claim_grace_until = $6::timestamptz
          )
          or (
            $7::text is not null
            and $7 <> $2
            and stripe_checkout_session_id = $7
          )
        )
      returning id
    `,
    [
      options.activationKey,
      options.checkoutSessionId,
      options.priceId,
      options.productId,
      options.checkoutExpiresAt,
      options.claimGraceUntil,
      options.replaceCheckoutSessionId || null,
    ],
  );
  return Boolean(result.rows[0]);
}

export async function getActivationClaimContext(activationKey: string) {
  const result = await query<{
    app_version: string | null;
    build_channel: string | null;
    expires_at: Date | string;
  }>(
    `
      select app_version, build_channel, expires_at
      from public.sidestream_activation_sessions
      where activation_key = $1
        and expires_at > now()
        and completed_at is null
        and device_id_hash is not null
        and status = 'pending'
      limit 1
    `,
    [activationKey],
  );

  const row = result.rows[0];
  return row
    ? {
        available: true as const,
        appVersion: row.app_version || "",
        buildChannel: row.build_channel || "",
        expiresAt: toIsoString(row.expires_at),
      }
    : { available: false as const };
}

export async function claimActivationToAccount(
  activationKey: string,
  accountId: string,
  options: {
    environment?: ResolvedLicenseEnvironment;
    identity?: unknown;
  } = {},
) {
  const environment = requireMatchingLicenseEnvironment(options.environment);
  const identity = normalizeCustomerIdentityInput(options.identity);
  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      const selected = await client.query<{
        id: string;
        account_id: string | null;
        status: string;
        completed_at: Date | string | null;
        expired: boolean;
      }>(
        `
          select
            id,
            account_id,
            status,
            completed_at,
            expires_at <= now() as expired
          from public.sidestream_activation_sessions
          where activation_key = $1
            and device_id_hash is not null
          for update
        `,
        [activationKey],
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query("rollback");
        return { claimed: false as const, reason: "unavailable" as const };
      }
      if (isActivationClaimReplay({
        existingAccountId: row.account_id,
        requestedAccountId: accountId,
        status: row.status,
        expired: row.expired,
      })) {
        await attachCustomerIdentity(client, {
          environment,
          identity,
          activationId: row.id,
          accountId,
          source: "activation_claim",
        });
        await client.query("commit");
        return { claimed: true as const };
      }
      if (row.expired || row.completed_at || row.status !== "pending") {
        await client.query("rollback");
        return { claimed: false as const, reason: "unavailable" as const };
      }
      if (!canBindActivationAccount(row.account_id, accountId)) {
        await client.query("rollback");
        return { claimed: false as const, reason: "account_conflict" as const };
      }

      const updated = await client.query<{ id: string }>(
        `
          update public.sidestream_activation_sessions
          set account_id = $2,
              status = 'restored',
              updated_at = now()
          where activation_key = $1
            and expires_at > now()
            and completed_at is null
            and status = 'pending'
            and (account_id is null or account_id = $2)
          returning id
        `,
        [activationKey, accountId],
      );
      if (!updated.rows[0]) {
        await client.query("rollback");
        return { claimed: false as const, reason: "conflict" as const };
      }

      await attachCustomerIdentity(client, {
        environment,
        identity,
        activationId: updated.rows[0].id,
        accountId,
        source: "activation_claim",
      });

      await client.query("commit");
      return { claimed: true as const };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export function createActivationClaimCsrf(
  activationKey: string,
  accountId: string,
) {
  return createClaimCsrfToken({
    activationKey,
    accountId,
    expiresAtSeconds: Math.floor(Date.now() / 1000) + ACTIVATION_CLAIM_CSRF_TTL_SECONDS,
    secret: getPrivateServerSecret(),
  });
}

export function validateActivationClaimRequest(
  request: IncomingMessage,
  options: { activationKey: string; accountId: string; csrfToken: string },
) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return validateActivationClaimPost({
    requestOrigin: firstHeaderValue(request.headers.origin),
    expectedOrigin: getBaseUrl(request),
    contentType: firstHeaderValue(request.headers["content-type"]),
    fetchSite: firstHeaderValue(request.headers["sec-fetch-site"]),
    fetchMode: firstHeaderValue(request.headers["sec-fetch-mode"]),
    fetchDest: firstHeaderValue(request.headers["sec-fetch-dest"]),
  }) && validateClaimCsrfToken({
    token: options.csrfToken,
    activationKey: options.activationKey,
    accountId: options.accountId,
    nowSeconds,
    secret: getPrivateServerSecret(),
  });
}

export async function getActivationStatus(
  activationKey: string,
  deviceId: string,
  options: {
    skipReconciliation?: boolean;
    environment?: ResolvedLicenseEnvironment;
    platform?: unknown;
    identity?: unknown;
  } = {},
) {
  const environment = requireMatchingLicenseEnvironment(options.environment);
  const identity = normalizeCustomerIdentityInput(options.identity);
  const result = await query<{
    activation_id: string;
    app_version: string | null;
    build_channel: string | null;
    account_id: string | null;
    license_id: string | null;
    status: string;
    expires_at: Date | string;
    completed_at: Date | string | null;
    device_id_hash: string | null;
    stripe_checkout_session_id: string | null;
    license_status: string | null;
    plan_key: string | null;
    entitlement_status: string | null;
    current_period_end: Date | string | null;
    cancel_at_period_end: boolean | null;
    grace_until: Date | string | null;
    features: Record<string, unknown> | null;
  }>(
    `
      select
        a.id as activation_id,
        a.app_version,
        a.build_channel,
        a.account_id,
        l.id as license_id,
        a.status,
        a.expires_at,
        a.completed_at,
        a.device_id_hash,
        a.stripe_checkout_session_id,
        l.status as license_status,
        l.plan_key,
        license_state.entitlement_status,
        l.current_period_end,
        l.cancel_at_period_end,
        l.grace_until,
        l.features
      from public.sidestream_activation_sessions a
      left join public.sidestream_licenses l on l.account_id = a.account_id
      left join lateral (
        select ${LICENSE_ENTITLEMENT_STATUS_SQL} as entitlement_status
      ) license_state on true
      where a.activation_key = $1
      order by (case
          when license_state.entitlement_status = 'active'
            and l.plan_key in ('sidestream_pro', 'sidestream_unlimited') then 0
          else 1
        end),
        l.updated_at desc nulls last
      limit 1
    `,
    [activationKey],
  );

  const row = result.rows[0];
  if (!row) {
    return { status: "not_found" as const };
  }

  const deviceIdHash = deviceId ? hashPrivateIdentifier(deviceId) : "";
  if (!matchesDeviceHash(row.device_id_hash, deviceIdHash)) {
    return { status: "device_mismatch" as const };
  }

  if (
    !options.skipReconciliation &&
    !row.license_id &&
    row.stripe_checkout_session_id
  ) {
    const cooldown = await query<{ id: string }>(
      `
        update public.sidestream_activation_sessions
        set reconciliation_last_attempt_at = now(), updated_at = now()
        where id = $1
          and (
            reconciliation_last_attempt_at is null
            or reconciliation_last_attempt_at < now() - ($2 * interval '1 second')
          )
        returning id
      `,
      [row.activation_id, ACTIVATION_RECONCILIATION_COOLDOWN_SECONDS],
    );
    if (cooldown.rows[0]) {
      await fulfillCheckoutSession(row.stripe_checkout_session_id, activationKey);
      return getActivationStatus(activationKey, deviceId, {
        ...options,
        skipReconciliation: true,
        environment,
      });
    }
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await query(
      `
        update public.sidestream_activation_sessions
        set status = 'expired', updated_at = now()
        where id = $1 and status <> 'expired'
      `,
      [row.activation_id],
    );
    return { status: "expired" as const };
  }

  // A later client may provide stable anonymous associations even when the
  // activation was started by an older client. Persist those associations
  // after the activation/device check, without making them device authority.
  if (Object.keys(identity).length > 0) {
    await attachCustomerIdentityTransaction({
      environment,
      identity,
      activationId: row.activation_id,
      accountId: row.account_id,
      platform: options.platform,
      appVersion: row.app_version,
      source: "activation_status",
    });
  }

  const license = buildLicenseSummary({
    status: row.license_status,
    planKey: row.plan_key,
    entitlementStatus: row.entitlement_status,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    graceUntil: row.grace_until,
    features: row.features,
  });

  if (!row.account_id) {
    return { status: "pending" as const, license };
  }

  if (!row.license_id || !license.active) {
    return { status: "pending_payment" as const, license };
  }

  const activationBinding = await checkActivationDeviceBinding({
    accountId: row.account_id,
    environment,
    deviceIdHash,
    platform: options.platform,
    appVersion: row.app_version,
    buildChannel: row.build_channel,
    previouslyIssuedAt: row.completed_at,
    licenseFeatures: row.features,
  });
  if (!activationBinding.allowed) {
    return {
      status: activationBinding.code,
      code: activationBinding.code,
      license,
    };
  }

  const legacyClient = needsLegacyLicenseCompatibility(row.app_version);

  if (
    !legacyClient &&
    !isActivationTokenReplayAllowed(
      row.completed_at ? new Date(row.completed_at).getTime() : null,
      Date.now(),
      ACTIVATION_TOKEN_REPLAY_SECONDS,
    )
  ) {
    await attachCustomerIdentityTransaction({
      environment,
      identity,
      activationId: row.activation_id,
      accountId: row.account_id,
      platform: options.platform,
      appVersion: row.app_version,
      source: "activation_status",
    });
    return { status: "completed" as const, license };
  }

  const issued = await issueLicenseTokenPair({
    activationId: row.activation_id,
    activationKey,
    accountId: row.account_id,
    licenseId: row.license_id,
    deviceId,
    environment,
    platform: options.platform,
    appVersion: row.app_version,
    buildChannel: row.build_channel,
    previouslyIssuedAt: row.completed_at,
    accessTokenTtlDays: legacyClient
      ? LEGACY_LICENSE_TOKEN_TTL_DAYS
      : LICENSE_TOKEN_TTL_DAYS,
    identity,
  });

  if (!issued.issued && issued.code) {
    return {
      status: issued.code,
      code: issued.code,
      license,
    };
  }

  if (issued.issued) {
    const { licenseWriteThrottleSeconds } = loadLicenseWriteConfiguration();
    await query(
      `
        update public.sidestream_activation_sessions
        set license_id = $2,
            completed_at = coalesce(completed_at, now()),
            status = 'linked',
            updated_at = now()
        where id = $1
          and (
            license_id is distinct from $2::uuid
            or completed_at is null
            or status <> 'linked'
            or updated_at <= now() - ($3::bigint * interval '1 second')
          )
      `,
      [row.activation_id, row.license_id, licenseWriteThrottleSeconds],
    );
  }

  return {
    status: "active" as const,
    license,
    ...(issued.issued
      ? {
          licenseToken: issued.licenseToken,
          refreshToken: issued.refreshToken,
          tokenExpiresAt: issued.tokenExpiresAt,
          refreshExpiresAt: issued.refreshExpiresAt,
        }
      : {}),
  };
}

export async function verifyLicenseToken(
  licenseToken: string,
  deviceId: string,
  environmentInput?: ResolvedLicenseEnvironment,
  identityInput?: unknown,
) {
  const environment = requireMatchingLicenseEnvironment(environmentInput);
  const identity = normalizeCustomerIdentityInput(identityInput);
  const tokenHash = hashToken(licenseToken);
  const deviceIdHash = deviceId ? hashPrivateIdentifier(deviceId) : "";
  const accountLookup = await query<{ account_id: string }>(
    `select account_id from public.sidestream_license_tokens where token_hash = $1 limit 1`,
    [tokenHash],
  );
  const accountId = accountLookup.rows[0]?.account_id;
  if (!accountId) {
    return {
      active: false as const,
      status: "invalid",
      code: "invalid_token" as const,
    };
  }

  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        getAccountDeviceLockKey(accountId, environment.namespace),
      ]);
      const selected = await client.query<{
        token_id: string;
        account_id: string;
        activation_session_id: string | null;
        expires_at: Date | string;
        revoked_at: Date | string | null;
        created_at: Date | string;
        device_id_hash: string | null;
        activation_app_version: string | null;
        activation_build_channel: string | null;
        status: string | null;
        plan_key: string | null;
        entitlement_status: string | null;
        current_period_end: Date | string | null;
        cancel_at_period_end: boolean | null;
        grace_until: Date | string | null;
        features: Record<string, unknown> | null;
      }>(
        `
          select
            t.id as token_id,
            t.account_id,
            t.activation_session_id,
            t.expires_at,
            t.revoked_at,
            t.created_at,
            t.device_id_hash,
            a.app_version as activation_app_version,
            a.build_channel as activation_build_channel,
            l.status,
            l.plan_key,
            ${LICENSE_ENTITLEMENT_STATUS_SQL} as entitlement_status,
            l.current_period_end,
            l.cancel_at_period_end,
            l.grace_until,
            l.features
          from public.sidestream_license_tokens t
          join public.sidestream_licenses l on l.id = t.license_id
          left join public.sidestream_activation_sessions a on a.id = t.activation_session_id
          where t.token_hash = $1
            and t.account_id = $2
          limit 1
          for update of t
        `,
        [tokenHash, accountId],
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query("rollback");
        return { active: false as const, status: "invalid", code: "invalid_token" as const };
      }
      if (!matchesDeviceHash(row.device_id_hash, deviceIdHash)) {
        await client.query("rollback");
        return { active: false as const, status: "invalid", code: "device_mismatch" as const };
      }
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await client.query("rollback");
        return { active: false as const, status: "invalid", code: "invalid_token" as const };
      }

      const license = buildLicenseSummary({
        status: row.status,
        planKey: row.plan_key,
        entitlementStatus: row.entitlement_status,
        currentPeriodEnd: row.current_period_end,
        cancelAtPeriodEnd: row.cancel_at_period_end,
        graceUntil: row.grace_until,
        features: row.features,
      });
      if (!license.active) {
        await client.query("rollback");
        return {
          active: false as const,
          status: license.status,
          code: "license_inactive" as const,
          license,
        };
      }

      const binding = await lockAccountDeviceBinding(client, {
        accountId: row.account_id,
        namespace: environment.namespace,
        requestedDeviceIdHash: deviceIdHash,
        purpose: "credential",
        claimEmpty: !row.revoked_at,
        credentialCreatedAt: row.created_at,
        appVersion: row.activation_app_version,
        buildChannel: row.activation_build_channel,
      });
      if (!binding.allowed) {
        await client.query("commit");
        return { active: false as const, status: "invalid", code: binding.code };
      }
      if (row.revoked_at) {
        await client.query("commit");
        return { active: false as const, status: "invalid", code: "revoked" as const };
      }

      await attachCustomerIdentity(client, {
        environment,
        identity,
        activationId: row.activation_session_id,
        accountId: row.account_id,
        appVersion: row.activation_app_version,
        source: "license_verify",
      });

      const legacyTokenExpiresAt = needsLegacyLicenseCompatibility(row.activation_app_version)
        ? addDays(new Date(), LEGACY_LICENSE_TOKEN_TTL_DAYS).toISOString()
        : "";
      const {
        legacyTokenRenewalThresholdDays,
        licenseWriteThrottleSeconds,
      } = loadLicenseWriteConfiguration();
      const updated = await client.query<{ expires_at: Date | string }>(
        `
          update public.sidestream_license_tokens
          set last_seen_at = case
                when last_seen_at is null
                  or last_seen_at <= now() - ($3::bigint * interval '1 second')
                  then now()
                else last_seen_at
              end,
              expires_at = case
                when $2::timestamptz is not null
                  and expires_at <= now() + ($4::bigint * interval '1 day')
                  then greatest(expires_at, $2::timestamptz)
                else expires_at
              end,
              updated_at = now()
          where id = $1
            and revoked_at is null
            and (
              last_seen_at is null
              or last_seen_at <= now() - ($3::bigint * interval '1 second')
              or (
                $2::timestamptz is not null
                and expires_at <= now() + ($4::bigint * interval '1 day')
              )
            )
          returning expires_at
        `,
        [
          row.token_id,
          legacyTokenExpiresAt || null,
          licenseWriteThrottleSeconds,
          legacyTokenRenewalThresholdDays,
        ],
      );

      await client.query("commit");
      return {
        active: true as const,
        status: license.status,
        tokenExpiresAt: toIsoString(updated.rows[0]?.expires_at || row.expires_at),
        license,
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function upsertLicenseFromSubscription(
  subscriptionPayload: unknown,
  accountIdHint?: string,
  stripeEvent?: { eventId: string; created: number },
) {
  const subscription = subscriptionPayload as Record<string, any>;
  const customerId = normalizeStripeId(subscription.customer);
  const subscriptionId = normalizeStripeId(subscription.id);
  if (!customerId || !subscriptionId) {
    return { fulfilled: false as const, reason: "missing_subscription_identity" };
  }

  const eventWatermark = normalizeStripeEventWatermark(stripeEvent);
  const itemPriceId = normalizeStripeId(subscription.items?.data?.[0]?.price);
  let price: Stripe.Price | null = null;
  let product: Stripe.Product | Stripe.DeletedProduct | null = null;
  if (itemPriceId) {
    price = await getStripe().prices.retrieve(
      itemPriceId,
      {},
      getStripeRequestOptions(),
    );
    const productId = normalizeStripeId(price.product);
    if (productId) {
      product = await getStripe().products.retrieve(
        productId,
        {},
        getStripeRequestOptions(),
      );
    }
  }

  const allowlist = getLegacySubscriptionAllowlist();
  const verification = verifyLegacySubscriptionEntitlement(
    subscription,
    price || {},
    product || {},
    allowlist,
  );
  const status = cleanString(subscription.status, 80) || "unknown";
  if (!verification.ok) {
    // This compatibility-only persistence path is used by old fixture callers
    // that provide an existing account explicitly. It records a denied row and
    // never makes that row eligible; runtime Stripe entry points pass no hint.
    if (accountIdHint && !itemPriceId && !allowlist.priceIds.length && !allowlist.productIds.length) {
      return persistDeniedLegacySubscriptionInventory({
        accountId: accountIdHint,
        customerId,
        subscriptionId,
        status,
        reason: verification.reason,
        eventWatermark,
      });
    }
    return quarantineExistingLegacySubscription({
      subscriptionId,
      status,
      reason: verification.reason,
      eventWatermark,
    });
  }

  const active = isLicenseStatusUsable(status);
  const existing = await query<{ account_id: string }>(
    `
      select account_id
      from public.sidestream_licenses
      where stripe_subscription_id = $1
      limit 1
    `,
    [subscriptionId],
  );
  if (!active && !existing.rows[0]) {
    return { fulfilled: false as const, reason: "inactive_subscription_without_license" };
  }

  const accountId = existing.rows[0]?.account_id || accountIdHint ||
    await findOrCreateAccountForStripeCustomer(customerId);
  if (!accountId) return { fulfilled: false as const, reason: "missing_account" };

  await query(
    `
      update public.sidestream_accounts
      set stripe_customer_id = $2, updated_at = now()
      where id = $1
    `,
    [accountId, customerId],
  );

  const currentPeriodEnd = timestampToIso(subscription.current_period_end);
  const cancelAtPeriodEnd = Boolean(subscription.cancel_at_period_end || subscription.cancel_at);
  const entitlementStatus = active ? "active" : "revoked";
  const statusReason = `subscription_${status}`.slice(0, 160);
  const features = {
    unlimited_downloads: active,
    customer_portal: true,
  };

  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `legacy_subscription:${subscriptionId}`,
      ]);
      await lockPaidEligibility(client, accountId);
      const result = await client.query<{ id: string }>(
        `
          insert into public.sidestream_licenses (
            account_id,
            stripe_customer_id,
            stripe_subscription_id,
            stripe_price_id,
            stripe_product_id,
            plan_key,
            status,
            current_period_end,
            cancel_at_period_end,
            grace_until,
            features,
            entitlement_status,
            status_reason,
            revoked_at,
            reconciled_at,
            legacy_subscription_eligible,
            legacy_subscription_audited_at,
            legacy_subscription_quarantined_at,
            stripe_state_event_created_at,
            stripe_state_event_id,
            created_at,
            updated_at
          )
          values (
            $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, null, $10::jsonb,
            $11, $12, case when $11 = 'revoked' then now() else null end,
            now(), true, now(), null, $13::timestamptz, $14, now(), now()
          )
          on conflict (stripe_subscription_id) do update set
            account_id = excluded.account_id,
            stripe_customer_id = excluded.stripe_customer_id,
            stripe_price_id = excluded.stripe_price_id,
            stripe_product_id = excluded.stripe_product_id,
            plan_key = excluded.plan_key,
            status = excluded.status,
            current_period_end = excluded.current_period_end,
            cancel_at_period_end = excluded.cancel_at_period_end,
            grace_until = null,
            features = excluded.features || case
              when sidestream_licenses.account_id = excluded.account_id
                and sidestream_licenses.features ? 'singleDevicePolicy'
                then jsonb_build_object(
                  'singleDevicePolicy',
                  sidestream_licenses.features -> 'singleDevicePolicy'
                )
              else '{}'::jsonb
            end,
            entitlement_status = excluded.entitlement_status,
            status_reason = excluded.status_reason,
            revoked_at = case
              when excluded.entitlement_status = 'revoked'
                then coalesce(sidestream_licenses.revoked_at, now())
              else sidestream_licenses.revoked_at
            end,
            reconciled_at = now(),
            legacy_subscription_eligible = true,
            legacy_subscription_audited_at = now(),
            legacy_subscription_quarantined_at = null,
            stripe_state_event_created_at = coalesce(
              excluded.stripe_state_event_created_at,
              sidestream_licenses.stripe_state_event_created_at
            ),
            stripe_state_event_id = coalesce(
              excluded.stripe_state_event_id,
              sidestream_licenses.stripe_state_event_id
            ),
            updated_at = now()
          where excluded.stripe_state_event_created_at is null
            or sidestream_licenses.stripe_state_event_created_at is null
            or excluded.stripe_state_event_created_at > sidestream_licenses.stripe_state_event_created_at
            or (
              excluded.stripe_state_event_created_at = sidestream_licenses.stripe_state_event_created_at
              and excluded.stripe_state_event_id > coalesce(sidestream_licenses.stripe_state_event_id, '')
            )
          returning id
        `,
        [
          accountId,
          customerId,
          subscriptionId,
          verification.priceId,
          verification.productId,
          SIDESTREAM_PRO_PLAN_KEY,
          status,
          currentPeriodEnd,
          cancelAtPeriodEnd,
          JSON.stringify(features),
          entitlementStatus,
          statusReason,
          eventWatermark?.createdAtIso || null,
          eventWatermark?.eventId || null,
        ],
      );
      const licenseId = result.rows[0]?.id;
      if (!licenseId) {
        await client.query("commit");
        return { fulfilled: true as const, applied: false as const, reason: "stale_event" };
      }
      if (!active) await revokeLicenseCredentials(client, licenseId);
      await client.query("commit");
      return { fulfilled: true as const, applied: true as const };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

function getLegacySubscriptionAllowlist() {
  return {
    productIds: parseStripeIdAllowlist(
      process.env[LEGACY_SUBSCRIPTION_PRODUCT_IDS_ENV],
      "prod",
    ),
    priceIds: parseStripeIdAllowlist(
      process.env[LEGACY_SUBSCRIPTION_PRICE_IDS_ENV],
      "price",
    ),
  };
}

function normalizeStripeEventWatermark(
  stripeEvent?: { eventId: string; created: number },
) {
  if (!stripeEvent) return null;
  const eventId = cleanString(stripeEvent.eventId, 255);
  if (!eventId || !Number.isSafeInteger(stripeEvent.created) || stripeEvent.created < 0) {
    throw new TypeError("Stripe event ordering requires an event ID and creation time");
  }
  return {
    eventId,
    createdAtIso: new Date(stripeEvent.created * 1_000).toISOString(),
    createdAtMs: stripeEvent.created * 1_000,
  };
}

async function quarantineExistingLegacySubscription(options: {
  subscriptionId: string;
  status: string;
  reason: string;
  eventWatermark: ReturnType<typeof normalizeStripeEventWatermark>;
}) {
  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `legacy_subscription:${options.subscriptionId}`,
      ]);
      const updated = await client.query<{ id: string }>(
        `
          update public.sidestream_licenses
          set status = $2,
              entitlement_status = 'revoked',
              status_reason = $3,
              revoked_at = coalesce(revoked_at, now()),
              reconciled_at = now(),
              legacy_subscription_eligible = false,
              legacy_subscription_audited_at = now(),
              legacy_subscription_quarantined_at = coalesce(
                legacy_subscription_quarantined_at,
                now()
              ),
              features = features || '{"unlimited_downloads": false}'::jsonb,
              stripe_state_event_created_at = coalesce(
                $4::timestamptz,
                stripe_state_event_created_at
              ),
              stripe_state_event_id = coalesce($5, stripe_state_event_id),
              updated_at = now()
          where stripe_subscription_id = $1
            and (
              $4::timestamptz is null
              or stripe_state_event_created_at is null
              or $4::timestamptz > stripe_state_event_created_at
              or (
                $4::timestamptz = stripe_state_event_created_at
                and $5 > coalesce(stripe_state_event_id, '')
              )
            )
          returning id
        `,
        [
          options.subscriptionId,
          options.status,
          `legacy_${options.reason}`.slice(0, 160),
          options.eventWatermark?.createdAtIso || null,
          options.eventWatermark?.eventId || null,
        ],
      );
      const licenseId = updated.rows[0]?.id;
      if (licenseId) {
        await revokeLicenseCredentials(client, licenseId);
        await client.query("commit");
        return {
          fulfilled: true as const,
          applied: true as const,
          eligible: false as const,
          reason: options.reason,
        };
      }

      const existing = await client.query(
        `select id from public.sidestream_licenses where stripe_subscription_id = $1 limit 1`,
        [options.subscriptionId],
      );
      await client.query("commit");
      return existing.rows[0]
        ? { fulfilled: true as const, applied: false as const, reason: "stale_event" }
        : { fulfilled: false as const, reason: options.reason };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function persistDeniedLegacySubscriptionInventory(options: {
  accountId: string;
  customerId: string;
  subscriptionId: string;
  status: string;
  reason: string;
  eventWatermark: ReturnType<typeof normalizeStripeEventWatermark>;
}) {
  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `legacy_subscription:${options.subscriptionId}`,
      ]);
      const lifecycleSchema = await client.query<{ present: boolean }>(
        `
          select exists (
            select 1
            from information_schema.columns
            where table_schema = 'public'
              and table_name = 'sidestream_licenses'
              and column_name = 'entitlement_status'
          ) as present
        `,
      );
      if (!lifecycleSchema.rows[0]?.present) {
        const result = await persistDeniedLegacySubscriptionBeforeLifecycleMigration(
          client,
          options,
        );
        await client.query("commit");
        return result;
      }
      const result = await client.query<{ id: string }>(
        `
          update public.sidestream_licenses
          set status = $2,
              entitlement_status = 'revoked',
              status_reason = $3,
              revoked_at = coalesce(revoked_at, now()),
              reconciled_at = now(),
              legacy_subscription_eligible = false,
              legacy_subscription_audited_at = now(),
              legacy_subscription_quarantined_at = coalesce(
                legacy_subscription_quarantined_at,
                now()
              ),
              features = features ||
                '{"unlimited_downloads": false, "customer_portal": true}'::jsonb,
              stripe_state_event_created_at = coalesce(
                $4::timestamptz,
                stripe_state_event_created_at
              ),
              stripe_state_event_id = coalesce($5, stripe_state_event_id),
              updated_at = now()
          where stripe_subscription_id = $1
            and (
              $4::timestamptz is null
              or stripe_state_event_created_at is null
              or $4::timestamptz > stripe_state_event_created_at
              or (
                $4::timestamptz = stripe_state_event_created_at
                and $5 > coalesce(stripe_state_event_id, '')
              )
            )
          returning id
        `,
        [
          options.subscriptionId,
          options.status,
          `legacy_${options.reason}`.slice(0, 160),
          options.eventWatermark?.createdAtIso || null,
          options.eventWatermark?.eventId || null,
        ],
      );
      const licenseId = result.rows[0]?.id;
      if (!licenseId) {
        const existing = await client.query(
          `select id from public.sidestream_licenses where stripe_subscription_id = $1 limit 1`,
          [options.subscriptionId],
        );
        await client.query("commit");
        return existing.rows[0]
          ? { fulfilled: true as const, applied: false as const, reason: "stale_event" }
          : { fulfilled: false as const, reason: options.reason };
      }
      await revokeLicenseCredentials(client, licenseId);
      await client.query("commit");
      return { fulfilled: true as const, applied: true as const };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function persistDeniedLegacySubscriptionBeforeLifecycleMigration(
  client: PoolClient,
  options: {
    accountId: string;
    customerId: string;
    subscriptionId: string;
    status: string;
    reason: string;
    eventWatermark: ReturnType<typeof normalizeStripeEventWatermark>;
  },
) {
  const result = await client.query<{ id: string }>(
    `
      insert into public.sidestream_licenses (
        account_id, stripe_customer_id, stripe_subscription_id,
        plan_key, status, cancel_at_period_end, features,
        stripe_state_event_created_at, stripe_state_event_id,
        created_at, updated_at
      )
      values (
        $1, $2, $3, 'legacy_unverified', $4, false,
        '{"unlimited_downloads": false, "customer_portal": true}'::jsonb,
        $5::timestamptz, $6, now(), now()
      )
      on conflict (stripe_subscription_id) do update set
        status = excluded.status,
        plan_key = 'legacy_unverified',
        features = sidestream_licenses.features ||
          '{"unlimited_downloads": false, "customer_portal": true}'::jsonb,
        stripe_state_event_created_at = coalesce(
          excluded.stripe_state_event_created_at,
          sidestream_licenses.stripe_state_event_created_at
        ),
        stripe_state_event_id = coalesce(
          excluded.stripe_state_event_id,
          sidestream_licenses.stripe_state_event_id
        ),
        updated_at = now()
      where excluded.stripe_state_event_created_at is null
        or sidestream_licenses.stripe_state_event_created_at is null
        or excluded.stripe_state_event_created_at > sidestream_licenses.stripe_state_event_created_at
        or (
          excluded.stripe_state_event_created_at = sidestream_licenses.stripe_state_event_created_at
          and excluded.stripe_state_event_id > coalesce(sidestream_licenses.stripe_state_event_id, '')
        )
      returning id
    `,
    [
      options.accountId,
      options.customerId,
      options.subscriptionId,
      options.status,
      options.eventWatermark?.createdAtIso || null,
      options.eventWatermark?.eventId || null,
    ],
  );
  const licenseId = result.rows[0]?.id;
  if (!licenseId) {
    return { fulfilled: true as const, applied: false as const, reason: "stale_event" };
  }
  await client.query(
    `
      update public.sidestream_license_tokens
      set revoked_at = coalesce(revoked_at, now()), updated_at = now()
      where license_id = $1
    `,
    [licenseId],
  );
  return { fulfilled: true as const, applied: true as const };
}

async function revokeLicenseCredentials(runner: Pool | PoolClient, licenseId: string) {
  await runner.query(
    `
      update public.sidestream_license_tokens
      set revoked_at = coalesce(revoked_at, now()),
          refresh_token_hash = null,
          refresh_expires_at = null,
          previous_refresh_token_hash = null,
          previous_refresh_valid_until = null,
          refresh_rotated_at = null,
          updated_at = now()
      where license_id = $1
    `,
    [licenseId],
  );
}

type UpgradePricingSubscriptionEventType =
  | "checkout.session.completed"
  | "customer.subscription.created"
  | "customer.subscription.updated"
  | "customer.subscription.deleted"
  | "invoice.paid"
  | "invoice.payment_failed";

type UpgradePricingSubscriptionContextRow = CheckoutIntentRow & {
  assignment_version: number | null;
  assignment_experiment_id: string | null;
  assignment_account_id: string | null;
  assignment_variant: string | null;
  assignment_billing_model: string | null;
  assignment_bucket: number | null;
  assignment_rollout_basis_points: number | null;
  assignment_assigned_at: Date | string | null;
  account_stripe_customer_id: string | null;
  activation_id: string | null;
  activation_account_id: string | null;
  activation_license_id: string | null;
  activation_key_value: string | null;
  activation_checkout_session_id: string | null;
  activation_checkout_price_id: string | null;
  activation_checkout_product_id: string | null;
  activation_checkout_attached_at: Date | string | null;
  activation_checkout_expires_at: Date | string | null;
  activation_checkout_claim_grace_until: Date | string | null;
};

export async function reconcileUpgradePricingSubscription(
  subscriptionPayload: unknown,
  stripeEvent: { eventId: string; created: number },
  options: {
    eventType: UpgradePricingSubscriptionEventType;
    invoicePayload?: unknown;
    checkoutSession?: Stripe.Checkout.Session;
    expectedActivationKey?: string;
  },
) {
  const eventWatermark = normalizeStripeEventWatermark(stripeEvent);
  const subscriptionId = normalizeStripeId(
    (subscriptionPayload as { id?: unknown } | null)?.id,
  );
  if (!subscriptionId) {
    return { fulfilled: false as const, reason: "missing_subscription_identity" };
  }
  const subscription = await getStripe().subscriptions.retrieve(
    subscriptionId,
    { expand: ["items.data.price", "latest_invoice"] },
    getStripeRequestOptions(),
  );
  if (subscription.id !== subscriptionId) {
    return { fulfilled: false as const, reason: "subscription_identity_mismatch" };
  }
  const intentId = cleanString(
    subscription.metadata?.sidestream_checkout_intent_id,
    80,
  );
  if (!intentId) {
    return { fulfilled: false as const, reason: "not_upgrade_pricing_subscription" };
  }

  const context = await query<UpgradePricingSubscriptionContextRow>(
    `
      select ci.*,
        assignment.assignment_version,
        assignment.experiment_id as assignment_experiment_id,
        assignment.account_id as assignment_account_id,
        assignment.variant as assignment_variant,
        assignment.billing_model as assignment_billing_model,
        assignment.assignment_bucket,
        assignment.rollout_basis_points as assignment_rollout_basis_points,
        assignment.assigned_at as assignment_assigned_at,
        account.stripe_customer_id as account_stripe_customer_id,
        activation.id as activation_id,
        activation.account_id as activation_account_id,
        activation.license_id as activation_license_id,
        activation.activation_key as activation_key_value,
        activation.stripe_checkout_session_id as activation_checkout_session_id,
        activation.stripe_checkout_price_id as activation_checkout_price_id,
        activation.stripe_checkout_product_id as activation_checkout_product_id,
        activation.checkout_attached_at as activation_checkout_attached_at,
        activation.stripe_checkout_expires_at as activation_checkout_expires_at,
        activation.checkout_claim_grace_until as activation_checkout_claim_grace_until
      from public.sidestream_checkout_intents ci
      join public.sidestream_accounts account on account.id = ci.account_id
      join public.sidestream_acquisitions acquisition on acquisition.id = ci.acquisition_id
      left join public.sidestream_upgrade_pricing_assignments assignment
        on assignment.id = ci.upgrade_pricing_assignment_id
      left join public.sidestream_activation_sessions activation
        on activation.id = ci.activation_session_id
      where ci.id = $1
      limit 1
    `,
    [intentId],
  );
  const row = context.rows[0];
  const snapshot = row ? readUpgradePricingIntentSnapshot(row) : null;
  if (
    !row ||
    !snapshot ||
    ![UPGRADE_PRICING_MONTHLY_VARIANT, UPGRADE_PRICING_ANNUAL_VARIANT]
      .includes(snapshot.variant) ||
    snapshot.billingModel !== "subscription"
  ) {
    return { fulfilled: false as const, reason: "not_upgrade_pricing_subscription" };
  }
  const offer = readCheckoutOfferSnapshot(row);
  if (
    !offer ||
    offer.country !== snapshot.country ||
    offer.currency !== snapshot.currency ||
    offer.amountMinor !== snapshot.amountMinor ||
    offer.priceId !== snapshot.priceId ||
    offer.productId !== snapshot.productId ||
    row.account_id !== snapshot.accountId ||
    row.acquisition_id !== snapshot.acquisitionId ||
    row.stripe_price_id !== snapshot.priceId ||
    row.stripe_product_id !== snapshot.productId ||
    !row.stripe_checkout_session_id ||
    !["open", "completed"].includes(row.state)
  ) {
    return { fulfilled: false as const, reason: "upgrade_subscription_intent_mismatch" };
  }
  if (
    !snapshot.assignmentId ||
    row.assignment_version !== snapshot.snapshotVersion ||
    row.assignment_experiment_id !== snapshot.experimentId ||
    row.assignment_account_id !== snapshot.accountId ||
    row.assignment_variant !== snapshot.variant ||
    row.assignment_billing_model !== snapshot.billingModel ||
    Number(row.assignment_bucket) !== snapshot.assignmentBucket ||
    Number(row.assignment_rollout_basis_points) !== snapshot.rolloutBasisPoints ||
    toIsoString(row.assignment_assigned_at) !== snapshot.assignedAt
  ) {
    return { fulfilled: false as const, reason: "upgrade_subscription_assignment_mismatch" };
  }
  assertCheckoutAcquisitionIntact(
    await requireCanonicalAcquisition(snapshot.acquisitionId),
  );

  const checkoutSession = options.checkoutSession ||
    await getStripe().checkout.sessions.retrieve(
      row.stripe_checkout_session_id,
      { expand: ["line_items.data.price.product"] },
      getStripeRequestOptions(),
    );
  const canonicalSubscriptionId = normalizeStripeId(checkoutSession.subscription);
  const customerId = normalizeStripeId(checkoutSession.customer);
  const initialInvoiceId = normalizeStripeId(checkoutSession.invoice);
  if (
    checkoutSession.id !== row.stripe_checkout_session_id ||
    canonicalSubscriptionId !== subscriptionId ||
    !customerId ||
    !initialInvoiceId ||
    row.stripe_customer_id !== customerId ||
    row.account_stripe_customer_id !== customerId
  ) {
    return { fulfilled: false as const, reason: "upgrade_subscription_owner_mismatch" };
  }

  const activationKey = cleanString(row.activation_key_value, 160);
  if (snapshot.activationSessionId) {
    if (
      row.activation_id !== snapshot.activationSessionId ||
      !activationKey ||
      row.activation_checkout_session_id !== checkoutSession.id ||
      row.activation_checkout_price_id !== snapshot.priceId ||
      row.activation_checkout_product_id !== snapshot.productId ||
      !row.activation_checkout_attached_at ||
      !row.activation_checkout_expires_at ||
      !row.activation_checkout_claim_grace_until ||
      new Date(row.activation_checkout_attached_at).getTime() >
        new Date(row.activation_checkout_expires_at).getTime() ||
      new Date(row.activation_checkout_expires_at).getTime() >
        new Date(row.activation_checkout_claim_grace_until).getTime() ||
      !canBindActivationAccount(row.activation_account_id, snapshot.accountId)
    ) {
      return { fulfilled: false as const, reason: "upgrade_subscription_activation_mismatch" };
    }
  } else if (row.activation_id || activationKey) {
    return { fulfilled: false as const, reason: "upgrade_subscription_activation_mismatch" };
  }
  if (
    options.expectedActivationKey &&
    options.expectedActivationKey !== activationKey
  ) {
    return { fulfilled: false as const, reason: "activation_mismatch" };
  }

  const eventInvoiceId = normalizeStripeId(
    (options.invoicePayload as { id?: unknown } | null)?.id,
  );
  const invoiceId = eventInvoiceId || (
    options.eventType === "checkout.session.completed"
      ? initialInvoiceId
      : normalizeStripeId(subscription.latest_invoice)
  );
  if (!invoiceId) {
    return { fulfilled: false as const, reason: "missing_subscription_invoice" };
  }
  const itemPriceId = normalizeStripeId(subscription.items?.data?.[0]?.price);
  if (!itemPriceId) {
    return { fulfilled: false as const, reason: "subscription_item_mismatch" };
  }
  const [customer, invoice, price] = await Promise.all([
    getStripe().customers.retrieve(customerId, {}, getStripeRequestOptions()),
    getStripe().invoices.retrieve(
      invoiceId,
      { expand: ["lines.data", "payments.data.payment.payment_intent"] },
      getStripeRequestOptions(),
    ),
    getStripe().prices.retrieve(itemPriceId, {}, getStripeRequestOptions()),
  ]);
  const productId = normalizeStripeId(price.product);
  if (!productId) {
    return { fulfilled: false as const, reason: "subscription_product_mismatch" };
  }
  const product = await getStripe().products.retrieve(
    productId,
    {},
    getStripeRequestOptions(),
  );
  const metadata = upgradePricingSubscriptionMetadata(snapshot, offer, activationKey);
  const verification = verifyUpgradePricingSubscriptionTruth({
    session: checkoutSession as unknown as Record<string, any>,
    subscription: subscription as unknown as Record<string, any>,
    customer: customer as unknown as Record<string, any>,
    invoice: invoice as unknown as Record<string, any>,
    price: price as unknown as Record<string, any>,
    product: product as unknown as Record<string, any>,
    expected: {
      sessionId: checkoutSession.id,
      subscriptionId,
      customerId,
      invoiceId,
      initialInvoiceId,
      priceId: snapshot.priceId,
      productId: snapshot.productId,
      currency: snapshot.currency,
      amountMinor: snapshot.amountMinor,
      interval: snapshot.variant === UPGRADE_PRICING_ANNUAL_VARIANT
        ? UPGRADE_PRICING_ANNUAL_INTERVAL
        : UPGRADE_PRICING_MONTHLY_INTERVAL,
      livemode: isLiveStripeMode(),
      clientReferenceId: activationKey || snapshot.accountId,
      metadata,
      invoiceEventType: options.eventType,
    },
  });
  if (!verification.ok) {
    return { fulfilled: false as const, reason: verification.reason };
  }

  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `upgrade_subscription:${subscriptionId}`,
      ]);
      await lockPaidEligibility(client, snapshot.accountId);
      const lockedIntent = await client.query<{
        acquisition_id: string | null;
        account_id: string | null;
        stripe_checkout_session_id: string | null;
      }>(
        `
          select acquisition_id, account_id, stripe_checkout_session_id
          from public.sidestream_checkout_intents
          where id = $1
          for update
        `,
        [snapshot.intentId],
      );
      const locked = lockedIntent.rows[0];
      if (
        locked?.acquisition_id !== snapshot.acquisitionId ||
        locked?.account_id !== snapshot.accountId ||
        locked?.stripe_checkout_session_id !== checkoutSession.id
      ) {
        await client.query("rollback");
        return { fulfilled: false as const, reason: "upgrade_subscription_intent_mismatch" };
      }
      assertCheckoutAcquisitionIntact(await requireCanonicalAcquisition(
        snapshot.acquisitionId,
        acquisitionTransactionDependencies(client),
      ));

      const selected = await client.query<{
        id: string;
        account_id: string;
        stripe_customer_id: string;
        stripe_subscription_id: string | null;
        stripe_checkout_session_id: string | null;
        stripe_price_id: string | null;
        stripe_product_id: string | null;
        entitlement_status: string;
        status_reason: string;
        stripe_state_event_created_at: Date | string | null;
        stripe_state_event_id: string | null;
      }>(
        `
          select id, account_id, stripe_customer_id, stripe_subscription_id,
            stripe_checkout_session_id, stripe_price_id, stripe_product_id,
            entitlement_status, status_reason, stripe_state_event_created_at,
            stripe_state_event_id
          from public.sidestream_licenses
          where stripe_subscription_id = $1 or stripe_checkout_session_id = $2
          order by created_at asc
          limit 2
          for update
        `,
        [subscriptionId, checkoutSession.id],
      );
      if (selected.rows.length > 1) {
        await client.query("rollback");
        return { fulfilled: false as const, reason: "ambiguous_subscription_license" };
      }
      const existing = selected.rows[0] || null;
      if (
        existing &&
        (
          existing.account_id !== snapshot.accountId ||
          existing.stripe_customer_id !== customerId ||
          (existing.stripe_subscription_id && existing.stripe_subscription_id !== subscriptionId) ||
          (existing.stripe_checkout_session_id && existing.stripe_checkout_session_id !== checkoutSession.id) ||
          (existing.stripe_price_id && existing.stripe_price_id !== snapshot.priceId) ||
          (existing.stripe_product_id && existing.stripe_product_id !== snapshot.productId)
        )
      ) {
        await client.query("rollback");
        return { fulfilled: false as const, reason: "subscription_license_owner_mismatch" };
      }

      const transition = planUpgradePricingSubscriptionTransition({
        status: verification.status,
        currentPeriodEndMs: verification.currentPeriodEndMs,
        cancelAtPeriodEnd: verification.cancelAtPeriodEnd,
        invoicePaid: verification.invoicePaid,
        eventType: options.eventType,
        eventCreatedAtMs: eventWatermark!.createdAtMs,
        storedEntitlementStatus: existing?.entitlement_status,
        storedStatusReason: existing?.status_reason,
      });
      const currentWatermark = existing?.stripe_state_event_created_at
        ? {
            createdAtMs: new Date(existing.stripe_state_event_created_at).getTime(),
            eventId: existing.stripe_state_event_id || "",
          }
        : null;
      const applyLifecycle = !existing || shouldApplyStripeEventWatermark(
        currentWatermark,
        {
          createdAtMs: eventWatermark!.createdAtMs,
          eventId: eventWatermark!.eventId,
        },
      );
      const features = JSON.stringify({
        unlimited_downloads: transition.entitlementStatus === "active",
        customer_portal: true,
        upgrade_pricing_v1:
          snapshot.experimentId === UPGRADE_PRICING_LEGACY_EXPERIMENT_ID,
        upgrade_pricing_v2:
          snapshot.experimentId === UPGRADE_PRICING_EXPERIMENT_ID,
        upgrade_pricing_experiment_id: snapshot.experimentId,
        upgrade_pricing_variant: snapshot.variant,
        subscription: true,
      });
      let licenseId = existing?.id || "";
      let resultingEntitlement = existing?.entitlement_status || transition.entitlementStatus;
      if (!existing) {
        const inserted = await client.query<{ id: string }>(
          `
            insert into public.sidestream_licenses (
              account_id, stripe_customer_id, stripe_subscription_id,
              stripe_checkout_session_id, stripe_price_id, stripe_product_id,
              plan_key, status, current_period_end, cancel_at_period_end,
              grace_until, features, entitlement_status, status_reason,
              revoked_at, suspended_at, reconciled_at,
              legacy_subscription_eligible, legacy_subscription_audited_at,
              legacy_subscription_quarantined_at,
              stripe_state_event_created_at, stripe_state_event_id,
              created_at, updated_at
            ) values (
              $1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10,
              $11::timestamptz, $12::jsonb, $13, $14,
              case when $13 = 'revoked' then now() else null end,
              case when $13 = 'suspended' then now() else null end,
              now(), false, null, null, $15::timestamptz, $16, now(), now()
            )
            returning id
          `,
          [
            snapshot.accountId,
            customerId,
            subscriptionId,
            checkoutSession.id,
            snapshot.priceId,
            snapshot.productId,
            SIDESTREAM_PRO_PLAN_KEY,
            verification.status,
            new Date(verification.currentPeriodEndMs).toISOString(),
            verification.cancelAtPeriodEnd,
            transition.graceUntilMs
              ? new Date(transition.graceUntilMs).toISOString()
              : null,
            features,
            transition.entitlementStatus,
            transition.statusReason,
            eventWatermark!.createdAtIso,
            eventWatermark!.eventId,
          ],
        );
        licenseId = inserted.rows[0]?.id || "";
      } else if (applyLifecycle) {
        const updated = await client.query<{ id: string; entitlement_status: string }>(
          `
            update public.sidestream_licenses
            set status = $2,
                current_period_end = $3::timestamptz,
                cancel_at_period_end = $4,
                grace_until = $5::timestamptz,
                features = features || $6::jsonb,
                entitlement_status = $7,
                status_reason = $8,
                revoked_at = case
                  when $7 = 'revoked' then coalesce(revoked_at, now())
                  else revoked_at
                end,
                suspended_at = case
                  when $7 = 'suspended' then coalesce(suspended_at, now())
                  else suspended_at
                end,
                reconciled_at = now(),
                legacy_subscription_eligible = false,
                stripe_state_event_created_at = $9::timestamptz,
                stripe_state_event_id = $10,
                updated_at = now()
            where id = $1
            returning id, entitlement_status
          `,
          [
            existing.id,
            verification.status,
            new Date(verification.currentPeriodEndMs).toISOString(),
            verification.cancelAtPeriodEnd,
            transition.graceUntilMs
              ? new Date(transition.graceUntilMs).toISOString()
              : null,
            features,
            transition.entitlementStatus,
            transition.statusReason,
            eventWatermark!.createdAtIso,
            eventWatermark!.eventId,
          ],
        );
        resultingEntitlement = updated.rows[0]?.entitlement_status || transition.entitlementStatus;
      }
      if (!licenseId) {
        await client.query("rollback");
        return { fulfilled: false as const, reason: "license_write_failed" };
      }
      if (applyLifecycle && transition.revokeCredentials) {
        await revokeLicenseCredentials(client, licenseId);
      }

      let activationBound = Boolean(
        snapshot.activationSessionId &&
        row.activation_license_id === licenseId &&
        row.activation_account_id === snapshot.accountId,
      );
      if (
        snapshot.activationSessionId &&
        activationKey &&
        resultingEntitlement === "active"
      ) {
        const bound = await client.query<{ id: string }>(
          `
            update public.sidestream_activation_sessions
            set account_id = $3,
                license_id = $4,
                status = case when status = 'linked' then status else 'paid' end,
                updated_at = now()
            where id = $1
              and activation_key = $2
              and stripe_checkout_session_id = $5
              and checkout_claim_grace_until >= now()
              and checkout_attached_at <= stripe_checkout_expires_at
              and (account_id is null or account_id = $3)
              and (license_id is null or license_id = $4)
            returning id
          `,
          [
            snapshot.activationSessionId,
            activationKey,
            snapshot.accountId,
            licenseId,
            checkoutSession.id,
          ],
        );
        activationBound = Boolean(bound.rows[0]) || activationBound;
      }

      await client.query(
        `
          update public.sidestream_checkout_intents
          set state = 'completed', stripe_customer_id = $2, updated_at = now()
          where id = $1 and stripe_checkout_session_id = $3
        `,
        [snapshot.intentId, customerId, checkoutSession.id],
      );
      if (invoiceId === initialInvoiceId) {
        const dependencies = acquisitionTransactionDependencies(client);
        await addTrustedDeliveryEvidence({
          acquisitionId: snapshot.acquisitionId,
          evidence: "stripe_checkout_session",
        }, dependencies);
        const completedStage = await recordAcquisitionStage({
          acquisitionId: snapshot.acquisitionId,
          stage: "checkout_completed",
          stableServerReference: `checkout-session:${checkoutSession.id}`,
          occurredAt: new Date(stripeEvent.created * 1_000),
        }, dependencies);
        const settledStage = await recordAcquisitionStage({
          acquisitionId: snapshot.acquisitionId,
          stage: "payment_settled",
          stableServerReference: `stripe-invoice:${invoiceId}`,
          occurredAt: new Date(stripeEvent.created * 1_000),
        }, dependencies);
        if (completedStage.ownerConflict || settledStage.ownerConflict) {
          await client.query("rollback");
          return { fulfilled: false as const, reason: "acquisition_stage_conflict" };
        }
      }
      await client.query("commit");
      return {
        fulfilled: true as const,
        applied: applyLifecycle,
        activationBound,
        entitlementStatus: resultingEntitlement,
        experimentSubscription: true as const,
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

function upgradePricingSubscriptionMetadata(
  snapshot: UpgradePricingIntentSnapshot,
  offer: CheckoutOfferSnapshot,
  activationKey: string,
) {
  return {
    sidestream_acquisition_id: snapshot.acquisitionId,
    sidestream_plan: SIDESTREAM_PRO_PLAN_KEY,
    sidestream_price_id: snapshot.priceId,
    sidestream_product_id: snapshot.productId,
    sidestream_checkout_intent_id: snapshot.intentId,
    sidestream_offer_id: offer.offerId,
    sidestream_offer_country: offer.country,
    sidestream_offer_currency: offer.currency,
    sidestream_offer_amount_minor: String(offer.amountMinor),
    sidestream_account_id: snapshot.accountId,
    sidestream_activation_key: activationKey || null,
    sidestream_upgrade_snapshot_version: String(snapshot.snapshotVersion),
    sidestream_upgrade_experiment_id: snapshot.experimentId,
    sidestream_upgrade_decision_reason: snapshot.decisionReason,
    sidestream_upgrade_assignment_id: snapshot.assignmentId,
    sidestream_upgrade_assignment_bucket:
      snapshot.assignmentBucket === null ? null : String(snapshot.assignmentBucket),
    sidestream_upgrade_rollout_bps:
      String(snapshot.rolloutBasisPoints),
    sidestream_upgrade_assigned_at: snapshot.assignedAt,
    sidestream_upgrade_variant: snapshot.variant,
    sidestream_upgrade_billing_model: snapshot.billingModel,
    sidestream_upgrade_country: snapshot.country,
    sidestream_upgrade_currency: snapshot.currency,
    sidestream_upgrade_amount_minor: String(snapshot.amountMinor),
    sidestream_upgrade_product_id: snapshot.productId,
    sidestream_upgrade_price_id: snapshot.priceId,
    sidestream_upgrade_account_id: snapshot.accountId,
    sidestream_upgrade_acquisition_id: snapshot.acquisitionId,
    sidestream_upgrade_intent_id: snapshot.intentId,
    sidestream_upgrade_activation_id:
      snapshot.activationSessionId,
  } as const;
}

export async function upsertLicenseFromCheckoutSession(
  sessionPayload: unknown,
  stripeEvent?: { eventId: string; created: number },
) {
  const checkoutSessionId = normalizeStripeId(
    (sessionPayload as { id?: unknown } | null)?.id,
  );
  if (!checkoutSessionId) return { fulfilled: false as const, reason: "missing_session_id" };
  return fulfillCheckoutSession(checkoutSessionId, "", stripeEvent);
}

export async function fulfillCheckoutSession(
  checkoutSessionId: string,
  expectedActivationKey = "",
  stripeEvent?: { eventId: string; created: number },
) {
  const intentCandidates = await query<{
    id: string;
    acquisition_id: string | null;
    account_id: string | null;
    activation_session_id: string | null;
    offer_id: string | null;
    offer_country: string | null;
    offer_currency: string | null;
    offer_amount_minor: number | null;
    offer_stripe_product_id: string | null;
    offer_stripe_price_id: string | null;
    upgrade_pricing_snapshot_version: number | null;
    upgrade_pricing_variant: string | null;
    upgrade_pricing_billing_model: string | null;
  }>(
    `
      select id, acquisition_id, account_id, activation_session_id, offer_id, offer_country,
        offer_currency, offer_amount_minor, offer_stripe_product_id,
        offer_stripe_price_id, upgrade_pricing_snapshot_version,
        upgrade_pricing_variant, upgrade_pricing_billing_model
      from public.sidestream_checkout_intents
      where stripe_checkout_session_id = $1
      order by updated_at desc, id desc
    `,
    [checkoutSessionId],
  );
  const checkoutSession = await getStripe().checkout.sessions.retrieve(
    checkoutSessionId,
    { expand: ["line_items.data.price.product"] },
    getStripeRequestOptions(),
  );
  const activationKey = cleanString(
    checkoutSession.metadata?.sidestream_activation_key,
    160,
  );
  if (expectedActivationKey && activationKey !== expectedActivationKey) {
    return { fulfilled: false as const, reason: "activation_mismatch" };
  }
  const paidAcquisitionCheckout =
    cleanString(
      checkoutSession.metadata?.sidestream_paid_acquisition,
      120,
    ) === PAID_ACQUISITION_EXPERIMENT_ID;

  const checkoutIntentId = cleanString(
    checkoutSession.metadata?.sidestream_checkout_intent_id,
    80,
  );
  const checkoutIntent = intentCandidates.rows.find(
    (candidate) => candidate.id === checkoutIntentId,
  );

  const subscriptionId = normalizeStripeId(checkoutSession.subscription);
  if (subscriptionId) {
    if (
      checkoutIntent &&
      [1, 2].includes(checkoutIntent.upgrade_pricing_snapshot_version || 0) &&
      [UPGRADE_PRICING_MONTHLY_VARIANT, UPGRADE_PRICING_ANNUAL_VARIANT]
        .includes(checkoutIntent.upgrade_pricing_variant as UpgradePricingVariant) &&
      checkoutIntent.upgrade_pricing_billing_model === "subscription"
    ) {
      const created = Number(checkoutSession.created);
      if (!stripeEvent && (!Number.isSafeInteger(created) || created < 0)) {
        return { fulfilled: false as const, reason: "invalid_checkout_created_at" };
      }
      const experimentResult = await reconcileUpgradePricingSubscription(
        { id: subscriptionId },
        stripeEvent || {
          eventId: `checkout_session_${checkoutSession.id}`,
          created,
        },
        {
          eventType: "checkout.session.completed",
          checkoutSession,
          expectedActivationKey,
        },
      );
      return experimentResult.fulfilled
        ? experimentResult
        : { ...experimentResult, experimentSubscription: true as const };
    }
    // Historical subscription reconciliation remains a separate allowlisted
    // compatibility path. Upgrade-pricing subscriptions never enter it.
    if (
      checkoutSession.status !== "complete" ||
      !isSidestreamPaidPlanKey(cleanString(checkoutSession.metadata?.sidestream_plan, 120))
    ) {
      return { fulfilled: false as const, reason: "invalid_subscription_checkout" };
    }
    const subscription = await getStripe().subscriptions.retrieve(
      subscriptionId,
      {},
      getStripeRequestOptions(),
    );
    const subscriptionResult = await upsertLicenseFromSubscription(
      subscription,
      undefined,
      stripeEvent,
    );
    if (!subscriptionResult.fulfilled) return subscriptionResult;
    return { fulfilled: true as const, activationBound: false };
  }
  if (!checkoutIntent) {
    return { fulfilled: false as const, reason: "checkout_intent_mismatch" };
  }
  const acquisitionId = cleanString(checkoutIntent.acquisition_id, 36);
  if (
    !ACQUISITION_ID.test(acquisitionId) ||
    cleanString(checkoutSession.metadata?.sidestream_acquisition_id, 36) !== acquisitionId
  ) {
    return { fulfilled: false as const, reason: "acquisition_mismatch" };
  }
  const checkoutOffer = readCheckoutOfferSnapshot(checkoutIntent);
  if (!checkoutOffer) {
    return { fulfilled: false as const, reason: "offer_snapshot_missing" };
  }

  const expectedPriceId = checkoutOffer.priceId;
  const expectedProductId = checkoutOffer.productId;
  let activationId = "";

  if (activationKey) {
    const attachment = await query<{
      id: string;
      stripe_checkout_price_id: string;
      stripe_checkout_product_id: string;
    }>(
      `
        select id, stripe_checkout_price_id, stripe_checkout_product_id
        from public.sidestream_activation_sessions
        where activation_key = $1
          and stripe_checkout_session_id = $2
          and checkout_attached_at is not null
          and checkout_attached_at <= stripe_checkout_expires_at
          and stripe_checkout_expires_at <= checkout_claim_grace_until
        limit 1
      `,
      [activationKey, checkoutSessionId],
    );
    const row = attachment.rows[0];
    if (!row) return { fulfilled: false as const, reason: "unattached_session" };
    if (
      row.stripe_checkout_price_id !== checkoutOffer.priceId ||
      row.stripe_checkout_product_id !== checkoutOffer.productId
    ) {
      return {
        fulfilled: false as const,
        reason: "activation_offer_mismatch",
      };
    }
    activationId = row.id;
  }

  const customerId = normalizeStripeId(checkoutSession.customer);
  if (!customerId) return { fulfilled: false as const, reason: "missing_customer" };
  const canonicalPayment = await retrieveCanonicalCheckoutPayment(
    checkoutSession,
    customerId,
    acquisitionId,
  );
  if (!canonicalPayment.ok) {
    return { fulfilled: false as const, reason: canonicalPayment.reason };
  }
  const purchaseVerification = verifyApprovedCheckoutPurchase(
    checkoutSession,
    canonicalPayment.facts,
    {
      sessionId: checkoutSessionId,
      acquisitionId,
      activationKey: activationKey || undefined,
      intentId: checkoutIntent.id,
      accountId: checkoutIntent.account_id || "",
      offerId: checkoutOffer.offerId,
      country: checkoutOffer.country,
      currency: checkoutOffer.currency,
      amountMinor: checkoutOffer.amountMinor,
      priceId: checkoutOffer.priceId,
      productId: checkoutOffer.productId,
      paidPlanKeys: SIDESTREAM_PAID_PLAN_KEYS,
    },
  );
  if (!purchaseVerification.isApprovedPurchase) {
    return {
      fulfilled: false as const,
      reason: purchaseVerification.reason,
    };
  }

  let accountId = checkoutIntent.account_id || "";
  if (accountId) {
    const customerOwnerId = await findAccountIdByStripeCustomer(customerId);
    if (customerOwnerId && customerOwnerId !== accountId) {
      return { fulfilled: false as const, reason: "stripe_account_mismatch" };
    }
  } else {
    accountId = await findOrCreateAccountForStripeCustomer(customerId, {
      email:
        checkoutSession.customer_details?.email ||
        checkoutSession.customer_email,
      name: checkoutSession.customer_details?.name,
    });
  }
  if (!accountId) return { fulfilled: false as const, reason: "missing_account" };

  const fulfillment = await withPgClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `checkout_session:${checkoutSessionId}`,
      ]);
      await lockPaidEligibility(client, accountId);
      const lockedIntent = await client.query<{ acquisition_id: string | null }>(
        `
          select acquisition_id
          from public.sidestream_checkout_intents
          where id = $1 and stripe_checkout_session_id = $2
          for update
        `,
        [checkoutIntent.id, checkoutSessionId],
      );
      if (lockedIntent.rows[0]?.acquisition_id !== acquisitionId) {
        await client.query("rollback");
        return { fulfilled: false as const, reason: "acquisition_mismatch" };
      }
      assertCheckoutAcquisitionIntact(await requireCanonicalAcquisition(
        acquisitionId,
        acquisitionTransactionDependencies(client),
      ));

      let activationCanBind = false;
      if (activationKey && activationId) {
        const lockedActivation = await client.query<{
          account_id: string | null;
          stripe_checkout_price_id: string;
          stripe_checkout_product_id: string;
        }>(
          `
            select account_id, stripe_checkout_price_id, stripe_checkout_product_id
            from public.sidestream_activation_sessions
            where id = $1
              and activation_key = $2
              and stripe_checkout_session_id = $3
              and checkout_claim_grace_until >= now()
              and checkout_attached_at <= stripe_checkout_expires_at
            for update
          `,
          [activationId, activationKey, checkoutSessionId],
        );
        const locked = lockedActivation.rows[0];
        activationCanBind = Boolean(
          locked &&
          locked.stripe_checkout_price_id === expectedPriceId &&
          locked.stripe_checkout_product_id === expectedProductId &&
          canBindActivationAccount(locked.account_id, accountId),
        );
      }

      await client.query(
        `
          update public.sidestream_accounts
          set stripe_customer_id = $2, updated_at = now()
          where id = $1
        `,
        [accountId, customerId],
      );

      const licenseResult = await upsertLicenseFromOneTimeCheckoutSession({
        accountId,
        customerId,
        checkoutSessionId,
        paymentFacts: canonicalPayment.facts,
        noPaymentRequired: canonicalPayment.noPaymentRequired,
        currency: canonicalPayment.currency,
        eventWatermark: normalizeStripeEventWatermark(stripeEvent),
      }, client);
      if (!licenseResult.fulfilled) {
        await client.query("rollback");
        return licenseResult;
      }
      const licenseId = licenseResult.licenseId;

      let activationBound = false;
      if (
        activationKey &&
        activationId &&
        activationCanBind &&
        licenseResult.entitlementStatus === "active"
      ) {
        const bound = await client.query<{ id: string }>(
          `
            update public.sidestream_activation_sessions
            set account_id = $3,
                license_id = $4,
                status = case when status = 'linked' then status else 'paid' end,
                updated_at = now()
            where id = $1
              and activation_key = $2
              and stripe_checkout_session_id = $5
              and checkout_claim_grace_until >= now()
              and checkout_attached_at <= stripe_checkout_expires_at
              and (account_id is null or account_id = $3)
            returning id
          `,
          [activationId, activationKey, accountId, licenseId, checkoutSessionId],
        );
        activationBound = Boolean(bound.rows[0]);
      }

      await client.query(
        `
          update public.sidestream_checkout_intents
          set state = 'completed', stripe_customer_id = $2, updated_at = now()
          where stripe_checkout_session_id = $1
        `,
        [checkoutSessionId, customerId],
      );

      const stageOccurredAt = stripeEvent
        ? new Date(stripeEvent.created * 1_000)
        : new Date();
      const dependencies = acquisitionTransactionDependencies(client);
      await addTrustedDeliveryEvidence({
        acquisitionId,
        evidence: "stripe_checkout_session",
      }, dependencies);
      const completedStage = await recordAcquisitionStage({
        acquisitionId,
        stage: "checkout_completed",
        stableServerReference: `checkout-session:${checkoutSessionId}`,
        occurredAt: stageOccurredAt,
      }, dependencies);
      const settledStage = await recordAcquisitionStage({
        acquisitionId,
        stage: "payment_settled",
        stableServerReference: canonicalPayment.facts
          ? `payment-intent:${canonicalPayment.facts.paymentIntentId}`
          : `checkout-no-payment-required:${checkoutSessionId}`,
        occurredAt: stageOccurredAt,
      }, dependencies);
      if (completedStage.ownerConflict || settledStage.ownerConflict) {
        await client.query("rollback");
        return {
          fulfilled: false as const,
          reason: "acquisition_stage_conflict",
        };
      }

      await client.query("commit");
      return {
        fulfilled: true as const,
        activationBound,
        licenseId,
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
  if (!fulfillment.fulfilled) return fulfillment;
  let paidAcquisitionReceiptCookie = "";
  if (paidAcquisitionCheckout) {
    const paidCompletion = await completePaidAcquisitionCheckout({
      environment: requireMatchingLicenseEnvironment().namespace,
      verifiedCheckoutSessionRef: checkoutSessionId,
      canonicalPaymentRef:
        canonicalPayment.facts?.paymentIntentId || checkoutSessionId,
      verifiedCheckoutEmail:
        checkoutSession.customer_details?.email ||
        checkoutSession.customer_email ||
        "",
      verifiedProductRef: expectedProductId,
      verifiedPriceRef: expectedPriceId,
      verifiedQuantity: 1,
      verifiedOriginalAmountMinor: checkoutOffer.amountMinor,
      verifiedDiscountAmountMinor:
        checkoutSession.total_details?.amount_discount ?? 0,
      verifiedAmountMinor: canonicalPayment.facts?.amountPaid ?? 0,
      verifiedCurrency: checkoutOffer.currency,
      accountRef: accountId,
      entitlementRef: fulfillment.licenseId,
    });
    if (paidCompletion.matched) {
      paidAcquisitionReceiptCookie = paidCompletion.receiptCookie;
    }
  }
  return {
    fulfilled: true as const,
    activationBound: fulfillment.activationBound,
    paidAcquisition: paidAcquisitionCheckout,
    ...(paidAcquisitionReceiptCookie
      ? { paidAcquisitionReceiptCookie }
      : {}),
  };
}

async function retrieveCanonicalCheckoutPayment(
  checkoutSession: Stripe.Checkout.Session,
  customerId: string,
  acquisitionId: string,
) {
  const invoiceId = normalizeStripeId(checkoutSession.invoice);
  if (invoiceId) {
    const invoice = await getStripe().invoices.retrieve(
      invoiceId,
      {},
      getStripeRequestOptions(),
    );
    if (
      invoice.id !== invoiceId ||
      cleanString(invoice.metadata?.sidestream_acquisition_id, 36) !== acquisitionId
    ) {
      return { ok: false as const, reason: "invoice_acquisition_mismatch" };
    }
  }
  const paymentIntentId = normalizeStripeId(checkoutSession.payment_intent);
  const currency = cleanString(checkoutSession.currency, 3).toLowerCase();
  if (!paymentIntentId) {
    if (!isZeroTotalCheckoutWithoutPaymentIntent(checkoutSession)) {
      return { ok: false as const, reason: "missing_payment_intent" };
    }
    return {
      ok: true as const,
      facts: null,
      noPaymentRequired: true,
      currency,
    };
  }

  const paymentIntent = await getStripe().paymentIntents.retrieve(
    paymentIntentId,
    { expand: ["latest_charge"] },
    getStripeRequestOptions(),
  );
  if (paymentIntent.id !== paymentIntentId) {
    return { ok: false as const, reason: "payment_intent_mismatch" };
  }
  if (
    cleanString(paymentIntent.metadata?.sidestream_acquisition_id, 36) !== acquisitionId
  ) {
    return { ok: false as const, reason: "payment_intent_acquisition_mismatch" };
  }
  const chargeId = normalizeStripeId(paymentIntent.latest_charge);
  if (!chargeId) return { ok: false as const, reason: "missing_charge" };

  const canonical = await retrieveCanonicalPaymentFacts({
    chargeId,
    expectedPaymentIntentId: paymentIntentId,
    expectedCustomerId: customerId,
    paymentIntent,
  });
  if (!canonical.ok) return canonical;
  return {
    ok: true as const,
    facts: canonical.facts,
    noPaymentRequired: false,
    currency: canonical.facts.currency,
  };
}

async function retrieveCanonicalPaymentFacts(options: {
  chargeId: string;
  expectedPaymentIntentId?: string;
  expectedCustomerId?: string;
  paymentIntent?: Stripe.PaymentIntent;
  canonicalDispute?: Stripe.Dispute;
  forceDisputeLookup?: boolean;
}) {
  const charge = await getStripe().charges.retrieve(
    options.chargeId,
    { expand: ["payment_intent"] },
    getStripeRequestOptions(),
  );
  if (charge.id !== options.chargeId) {
    return { ok: false as const, reason: "charge_mismatch" };
  }
  const paymentIntentId = normalizeStripeId(charge.payment_intent);
  if (
    !paymentIntentId ||
    (options.expectedPaymentIntentId && paymentIntentId !== options.expectedPaymentIntentId)
  ) {
    return { ok: false as const, reason: "payment_intent_mismatch" };
  }
  const paymentIntent = options.paymentIntent ||
    await getStripe().paymentIntents.retrieve(
      paymentIntentId,
      { expand: ["latest_charge"] },
      getStripeRequestOptions(),
    );
  if (paymentIntent.id !== paymentIntentId) {
    return { ok: false as const, reason: "payment_intent_mismatch" };
  }
  const latestChargeId = normalizeStripeId(paymentIntent.latest_charge);
  if (latestChargeId && latestChargeId !== charge.id) {
    return { ok: false as const, reason: "latest_charge_mismatch" };
  }
  const chargeCustomerId = normalizeStripeId(charge.customer);
  const paymentIntentCustomerId = normalizeStripeId(paymentIntent.customer);
  if (
    !chargeCustomerId ||
    !paymentIntentCustomerId ||
    chargeCustomerId !== paymentIntentCustomerId ||
    (options.expectedCustomerId && chargeCustomerId !== options.expectedCustomerId)
  ) {
    return { ok: false as const, reason: "payment_customer_mismatch" };
  }

  const currency = cleanString(paymentIntent.currency, 3).toLowerCase();
  const chargeCurrency = cleanString(charge.currency, 3).toLowerCase();
  if (!/^[a-z]{3}$/.test(currency) || chargeCurrency !== currency) {
    return { ok: false as const, reason: "payment_currency_mismatch" };
  }
  if (
    !Number.isSafeInteger(paymentIntent.amount_received) ||
    paymentIntent.amount_received < 0 ||
    !Number.isSafeInteger(charge.amount_refunded) ||
    charge.amount_refunded < 0
  ) {
    return { ok: false as const, reason: "invalid_payment_amounts" };
  }

  let disputes: readonly Stripe.Dispute[] = options.canonicalDispute
    ? [options.canonicalDispute]
    : [];
  let disputesHaveMore = false;
  if (options.forceDisputeLookup || charge.disputed) {
    const listed = await getStripe().disputes.list(
      { charge: charge.id, limit: 100 },
      getStripeRequestOptions(),
    );
    disputes = mergeCanonicalDisputes(disputes, listed.data);
    disputesHaveMore = listed.has_more;
  }
  const disputeStatus = canonicalDisputeStatus(
    disputes,
    disputesHaveMore || Boolean(charge.disputed),
  );

  return {
    ok: true as const,
    facts: {
      paymentIntentId,
      chargeId: charge.id,
      customerId: chargeCustomerId,
      amountPaid: paymentIntent.amount_received,
      amountRefunded: charge.amount_refunded,
      currency,
      paymentProven: paymentIntent.status === "succeeded" && charge.paid === true,
      disputeStatus,
    } satisfies CanonicalOneTimePaymentFacts,
  };
}

function mergeCanonicalDisputes(
  first: readonly Stripe.Dispute[],
  second: readonly Stripe.Dispute[],
) {
  const disputes = new Map<string, Stripe.Dispute>();
  for (const dispute of [...first, ...second]) disputes.set(dispute.id, dispute);
  return [...disputes.values()];
}

function canonicalDisputeStatus(
  disputes: readonly Stripe.Dispute[],
  disputedWithoutFinalProof: boolean,
) {
  const statuses = disputes.map((dispute) => cleanString(dispute.status, 80).toLowerCase());
  if (statuses.includes("lost")) return "lost";
  const open = statuses.find((status) => status && status !== "won");
  if (open) return open;
  if (statuses.includes("won")) return "won";
  return disputedWithoutFinalProof ? "unknown" : "none";
}

export async function reconcileOneTimePaymentLifecycle(
  eventType: string,
  eventPayload: unknown,
  stripeEvent: { eventId: string; created: number },
) {
  const payload = eventPayload as Record<string, any>;
  const eventWatermark = normalizeStripeEventWatermark(stripeEvent);
  let chargeId = "";
  let canonicalDispute: Stripe.Dispute | undefined;
  if (eventType.startsWith("charge.dispute.")) {
    const disputeId = normalizeStripeId(payload.id);
    if (!disputeId) {
      return { fulfilled: false as const, reason: "missing_dispute_id" };
    }
    canonicalDispute = await getStripe().disputes.retrieve(
      disputeId,
      {},
      getStripeRequestOptions(),
    );
    if (canonicalDispute.id !== disputeId) {
      return { fulfilled: false as const, reason: "dispute_identity_mismatch" };
    }
    chargeId = normalizeStripeId(canonicalDispute.charge);
    const payloadChargeId = normalizeStripeId(payload.charge);
    if (payloadChargeId && payloadChargeId !== chargeId) {
      return { fulfilled: false as const, reason: "event_charge_mismatch" };
    }
  } else if (eventType.startsWith("refund.")) {
    if (!normalizeStripeId(payload.id)) {
      return { fulfilled: false as const, reason: "missing_refund_id" };
    }
    chargeId = normalizeStripeId(payload.charge);
  } else if (eventType === "charge.refunded" || eventType === "charge.updated") {
    chargeId = normalizeStripeId(payload.id);
  } else {
    return { fulfilled: false as const, reason: "unsupported_lifecycle_event" };
  }
  if (!chargeId) return { fulfilled: false as const, reason: "missing_charge_id" };

  const expectedPaymentIntentId = normalizeStripeId(payload.payment_intent);
  const canonical = await retrieveCanonicalPaymentFacts({
    chargeId,
    expectedPaymentIntentId: expectedPaymentIntentId || undefined,
    canonicalDispute,
    forceDisputeLookup: eventType.startsWith("charge.dispute."),
  });
  if (!canonical.ok) {
    return { fulfilled: false as const, reason: canonical.reason };
  }

  const reconciliation = await withPgClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `one_time_payment:${canonical.facts.paymentIntentId}`,
      ]);
      const selected = await client.query<{
        account_id: string;
        acquisition_id: string | null;
        stripe_customer_id: string;
        stripe_checkout_session_id: string;
        stripe_payment_intent_id: string;
        stripe_charge_id: string | null;
      }>(
        `
          select license.account_id, license.stripe_customer_id,
            license.stripe_checkout_session_id, license.stripe_payment_intent_id,
            license.stripe_charge_id,
            (
              select checkout.acquisition_id
              from public.sidestream_checkout_intents checkout
              where checkout.stripe_checkout_session_id = license.stripe_checkout_session_id
              order by checkout.updated_at desc, checkout.id desc
              limit 1
            ) as acquisition_id
          from public.sidestream_licenses license
          where license.stripe_payment_intent_id = $1
             or license.stripe_charge_id = $2
          order by created_at asc
          limit 2
          for update
        `,
        [canonical.facts.paymentIntentId, canonical.facts.chargeId],
      );
      if (selected.rows.length !== 1) {
        await client.query("rollback");
        return {
          fulfilled: false as const,
          reason: selected.rows.length ? "ambiguous_payment_identity" : "missing_license",
        };
      }
      const license = selected.rows[0];
      if (
        license.stripe_payment_intent_id !== canonical.facts.paymentIntentId ||
        license.stripe_customer_id !== canonical.facts.customerId ||
        (license.stripe_charge_id && license.stripe_charge_id !== canonical.facts.chargeId)
      ) {
        await client.query("rollback");
        return { fulfilled: false as const, reason: "payment_identity_mismatch" };
      }

      const result = await upsertLicenseFromOneTimeCheckoutSession({
        accountId: license.account_id,
        customerId: license.stripe_customer_id,
        checkoutSessionId: license.stripe_checkout_session_id,
        paymentFacts: canonical.facts,
        noPaymentRequired: false,
        currency: canonical.facts.currency,
        eventWatermark,
      }, client);
      if (!result.fulfilled) {
        await client.query("rollback");
        return result;
      }
      await client.query("commit");
      return {
        fulfilled: true as const,
        applied: result.applied,
        entitlementStatus: result.entitlementStatus,
        acquisitionId: license.acquisition_id,
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
  if (reconciliation.fulfilled) {
    const acquisitionId = cleanString(reconciliation.acquisitionId, 36);
    if (ACQUISITION_ID.test(acquisitionId)) {
      const lifecycleStages = getStripeAcquisitionLifecycleStages(
        eventType,
        canonicalDispute || payload,
        canonical.facts,
      );
      for (const lifecycleStage of lifecycleStages) {
        const stage = await recordAcquisitionStage({
          acquisitionId,
          stage: lifecycleStage.stage,
          stableServerReference: lifecycleStage.stableServerReference,
          occurredAt: new Date(stripeEvent.created * 1_000),
        });
        if (stage.ownerConflict) {
          throw new AcquisitionIntegrityError(
            "lifecycle_acquisition_conflict",
            "Stripe lifecycle acquisition ownership conflicted.",
          );
        }
      }
    }
    if (reconciliation.entitlementStatus === "unknown") {
      return reconciliation;
    }
    try {
      await recordPaidAcquisitionLifecycle({
        environment: requireMatchingLicenseEnvironment().namespace,
        canonicalPaymentRef: canonical.facts.paymentIntentId,
        entitlementStatus: reconciliation.entitlementStatus,
        reason:
          canonical.facts.disputeStatus !== "none" &&
          canonical.facts.disputeStatus !== "won"
            ? "dispute"
            : canonical.facts.amountRefunded >= canonical.facts.amountPaid
              ? "full_refund"
              : "active",
      });
    } catch (error) {
      if (!isPaidAcquisitionSchemaUnavailable(error)) throw error;
    }
  }
  return reconciliation;
}

export function getStripeAcquisitionLifecycleStages(
  eventType: string,
  eventPayload: unknown,
  facts: Pick<CanonicalOneTimePaymentFacts, "chargeId" | "amountRefunded">,
) {
  const payload = eventPayload as Record<string, unknown>;
  if (eventType.startsWith("charge.dispute.")) {
    const disputeId = normalizeStripeId(payload?.id);
    return Object.freeze(disputeId
      ? [Object.freeze({
          stage: "disputed" as const,
          stableServerReference: `stripe-dispute:${disputeId}`,
        })]
      : []);
  }
  if (eventType.startsWith("refund.")) {
    const refundId = normalizeStripeId(payload?.id);
    return Object.freeze(refundId && facts.amountRefunded > 0
      ? [Object.freeze({
          stage: "refunded" as const,
          stableServerReference: `stripe-refund:${refundId}`,
        })]
      : []);
  }
  if (eventType === "charge.refunded" && facts.amountRefunded > 0) {
    const refunds = payload?.refunds as {
      data?: readonly Readonly<{ id?: unknown }>[];
    } | null | undefined;
    const refundIds = [...new Set(
      (refunds?.data || []).map((refund) => normalizeStripeId(refund.id)).filter(Boolean),
    )];
    return Object.freeze(refundIds.map((refundId) => Object.freeze({
      stage: "refunded" as const,
      stableServerReference: `stripe-refund:${refundId}`,
    })));
  }
  return Object.freeze([]);
}

async function upsertLicenseFromOneTimeCheckoutSession(options: {
  accountId: string;
  customerId: string;
  checkoutSessionId: string;
  paymentFacts: CanonicalOneTimePaymentFacts | null;
  noPaymentRequired: boolean;
  currency: string;
  eventWatermark: ReturnType<typeof normalizeStripeEventWatermark>;
}, runner: Pool | PoolClient) {
  const selected = await runner.query<{
    id: string;
    account_id: string;
    stripe_customer_id: string;
    stripe_payment_intent_id: string | null;
    stripe_charge_id: string | null;
    currency: string | null;
    entitlement_status: "unknown" | "active" | "suspended" | "revoked";
    status_reason: string;
    stripe_state_event_created_at: Date | string | null;
    stripe_state_event_id: string | null;
  }>(
    `
      select id, account_id, stripe_customer_id, stripe_payment_intent_id,
        stripe_charge_id, currency, entitlement_status, status_reason,
        stripe_state_event_created_at, stripe_state_event_id
      from public.sidestream_licenses
      where stripe_checkout_session_id = $1
      limit 1
      for update
    `,
    [options.checkoutSessionId],
  );
  const existing = selected.rows[0] || null;
  const paymentIntentId = options.paymentFacts?.paymentIntentId || "";
  const chargeId = options.paymentFacts?.chargeId || "";
  if (
    existing &&
    (
      existing.account_id !== options.accountId ||
      existing.stripe_customer_id !== options.customerId ||
      (existing.stripe_payment_intent_id && existing.stripe_payment_intent_id !== paymentIntentId) ||
      (existing.stripe_charge_id && existing.stripe_charge_id !== chargeId) ||
      (existing.currency && existing.currency !== options.currency)
    )
  ) {
    return { fulfilled: false as const, reason: "payment_identity_mismatch" };
  }

  let applyLifecycle = true;
  let entitlementStatus: "active" | "suspended" | "revoked" = "active";
  let statusReason = options.noPaymentRequired
    ? "checkout_no_payment_required"
    : "payment_paid";
  let revokeCredentials = false;
  if (options.paymentFacts) {
    const transition = planOneTimeEntitlementTransition({
      stored: {
        paymentIntentId: existing?.stripe_payment_intent_id,
        chargeId: existing?.stripe_charge_id,
        customerId: existing?.stripe_customer_id,
        entitlementStatus: existing?.entitlement_status,
        statusReason: existing?.status_reason,
        stripeEventCreatedAtMs: existing?.stripe_state_event_created_at
          ? new Date(existing.stripe_state_event_created_at).getTime()
          : null,
        stripeEventId: existing?.stripe_state_event_id,
      },
      facts: options.paymentFacts,
      event: options.eventWatermark
        ? {
            createdAtMs: options.eventWatermark.createdAtMs,
            eventId: options.eventWatermark.eventId,
          }
        : null,
    });
    if (!transition.apply) {
      if (transition.reason !== "stale_event") {
        return { fulfilled: false as const, reason: transition.reason };
      }
      applyLifecycle = false;
    } else {
      entitlementStatus = transition.entitlementStatus;
      statusReason = transition.statusReason;
      revokeCredentials = transition.revokeCredentials;
    }
  } else if (!options.noPaymentRequired) {
    return { fulfilled: false as const, reason: "missing_payment_identity" };
  }

  if (
    existing &&
    !options.eventWatermark &&
    existing.entitlement_status !== "unknown" &&
    existing.entitlement_status !== "active" &&
    entitlementStatus === "active"
  ) {
    applyLifecycle = false;
  }

  const amountPaid = options.paymentFacts?.amountPaid ?? 0;
  const amountRefunded = options.paymentFacts?.amountRefunded ?? 0;
  const active = applyLifecycle
    ? entitlementStatus === "active"
    : existing?.entitlement_status === "active";
  let licenseId = existing?.id || "";
  let resultingStatus = existing?.entitlement_status || entitlementStatus;
  if (!existing) {
    const inserted = await runner.query<{ id: string }>(
      `
        insert into public.sidestream_licenses (
          account_id, stripe_customer_id, stripe_subscription_id,
          stripe_checkout_session_id, stripe_payment_intent_id, stripe_charge_id,
          plan_key, status, current_period_end, cancel_at_period_end, grace_until,
          features, amount_paid, amount_refunded, currency,
          entitlement_status, status_reason, revoked_at, suspended_at,
          reconciled_at, stripe_state_event_created_at, stripe_state_event_id,
          created_at, updated_at
        )
        values (
          $1, $2, null, $3, $4, $5, $6, $7, null, false, null, $8::jsonb,
          $9, $10, $11, $12, $13,
          case when $12 = 'revoked' then now() else null end,
          case when $12 = 'suspended' then now() else null end,
          now(), $14::timestamptz, $15, now(), now()
        )
        returning id
      `,
      [
        options.accountId,
        options.customerId,
        options.checkoutSessionId,
        paymentIntentId || null,
        chargeId || null,
        SIDESTREAM_PRO_PLAN_KEY,
        entitlementStatus,
        JSON.stringify({
          unlimited_downloads: active,
          customer_portal: true,
          one_time_purchase: true,
        }),
        amountPaid,
        amountRefunded,
        options.currency,
        entitlementStatus,
        statusReason,
        options.eventWatermark?.createdAtIso || null,
        options.eventWatermark?.eventId || null,
      ],
    );
    licenseId = inserted.rows[0]?.id || "";
    resultingStatus = entitlementStatus;
  } else {
    const updated = await runner.query<{
      id: string;
      entitlement_status: "unknown" | "active" | "suspended" | "revoked";
    }>(
      `
        update public.sidestream_licenses
        set stripe_payment_intent_id = coalesce(stripe_payment_intent_id, $2),
            stripe_charge_id = coalesce(stripe_charge_id, $3),
            amount_paid = greatest(coalesce(amount_paid, 0), $4),
            amount_refunded = greatest(coalesce(amount_refunded, 0), $5),
            currency = coalesce(currency, $6),
            plan_key = $7,
            status = case when $8 then $9 else status end,
            entitlement_status = case when $8 then $9 else entitlement_status end,
            status_reason = case when $8 then $10 else status_reason end,
            revoked_at = case
              when $8 and $9 = 'revoked' then coalesce(revoked_at, now())
              else revoked_at
            end,
            suspended_at = case
              when $8 and $9 = 'suspended' then coalesce(suspended_at, now())
              else suspended_at
            end,
            reconciled_at = now(),
            stripe_state_event_created_at = case
              when $8 and $11::timestamptz is not null then $11::timestamptz
              else stripe_state_event_created_at
            end,
            stripe_state_event_id = case
              when $8 and $11::timestamptz is not null then $12
              else stripe_state_event_id
            end,
            features = features || jsonb_build_object(
              'unlimited_downloads', $13::boolean,
              'customer_portal', true,
              'one_time_purchase', true
            ),
            current_period_end = null,
            cancel_at_period_end = false,
            grace_until = null,
            updated_at = now()
        where id = $1
        returning id, entitlement_status
      `,
      [
        existing.id,
        paymentIntentId || null,
        chargeId || null,
        amountPaid,
        amountRefunded,
        options.currency,
        SIDESTREAM_PRO_PLAN_KEY,
        applyLifecycle,
        entitlementStatus,
        statusReason,
        options.eventWatermark?.createdAtIso || null,
        options.eventWatermark?.eventId || null,
        active,
      ],
    );
    licenseId = updated.rows[0]?.id || "";
    resultingStatus = updated.rows[0]?.entitlement_status || existing.entitlement_status;
  }

  if (!licenseId) return { fulfilled: false as const, reason: "license_write_failed" };
  if (resultingStatus !== "active" || revokeCredentials) {
    await revokeLicenseCredentials(runner, licenseId);
  }
  return {
    fulfilled: true as const,
    licenseId,
    entitlementStatus: resultingStatus,
    applied: !existing || applyLifecycle,
  };
}

export function sanitizeNextPath(value: unknown) {
  return sanitizeAccountNextPath(value);
}

export function cleanString(value: unknown, maxLength = 240) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function requiredAcquisitionId(value: unknown) {
  const acquisitionId = cleanString(value, 36);
  if (!ACQUISITION_ID.test(acquisitionId)) {
    throw new AcquisitionIntegrityError(
      "acquisition_linkage_missing",
      "A canonical acquisition is required for Checkout.",
    );
  }
  return acquisitionId;
}

function assertCheckoutAcquisitionIntact(
  acquisition: CanonicalAcquisition,
) {
  if (acquisition.integrityState !== "intact") {
    throw new AcquisitionIntegrityError(
      "acquisition_integrity_invalid",
      "Checkout acquisition integrity is not intact.",
    );
  }
  return acquisition;
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
) {
  return getPool().query<T>(text, params);
}

async function withPgClient<T>(callback: (client: PoolClient) => Promise<T>) {
  const client = await getPool().connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

async function attachCustomerIdentityTransaction(
  options: Parameters<typeof attachCustomerIdentity>[1],
) {
  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      const result = await attachCustomerIdentity(client, options);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function findBillingResource(
  resourceKey: string,
  client?: PoolClient,
) {
  const runner = client || getPool();
  const result = await runner.query<BillingResource>(
    `
      select stripe_product_id, stripe_price_id, unit_amount, currency, recurring_interval
      from public.sidestream_billing_resources
      where resource_key = $1
      limit 1
    `,
    [resourceKey],
  );

  return result.rows[0] || null;
}

function isStripeResourceMissing(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "resource_missing",
  );
}

function isPaidAcquisitionSchemaUnavailable(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    ["42P01", "42703"].includes(
      String((error as { code?: unknown }).code || ""),
    ),
  );
}

function getPool() {
  const environment = resolveLicenseEnvironment({ serverEnv: process.env });
  if (environment) {
    return getPostgresPool({
      connectionString: environment.database.connectionString,
      environmentVariable: environment.database.environmentVariable,
      pooled: true,
    });
  }
  return getPostgresPool();
}

function requireMatchingLicenseEnvironment(
  environmentInput?: ResolvedLicenseEnvironment,
) {
  const trustedServerEnvironment = resolveLicenseEnvironment({
    serverEnv: process.env,
  });
  const environment = environmentInput || trustedServerEnvironment;
  if (!environment) {
    throw new Error("Unable to resolve the trusted Sidestream license environment");
  }
  if (
    trustedServerEnvironment &&
    environment.namespace !== trustedServerEnvironment.namespace
  ) {
    throw new Error("License namespace does not match trusted deployment state");
  }

  const configuredConnectionString = normalizeConnectionString(
    requirePostgresConnectionString(),
  );
  const selectedConnectionString = normalizeConnectionString(
    environment.database.connectionString,
  );
  if (configuredConnectionString !== selectedConnectionString) {
    throw new Error("License namespace database does not match the configured server database");
  }
  return environment;
}

function requirePostgresConnectionString() {
  const environment = resolveLicenseEnvironment({ serverEnv: process.env });
  if (environment) return environment.database.connectionString;
  if (
    getValidEnvValue("SIDESTREAM_LICENSE_NAMESPACE") ||
    getValidEnvValue("VERCEL_ENV")
  ) {
    throw new Error("Invalid or incomplete Sidestream license environment configuration");
  }

  return requireRuntimePostgresTarget().connectionString;
}

function requireEnv(name: string) {
  const value = getValidEnvValue(name);
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function getValidEnvValue(name: string) {
  const value = process.env[name]?.trim();
  if (!value || value.includes("[YOUR-") || value === "changeme") {
    return "";
  }
  return value;
}

function normalizeConnectionString(connectionString: string) {
  return normalizePostgresConnectionString(connectionString);
}

function buildLicenseSummary(options: {
  status?: string | null;
  planKey?: string | null;
  entitlementStatus?: string | null;
  currentPeriodEnd?: Date | string | null;
  cancelAtPeriodEnd?: boolean | null;
  graceUntil?: Date | string | null;
  features?: Record<string, unknown> | null;
}): LicenseSummary {
  const status = cleanString(options.status, 80) || "free";
  const graceUntil = toIsoString(options.graceUntil);
  const active = isCanonicalLicenseEntitlementUsable({
    planKey: options.planKey,
    entitlementStatus: options.entitlementStatus,
  });

  return {
    active,
    plan: active ? (cleanString(options.planKey, 120) || SIDESTREAM_PRO_PLAN_KEY) : "free",
    status,
    currentPeriodEnd: toIsoString(options.currentPeriodEnd),
    cancelAtPeriodEnd: Boolean(options.cancelAtPeriodEnd),
    graceUntil,
    features: {
      customer_portal: true,
      ...(options.features || {}),
      unlimited_downloads: active,
    },
  };
}

function isLicenseStatusUsable(status: string) {
  return status === "active" || status === "trialing";
}

async function hasCanonicalActivePaidLicense(
  accountId: string,
  runner: Pool | PoolClient = getPostgresPool(),
) {
  const result = await runner.query<{ active: boolean }>(
    `
      select exists (
        select 1
        from public.sidestream_licenses l
        where l.account_id = $1
          and l.plan_key in ('sidestream_pro', 'sidestream_unlimited')
          and (${LICENSE_ENTITLEMENT_STATUS_SQL}) = 'active'
      ) as active
    `,
    [accountId],
  );
  return result.rows[0]?.active === true;
}

function getPaidEligibilityLockKey(accountId: string) {
  return `${PAID_ELIGIBILITY_LOCK_PREFIX}:${accountId}`;
}

async function lockPaidEligibility(
  client: Pick<PoolClient, "query">,
  accountId: string,
) {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    getPaidEligibilityLockKey(accountId),
  ]);
}

function isSidestreamPaidPlanKey(planKey: string) {
  return planKey === SIDESTREAM_PRO_PLAN_KEY ||
    planKey === SIDESTREAM_LEGACY_UNLIMITED_PLAN_KEY;
}

type AccountDeviceRow = {
  id: string;
  device_id_hash: string;
  active_slot: number;
  activated_at: Date | string;
  revoked_at: Date | string | null;
  revocation_reason: DeviceRevocationReason | null;
};

type AccountDeviceBinding = {
  allowed: true;
  deviceGeneration: string;
  activeDeviceId: string;
  activeDeviceActivatedAt: Date | string;
  bindingMatches: boolean;
  observedErrorCode: DevicePolicyErrorCode | null;
} | {
  allowed: false;
  code: DevicePolicyErrorCode;
};

function getAccountDeviceLockKey(accountId: string, namespace: DeviceNamespace) {
  return `${ACCOUNT_DEVICE_LOCK_PREFIX}:${accountId}:${namespace}`;
}

async function lockAccountDeviceBinding(
  client: PoolClient,
  options: {
    accountId: string;
    namespace: DeviceNamespace;
    requestedDeviceIdHash: string;
    purpose: "activation" | "credential";
    claimEmpty?: boolean;
    touchLastSeen?: boolean;
    credentialCreatedAt?: Date | string;
    platform?: unknown;
    appVersion?: unknown;
    buildChannel?: unknown;
    licenseFeatures?: Record<string, unknown> | null;
  },
): Promise<AccountDeviceBinding> {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    getAccountDeviceLockKey(options.accountId, options.namespace),
  ]);

  let activeResult = await client.query<AccountDeviceRow>(
    `
      select id, device_id_hash, active_slot, activated_at, revoked_at, revocation_reason
      from public.sidestream_account_devices
      where account_id = $1
        and license_namespace = $2
        and revoked_at is null
      order by (device_id_hash = $3) desc, activated_at desc, id desc
      for update
    `,
    [options.accountId, options.namespace, options.requestedDeviceIdHash],
  );
  let activeDevices = activeResult.rows;
  let activeDevice = activeDevices[0] || null;

  let latestRequestedResult = await client.query<AccountDeviceRow>(
    `
      select id, device_id_hash, active_slot, activated_at, revoked_at, revocation_reason
      from public.sidestream_account_devices
      where account_id = $1
        and license_namespace = $2
        and device_id_hash = $3
      order by activated_at desc, id desc
      limit 1
      for update
    `,
    [options.accountId, options.namespace, options.requestedDeviceIdHash],
  );
  let latestRequestedDevice = latestRequestedResult.rows[0] || null;

  if (
    activeDevices.length < MAX_ACTIVE_DEVICES &&
    options.claimEmpty !== false &&
    !(options.purpose === "credential" && latestRequestedDevice?.revoked_at)
  ) {
    const platform = normalizeDevicePlatform(options.platform);
    const appVersion = normalizeRegistryAppVersion(options.appVersion);
    const buildChannel = getLicenseDiagnosticMetadata({
      buildChannel: options.buildChannel,
    }).buildChannel;
    const activatedAt = options.purpose === "credential"
      ? toIsoString(options.credentialCreatedAt)
      : "";
    await client.query(
      `
        insert into public.sidestream_account_devices (
          account_id,
          license_namespace,
          device_id_hash,
          platform,
          app_version,
          build_channel,
          active_slot,
          activated_at,
          last_seen_at
        )
        select $1, $2, $3, $4, $5, $6,
          case
            when not exists (
              select 1 from public.sidestream_account_devices
              where account_id = $1 and license_namespace = $2
                and active_slot = 1 and revoked_at is null
            ) then 1
            else 2
          end,
          coalesce($7::timestamptz, now()), now()
        where not exists (
          select 1
          from public.sidestream_account_devices
          where account_id = $1
            and license_namespace = $2
            and device_id_hash = $3
            and revoked_at is null
        )
          and (
            select count(*)
            from public.sidestream_account_devices
            where account_id = $1
              and license_namespace = $2
              and revoked_at is null
          ) < 2
        on conflict do nothing
      `,
      [
        options.accountId,
        options.namespace,
        options.requestedDeviceIdHash,
        platform,
        appVersion,
        buildChannel,
        activatedAt || null,
      ],
    );
    activeResult = await client.query<AccountDeviceRow>(
      `
        select id, device_id_hash, active_slot, activated_at, revoked_at, revocation_reason
        from public.sidestream_account_devices
        where account_id = $1
          and license_namespace = $2
          and revoked_at is null
        order by (device_id_hash = $3) desc, activated_at desc, id desc
        for update
      `,
      [options.accountId, options.namespace, options.requestedDeviceIdHash],
    );
    activeDevices = activeResult.rows;
    activeDevice = activeDevices[0] || null;
    latestRequestedResult = await client.query<AccountDeviceRow>(
      `
        select id, device_id_hash, active_slot, activated_at, revoked_at, revocation_reason
        from public.sidestream_account_devices
        where account_id = $1
          and license_namespace = $2
          and device_id_hash = $3
        order by activated_at desc, id desc
        limit 1
        for update
      `,
      [options.accountId, options.namespace, options.requestedDeviceIdHash],
    );
    latestRequestedDevice = latestRequestedResult.rows[0] || null;
  }

  if (!activeDevice) {
    const credentialDecision = evaluateDeviceCredentialBinding({
      namespace: options.namespace,
      requestedDeviceIdHash: options.requestedDeviceIdHash,
      activeDevice: null,
      latestRequestedDevice: latestRequestedDevice
        ? mapAccountDevicePolicyRecord(options.namespace, latestRequestedDevice)
        : null,
      credentialCreatedAt: options.credentialCreatedAt || new Date(0),
      mode: process.env[DEVICE_POLICY_MODE_ENV],
    });
    const code = credentialDecision.publicErrorCode ||
      DEVICE_POLICY_ERROR_CODES.DEVICE_DEACTIVATED;
    return { allowed: false, code };
  }

  const activePolicyRecord = mapAccountDevicePolicyRecord(options.namespace, activeDevice);
  const latestRequestedPolicyRecord = latestRequestedDevice
    ? mapAccountDevicePolicyRecord(options.namespace, latestRequestedDevice)
    : null;
  const policyMode = resolveDevicePolicyMode(process.env[DEVICE_POLICY_MODE_ENV]);
  let bindingMatches = false;
  let observedErrorCode: DevicePolicyErrorCode | null = null;

  if (options.purpose === "activation") {
    const activationDecision = decideDeviceActivation({
      namespace: options.namespace,
      requestedDeviceIdHash: options.requestedDeviceIdHash,
      activeDevice: activePolicyRecord,
      activeDeviceCount: activeDevices.length,
    });
    bindingMatches = activationDecision.decision !== "transfer_required";
    const policy = applyDevicePolicyMode({
      mode: policyMode,
      errorCode: activationDecision.errorCode,
    });
    if (!policy.allowed) {
      return {
        allowed: false,
        code: policy.publicErrorCode || DEVICE_POLICY_ERROR_CODES.TRANSFER_REQUIRED,
      };
    }
    observedErrorCode = policy.observedErrorCode;
  } else {
    const credentialDecision = evaluateDeviceCredentialBinding({
      namespace: options.namespace,
      requestedDeviceIdHash: options.requestedDeviceIdHash,
      activeDevice: activePolicyRecord,
      latestRequestedDevice: latestRequestedPolicyRecord,
      credentialCreatedAt: options.credentialCreatedAt || new Date(0),
      activeDeviceActivatedAt: activeDevice.activated_at,
      mode: policyMode,
    });
    if (!credentialDecision.allowed) {
      return {
        allowed: false,
        code: credentialDecision.publicErrorCode ||
          DEVICE_POLICY_ERROR_CODES.DEVICE_REPLACED,
      };
    }
    bindingMatches = safeEqual(activeDevice.device_id_hash, options.requestedDeviceIdHash);
    observedErrorCode = credentialDecision.observedErrorCode;
  }

  if (observedErrorCode) {
    recordDevicePolicyObservation({
      accountId: options.accountId,
      namespace: options.namespace,
      requestedDeviceIdHash: options.requestedDeviceIdHash,
      stage: options.purpose,
      code: observedErrorCode,
    });
  }

  if (bindingMatches && options.touchLastSeen !== false) {
    const { licenseWriteThrottleSeconds } = loadLicenseWriteConfiguration();
    await client.query(
      `
        update public.sidestream_account_devices
        set last_seen_at = greatest(last_seen_at, now()),
            platform = case when platform = 'unknown' then $2 else platform end,
            app_version = coalesce($3, app_version),
            build_channel = coalesce($4, build_channel)
        where id = $1
          and revoked_at is null
          and last_seen_at <= now() - ($5::bigint * interval '1 second')
      `,
      [
        activeDevice.id,
        normalizeDevicePlatform(options.platform),
        normalizeRegistryAppVersion(options.appVersion),
        getLicenseDiagnosticMetadata({ buildChannel: options.buildChannel }).buildChannel,
        licenseWriteThrottleSeconds,
      ],
    );
  }

  const generation = await client.query<{ device_generation: string }>(
    `
      select count(*)::text as device_generation
      from public.sidestream_account_devices d
      where d.account_id = $1
        and d.license_namespace = $2
        and (d.activated_at, d.id) <= (
          select activated_at, id
          from public.sidestream_account_devices
          where id = $3
        )
    `,
    [options.accountId, options.namespace, activeDevice.id],
  );
  const deviceGeneration = generation.rows[0]?.device_generation || "";
  if (!/^[1-9][0-9]*$/.test(deviceGeneration)) {
    throw new Error("Unable to resolve account device generation");
  }

  return {
    allowed: true,
    deviceGeneration,
    activeDeviceId: activeDevice.id,
    activeDeviceActivatedAt: activeDevice.activated_at,
    bindingMatches,
    observedErrorCode,
  };
}

function mapAccountDevicePolicyRecord(
  namespace: DeviceNamespace,
  row: AccountDeviceRow,
) {
  return {
    namespace,
    deviceIdHash: row.device_id_hash,
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason,
  } as const;
}

function normalizeRegistryAppVersion(value: unknown) {
  const appVersion = cleanString(value, 64);
  return /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(appVersion)
    ? appVersion
    : null;
}

function recordDevicePolicyObservation(options: {
  accountId: string;
  namespace: DeviceNamespace;
  requestedDeviceIdHash: string;
  stage: "activation" | "credential";
  code: DevicePolicyErrorCode;
}) {
  const accountReference = createHash("sha256")
    .update(`device-policy-account:${options.accountId}`)
    .digest("hex")
    .slice(0, 16);
  console.warn("sidestream_device_policy_observation", {
    accountReference,
    namespace: options.namespace,
    requestedDeviceReference: options.requestedDeviceIdHash.slice(0, 16),
    stage: options.stage,
    code: options.code,
  });
}

type DownloadAuthorizationCredentialRow = {
  token_id: string;
  account_id: string;
  device_id_hash: string | null;
  created_at: Date | string;
  expires_at: Date | string;
  refresh_token_hash: string | null;
  refresh_expires_at: Date | string | null;
  revoked_at: Date | string | null;
  status: string | null;
  plan_key: string | null;
  entitlement_status: string | null;
  current_period_end: Date | string | null;
  cancel_at_period_end: boolean | null;
  grace_until: Date | string | null;
  features: Record<string, unknown> | null;
};

type DownloadAuthorizationFailureCode =
  | typeof DEVICE_POLICY_ERROR_CODES.DEVICE_REPLACED
  | typeof DEVICE_POLICY_ERROR_CODES.DEVICE_DEACTIVATED
  | "license_inactive";

function deniedDownloadAuthorization(code: DownloadAuthorizationFailureCode) {
  return { active: false as const, code };
}

export async function authorizeLicenseDownload(options: {
  licenseToken: string;
  deviceId: string;
  environment: ResolvedLicenseEnvironment;
}) {
  const environment = requireMatchingLicenseEnvironment(options.environment);
  if (!options.licenseToken || !options.deviceId) {
    return deniedDownloadAuthorization(
      DEVICE_POLICY_ERROR_CODES.DEVICE_DEACTIVATED,
    );
  }

  const tokenHash = hashToken(options.licenseToken);
  const deviceIdHash = hashPrivateIdentifier(options.deviceId);
  const accountLookup = await query<{ account_id: string }>(
    `
      select account_id
      from public.sidestream_license_tokens
      where token_hash = $1
      order by created_at desc
      limit 1
    `,
    [tokenHash],
  );
  const accountId = accountLookup.rows[0]?.account_id;
  if (!accountId) {
    return deniedDownloadAuthorization(
      DEVICE_POLICY_ERROR_CODES.DEVICE_DEACTIVATED,
    );
  }

  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        getAccountDeviceLockKey(accountId, environment.namespace),
      ]);
      const selected = await client.query<DownloadAuthorizationCredentialRow>(
        `
          select
            t.id as token_id,
            t.account_id,
            t.device_id_hash,
            t.created_at,
            t.expires_at,
            t.refresh_token_hash,
            t.refresh_expires_at,
            t.revoked_at,
            l.status,
            l.plan_key,
            ${LICENSE_ENTITLEMENT_STATUS_SQL} as entitlement_status,
            l.current_period_end,
            l.cancel_at_period_end,
            l.grace_until,
            l.features
          from public.sidestream_license_tokens t
          join public.sidestream_licenses l on l.id = t.license_id
          where t.token_hash = $1
            and t.account_id = $2
          limit 1
          for update of t
        `,
        [tokenHash, accountId],
      );
      const credential = selected.rows[0];
      if (!credential) {
        await client.query("rollback");
        return deniedDownloadAuthorization(
          DEVICE_POLICY_ERROR_CODES.DEVICE_DEACTIVATED,
        );
      }
      if (!matchesDeviceHash(credential.device_id_hash, deviceIdHash)) {
        await client.query("rollback");
        return deniedDownloadAuthorization(
          DEVICE_POLICY_ERROR_CODES.DEVICE_REPLACED,
        );
      }

      const license = buildLicenseSummary({
        status: credential.status,
        planKey: credential.plan_key,
        entitlementStatus: credential.entitlement_status,
        currentPeriodEnd: credential.current_period_end,
        cancelAtPeriodEnd: credential.cancel_at_period_end,
        graceUntil: credential.grace_until,
        features: credential.features,
      });
      if (!license.active) {
        await client.query("rollback");
        return deniedDownloadAuthorization("license_inactive");
      }

      const binding = await lockAccountDeviceBinding(client, {
        accountId: credential.account_id,
        namespace: environment.namespace,
        requestedDeviceIdHash: deviceIdHash,
        purpose: "credential",
        claimEmpty: false,
        touchLastSeen: false,
        credentialCreatedAt: credential.created_at,
      });
      if (!binding.allowed) {
        await client.query("commit");
        return deniedDownloadAuthorization(
          binding.code === DEVICE_POLICY_ERROR_CODES.DEVICE_DEACTIVATED
            ? DEVICE_POLICY_ERROR_CODES.DEVICE_DEACTIVATED
            : DEVICE_POLICY_ERROR_CODES.DEVICE_REPLACED,
        );
      }
      if (!binding.bindingMatches) {
        await client.query("commit");
        return deniedDownloadAuthorization(
          DEVICE_POLICY_ERROR_CODES.DEVICE_REPLACED,
        );
      }

      const now = Date.now();
      const familyIsCurrent = !credential.revoked_at &&
        new Date(credential.expires_at).getTime() > now &&
        Boolean(credential.refresh_token_hash) &&
        credential.refresh_expires_at !== null &&
        new Date(credential.refresh_expires_at).getTime() > now;
      if (!familyIsCurrent) {
        await client.query("commit");
        return deniedDownloadAuthorization(
          DEVICE_POLICY_ERROR_CODES.DEVICE_DEACTIVATED,
        );
      }

      const { licenseWriteThrottleSeconds } = loadLicenseWriteConfiguration();
      const touched = await client.query(
        `
          update public.sidestream_license_tokens
          set last_seen_at = now(), updated_at = now()
          where id = $1
            and token_hash = $2
            and refresh_token_hash is not null
            and revoked_at is null
            and expires_at > now()
            and refresh_expires_at > now()
            and (
              last_seen_at is null
              or last_seen_at <= now() - ($3::bigint * interval '1 second')
            )
        `,
        [credential.token_id, tokenHash, licenseWriteThrottleSeconds],
      );
      if (touched.rowCount === 0) {
        const stillCurrent = await client.query(
          `
            select 1
            from public.sidestream_license_tokens
            where id = $1
              and token_hash = $2
              and refresh_token_hash is not null
              and revoked_at is null
              and expires_at > now()
              and refresh_expires_at > now()
          `,
          [credential.token_id, tokenHash],
        );
        if (stillCurrent.rowCount !== 1) {
          await client.query("rollback");
          return deniedDownloadAuthorization(
            DEVICE_POLICY_ERROR_CODES.DEVICE_DEACTIVATED,
          );
        }
      }
      await client.query(
        `
          update public.sidestream_account_devices
          set last_seen_at = greatest(last_seen_at, now())
          where id = $1
            and account_id = $2
            and license_namespace = $3
            and revoked_at is null
            and last_seen_at <= now() - ($4::bigint * interval '1 second')
        `,
        [
          binding.activeDeviceId,
          credential.account_id,
          environment.namespace,
          licenseWriteThrottleSeconds,
        ],
      );

      await client.query("commit");
      return { active: true as const };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function getAccountDeviceStatus(
  accountId: string,
  environmentInput: ResolvedLicenseEnvironment,
) {
  const environment = requireMatchingLicenseEnvironment(environmentInput);
  if (!accountId) throw new TypeError("Invalid account device status identity");

  const result = await query<{
    platform: DevicePlatform;
    activated_at: Date | string;
    last_seen_at: Date | string;
  }>(
    `
      select platform, activated_at, last_seen_at
      from public.sidestream_account_devices
      where account_id = $1
        and license_namespace = $2
        and revoked_at is null
      order by activated_at desc, id desc
    `,
    [accountId, environment.namespace],
  );
  const devices = result.rows.map((row) => ({
    platform: normalizeDevicePlatform(row.platform),
    activatedAt: toIsoString(row.activated_at),
    lastSeenAt: toIsoString(row.last_seen_at),
  }));
  const device = devices[0];
  if (!device) return { active: false as const, device: null, devices: [] };

  return {
    active: true as const,
    device,
    devices,
  };
}

export async function deactivateAccountDevice(options: {
  accountId: string;
  environment: ResolvedLicenseEnvironment;
}) {
  const environment = requireMatchingLicenseEnvironment(options.environment);
  if (!options.accountId) throw new TypeError("Invalid account device identity");

  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        getAccountDeviceLockKey(options.accountId, environment.namespace),
      ]);
      const selected = await client.query<{ id: string }>(
        `
          select id
          from public.sidestream_account_devices
          where account_id = $1
            and license_namespace = $2
            and revoked_at is null
          for update
        `,
        [options.accountId, environment.namespace],
      );
      const activeDeviceIds = selected.rows.map((row) => row.id);
      if (activeDeviceIds.length) {
        const revokedDevice = await client.query(
          `
            update public.sidestream_account_devices
            set revoked_at = now(), revocation_reason = 'deactivated'
            where account_id = $1
              and license_namespace = $2
              and revoked_at is null
          `,
          [options.accountId, environment.namespace],
        );
        if (revokedDevice.rowCount !== activeDeviceIds.length) {
          throw new Error("Account device deactivation compare-and-swap failed");
        }
      }

      await client.query(
        `
          update public.sidestream_license_tokens
          set revoked_at = coalesce(revoked_at, now()), updated_at = now()
          where account_id = $1
            and revoked_at is null
        `,
        [options.accountId],
      );
      await client.query("commit");
      return {
        active: false as const,
        deactivated: activeDeviceIds.length > 0,
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function checkActivationDeviceBinding(options: {
  accountId: string;
  environment: ResolvedLicenseEnvironment;
  deviceIdHash: string;
  platform?: unknown;
  appVersion?: unknown;
  buildChannel?: unknown;
  previouslyIssuedAt?: Date | string | null;
  licenseFeatures?: Record<string, unknown> | null;
}) {
  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      const binding = await lockAccountDeviceBinding(client, {
        accountId: options.accountId,
        namespace: options.environment.namespace,
        requestedDeviceIdHash: options.deviceIdHash,
        purpose: options.previouslyIssuedAt ? "credential" : "activation",
        credentialCreatedAt: options.previouslyIssuedAt || undefined,
        platform: options.platform,
        appVersion: options.appVersion,
        buildChannel: options.buildChannel,
        licenseFeatures: options.licenseFeatures,
      });
      await client.query("commit");
      return binding;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function issueLicenseTokenPair(options: {
  activationId: string;
  activationKey: string;
  accountId: string;
  licenseId: string;
  deviceId: string;
  environment: ResolvedLicenseEnvironment;
  platform?: unknown;
  appVersion?: unknown;
  buildChannel?: unknown;
  previouslyIssuedAt?: Date | string | null;
  accessTokenTtlDays?: number;
  identity: CustomerIdentityInput;
}) {
  if (!options.deviceId) throw new Error("Cannot issue a device-less refresh credential");

  const environment = requireMatchingLicenseEnvironment(options.environment);
  const deviceIdHash = hashPrivateIdentifier(options.deviceId);
  const tokenExpiresAt = addDays(
    new Date(),
    options.accessTokenTtlDays || LICENSE_TOKEN_TTL_DAYS,
  ).toISOString();

  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      const binding = await lockAccountDeviceBinding(client, {
        accountId: options.accountId,
        namespace: environment.namespace,
        requestedDeviceIdHash: deviceIdHash,
        purpose: options.previouslyIssuedAt ? "credential" : "activation",
        credentialCreatedAt: options.previouslyIssuedAt || undefined,
        platform: options.platform,
        appVersion: options.appVersion,
        buildChannel: options.buildChannel,
      });
      if (!binding.allowed) {
        await client.query("commit");
        return { issued: false as const, code: binding.code };
      }

      await attachCustomerIdentity(client, {
        environment,
        identity: options.identity,
        activationId: options.activationId,
        accountId: options.accountId,
        platform: options.platform,
        appVersion: options.appVersion,
        source: "activation_status",
      });

      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `activation_token:${options.activationId}`,
      ]);
      const deviceScope: CredentialDeviceScope = {
        licenseNamespace: environment.namespace,
        deviceGeneration: binding.deviceGeneration,
      };
      const tokens = deriveActivationTokenPair(
        options.activationKey,
        options.deviceId,
        getPrivateServerSecret(),
        deviceScope,
      );
      const legacyTokens = deriveActivationTokenPair(
        options.activationKey,
        options.deviceId,
        getPrivateServerSecret(),
      );
      const existing = await client.query<{
        token_id: string;
        token_hash: string;
        refresh_token_hash: string;
        expires_at: Date | string;
        refresh_expires_at: Date | string;
        revoked_at: Date | string | null;
      }>(
        `
          select
            id as token_id,
            token_hash,
            refresh_token_hash,
            expires_at,
            refresh_expires_at,
            revoked_at
          from public.sidestream_license_tokens
          where activation_session_id = $1
            and device_id_hash = $2
            and created_at >= $3::timestamptz
            and refresh_token_hash is not null
          order by created_at asc
          limit 1
          for update
        `,
        [options.activationId, deviceIdHash, toIsoString(binding.activeDeviceActivatedAt)],
      );
      const row = existing.rows[0];
      if (row) {
        const replayTokens = [tokens, legacyTokens].find((candidate) =>
          safeEqual(row.token_hash, hashToken(candidate.licenseToken)) &&
          safeEqual(row.refresh_token_hash, hashToken(candidate.refreshToken))
        );
        if (
          !row.revoked_at &&
          replayTokens
        ) {
          const legacyReplay = options.accessTokenTtlDays ===
            LEGACY_LICENSE_TOKEN_TTL_DAYS;
          const { legacyTokenRenewalThresholdDays } =
            loadLicenseWriteConfiguration();
          const extended = legacyReplay
            ? await client.query<{ expires_at: Date | string }>(
              `
                update public.sidestream_license_tokens
                set expires_at = greatest(expires_at, $2::timestamptz),
                    updated_at = now()
                where id = $1
                  and revoked_at is null
                  and expires_at <= now() + ($3::bigint * interval '1 day')
                returning expires_at
              `,
              [row.token_id, tokenExpiresAt, legacyTokenRenewalThresholdDays],
            )
            : { rows: [] };
          await client.query("commit");
          return {
            issued: true as const,
            ...replayTokens,
            tokenExpiresAt: toIsoString(extended.rows[0]?.expires_at || row.expires_at),
            refreshExpiresAt: toIsoString(row.refresh_expires_at),
          };
        }
        await client.query("commit");
        return { issued: false as const, code: null };
      }

      const refreshExpiresAt = addDays(new Date(), REFRESH_TOKEN_TTL_DAYS).toISOString();
      await client.query(
        `
          insert into public.sidestream_license_tokens (
            account_id,
            license_id,
            activation_session_id,
            device_id_hash,
            token_hash,
            expires_at,
            refresh_token_hash,
            refresh_expires_at,
            created_at,
            updated_at
          )
          values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8::timestamptz, now(), now())
        `,
        [
          options.accountId,
          options.licenseId,
          options.activationId,
          deviceIdHash,
          hashToken(tokens.licenseToken),
          tokenExpiresAt,
          hashToken(tokens.refreshToken),
          refreshExpiresAt,
        ],
      );
      await client.query("commit");
      return {
        issued: true as const,
        ...tokens,
        tokenExpiresAt,
        refreshExpiresAt,
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

type RefreshCredentialRow = {
  token_id: string;
  account_id: string;
  license_id: string;
  activation_session_id: string | null;
  device_id_hash: string;
  token_hash: string;
  refresh_token_hash: string;
  revoked_at: Date | string | null;
  created_at: Date | string;
  refresh_expires_at: Date | string;
  expires_at: Date | string;
  activation_app_version: string | null;
  activation_build_channel: string | null;
  status: string | null;
  plan_key: string | null;
  entitlement_status: string | null;
  current_period_end: Date | string | null;
  cancel_at_period_end: boolean | null;
  grace_until: Date | string | null;
  features: Record<string, unknown> | null;
};

export async function refreshLicenseToken(
  refreshToken: string,
  deviceId: string,
  environmentInput?: ResolvedLicenseEnvironment,
  identityInput?: unknown,
) {
  if (!refreshToken || !deviceId) {
    return { active: false as const, status: "invalid", code: "invalid_token" as const };
  }

  const environment = requireMatchingLicenseEnvironment(environmentInput);
  const identity = normalizeCustomerIdentityInput(identityInput);
  const refreshTokenHash = hashToken(refreshToken);
  const deviceIdHash = hashPrivateIdentifier(deviceId);
  const accountLookup = await query<{ account_id: string }>(
    `
      select account_id
      from public.sidestream_license_tokens
      where refresh_token_hash = $1
        or (
          previous_refresh_token_hash = $1
          and previous_refresh_valid_until > now()
        )
      order by
        case when previous_refresh_token_hash = $1 and revoked_at is null then 0 else 1 end,
        created_at desc
      limit 1
    `,
    [refreshTokenHash],
  );
  const accountId = accountLookup.rows[0]?.account_id;
  if (!accountId) {
    return { active: false as const, status: "invalid", code: "invalid_token" as const };
  }

  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        getAccountDeviceLockKey(accountId, environment.namespace),
      ]);
      const selected = await client.query<RefreshCredentialRow>(
        `
          select
            t.id as token_id,
            t.account_id,
            t.license_id,
            t.activation_session_id,
            t.device_id_hash,
            t.token_hash,
            t.refresh_token_hash,
            t.revoked_at,
            t.created_at,
            t.refresh_expires_at,
            t.expires_at,
            a.app_version as activation_app_version,
            a.build_channel as activation_build_channel,
            l.status,
            l.plan_key,
            ${LICENSE_ENTITLEMENT_STATUS_SQL} as entitlement_status,
            l.current_period_end,
            l.cancel_at_period_end,
            l.grace_until,
            l.features
          from public.sidestream_license_tokens t
          join public.sidestream_licenses l on l.id = t.license_id
          left join public.sidestream_activation_sessions a on a.id = t.activation_session_id
          where t.refresh_token_hash = $1
            and t.account_id = $2
          limit 1
          for update of t
        `,
        [refreshTokenHash, accountId],
      );
      const current = selected.rows[0];

      if (current && !matchesDeviceHash(current.device_id_hash, deviceIdHash)) {
        await client.query("rollback");
        return { active: false as const, status: "invalid", code: "device_mismatch" as const };
      }

      const replay = !current || current.revoked_at
        ? await client.query<RefreshCredentialRow>(
          `
            select
              t.id as token_id,
              t.account_id,
              t.license_id,
              t.activation_session_id,
              t.device_id_hash,
              t.token_hash,
              t.refresh_token_hash,
              t.revoked_at,
              t.created_at,
              t.refresh_expires_at,
              t.expires_at,
              a.app_version as activation_app_version,
              a.build_channel as activation_build_channel,
              l.status,
              l.plan_key,
              ${LICENSE_ENTITLEMENT_STATUS_SQL} as entitlement_status,
              l.current_period_end,
              l.cancel_at_period_end,
              l.grace_until,
              l.features
            from public.sidestream_license_tokens t
            join public.sidestream_licenses l on l.id = t.license_id
            left join public.sidestream_activation_sessions a on a.id = t.activation_session_id
            where t.previous_refresh_token_hash = $1
              and t.account_id = $2
              and t.previous_refresh_valid_until > now()
              and t.revoked_at is null
              and t.refresh_expires_at > now()
            limit 1
            for update of t
          `,
          [refreshTokenHash, accountId],
        )
        : null;
      const replayRow = replay?.rows[0] || null;
      const credential = current && !current.revoked_at ? current : replayRow;
      if (!credential) {
        if (current) {
          const revokedBinding = await lockAccountDeviceBinding(client, {
            accountId: current.account_id,
            namespace: environment.namespace,
            requestedDeviceIdHash: deviceIdHash,
            purpose: "credential",
            claimEmpty: false,
            credentialCreatedAt: current.created_at,
            appVersion: current.activation_app_version,
            buildChannel: current.activation_build_channel,
          });
          await client.query("commit");
          return {
            active: false as const,
            status: "invalid",
            code: revokedBinding.allowed ? "revoked" as const : revokedBinding.code,
          };
        }
        await client.query("rollback");
        return { active: false as const, status: "invalid", code: "invalid_token" as const };
      }

      if (!matchesDeviceHash(credential.device_id_hash, deviceIdHash)) {
        await client.query("rollback");
        return { active: false as const, status: "invalid", code: "device_mismatch" as const };
      }
      if (new Date(credential.refresh_expires_at).getTime() <= Date.now()) {
        await client.query("rollback");
        return { active: false as const, status: "invalid", code: "invalid_token" as const };
      }

      const license = buildLicenseSummary({
        status: credential.status,
        planKey: credential.plan_key,
        entitlementStatus: credential.entitlement_status,
        currentPeriodEnd: credential.current_period_end,
        cancelAtPeriodEnd: credential.cancel_at_period_end,
        graceUntil: credential.grace_until,
        features: credential.features,
      });
      if (!license.active) {
        await client.query(
          `
            update public.sidestream_license_tokens
            set revoked_at = coalesce(revoked_at, now()), updated_at = now()
            where id = $1
          `,
          [credential.token_id],
        );
        await client.query("commit");
        return { active: false as const, status: license.status, code: "license_inactive" as const, license };
      }

      const binding = await lockAccountDeviceBinding(client, {
        accountId: credential.account_id,
        namespace: environment.namespace,
        requestedDeviceIdHash: deviceIdHash,
        purpose: "credential",
        credentialCreatedAt: credential.created_at,
        appVersion: credential.activation_app_version,
        buildChannel: credential.activation_build_channel,
      });
      if (!binding.allowed) {
        await client.query("commit");
        return { active: false as const, status: "invalid", code: binding.code };
      }

      const deviceScope: CredentialDeviceScope = {
        licenseNamespace: environment.namespace,
        deviceGeneration: binding.deviceGeneration,
      };
      if (replayRow) {
        const replayedTokens = [
          deriveRefreshRotationTokens(refreshToken, getPrivateServerSecret(), deviceScope),
          deriveRefreshRotationTokens(refreshToken, getPrivateServerSecret()),
        ].find((candidate) =>
          safeEqual(replayRow.token_hash, hashToken(candidate.licenseToken)) &&
          safeEqual(replayRow.refresh_token_hash, hashToken(candidate.refreshToken))
        );
        if (!replayedTokens) {
          await client.query("rollback");
          return { active: false as const, status: "invalid", code: "invalid_token" as const };
        }
        await attachCustomerIdentity(client, {
          environment,
          identity,
          activationId: replayRow.activation_session_id,
          accountId: replayRow.account_id,
          appVersion: replayRow.activation_app_version,
          source: "license_refresh",
        });
        await client.query("commit");
        return {
          active: true as const,
          status: license.status,
          license,
          ...replayedTokens,
          tokenExpiresAt: toIsoString(replayRow.expires_at),
          refreshExpiresAt: toIsoString(replayRow.refresh_expires_at),
        };
      }

      const rotated = deriveRefreshRotationTokens(
        refreshToken,
        getPrivateServerSecret(),
        deviceScope,
      );
      const tokenExpiresAt = addDays(new Date(), LICENSE_TOKEN_TTL_DAYS).toISOString();
      const refreshExpiresAt = addDays(new Date(), REFRESH_TOKEN_TTL_DAYS).toISOString();

      const revoked = await client.query(
        `
          update public.sidestream_license_tokens
          set revoked_at = now(), updated_at = now()
          where id = $1
            and revoked_at is null
        `,
        [credential.token_id],
      );
      if (revoked.rowCount !== 1) {
        await client.query("rollback");
        return { active: false as const, status: "invalid", code: "revoked" as const };
      }
      await client.query(
        `
          insert into public.sidestream_license_tokens (
            account_id,
            license_id,
            activation_session_id,
            device_id_hash,
            token_hash,
            expires_at,
            refresh_token_hash,
            refresh_expires_at,
            previous_refresh_token_hash,
            previous_refresh_valid_until,
            refresh_rotated_at,
            created_at,
            updated_at
          )
          values (
            $1, $2, $3, $4, $5, $6::timestamptz, $7, $8::timestamptz,
            $9, now() + ($10 * interval '1 second'), now(), now(), now()
          )
        `,
        [
          credential.account_id,
          credential.license_id,
          credential.activation_session_id,
          deviceIdHash,
          hashToken(rotated.licenseToken),
          tokenExpiresAt,
          hashToken(rotated.refreshToken),
          refreshExpiresAt,
          refreshTokenHash,
          REFRESH_RETRY_GRACE_SECONDS,
        ],
      );

      await attachCustomerIdentity(client, {
        environment,
        identity,
        activationId: credential.activation_session_id,
        accountId: credential.account_id,
        appVersion: credential.activation_app_version,
        source: "license_refresh",
      });

      await client.query("commit");
      return {
        active: true as const,
        status: license.status,
        license,
        ...rotated,
        tokenExpiresAt,
        refreshExpiresAt,
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function confirmAccountDeviceTransfer(
  options: ConfirmAccountDeviceTransferOptions,
) {
  const environment = requireMatchingLicenseEnvironment(options.environment);
  if (
    !/^[0-9a-f]{64}$/.test(options.expectedPriorDeviceIdHash) ||
    !/^[0-9a-f]{64}$/.test(options.newDeviceIdHash) ||
    !options.expectedPriorDeviceId ||
    !options.accountId
  ) {
    throw new TypeError("Invalid account device transfer identity");
  }
  if (!["account", "support", "system"].includes(options.initiatedBy)) {
    throw new TypeError("Invalid account device transfer initiator");
  }
  if (!["device_change", "lost_device", "support_override"].includes(options.transferReason)) {
    throw new TypeError("Invalid account device transfer reason");
  }

  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        getAccountDeviceLockKey(options.accountId, environment.namespace),
      ]);
      const selected = await client.query<AccountDeviceRow>(
        `
          select id, device_id_hash, active_slot, activated_at, revoked_at, revocation_reason
          from public.sidestream_account_devices
          where account_id = $1
            and license_namespace = $2
            and id = $3
            and revoked_at is null
          for update
        `,
        [options.accountId, environment.namespace, options.expectedPriorDeviceId],
      );
      const priorDevice = selected.rows[0];
      if (
        !priorDevice ||
        !safeEqual(priorDevice.id, options.expectedPriorDeviceId) ||
        !safeEqual(priorDevice.device_id_hash, options.expectedPriorDeviceIdHash)
      ) {
        await client.query("commit");
        return { transferred: false as const, reason: "binding_changed" as const };
      }
      if (safeEqual(priorDevice.device_id_hash, options.newDeviceIdHash)) {
        await client.query("commit");
        return { transferred: false as const, reason: "same_device" as const };
      }

      const revokedPrior = await client.query(
        `
          update public.sidestream_account_devices
          set revoked_at = now(), revocation_reason = 'replaced'
          where id = $1
            and account_id = $2
            and license_namespace = $3
            and device_id_hash = $4
            and revoked_at is null
        `,
        [
          priorDevice.id,
          options.accountId,
          environment.namespace,
          options.expectedPriorDeviceIdHash,
        ],
      );
      if (revokedPrior.rowCount !== 1) {
        await client.query("rollback");
        return { transferred: false as const, reason: "binding_changed" as const };
      }

      await client.query(
        `
          update public.sidestream_license_tokens
          set revoked_at = now(), updated_at = now()
          where account_id = $1
            and device_id_hash = $2
            and revoked_at is null
        `,
        [options.accountId, options.expectedPriorDeviceIdHash],
      );
      const inserted = await client.query<{ id: string }>(
        `
          insert into public.sidestream_account_devices (
            account_id,
            license_namespace,
            device_id_hash,
            platform,
            app_version,
            build_channel,
            active_slot,
            activated_at,
            last_seen_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, now(), now())
          returning id
        `,
        [
          options.accountId,
          environment.namespace,
          options.newDeviceIdHash,
          normalizeDevicePlatform(options.platform),
          normalizeRegistryAppVersion(options.appVersion),
          getLicenseDiagnosticMetadata({ buildChannel: options.buildChannel }).buildChannel,
          priorDevice.active_slot,
        ],
      );
      const newDeviceId = inserted.rows[0]?.id;
      if (!newDeviceId) throw new Error("Account device transfer insert failed");

      await client.query(
        `
          insert into public.sidestream_device_transfers (
            account_id,
            license_namespace,
            from_device_id,
            to_device_id,
            initiated_by,
            transfer_reason,
            transferred_at
          )
          values ($1, $2, $3, $4, $5, $6, now())
        `,
        [
          options.accountId,
          environment.namespace,
          priorDevice.id,
          newDeviceId,
          options.initiatedBy,
          options.transferReason,
        ],
      );
      const generation = await client.query<{ device_generation: string }>(
        `
          select count(*)::text as device_generation
          from public.sidestream_account_devices d
          where d.account_id = $1
            and d.license_namespace = $2
            and (d.activated_at, d.id) <= (
              select activated_at, id
              from public.sidestream_account_devices
              where id = $3
            )
        `,
        [options.accountId, environment.namespace, newDeviceId],
      );
      const deviceGeneration = generation.rows[0]?.device_generation || "";
      if (!/^[1-9][0-9]*$/.test(deviceGeneration)) {
        throw new Error("Unable to resolve transferred account device generation");
      }

      await client.query("commit");
      return {
        transferred: true as const,
        newDeviceId,
        deviceGeneration,
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function findAccountIdByStripeCustomer(customerId: string) {
  const result = await query<{ id: string }>(
    `
      select id
      from public.sidestream_accounts
      where stripe_customer_id = $1
      limit 1
    `,
    [customerId],
  );

  return result.rows[0]?.id || "";
}

async function findOrCreateAccountForStripeCustomer(
  customerId: string,
  profile: { email?: unknown; name?: unknown } = {},
) {
  if (!customerId) return "";

  let email = normalizeEmail(profile.email);
  let name = cleanString(profile.name, 180);

  if (!email || !name) {
    const customerProfile = await getStripeCustomerProfile(customerId);
    email ||= customerProfile.email;
    name ||= customerProfile.name;
  }

  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `stripe_customer:${customerId}`,
      ]);
      if (email) {
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [
          `sidestream_account:${email}`,
        ]);
      }

      const byCustomer = await client.query<{ id: string }>(
        `
          select id
          from public.sidestream_accounts
          where stripe_customer_id = $1
          limit 1
        `,
        [customerId],
      );

      if (byCustomer.rows[0]?.id) {
        if (email || name) {
          await client.query(
            `
              update public.sidestream_accounts
              set email = coalesce($2, email),
                  display_name = coalesce($3, display_name),
                  updated_at = now()
              where id = $1
            `,
            [byCustomer.rows[0].id, email || null, name || null],
          );
        }
        await client.query("commit");
        return byCustomer.rows[0].id;
      }

      if (!email) {
        await client.query("commit");
        return "";
      }

      const byEmail = await client.query<{ id: string }>(
        `
          update public.sidestream_accounts
          set stripe_customer_id = $2,
              display_name = coalesce($3, display_name),
              updated_at = now()
          where id = (
            select id
            from public.sidestream_accounts
            where email = $1
            order by
              case
                when stripe_customer_id = $2 then 0
                when stripe_customer_id is null then 1
                else 2
              end,
              updated_at desc
            limit 1
          )
          returning id
        `,
        [email, customerId, name || null],
      );

      if (byEmail.rows[0]?.id) {
        await client.query("commit");
        return byEmail.rows[0].id;
      }

      const inserted = await client.query<{ id: string }>(
        `
          insert into public.sidestream_accounts (
            google_sub,
            email,
            display_name,
            stripe_customer_id,
            created_at,
            updated_at
          )
          values (null, $1, $2, $3, now(), now())
          returning id
        `,
        [email, name || null, customerId],
      );

      await client.query("commit");
      return inserted.rows[0].id;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function getStripeCustomerProfile(customerId: string) {
  const customer = await getStripe().customers.retrieve(customerId);
  if (isDeletedStripeCustomer(customer)) {
    return { email: "", name: "" };
  }

  return {
    email: normalizeEmail(customer.email),
    name: cleanString(customer.name, 180),
  };
}

function isDeletedStripeCustomer(
  customer: Stripe.Customer | Stripe.DeletedCustomer,
): customer is Stripe.DeletedCustomer {
  return "deleted" in customer && customer.deleted === true;
}

function normalizeStripeId(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    return typeof value.id === "string" ? value.id : "";
  }
  return "";
}

function timestampToIso(timestamp: unknown) {
  return typeof timestamp === "number"
    ? new Date(timestamp * 1000).toISOString()
    : null;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function hashPrivateIdentifier(value: string) {
  return createHmac("sha256", getPrivateServerSecret()).update(value).digest("hex");
}

function getPrivateServerSecret() {
  return process.env.SIDESTREAM_LICENSE_HASH_SECRET ||
    getOptionalPostgresConnectionString() ||
    "sidestream-license-dev-salt";
}

function getOptionalPostgresConnectionString() {
  return getOptionalRuntimePostgresConnectionString();
}

function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function encodeBase64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function toIsoString(value: Date | string | null | undefined) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function addSeconds(date: Date, seconds: number) {
  return new Date(date.getTime() + seconds * 1000);
}

function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function getCookie(request: IncomingMessage, name: string) {
  const cookieHeader = firstHeaderValue(request.headers.cookie);
  if (!cookieHeader) return "";

  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = part.split("=");
    if (rawKey.trim() === name) {
      return decodeURIComponent(rawValue.join("=").trim());
    }
  }

  return "";
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly?: boolean;
    maxAge?: number;
    path?: string;
    sameSite?: "Lax" | "Strict" | "None";
    secure?: boolean;
  },
) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, options.maxAge)}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function appendSetCookies(response: ServerResponse, cookies: string[]) {
  const existing = response.getHeader("Set-Cookie");
  const next = Array.isArray(existing)
    ? [...existing.map(String), ...cookies]
    : existing
      ? [String(existing), ...cookies]
      : cookies;
  response.setHeader("Set-Cookie", next);
}

function shouldUseSecureCookies(request: IncomingMessage) {
  return getBaseUrl(request).startsWith("https://");
}

export function getClientIp(request: IncomingMessage) {
  const candidates = [
    firstHeaderValue(request.headers["x-forwarded-for"]).split(",")[0],
    firstHeaderValue(request.headers["x-real-ip"]),
    firstHeaderValue(request.headers["cf-connecting-ip"]),
    firstHeaderValue(request.headers["x-vercel-forwarded-for"]).split(",")[0],
    request.socket?.remoteAddress || "",
  ];

  for (const candidate of candidates) {
    const ipAddress = normalizeIpAddress(candidate);
    if (ipAddress) return ipAddress;
  }

  return "";
}

function normalizeIpAddress(value: string) {
  let candidate = value.trim();
  if (!candidate || candidate.toLowerCase() === "unknown") return "";

  if (candidate.startsWith("[") && candidate.includes("]")) {
    candidate = candidate.slice(1, candidate.indexOf("]"));
  }

  const ipv4WithPort = candidate.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (ipv4WithPort) {
    candidate = ipv4WithPort[1];
  }

  return isIP(candidate) ? candidate : "";
}

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function getOAuthRequestOrigin(request: IncomingMessage) {
  const forwardedHost = firstHeaderValue(request.headers["x-forwarded-host"])
    .split(",")[0]
    .trim();
  const host = forwardedHost || firstHeaderValue(request.headers.host).trim();
  const forwardedProto = firstHeaderValue(request.headers["x-forwarded-proto"])
    .split(",")[0]
    .trim();
  const proto = forwardedProto || (process.env.VERCEL ? "https" : "http");

  if (!host) return new URL(getBaseUrl(request)).origin;
  return new URL(`${proto}://${host}`).origin;
}

function safeUrlOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

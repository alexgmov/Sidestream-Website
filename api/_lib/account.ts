import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { Pool, PoolClient } from "pg";
import Stripe from "stripe";
import {
  canBindActivationAccount,
  type CredentialDeviceScope,
  createClaimCsrfToken,
  deriveActivationTokenPair,
  deriveRefreshRotationTokens,
  getStripeCheckoutWindow,
  isActivationClaimReplay,
  needsLegacyLicenseCompatibility,
  isActivationTokenReplayAllowed,
  REFRESH_RETRY_GRACE_SECONDS,
  matchesDeviceHash,
  safeEqual,
  sanitizeAccountNextPath,
  validateActivationClaimPost,
  validateClaimCsrfToken,
  verifyPaidCheckoutSession,
} from "./entitlement.js";
import {
  DEVICE_POLICY_ERROR_CODES,
  applyDevicePolicyMode,
  decideDeviceActivation,
  evaluateDeviceCredentialBinding,
  evaluateDeviceTransferLimit,
  getConfirmedDeviceMoveTimestamps,
  getDeviceRevocationErrorCode,
  getDeviceTransferLimitOverride,
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
import {
  getOptionalRuntimePostgresConnectionString,
  getPostgresPool,
  normalizePostgresConnectionString,
  requireRuntimePostgresTarget,
} from "./postgres.js";

const SESSION_COOKIE = "sidestream_session";
const OAUTH_STATE_COOKIE = "sidestream_oauth_state";
const OAUTH_NEXT_COOKIE = "sidestream_oauth_next";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const OAUTH_MAX_AGE_SECONDS = 60 * 10;
const ACTIVATION_TTL_HOURS = 24;
const CHECKOUT_CLAIM_GRACE_SECONDS = 10 * 60;
const LICENSE_TOKEN_TTL_DAYS = 7;
const LEGACY_LICENSE_TOKEN_TTL_DAYS = 365;
const REFRESH_TOKEN_TTL_DAYS = 365;
const ACTIVATION_RECONCILIATION_COOLDOWN_SECONDS = 5;
const ACTIVATION_CLAIM_CSRF_TTL_SECONDS = 10 * 60;
const ACTIVATION_TOKEN_REPLAY_SECONDS = 10 * 60;
const MAX_BODY_BYTES = 64 * 1024;
const DEVICE_POLICY_MODE_ENV = "SIDESTREAM_DEVICE_POLICY_MODE";
const ACCOUNT_DEVICE_LOCK_PREFIX = "sidestream:device-support";
export const DEVICE_DEACTIVATION_INTENT = "deactivate_active_device";
export const SIDESTREAM_PRO_PLAN_KEY = "sidestream_pro";
const SIDESTREAM_LEGACY_UNLIMITED_PLAN_KEY = "sidestream_unlimited";
const SIDESTREAM_PAID_PLAN_KEYS = [
  SIDESTREAM_PRO_PLAN_KEY,
  SIDESTREAM_LEGACY_UNLIMITED_PLAN_KEY,
] as const;
const SIDESTREAM_PRO_DEFAULT_PRODUCT_ID = "prod_UpwXh6oO1OmPyQ";
// Stripe Prices are immutable. Resolve the active $9.99 one-time Price by
// lookup key, creating it once if this deployment is the first to use it.
const SIDESTREAM_PRO_DEFAULT_PRICE_ID = "";
const SIDESTREAM_PRO_PRICE = {
  lookupKey: "sidestream_pro_once_999",
  name: "Sidestream Pro",
  description: "Lifetime Sidestream Pro access for one Mac editor.",
  unitAmount: 999,
  currency: "usd",
};
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

export type AccountSession = {
  accountId: string;
  email: string;
  name: string;
  avatarUrl: string;
  stripeCustomerId: string;
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

export function getGoogleRedirectUri(request: IncomingMessage) {
  return process.env.GOOGLE_REDIRECT_URI ||
    `${getBaseUrl(request)}/api/auth/google/callback`;
}

export function getGoogleAuthUrl(
  request: IncomingMessage,
  options: { state: string },
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

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function setOAuthCookies(
  request: IncomingMessage,
  response: ServerResponse,
  options: { state: string; nextPath: string },
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
    license_status: string | null;
    plan_key: string | null;
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
        l.status as license_status,
        l.plan_key,
        l.current_period_end,
        l.cancel_at_period_end,
        l.grace_until,
        l.features
      from public.sidestream_account_sessions s
      join public.sidestream_accounts a on a.id = s.account_id
      left join public.sidestream_licenses l on l.account_id = a.id
      where s.session_token_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()
      -- Usable licenses first: a grandfathered one-time 'active' row must
      -- outrank a newer cancelled subscription row for the same account.
      order by (case when l.status in ('active', 'trialing') then 0 else 1 end),
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
    license: buildLicenseSummary({
      status: row.license_status,
      planKey: row.plan_key,
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
    },
  };
}

export async function findOrCreateStripeCustomer(session: AccountSession) {
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

  return createStripeCustomerForSession(session);
}

async function createStripeCustomerForSession(session: AccountSession) {
  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email: session.email,
    name: session.name || undefined,
    metadata: {
      sidestream_account_id: session.accountId,
    },
  });

  await query(
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
    const price = await getStripe().prices.retrieve(
      configuredPriceId,
      {},
      getStripeRequestOptions(),
    );
    if (isSidestreamProPriceShape(price, productId)) return price.id;

    throw new Error(
      `Configured SIDESTREAM_PRO_PRICE_ID ${configuredPriceId} is not the active $9.99 one-time Sidestream Pro price for product ${productId}`,
    );
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
    throw new Error(`Configured Sidestream Pro product ${productId} was deleted in Stripe`);
  }

  if (!product.active) {
    throw new Error(`Configured Sidestream Pro product ${productId} is not active in Stripe`);
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
      `Stripe lookup key ${SIDESTREAM_PRO_PRICE.lookupKey} points to a price that is not the active $9.99 one-time Sidestream Pro price for product ${productId}`,
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
      getStripeRequestOptions(),
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
  },
) {
  const activationKey = randomToken(24);
  const expiresAt = addHours(new Date(), ACTIVATION_TTL_HOURS);
  const deviceId = cleanString(payload.deviceId, 240);
  if (!deviceId) throw new Error("Missing device ID");

  await query(
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
    `,
    [
      activationKey,
      hashPrivateIdentifier(deviceId),
      cleanString(payload.appVersion, 80) || null,
      cleanString(payload.buildChannel, 80) || null,
      cleanString(payload.source, 120) || "plugin",
      getClientIp(request) || null,
      cleanString(request.headers["user-agent"], 500) || null,
      expiresAt.toISOString(),
    ],
  );

  return {
    activationKey,
    expiresAt: expiresAt.toISOString(),
    upgradeUrl: `${getBaseUrl(request)}/api/checkout/start?activation=${encodeURIComponent(activationKey)}`,
    restoreUrl: `${getBaseUrl(request)}/api/activation/claim?activation=${encodeURIComponent(activationKey)}`,
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
}) {
  const result = await query<{ id: string }>(
    `
      update public.sidestream_activation_sessions
      set stripe_checkout_session_id = $2,
          stripe_checkout_price_id = $3,
          stripe_checkout_product_id = $4,
          checkout_attached_at = coalesce(checkout_attached_at, now()),
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
) {
  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      const selected = await client.query<{
        account_id: string | null;
        status: string;
        completed_at: Date | string | null;
        expired: boolean;
      }>(
        `
          select
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
  } = {},
) {
  const environment = requireMatchingLicenseEnvironment(options.environment);
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
        l.current_period_end,
        l.cancel_at_period_end,
        l.grace_until,
        l.features
      from public.sidestream_activation_sessions a
      left join public.sidestream_licenses l on l.account_id = a.account_id
      where a.activation_key = $1
      -- Usable licenses first: a grandfathered one-time 'active' row must
      -- outrank a newer cancelled subscription row for the same account.
      order by (case when l.status in ('active', 'trialing') then 0 else 1 end),
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

  const license = buildLicenseSummary({
    status: row.license_status,
    planKey: row.plan_key,
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
  });

  if (!issued.issued && issued.code) {
    return {
      status: issued.code,
      code: issued.code,
      license,
    };
  }

  if (issued.issued) {
    await query(
      `
        update public.sidestream_activation_sessions
        set license_id = $2,
            completed_at = coalesce(completed_at, now()),
            status = 'linked',
            updated_at = now()
        where id = $1
      `,
      [row.activation_id, row.license_id],
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
) {
  const environment = requireMatchingLicenseEnvironment(environmentInput);
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
        expires_at: Date | string;
        revoked_at: Date | string | null;
        created_at: Date | string;
        device_id_hash: string | null;
        activation_app_version: string | null;
        activation_build_channel: string | null;
        status: string | null;
        plan_key: string | null;
        current_period_end: Date | string | null;
        cancel_at_period_end: boolean | null;
        grace_until: Date | string | null;
        features: Record<string, unknown> | null;
      }>(
        `
          select
            t.id as token_id,
            t.account_id,
            t.expires_at,
            t.revoked_at,
            t.created_at,
            t.device_id_hash,
            a.app_version as activation_app_version,
            a.build_channel as activation_build_channel,
            l.status,
            l.plan_key,
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

      const legacyTokenExpiresAt = needsLegacyLicenseCompatibility(row.activation_app_version)
        ? addDays(new Date(), LEGACY_LICENSE_TOKEN_TTL_DAYS).toISOString()
        : "";
      const updated = await client.query<{ expires_at: Date | string }>(
        `
          update public.sidestream_license_tokens
          set last_seen_at = now(),
              expires_at = case
                when $2::timestamptz is not null then greatest(expires_at, $2::timestamptz)
                else expires_at
              end,
              updated_at = now()
          where id = $1
            and revoked_at is null
          returning expires_at
        `,
        [row.token_id, legacyTokenExpiresAt || null],
      );
      if (!updated.rows[0]) {
        await client.query("rollback");
        return { active: false as const, status: "invalid", code: "revoked" as const };
      }

      await client.query("commit");
      return {
        active: true as const,
        status: license.status,
        tokenExpiresAt: toIsoString(updated.rows[0].expires_at),
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

  const stripeEventId = stripeEvent ? cleanString(stripeEvent.eventId, 255) : "";
  const stripeEventCreatedAt = stripeEvent && Number.isFinite(stripeEvent.created)
    ? new Date(stripeEvent.created * 1_000).toISOString()
    : null;
  if (stripeEvent && (!stripeEventId || !stripeEventCreatedAt)) {
    throw new TypeError("Stripe event ordering requires an event ID and creation time");
  }

  const accountId = accountIdHint || await findOrCreateAccountForStripeCustomer(customerId);
  if (!accountId) return { fulfilled: false as const, reason: "missing_account" };

  await query(
    `
      update public.sidestream_accounts
      set stripe_customer_id = $2, updated_at = now()
      where id = $1
    `,
    [accountId, customerId],
  );

  const price = subscription.items?.data?.[0]?.price;
  const status = cleanString(subscription.status, 80) || "unknown";
  const currentPeriodEnd = timestampToIso(subscription.current_period_end);
  const cancelAtPeriodEnd = Boolean(subscription.cancel_at_period_end || subscription.cancel_at);
  const planKey = cleanString(
    price?.lookup_key || price?.nickname || price?.id || SIDESTREAM_LEGACY_UNLIMITED_PLAN_KEY,
    120,
  ) || SIDESTREAM_LEGACY_UNLIMITED_PLAN_KEY;
  const graceUntil = shouldGrantGrace(status)
    ? addDays(new Date(), LICENSE_TOKEN_TTL_DAYS).toISOString()
    : null;
  const features = {
    unlimited_downloads: isLicenseStatusUsable(status),
    customer_portal: true,
  };

  const result = await query<{ id: string }>(
    `
      insert into public.sidestream_licenses (
        account_id,
        stripe_customer_id,
        stripe_subscription_id,
        plan_key,
        status,
        current_period_end,
        cancel_at_period_end,
        grace_until,
        features,
        stripe_state_event_created_at,
        stripe_state_event_id,
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4, $5, $6::timestamptz, $7, $8::timestamptz, $9::jsonb,
        $10::timestamptz, $11, now(), now()
      )
      on conflict (stripe_subscription_id) do update set
        account_id = excluded.account_id,
        stripe_customer_id = excluded.stripe_customer_id,
        plan_key = excluded.plan_key,
        status = excluded.status,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        grace_until = excluded.grace_until,
        features = excluded.features || case
          when sidestream_licenses.account_id = excluded.account_id
            and sidestream_licenses.features ? 'singleDevicePolicy'
            then jsonb_build_object(
              'singleDevicePolicy',
              sidestream_licenses.features -> 'singleDevicePolicy'
            )
          else '{}'::jsonb
        end,
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
          and excluded.stripe_state_event_id >= coalesce(sidestream_licenses.stripe_state_event_id, '')
        )
      returning id
    `,
    [
      accountId,
      customerId,
      subscriptionId,
      planKey,
      status,
      currentPeriodEnd,
      cancelAtPeriodEnd,
      graceUntil,
      JSON.stringify(features),
      stripeEventCreatedAt,
      stripeEventId || null,
    ],
  );
  return result.rows[0]
    ? { fulfilled: true as const, applied: true as const }
    : { fulfilled: true as const, applied: false as const, reason: "stale_event" };
}

export async function upsertLicenseFromCheckoutSession(
  sessionPayload: unknown,
) {
  const checkoutSessionId = normalizeStripeId(
    (sessionPayload as { id?: unknown } | null)?.id,
  );
  if (!checkoutSessionId) return { fulfilled: false as const, reason: "missing_session_id" };
  return fulfillCheckoutSession(checkoutSessionId);
}

export async function fulfillCheckoutSession(
  checkoutSessionId: string,
  expectedActivationKey = "",
) {
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

  const subscriptionId = normalizeStripeId(checkoutSession.subscription);
  if (subscriptionId) {
    if (
      checkoutSession.status !== "complete" ||
      !isSidestreamPaidPlanKey(cleanString(checkoutSession.metadata?.sidestream_plan, 120))
    ) {
      return { fulfilled: false as const, reason: "invalid_subscription_checkout" };
    }
    const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
    const subscriptionResult = await upsertLicenseFromSubscription(subscription);
    if (!subscriptionResult.fulfilled) return subscriptionResult;
    return { fulfilled: true as const, activationBound: false };
  }

  let expectedPriceId = activationKey
    ? cleanString(checkoutSession.metadata?.sidestream_price_id, 160)
    : await getSidestreamProPriceId();
  let expectedProductId = getSidestreamProProductId();
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
    activationId = row.id;
    expectedPriceId = row.stripe_checkout_price_id;
    expectedProductId = row.stripe_checkout_product_id;
  }

  const verification = verifyPaidCheckoutSession(checkoutSession, {
    sessionId: checkoutSessionId,
    activationKey: activationKey || undefined,
    priceId: expectedPriceId,
    productId: expectedProductId,
    paidPlanKeys: SIDESTREAM_PAID_PLAN_KEYS,
  });
  if (verification.ok === false) {
    return { fulfilled: false as const, reason: verification.reason };
  }

  const customerId = normalizeStripeId(checkoutSession.customer);
  if (!customerId) return { fulfilled: false as const, reason: "missing_customer" };

  const stripeAccountId = await findOrCreateAccountForStripeCustomer(customerId, {
    email: checkoutSession.customer_details?.email || checkoutSession.customer_email,
    name: checkoutSession.customer_details?.name,
  });
  const metadataAccountId = cleanString(
    checkoutSession.metadata?.sidestream_account_id,
    80,
  );
  const accountId = stripeAccountId || metadataAccountId;
  if (!accountId) return { fulfilled: false as const, reason: "missing_account" };

  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `checkout_session:${checkoutSessionId}`,
      ]);

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

      const licenseId = await upsertLicenseFromOneTimeCheckoutSession({
        accountId,
        customerId,
        checkoutSessionId,
        paymentIntentId: normalizeStripeId(checkoutSession.payment_intent),
      }, client);

      let activationBound = false;
      if (activationKey && activationId && activationCanBind) {
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

      await client.query("commit");
      return { fulfilled: true as const, activationBound };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function upsertLicenseFromOneTimeCheckoutSession(options: {
  accountId: string;
  customerId: string;
  checkoutSessionId: string;
  paymentIntentId: string;
}, runner: Pool | PoolClient) {
  const result = await runner.query<{ id: string }>(
    `
      insert into public.sidestream_licenses (
        account_id,
        stripe_customer_id,
        stripe_subscription_id,
        stripe_checkout_session_id,
        stripe_payment_intent_id,
        plan_key,
        status,
        current_period_end,
        cancel_at_period_end,
        grace_until,
        features,
        created_at,
        updated_at
      )
      values ($1, $2, null, $3, $4, $5, 'active', null, false, null, $6::jsonb, now(), now())
      on conflict (stripe_checkout_session_id) do update set
        account_id = excluded.account_id,
        stripe_customer_id = excluded.stripe_customer_id,
        stripe_payment_intent_id = excluded.stripe_payment_intent_id,
        plan_key = excluded.plan_key,
        status = excluded.status,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        grace_until = excluded.grace_until,
        features = excluded.features || case
          when sidestream_licenses.account_id = excluded.account_id
            and sidestream_licenses.features ? 'singleDevicePolicy'
            then jsonb_build_object(
              'singleDevicePolicy',
              sidestream_licenses.features -> 'singleDevicePolicy'
            )
          else '{}'::jsonb
        end,
        updated_at = now()
      returning id
    `,
    [
      options.accountId,
      options.customerId,
      options.checkoutSessionId,
      options.paymentIntentId || null,
      SIDESTREAM_PRO_PLAN_KEY,
      JSON.stringify({
        unlimited_downloads: true,
        customer_portal: true,
        one_time_purchase: true,
      }),
    ],
  );
  return result.rows[0]?.id || "";
}

export function sanitizeNextPath(value: unknown) {
  return sanitizeAccountNextPath(value);
}

export function cleanString(value: unknown, maxLength = 240) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
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
  currentPeriodEnd?: Date | string | null;
  cancelAtPeriodEnd?: boolean | null;
  graceUntil?: Date | string | null;
  features?: Record<string, unknown> | null;
}): LicenseSummary {
  const status = cleanString(options.status, 80) || "free";
  const graceUntil = toIsoString(options.graceUntil);
  const active = isLicenseStatusUsable(status) ||
    Boolean(graceUntil && new Date(graceUntil).getTime() > Date.now());

  return {
    active,
    plan: active ? (cleanString(options.planKey, 120) || SIDESTREAM_PRO_PLAN_KEY) : "free",
    status,
    currentPeriodEnd: toIsoString(options.currentPeriodEnd),
    cancelAtPeriodEnd: Boolean(options.cancelAtPeriodEnd),
    graceUntil,
    features: active
      ? { unlimited_downloads: true, customer_portal: true, ...(options.features || {}) }
      : { unlimited_downloads: false, customer_portal: true, ...(options.features || {}) },
  };
}

function isLicenseStatusUsable(status: string) {
  return status === "active" || status === "trialing";
}

function isSidestreamPaidPlanKey(planKey: string) {
  return planKey === SIDESTREAM_PRO_PLAN_KEY ||
    planKey === SIDESTREAM_LEGACY_UNLIMITED_PLAN_KEY;
}

function shouldGrantGrace(status: string) {
  return status === "past_due" || status === "unpaid";
}

type AccountDeviceRow = {
  id: string;
  device_id_hash: string;
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
      select id, device_id_hash, activated_at, revoked_at, revocation_reason
      from public.sidestream_account_devices
      where account_id = $1
        and license_namespace = $2
        and revoked_at is null
      order by activated_at desc, id desc
      limit 1
      for update
    `,
    [options.accountId, options.namespace],
  );
  let activeDevice = activeResult.rows[0] || null;

  let latestRequestedResult = await client.query<AccountDeviceRow>(
    `
      select id, device_id_hash, activated_at, revoked_at, revocation_reason
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
    !activeDevice &&
    options.claimEmpty !== false &&
    !(options.purpose === "credential" && latestRequestedDevice?.revoked_at)
  ) {
    if (options.purpose === "activation") {
      const transferLimit = await getEmptySlotTransferLimitState(client, {
        accountId: options.accountId,
        namespace: options.namespace,
        requestedDeviceIdHash: options.requestedDeviceIdHash,
        licenseFeatures: options.licenseFeatures,
      });
      if (!transferLimit.allowed) {
        return {
          allowed: false,
          code: DEVICE_POLICY_ERROR_CODES.TRANSFER_LIMIT_REACHED,
        };
      }
    }
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
          activated_at,
          last_seen_at
        )
        select $1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()), now()
        where not exists (
          select 1
          from public.sidestream_account_devices
          where account_id = $1
            and license_namespace = $2
            and revoked_at is null
        )
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
        select id, device_id_hash, activated_at, revoked_at, revocation_reason
        from public.sidestream_account_devices
        where account_id = $1
          and license_namespace = $2
          and revoked_at is null
        order by activated_at desc, id desc
        limit 1
        for update
      `,
      [options.accountId, options.namespace],
    );
    activeDevice = activeResult.rows[0] || null;
    latestRequestedResult = await client.query<AccountDeviceRow>(
      `
        select id, device_id_hash, activated_at, revoked_at, revocation_reason
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
    if (
      latestRequestedDevice?.revoked_at &&
      !safeEqual(activeDevice.device_id_hash, options.requestedDeviceIdHash)
    ) {
      return {
        allowed: false,
        code: getDeviceRevocationErrorCode(
          latestRequestedDevice.revocation_reason === "deactivated"
            ? "deactivated"
            : "replaced",
        ),
      };
    }
    const activationDecision = decideDeviceActivation({
      namespace: options.namespace,
      requestedDeviceIdHash: options.requestedDeviceIdHash,
      activeDevice: activePolicyRecord,
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
    await client.query(
      `
        update public.sidestream_account_devices
        set last_seen_at = greatest(last_seen_at, now()),
            platform = case when platform = 'unknown' then $2 else platform end,
            app_version = coalesce($3, app_version),
            build_channel = coalesce($4, build_channel)
        where id = $1
          and revoked_at is null
      `,
      [
        activeDevice.id,
        normalizeDevicePlatform(options.platform),
        normalizeRegistryAppVersion(options.appVersion),
        getLicenseDiagnosticMetadata({ buildChannel: options.buildChannel }).buildChannel,
      ],
    );
  }

  const generation = await client.query<{ device_generation: string }>(
    `
      select count(*)::text as device_generation
      from public.sidestream_account_devices
      where account_id = $1
        and license_namespace = $2
    `,
    [options.accountId, options.namespace],
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

async function getEmptySlotTransferLimitState(
  client: PoolClient,
  options: {
    accountId: string;
    namespace: DeviceNamespace;
    requestedDeviceIdHash: string;
    licenseFeatures?: Record<string, unknown> | null;
  },
) {
  const devices = await client.query<{
    id: string;
    device_id_hash: string;
    activated_at: Date | string;
  }>(
    `
      select id, device_id_hash, activated_at
      from public.sidestream_account_devices
      where account_id = $1
        and license_namespace = $2
      order by activated_at asc, id asc
    `,
    [options.accountId, options.namespace],
  );
  const latestDevice = devices.rows.at(-1);
  if (
    !latestDevice ||
    safeEqual(latestDevice.device_id_hash, options.requestedDeviceIdHash)
  ) {
    return { allowed: true as const };
  }

  const transfers = await client.query<{
    from_device_id: string;
    to_device_id: string;
    transferred_at: Date | string;
  }>(
    `
      select from_device_id, to_device_id, transferred_at
      from public.sidestream_device_transfers
      where account_id = $1
        and license_namespace = $2
      order by transferred_at asc, id asc
    `,
    [options.accountId, options.namespace],
  );
  const nowMs = Date.now();
  return evaluateDeviceTransferLimit({
    transferTimestampsMs: getConfirmedDeviceMoveTimestamps({
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
    }),
    nowMs,
    configuredLimit: getDeviceTransferLimitOverride(
      options.licenseFeatures,
      options.namespace,
      nowMs,
    ),
  });
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
        `,
        [credential.token_id, tokenHash],
      );
      if (touched.rowCount !== 1) {
        await client.query("rollback");
        return deniedDownloadAuthorization(
          DEVICE_POLICY_ERROR_CODES.DEVICE_DEACTIVATED,
        );
      }
      await client.query(
        `
          update public.sidestream_account_devices
          set last_seen_at = greatest(last_seen_at, now())
          where id = $1
            and account_id = $2
            and license_namespace = $3
            and revoked_at is null
        `,
        [binding.activeDeviceId, credential.account_id, environment.namespace],
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
      limit 1
    `,
    [accountId, environment.namespace],
  );
  const device = result.rows[0];
  if (!device) return { active: false as const, device: null };

  return {
    active: true as const,
    device: {
      platform: normalizeDevicePlatform(device.platform),
      activatedAt: toIsoString(device.activated_at),
      lastSeenAt: toIsoString(device.last_seen_at),
    },
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
          order by activated_at desc, id desc
          limit 1
          for update
        `,
        [options.accountId, environment.namespace],
      );
      const activeDeviceId = selected.rows[0]?.id || "";
      if (activeDeviceId) {
        const revokedDevice = await client.query(
          `
            update public.sidestream_account_devices
            set revoked_at = now(), revocation_reason = 'deactivated'
            where id = $1
              and account_id = $2
              and license_namespace = $3
              and revoked_at is null
          `,
          [activeDeviceId, options.accountId, environment.namespace],
        );
        if (revokedDevice.rowCount !== 1) {
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
        deactivated: Boolean(activeDeviceId),
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
          const extended = await client.query<{ expires_at: Date | string }>(
            `
              update public.sidestream_license_tokens
              set expires_at = greatest(expires_at, $2::timestamptz), updated_at = now()
              where id = $1
                and revoked_at is null
              returning expires_at
            `,
            [row.token_id, tokenExpiresAt],
          );
          if (!extended.rows[0]) {
            await client.query("rollback");
            return { issued: false as const, code: "revoked" as const };
          }
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
  current_period_end: Date | string | null;
  cancel_at_period_end: boolean | null;
  grace_until: Date | string | null;
  features: Record<string, unknown> | null;
};

export async function refreshLicenseToken(
  refreshToken: string,
  deviceId: string,
  environmentInput?: ResolvedLicenseEnvironment,
) {
  if (!refreshToken || !deviceId) {
    return { active: false as const, status: "invalid", code: "invalid_token" as const };
  }

  const environment = requireMatchingLicenseEnvironment(environmentInput);
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
          select id, device_id_hash, activated_at, revoked_at, revocation_reason
          from public.sidestream_account_devices
          where account_id = $1
            and license_namespace = $2
            and revoked_at is null
          order by activated_at desc, id desc
          limit 1
          for update
        `,
        [options.accountId, environment.namespace],
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
            and revoked_at is null
        `,
        [options.accountId],
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
            activated_at,
            last_seen_at
          )
          values ($1, $2, $3, $4, $5, $6, now(), now())
          returning id
        `,
        [
          options.accountId,
          environment.namespace,
          options.newDeviceIdHash,
          normalizeDevicePlatform(options.platform),
          normalizeRegistryAppVersion(options.appVersion),
          getLicenseDiagnosticMetadata({ buildChannel: options.buildChannel }).buildChannel,
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
          from public.sidestream_account_devices
          where account_id = $1
            and license_namespace = $2
        `,
        [options.accountId, environment.namespace],
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

function hashPrivateIdentifier(value: string) {
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

function getClientIp(request: IncomingMessage) {
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

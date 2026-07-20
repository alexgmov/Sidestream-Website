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
  createCheckoutIntentToken,
  createPluginUpgradeIntentToken,
  createClaimCsrfToken,
  deriveActivationTokenPair,
  deriveRefreshRotationTokens,
  getCheckoutSessionIdempotencyKey,
  getStripeCustomerIdempotencyKey,
  getStripeCheckoutWindow,
  getStripePriceIdempotencyKey,
  hasSameOrigin,
  isActivationClaimReplay,
  isCanonicalLicenseEntitlementUsable,
  needsLegacyLicenseCompatibility,
  isActivationTokenReplayAllowed,
  parseStripeIdAllowlist,
  planOneTimeEntitlementTransition,
  REFRESH_RETRY_GRACE_SECONDS,
  matchesDeviceHash,
  safeEqual,
  sanitizeAccountNextPath,
  shouldUseDirectPluginUpgradeHandoff,
  validateCheckoutIntentToken,
  validatePluginUpgradeIntentToken,
  validateActivationClaimPost,
  validateClaimCsrfToken,
  verifyPaidCheckoutSession,
  verifyLegacySubscriptionEntitlement,
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

const SESSION_COOKIE = "sidestream_session";
const OAUTH_STATE_COOKIE = "sidestream_oauth_state";
const OAUTH_NEXT_COOKIE = "sidestream_oauth_next";
const OAUTH_PLUGIN_UPGRADE_COOKIE = "sidestream_oauth_plugin_upgrade";
const OAUTH_CHECKOUT_INTENT_COOKIE = "sidestream_oauth_checkout_intent";
const OAUTH_CHECKOUT_ROTATE_COOKIE = "sidestream_oauth_checkout_rotate";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const OAUTH_MAX_AGE_SECONDS = 60 * 10;
const ACTIVATION_TTL_HOURS = 24;
const CHECKOUT_CLAIM_GRACE_SECONDS = 10 * 60;
const LICENSE_TOKEN_TTL_DAYS = 7;
const LEGACY_LICENSE_TOKEN_TTL_DAYS = 365;
const REFRESH_TOKEN_TTL_DAYS = 365;
const ACTIVATION_RECONCILIATION_COOLDOWN_SECONDS = 5;
const ACTIVATION_CLAIM_CSRF_TTL_SECONDS = 10 * 60;
const CHECKOUT_INTENT_CSRF_TTL_SECONDS = 10 * 60;
const CHECKOUT_INTENT_TTL_HOURS = 24;
const ACTIVATION_TOKEN_REPLAY_SECONDS = 10 * 60;
const MAX_BODY_BYTES = 64 * 1024;
const DEVICE_POLICY_MODE_ENV = "SIDESTREAM_DEVICE_POLICY_MODE";
const ACCOUNT_DEVICE_LOCK_PREFIX = "sidestream:device-support";
export const DEVICE_DEACTIVATION_INTENT = "deactivate_active_device";
export const SIDESTREAM_PRO_PLAN_KEY = "sidestream_pro";
const SIDESTREAM_LEGACY_UNLIMITED_PLAN_KEY = "sidestream_unlimited";
const SIDESTREAM_PAID_PLAN_KEYS = CANONICAL_PAID_PLAN_KEYS;
const LEGACY_SUBSCRIPTION_PRODUCT_IDS_ENV =
  "SIDESTREAM_LEGACY_SUBSCRIPTION_PRODUCT_IDS";
const LEGACY_SUBSCRIPTION_PRICE_IDS_ENV =
  "SIDESTREAM_LEGACY_SUBSCRIPTION_PRICE_IDS";
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
// Production can still use the pre-lifecycle license schema. JSON extraction
// avoids a parse-time column lookup while preserving canonical migrated state
// whenever the lifecycle field exists.
const LICENSE_ENTITLEMENT_STATUS_SQL = `
  case
    when l.id is null then null
    when to_jsonb(l) ? 'entitlement_status'
      then to_jsonb(l) ->> 'entitlement_status'
    when l.stripe_checkout_session_id is not null
      and l.status in ('active', 'trialing')
      and l.plan_key in ('sidestream_pro', 'sidestream_unlimited') then 'active'
    else 'unknown'
  end
`;
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

export type CheckoutIntentConfirmation = {
  intentId: string;
  browserToken: string;
  signedToken: string;
  signedTokenExpiresAt: string;
  intentExpiresAt: string;
  kind: CheckoutIntentKind;
  activationKey: string;
  state: string;
  hasCheckoutSession: boolean;
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
  options: {
    state: string;
    nextPath: string;
    pluginUpgradeToken?: string;
    checkoutIntentToken?: string;
    rotateCancelledCheckout?: boolean;
  },
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
    serializeCookie(
      OAUTH_PLUGIN_UPGRADE_COOKIE,
      options.pluginUpgradeToken || "",
      {
        httpOnly: true,
        maxAge: options.pluginUpgradeToken ? OAUTH_MAX_AGE_SECONDS : 0,
        path: "/",
        sameSite: "Lax",
        secure: shouldUseSecureCookies(request),
      },
    ),
    serializeCookie(
      OAUTH_CHECKOUT_INTENT_COOKIE,
      options.checkoutIntentToken || "",
      {
        httpOnly: true,
        maxAge: options.checkoutIntentToken ? OAUTH_MAX_AGE_SECONDS : 0,
        path: "/",
        sameSite: "Lax",
        secure: shouldUseSecureCookies(request),
      },
    ),
    serializeCookie(
      OAUTH_CHECKOUT_ROTATE_COOKIE,
      options.checkoutIntentToken && options.rotateCancelledCheckout
        ? "cancelled"
        : "",
      {
        httpOnly: true,
        maxAge: options.checkoutIntentToken && options.rotateCancelledCheckout
          ? OAUTH_MAX_AGE_SECONDS
          : 0,
        path: "/",
        sameSite: "Lax",
        secure: shouldUseSecureCookies(request),
      },
    ),
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
    serializeCookie(OAUTH_PLUGIN_UPGRADE_COOKIE, "", {
      httpOnly: true,
      maxAge: 0,
      path: "/",
      sameSite: "Lax",
      secure: shouldUseSecureCookies(request),
    }),
    serializeCookie(OAUTH_CHECKOUT_INTENT_COOKIE, "", {
      httpOnly: true,
      maxAge: 0,
      path: "/",
      sameSite: "Lax",
      secure: shouldUseSecureCookies(request),
    }),
    serializeCookie(OAUTH_CHECKOUT_ROTATE_COOKIE, "", {
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

export function readPluginUpgradeIntentToken(value: unknown) {
  const token = cleanString(value, 500);
  return {
    token,
    activationKey: token
      ? validatePluginUpgradeIntentToken({
          token,
          nowSeconds: Math.floor(Date.now() / 1_000),
          secret: getPrivateServerSecret(),
        })
      : "",
  };
}

export function getOAuthPluginUpgradeIntent(request: IncomingMessage) {
  const parsed = readPluginUpgradeIntentToken(
    getCookie(request, OAUTH_PLUGIN_UPGRADE_COOKIE),
  );
  return {
    requested: Boolean(parsed.token),
    activationKey: parsed.activationKey,
  };
}

export function getOAuthCheckoutIntent(request: IncomingMessage) {
  const browserToken = cleanString(
    getCookie(request, OAUTH_CHECKOUT_INTENT_COOKIE),
    160,
  );
  return {
    requested: Boolean(browserToken),
    browserToken,
    rotateCancelledSession:
      Boolean(browserToken) &&
      getCookie(request, OAUTH_CHECKOUT_ROTATE_COOKIE) === "cancelled",
  };
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

export async function getAccountSessionById(
  accountId: string,
): Promise<AccountSession | null> {
  const result = await query<{
    account_id: string;
    email: string;
    display_name: string | null;
    avatar_url: string | null;
    stripe_customer_id: string | null;
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
        l.status as license_status,
        l.plan_key,
        license_state.entitlement_status,
        l.current_period_end,
        l.cancel_at_period_end,
        l.grace_until,
        l.features
      from public.sidestream_accounts a
      left join public.sidestream_licenses l on l.account_id = a.id
      left join lateral (
        select ${LICENSE_ENTITLEMENT_STATUS_SQL} as entitlement_status
      ) license_state on true
      where a.id = $1::uuid
      order by (case
          when license_state.entitlement_status = 'active'
            and l.plan_key in ('sidestream_pro', 'sidestream_unlimited') then 0
          else 1
        end),
        l.updated_at desc nulls last
      limit 1
    `,
    [accountId],
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
      entitlementStatus: row.entitlement_status,
      currentPeriodEnd: row.current_period_end,
      cancelAtPeriodEnd: row.cancel_at_period_end,
      graceUntil: row.grace_until,
      features: row.features,
    }),
  };
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

type CheckoutIntentRow = {
  id: string;
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
  stripe_session_expires_at: Date | string | null;
  expires_at: Date | string;
  activation_key: string | null;
  activation_expires_at: Date | string | null;
  activation_checkout_session_id: string | null;
};

export async function createCheckoutIntentConfirmation(options: {
  activationKey?: string;
  session?: AccountSession | null;
  now?: Date;
}): Promise<CheckoutIntentConfirmation | null> {
  if (options.session?.license.active) return null;

  const now = options.now || new Date();
  const activationKey = cleanString(options.activationKey, 160);
  const kind: CheckoutIntentKind = activationKey
    ? "activation"
    : options.session ? "account" : "anonymous";
  const intentId = randomUUID();
  const browserToken = randomToken(32);
  const expiresAt = addHours(now, CHECKOUT_INTENT_TTL_HOURS);
  const accountId = options.session?.accountId || null;
  const result = activationKey
    ? await query<{ id: string }>(
        `
          insert into public.sidestream_checkout_intents (
            id, intent_kind, browser_token_hash, account_id,
            activation_session_id, state, attempt, expires_at,
            created_at, updated_at
          )
          select $1::uuid, 'activation', $2, $3::uuid, a.id,
            'pending', 0, $4::timestamptz, $5::timestamptz, $5::timestamptz
          from public.sidestream_activation_sessions a
          where a.activation_key = $6
            and a.expires_at > $5::timestamptz
            and a.completed_at is null
            and a.device_id_hash is not null
            and a.account_id is null
            and a.status = 'pending'
          returning id
        `,
        [
          intentId,
          hashToken(browserToken),
          accountId,
          expiresAt.toISOString(),
          now.toISOString(),
          activationKey,
        ],
      )
    : await query<{ id: string }>(
        `
          insert into public.sidestream_checkout_intents (
            id, intent_kind, browser_token_hash, account_id,
            activation_session_id, state, attempt, expires_at,
            created_at, updated_at
          ) values (
            $1::uuid, $2, $3, $4::uuid, null, 'pending', 0,
            $5::timestamptz, $6::timestamptz, $6::timestamptz
          )
          returning id
        `,
        [
          intentId,
          kind,
          hashToken(browserToken),
          accountId,
          expiresAt.toISOString(),
          now.toISOString(),
        ],
      );
  if (!result.rows[0]) return null;

  return buildCheckoutIntentConfirmation({
    intentId,
    browserToken,
    intentExpiresAt: expiresAt,
    kind,
    activationKey,
    state: "pending",
    hasCheckoutSession: false,
    now,
  });
}

export async function resumeCheckoutIntentConfirmation(options: {
  browserToken: string;
  session?: AccountSession | null;
  deferAccountBindingCheck?: boolean;
  now?: Date;
}): Promise<CheckoutIntentConfirmation | null> {
  const browserToken = cleanString(options.browserToken, 160);
  if (!browserToken) return null;
  const now = options.now || new Date();
  const result = await query<CheckoutIntentRow>(
    `
      select ci.id, ci.intent_kind, ci.account_id, ci.activation_session_id,
        ci.state, ci.attempt, ci.stripe_customer_id,
        ci.stripe_checkout_session_id, ci.stripe_checkout_url,
        ci.stripe_price_id, ci.stripe_product_id,
        ci.stripe_session_expires_at, ci.expires_at,
        a.activation_key, a.expires_at as activation_expires_at,
        a.stripe_checkout_session_id as activation_checkout_session_id
      from public.sidestream_checkout_intents ci
      left join public.sidestream_activation_sessions a
        on a.id = ci.activation_session_id
      where ci.browser_token_hash = $1
        and ci.expires_at > $2::timestamptz
      limit 1
    `,
    [hashToken(browserToken), now.toISOString()],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (
    row.account_id &&
    row.account_id !== options.session?.accountId &&
    !options.deferAccountBindingCheck
  ) return null;
  if (
    row.intent_kind === "activation" &&
    (!row.activation_key ||
      !row.activation_expires_at ||
      new Date(row.activation_expires_at).getTime() <= now.getTime())
  ) return null;

  return buildCheckoutIntentConfirmation({
    intentId: row.id,
    browserToken,
    intentExpiresAt: new Date(row.expires_at),
    kind: row.intent_kind,
    activationKey: row.activation_key || "",
    state: row.state,
    hasCheckoutSession: Boolean(row.stripe_checkout_session_id),
    now,
  });
}

export function validateCheckoutIntentConfirmation(options: {
  intentId: string;
  browserToken: string;
  signedToken: string;
  now?: Date;
}) {
  return validateCheckoutIntentToken({
    intentId: options.intentId,
    browserToken: options.browserToken,
    token: options.signedToken,
    nowSeconds: Math.floor((options.now || new Date()).getTime() / 1_000),
    secret: getPrivateServerSecret(),
  });
}

export async function createOrReuseCheckoutSession(options: {
  intentId: string;
  browserToken: string;
  session: AccountSession | null;
  baseUrl: string;
  rotateCancelledSession?: boolean;
}): Promise<CheckoutIntentResult> {
  const now = new Date();
  const browserTokenHash = hashToken(options.browserToken);
  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      const selected = await client.query<CheckoutIntentRow>(
        `
          select ci.id, ci.intent_kind, ci.account_id,
            ci.activation_session_id, ci.state, ci.attempt,
            ci.stripe_customer_id, ci.stripe_checkout_session_id,
            ci.stripe_checkout_url, ci.stripe_price_id,
            ci.stripe_product_id, ci.stripe_session_expires_at,
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
          "Checkout confirmation expired",
          "intent_expired",
        ));
      }
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
          "Checkout confirmation expired",
          "intent_expired",
        ));
      }
      if (row.account_id && row.account_id !== options.session?.accountId) {
        return commitCheckoutIntentResult(client, checkoutIntentError(
          403,
          "Checkout confirmation does not belong to this account",
          "intent_account_mismatch",
        ));
      }
      if (options.session?.license.active) {
        return commitCheckoutIntentResult(client, checkoutIntentError(
          409,
          "Sidestream Pro is already active. Open your account or use Restore Purchase.",
          "active_license",
        ));
      }

      let attempt = Number(row.attempt) || 0;
      let replacementSessionId = "";
      let activationKey = row.activation_key || "";
      let activationExpiresAt = row.activation_expires_at
        ? new Date(row.activation_expires_at)
        : null;

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
            state: string;
            attempt: number;
            stripe_customer_id: string | null;
            stripe_checkout_url: string | null;
            stripe_price_id: string | null;
            stripe_product_id: string | null;
            stripe_session_expires_at: Date | string | null;
          }>(
            `
              select state, attempt, stripe_customer_id, stripe_checkout_url,
                stripe_price_id, stripe_product_id, stripe_session_expires_at
              from public.sidestream_checkout_intents
              where stripe_checkout_session_id = $1
              order by updated_at desc
              limit 1
            `,
            [attachedSessionId],
          );
          const attached = attachedIntent.rows[0];
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
            });
          }

          const attachedExpiresAt = attached?.stripe_session_expires_at
            ? new Date(attached.stripe_session_expires_at).getTime()
            : 0;
          if (
            !options.rotateCancelledSession &&
            attached?.stripe_checkout_url &&
            attachedExpiresAt > now.getTime()
          ) {
            await attachExistingSessionToCheckoutIntent(client, row.id, {
              sessionId: attachedSessionId,
              url: attached.stripe_checkout_url,
              customerId: attached.stripe_customer_id || "",
              priceId: attached.stripe_price_id || "",
              productId: attached.stripe_product_id || "",
              expiresAt: new Date(attachedExpiresAt),
              attempt,
            });
            return commitCheckoutIntentResult(client, {
              ok: true,
              url: attached.stripe_checkout_url,
              reused: true,
            });
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
              });
            }
            if (
              !options.rotateCancelledSession &&
              stripeSession.status === "open" &&
              stripeSession.url
            ) {
              await attachExistingSessionToCheckoutIntent(client, row.id, {
                sessionId: stripeSession.id,
                url: stripeSession.url,
                customerId: normalizeStripeId(stripeSession.customer),
                priceId: lockedActivation.stripe_checkout_price_id ||
                  cleanString(stripeSession.metadata?.sidestream_price_id, 160),
                productId: lockedActivation.stripe_checkout_product_id ||
                  getSidestreamProProductId(),
                expiresAt: new Date(stripeSession.expires_at * 1_000),
                attempt,
              });
              return commitCheckoutIntentResult(client, {
                ok: true,
                url: stripeSession.url,
                reused: true,
              });
            }
            if (stripeSession.status === "open") {
              await expireCheckoutSession(stripeSession.id, row.id, attempt);
            }
          } else if (options.rotateCancelledSession) {
            await expireCheckoutSession(attachedSessionId, row.id, attempt);
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
          !options.rotateCancelledSession
        ) {
          return commitCheckoutIntentResult(client, {
            ok: true,
            url: row.stripe_checkout_url,
            reused: true,
          });
        }
        if (row.state === "completed") {
          const completionUrl = buildCheckoutCompletionUrl(options.baseUrl)
            .replace(CHECKOUT_SESSION_PLACEHOLDER, row.stripe_checkout_session_id);
          return commitCheckoutIntentResult(client, {
            ok: true,
            url: completionUrl,
            reused: true,
          });
        }
        if (sessionExpiresAt > now.getTime() && options.rotateCancelledSession) {
          await expireCheckoutSession(row.stripe_checkout_session_id, row.id, attempt);
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

      const stripePriceId = await getSidestreamProPriceId();
      const stripeProductId = getSidestreamProProductId();
      const stripeCustomerId = row.intent_kind === "account" && options.session
        ? await findOrCreateStripeCustomer(options.session, client)
        : "";
      const cancelUrl = new URL("/api/checkout/start", options.baseUrl);
      cancelUrl.searchParams.set("checkout", "cancelled");
      cancelUrl.searchParams.set("intent", options.browserToken);
      const metadata: Record<string, string> = {
        sidestream_plan: SIDESTREAM_PRO_PLAN_KEY,
        sidestream_price_id: stripePriceId,
        sidestream_checkout_intent_id: row.id,
      };
      if (row.intent_kind === "account" && options.session) {
        metadata.sidestream_account_id = options.session.accountId;
      }
      if (activationKey) metadata.sidestream_activation_key = activationKey;

      // Anonymous Checkout cannot safely infer prior ownership from an email
      // that Stripe has not collected and verified yet. Intent idempotency
      // prevents retry duplicates; it does not prevent cross-browser purchases.
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
      const checkoutParams: Stripe.Checkout.SessionCreateParams = {
        mode: "payment",
        ...(stripeCustomerId ? { customer: stripeCustomerId } : {}),
        ...(!stripeCustomerId ? { customer_creation: "always" as const } : {}),
        line_items: [{ price: stripePriceId, quantity: 1 }],
        payment_method_types: ["card"],
        allow_promotion_codes: true,
        billing_address_collection: "auto",
        success_url: buildCheckoutCompletionUrl(options.baseUrl, activationKey),
        cancel_url: cancelUrl.toString(),
        ...(checkoutWindow ? { expires_at: checkoutWindow.checkoutExpiresAt } : {}),
        client_reference_id: activationKey || options.session?.accountId || row.id,
        custom_text: {
          submit: { message: "One-time payment. No subscription." },
        },
        invoice_creation: {
          enabled: true,
          invoice_data: { metadata },
        },
        metadata,
        payment_intent_data: { metadata },
      };
      const checkoutSession = await getStripe().checkout.sessions.create(
        checkoutParams,
        {
          ...getStripeRequestOptions(),
          idempotencyKey: getCheckoutSessionIdempotencyKey({
            kind: row.intent_kind,
            intentId: row.id,
            activationKey,
            attempt,
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
      await client.query("commit");
      return { ok: true, url: checkoutSession.url, reused: false };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

function buildCheckoutIntentConfirmation(options: {
  intentId: string;
  browserToken: string;
  intentExpiresAt: Date;
  kind: CheckoutIntentKind;
  activationKey: string;
  state: string;
  hasCheckoutSession: boolean;
  now: Date;
}): CheckoutIntentConfirmation {
  const signedTokenExpiresAt = addSeconds(
    options.now,
    CHECKOUT_INTENT_CSRF_TTL_SECONDS,
  );
  return {
    intentId: options.intentId,
    browserToken: options.browserToken,
    signedToken: createCheckoutIntentToken({
      intentId: options.intentId,
      browserToken: options.browserToken,
      expiresAtSeconds: Math.floor(signedTokenExpiresAt.getTime() / 1_000),
      secret: getPrivateServerSecret(),
    }),
    signedTokenExpiresAt: signedTokenExpiresAt.toISOString(),
    intentExpiresAt: options.intentExpiresAt.toISOString(),
    kind: options.kind,
    activationKey: options.activationKey,
    state: options.state,
    hasCheckoutSession: options.hasCheckoutSession,
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
  },
) {
  await client.query(
    `
      update public.sidestream_checkout_intents
      set state = 'open', attempt = $2, stripe_customer_id = $3,
        stripe_checkout_session_id = $4, stripe_checkout_url = $5,
        stripe_price_id = $6, stripe_product_id = $7,
        stripe_session_expires_at = $8::timestamptz,
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

async function commitCheckoutIntentResult(
  client: PoolClient,
  result: CheckoutIntentResult,
) {
  await client.query("commit");
  return result;
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
  const now = new Date();
  const expiresAt = addHours(now, ACTIVATION_TTL_HOURS);
  const deviceId = cleanString(payload.deviceId, 240);
  const appVersion = cleanString(payload.appVersion, 80);
  const requestedSource = cleanString(payload.source, 120);
  const source = requestedSource || "plugin";
  if (!deviceId) throw new Error("Missing device ID");

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
          appVersion || null,
          cleanString(payload.buildChannel, 80) || null,
          source,
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

  const baseUrl = getBaseUrl(request);
  const checkoutUrl = new URL("/api/checkout/start", baseUrl);
  checkoutUrl.searchParams.set("activation", activationKey);
  let upgradeUrl = checkoutUrl.toString();
  if (shouldUseDirectPluginUpgradeHandoff({
    source: requestedSource,
    appVersion,
  })) {
    const pluginUpgradeUrl = new URL("/api/auth/google/start", baseUrl);
    pluginUpgradeUrl.searchParams.set(
      "plugin_upgrade",
      createPluginUpgradeIntentToken({
        activationKey,
        expiresAtSeconds: Math.floor(
          addSeconds(now, OAUTH_MAX_AGE_SECONDS).getTime() / 1_000,
        ),
        secret: getPrivateServerSecret(),
      }),
    );
    upgradeUrl = pluginUpgradeUrl.toString();
  }

  return {
    activationKey,
    expiresAt: expiresAt.toISOString(),
    upgradeUrl,
    restoreUrl: `${baseUrl}/api/activation/claim?activation=${encodeURIComponent(activationKey)}`,
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

  let expectedPriceId = cleanString(
    checkoutSession.metadata?.sidestream_price_id,
    160,
  );
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
  const canonicalPayment = await retrieveCanonicalCheckoutPayment(
    checkoutSession,
    customerId,
  );
  if (!canonicalPayment.ok) {
    return { fulfilled: false as const, reason: canonicalPayment.reason };
  }

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

      const licenseResult = await upsertLicenseFromOneTimeCheckoutSession({
        accountId,
        customerId,
        checkoutSessionId,
        priceId: expectedPriceId,
        productId: expectedProductId,
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

      await client.query("commit");
      return { fulfilled: true as const, activationBound };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function retrieveCanonicalCheckoutPayment(
  checkoutSession: Stripe.Checkout.Session,
  customerId: string,
) {
  const paymentIntentId = normalizeStripeId(checkoutSession.payment_intent);
  const currency = cleanString(checkoutSession.currency, 3).toLowerCase();
  if (!paymentIntentId) {
    if (
      checkoutSession.payment_status !== "no_payment_required" ||
      checkoutSession.amount_total !== 0 ||
      !/^[a-z]{3}$/.test(currency)
    ) {
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
    disputesHaveMore || (Boolean(charge.disputed) && disputes.length === 0),
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
  const open = statuses.find((status) => [
    "warning_needs_response",
    "warning_under_review",
    "needs_response",
    "under_review",
  ].includes(status));
  if (open) return open;
  const unknown = statuses.find((status) => status && ![
    "warning_closed",
    "prevented",
    "won",
  ].includes(status));
  if (unknown) return "unknown";
  if (disputedWithoutFinalProof) return "unknown";
  if (statuses.includes("won")) return "won";
  if (statuses.includes("prevented")) return "prevented";
  if (statuses.includes("warning_closed")) return "warning_closed";
  return "none";
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
  let canonicalRefund: Stripe.Refund | undefined;
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
    const refundId = normalizeStripeId(payload.id);
    if (!refundId) {
      return { fulfilled: false as const, reason: "missing_refund_id" };
    }
    canonicalRefund = await getStripe().refunds.retrieve(
      refundId,
      { expand: ["charge", "payment_intent"] },
      getStripeRequestOptions(),
    );
    if (canonicalRefund.id !== refundId) {
      return { fulfilled: false as const, reason: "refund_identity_mismatch" };
    }
    if (eventType === "refund.failed" && canonicalRefund.status !== "failed") {
      return { fulfilled: false as const, reason: "refund_status_mismatch" };
    }
    chargeId = normalizeStripeId(canonicalRefund.charge);
    const payloadChargeId = normalizeStripeId(payload.charge);
    if (payloadChargeId && payloadChargeId !== chargeId) {
      return { fulfilled: false as const, reason: "event_charge_mismatch" };
    }
    const canonicalPaymentIntentId = normalizeStripeId(canonicalRefund.payment_intent);
    const payloadPaymentIntentId = normalizeStripeId(payload.payment_intent);
    if (
      payloadPaymentIntentId &&
      canonicalPaymentIntentId &&
      payloadPaymentIntentId !== canonicalPaymentIntentId
    ) {
      return { fulfilled: false as const, reason: "event_payment_intent_mismatch" };
    }
  } else if (eventType === "charge.refunded" || eventType === "charge.updated") {
    chargeId = normalizeStripeId(payload.id);
  } else {
    return { fulfilled: false as const, reason: "unsupported_lifecycle_event" };
  }
  if (!chargeId) return { fulfilled: false as const, reason: "missing_charge_id" };

  const expectedPaymentIntentId = normalizeStripeId(
    canonicalRefund?.payment_intent || payload.payment_intent,
  );
  return withPgClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `one_time_charge:${chargeId}`,
      ]);
      // The provider snapshot that justifies the write is deliberately read
      // after the per-charge fence. A pre-lock snapshot is never applied.
      const canonical = await retrieveCanonicalPaymentFacts({
        chargeId,
        expectedPaymentIntentId: expectedPaymentIntentId || undefined,
        canonicalDispute,
        forceDisputeLookup: true,
      });
      if (!canonical.ok) {
        await client.query("rollback");
        return { fulfilled: false as const, reason: canonical.reason };
      }
      const selected = await selectOneTimeLifecycleLicenses(
        client,
        canonical.facts.paymentIntentId,
        canonical.facts.chargeId,
        true,
      );
      if (selected.length !== 1) {
        await client.query("rollback");
        return {
          fulfilled: false as const,
          reason: selected.length ? "ambiguous_payment_identity" : "missing_license",
        };
      }
      const license = selected[0];
      if (!oneTimeLifecycleIdentityMatches(license, canonical.facts)) {
        await client.query("rollback");
        return { fulfilled: false as const, reason: "payment_identity_mismatch" };
      }
      const reactivationProven = license.entitlement_status === "active"
        ? true
        : await proveCanonicalOneTimeReactivation(license, canonical.facts);
      const fullRefundRecoveryProven = license.status_reason === "full_refund" &&
        canonical.facts.amountPaid > 0 &&
        canonical.facts.amountRefunded < canonical.facts.amountPaid &&
        reactivationProven;

      const result = await upsertLicenseFromOneTimeCheckoutSession({
        accountId: license.account_id,
        customerId: license.stripe_customer_id,
        checkoutSessionId: license.stripe_checkout_session_id,
        priceId: license.stripe_price_id || "",
        productId: license.stripe_product_id || "",
        paymentFacts: {
          ...canonical.facts,
          fullRefundRecoveryProven,
          reactivationProven,
        },
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
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

type OneTimeLifecycleLicense = Readonly<{
  id: string;
  account_id: string;
  account_stripe_customer_id: string | null;
  stripe_customer_id: string;
  stripe_checkout_session_id: string;
  stripe_payment_intent_id: string;
  stripe_charge_id: string | null;
  stripe_price_id: string | null;
  stripe_product_id: string | null;
  plan_key: string;
  entitlement_status: "unknown" | "active" | "suspended" | "revoked";
  status_reason: string;
}>;

async function selectOneTimeLifecycleLicenses(
  runner: Pick<Pool | PoolClient, "query">,
  paymentIntentId: string,
  chargeId: string,
  forUpdate = false,
) {
  const selected = await runner.query<OneTimeLifecycleLicense>(
    `
      select l.id, l.account_id,
        (select a.stripe_customer_id
         from public.sidestream_accounts a
         where a.id = l.account_id) as account_stripe_customer_id,
        l.stripe_customer_id, l.stripe_checkout_session_id,
        l.stripe_payment_intent_id, l.stripe_charge_id,
        l.stripe_price_id, l.stripe_product_id, l.plan_key,
        to_jsonb(l) ->> 'entitlement_status' as entitlement_status,
        l.status_reason
      from public.sidestream_licenses l
      where l.stripe_payment_intent_id = $1
         or l.stripe_charge_id = $2
      order by l.created_at asc
      limit 2
      ${forUpdate ? "for update" : ""}
    `,
    [paymentIntentId, chargeId],
  );
  return selected.rows;
}

function oneTimeLifecycleIdentityMatches(
  license: OneTimeLifecycleLicense,
  facts: CanonicalOneTimePaymentFacts,
) {
  return license.stripe_payment_intent_id === facts.paymentIntentId &&
    license.stripe_customer_id === facts.customerId &&
    (!license.stripe_charge_id || license.stripe_charge_id === facts.chargeId);
}

async function proveCanonicalOneTimeReactivation(
  license: OneTimeLifecycleLicense,
  facts: CanonicalOneTimePaymentFacts,
) {
  if (
    !license.stripe_checkout_session_id ||
    !license.stripe_price_id ||
    !license.stripe_product_id ||
    license.plan_key !== SIDESTREAM_PRO_PLAN_KEY ||
    license.stripe_product_id !== getSidestreamProProductId() ||
    license.stripe_price_id !== await getSidestreamProPriceId() ||
    license.account_stripe_customer_id !== facts.customerId
  ) {
    return false;
  }
  const checkoutSession = await getStripe().checkout.sessions.retrieve(
    license.stripe_checkout_session_id,
    { expand: ["line_items.data.price.product"] },
    getStripeRequestOptions(),
  );
  const verification = verifyPaidCheckoutSession(checkoutSession, {
    sessionId: license.stripe_checkout_session_id,
    priceId: license.stripe_price_id,
    productId: license.stripe_product_id,
    paidPlanKeys: SIDESTREAM_PAID_PLAN_KEYS,
  });
  const metadataAccountId = cleanString(
    checkoutSession.metadata?.sidestream_account_id,
    80,
  );
  return verification.ok &&
    normalizeStripeId(checkoutSession.customer) === facts.customerId &&
    normalizeStripeId(checkoutSession.payment_intent) === facts.paymentIntentId &&
    (!metadataAccountId || metadataAccountId === license.account_id);
}

async function upsertLicenseFromOneTimeCheckoutSession(options: {
  accountId: string;
  customerId: string;
  checkoutSessionId: string;
  priceId: string;
  productId: string;
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
    stripe_price_id: string | null;
    stripe_product_id: string | null;
    currency: string | null;
    entitlement_status: "unknown" | "active" | "suspended" | "revoked";
    status_reason: string;
    stripe_state_event_created_at: Date | string | null;
    stripe_state_event_id: string | null;
  }>(
    `
      select id, account_id, stripe_customer_id, stripe_payment_intent_id,
        stripe_charge_id, stripe_price_id, stripe_product_id, currency,
        entitlement_status, status_reason,
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
      (existing.stripe_price_id && existing.stripe_price_id !== options.priceId) ||
      (existing.stripe_product_id && existing.stripe_product_id !== options.productId) ||
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
          stripe_price_id, stripe_product_id,
          plan_key, status, current_period_end, cancel_at_period_end, grace_until,
          features, amount_paid, amount_refunded, currency,
          entitlement_status, status_reason, revoked_at, suspended_at,
          reconciled_at, stripe_state_event_created_at, stripe_state_event_id,
          created_at, updated_at
        )
        values (
          $1, $2, null, $3, $4, $5, $6, $7, $8, $9, null, false, null, $10::jsonb,
          $11, $12, $13, $14, $15,
          case when $14 = 'revoked' then now() else null end,
          case when $14 = 'suspended' then now() else null end,
          now(), $16::timestamptz, $17, now(), now()
        )
        returning id
      `,
      [
        options.accountId,
        options.customerId,
        options.checkoutSessionId,
        paymentIntentId || null,
        chargeId || null,
        options.priceId,
        options.productId,
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
            stripe_price_id = coalesce(stripe_price_id, nullif($4, '')),
            stripe_product_id = coalesce(stripe_product_id, nullif($5, '')),
            amount_paid = case when $10 then $6 else amount_paid end,
            amount_refunded = case when $10 then $7 else amount_refunded end,
            currency = coalesce(currency, $8),
            plan_key = plan_key,
            status = case when $10 then $11 else status end,
            entitlement_status = case when $10 then $11 else entitlement_status end,
            status_reason = case when $10 then $12 else status_reason end,
            revoked_at = case
              when $10 and $11 = 'revoked' then coalesce(revoked_at, now())
              when $10 and $11 = 'active' then null
              else revoked_at
            end,
            suspended_at = case
              when $10 and $11 = 'suspended' then coalesce(suspended_at, now())
              when $10 and $11 = 'active' then null
              else suspended_at
            end,
            reconciled_at = now(),
            stripe_state_event_created_at = case
              when $10 and $13::timestamptz is not null then $13::timestamptz
              else stripe_state_event_created_at
            end,
            stripe_state_event_id = case
              when $10 and $13::timestamptz is not null then $14
              else stripe_state_event_id
            end,
            features = features || jsonb_build_object(
              'unlimited_downloads', $15::boolean,
              'customer_portal', true,
              'one_time_purchase', true
            ),
            current_period_end = null,
            cancel_at_period_end = false,
            grace_until = null,
            updated_at = now()
        where id = $1
          and plan_key = $9
        returning id, entitlement_status
      `,
      [
        existing.id,
        paymentIntentId || null,
        chargeId || null,
        options.priceId,
        options.productId,
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

function isSidestreamPaidPlanKey(planKey: string) {
  return planKey === SIDESTREAM_PRO_PLAN_KEY ||
    planKey === SIDESTREAM_LEGACY_UNLIMITED_PLAN_KEY;
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

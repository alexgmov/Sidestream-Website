import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { Pool, type PoolClient } from "pg";
import Stripe from "stripe";

const SESSION_COOKIE = "sidestream_session";
const OAUTH_STATE_COOKIE = "sidestream_oauth_state";
const OAUTH_NEXT_COOKIE = "sidestream_oauth_next";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const OAUTH_MAX_AGE_SECONDS = 60 * 10;
const ACTIVATION_TTL_MINUTES = 30;
const LICENSE_TOKEN_TTL_DAYS = 7;
const MAX_BODY_BYTES = 64 * 1024;
export const SIDESTREAM_PRO_PLAN_KEY = "sidestream_pro";
const SIDESTREAM_LEGACY_UNLIMITED_PLAN_KEY = "sidestream_unlimited";
const SIDESTREAM_PRO_DEFAULT_PRODUCT_ID = "prod_UpwXh6oO1OmPyQ";
const SIDESTREAM_PRO_DEFAULT_PRICE_ID = "price_1TqGeBDFKjeGlioXlV8fBGK8";
const SIDESTREAM_PRO_PRICE = {
  lookupKey: "sidestream_pro_once",
  name: "Sidestream Pro",
  description: "Lifetime Sidestream Pro access for one Mac editor.",
  unitAmount: 499,
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
const POSTGRES_URL_ENV_NAMES = [
  "SIDESTREAM_POSTGRES_URL",
  "SIDESTREAM_POSTGRES_PRISMA_URL",
  "SIDESTREAM_POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
];

let pool: Pool | null = null;
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
): Promise<AccountSession | null> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;

  await processUnprocessedStripeEvents();

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
      order by l.updated_at desc nulls last
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

function getSidestreamProProductId() {
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
      `Configured SIDESTREAM_PRO_PRICE_ID ${configuredPriceId} is not the active $4.99 one-time Sidestream Pro price for product ${productId}`,
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
  try {
    const price = await getStripe().prices.retrieve(
      SIDESTREAM_PRO_DEFAULT_PRICE_ID,
      {},
      getStripeRequestOptions(),
    );
    if (isSidestreamProPriceShape(price, productId)) return price.id;

    throw new Error(
      `Default Sidestream Pro price ${SIDESTREAM_PRO_DEFAULT_PRICE_ID} is not the active $4.99 one-time price for product ${productId}`,
    );
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
      `Stripe lookup key ${SIDESTREAM_PRO_PRICE.lookupKey} points to a price that is not the active $4.99 one-time Sidestream Pro price for product ${productId}`,
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
  const expiresAt = addMinutes(new Date(), ACTIVATION_TTL_MINUTES);
  const deviceId = cleanString(payload.deviceId, 240);

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
      deviceId ? hashPrivateIdentifier(deviceId) : null,
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
  };
}

export async function bindActivationToAccount(
  activationKey: string,
  accountId: string,
) {
  if (!activationKey) return;

  await query(
    `
      update public.sidestream_activation_sessions
      set account_id = $2,
          status = case when status = 'pending' then 'authenticated' else status end,
          updated_at = now()
      where activation_key = $1
        and expires_at > now()
        and status <> 'expired'
    `,
    [activationKey, accountId],
  );
}

export async function getActivationStatus(
  activationKey: string,
  deviceId: string,
) {
  await processUnprocessedStripeEvents();

  const result = await query<{
    activation_id: string;
    account_id: string | null;
    license_id: string | null;
    status: string;
    expires_at: Date | string;
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
        a.account_id,
        l.id as license_id,
        a.status,
        a.expires_at,
        l.status as license_status,
        l.plan_key,
        l.current_period_end,
        l.cancel_at_period_end,
        l.grace_until,
        l.features
      from public.sidestream_activation_sessions a
      left join public.sidestream_licenses l on l.account_id = a.account_id
      where a.activation_key = $1
      order by l.updated_at desc nulls last
      limit 1
    `,
    [activationKey],
  );

  const row = result.rows[0];
  if (!row) {
    return { status: "not_found" as const };
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

  const issued = await issueLicenseToken({
    activationId: row.activation_id,
    accountId: row.account_id,
    licenseId: row.license_id,
    deviceId,
  });

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

  return {
    status: "active" as const,
    license,
    licenseToken: issued.token,
    tokenExpiresAt: issued.expiresAt,
  };
}

export async function verifyLicenseToken(
  licenseToken: string,
  deviceId: string,
) {
  const result = await query<{
    token_id: string;
    expires_at: Date | string;
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
        t.expires_at,
        l.status,
        l.plan_key,
        l.current_period_end,
        l.cancel_at_period_end,
        l.grace_until,
        l.features
      from public.sidestream_license_tokens t
      join public.sidestream_licenses l on l.id = t.license_id
      where t.token_hash = $1
        and t.revoked_at is null
        and t.expires_at > now()
        and (t.device_id_hash is null or t.device_id_hash = $2)
      limit 1
    `,
    [hashToken(licenseToken), deviceId ? hashPrivateIdentifier(deviceId) : null],
  );

  const row = result.rows[0];
  if (!row) {
    return {
      active: false,
      status: "invalid",
      license: buildLicenseSummary({}),
    };
  }

  await query(
    `
      update public.sidestream_license_tokens
      set last_seen_at = now(), updated_at = now()
      where id = $1
    `,
    [row.token_id],
  );

  const license = buildLicenseSummary({
    status: row.status,
    planKey: row.plan_key,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    graceUntil: row.grace_until,
    features: row.features,
  });

  return {
    active: license.active,
    status: license.status,
    tokenExpiresAt: toIsoString(row.expires_at),
    license,
  };
}

export async function recordStripeEvent(
  event: Stripe.Event,
  rawPayload: string,
) {
  const result = await query<{ event_id: string }>(
    `
      insert into public.sidestream_stripe_events (
        event_id,
        event_type,
        stripe_created_at,
        payload,
        raw_payload,
        received_at,
        created_at,
        updated_at
      )
      values ($1, $2, to_timestamp($3), $4::jsonb, $5, now(), now(), now())
      on conflict (event_id) do update set
        payload = excluded.payload,
        raw_payload = excluded.raw_payload,
        received_at = now(),
        updated_at = now()
      where public.sidestream_stripe_events.processed_at is null
      returning event_id
    `,
    [
      event.id,
      event.type,
      event.created || Math.floor(Date.now() / 1000),
      JSON.stringify(event),
      rawPayload,
    ],
  );

  return Boolean(result.rows[0]);
}

export async function markStripeEventProcessed(eventId: string) {
  await query(
    `
      update public.sidestream_stripe_events
      set processed_at = now(), updated_at = now()
      where event_id = $1
    `,
    [eventId],
  );
}

export async function processUnprocessedStripeEvents(limit = 10) {
  const result = await query<{
    event_id: string;
    event_type: string;
    payload: Stripe.Event;
  }>(
    `
      select event_id, event_type, payload
      from public.sidestream_stripe_events
      where processed_at is null
      order by created_at asc
      limit $1
    `,
    [limit],
  );

  for (const row of result.rows) {
    switch (row.event_type) {
      case "checkout.session.completed":
        await upsertLicenseFromCheckoutSession(row.payload.data.object);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await upsertLicenseFromSubscription(row.payload.data.object);
        break;
      default:
        break;
    }
    await markStripeEventProcessed(row.event_id);
  }
}

export async function upsertLicenseFromSubscription(
  subscriptionPayload: unknown,
  accountIdHint?: string,
) {
  const subscription = subscriptionPayload as Record<string, any>;
  const customerId = normalizeStripeId(subscription.customer);
  const subscriptionId = normalizeStripeId(subscription.id);
  if (!customerId || !subscriptionId) return;

  const accountId = accountIdHint || await findOrCreateAccountForStripeCustomer(customerId);
  if (!accountId) return;

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

  await query(
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
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8::timestamptz, $9::jsonb, now(), now())
      on conflict (stripe_subscription_id) do update set
        account_id = excluded.account_id,
        stripe_customer_id = excluded.stripe_customer_id,
        plan_key = excluded.plan_key,
        status = excluded.status,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        grace_until = excluded.grace_until,
        features = excluded.features,
        updated_at = now()
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
    ],
  );
}

export async function upsertLicenseFromCheckoutSession(
  sessionPayload: unknown,
) {
  const checkoutSession = sessionPayload as Record<string, any>;
  const mode = cleanString(checkoutSession.mode, 40);
  const checkoutSessionId = normalizeStripeId(checkoutSession.id);
  const paymentIntentId = normalizeStripeId(checkoutSession.payment_intent);
  const paymentStatus = cleanString(checkoutSession.payment_status, 80);
  const planKey = cleanString(checkoutSession.metadata?.sidestream_plan, 120);
  const metadataAccountId = cleanString(checkoutSession.metadata?.sidestream_account_id, 80);
  const activationKey = cleanString(checkoutSession.metadata?.sidestream_activation_key, 120);
  const subscriptionId = normalizeStripeId(checkoutSession.subscription);
  const customerId = normalizeStripeId(checkoutSession.customer);
  const checkoutEmail = checkoutSession.customer_details?.email ||
    checkoutSession.customer_email;
  const checkoutName = checkoutSession.customer_details?.name;
  let accountId = metadataAccountId;

  if (customerId) {
    const stripeAccountId = await findOrCreateAccountForStripeCustomer(customerId, {
      email: checkoutEmail,
      name: checkoutName,
    });
    accountId = stripeAccountId || accountId;
  }

  if (accountId && customerId) {
    await query(
      `
        update public.sidestream_accounts
        set stripe_customer_id = $2, updated_at = now()
        where id = $1
      `,
      [accountId, customerId],
    );
  }

  if (activationKey && accountId) {
    await bindActivationToAccount(activationKey, accountId);
  }

  if (subscriptionId) {
    const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
    await upsertLicenseFromSubscription(subscription, accountId || undefined);
    return;
  }

  if (
    mode === "payment" &&
    checkoutSessionId &&
    customerId &&
    isSidestreamPaidPlanKey(planKey) &&
    (paymentStatus === "paid" || paymentStatus === "no_payment_required")
  ) {
    await upsertLicenseFromOneTimeCheckoutSession({
      accountId,
      customerId,
      checkoutSessionId,
      paymentIntentId,
    });
  }
}

async function upsertLicenseFromOneTimeCheckoutSession(options: {
  accountId: string;
  customerId: string;
  checkoutSessionId: string;
  paymentIntentId: string;
}) {
  if (!options.accountId) return;

  await ensureOneTimeCheckoutLicenseSchema();

  await query(
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
        features = excluded.features,
        updated_at = now()
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
}

async function ensureOneTimeCheckoutLicenseSchema() {
  await query(
    `
      alter table public.sidestream_licenses
        add column if not exists stripe_checkout_session_id text,
        add column if not exists stripe_payment_intent_id text,
        alter column stripe_subscription_id drop not null
    `,
  );

  await query(
    `
      do $$
      begin
        alter table public.sidestream_licenses
          add constraint sidestream_licenses_checkout_session_unique unique (stripe_checkout_session_id);
      exception
        when duplicate_object or duplicate_table then null;
      end $$
    `,
  );

  await query(
    `
      do $$
      begin
        alter table public.sidestream_licenses
          add constraint sidestream_licenses_payment_intent_unique unique (stripe_payment_intent_id);
      exception
        when duplicate_object or duplicate_table then null;
      end $$
    `,
  );
}

async function ensureStripeFirstAccountSchema(client?: PoolClient) {
  const runner = client || getPool();
  await runner.query(
    `
      alter table public.sidestream_accounts
        alter column google_sub drop not null
    `,
  );
}

export function sanitizeNextPath(value: unknown) {
  const nextPath = typeof value === "string" ? value.trim() : "";
  if (!nextPath || !nextPath.startsWith("/") || nextPath.startsWith("//")) {
    return "/account.html";
  }
  if (/[\r\n]/.test(nextPath)) return "/account.html";
  return nextPath.slice(0, 500);
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
  if (!pool) {
    const connectionString = normalizeConnectionString(requirePostgresConnectionString());
    pool = new Pool({
      connectionString,
      max: Number(process.env.POSTGRES_POOL_MAX || 1),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : false,
    });
  }

  return pool;
}

function requirePostgresConnectionString() {
  for (const name of POSTGRES_URL_ENV_NAMES) {
    const value = getValidEnvValue(name);
    if (value) return value;
  }

  throw new Error(`Missing Postgres connection string (${POSTGRES_URL_ENV_NAMES.join(", ")})`);
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
  try {
    const url = new URL(connectionString);
    if (/^(prefer|require)$/i.test(url.searchParams.get("sslmode") || "")) {
      url.searchParams.delete("sslmode");
    }
    return url.toString();
  } catch {
    return connectionString;
  }
}

function shouldUseSsl(connectionString: string) {
  if (process.env.POSTGRES_SSL === "0") return false;
  if (/sslmode=(disable|false)/i.test(connectionString)) return false;
  return !/localhost|127\.0\.0\.1|::1/.test(connectionString);
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

async function issueLicenseToken(options: {
  activationId: string;
  accountId: string;
  licenseId: string;
  deviceId: string;
}) {
  const token = randomToken(32);
  const expiresAt = addDays(new Date(), LICENSE_TOKEN_TTL_DAYS).toISOString();

  await query(
    `
      insert into public.sidestream_license_tokens (
        account_id,
        license_id,
        activation_session_id,
        device_id_hash,
        token_hash,
        expires_at,
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6::timestamptz, now(), now())
    `,
    [
      options.accountId,
      options.licenseId,
      options.activationId,
      options.deviceId ? hashPrivateIdentifier(options.deviceId) : null,
      hashToken(token),
      expiresAt,
    ],
  );

  return { token, expiresAt };
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

      await ensureStripeFirstAccountSchema(client);

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
  const secret = process.env.SIDESTREAM_LICENSE_HASH_SECRET ||
    getOptionalPostgresConnectionString() ||
    "sidestream-license-dev-salt";
  return createHmac("sha256", secret).update(value).digest("hex");
}

function getOptionalPostgresConnectionString() {
  for (const name of POSTGRES_URL_ENV_NAMES) {
    const value = getValidEnvValue(name);
    if (value) return value;
  }
  return "";
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

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
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

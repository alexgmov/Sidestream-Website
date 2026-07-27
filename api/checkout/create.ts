import type { ServerResponse } from "node:http";
import {
  cleanString,
  createCheckoutIntentConfirmation,
  createOrReuseCheckoutSession,
  getBaseUrl,
  getClientIp,
  getSession,
  methodNotAllowed,
  readRequestBody,
  redirect,
  sendJson,
  validateCheckoutIntentConfirmation,
  type AccountRequest,
} from "../_lib/account.js";
import { validateCheckoutIntentPost } from "../_lib/entitlement.js";
import {
  applyRateLimitHeaders,
  consumeRateLimit,
  sendRateLimitExceeded,
} from "../_lib/rate-limit.js";

type CheckoutPayload = {
  activationKey?: unknown;
  checkoutIntentId?: unknown;
  checkoutIntent?: unknown;
  intentToken?: unknown;
  intent?: unknown;
  rotate?: unknown;
};

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "POST").toUpperCase();
  if (method !== "POST") return methodNotAllowed(response, "POST");

  const baseUrl = getBaseUrl(request);
  if (!validateCheckoutIntentPost({
    requestOrigin: firstHeaderValue(request.headers.origin),
    expectedOrigin: baseUrl,
    fetchSite: firstHeaderValue(request.headers["sec-fetch-site"]),
    contentType: firstHeaderValue(request.headers["content-type"]),
  })) {
    return sendJson(response, 403, {
      error: "Invalid Checkout confirmation",
      code: "csrf_rejected",
    });
  }

  let checkoutRequest: Awaited<ReturnType<typeof readCheckoutRequest>>;
  try {
    checkoutRequest = await readCheckoutRequest(request);
  } catch {
    return sendJson(response, 400, { error: "Invalid Checkout request" });
  }
  const { payload, browserForm } = checkoutRequest;
  let intentId = cleanString(payload.checkoutIntentId, 80);
  let browserToken = cleanString(payload.checkoutIntent, 160);
  const signedToken = cleanString(payload.intentToken, 500);
  const legacyActivationKey = cleanString(payload.activationKey, 160);
  const purchaseIntent = cleanString(payload.intent, 32);
  const directAccountPurchase = browserForm &&
    purchaseIntent === "account_purchase" &&
    !legacyActivationKey &&
    !intentId &&
    !browserToken &&
    !signedToken;
  if (
    browserForm &&
    legacyActivationKey &&
    !intentId &&
    !browserToken &&
    !signedToken &&
    purchaseIntent === "purchase"
  ) {
    // The pre-intent restore page can still submit its historical form, but
    // this branch performs no Stripe or account mutation. It only moves the
    // browser to the signed confirmation GET used by 1.0.12/1.0.13 links.
    const confirmationUrl = new URL("/api/checkout/start", baseUrl);
    confirmationUrl.searchParams.set("activation", legacyActivationKey);
    return redirect(response, confirmationUrl.toString());
  }
  if (!directAccountPurchase && (
    !/^[0-9a-f-]{36}$/i.test(intentId) ||
    !browserToken ||
    !signedToken ||
    purchaseIntent !== "purchase" ||
    !validateCheckoutIntentConfirmation({
      intentId,
      browserToken,
      signedToken,
    })
  )) {
    return sendJson(response, 403, {
      error: "Checkout confirmation expired or invalid",
      code: "csrf_rejected",
      confirmationUrl: "/upgrade.html",
    });
  }

  const session = await getSession(request);
  if (directAccountPurchase && !session) {
    const signInUrl = new URL("/api/auth/google/start", baseUrl);
    signInUrl.searchParams.set("next", "/account.html");
    return redirect(response, signInUrl.toString());
  }
  if (session?.license.active) {
    if (directAccountPurchase) {
      const accountUrl = new URL("/account.html", baseUrl);
      accountUrl.searchParams.set("checkout", "already_owned");
      return redirect(response, accountUrl.toString());
    }
    return sendJson(response, 409, {
      error: "Sidestream Pro is already active. Open your account or use Restore Purchase.",
      code: "active_license",
      accountUrl: "/account.html",
      restoreUrl: "/api/activation/claim",
    });
  }
  const rateLimit = await consumeRateLimit({
    scope: "checkout:create",
    dimensions: [
      directAccountPurchase && session
        ? { name: "account", value: session.accountId, limit: 8 }
        : { name: "intent", value: intentId, limit: 8 },
      { name: "ip", value: getClientIp(request) || "unknown-client", limit: 20 },
    ],
    windowSeconds: 15 * 60,
  });
  if (!rateLimit.allowed) return sendRateLimitExceeded(response, rateLimit);
  applyRateLimitHeaders(response, rateLimit);

  if (directAccountPurchase && session) {
    const confirmation = await createCheckoutIntentConfirmation({ session });
    if (!confirmation) {
      return sendJson(response, 409, {
        error: "Checkout could not be started",
        code: "intent_unavailable",
      });
    }
    intentId = confirmation.intentId;
    browserToken = confirmation.browserToken;
  }

  // The locked intent worker owns attachCheckoutSessionToActivation and the
  // getActivationCheckoutIdempotencyKey namespace. No caller-controlled
  // activation tuple reaches Stripe from this handler.
  const result = await createOrReuseCheckoutSession({
    intentId,
    browserToken,
    session,
    baseUrl,
    rotateCancelledSession: cleanString(payload.rotate, 32) === "cancelled",
  });
  if (!result.ok) {
    return sendJson(response, result.statusCode, {
      error: result.error,
      code: result.code,
      ...(result.code === "active_license"
        ? { accountUrl: "/account.html", restoreUrl: "/api/activation/claim" }
        : {}),
    });
  }
  return browserForm
    ? redirect(response, result.url)
    : sendJson(response, 200, { url: result.url, reused: result.reused });
}

async function readCheckoutRequest(request: AccountRequest) {
  const contentType = firstHeaderValue(request.headers["content-type"]).toLowerCase();
  const body = await readRequestBody(request);
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(body);
    return {
      browserForm: true,
      payload: {
        activationKey: form.get("activationKey"),
        checkoutIntentId: form.get("checkoutIntentId"),
        checkoutIntent: form.get("checkoutIntent"),
        intentToken: form.get("intentToken"),
        intent: form.get("intent"),
        rotate: form.get("rotate"),
      } satisfies CheckoutPayload,
    };
  }

  return {
    browserForm: false,
    payload: (body.trim() ? JSON.parse(body) : {}) as CheckoutPayload,
  };
}

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

import type { ServerResponse } from "node:http";
import {
  cleanString,
  createCheckoutIntent,
  createOrReuseCheckoutSession,
  getBaseUrl,
  getClientIp,
  getSession,
  methodNotAllowed,
  redirect,
  sendJson,
  type AccountRequest,
} from "../_lib/account.js";
import { isLegacyVercelHost } from "../_lib/entitlement.js";
import {
  applyRateLimitHeaders,
  consumeRateLimit,
  sendRateLimitExceeded,
} from "../_lib/rate-limit.js";

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "GET").toUpperCase();
  if (method !== "GET") return methodNotAllowed(response, "GET");

  const baseUrl = getBaseUrl(request);
  const requestUrl = new URL(request.url || "/api/checkout/start", baseUrl);
  const activationKey = cleanString(requestUrl.searchParams.get("activation"), 160);

  if (isLegacyVercelHost(request.headers.host)) {
    const canonicalCheckout = new URL("/api/checkout/start", baseUrl);
    if (!isLegacyVercelHost(canonicalCheckout.host)) {
      if (activationKey) canonicalCheckout.searchParams.set("activation", activationKey);
      return redirect(response, canonicalCheckout.toString(), 302);
    }
  }

  const session = await getSession(request);
  if (!session) {
    const nextUrl = new URL("/api/checkout/start", baseUrl);
    if (activationKey) nextUrl.searchParams.set("activation", activationKey);
    const signInUrl = new URL("/api/auth/google/start", baseUrl);
    signInUrl.searchParams.set("next", `${nextUrl.pathname}${nextUrl.search}`);
    return redirect(response, signInUrl.toString(), 302);
  }

  if (session.license.active) {
    if (activationKey) {
      const restoreUrl = new URL("/api/activation/claim", baseUrl);
      restoreUrl.searchParams.set("activation", activationKey);
      return redirect(response, restoreUrl.toString(), 302);
    }
    const accountUrl = new URL("/account.html", baseUrl);
    accountUrl.searchParams.set("checkout", "already_owned");
    return redirect(response, accountUrl.toString(), 302);
  }

  const rateLimit = await consumeRateLimit({
    scope: "checkout:start",
    dimensions: [
      { name: "account", value: session.accountId, limit: 8 },
      { name: "ip", value: getClientIp(request) || "unknown-client", limit: 20 },
    ],
    windowSeconds: 15 * 60,
  });
  if (!rateLimit.allowed) return sendRateLimitExceeded(response, rateLimit);
  applyRateLimitHeaders(response, rateLimit);

  const intent = await createCheckoutIntent({ activationKey, session });
  if (!intent) {
    return sendJson(response, 409, {
      error: "Checkout unavailable",
      code: "checkout_unavailable",
    });
  }

  const result = await createOrReuseCheckoutSession({
    intentId: intent.intentId,
    browserToken: intent.browserToken,
    session,
    baseUrl,
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

  return redirect(response, result.url);
}

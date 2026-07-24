import type { ServerResponse } from "node:http";
import {
  cleanString,
  createOrReuseCheckoutSession,
  getBaseUrl,
  getClientIp,
  getGoogleAuthUrl,
  getSession,
  methodNotAllowed,
  randomToken,
  redirect,
  resumeCheckoutIntentConfirmation,
  sanitizeNextPath,
  sendGoogleSignInError,
  setOAuthCookies,
  type AccountRequest,
} from "../../_lib/account.js";
import {
  applyRateLimitHeaders,
  consumeRateLimit,
  sendRateLimitExceeded,
} from "../../_lib/rate-limit.js";

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "GET").toUpperCase();
  if (method !== "GET") return methodNotAllowed(response, "GET");

  const url = new URL(request.url || "/", "http://sidestream.local");
  const nextPath = sanitizeNextPath(url.searchParams.get("next"));
  const checkoutIntentRequested = url.searchParams.has("checkout_intent");
  const checkoutIntentToken = cleanString(
    url.searchParams.get("checkout_intent"),
    160,
  );
  const rotateCancelledCheckout =
    url.searchParams.get("checkout") === "cancelled";
  const session = await getSession(request);
  const checkoutIntent = checkoutIntentRequested
    ? await resumeCheckoutIntentConfirmation({
        browserToken: checkoutIntentToken,
        session,
        // OAuth start may not know the account yet. The callback repeats this
        // lookup with the verified account and enforces the binding.
        deferAccountBindingCheck: !session,
      })
    : null;
  if (checkoutIntentRequested && !checkoutIntent) {
    return sendGoogleSignInError(response, 400, "invalid_state");
  }

  if (session && checkoutIntent) {
    const baseUrl = getBaseUrl(request);
    if (session.license.active) {
      return redirectToOwnedCheckout(
        response,
        baseUrl,
        checkoutIntent.activationKey,
      );
    }

    const rateLimit = await consumeRateLimit({
      scope: "checkout:create",
      dimensions: [
        { name: "intent", value: checkoutIntent.intentId, limit: 8 },
        { name: "ip", value: getClientIp(request) || "unknown-client", limit: 20 },
      ],
      windowSeconds: 15 * 60,
    });
    if (!rateLimit.allowed) {
      return sendRateLimitExceeded(response, rateLimit);
    }
    applyRateLimitHeaders(response, rateLimit);

    const checkout = await createOrReuseCheckoutSession({
      intentId: checkoutIntent.intentId,
      browserToken: checkoutIntent.browserToken,
      session,
      baseUrl,
      rotateCancelledSession: rotateCancelledCheckout,
    });
    if (!checkout.ok) {
      if (checkout.code === "active_license") {
        return redirectToOwnedCheckout(
          response,
          baseUrl,
          checkoutIntent.activationKey,
        );
      }
      return sendGoogleSignInError(response, checkout.statusCode, "failed");
    }
    return redirect(response, checkout.url, 303);
  }
  if (session) return redirect(response, nextPath, 303);

  const state = randomToken(24);
  let authUrl = "";

  try {
    authUrl = getGoogleAuthUrl(request, { state });
  } catch (error) {
    console.error("[sidestream auth] Google sign-in configuration rejected", error);
    return sendGoogleSignInError(response, 503, "unavailable");
  }

  setOAuthCookies(request, response, {
    state,
    nextPath,
    checkoutIntentToken: checkoutIntent?.browserToken,
    rotateCancelledCheckout,
  });
  return redirect(response, authUrl, 302);
}

function redirectToOwnedCheckout(
  response: ServerResponse,
  baseUrl: string,
  activationKey: string,
) {
  if (activationKey) {
    const claimUrl = new URL("/api/activation/claim", baseUrl);
    claimUrl.searchParams.set("activation", activationKey);
    return redirect(response, claimUrl.toString(), 303);
  }
  const accountUrl = new URL("/account.html", baseUrl);
  accountUrl.searchParams.set("checkout", "already_owned");
  return redirect(response, accountUrl.toString(), 303);
}

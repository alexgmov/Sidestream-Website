import type { ServerResponse } from "node:http";
import {
  clearOAuthCookies,
  createOrReuseCheckoutSession,
  createWebSession,
  exchangeGoogleCode,
  getAccountSessionById,
  getBaseUrl,
  getClientIp,
  getOAuthCheckoutIntent,
  getOAuthNextPath,
  getOAuthState,
  methodNotAllowed,
  redirect,
  resumeCheckoutIntentConfirmation,
  sendGoogleSignInError,
  type AccountRequest,
  upsertGoogleAccount,
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

  const callbackUrl = new URL(request.url || "/", "http://sidestream.local");
  const expectedState = getOAuthState(request);
  const returnedState = callbackUrl.searchParams.get("state") || "";
  const code = callbackUrl.searchParams.get("code") || "";
  const nextPath = getOAuthNextPath(request);
  const checkoutIntent = getOAuthCheckoutIntent(request);

  clearOAuthCookies(request, response);

  if (!code || !expectedState || returnedState !== expectedState) {
    return sendGoogleSignInError(response, 400, "invalid_state");
  }

  try {
    if (
      checkoutIntent.requested &&
      !(await resumeCheckoutIntentConfirmation({
        browserToken: checkoutIntent.browserToken,
        session: null,
        deferAccountBindingCheck: true,
      }))
    ) {
      return sendGoogleSignInError(response, 400, "invalid_state");
    }

    const profile = await exchangeGoogleCode(request, code);
    const accountId = await upsertGoogleAccount(profile);
    await createWebSession(request, response, accountId);
    if (checkoutIntent.requested) {
      const session = await getAccountSessionById(accountId);
      if (!session) {
        return sendGoogleSignInError(response, 502, "failed");
      }
      const confirmation = await resumeCheckoutIntentConfirmation({
        browserToken: checkoutIntent.browserToken,
        session,
      });
      if (!confirmation) {
        return sendGoogleSignInError(response, 409, "failed");
      }

      const baseUrl = getBaseUrl(request);
      if (session.license.active) {
        return redirectToOwnedCheckout(
          response,
          baseUrl,
          confirmation.activationKey,
        );
      }
      const rateLimit = await consumeRateLimit({
        scope: "checkout:create",
        dimensions: [
          { name: "intent", value: confirmation.intentId, limit: 8 },
          { name: "ip", value: getClientIp(request) || "unknown-client", limit: 20 },
        ],
        windowSeconds: 15 * 60,
      });
      if (!rateLimit.allowed) {
        return sendRateLimitExceeded(response, rateLimit);
      }
      applyRateLimitHeaders(response, rateLimit);

      const checkout = await createOrReuseCheckoutSession({
        intentId: confirmation.intentId,
        browserToken: confirmation.browserToken,
        session,
        baseUrl,
        rotateCancelledSession: checkoutIntent.rotateCancelledSession,
      });
      if (!checkout.ok) {
        if (checkout.code === "active_license") {
          return redirectToOwnedCheckout(
            response,
            baseUrl,
            confirmation.activationKey,
          );
        }
        return sendGoogleSignInError(response, checkout.statusCode, "failed");
      }
      return redirect(response, checkout.url, 303);
    }
    return redirect(response, nextPath, 303);
  } catch (error) {
    console.error("[sidestream auth] Google sign-in or Checkout handoff failed", error);
    return sendGoogleSignInError(response, 502, "failed");
  }
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

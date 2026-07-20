import type { ServerResponse } from "node:http";
import {
  clearOAuthCookies,
  createCheckoutIntentConfirmation,
  createOrReuseCheckoutSession,
  createWebSession,
  exchangeGoogleCode,
  getAccountSessionById,
  getBaseUrl,
  getClientIp,
  getOAuthNextPath,
  getOAuthPluginUpgradeIntent,
  getOAuthState,
  methodNotAllowed,
  redirect,
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
  const pluginUpgrade = getOAuthPluginUpgradeIntent(request);

  clearOAuthCookies(request, response);

  if (
    !code ||
    !expectedState ||
    returnedState !== expectedState ||
    (pluginUpgrade.requested && !pluginUpgrade.activationKey)
  ) {
    return sendGoogleSignInError(response, 400, "invalid_state");
  }

  try {
    const profile = await exchangeGoogleCode(request, code);
    const accountId = await upsertGoogleAccount(profile);
    await createWebSession(request, response, accountId);
    if (pluginUpgrade.activationKey) {
      const session = await getAccountSessionById(accountId);
      if (!session) {
        return sendGoogleSignInError(response, 502, "failed");
      }
      if (session.license.active) {
        const claimUrl = new URL("/api/activation/claim", getBaseUrl(request));
        claimUrl.searchParams.set("activation", pluginUpgrade.activationKey);
        return redirect(response, claimUrl.toString(), 303);
      }

      const confirmation = await createCheckoutIntentConfirmation({
        activationKey: pluginUpgrade.activationKey,
        session,
      });
      if (!confirmation) {
        return sendGoogleSignInError(response, 409, "failed");
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
        baseUrl: getBaseUrl(request),
      });
      if (!checkout.ok) {
        if (checkout.code === "active_license") {
          const claimUrl = new URL("/api/activation/claim", getBaseUrl(request));
          claimUrl.searchParams.set("activation", pluginUpgrade.activationKey);
          return redirect(response, claimUrl.toString(), 303);
        }
        return sendGoogleSignInError(response, checkout.statusCode, "failed");
      }
      return redirect(response, checkout.url, 303);
    }
    return redirect(response, nextPath, 303);
  } catch (error) {
    console.error("[sidestream auth] Google sign-in or plugin Checkout handoff failed", error);
    return sendGoogleSignInError(response, 502, "failed");
  }
}

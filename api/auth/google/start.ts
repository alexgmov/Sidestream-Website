import type { ServerResponse } from "node:http";
import {
  cleanString,
  createCheckoutIntentConfirmation,
  createOrReuseCheckoutSession,
  getBaseUrl,
  getClientIp,
  getGoogleAuthUrl,
  getSession,
  methodNotAllowed,
  randomToken,
  readPluginUpgradeIntentToken,
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
  const pluginUpgradeRequested = url.searchParams.has("plugin_upgrade");
  const checkoutIntentRequested = url.searchParams.has("checkout_intent");
  const pluginUpgrade = readPluginUpgradeIntentToken(
    url.searchParams.get("plugin_upgrade"),
  );
  const checkoutIntentToken = cleanString(
    url.searchParams.get("checkout_intent"),
    160,
  );
  const rotateCancelledCheckout =
    url.searchParams.get("checkout") === "cancelled";
  const checkoutIntent = checkoutIntentRequested
    ? await resumeCheckoutIntentConfirmation({
        browserToken: checkoutIntentToken,
        session: null,
        // OAuth start only proves that the opaque browser capability exists.
        // The callback enforces its account binding after Google signs in.
        deferAccountBindingCheck: true,
      })
    : null;
  if (
    (pluginUpgradeRequested && !pluginUpgrade.activationKey) ||
    (checkoutIntentRequested && !checkoutIntent) ||
    (pluginUpgradeRequested && checkoutIntentRequested)
  ) {
    return sendGoogleSignInError(response, 400, "invalid_state");
  }
  const baseUrl = getBaseUrl(request);
  const session = await getSession(request);
  if (session && (pluginUpgrade.activationKey || checkoutIntent)) {
    if (session.license.active) {
      if (pluginUpgrade.activationKey) {
        const claimUrl = new URL("/api/activation/claim", baseUrl);
        claimUrl.searchParams.set("activation", pluginUpgrade.activationKey);
        return redirect(response, claimUrl.toString(), 303);
      }
      const accountUrl = new URL("/account.html", baseUrl);
      accountUrl.searchParams.set("checkout", "already_owned");
      return redirect(response, accountUrl.toString(), 303);
    }

    const confirmation = pluginUpgrade.activationKey
      ? await createCheckoutIntentConfirmation({
          activationKey: pluginUpgrade.activationKey,
          session,
        })
      : await resumeCheckoutIntentConfirmation({
          browserToken: checkoutIntent?.browserToken || "",
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
      baseUrl,
      rotateCancelledSession: rotateCancelledCheckout,
    });
    if (checkout.ok === false) {
      if (checkout.code === "active_license") {
        if (pluginUpgrade.activationKey) {
          const claimUrl = new URL("/api/activation/claim", baseUrl);
          claimUrl.searchParams.set("activation", pluginUpgrade.activationKey);
          return redirect(response, claimUrl.toString(), 303);
        }
        const accountUrl = new URL("/account.html", baseUrl);
        accountUrl.searchParams.set("checkout", "already_owned");
        return redirect(response, accountUrl.toString(), 303);
      }
      return sendGoogleSignInError(response, checkout.statusCode, "failed");
    }
    return redirect(response, checkout.url, 303);
  }
  if (session) {
    return redirect(response, nextPath, 303);
  }

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
    pluginUpgradeToken: pluginUpgrade.token,
    checkoutIntentToken: checkoutIntent?.browserToken,
    rotateCancelledCheckout,
  });
  return redirect(response, authUrl, 302);
}

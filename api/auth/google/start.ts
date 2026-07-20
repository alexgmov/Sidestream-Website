import type { ServerResponse } from "node:http";
import {
  cleanString,
  getBaseUrl,
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
  const session = await getSession(request);
  if (session && pluginUpgrade.activationKey) {
    const checkoutUrl = new URL("/api/checkout/start", getBaseUrl(request));
    checkoutUrl.searchParams.set("activation", pluginUpgrade.activationKey);
    return redirect(response, checkoutUrl.toString(), 303);
  }
  if (session && checkoutIntent) {
    const checkoutUrl = new URL("/api/checkout/start", getBaseUrl(request));
    checkoutUrl.searchParams.set("intent", checkoutIntent.browserToken);
    if (rotateCancelledCheckout) {
      checkoutUrl.searchParams.set("checkout", "cancelled");
    }
    return redirect(response, checkoutUrl.toString(), 303);
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

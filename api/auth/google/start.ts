import type { ServerResponse } from "node:http";
import {
  getGoogleAuthUrl,
  getSession,
  methodNotAllowed,
  randomToken,
  readPluginUpgradeIntentToken,
  redirect,
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
  const pluginUpgrade = readPluginUpgradeIntentToken(
    url.searchParams.get("plugin_upgrade"),
  );
  if (pluginUpgradeRequested && !pluginUpgrade.activationKey) {
    return sendGoogleSignInError(response, 400, "invalid_state");
  }
  const session = await getSession(request);
  if (session && !pluginUpgrade.activationKey) {
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
  });
  return redirect(response, authUrl, 302);
}

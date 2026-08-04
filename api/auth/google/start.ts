import type { ServerResponse } from "node:http";
import {
  getGoogleAuthUrl,
  getSession,
  methodNotAllowed,
  randomToken,
  redirect,
  resolveRequiredCheckoutAcquisition,
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
  const prompt = url.searchParams.get("prompt") === "select_account"
    ? "select_account"
    : undefined;
  const session = await getSession(request);
  if (session) return redirect(response, nextPath, 303);

  let acquisition;
  try {
    const nextUrl = new URL(nextPath, "https://sidestream.tv");
    const handoffs = nextUrl.pathname === "/api/checkout/start"
      ? nextUrl.searchParams.getAll("handoff")
      : [];
    acquisition = await resolveRequiredCheckoutAcquisition(request, response, {
      handoffToken: handoffs.length === 1 ? handoffs[0] : "",
    });
  } catch (error) {
    console.error("[sidestream auth] acquisition resolution failed", error);
    return sendGoogleSignInError(response, 503, "acquisition_unavailable");
  }

  const state = randomToken(24);
  let authUrl = "";

  try {
    authUrl = getGoogleAuthUrl(request, { state, prompt });
  } catch (error) {
    console.error("[sidestream auth] Google sign-in configuration rejected", error);
    return sendGoogleSignInError(response, 503, "unavailable");
  }

  setOAuthCookies(request, response, {
    state,
    nextPath,
    acquisitionCookieValue: acquisition.browserCookieValue,
  });
  return redirect(response, authUrl, 302);
}

import type { ServerResponse } from "node:http";
import {
  clearOAuthCookies,
  completeGoogleAuthenticationAcquisition,
  createWebSession,
  exchangeGoogleCode,
  getOAuthNextPath,
  getOAuthAcquisitionCookie,
  getOAuthState,
  methodNotAllowed,
  redirect,
  sendGoogleSignInError,
  type AccountRequest,
  upsertGoogleAccount,
} from "../../_lib/account.js";

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
  const oauthAcquisitionCookieValue = getOAuthAcquisitionCookie(request);

  clearOAuthCookies(request, response);

  if (!code || !expectedState || returnedState !== expectedState) {
    return sendGoogleSignInError(response, 400, "invalid_state");
  }

  try {
    const profile = await exchangeGoogleCode(request, code);
    const accountId = await upsertGoogleAccount(profile);
    const acquisition = await completeGoogleAuthenticationAcquisition({
      oauthAcquisitionCookieValue,
      nextPath,
      exactVerifiedEmail: profile.email,
      accountId,
      response,
    });
    if (acquisition.possibleForwardedHandoff) {
      console.warn("[sidestream auth] possible forwarded acquisition handoff", {
        acquisitionId: acquisition.acquisitionId,
      });
    }
    await createWebSession(request, response, accountId);
    return redirect(response, nextPath, 303);
  } catch (error) {
    console.error("[sidestream auth] Google sign-in callback failed", error);
    return sendGoogleSignInError(response, 502, "failed");
  }
}

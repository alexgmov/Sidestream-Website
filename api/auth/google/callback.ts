import type { ServerResponse } from "node:http";
import {
  clearOAuthCookies,
  createWebSession,
  exchangeGoogleCode,
  getOAuthNextPath,
  getOAuthState,
  methodNotAllowed,
  redirect,
  sendJson,
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

  clearOAuthCookies(request, response);

  if (!code || !expectedState || returnedState !== expectedState) {
    return sendJson(response, 400, { error: "Invalid Google sign-in state" });
  }

  try {
    const profile = await exchangeGoogleCode(request, code);
    const accountId = await upsertGoogleAccount(profile);
    await createWebSession(request, response, accountId);
    return redirect(response, nextPath, 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google sign-in failed";
    return sendJson(response, 500, { error: message });
  }
}

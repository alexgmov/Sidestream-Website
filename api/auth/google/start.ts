import type { ServerResponse } from "node:http";
import {
  getGoogleAuthUrl,
  methodNotAllowed,
  randomToken,
  redirect,
  sanitizeNextPath,
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
  const state = randomToken(24);
  const nextPath = sanitizeNextPath(url.searchParams.get("next"));

  setOAuthCookies(request, response, { state, nextPath });
  return redirect(response, getGoogleAuthUrl(request, { state }), 302);
}

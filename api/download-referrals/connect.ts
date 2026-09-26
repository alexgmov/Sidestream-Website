import type { ServerResponse } from "node:http";
import { methodNotAllowed, sendJson, type AccountRequest } from "../_lib/account.js";
import { completeReferralConnection } from "../_lib/download-referrals.js";
import { referralBrowserSession, referralFailure, referralRequest, renderReferralConfirmation } from "../_lib/download-referral-http.js";
export default async function handler(request: AccountRequest, response: ServerResponse) {
  if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed(response, "GET, POST");
  try {
    const environment = await referralRequest(request, response, "connect-browser", new URL(request.url || "/", "https://sidestream.invalid").searchParams.get("key") || "invalid");
    if (!environment) return;
    const browser = await referralBrowserSession(request, response, "/api/download-referrals/connect", "key");
    if (!browser) return;
    if (request.method === "GET") return renderReferralConfirmation(response, "connect");
    return sendJson(response, 200, await completeReferralConnection(environment, browser.key, browser.session.accountId));
  } catch (error) { return referralFailure(response, error); }
}

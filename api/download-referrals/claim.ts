import type { ServerResponse } from "node:http";
import { methodNotAllowed, sendJson, type AccountRequest } from "../_lib/account.js";
import { claimDownloadReferral } from "../_lib/download-referrals.js";
import { referralBrowserSession, referralFailure, referralRequest, renderReferralConfirmation } from "../_lib/download-referral-http.js";
export default async function handler(request: AccountRequest, response: ServerResponse) {
  if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed(response, "GET, POST");
  try {
    const environment = await referralRequest(request, response, "claim", new URL(request.url || "/", "https://sidestream.invalid").searchParams.get("visit") || "invalid");
    if (!environment) return;
    const browser = await referralBrowserSession(request, response, "/api/download-referrals/claim", "visit");
    if (!browser) return;
    if (request.method === "GET") return renderReferralConfirmation(response, "claim");
    return sendJson(response, 200, await claimDownloadReferral(environment, browser.key, browser.session.accountId));
  } catch (error) { return referralFailure(response, error); }
}

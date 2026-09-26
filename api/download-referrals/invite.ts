import type { ServerResponse } from "node:http";
import { methodNotAllowed, redirect, type AccountRequest } from "../_lib/account.js";
import { startReferralVisit } from "../_lib/download-referrals.js";
import { referralFailure, referralRequest } from "../_lib/download-referral-http.js";
export default async function handler(request: AccountRequest, response: ServerResponse) {
  if (request.method !== "GET") return methodNotAllowed(response, "GET");
  try {
    const code = new URL(request.url || "/", "https://sidestream.invalid").searchParams.get("code") || "";
    const environment = await referralRequest(request, response, "visit", code);
    if (!environment) return;
    const cookie = String(request.headers.cookie || "").split(";").map(part => part.trim())
      .find(part => part.startsWith("__Host-sidestream-download-invitation="));
    const previousVisit = cookie ? cookie.slice(cookie.indexOf("=") + 1) : "";
    const visit = await startReferralVisit(environment, code, previousVisit);
    response.setHeader("Set-Cookie", `__Host-sidestream-download-invitation=${visit}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`);
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "private, no-store");
    return redirect(response, `/api/download-referrals/claim?visit=${visit}`, 303);
  } catch (error) { return referralFailure(response, error); }
}

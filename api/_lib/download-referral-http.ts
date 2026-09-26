import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { getBaseUrl, getClientIp, getSession, redirect, resolveRequestLicenseEnvironment, sendJson, validateSameOriginJsonMutation, type AccountRequest } from "./account.js";
import { applyRateLimitHeaders, consumeRateLimit, sendRateLimitExceeded } from "./rate-limit.js";
import { DownloadReferralError, referralMode, referralPool, referralToken } from "./download-referrals.js";

export async function referralRequest(request: AccountRequest, response: ServerResponse, action: string, identity = "anonymous") {
  const environment = resolveRequestLicenseEnvironment(request);
  if (!environment) throw new DownloadReferralError("referral_environment_unavailable", 503, true);
  const origin = new URL(getBaseUrl(request));
  if (!environment.allowedApiHosts.includes(origin.host) || (origin.protocol !== "https:" && process.env.NODE_ENV !== "test")) {
    throw new DownloadReferralError("referral_environment_unavailable", 503, true);
  }
  if (referralMode() === "off") throw new DownloadReferralError("referrals_disabled", 503, false);
  const limit = await consumeRateLimit({
    scope: `download-referrals:${environment.namespace}:${action}`,
    dimensions: [
      { name: "ip", value: getClientIp(request) || "unknown-client", limit: action === "status" ? 600 : 120 },
      { name: "identity", value: identity, limit: action === "status" ? 180 : 30 },
    ], windowSeconds: 900, runner: referralPool(environment),
  });
  if (!limit.allowed) { sendRateLimitExceeded(response, limit); return null; }
  applyRateLimitHeaders(response, limit);
  return environment;
}
export function referralFailure(response: ServerResponse, error: unknown) {
  const known = error instanceof DownloadReferralError;
  if (!known) console.error("sidestream_download_referrals_unavailable");
  if (!known || error.retryable) response.setHeader("Retry-After", "5");
  return sendJson(response, known ? error.status : 503, {
    code: known ? error.code : "referrals_unavailable",
    retryable: known ? error.retryable : true,
    action: known && error.status === 401 ? "reconnect" : known && !error.retryable ? "check_claim" : "retry",
  });
}
export async function referralBrowserSession(request: AccountRequest, response: ServerResponse, pathname: string, parameter: string) {
  const url = new URL(request.url || "/", "https://sidestream.invalid");
  const key = referralToken(url.searchParams.get(parameter));
  if (!key || url.searchParams.size !== 1) throw new DownloadReferralError("referral_request_invalid", 400);
  if (request.method === "POST" && !validateSameOriginJsonMutation(request)) throw new DownloadReferralError("origin_required", 403);
  const session = await getSession(request);
  if (!session) {
    if (request.method === "POST") throw new DownloadReferralError("sign_in_required", 401);
    redirect(response, `/api/auth/google/start?next=${encodeURIComponent(`${pathname}?${parameter}=${key}`)}`, 303);
    return null;
  }
  return { key, session };
}
export function renderReferralConfirmation(response: ServerResponse, kind: "claim" | "connect") {
  const nonce = randomBytes(18).toString("base64url");
  const title = kind === "claim" ? "Claim your free month" : "Connect Sidestream";
  const description = kind === "claim"
    ? "You and your friend each get 30 days of unlimited downloads after your first successful download. A new account and installation are required. No purchase needed."
    : "Connect this Sidestream installation to your signed-in account to claim invitations and keep your rewards. No purchase needed.";
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  response.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Sidestream</title><style nonce="${nonce}">body{background:#090909;color:#eee;font:16px system-ui;margin:12vh auto;padding:24px;max-width:520px;line-height:1.6}button,a{color:inherit}button{background:#eee;color:#111;border:0;border-radius:10px;padding:12px 20px;font:inherit;cursor:pointer}a{margin-right:20px}</style><h1>${title}</h1><p>${description}</p><button id="confirm">${kind === "claim" ? "Claim invitation" : "Connect account"}</button><p id="status" role="status" aria-live="polite"></p><div id="downloads" hidden><p>Install Sidestream, open the panel, and connect this same account to finish claiming.</p><a href="/api/download">Download for Mac</a><a href="/api/download?platform=win32-x64">Download for Windows</a></div><script nonce="${nonce}">
const button=document.getElementById('confirm'),status=document.getElementById('status');
const messages={self_referral:'You cannot claim your own invitation.',recipient_not_new:'This invitation is for a new account and installation.',already_qualified:'This account has already earned a referral reward.',claim_already_used:'This invitation has already been claimed.',installation_already_linked:'This installation is connected to another account. Sign in with that account.',invitation_expired:'This claim link has expired. Open your friend’s original invitation again.',connection_expired:'Return to Sidestream and connect again.',wallet_sync_required:'Open Sidestream, wait for your download balance to load, then retry.',sign_in_required:'Sign in again by refreshing this page.'};
button.onclick=async()=>{button.disabled=true;status.textContent='Connecting…';try{const r=await fetch(location.pathname+location.search,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',credentials:'same-origin'});const p=await r.json();if(!r.ok){status.textContent=messages[p.code]||(p.retryable?'Please wait a moment and try again.':'This request could not be completed. Return to Sidestream and reconnect.');button.disabled=false;return;}status.textContent=${JSON.stringify(kind === "claim" ? "Invitation claimed. Your first successful download unlocks both rewards." : "Connected. Return to Sidestream; it will refresh automatically.")};button.hidden=true;document.getElementById('downloads').hidden=${kind === "claim" ? "false" : "true"};}catch{status.textContent='Check your connection and retry.';button.disabled=false;}};
</script></html>`);
}

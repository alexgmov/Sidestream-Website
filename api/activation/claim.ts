import type { ServerResponse } from "node:http";
import {
  claimActivationToAccount,
  cleanString,
  createActivationClaimCsrf,
  getActivationClaimContext,
  getBaseUrl,
  getSession,
  methodNotAllowed,
  readRequestBody,
  redirect,
  sendJson,
  type AccountRequest,
  validateActivationClaimRequest,
} from "../_lib/account.js";

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return methodNotAllowed(response, "GET, POST");
  }

  const baseUrl = getBaseUrl(request);
  if (method === "GET") {
    const requestUrl = new URL(request.url || "/api/activation/claim", baseUrl);
    const activationKey = cleanString(requestUrl.searchParams.get("activation"), 160);
    if (!activationKey) return sendJson(response, 400, { error: "Missing activation key" });

    const session = await getSession(request);
    if (!session) {
      const nextPath = `/api/activation/claim?activation=${encodeURIComponent(activationKey)}`;
      const signIn = new URL("/api/auth/google/start", baseUrl);
      signIn.searchParams.set("next", nextPath);
      return redirect(response, signIn.toString(), 302);
    }
    if (!session.license.active) {
      return redirect(response, `${baseUrl}/account.html?restore=license_required`);
    }

    const activation = await getActivationClaimContext(activationKey);
    if (!activation.available) {
      return sendConfirmationPage(response, 409, unavailablePage());
    }

    const csrfToken = createActivationClaimCsrf(activationKey, session.accountId);
    return sendConfirmationPage(response, 200, confirmationPage({
      activationKey,
      csrfToken,
      email: session.email,
      appVersion: activation.appVersion,
    }));
  }

  const session = await getSession(request);
  if (!session) return sendJson(response, 401, { error: "Authentication required" });
  if (!session.license.active) {
    return sendJson(response, 403, { error: "An active Sidestream Pro license is required" });
  }

  const form = new URLSearchParams(await readRequestBody(request));
  const activationKey = cleanString(form.get("activation"), 160);
  const csrfToken = cleanString(form.get("csrf"), 500);
  if (!activationKey || !csrfToken) {
    return sendJson(response, 400, { error: "Invalid restore confirmation" });
  }
  if (!validateActivationClaimRequest(request, {
    activationKey,
    accountId: session.accountId,
    csrfToken,
  })) {
    return sendJson(response, 403, { error: "Invalid restore confirmation", code: "csrf_rejected" });
  }

  const claimed = await claimActivationToAccount(activationKey, session.accountId);
  if (!claimed.claimed) {
    return sendJson(response, 409, { error: "Activation could not be restored", code: claimed.reason });
  }

  const destination = new URL("/thank-you.html", baseUrl);
  destination.searchParams.set("restore", "success");
  destination.searchParams.set("activation", activationKey);
  return redirect(response, destination.toString());
}

function sendConfirmationPage(response: ServerResponse, statusCode: number, html: string) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("X-Frame-Options", "DENY");
  response.end(html);
}

function confirmationPage(options: {
  activationKey: string;
  csrfToken: string;
  email: string;
  appVersion: string;
}) {
  const version = options.appVersion
    ? `<p class="muted">Sidestream ${escapeHtml(options.appVersion)}</p>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Restore Sidestream Pro</title><style>body{margin:0;background:#0b0b0b;color:#e2e8f0;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;min-height:100vh;place-items:center}.card{max-width:520px;margin:24px;padding:32px;border:1px solid #333;border-radius:24px;background:#151515}h1{margin:0 0 16px;font-size:30px}p{line-height:1.55}.muted{color:#aab2bf}button{margin-top:12px;border:0;border-radius:999px;background:#fff;color:#111;padding:13px 20px;font:inherit;font-weight:650;cursor:pointer}</style></head><body><main class="card"><h1>Restore Sidestream Pro?</h1><p>Only continue if you started Restore Purchase from Sidestream on this computer.</p>${version}<p class="muted">Signed in as ${escapeHtml(options.email)}</p><form method="post" action="/api/activation/claim"><input type="hidden" name="activation" value="${escapeHtml(options.activationKey)}"><input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken)}"><button type="submit">Restore Sidestream Pro</button></form></main></body></html>`;
}

function unavailablePage() {
  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"robots\" content=\"noindex,nofollow\"><title>Restore unavailable</title></head><body><h1>Restore link unavailable</h1><p>Return to Sidestream and start Restore Purchase again.</p></body></html>";
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] || character);
}

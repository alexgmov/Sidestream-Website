import type { ServerResponse } from "node:http";
import {
  cleanString,
  createCheckoutIntentConfirmation,
  createOrResumeActivationCheckout,
  getBaseUrl,
  getSession,
  methodNotAllowed,
  redirect,
  resumeCheckoutIntentConfirmation,
  sendJson,
  type AccountRequest,
  type CheckoutIntentConfirmation,
} from "../_lib/account.js";
import { isLegacyVercelHost } from "../_lib/entitlement.js";

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "GET").toUpperCase();
  if (method !== "GET") return methodNotAllowed(response, "GET");

  const baseUrl = getBaseUrl(request);
  const requestUrl = new URL(request.url || "/api/checkout/start", baseUrl);
  const activationKey = cleanString(requestUrl.searchParams.get("activation"), 160);
  const browserToken = cleanString(requestUrl.searchParams.get("intent"), 160);
  const checkoutState = cleanString(requestUrl.searchParams.get("checkout"), 32);
  if (!activationKey && !browserToken && isLegacyVercelHost(request.headers.host)) {
    const retryUrl = new URL("/upgrade.html", baseUrl);
    retryUrl.searchParams.set("checkout", "activation_required");
    return redirect(response, retryUrl.toString(), 302);
  }
  if (activationKey && isLegacyVercelHost(request.headers.host)) {
    const canonicalConfirmation = new URL("/api/checkout/start", baseUrl);
    if (!isLegacyVercelHost(canonicalConfirmation.host)) {
      canonicalConfirmation.searchParams.set("activation", activationKey);
      return redirect(response, canonicalConfirmation.toString(), 302);
    }
  }

  // Anonymous website GETs remain a read/confirmation boundary for Stripe.
  // The activation-capability exception below is scoped to shipped panels.
  const session = await getSession(request);
  if (session?.license.active) {
    if (activationKey) {
      const restoreUrl = new URL("/api/activation/claim", baseUrl);
      restoreUrl.searchParams.set("activation", activationKey);
      return redirect(response, restoreUrl.toString(), 302);
    }
    const accountUrl = new URL("/account.html", baseUrl);
    accountUrl.searchParams.set("checkout", "already_owned");
    return redirect(response, accountUrl.toString(), 302);
  }

  // Shipped CEP panels already hold a high-entropy activation capability and
  // expect this GET to resume or create their one attached Stripe Session.
  // Keep anonymous website purchases on the confirmation/POST flow below.
  if (activationKey) {
    const checkout = await createOrResumeActivationCheckout({
      activationKey,
      baseUrl,
    });
    if (!checkout.ok) {
      return sendJson(response, checkout.statusCode, { error: checkout.error });
    }
    return redirect(response, checkout.url);
  }

  const confirmation = browserToken
    ? await resumeCheckoutIntentConfirmation({ browserToken, session })
    : await createCheckoutIntentConfirmation({ activationKey, session });
  if (!confirmation) {
    return sendConfirmationPage(
      response,
      409,
      "Checkout link unavailable",
      "Return to Sidestream and start Upgrade again. No Stripe Customer, Price, or Checkout Session was created.",
    );
  }

  return sendConfirmationPage(
    response,
    200,
    confirmation.activationKey
      ? "Confirm this Sidestream activation purchase"
      : "Confirm Sidestream Pro purchase",
    confirmation.activationKey
      ? "This $9.99 one-time purchase will stay attached to the exact Sidestream activation that opened this page."
      : "Continue only if you intend to buy Sidestream Pro for $9.99 as a one-time payment.",
    checkoutForm(confirmation, checkoutState === "cancelled"),
  );
}

function checkoutForm(
  confirmation: CheckoutIntentConfirmation,
  cancelled: boolean,
) {
  const label = cancelled && confirmation.hasCheckoutSession
    ? "Expire cancelled checkout and start a new one"
    : confirmation.hasCheckoutSession
      ? "Return to secure checkout"
      : "Continue to secure checkout";
  return `<form method="post" action="/api/checkout/create">
    <input type="hidden" name="checkoutIntentId" value="${escapeHtml(confirmation.intentId)}">
    <input type="hidden" name="checkoutIntent" value="${escapeHtml(confirmation.browserToken)}">
    <input type="hidden" name="intentToken" value="${escapeHtml(confirmation.signedToken)}">
    <input type="hidden" name="intent" value="purchase">
    ${cancelled ? '<input type="hidden" name="rotate" value="cancelled">' : ""}
    <button type="submit">${escapeHtml(label)}</button>
  </form>`;
}

function sendConfirmationPage(
  response: ServerResponse,
  statusCode: number,
  title: string,
  description: string,
  action = '<a href="/upgrade.html">Back to Upgrade</a>',
) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  response.setHeader("X-Frame-Options", "DENY");
  response.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${escapeHtml(title)} - Sidestream</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#090909;color:#f7f7f7}
    body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;box-sizing:border-box}
    main{width:min(520px,100%);padding:32px;border:1px solid #2b2b2b;border-radius:24px;background:#151515}
    h1{font-size:clamp(1.8rem,5vw,2.6rem);line-height:1.05;margin:0 0 18px}
    p{color:#b8b8b8;line-height:1.55;margin:0 0 24px}
    button,a{display:inline-block;border:0;border-radius:999px;padding:13px 19px;background:#fff;color:#000;font:inherit;font-weight:700;text-decoration:none;cursor:pointer}
  </style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p>${action}</main></body>
</html>`);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '\"': "&quot;",
  })[character] || character);
}

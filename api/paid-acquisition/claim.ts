import type { ServerResponse } from "node:http";
import {
  claimActivationToAccount,
  cleanString,
  fulfillCheckoutSession,
  getBaseUrl,
  getSession,
  methodNotAllowed,
  redirect,
  resolveRequestLicenseEnvironment,
  type AccountRequest,
} from "../_lib/account.js";
import {
  PAID_ACQUISITION_RECEIPT_COOKIE,
  PaidAcquisitionError,
  claimPaidAcquisitionActivation,
  getPaidAcquisitionReceiptState,
  normalizePaidAcquisitionVerifiedEmail,
  validatePaidAcquisitionReceiptCookie,
} from "../_lib/paid-acquisition.js";

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  response.setHeader("Cache-Control", "no-store");
  const method = (request.method || "GET").toUpperCase();
  if (method !== "GET") return methodNotAllowed(response, "GET");

  const environment = resolveRequestLicenseEnvironment(request);
  const receiptSecret =
    process.env.SIDESTREAM_PAID_ACQUISITION_RECEIPT_SECRET?.trim() || "";
  if (!environment || Buffer.byteLength(receiptSecret, "utf8") < 32) {
    return sendOutcome(response, 503, "temporarily_unavailable");
  }
  const requestUrl = new URL(
    request.url || "/api/paid-acquisition/claim",
    getBaseUrl(request),
  );
  const activationKey = cleanString(
    requestUrl.searchParams.get("activation"),
    160,
  );
  if (
    !activationKey ||
    requestUrl.searchParams.getAll("activation").length !== 1 ||
    [...requestUrl.searchParams.keys()].some((key) => key !== "activation")
  ) {
    return sendOutcome(response, 400, "invalid_request");
  }

  let receipt = "";
  try {
    receipt = validatePaidAcquisitionReceiptCookie({
      cookieValue: readSingleCookie(
        request.headers.cookie,
        PAID_ACQUISITION_RECEIPT_COOKIE,
      ),
      environment: environment.namespace,
      secret: receiptSecret,
    });
  } catch {
    return sendOutcome(response, 400, "invalid_request");
  }

  const session = await getSession(request);
  if (!session) {
    const nextPath =
      `/api/paid-acquisition/claim?activation=${encodeURIComponent(activationKey)}`;
    const signIn = new URL("/api/auth/google/start", getBaseUrl(request));
    signIn.searchParams.set("next", nextPath);
    return redirect(response, signIn.toString(), 302);
  }

  try {
    let state = await getPaidAcquisitionReceiptState({
      environment: environment.namespace,
      receipt,
    });
    if (!state || !state.verified_checkout_session_ref) {
      return sendOutcome(response, 409, "payment_pending");
    }
    if (
      !state.receipt_expires_at ||
      new Date(state.receipt_expires_at).getTime() <= Date.now()
    ) {
      return sendOutcome(response, 410, "activation_expired");
    }
    if (state.payment_state === "refunded") {
      return sendOutcome(response, 403, "refunded");
    }
    if (state.payment_state === "disputed") {
      return sendOutcome(response, 403, "disputed");
    }
    if (
      normalizePaidAcquisitionVerifiedEmail(session.email) !==
      state.checkout_email_normalized
    ) {
      await claimPaidAcquisitionActivation({
        environment: environment.namespace,
        receipt,
        activationKey,
        accountRef: session.accountId,
        verifiedGoogleEmail: session.email,
      });
      return sendOutcome(response, 409, "email_mismatch");
    }

    const verification = await fulfillCheckoutSession(
      state.verified_checkout_session_ref,
    );
    if (!verification.fulfilled) {
      return sendOutcome(response, 409, "payment_pending");
    }
    state = await getPaidAcquisitionReceiptState({
      environment: environment.namespace,
      receipt,
    });
    if (!state || state.entitlement_status !== "active") {
      const code =
        state?.payment_state === "refunded"
          ? "refunded"
          : state?.payment_state === "disputed"
            ? "disputed"
            : "payment_pending";
      return sendOutcome(
        response,
        code === "payment_pending" ? 409 : 403,
        code,
      );
    }

    const activation = await claimActivationToAccount(
      activationKey,
      session.accountId,
      { environment },
    );
    if (!activation.claimed) {
      return sendOutcome(
        response,
        409,
        activation.reason === "account_conflict"
          ? "already_claimed"
          : "activation_expired",
      );
    }
    const claim = await claimPaidAcquisitionActivation({
      environment: environment.namespace,
      receipt,
      activationKey,
      accountRef: session.accountId,
      verifiedGoogleEmail: session.email,
    });
    switch (claim.outcome) {
      case "claimed":
        return sendOutcome(response, 200, "claimed");
      case "email_mismatch":
        return sendOutcome(response, 409, "email_mismatch");
      case "already_claimed":
        return sendOutcome(response, 409, "already_claimed");
      case "activation_expired":
        return sendOutcome(response, 410, "activation_expired");
      case "refunded":
      case "disputed":
        return sendOutcome(response, 403, claim.outcome);
      default:
        return sendOutcome(response, 409, "payment_pending");
    }
  } catch (error) {
    if (
      error instanceof PaidAcquisitionError &&
      error.code === "invalid_customer_identity"
    ) {
      return sendOutcome(response, 409, "email_mismatch");
    }
    return sendOutcome(response, 503, "temporarily_unavailable");
  }
}

function readSingleCookie(
  value: string | string[] | undefined,
  name: string,
) {
  const header = Array.isArray(value) ? value.join(";") : value || "";
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return matches.length === 1 ? decodeURIComponent(matches[0]) : "";
}

function sendOutcome(
  response: ServerResponse,
  statusCode: number,
  code: string,
) {
  const title = code === "claimed"
    ? "Sidestream Pro is ready"
    : "Sidestream needs your attention";
  const message = outcomeMessage(code);
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${title}</title></head>
<body><main><h1>${title}</h1><p>${message}</p><p data-code="${code}">${code}</p></main></body></html>`;
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Content-Length", String(Buffer.byteLength(body)));
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  );
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(body);
}

function outcomeMessage(code: string) {
  switch (code) {
    case "claimed":
      return "Return to Sidestream. It will finish activation automatically.";
    case "email_mismatch":
      return "Sign in again with the same verified Google email used at Checkout, or contact support. Do not purchase again.";
    case "already_claimed":
      return "This purchase is already attached. Use Restore Purchase or the confirmed device-transfer flow.";
    case "activation_expired":
      return "This activation expired. Start activation again; you do not need to purchase again.";
    case "refunded":
      return "This purchase was refunded. Contact support if this is unexpected.";
    case "disputed":
      return "This purchase is under payment review. Contact support for recovery.";
    case "payment_pending":
      return "Payment verification is still pending. Keep Sidestream open and try again shortly.";
    default:
      return "This step is temporarily unavailable. Try again shortly.";
  }
}

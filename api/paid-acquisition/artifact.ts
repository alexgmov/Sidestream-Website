import type { ServerResponse } from "node:http";
import {
  fulfillCheckoutSession,
  getClientIp,
  methodNotAllowed,
  resolveRequestLicenseEnvironment,
  type AccountRequest,
} from "../_lib/account.js";
import {
  PAID_ACQUISITION_RECEIPT_COOKIE,
  PAID_ACQUISITION_RECEIPT_MAX_AGE_SECONDS,
  PaidAcquisitionError,
  createPaidAcquisitionReceiptCookie,
  getPaidAcquisitionReceiptState,
} from "../_lib/paid-acquisition.js";
import {
  getPaidArtifactPathname,
  readPaidReleaseManifest,
  resolvePaidReleasePlatform,
} from "../_lib/paid-release-manifest.js";
import {
  applyRateLimitHeaders,
  consumeRateLimit,
} from "../_lib/rate-limit.js";
import { createSignedPaidDownloadUrl } from "../paid-download.js";

const RECEIPT = /^[A-Za-z0-9_-]{43}$/;

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  response.setHeader("Cache-Control", "no-store");
  const method = (request.method || "GET").toUpperCase();
  if (method !== "GET") return methodNotAllowed(response, "GET");

  const requestUrl = new URL(
    request.url || "/api/paid-acquisition/artifact",
    "https://sidestream.tv",
  );
  const entries = [...requestUrl.searchParams.entries()];
  if (
    entries.length !== 2 ||
    requestUrl.searchParams.getAll("receipt").length !== 1 ||
    requestUrl.searchParams.getAll("platform").length !== 1
  ) {
    return sendError(response, 400, "invalid_request");
  }
  const receipt = requestUrl.searchParams.get("receipt") || "";
  const platform = resolvePaidReleasePlatform(
    requestUrl.searchParams.get("platform"),
  );
  if (!RECEIPT.test(receipt)) {
    return sendError(response, 400, "invalid_request");
  }
  if (!platform) {
    return sendError(response, 404, "artifact_not_found");
  }

  const environment = resolveRequestLicenseEnvironment(request);
  const receiptSecret =
    process.env.SIDESTREAM_PAID_ACQUISITION_RECEIPT_SECRET?.trim() || "";
  if (!environment || Buffer.byteLength(receiptSecret, "utf8") < 32) {
    return sendError(response, 503, "temporarily_unavailable");
  }

  try {
    let state = await getPaidAcquisitionReceiptState({
      environment: environment.namespace,
      receipt,
    });
    const rateLimit = await consumeRateLimit({
      scope: "paid-acquisition:artifact",
      dimensions: [
        { name: "receipt", value: receipt, limit: 12 },
        {
          name: "ip",
          value: getClientIp(request) || "unknown-client",
          limit: 30,
        },
      ],
      windowSeconds: 15 * 60,
    });
    applyRateLimitHeaders(response, rateLimit);
    if (!rateLimit.allowed) {
      return sendError(
        response,
        429,
        "rate_limited",
        rateLimit.retryAfterSeconds,
      );
    }

    if (!state) return sendError(response, 403, "payment_inactive");
    if (
      !state.receipt_expires_at ||
      new Date(state.receipt_expires_at).getTime() <= Date.now()
    ) {
      return sendError(response, 410, "receipt_expired");
    }
    if (state.payment_state === "refunded") {
      return sendError(response, 403, "refunded");
    }
    if (state.payment_state === "disputed") {
      return sendError(response, 403, "disputed");
    }
    if (!state.verified_checkout_session_ref) {
      return sendError(response, 403, "payment_inactive");
    }

    const verification = await fulfillCheckoutSession(
      state.verified_checkout_session_ref,
    );
    if (!verification.fulfilled) {
      return sendError(response, 403, "payment_inactive");
    }
    state = await getPaidAcquisitionReceiptState({
      environment: environment.namespace,
      receipt,
    });
    if (
      !state ||
      state.payment_state !== "active" ||
      state.entitlement_status !== "active"
    ) {
      const code =
        state?.payment_state === "refunded"
          ? "refunded"
          : state?.payment_state === "disputed"
            ? "disputed"
            : "payment_inactive";
      return sendError(response, 403, code);
    }

    const manifest = readPaidReleaseManifest(platform);
    const pathname = getPaidArtifactPathname(manifest);
    const { head } = await import("@vercel/blob");
    const metadata = await head(pathname);
    if (
      !metadata ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size !== manifest.sizeBytes
    ) {
      return sendError(response, 404, "artifact_not_found");
    }
    const signedUrl = await createSignedPaidDownloadUrl(pathname);
    if (!isSafeHttpsUrl(signedUrl)) {
      return sendError(response, 503, "temporarily_unavailable");
    }

    const claimCookie = createPaidAcquisitionReceiptCookie({
      receipt,
      environment: environment.namespace,
      secret: receiptSecret,
    });
    response.statusCode = 302;
    response.setHeader("Location", signedUrl);
    response.setHeader(
      "Set-Cookie",
      [
        `${PAID_ACQUISITION_RECEIPT_COOKIE}=${claimCookie}`,
        `Max-Age=${PAID_ACQUISITION_RECEIPT_MAX_AGE_SECONDS}`,
        "Path=/",
        "Secure",
        "HttpOnly",
        "SameSite=Lax",
      ].join("; "),
    );
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.end();
  } catch (error) {
    if (
      error instanceof PaidAcquisitionError &&
      error.code === "invalid_request"
    ) {
      return sendError(response, 400, "invalid_request");
    }
    return sendError(response, 503, "temporarily_unavailable");
  }
}

function isSafeHttpsUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function sendError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  retryAfterSeconds?: number,
) {
  const body = JSON.stringify({ error: code, code });
  response.statusCode = statusCode;
  if (retryAfterSeconds) {
    response.setHeader("Retry-After", String(retryAfterSeconds));
  }
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(Buffer.byteLength(body)));
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(body);
}

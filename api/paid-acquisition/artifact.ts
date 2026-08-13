import { waitUntil } from "@vercel/functions";
import type { ServerResponse } from "node:http";
import {
  fulfillCheckoutSession,
  getBaseUrl,
  getClientIp,
  methodNotAllowed,
  resolveRequestLicenseEnvironment,
  type AccountRequest,
} from "../_lib/account.js";
import {
  PAID_ACQUISITION_RECEIPT_COOKIE,
  PaidAcquisitionError,
  getPaidAcquisitionReceiptState,
  recordPaidAcquisitionInstallerRequest,
  serializePaidAcquisitionReceiptCookie,
  validatePaidAcquisitionReceiptCookie,
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
import { createSignedPaidDownloadUrl } from "../_lib/paid-download.js";

const RECEIPT = /^[A-Za-z0-9_-]{43}$/;
const HANDOFF_BODY_MAX_BYTES = 128;

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  response.setHeader("Cache-Control", "no-store");
  const method = (request.method || "GET").toUpperCase();
  if (method === "POST") {
    return createPaidArtifactHandoff(request, response);
  }
  if (method !== "GET") return methodNotAllowed(response, "GET, POST");

  const requestUrl = new URL(
    request.url || "/api/paid-acquisition/artifact",
    "https://sidestream.tv",
  );
  const entries = [...requestUrl.searchParams.entries()];
  if (
    entries.length === 1 &&
    requestUrl.searchParams.getAll("handoff").length === 1
  ) {
    const handoff = requestUrl.searchParams.get("handoff") || "";
    if (!RECEIPT.test(handoff)) {
      return sendError(response, 404, "artifact_not_found");
    }
    const target = new URL("/api/paid-acquisition/artifact", "https://sidestream.tv");
    target.searchParams.set("receipt", handoff);
    target.searchParams.set(
      "platform",
      paidPlatformFromUserAgent(firstHeaderValue(request.headers["user-agent"])),
    );
    response.statusCode = 302;
    response.setHeader("Location", `${target.pathname}${target.search}`);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.end();
    return;
  }
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

    const claimCookie = serializePaidAcquisitionReceiptCookie({
      receipt,
      environment: environment.namespace,
      secret: receiptSecret,
    });
    response.statusCode = 302;
    response.setHeader("Location", signedUrl);
    response.setHeader("Set-Cookie", claimCookie);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.end();
    schedulePaidArtifactTracking({
      acquisitionId: state.acquisition_id,
      checkoutId: state.id,
      platform,
      occurredAt: new Date(),
    });
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

async function createPaidArtifactHandoff(
  request: AccountRequest,
  response: ServerResponse,
) {
  if (!isJsonContentType(firstHeaderValue(request.headers["content-type"]))) {
    return sendError(response, 415, "unsupported_media_type");
  }
  try {
    const payload = await readHandoffPayload(request);
    if (
      !payload ||
      Object.keys(payload).length !== 1 ||
      payload.handoffOnly !== true
    ) {
      return sendError(response, 400, "invalid_request");
    }
  } catch {
    return sendError(response, 400, "invalid_request");
  }

  const environment = resolveRequestLicenseEnvironment(request);
  const receiptSecret =
    process.env.SIDESTREAM_PAID_ACQUISITION_RECEIPT_SECRET?.trim() || "";
  if (!environment || Buffer.byteLength(receiptSecret, "utf8") < 32) {
    return sendError(response, 503, "temporarily_unavailable");
  }

  try {
    const receipt = validatePaidAcquisitionReceiptCookie({
      cookieValue: readSingleCookie(
        request.headers.cookie,
        PAID_ACQUISITION_RECEIPT_COOKIE,
      ),
      environment: environment.namespace,
      secret: receiptSecret,
    });
    const state = await getPaidAcquisitionReceiptState({
      environment: environment.namespace,
      receipt,
    });
    if (!state || !state.verified_checkout_session_ref) {
      return sendError(response, 403, "payment_inactive");
    }
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
    if (
      state.payment_state !== "active" ||
      state.entitlement_status !== "active"
    ) {
      return sendError(response, 403, "payment_inactive");
    }

    const handoffUrl = new URL(
      "/api/paid-acquisition/artifact",
      getBaseUrl(request),
    );
    handoffUrl.searchParams.set("handoff", receipt);
    return sendJson(response, 200, {
      ok: true,
      handoffUrl: handoffUrl.toString(),
    });
  } catch {
    return sendError(response, 403, "payment_inactive");
  }
}

async function readHandoffPayload(request: AccountRequest) {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > HANDOFF_BODY_MAX_BYTES) {
      throw new Error("handoff body too large");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

function isJsonContentType(value: string) {
  return value.split(";", 1)[0].trim().toLowerCase() === "application/json";
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

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function paidPlatformFromUserAgent(value: string) {
  return /Windows/i.test(value) ? "windows-x64" : "macos-universal";
}

function schedulePaidArtifactTracking(event: Readonly<{
  acquisitionId: string | null;
  checkoutId: string;
  platform: "macos-universal" | "windows-x64";
  occurredAt: Date;
}>) {
  if (!event.acquisitionId) {
    console.error("[sidestream paid artifact] acquisition tracking unavailable", {
      code: "acquisition_linkage_missing",
    });
    return;
  }
  try {
    waitUntil(recordPaidAcquisitionInstallerRequest({
      acquisitionId: event.acquisitionId,
      checkoutId: event.checkoutId,
      platform: event.platform,
      occurredAt: event.occurredAt,
    }).catch(() => {
      console.error("[sidestream paid artifact] acquisition tracking unavailable", {
        code: "acquisition_stage_write_failed",
      });
    }));
  } catch {
    console.error("[sidestream paid artifact] acquisition tracking unavailable", {
      code: "acquisition_schedule_failed",
    });
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

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
) {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(Buffer.byteLength(body)));
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(body);
}

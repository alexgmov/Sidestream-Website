import type { ServerResponse } from "node:http";
import {
  cleanString,
  getClientIp,
  methodNotAllowed,
  readJsonBody,
  resolveRequestLicenseEnvironment,
  sendJson,
  type AccountRequest,
} from "../_lib/account.js";
import { serializeDownloadCreditFinalization } from "../_lib/download-credit-response.js";
import { isDownloadCreditServiceEnabled } from "../_lib/download-credit-pack.js";
import {
  finalizeDownloadCredits,
  normalizeCreditReservationKey,
  type DownloadCreditOutcome,
} from "../_lib/download-credits.js";
import {
  applyRateLimitHeaders,
  consumeRateLimit,
  sendRateLimitExceeded,
} from "../_lib/rate-limit.js";

type CreditFinalizationPayload = {
  deviceId?: unknown;
  reservationKey?: unknown;
  outcome?: unknown;
};

export default async function handler(request: AccountRequest, response: ServerResponse) {
  if ((request.method || "POST").toUpperCase() !== "POST") {
    return methodNotAllowed(response, "POST");
  }

  try {
    if (!isDownloadCreditServiceEnabled()) return creditServiceUnavailable(response);
    const environment = resolveRequestLicenseEnvironment(request);
    if (!environment) return creditServiceUnavailable(response);
    const payload = await readJsonBody<CreditFinalizationPayload>(request);
    const deviceId = cleanString(payload.deviceId, 240);
    const reservationKey = normalizeCreditReservationKey(payload.reservationKey);
    const outcome = normalizeOutcome(payload.outcome);
    if (!deviceId || !reservationKey || !outcome) {
      return sendJson(response, 400, {
        error: "Invalid credit finalization request",
        code: "credit_request_invalid",
      });
    }

    const rateLimit = await consumeRateLimit({
      scope: "credits:finalize",
      dimensions: [
        { name: "device", value: deviceId, limit: 180 },
        { name: "ip", value: getClientIp(request) || "unknown-client", limit: 700 },
      ],
      windowSeconds: 15 * 60,
    });
    if (!rateLimit.allowed) return sendRateLimitExceeded(response, rateLimit);
    applyRateLimitHeaders(response, rateLimit);

    const result = await finalizeDownloadCredits({
      deviceId,
      environment,
      reservationKey,
      outcome,
    });
    return sendJson(response, 200, serializeDownloadCreditFinalization(result));
  } catch {
    console.error("sidestream_credit_finalization_unavailable");
    return creditServiceUnavailable(response);
  }
}

function normalizeOutcome(value: unknown): DownloadCreditOutcome | null {
  return value === "committed" || value === "released" ? value : null;
}

function creditServiceUnavailable(response: ServerResponse) {
  return sendJson(response, 503, {
    error: "Credit service unavailable",
    code: "credits_unavailable",
    retryable: true,
  });
}

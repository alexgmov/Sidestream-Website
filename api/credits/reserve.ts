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
import { serializeDownloadCreditReservation } from "../_lib/download-credit-response.js";
import { isDownloadCreditServiceEnabled } from "../_lib/download-credit-pack.js";
import {
  normalizeCreditReservationKey,
  normalizeDownloadCreditFormat,
  reserveDownloadCredits,
} from "../_lib/download-credits.js";
import {
  applyRateLimitHeaders,
  consumeRateLimit,
  sendRateLimitExceeded,
} from "../_lib/rate-limit.js";

type CreditReservationPayload = {
  deviceId?: unknown;
  reservationKey?: unknown;
  formatType?: unknown;
};

export default async function handler(request: AccountRequest, response: ServerResponse) {
  if ((request.method || "POST").toUpperCase() !== "POST") {
    return methodNotAllowed(response, "POST");
  }

  try {
    if (!isDownloadCreditServiceEnabled()) return creditServiceUnavailable(response);
    const environment = resolveRequestLicenseEnvironment(request);
    if (!environment) return creditServiceUnavailable(response);
    const payload = await readJsonBody<CreditReservationPayload>(request);
    const deviceId = cleanString(payload.deviceId, 240);
    const reservationKey = normalizeCreditReservationKey(payload.reservationKey);
    const formatType = normalizeDownloadCreditFormat(payload.formatType);
    if (!deviceId || !reservationKey || !formatType) {
      return sendJson(response, 400, {
        error: "Invalid credit reservation request",
        code: "credit_request_invalid",
      });
    }

    const rateLimit = await consumeRateLimit({
      scope: "credits:reserve",
      dimensions: [
        { name: "device", value: deviceId, limit: 120 },
        { name: "ip", value: getClientIp(request) || "unknown-client", limit: 500 },
      ],
      windowSeconds: 15 * 60,
    });
    if (!rateLimit.allowed) return sendRateLimitExceeded(response, rateLimit);
    applyRateLimitHeaders(response, rateLimit);

    const result = await reserveDownloadCredits({
      deviceId,
      environment,
      reservationKey,
      formatType,
    });
    return sendJson(response, 200, serializeDownloadCreditReservation(result));
  } catch {
    console.error("sidestream_credit_reservation_unavailable");
    return creditServiceUnavailable(response);
  }
}

function creditServiceUnavailable(response: ServerResponse) {
  return sendJson(response, 503, {
    error: "Credit service unavailable",
    code: "credits_unavailable",
    retryable: true,
  });
}

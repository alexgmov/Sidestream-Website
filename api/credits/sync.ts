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
import { serializeDownloadCreditSnapshot } from "../_lib/download-credit-response.js";
import {
  synchronizeDownloadCredits,
} from "../_lib/download-credits.js";
import {
  getConfiguredDownloadCreditPack,
  isDownloadCreditServiceEnabled,
  serializeDownloadCreditPack,
} from "../_lib/download-credit-pack.js";
import {
  applyRateLimitHeaders,
  consumeRateLimit,
  sendRateLimitExceeded,
} from "../_lib/rate-limit.js";

type CreditSyncPayload = {
  deviceId?: unknown;
  legacyUsedCredits?: unknown;
};

export default async function handler(request: AccountRequest, response: ServerResponse) {
  if ((request.method || "POST").toUpperCase() !== "POST") {
    return methodNotAllowed(response, "POST");
  }

  try {
    if (!isDownloadCreditServiceEnabled()) return creditServiceUnavailable(response);
    const environment = resolveRequestLicenseEnvironment(request);
    if (!environment) return creditServiceUnavailable(response);
    const payload = await readJsonBody<CreditSyncPayload>(request);
    const deviceId = cleanString(payload.deviceId, 240);
    if (!deviceId) {
      return sendJson(response, 400, { error: "Device identity required", code: "device_required" });
    }

    const rateLimit = await consumeRateLimit({
      scope: "credits:sync",
      dimensions: [
        { name: "device", value: deviceId, limit: 60 },
        { name: "ip", value: getClientIp(request) || "unknown-client", limit: 300 },
      ],
      windowSeconds: 15 * 60,
    });
    if (!rateLimit.allowed) return sendRateLimitExceeded(response, rateLimit);
    applyRateLimitHeaders(response, rateLimit);

    const snapshot = await synchronizeDownloadCredits({
      deviceId,
      environment,
      legacyUsedCredits: Number(payload.legacyUsedCredits),
    });
    return sendJson(response, 200, {
      ...serializeDownloadCreditSnapshot(snapshot),
      creditPack: serializeDownloadCreditPack(getConfiguredDownloadCreditPack()),
    });
  } catch {
    console.error("sidestream_credit_sync_unavailable");
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

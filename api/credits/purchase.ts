import type { ServerResponse } from "node:http";
import {
  cleanString,
  getBaseUrl,
  getClientIp,
  methodNotAllowed,
  readJsonBody,
  resolveRequestLicenseEnvironment,
  sendJson,
  type AccountRequest,
} from "../_lib/account.js";
import {
  createDownloadCreditPackCheckout,
} from "../_lib/download-credits.js";
import {
  getConfiguredDownloadCreditPack,
  isDownloadCreditPurchaseEnabled,
  isDownloadCreditServiceEnabled,
} from "../_lib/download-credit-pack.js";
import {
  applyRateLimitHeaders,
  consumeRateLimit,
  sendRateLimitExceeded,
} from "../_lib/rate-limit.js";

type CreditPurchasePayload = {
  deviceId?: unknown;
  packKey?: unknown;
  purchaseRequestKey?: unknown;
};

export default async function handler(request: AccountRequest, response: ServerResponse) {
  if ((request.method || "POST").toUpperCase() !== "POST") {
    return methodNotAllowed(response, "POST");
  }

  try {
    if (
      !isDownloadCreditServiceEnabled() ||
      !isDownloadCreditPurchaseEnabled()
    ) return purchaseUnavailable(response);
    const environment = resolveRequestLicenseEnvironment(request);
    if (!environment) return purchaseUnavailable(response);
    const pack = getConfiguredDownloadCreditPack();
    if (!pack) return purchaseUnavailable(response);
    const payload = await readJsonBody<CreditPurchasePayload>(request);
    const deviceId = cleanString(payload.deviceId, 240);
    const packKey = cleanString(payload.packKey, 64);
    const purchaseRequestKey = cleanString(payload.purchaseRequestKey, 96);
    if (
      !deviceId ||
      packKey !== pack.key ||
      !/^credit-purchase-[0-9a-f]{32,64}$/.test(purchaseRequestKey)
    ) {
      return sendJson(response, 400, {
        error: "Invalid credit purchase request",
        code: "credit_purchase_invalid",
      });
    }

    const rateLimit = await consumeRateLimit({
      scope: "credits:purchase",
      dimensions: [
        { name: "device", value: deviceId, limit: 8 },
        { name: "ip", value: getClientIp(request) || "unknown-client", limit: 20 },
      ],
      windowSeconds: 15 * 60,
    });
    if (!rateLimit.allowed) return sendRateLimitExceeded(response, rateLimit);
    applyRateLimitHeaders(response, rateLimit);

    const baseUrl = getBaseUrl(request);
    const checkout = await createDownloadCreditPackCheckout({
      deviceId,
      environment,
      packKey,
      purchaseRequestKey,
      successUrl: new URL("/credit-complete.html?status=success", baseUrl).toString(),
      cancelUrl: new URL("/credit-complete.html?status=cancelled", baseUrl).toString(),
    });
    return sendJson(response, 200, checkout);
  } catch (error) {
    console.error("sidestream_credit_purchase_unavailable", safeErrorCode(error));
    return purchaseUnavailable(response);
  }
}

function safeErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return "unknown";
  const candidate = "code" in error
    ? String((error as { code?: unknown }).code || "")
    : "";
  return /^[A-Za-z0-9_]{1,80}$/.test(candidate) ? candidate : "unavailable";
}

function purchaseUnavailable(response: ServerResponse) {
  return sendJson(response, 503, {
    error: "Credit purchases are unavailable",
    code: "credit_purchases_unavailable",
    retryable: true,
  });
}

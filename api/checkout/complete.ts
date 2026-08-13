import type { ServerResponse } from "node:http";
import {
  cleanString,
  fulfillCheckoutSession,
  getBaseUrl,
  methodNotAllowed,
  redirect,
  sendJson,
  type AccountRequest,
} from "../_lib/account.js";

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "GET").toUpperCase();
  if (method !== "GET") return methodNotAllowed(response, "GET");

  const baseUrl = getBaseUrl(request);
  const requestUrl = new URL(request.url || "/api/checkout/complete", baseUrl);
  const checkoutSessionId = cleanString(requestUrl.searchParams.get("session_id"), 160);
  const activationKey = cleanString(requestUrl.searchParams.get("activation"), 160);
  if (!checkoutSessionId) {
    return sendJson(response, 400, { error: "Missing Checkout Session" });
  }

  const fulfillment = await fulfillCheckoutSession(checkoutSessionId, activationKey);
  if (!fulfillment.fulfilled) {
    return sendJson(response, 409, {
      error: "Checkout is not ready for fulfillment",
      code: fulfillment.reason,
    });
  }

  if (
    "paidAcquisitionReceiptCookie" in fulfillment &&
    typeof fulfillment.paidAcquisitionReceiptCookie === "string" &&
    fulfillment.paidAcquisitionReceiptCookie
  ) {
    response.setHeader("Set-Cookie", fulfillment.paidAcquisitionReceiptCookie);
  }

  const destination = new URL(
    "paidAcquisition" in fulfillment && fulfillment.paidAcquisition === true
      ? "/paid-thank-you.html"
      : "/thank-you.html",
    baseUrl,
  );
  destination.searchParams.set("checkout", "success");
  if (activationKey) destination.searchParams.set("activation", activationKey);
  return redirect(response, destination.toString());
}

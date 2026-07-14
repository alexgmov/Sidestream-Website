import type { ServerResponse } from "node:http";
import {
  getAccountDeviceStatus,
  getSession,
  methodNotAllowed,
  resolveRequestLicenseEnvironment,
  sendJson,
  type AccountRequest,
} from "../_lib/account.js";

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "GET").toUpperCase();
  if (method !== "GET") return methodNotAllowed(response, "GET");

  try {
    const session = await getSession(request, { reconcileStripeEvents: false });
    if (!session) {
      return sendJson(response, 401, { code: "authentication_required" });
    }

    const environment = resolveRequestLicenseEnvironment(request);
    if (!environment) return statusUnavailable(response);
    const status = await getAccountDeviceStatus(
      session.accountId,
      environment,
    );
    return sendJson(response, 200, status);
  } catch {
    console.error("sidestream_account_device_status_unavailable");
    return statusUnavailable(response);
  }
}

function statusUnavailable(response: ServerResponse) {
  return sendJson(response, 503, {
    code: "device_status_unavailable",
    retryable: true,
  });
}

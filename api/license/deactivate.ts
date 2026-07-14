import type { ServerResponse } from "node:http";
import {
  cleanString,
  deactivateAccountDevice,
  DEVICE_DEACTIVATION_INTENT,
  getSession,
  methodNotAllowed,
  readJsonBody,
  resolveRequestLicenseEnvironment,
  sendJson,
  validateSameOriginJsonMutation,
  type AccountRequest,
} from "../_lib/account.js";

type DeviceDeactivationPayload = {
  intent?: unknown;
};

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "POST").toUpperCase();
  if (method !== "POST") return methodNotAllowed(response, "POST");

  try {
    const session = await getSession(request);
    if (!session) {
      return sendJson(response, 401, { code: "authentication_required" });
    }

    const payload = await readJsonBody<DeviceDeactivationPayload>(request);
    const intent = cleanString(payload.intent, 64);
    if (intent !== DEVICE_DEACTIVATION_INTENT) {
      return sendJson(response, 400, { code: "invalid_intent" });
    }
    if (!validateSameOriginJsonMutation(request)) {
      return sendJson(response, 403, { code: "same_origin_required" });
    }

    const environment = resolveRequestLicenseEnvironment(request);
    if (!environment) return deactivationUnavailable(response);
    const result = await deactivateAccountDevice({
      accountId: session.accountId,
      environment,
    });
    return sendJson(response, 200, result);
  } catch {
    console.error("sidestream_device_deactivation_unavailable");
    return deactivationUnavailable(response);
  }
}

function deactivationUnavailable(response: ServerResponse) {
  return sendJson(response, 503, {
    code: "deactivation_unavailable",
    retryable: true,
  });
}

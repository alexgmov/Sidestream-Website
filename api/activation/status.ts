import type { ServerResponse } from "node:http";
import {
  cleanString,
  getActivationStatus,
  methodNotAllowed,
  readJsonBody,
  resolveRequestLicenseEnvironment,
  sendJson,
  type AccountRequest,
} from "../_lib/account.js";

type ActivationStatusPayload = {
  activationKey?: unknown;
  deviceId?: unknown;
  platform?: unknown;
};

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "POST").toUpperCase();
  if (method !== "POST") return methodNotAllowed(response, "POST");

  const payload = await readJsonBody<ActivationStatusPayload>(request);
  const activationKey = cleanString(payload.activationKey, 160);
  if (!activationKey) {
    return sendJson(response, 400, { error: "Missing activation key", code: "invalid_request" });
  }
  const deviceId = cleanString(payload.deviceId, 240);
  if (!deviceId) {
    return sendJson(response, 400, { error: "Missing device ID", code: "invalid_request" });
  }

  const environment = resolveRequestLicenseEnvironment(request);
  if (!environment) {
    return sendJson(response, 503, {
      error: "License environment unavailable",
      code: "license_environment_unavailable",
    });
  }

  const status = await getActivationStatus(activationKey, deviceId, {
    environment,
    platform: payload.platform,
  });
  return sendJson(response, 200, status);
}

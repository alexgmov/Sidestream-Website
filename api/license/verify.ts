import type { ServerResponse } from "node:http";
import {
  cleanString,
  methodNotAllowed,
  readJsonBody,
  resolveRequestLicenseEnvironment,
  sendJson,
  type AccountRequest,
  verifyLicenseToken,
} from "../_lib/account.js";
import { normalizeTelemetryIdentityInput } from "../_lib/telemetry-identity.js";
type LicenseVerifyPayload = {
  licenseToken?: unknown;
  deviceId?: unknown;
  installIdHash?: unknown;
};

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "POST").toUpperCase();
  if (method !== "POST") return methodNotAllowed(response, "POST");

  const payload = await readJsonBody<LicenseVerifyPayload>(request);
  const licenseToken = cleanString(payload.licenseToken, 500);
  if (!licenseToken) {
    return sendJson(response, 400, { error: "Missing license token", code: "invalid_request" });
  }
  const deviceId = cleanString(payload.deviceId, 240);
  if (!deviceId) {
    return sendJson(response, 400, { error: "Missing device ID", code: "invalid_request" });
  }
  let identity: ReturnType<typeof normalizeTelemetryIdentityInput>;
  try {
    identity = normalizeTelemetryIdentityInput(payload);
  } catch {
    return sendJson(response, 400, {
      error: "Invalid install ID hash",
      code: "invalid_request",
    });
  }

  const environment = resolveRequestLicenseEnvironment(request);
  if (!environment) {
    return sendJson(response, 503, {
      active: false,
      status: "unavailable",
      code: "license_environment_unavailable",
    });
  }

  const verified = await verifyLicenseToken(
    licenseToken,
    deviceId,
    environment,
    identity,
  );
  if (!verified.active) {
    const statusCode = verified.code === "license_inactive" ? 403 : 401;
    return sendJson(response, statusCode, verified);
  }
  return sendJson(response, 200, verified);
}

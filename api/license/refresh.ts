import type { ServerResponse } from "node:http";
import {
  cleanString,
  methodNotAllowed,
  readJsonBody,
  refreshLicenseToken,
  resolveRequestLicenseEnvironment,
  sendJson,
  type AccountRequest,
} from "../_lib/account.js";
import { normalizeTelemetryIdentityInput } from "../_lib/telemetry-identity.js";

type LicenseRefreshPayload = {
  refreshToken?: unknown;
  deviceId?: unknown;
  installIdHash?: unknown;
};

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "POST").toUpperCase();
  if (method !== "POST") return methodNotAllowed(response, "POST");

  const payload = await readJsonBody<LicenseRefreshPayload>(request);
  const refreshToken = cleanString(payload.refreshToken, 500);
  const deviceId = cleanString(payload.deviceId, 240);
  if (!refreshToken || !deviceId) {
    return sendJson(response, 400, { error: "Missing refresh token or device ID", code: "invalid_request" });
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

  const refreshed = await refreshLicenseToken(
    refreshToken,
    deviceId,
    environment,
    identity,
  );
  if (!refreshed.active) {
    const statusCode = refreshed.code === "license_inactive" ? 403 : 401;
    return sendJson(response, statusCode, refreshed);
  }
  return sendJson(response, 200, refreshed);
}

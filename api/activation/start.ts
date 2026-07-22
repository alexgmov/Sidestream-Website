import type { ServerResponse } from "node:http";
import {
  cleanString,
  createActivationSession,
  methodNotAllowed,
  readJsonBody,
  resolveRequestLicenseEnvironment,
  sendJson,
  type AccountRequest,
} from "../_lib/account.js";
import { normalizeTelemetryIdentityInput } from "../_lib/telemetry-identity.js";

type ActivationStartPayload = {
  deviceId?: unknown;
  appVersion?: unknown;
  buildChannel?: unknown;
  source?: unknown;
  installIdHash?: unknown;
};

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "POST").toUpperCase();
  if (method !== "POST") return methodNotAllowed(response, "POST");

  const payload = await readJsonBody<ActivationStartPayload>(request);
  if (!cleanString(payload.deviceId, 240)) {
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
      error: "License environment unavailable",
      code: "license_environment_unavailable",
    });
  }
  const activation = await createActivationSession(
    request,
    {
      deviceId: payload.deviceId,
      appVersion: payload.appVersion,
      buildChannel: payload.buildChannel,
      source: payload.source,
      installIdHash: identity.installIdHash,
    },
    environment,
  );
  return sendJson(response, 200, activation);
}

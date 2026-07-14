import type { ServerResponse } from "node:http";
import {
  cleanString,
  createActivationSession,
  methodNotAllowed,
  readJsonBody,
  sendJson,
  type AccountRequest,
} from "../_lib/account.js";

type ActivationStartPayload = {
  deviceId?: unknown;
  appVersion?: unknown;
  buildChannel?: unknown;
  source?: unknown;
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
  const activation = await createActivationSession(request, payload);
  return sendJson(response, 200, activation);
}

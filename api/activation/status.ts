import type { ServerResponse } from "node:http";
import {
  cleanString,
  getActivationStatus,
  methodNotAllowed,
  readJsonBody,
  sendJson,
  type AccountRequest,
} from "../_lib/account.js";

type ActivationStatusPayload = {
  activationKey?: unknown;
  deviceId?: unknown;
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
    return sendJson(response, 400, { error: "Missing activation key" });
  }

  const status = await getActivationStatus(
    activationKey,
    cleanString(payload.deviceId, 240),
  );
  return sendJson(response, 200, status);
}

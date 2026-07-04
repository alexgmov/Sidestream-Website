import type { ServerResponse } from "node:http";
import {
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
  const activation = await createActivationSession(request, payload);
  return sendJson(response, 200, activation);
}

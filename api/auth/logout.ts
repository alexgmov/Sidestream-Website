import type { ServerResponse } from "node:http";
import {
  clearWebSession,
  methodNotAllowed,
  sendJson,
  type AccountRequest,
} from "../_lib/account.js";

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "POST").toUpperCase();
  if (method !== "POST") return methodNotAllowed(response, "POST");

  await clearWebSession(request, response);
  return sendJson(response, 200, { ok: true });
}

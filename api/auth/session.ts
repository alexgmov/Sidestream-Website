import type { ServerResponse } from "node:http";
import {
  getSession,
  methodNotAllowed,
  publicSessionPayload,
  sendJson,
  type AccountRequest,
} from "../_lib/account";

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "GET").toUpperCase();
  if (method !== "GET") return methodNotAllowed(response, "GET");

  const session = await getSession(request);
  return sendJson(response, 200, publicSessionPayload(session));
}

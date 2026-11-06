import type { ServerResponse } from "node:http";
import type { AccountRequest } from "../_lib/account.js";
import { handleMcpRequest } from "../_lib/mcp.js";

export default function handler(request: AccountRequest, response: ServerResponse) {
  return handleMcpRequest("revoke", request, response);
}

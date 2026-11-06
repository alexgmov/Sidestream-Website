import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export class McpError extends Error {
  constructor(public code: string, public status = 400, message = code, public retryable = false,
    public details: Record<string, unknown> = {}) { super(message); }
}

export const MCP_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const MCP_REQUEST_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function mcpHash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function secret() {
  const value = process.env.SIDESTREAM_MCP_TOKEN_SECRET || process.env.SIDESTREAM_LICENSE_HASH_SECRET || "";
  if (value.length < 32) throw new McpError("mcp_unavailable", 503, "Sidestream connection is temporarily unavailable.", true);
  return value;
}
export function mcpAccessToken(connectionKey: string, pollHash: string) {
  return createHmac("sha256", secret()).update(`sidestream-mcp-access-v1\0${connectionKey}\0${pollHash}`).digest("base64url");
}
export function mcpCsrf(accountId: string, action: string, now = Date.now()) {
  const expiry = Math.floor(now / 1000) + 600;
  const signature = createHmac("sha256", secret()).update(`sidestream-mcp-csrf-v1\0${accountId}\0${action}\0${expiry}`).digest("base64url");
  return `${expiry}.${signature}`;
}
export function validMcpCsrf(value: unknown, accountId: string, action: string, now = Date.now()) {
  if (typeof value !== "string" || !/^[0-9]{10}\.[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const [expiry, signature] = value.split(".");
  if (Number(expiry) < Math.floor(now / 1000) || Number(expiry) > Math.floor(now / 1000) + 600) return false;
  const expected = createHmac("sha256", secret()).update(`sidestream-mcp-csrf-v1\0${accountId}\0${action}\0${expiry}`).digest("base64url");
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
export async function readMcpBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (Number(request.headers["content-length"] || 0) > 16384) throw new McpError("request_too_large", 413);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 16384) throw new McpError("request_too_large", 413);
    chunks.push(bytes);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new McpError("invalid_request", 400, "Send a JSON object."); }
}
export function mcpBearer(request: IncomingMessage) {
  const header = request.headers.authorization;
  const match = typeof header === "string" ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header) : null;
  if (!match) throw new McpError("reconnect_required", 401, "Connect Sidestream to continue.");
  return match[1];
}
export function mcpKey(value: unknown) {
  if (typeof value !== "string" || !MCP_KEY_PATTERN.test(value)) throw new McpError("invalid_connection", 400);
  return value;
}
export function mcpRequestId(value: unknown) {
  if (typeof value !== "string" || !MCP_REQUEST_PATTERN.test(value)) throw new McpError("invalid_request_id", 400);
  return value;
}

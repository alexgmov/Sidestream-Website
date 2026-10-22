import type { ServerResponse } from "node:http";
import { hashPrivateIdentifier, methodNotAllowed, resolveRequestLicenseEnvironment, sendJson, type AccountRequest } from "../_lib/account.js";
import { withPostgresTransaction } from "../_lib/postgres.js";
import { applyRateLimitHeaders, consumeRateLimit } from "../_lib/rate-limit.js";
import { initialHash, issueInitialAuthorization, loadInitialAuthority } from "../_lib/paid-initial-authorization.js";

export default async function handler(request: AccountRequest, response: ServerResponse) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  if (request.method !== "POST") return methodNotAllowed(response, "POST");
  if ((request.url || "").includes("?") || String(request.headers["content-type"] || "").split(";")[0].trim() !== "application/json")
    return sendJson(response, 400, { code: "invalid_request" });
  const environment = resolveRequestLicenseEnvironment(request);
  if (environment?.namespace !== "production") return sendJson(response, 503, { code: "initial_authority_unavailable" });
  let authority;
  try { authority = loadInitialAuthority(process.env); }
  catch { return sendJson(response, 503, { code: "initial_authority_unavailable" }); }
  try {
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); length += bytes.length;
      if (length > 96 * 1024) return sendJson(response, 413, { code: "invalid_request" });
      chunks.push(bytes);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || Object.keys(body).sort().join(",") !== "deviceId,initial,licenseToken" ||
        typeof body.licenseToken !== "string" || !body.licenseToken || body.licenseToken.length > 500 ||
        typeof body.deviceId !== "string" || !body.deviceId || body.deviceId.length > 240) return sendJson(response, 400, { code: "invalid_request" });
    const tokenHash = initialHash(body.licenseToken);
    const rate = await consumeRateLimit({scope: "paid-initial-authorization", dimensions: [{name: "credential", value: tokenHash, limit: 8}], windowSeconds: 900});
    applyRateLimitHeaders(response, rate);
    if (!rate.allowed) return sendJson(response, 429, { code: "rate_limited" });
    const envelope = await withPostgresTransaction(client => issueInitialAuthorization(client, body.initial, authority,
      {tokenHash, deviceIdHash: hashPrivateIdentifier(body.deviceId)}));
    return sendJson(response, 200, envelope);
  } catch {
    // Do not emit receipts, tokens, proof bodies, SQL values or provider errors.
    return sendJson(response, 403, { code: "initial_authorization_refused" });
  }
}

import type { ServerResponse } from "node:http";
import {
  getBaseUrl,
  methodNotAllowed,
  readJsonBody,
  resolveRequestLicenseEnvironment,
  sendJson,
  type AccountRequest,
} from "../_lib/account.js";
import {
  ANONYMOUS_INSTALL_CLAIM_SECRET_NAME,
  getAnonymousInstallationClaimStatus,
} from "../_lib/anonymous-install-claim.js";

const TERMINAL_UNKNOWN = Object.freeze({ state: "terminal_unknown" as const });

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  setPrivateStatusHeaders(response);
  const method = (request.method || "POST").toUpperCase();
  if (method !== "POST") return methodNotAllowed(response, "POST");

  const requestUrl = new URL(
    request.url || "/api/installation/claim-status",
    getBaseUrl(request),
  );
  if (requestUrl.search) return sendJson(response, 400, TERMINAL_UNKNOWN);

  const environment = resolveRequestLicenseEnvironment(request);
  const secret = process.env[ANONYMOUS_INSTALL_CLAIM_SECRET_NAME] || "";
  if (!environment || Buffer.byteLength(secret, "utf8") < 32) {
    return sendJson(response, 503, TERMINAL_UNKNOWN);
  }

  let payload: unknown;
  try {
    payload = await readJsonBody(request);
  } catch {
    return sendJson(response, 400, TERMINAL_UNKNOWN);
  }

  try {
    const status = await getAnonymousInstallationClaimStatus(payload, {
      environment,
      secret,
    });
    return sendJson(response, 200, status);
  } catch {
    return sendJson(response, 400, TERMINAL_UNKNOWN);
  }
}

function setPrivateStatusHeaders(response: ServerResponse) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'none'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
}

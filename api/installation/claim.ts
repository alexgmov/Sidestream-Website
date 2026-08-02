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
  AnonymousInstallationClaimError,
  buildAnonymousInstallationClaimUrl,
  createAnonymousInstallationClaim,
} from "../_lib/anonymous-install-claim.js";

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  const method = (request.method || "POST").toUpperCase();
  if (method !== "POST") return methodNotAllowed(response, "POST");

  const requestUrl = new URL(request.url || "/api/installation/claim", getBaseUrl(request));
  if (requestUrl.search) {
    return sendJson(response, 400, {
      error: "Invalid installation claim",
      code: "invalid_request",
    });
  }
  const environment = resolveRequestLicenseEnvironment(request);
  const secret = process.env[ANONYMOUS_INSTALL_CLAIM_SECRET_NAME] || "";
  if (!environment || Buffer.byteLength(secret, "utf8") < 32) {
    return sendJson(response, 503, {
      error: "Installation association unavailable",
      code: "claim_unavailable",
    });
  }

  let payload: unknown;
  try {
    payload = await readJsonBody(request);
  } catch {
    return sendJson(response, 400, {
      error: "Invalid installation claim",
      code: "invalid_request",
    });
  }

  try {
    const claim = await createAnonymousInstallationClaim(payload, {
      environment,
      secret,
    });
    return sendJson(response, 200, {
      browserUrl: buildAnonymousInstallationClaimUrl(getBaseUrl(request), claim.nonce),
      expiresAt: claim.expiresAt,
    });
  } catch (error) {
    if (error instanceof AnonymousInstallationClaimError) {
      const status = error.code === "invalid_request" ||
          error.code === "invalid_customer_identity"
        ? 400
        : 503;
      return sendJson(response, status, {
        error: status === 400
          ? "Invalid installation claim"
          : "Installation association unavailable",
        code: error.code,
      });
    }
    return sendJson(response, 503, {
      error: "Installation association unavailable",
      code: "claim_unavailable",
    });
  }
}

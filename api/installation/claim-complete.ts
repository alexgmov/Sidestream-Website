import type { ServerResponse } from "node:http";
import {
  getBaseUrl,
  methodNotAllowed,
  resolveRequestLicenseEnvironment,
  type AccountRequest,
} from "../_lib/account.js";
import {
  readBrowserAcquisitionCookie,
  verifyBrowserAcquisitionCookie,
} from "../_lib/acquisition-cookie.js";
import {
  ANONYMOUS_INSTALL_CLAIM_SECRET_NAME,
  AnonymousInstallationClaimError,
  completeAnonymousInstallationClaim,
} from "../_lib/anonymous-install-claim.js";

const HTML = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"robots\" content=\"noindex,nofollow\"><title>Sidestream connected</title></head><body><main><p>Sidestream connected.</p><p>Return to Premiere Pro.</p></main></body></html>";

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  setPrivateHtmlHeaders(response);
  const method = (request.method || "GET").toUpperCase();
  if (method !== "GET") return methodNotAllowed(response, "GET");

  const environment = resolveRequestLicenseEnvironment(request);
  const secret = process.env[ANONYMOUS_INSTALL_CLAIM_SECRET_NAME] || "";
  if (!environment || Buffer.byteLength(secret, "utf8") < 32) {
    return sendConnectedHtml(response, 503);
  }
  const requestUrl = new URL(
    request.url || "/api/installation/claim-complete",
    getBaseUrl(request),
  );
  const nonceValues = requestUrl.searchParams.getAll("nonce");
  if (
    nonceValues.length !== 1 ||
    !nonceValues[0] ||
    [...requestUrl.searchParams.keys()].some((key) => key !== "nonce")
  ) {
    return sendConnectedHtml(response, 400);
  }

  let acquisitionToken = "";
  try {
    const cookieValue = readBrowserAcquisitionCookie(request.headers.cookie);
    acquisitionToken = verifyBrowserAcquisitionCookie(cookieValue, {
      secret,
    }).token;
  } catch {
    // Missing or forged browser state is deliberately indistinguishable from a
    // successful optional association and never consumes the one-time claim.
    return sendConnectedHtml(response, 200);
  }

  try {
    const completed = await completeAnonymousInstallationClaim({
      nonce: nonceValues[0],
      acquisitionToken,
    }, {
      environment,
      secret,
    });
    return sendConnectedHtml(
      response,
      completed.outcome === "expired"
        ? 410
        : completed.outcome === "conflict"
          ? 409
          : 200,
    );
  } catch (error) {
    if (error instanceof AnonymousInstallationClaimError) {
      if (error.code === "claim_expired") return sendConnectedHtml(response, 410);
      if (error.code === "invalid_claim" || error.code === "invalid_request") {
        return sendConnectedHtml(response, 400);
      }
    }
    return sendConnectedHtml(response, 503);
  }
}

function setPrivateHtmlHeaders(response: ServerResponse) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
}

function sendConnectedHtml(response: ServerResponse, statusCode: number) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Content-Length", String(Buffer.byteLength(HTML)));
  response.end(HTML);
}

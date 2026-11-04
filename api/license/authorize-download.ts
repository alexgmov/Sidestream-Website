import type { ServerResponse } from "node:http";
import {
  authorizeLicenseDownload,
  cleanString,
  methodNotAllowed,
  readJsonBody,
  resolveRequestLicenseEnvironment,
  sendJson,
  type AccountRequest,
} from "../_lib/account.js";

type DownloadAuthorizationPayload = {
  licenseToken?: unknown;
  deviceId?: unknown;
  downloadPolicyVersion?: unknown;
};

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "POST").toUpperCase();
  if (method !== "POST") return methodNotAllowed(response, "POST");

  try {
    const environment = resolveRequestLicenseEnvironment(request);
    if (!environment) return authorizationUnavailable(response);

    const payload = await readJsonBody<DownloadAuthorizationPayload>(request);
    if (payload.downloadPolicyVersion !== undefined && payload.downloadPolicyVersion !== 1) {
      return sendJson(response, 400, {
        active: false,
        code: "invalid_download_policy_version",
      });
    }
    const licenseToken = cleanString(payload.licenseToken, 500);
    const deviceId = cleanString(payload.deviceId, 240);
    if (!licenseToken || !deviceId) {
      return sendJson(response, 401, {
        active: false,
        code: "device_deactivated",
      });
    }

    const authorization = await authorizeLicenseDownload({
      licenseToken,
      deviceId,
      environment,
      ...(payload.downloadPolicyVersion === 1 ? { downloadPolicyVersion: 1 as const } : {}),
    });
    if (authorization.active) {
      // Installed clients require the original exact one-key response.
      if (payload.downloadPolicyVersion !== 1) {
        return sendJson(response, 200, { active: true });
      }
      return sendJson(response, 200, {
        active: true,
        purchasePlan: authorization.purchasePlan,
        maxVideoHeight: authorization.maxVideoHeight,
        socialDownloads: authorization.socialDownloads,
      });
    }
    if (authorization.code === "license_inactive") {
      return sendJson(response, 403, {
        active: false,
        code: "license_inactive",
      });
    }
    return sendJson(response, 401, {
      active: false,
      code: authorization.code,
    });
  } catch {
    console.error("sidestream_download_authorization_unavailable");
    return authorizationUnavailable(response);
  }
}

function authorizationUnavailable(response: ServerResponse) {
  return sendJson(response, 503, {
    active: false,
    code: "authorization_unavailable",
    retryable: true,
  });
}

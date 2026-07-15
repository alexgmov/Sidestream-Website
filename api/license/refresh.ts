import type { ServerResponse } from "node:http";
import {
  cleanString,
  methodNotAllowed,
  readJsonBody,
  refreshLicenseToken,
  resolveRequestLicenseEnvironment,
  sendJson,
  type AccountRequest,
} from "../_lib/account.js";

type LicenseRefreshPayload = {
  refreshToken?: unknown;
  deviceId?: unknown;
  installIdHash?: unknown;
  supportCode?: unknown;
  installerReceiptIdHash?: unknown;
};

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "POST").toUpperCase();
  if (method !== "POST") return methodNotAllowed(response, "POST");

  const payload = await readJsonBody<LicenseRefreshPayload>(request);
  const refreshToken = cleanString(payload.refreshToken, 500);
  const deviceId = cleanString(payload.deviceId, 240);
  if (!refreshToken || !deviceId) {
    return sendJson(response, 400, { error: "Missing refresh token or device ID", code: "invalid_request" });
  }
  const identity = readCustomerIdentityFields(payload);
  if (!identity) {
    return sendJson(response, 400, {
      error: "Invalid customer identity",
      code: "invalid_customer_identity",
    });
  }

  const environment = resolveRequestLicenseEnvironment(request);
  if (!environment) {
    return sendJson(response, 503, {
      active: false,
      status: "unavailable",
      code: "license_environment_unavailable",
    });
  }

  const refreshed = await refreshLicenseToken(
    refreshToken,
    deviceId,
    environment,
    identity,
  );
  if (!refreshed.active) {
    const statusCode = refreshed.code === "license_inactive" ? 403 : 401;
    return sendJson(response, statusCode, refreshed);
  }
  return sendJson(response, 200, refreshed);
}

function readCustomerIdentityFields(payload: LicenseRefreshPayload) {
  const installIdHash = readOptionalIdentity(payload.installIdHash, /^[0-9a-f]{64}$/);
  const supportCode = readOptionalIdentity(
    payload.supportCode,
    /^SIDE-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/,
  );
  const installerReceiptIdHash = readOptionalIdentity(
    payload.installerReceiptIdHash,
    /^[0-9a-f]{64}$/,
  );
  if ([installIdHash, supportCode, installerReceiptIdHash].includes(null)) return null;
  return {
    ...(installIdHash ? { installIdHash } : {}),
    ...(supportCode ? { supportCode } : {}),
    ...(installerReceiptIdHash ? { installerReceiptIdHash } : {}),
  };
}

function readOptionalIdentity(value: unknown, pattern: RegExp): string | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "string" && pattern.test(value) ? value : null;
}

import type { ServerResponse } from "node:http";
import {
  cleanString,
  methodNotAllowed,
  readJsonBody,
  sendJson,
  type AccountRequest,
  verifyLicenseToken,
} from "../_lib/account";

type LicenseVerifyPayload = {
  licenseToken?: unknown;
  deviceId?: unknown;
};

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "POST").toUpperCase();
  if (method !== "POST") return methodNotAllowed(response, "POST");

  const payload = await readJsonBody<LicenseVerifyPayload>(request);
  const licenseToken = cleanString(payload.licenseToken, 500);
  if (!licenseToken) {
    return sendJson(response, 400, { error: "Missing license token" });
  }

  return sendJson(
    response,
    200,
    await verifyLicenseToken(licenseToken, cleanString(payload.deviceId, 240)),
  );
}

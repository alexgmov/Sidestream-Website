import type { ServerResponse } from "node:http";
import { cleanString, getBaseUrl, methodNotAllowed, readJsonBody, sendJson, type AccountRequest } from "./_lib/account.js";
import { DownloadReferralError, getReferralStatus, referralMode, referralToken, startReferralConnection } from "./_lib/download-referrals.js";
import { referralFailure, referralRequest } from "./_lib/download-referral-http.js";

export default async function handler(request: AccountRequest, response: ServerResponse) {
  if (request.method !== "POST") return methodNotAllowed(response, "POST");
  try {
    const body = await readJsonBody<{ action?: unknown; deviceId?: unknown; referralToken?: unknown }>(request);
    const deviceId = cleanString(body.deviceId, 240);
    if (!deviceId || !["status", "connect"].includes(String(body.action))) throw new DownloadReferralError("referral_request_invalid", 400);
    if (referralMode() === "off" && body.action === "status") return sendJson(response, 200, { enabled: false, state: "disabled" });
    const environment = await referralRequest(request, response, String(body.action), deviceId);
    if (!environment) return;
    if (body.action === "connect") {
      const started = await startReferralConnection(environment, deviceId);
      return sendJson(response, 200, {
        state: "awaiting_connection", connectionToken: started.connectionToken, expiresAt: started.expiresAt,
        connectUrl: `${getBaseUrl(request)}/api/download-referrals/connect?key=${started.browserKey}`, retryAfterSeconds: 3,
      });
    }
    if (body.referralToken !== undefined && !referralToken(body.referralToken)) throw new DownloadReferralError("referral_request_invalid", 400);
    const status = await getReferralStatus(environment, deviceId, referralToken(body.referralToken));
    const { inviteCode, ...publicStatus } = status as typeof status & { inviteCode?: string };
    return sendJson(response, 200, { ...publicStatus, ...(inviteCode ? { invitationUrl: `${getBaseUrl(request)}/r/${inviteCode}` } : {}) });
  } catch (error) { return referralFailure(response, error); }
}

import type { ServerResponse } from "node:http";
import {
  cleanString,
  getActivationStatus,
  methodNotAllowed,
  readJsonBody,
  resolveRequestLicenseEnvironment,
  sendJson,
  type AccountRequest,
} from "../_lib/account.js";
import { getPaidAcquisitionActivationOutcome } from "../_lib/paid-acquisition.js";

type ActivationStatusPayload = {
  activationKey?: unknown;
  deviceId?: unknown;
  platform?: unknown;
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

  const payload = await readJsonBody<ActivationStatusPayload>(request);
  const activationKey = cleanString(payload.activationKey, 160);
  if (!activationKey) {
    return sendJson(response, 400, { error: "Missing activation key", code: "invalid_request" });
  }
  const deviceId = cleanString(payload.deviceId, 240);
  if (!deviceId) {
    return sendJson(response, 400, { error: "Missing device ID", code: "invalid_request" });
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
      error: "License environment unavailable",
      code: "license_environment_unavailable",
    });
  }

  try {
    const paidOutcome = await getPaidAcquisitionActivationOutcome({
      environment: environment.namespace,
      activationKey,
    });
    if (
      paidOutcome &&
      !["pending", "claimed"].includes(paidOutcome)
    ) {
      return sendJson(
        response,
        paidOutcome === "refunded" || paidOutcome === "disputed" ? 403 : 200,
        { status: paidOutcome },
      );
    }
  } catch (error) {
    if (!isPaidSchemaUnavailable(error)) {
      return sendJson(response, 503, {
        error: "Paid activation is temporarily unavailable",
        code: "temporarily_unavailable",
      });
    }
  }

  const status = await getActivationStatus(activationKey, deviceId, {
    environment,
    platform: payload.platform,
    identity,
  });
  return sendJson(response, 200, status);
}

function isPaidSchemaUnavailable(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    ["42P01", "42703"].includes(
      String((error as { code?: unknown }).code || ""),
    ),
  );
}

function readCustomerIdentityFields(payload: ActivationStatusPayload) {
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

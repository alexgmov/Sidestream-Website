import type { ServerResponse } from "node:http";
import {
  handleActivationClaim,
} from "./claim.js";
import {
  resolveRequestLicenseEnvironment,
  type AccountRequest,
} from "../_lib/account.js";
import {
  PAID_ACQUISITION_RECEIPT_COOKIE,
  PAID_ACQUISITION_SOURCE,
  validatePaidAcquisitionReceiptCookie,
} from "../_lib/paid-acquisition.js";

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const paidAcquisitionReceipt = readValidPaidReceipt(request);
  return handleActivationClaim(request, response, {
    claimPath: "/api/activation/paid-claim",
    requiredActivationSource: PAID_ACQUISITION_SOURCE,
    inactiveEntitlementMode: "support_only",
    googlePrompt: "select_account",
    ...(paidAcquisitionReceipt ? { paidAcquisitionReceipt } : {}),
  });
}

function readValidPaidReceipt(request: AccountRequest) {
  const environment = resolveRequestLicenseEnvironment(request);
  const secret =
    process.env.SIDESTREAM_PAID_ACQUISITION_RECEIPT_SECRET?.trim() || "";
  if (!environment || Buffer.byteLength(secret, "utf8") < 32) return "";
  try {
    return validatePaidAcquisitionReceiptCookie({
      cookieValue: readSingleCookie(
        request.headers.cookie,
        PAID_ACQUISITION_RECEIPT_COOKIE,
      ),
      environment: environment.namespace,
      secret,
    });
  } catch {
    return "";
  }
}

function readSingleCookie(
  value: string | string[] | undefined,
  name: string,
) {
  const header = Array.isArray(value) ? value.join(";") : value || "";
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return matches.length === 1 ? decodeURIComponent(matches[0]) : "";
}

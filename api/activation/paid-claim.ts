import type { ServerResponse } from "node:http";
import {
  handleActivationClaim,
} from "./claim.js";
import type { AccountRequest } from "../_lib/account.js";
import {
  PAID_ACQUISITION_SOURCE,
} from "../_lib/paid-acquisition.js";

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  return handleActivationClaim(request, response, {
    claimPath: "/api/activation/paid-claim",
    requiredActivationSource: PAID_ACQUISITION_SOURCE,
    inactiveEntitlementMode: "support_only",
  });
}

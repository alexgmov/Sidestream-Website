import type { ServerResponse } from "node:http";
import {
  getBaseUrl,
  getStripe,
  methodNotAllowed,
  requireSession,
  sendJson,
  type AccountRequest,
} from "../_lib/account";

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "POST").toUpperCase();
  if (method !== "POST") return methodNotAllowed(response, "POST");

  const session = await requireSession(request, response);
  if (!session) return;

  if (!session.stripeCustomerId) {
    return sendJson(response, 400, { error: "No Stripe customer is linked to this account yet" });
  }

  const portalSession = await getStripe().billingPortal.sessions.create({
    customer: session.stripeCustomerId,
    return_url: `${getBaseUrl(request)}/account.html`,
  });

  return sendJson(response, 200, { url: portalSession.url });
}

import type { ServerResponse } from "node:http";
import {
  getStripe,
  getStripeWebhookSecret,
  markStripeEventProcessed,
  methodNotAllowed,
  recordStripeEvent,
  readRequestBody,
  sendJson,
  type AccountRequest,
  upsertLicenseFromCheckoutSession,
  upsertLicenseFromSubscription,
} from "../_lib/account";

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "POST").toUpperCase();
  if (method !== "POST") return methodNotAllowed(response, "POST");

  const rawBody = await readRequestBody(request);
  const signature = request.headers["stripe-signature"];
  if (!signature || Array.isArray(signature)) {
    return sendJson(response, 400, { error: "Missing Stripe signature" });
  }

  let event;
  try {
    event = getStripe().webhooks.constructEvent(
      rawBody,
      signature,
      getStripeWebhookSecret(),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid webhook signature";
    return sendJson(response, 400, { error: message });
  }

  const isNewEvent = await recordStripeEvent(event, rawBody);
  if (!isNewEvent) {
    return sendJson(response, 200, { received: true, duplicate: true });
  }

  switch (event.type) {
    case "checkout.session.completed":
      await upsertLicenseFromCheckoutSession(event.data.object);
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await upsertLicenseFromSubscription(event.data.object);
      break;
    default:
      break;
  }

  await markStripeEventProcessed(event.id);
  return sendJson(response, 200, { received: true });
}

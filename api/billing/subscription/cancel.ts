import type { ServerResponse } from "node:http";
import type Stripe from "stripe";
import {
  canCancelAccountSubscription,
  getStripe,
  getStripeRequestOptions,
  methodNotAllowed,
  requireSession,
  sendJson,
  type AccountRequest,
} from "../../_lib/account.js";

function stripeId(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    return typeof value.id === "string" ? value.id : "";
  }
  return "";
}

function subscriptionPeriodEnd(subscription: Stripe.Subscription) {
  const timestamp = subscription.items?.data?.[0]?.current_period_end;
  return Number.isSafeInteger(timestamp) && Number(timestamp) > 0
    ? new Date(Number(timestamp) * 1_000).toISOString()
    : "";
}

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "POST").toUpperCase();
  if (method !== "POST") return methodNotAllowed(response, "POST");

  const session = await requireSession(request, response);
  if (!session) return;

  if (session.stripeSubscriptionId && session.license.cancelAtPeriodEnd) {
    return sendJson(response, 200, {
      ok: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: session.license.currentPeriodEnd,
      alreadyScheduled: true,
    });
  }

  if (!canCancelAccountSubscription(session)) {
    return sendJson(response, 400, {
      error: "No active Sidestream subscription is available to cancel",
    });
  }
  if (!session.stripeCustomerId) {
    return sendJson(response, 409, {
      error: "The subscription customer is unavailable",
    });
  }

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(
    session.stripeSubscriptionId,
    {},
    getStripeRequestOptions(),
  );
  if (subscription.id !== session.stripeSubscriptionId) {
    return sendJson(response, 409, {
      error: "The subscription could not be verified",
    });
  }
  if (stripeId(subscription.customer) !== session.stripeCustomerId) {
    return sendJson(response, 403, {
      error: "The subscription does not belong to this account",
    });
  }

  if (subscription.cancel_at_period_end) {
    return sendJson(response, 200, {
      ok: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd:
        subscriptionPeriodEnd(subscription) || session.license.currentPeriodEnd,
      alreadyScheduled: true,
    });
  }

  const updated = await stripe.subscriptions.update(
    session.stripeSubscriptionId,
    { cancel_at_period_end: true },
    getStripeRequestOptions(),
  );
  if (
    updated.id !== session.stripeSubscriptionId ||
    stripeId(updated.customer) !== session.stripeCustomerId ||
    updated.cancel_at_period_end !== true
  ) {
    return sendJson(response, 502, {
      error: "Stripe did not confirm the cancellation",
    });
  }

  return sendJson(response, 200, {
    ok: true,
    cancelAtPeriodEnd: true,
    currentPeriodEnd:
      subscriptionPeriodEnd(updated) || session.license.currentPeriodEnd,
    alreadyScheduled: false,
  });
}

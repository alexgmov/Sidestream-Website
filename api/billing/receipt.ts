import type { ServerResponse } from "node:http";
import type Stripe from "stripe";
import {
  getStripe,
  getStripeRequestOptions,
  methodNotAllowed,
  query,
  requireSession,
  sendJson,
  type AccountRequest,
} from "../_lib/account.js";

function normalizeStripeId(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    return String((value as { id?: unknown }).id || "");
  }
  return "";
}

async function getChargeForPaymentIntent(paymentIntentId: string) {
  const paymentIntent = await getStripe().paymentIntents.retrieve(
    paymentIntentId,
    { expand: ["latest_charge"] },
    getStripeRequestOptions(),
  );
  const latestCharge = paymentIntent.latest_charge;
  if (!latestCharge) return { paymentIntent, charge: null };

  if (typeof latestCharge !== "string") {
    return { paymentIntent, charge: latestCharge };
  }

  const charge = await getStripe().charges.retrieve(
    latestCharge,
    {},
    getStripeRequestOptions(),
  );
  return { paymentIntent, charge };
}

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "POST").toUpperCase();
  if (method !== "POST") return methodNotAllowed(response, "POST");

  const session = await requireSession(request, response);
  if (!session) return;

  const result = await query<{
    stripe_checkout_session_id: string | null;
    stripe_payment_intent_id: string | null;
  }>(
    `
      select stripe_checkout_session_id, stripe_payment_intent_id
      from public.sidestream_licenses
      where account_id = $1
      order by updated_at desc
      limit 1
    `,
    [session.accountId],
  );

  const license = result.rows[0];
  let paymentIntentId = license?.stripe_payment_intent_id || "";
  if (!paymentIntentId && license?.stripe_checkout_session_id) {
    const checkoutSession = await getStripe().checkout.sessions.retrieve(
      license.stripe_checkout_session_id,
      {},
      getStripeRequestOptions(),
    );
    paymentIntentId = normalizeStripeId(checkoutSession.payment_intent);
  }

  if (!paymentIntentId) {
    return sendJson(response, 404, { error: "No Sidestream purchase receipt was found" });
  }

  const { paymentIntent, charge } = await getChargeForPaymentIntent(paymentIntentId);
  const customerId = normalizeStripeId(paymentIntent.customer);
  if (
    session.stripeCustomerId &&
    customerId &&
    customerId !== session.stripeCustomerId
  ) {
    return sendJson(response, 403, { error: "Receipt does not belong to this account" });
  }

  const receiptUrl = (charge as Stripe.Charge | null)?.receipt_url || "";
  if (!receiptUrl) {
    return sendJson(response, 404, { error: "Stripe has not generated a receipt URL for this payment" });
  }

  return sendJson(response, 200, { url: receiptUrl });
}

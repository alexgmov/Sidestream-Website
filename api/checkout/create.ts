import type { ServerResponse } from "node:http";
import type Stripe from "stripe";
import {
  bindActivationToAccount,
  cleanString,
  findOrCreateStripeCustomer,
  getBaseUrl,
  getSidestreamUnlimitedPriceId,
  getStripe,
  getStripeRequestOptions,
  methodNotAllowed,
  readJsonBody,
  requireSession,
  sendJson,
  type AccountRequest,
} from "../_lib/account.js";

type CheckoutPayload = {
  activationKey?: unknown;
};

const CHECKOUT_PROMISE_TEXT =
  "One-time payment. No subscription.";
const PLAN_KEY = "sidestream_unlimited";

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "POST").toUpperCase();
  if (method !== "POST") return methodNotAllowed(response, "POST");

  const session = await requireSession(request, response);
  if (!session) return;

  const payload = await readJsonBody<CheckoutPayload>(request);
  const activationKey = cleanString(payload.activationKey, 160);
  if (activationKey) {
    await bindActivationToAccount(activationKey, session.accountId);
  }

  const stripe = getStripe();
  const baseUrl = getBaseUrl(request);
  const stripeCustomerId = await findOrCreateStripeCustomer(session);
  const stripePriceId = await getSidestreamUnlimitedPriceId();
  const successUrl = new URL("/upgrade.html", baseUrl);
  const cancelUrl = new URL("/upgrade.html", baseUrl);
  const metadata: Record<string, string> = {
    sidestream_account_id: session.accountId,
    sidestream_plan: PLAN_KEY,
    sidestream_price_id: stripePriceId,
  };

  successUrl.searchParams.set("checkout", "success");
  cancelUrl.searchParams.set("checkout", "cancelled");
  if (activationKey) {
    successUrl.searchParams.set("activation", activationKey);
    cancelUrl.searchParams.set("activation", activationKey);
    metadata.sidestream_activation_key = activationKey;
  }
  successUrl.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");

  const checkoutParams: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    customer: stripeCustomerId,
    line_items: [{ price: stripePriceId, quantity: 1 }],
    allow_promotion_codes: true,
    billing_address_collection: "auto",
    success_url: successUrl.toString(),
    cancel_url: cancelUrl.toString(),
    client_reference_id: session.accountId,
    custom_text: {
      submit: {
        message: CHECKOUT_PROMISE_TEXT,
      },
    },
    metadata,
    payment_intent_data: {
      metadata,
    },
  };

  const checkoutSession = await stripe.checkout.sessions.create(
    checkoutParams,
    getStripeRequestOptions(),
  );

  return sendJson(response, 200, { url: checkoutSession.url });
}

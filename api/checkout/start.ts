import type { ServerResponse } from "node:http";
import type Stripe from "stripe";
import {
  bindActivationToAccount,
  cleanString,
  findOrCreateStripeCustomer,
  getBaseUrl,
  getSidestreamUnlimitedPriceId,
  getSession,
  getStripe,
  getStripeRequestOptions,
  methodNotAllowed,
  redirect,
  sendJson,
  type AccountRequest,
} from "../_lib/account.js";

const CHECKOUT_PROMISE_TEXT =
  "One-time payment. No subscription.";
const PLAN_KEY = "sidestream_unlimited";

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "GET").toUpperCase();
  if (method !== "GET") return methodNotAllowed(response, "GET");

  const baseUrl = getBaseUrl(request);
  const requestUrl = new URL(request.url || "/api/checkout/start", baseUrl);
  const activationKey = cleanString(requestUrl.searchParams.get("activation"), 160);
  const session = await getSession(request);
  const stripe = getStripe();
  const stripePriceId = await getSidestreamUnlimitedPriceId();
  const successUrl = new URL("/upgrade.html", baseUrl);
  const cancelUrl = new URL("/upgrade.html", baseUrl);
  const metadata: Record<string, string> = {
    sidestream_plan: PLAN_KEY,
    sidestream_price_id: stripePriceId,
  };

  successUrl.searchParams.set("checkout", "success");
  cancelUrl.searchParams.set("checkout", "cancelled");
  successUrl.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");

  if (activationKey) {
    successUrl.searchParams.set("activation", activationKey);
    cancelUrl.searchParams.set("activation", activationKey);
    metadata.sidestream_activation_key = activationKey;
  }

  let stripeCustomerId = "";
  if (session) {
    stripeCustomerId = await findOrCreateStripeCustomer(session);
    metadata.sidestream_account_id = session.accountId;
    if (activationKey) {
      await bindActivationToAccount(activationKey, session.accountId);
    }
  }

  const checkoutParams: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    ...(stripeCustomerId ? { customer: stripeCustomerId } : {}),
    ...(!stripeCustomerId ? { customer_creation: "always" as const } : {}),
    line_items: [{ price: stripePriceId, quantity: 1 }],
    allow_promotion_codes: true,
    billing_address_collection: "auto",
    success_url: successUrl.toString(),
    cancel_url: cancelUrl.toString(),
    client_reference_id: session?.accountId || activationKey || undefined,
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

  if (!checkoutSession.url) {
    return sendJson(response, 502, { error: "Stripe did not return a Checkout URL" });
  }

  return redirect(response, checkoutSession.url);
}

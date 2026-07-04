import type { ServerResponse } from "node:http";
import type Stripe from "stripe";
import {
  bindActivationToAccount,
  cleanString,
  findOrCreateStripeCustomer,
  getBaseUrl,
  getOrCreateBasicSubscriptionPriceId,
  getStripe,
  getStripePreviewRequestOptions,
  methodNotAllowed,
  readJsonBody,
  requireSession,
  sendJson,
  type AccountRequest,
} from "../_lib/account.js";

type CheckoutPayload = {
  activationKey?: unknown;
};

type ManagedPaymentsCheckoutParams = Stripe.Checkout.SessionCreateParams & {
  managed_payments: {
    enabled: boolean;
  };
};

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
  const stripePriceId = await getOrCreateBasicSubscriptionPriceId();
  const successUrl = new URL("/upgrade.html", baseUrl);
  const cancelUrl = new URL("/upgrade.html", baseUrl);

  successUrl.searchParams.set("checkout", "success");
  cancelUrl.searchParams.set("checkout", "cancelled");
  if (activationKey) {
    successUrl.searchParams.set("activation", activationKey);
    cancelUrl.searchParams.set("activation", activationKey);
  }
  successUrl.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");

  const checkoutParams: ManagedPaymentsCheckoutParams = {
    mode: "subscription",
    customer: stripeCustomerId,
    line_items: [{ price: stripePriceId, quantity: 1 }],
    managed_payments: {
      enabled: true,
    },
    allow_promotion_codes: true,
    billing_address_collection: "auto",
    success_url: successUrl.toString(),
    cancel_url: cancelUrl.toString(),
    client_reference_id: session.accountId,
    metadata: {
      sidestream_account_id: session.accountId,
      sidestream_activation_key: activationKey,
    },
    subscription_data: {
      metadata: {
        sidestream_account_id: session.accountId,
        sidestream_activation_key: activationKey,
      },
    },
  };

  const checkoutSession = await stripe.checkout.sessions.create(
    checkoutParams as Stripe.Checkout.SessionCreateParams,
    getStripePreviewRequestOptions(),
  );

  return sendJson(response, 200, { url: checkoutSession.url });
}

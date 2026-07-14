import type { ServerResponse } from "node:http";
import type Stripe from "stripe";
import {
  cleanString,
  findOrCreateStripeCustomer,
  getBaseUrl,
  getSession,
  getSidestreamProPriceId,
  getStripe,
  getStripeRequestOptions,
  methodNotAllowed,
  redirect,
  sendJson,
  SIDESTREAM_PRO_PLAN_KEY,
  type AccountRequest,
} from "../_lib/account.js";
import {
  buildCheckoutCompletionUrl,
  isLegacyVercelHost,
} from "../_lib/entitlement.js";

const CHECKOUT_PROMISE_TEXT =
  "One-time payment. No subscription.";

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "GET").toUpperCase();
  if (method !== "GET") return methodNotAllowed(response, "GET");

  const baseUrl = getBaseUrl(request);
  const requestUrl = new URL(request.url || "/api/checkout/start", baseUrl);
  const activationKey = cleanString(requestUrl.searchParams.get("activation"), 160);
  if (!activationKey && isLegacyVercelHost(request.headers.host)) {
    const retryUrl = new URL("/upgrade.html", baseUrl);
    retryUrl.searchParams.set("checkout", "activation_required");
    return redirect(response, retryUrl.toString(), 302);
  }

  if (activationKey) {
    // Legacy 1.0.12 activation links enter the same authenticated, read-only
    // decision as Restore Purchase. Free accounts explicitly POST from there;
    // active `license.active` owners are never sent to a second purchase.
    const decisionUrl = new URL("/api/activation/claim", baseUrl);
    decisionUrl.searchParams.set("activation", activationKey);
    return redirect(response, decisionUrl.toString(), 302);
  }

  // Activation attachment is intentionally confined to authenticated POST
  // /api/checkout/create (attachCheckoutSessionToActivation and
  // getActivationCheckoutIdempotencyKey), after the user chooses purchase.
  const session = await getSession(request);
  const stripe = getStripe();
  const stripeCustomerId = session
    ? await findOrCreateStripeCustomer(session)
    : "";
  const stripePriceId = await getSidestreamProPriceId();
  const cancelUrl = new URL("/upgrade.html", baseUrl);
  const metadata: Record<string, string> = {
    sidestream_plan: SIDESTREAM_PRO_PLAN_KEY,
    sidestream_price_id: stripePriceId,
  };
  if (session) metadata.sidestream_account_id = session.accountId;

  cancelUrl.searchParams.set("checkout", "cancelled");
  const checkoutParams: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    ...(stripeCustomerId ? { customer: stripeCustomerId } : {}),
    ...(!stripeCustomerId ? { customer_creation: "always" as const } : {}),
    line_items: [{ price: stripePriceId, quantity: 1 }],
    payment_method_types: ["card"],
    allow_promotion_codes: true,
    billing_address_collection: "auto",
    success_url: buildCheckoutCompletionUrl(baseUrl),
    cancel_url: cancelUrl.toString(),
    client_reference_id: session?.accountId || undefined,
    custom_text: {
      submit: {
        message: CHECKOUT_PROMISE_TEXT,
      },
    },
    invoice_creation: {
      enabled: true,
      invoice_data: {
        metadata,
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

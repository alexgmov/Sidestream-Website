import type { ServerResponse } from "node:http";
import type Stripe from "stripe";
import {
  attachCheckoutSessionToActivation,
  cleanString,
  findOrCreateStripeCustomer,
  fulfillCheckoutSession,
  getActivationCheckoutContext,
  getBaseUrl,
  getSidestreamProProductId,
  getSidestreamProPriceId,
  getSession,
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
  getActivationCheckoutIdempotencyKey,
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
  const activation = activationKey
    ? await getActivationCheckoutContext(activationKey)
    : null;
  if (activationKey && !activation) {
    return sendJson(response, 409, { error: "Activation expired or unavailable" });
  }

  const session = await getSession(request);
  if (activationKey && session?.license.active) {
    const restoreUrl = new URL("/api/activation/claim", baseUrl);
    restoreUrl.searchParams.set("activation", activationKey);
    return redirect(response, restoreUrl.toString(), 302);
  }
  const stripe = getStripe();
  if (activation?.checkoutSessionId) {
    const attachedSession = await stripe.checkout.sessions.retrieve(
      activation.checkoutSessionId,
      {},
      getStripeRequestOptions(),
    );
    if (attachedSession.status === "complete") {
      await fulfillCheckoutSession(attachedSession.id, activationKey);
      const completedUrl = new URL("/thank-you.html", baseUrl);
      completedUrl.searchParams.set("checkout", "success");
      completedUrl.searchParams.set("activation", activationKey);
      return redirect(response, completedUrl.toString());
    }
    if (attachedSession.status === "open" && attachedSession.url) {
      return redirect(response, attachedSession.url);
    }
    return sendJson(response, 409, { error: "Attached Checkout Session is unavailable" });
  }

  const stripePriceId = await getSidestreamProPriceId();
  const stripeProductId = getSidestreamProProductId();
  const cancelUrl = new URL("/upgrade.html", baseUrl);
  const metadata: Record<string, string> = {
    sidestream_plan: SIDESTREAM_PRO_PLAN_KEY,
    sidestream_price_id: stripePriceId,
  };

  cancelUrl.searchParams.set("checkout", "cancelled");

  if (activationKey) {
    cancelUrl.searchParams.set("activation", activationKey);
    metadata.sidestream_activation_key = activationKey;
  }

  let stripeCustomerId = "";
  if (session && !activationKey) {
    stripeCustomerId = await findOrCreateStripeCustomer(session);
    metadata.sidestream_account_id = session.accountId;
  }

  const checkoutParams: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    ...(stripeCustomerId ? { customer: stripeCustomerId } : {}),
    ...(!stripeCustomerId ? { customer_creation: "always" as const } : {}),
    line_items: [{ price: stripePriceId, quantity: 1 }],
    payment_method_types: ["card"],
    allow_promotion_codes: true,
    billing_address_collection: "auto",
    success_url: buildCheckoutCompletionUrl(baseUrl, activationKey),
    cancel_url: cancelUrl.toString(),
    ...(activation ? { expires_at: activation.checkoutExpiresAt } : {}),
    client_reference_id: activationKey || session?.accountId || undefined,
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
    {
      ...getStripeRequestOptions(),
      ...(activationKey
        ? { idempotencyKey: getActivationCheckoutIdempotencyKey(activationKey) }
        : {}),
    },
  );

  if (activationKey && activation) {
    const attached = await attachCheckoutSessionToActivation({
      activationKey,
      checkoutSessionId: checkoutSession.id,
      priceId: stripePriceId,
      productId: stripeProductId,
      checkoutExpiresAt: checkoutSession.expires_at || activation.checkoutExpiresAt,
      claimGraceUntil: activation.claimGraceUntil,
    });
    if (!attached) {
      const winner = await getActivationCheckoutContext(activationKey);
      if (winner?.checkoutSessionId) {
        const winnerSession = await stripe.checkout.sessions.retrieve(
          winner.checkoutSessionId,
          {},
          getStripeRequestOptions(),
        );
        if (winnerSession.status === "open" && winnerSession.url) {
          return redirect(response, winnerSession.url);
        }
      }
      if (checkoutSession.status === "open") {
        await stripe.checkout.sessions.expire(checkoutSession.id).catch(() => undefined);
      }
      return sendJson(response, 409, { error: "Could not attach Checkout to activation" });
    }
  }

  if (!checkoutSession.url) {
    return sendJson(response, 502, { error: "Stripe did not return a Checkout URL" });
  }

  return redirect(response, checkoutSession.url);
}

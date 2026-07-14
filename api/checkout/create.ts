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
  getStripe,
  getStripeRequestOptions,
  methodNotAllowed,
  readRequestBody,
  redirect,
  requireSession,
  sendJson,
  SIDESTREAM_PRO_PLAN_KEY,
  type AccountRequest,
} from "../_lib/account.js";
import {
  buildCheckoutCompletionUrl,
  getActivationCheckoutIdempotencyKey,
} from "../_lib/entitlement.js";

type CheckoutPayload = {
  activationKey?: unknown;
  intent?: unknown;
};

const CHECKOUT_PROMISE_TEXT =
  "One-time payment. No subscription.";

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "POST").toUpperCase();
  if (method !== "POST") return methodNotAllowed(response, "POST");

  const session = await requireSession(request, response);
  if (!session) return;

  let checkoutRequest: Awaited<ReturnType<typeof readCheckoutRequest>>;
  try {
    checkoutRequest = await readCheckoutRequest(request);
  } catch {
    return sendJson(response, 400, { error: "Invalid Checkout request" });
  }
  const { payload, browserForm } = checkoutRequest;
  const activationKey = cleanString(payload.activationKey, 160);
  if (
    browserForm &&
    (!activationKey || cleanString(payload.intent, 32) !== "purchase")
  ) {
    return sendJson(response, 400, { error: "Invalid purchase confirmation" });
  }
  const activation = activationKey
    ? await getActivationCheckoutContext(activationKey)
    : null;
  if (activationKey && !activation) {
    return sendJson(response, 409, { error: "Activation expired or unavailable" });
  }

  if (activationKey && session.license.active) {
    const restoreUrl = new URL("/api/activation/claim", getBaseUrl(request));
    restoreUrl.searchParams.set("activation", activationKey);
    return sendCheckoutDestination(response, browserForm, restoreUrl.toString());
  }

  const stripe = getStripe();
  const baseUrl = getBaseUrl(request);
  if (activation?.checkoutSessionId) {
    const attachedSession = await stripe.checkout.sessions.retrieve(
      activation.checkoutSessionId,
      {},
      getStripeRequestOptions(),
    );
    if (attachedSession.status === "complete") {
      await fulfillCheckoutSession(attachedSession.id, activationKey);
      return sendCheckoutDestination(
        response,
        browserForm,
        `${baseUrl}/thank-you.html?checkout=success&activation=${encodeURIComponent(activationKey)}`,
      );
    }
    if (attachedSession.status === "open" && attachedSession.url) {
      return sendCheckoutDestination(response, browserForm, attachedSession.url);
    }
    return sendJson(response, 409, { error: "Attached Checkout Session is unavailable" });
  }

  const stripeCustomerId = activationKey
    ? ""
    : await findOrCreateStripeCustomer(session);
  const stripePriceId = await getSidestreamProPriceId();
  const stripeProductId = getSidestreamProProductId();
  const cancelUrl = new URL("/upgrade.html", baseUrl);
  const metadata: Record<string, string> = {
    sidestream_plan: SIDESTREAM_PRO_PLAN_KEY,
    sidestream_price_id: stripePriceId,
  };
  if (!activationKey) metadata.sidestream_account_id = session.accountId;

  cancelUrl.searchParams.set("checkout", "cancelled");
  if (activationKey) {
    cancelUrl.searchParams.set("activation", activationKey);
    metadata.sidestream_activation_key = activationKey;
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
    client_reference_id: activationKey || session.accountId,
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
          return sendCheckoutDestination(response, browserForm, winnerSession.url);
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
  return sendCheckoutDestination(response, browserForm, checkoutSession.url);
}

async function readCheckoutRequest(request: AccountRequest) {
  const rawContentType = request.headers["content-type"];
  const contentType = (Array.isArray(rawContentType)
    ? rawContentType[0]
    : rawContentType || "").toLowerCase();
  const body = await readRequestBody(request);
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(body);
    return {
      browserForm: true,
      payload: {
        activationKey: form.get("activationKey"),
        intent: form.get("intent"),
      } satisfies CheckoutPayload,
    };
  }

  return {
    browserForm: false,
    payload: (body.trim() ? JSON.parse(body) : {}) as CheckoutPayload,
  };
}

function sendCheckoutDestination(
  response: ServerResponse,
  browserForm: boolean,
  url: string,
) {
  return browserForm
    ? redirect(response, url)
    : sendJson(response, 200, { url });
}

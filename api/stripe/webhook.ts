import { waitUntil } from "@vercel/functions";
import type { ServerResponse } from "node:http";
import type Stripe from "stripe";
import {
  getStripe,
  getStripeWebhookSecret,
  methodNotAllowed,
  readRequestBody,
  sendJson,
  type AccountRequest,
} from "../_lib/account.js";
import {
  drainStripeEventQueue,
  recordStripeEvent,
  type StripeEventDrainSummary,
  type StripeEventLog,
} from "../_lib/stripe-events.js";

const WEBHOOK_DRAIN_BATCH_SIZE = 3;

type StripeWebhookDependencies = Readonly<{
  constructEvent: (rawBody: string, signature: string) => Stripe.Event;
  recordEvent: (event: Stripe.Event, rawBody: string) => Promise<boolean>;
  drainQueue: () => Promise<StripeEventDrainSummary>;
  scheduleBackground: (operation: Promise<void>) => void;
  log: (entry: StripeEventLog) => void;
}>;

const defaultDependencies: StripeWebhookDependencies = {
  constructEvent: (rawBody, signature) => getStripe().webhooks.constructEvent(
    rawBody,
    signature,
    getStripeWebhookSecret(),
  ),
  recordEvent: recordStripeEvent,
  drainQueue: () => drainStripeEventQueue({ batchSize: WEBHOOK_DRAIN_BATCH_SIZE }),
  scheduleBackground: waitUntil,
  log: (entry) => console.error(JSON.stringify(entry)),
};

export function createStripeWebhookHandler(
  overrides: Partial<StripeWebhookDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };

  return async function stripeWebhookHandler(
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

    let event: Stripe.Event;
    try {
      event = dependencies.constructEvent(rawBody, signature);
    } catch {
      return sendJson(response, 400, { error: "Invalid Stripe signature" });
    }

    const inserted = await dependencies.recordEvent(event, rawBody);
    const backgroundDrain = dependencies.drainQueue()
      .then(() => undefined)
      .catch(() => {
        dependencies.log({
          eventId: event.id,
          eventType: event.type,
          attempt: 0,
          outcome: "background_drain_failed",
          durationMs: 0,
        });
      });
    try {
      dependencies.scheduleBackground(backgroundDrain);
    } catch {
      dependencies.log({
        eventId: event.id,
        eventType: event.type,
        attempt: 0,
        outcome: "background_schedule_failed",
        durationMs: 0,
      });
    }

    return sendJson(response, 200, {
      received: true,
      ...(inserted ? {} : { duplicate: true }),
    });
  };
}

export default createStripeWebhookHandler();

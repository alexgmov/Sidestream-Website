import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  drainStripeEventQueue,
  type StripeEventDrainSummary,
} from "../../_lib/stripe-events.js";

const CRON_BATCH_SIZE = 25;
const CRON_LEASE_MS = 10 * 60 * 1_000;

type StripeEventProcessDependencies = Readonly<{
  getCronSecret: () => string;
  drainQueue: () => Promise<StripeEventDrainSummary>;
}>;

const defaultDependencies: StripeEventProcessDependencies = {
  getCronSecret: () => {
    const secret = process.env.CRON_SECRET?.trim() || "";
    if (!secret) throw new Error("CRON_SECRET is not configured");
    return secret;
  },
  drainQueue: () => drainStripeEventQueue({
    batchSize: CRON_BATCH_SIZE,
    leaseMs: CRON_LEASE_MS,
  }),
};

export function createStripeEventProcessHandler(
  overrides: Partial<StripeEventProcessDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };

  return async function processStripeEvents(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    if ((request.method || "GET").toUpperCase() !== "GET") {
      response.setHeader("Allow", "GET");
      return sendJson(response, 405, { error: "Method not allowed" });
    }

    let cronSecret: string;
    try {
      cronSecret = dependencies.getCronSecret();
    } catch {
      return sendJson(response, 503, {
        error: "Stripe event processing is not configured",
        code: "processor_unavailable",
      });
    }
    if (!hasValidBearerSecret(request.headers.authorization, cronSecret)) {
      return sendJson(response, 401, {
        error: "Unauthorized",
        code: "unauthorized",
      });
    }

    try {
      const summary = await dependencies.drainQueue();
      return sendJson(response, 200, { ok: true, ...summary });
    } catch {
      return sendJson(response, 500, {
        error: "Stripe event processing failed",
        code: "processing_failed",
      });
    }
  };
}

function hasValidBearerSecret(
  authorization: string | string[] | undefined,
  secret: string,
) {
  if (!authorization || Array.isArray(authorization)) return false;
  const actualDigest = createHash("sha256").update(authorization).digest();
  const expectedDigest = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

export default createStripeEventProcessHandler();

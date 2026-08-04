import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  createCheckoutIntentConfirmation,
  createOrReuseCheckoutSession,
  getBaseUrl,
  getClientIp,
  getTrustedCheckoutCountry,
  methodNotAllowed,
  readRequestBody,
  resolveRequestLicenseEnvironment,
  type AccountRequest,
  validateSameOriginJsonMutation,
} from "../_lib/account.js";
import {
  PAID_ACQUISITION_COOKIE_NAME,
  PaidAcquisitionError,
  attachPaidAcquisitionCheckoutSession,
  bindPaidAcquisitionCheckoutIntent,
  findPaidAcquisitionCheckoutReplay,
  loadPaidAcquisitionEntry,
  persistPaidAcquisitionCheckoutIntent,
  validatePaidAcquisitionCheckoutEntry,
} from "../_lib/paid-acquisition.js";
import {
  applyRateLimitHeaders,
  consumeRateLimit,
} from "../_lib/rate-limit.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENTRY_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_BODY_BYTES = 4096;

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  response.setHeader("Cache-Control", "no-store");
  const method = (request.method || "POST").toUpperCase();
  if (method !== "POST") return methodNotAllowed(response, "POST");
  if (!validateSameOriginJsonMutation(request)) {
    return sendError(response, 403, "ineligible_entry");
  }

  let payload: Record<string, unknown>;
  try {
    const body = await readRequestBody(request);
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      return sendError(response, 400, "invalid_request");
    }
    payload = body ? JSON.parse(body) : {};
  } catch {
    return sendError(response, 400, "invalid_request");
  }
  if (!isCheckoutPayload(payload)) {
    return sendError(response, 400, "invalid_request");
  }

  const environment = resolveRequestLicenseEnvironment(request);
  const assignmentSecret =
    process.env.SIDESTREAM_PAID_ACQUISITION_ASSIGNMENT_SECRET?.trim() || "";
  const assignmentCookieValue = readSingleCookie(
    request.headers.cookie,
    PAID_ACQUISITION_COOKIE_NAME,
  );
  if (
    !environment ||
    Buffer.byteLength(assignmentSecret, "utf8") < 32
  ) {
    return sendError(response, 503, "temporarily_unavailable");
  }
  if (!assignmentCookieValue) {
    return sendError(response, 403, "ineligible_entry");
  }

  try {
    const storedEntry = await loadPaidAcquisitionEntry(
      payload.entryToken,
      environment.namespace,
    );
    const validatedEntry = validatePaidAcquisitionCheckoutEntry({
      entryToken: payload.entryToken,
      persistedContext: storedEntry.context,
      assignmentCookieValue,
      assignmentSecret,
      trustedEnvironment: environment.namespace,
    });
    const rateLimit = await consumeRateLimit({
      scope: "paid-acquisition:checkout",
      dimensions: [
        {
          name: "entry",
          value: validatedEntry.entryTokenHash,
          limit: 8,
        },
        {
          name: "ip",
          value: getClientIp(request) || "unknown-client",
          limit: 20,
        },
      ],
      windowSeconds: 15 * 60,
    });
    applyRateLimitHeaders(response, rateLimit);
    if (!rateLimit.allowed) {
      return sendError(response, 429, "rate_limited", rateLimit.retryAfterSeconds);
    }

    const replayProbe = bindPaidAcquisitionCheckoutIntent({
      validatedEntry,
      checkoutIntentRef: randomUUID(),
      idempotencyKey: payload.idempotencyKey,
    });
    const replay = await findPaidAcquisitionCheckoutReplay({
      environment: environment.namespace,
      idempotencyKey: payload.idempotencyKey,
      proposedIntent: replayProbe,
    });
    if (replay) {
      return sendSuccess(response, replay.url, true);
    }

    const confirmation = await createCheckoutIntentConfirmation({
      buyerCountry: getTrustedCheckoutCountry(request.headers),
      request,
      response,
    });
    if (!confirmation) {
      return sendError(response, 503, "temporarily_unavailable");
    }
    const intent = bindPaidAcquisitionCheckoutIntent({
      validatedEntry,
      checkoutIntentRef: confirmation.intentId,
      idempotencyKey: payload.idempotencyKey,
    });
    try {
      await persistPaidAcquisitionCheckoutIntent({
        entryId: storedEntry.id,
        intent,
        expiresAt: confirmation.intentExpiresAt,
      });
    } catch (error) {
      if (postgresCode(error) !== "23505") throw error;
      const concurrentReplay = await findPaidAcquisitionCheckoutReplay({
        environment: environment.namespace,
        idempotencyKey: payload.idempotencyKey,
        proposedIntent: replayProbe,
      });
      if (concurrentReplay) {
        return sendSuccess(response, concurrentReplay.url, true);
      }
      return sendError(response, 409, "checkout_conflict");
    }

    const checkout = await createOrReuseCheckoutSession({
      intentId: confirmation.intentId,
      browserToken: confirmation.browserToken,
      session: null,
      baseUrl: getBaseUrl(request),
      paidAcquisition: true,
    });
    if (!checkout.ok) {
      const code =
        checkout.code === "intent_expired"
          ? "checkout_conflict"
          : "temporarily_unavailable";
      return sendError(
        response,
        code === "checkout_conflict" ? 409 : 503,
        code,
      );
    }
    await attachPaidAcquisitionCheckoutSession({
      environment: environment.namespace,
      checkoutIntentRef: confirmation.intentId,
    });
    return sendSuccess(response, checkout.url, checkout.reused);
  } catch (error) {
    if (error instanceof PaidAcquisitionError) {
      if (error.code === "ineligible_entry") {
        return sendError(response, 403, "ineligible_entry");
      }
      if (error.code === "checkout_conflict") {
        return sendError(response, 409, "checkout_conflict");
      }
      if (error.code === "invalid_request") {
        return sendError(response, 400, "invalid_request");
      }
    }
    console.error("[sidestream paid checkout] server failure", {
      code: postgresCode(error) || "checkout_unavailable",
    });
    return sendError(response, 503, "temporarily_unavailable");
  }
}

function isCheckoutPayload(
  payload: Record<string, unknown>,
): payload is {
  schemaVersion: 1;
  entryToken: string;
  idempotencyKey: string;
} {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.getPrototypeOf(payload) !== Object.prototype
  ) {
    return false;
  }
  const keys = Object.keys(payload).sort();
  return (
    keys.join(",") === "entryToken,idempotencyKey,schemaVersion" &&
    payload.schemaVersion === 1 &&
    typeof payload.entryToken === "string" &&
    ENTRY_TOKEN.test(payload.entryToken) &&
    typeof payload.idempotencyKey === "string" &&
    UUID.test(payload.idempotencyKey)
  );
}

function readSingleCookie(
  value: string | string[] | undefined,
  name: string,
) {
  const header = Array.isArray(value) ? value.join(";") : value || "";
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return matches.length === 1 ? matches[0] : "";
}

function postgresCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code || "")
    : "";
}

function sendSuccess(
  response: ServerResponse,
  url: string,
  reused: boolean,
) {
  let valid = false;
  try {
    const parsed = new URL(url);
    valid =
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      parsed.href.length <= 2048;
  } catch {
    valid = false;
  }
  if (!valid) return sendError(response, 503, "temporarily_unavailable");
  const body = JSON.stringify({ url, reused });
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(Buffer.byteLength(body)));
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(body);
}

function sendError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  retryAfterSeconds?: number,
) {
  const body = JSON.stringify({
    error: code,
    code,
  });
  response.statusCode = statusCode;
  if (retryAfterSeconds) {
    response.setHeader("Retry-After", String(retryAfterSeconds));
  }
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(Buffer.byteLength(body)));
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(body);
}

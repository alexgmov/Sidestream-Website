import { waitUntil } from "@vercel/functions";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  buildReferralVisitEvent,
  parseReferralVisitSource,
  recordReferralVisit,
  type ReferralVisitEvent,
} from "./_lib/referral-visits.js";

const MAX_BODY_BYTES = 1_024;
const WRITE_TIMEOUT_MS = 1_500;

type ReferralVisitRequest = IncomingMessage & Readonly<{
  body?: unknown;
}>;

type ReferralVisitDependencies = Readonly<{
  buildEvent: typeof buildReferralVisitEvent;
  recordVisit: (event: ReferralVisitEvent) => Promise<unknown>;
  scheduleBackground: (operation: Promise<void>) => void;
  trackingTimeoutMs: number;
  logTrackingError: (error: unknown) => void;
}>;

export function createReferralVisitHandler(
  overrides: Partial<ReferralVisitDependencies> = {},
) {
  const dependencies: ReferralVisitDependencies = {
    buildEvent: buildReferralVisitEvent,
    recordVisit: recordReferralVisit,
    scheduleBackground: waitUntil,
    trackingTimeoutMs: WRITE_TIMEOUT_MS,
    logTrackingError: (error) => {
      console.error("Sidestream referral visit capture failed", error);
    },
    ...overrides,
  };

  return async function referralVisitHandler(
    request: ReferralVisitRequest,
    response: ServerResponse,
  ) {
    if ((request.method || "GET").toUpperCase() !== "POST") {
      response.setHeader("Allow", "POST");
      return sendJson(response, 405, { error: "Method not allowed" });
    }

    const contentType = firstHeaderValue(request.headers["content-type"]);
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      return sendJson(response, 415, { error: "Content-Type must be application/json" });
    }

    let payload: Record<string, unknown>;
    try {
      payload = await readJsonObject(request);
    } catch (error) {
      const statusCode = error instanceof RequestBodyError ? error.statusCode : 400;
      return sendJson(response, statusCode, { error: "Invalid request body" });
    }

    const source = parseReferralVisitSource(payload.source);
    if (!source) {
      return sendJson(response, 400, { error: "Unsupported referral source" });
    }

    let event: ReferralVisitEvent;
    try {
      event = dependencies.buildEvent(request, source);
    } catch (error) {
      dependencies.logTrackingError(error);
      response.statusCode = 204;
      setResponseHeaders(response);
      response.end();
      return;
    }

    response.statusCode = 204;
    setResponseHeaders(response);
    response.end();

    try {
      dependencies.scheduleBackground(captureReferralVisit(event, dependencies));
    } catch (error) {
      dependencies.logTrackingError(error);
    }
  };
}

export default createReferralVisitHandler();

async function captureReferralVisit(
  event: ReferralVisitEvent,
  dependencies: Pick<
    ReferralVisitDependencies,
    "recordVisit" | "trackingTimeoutMs" | "logTrackingError"
  >,
) {
  try {
    await withTimeout(
      Promise.resolve(dependencies.recordVisit(event)).then(() => undefined),
      dependencies.trackingTimeoutMs,
    );
  } catch (error) {
    dependencies.logTrackingError(error);
  }
}

async function readJsonObject(request: ReferralVisitRequest) {
  if (request.body !== undefined) return parseJsonObject(request.body);

  const declaredLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new RequestBodyError(413);
  }

  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_BODY_BYTES) throw new RequestBodyError(413);
    chunks.push(buffer);
  }

  if (chunks.length === 0) throw new RequestBodyError(400);
  return parseJsonObject(Buffer.concat(chunks).toString("utf8"));
}

function parseJsonObject(input: unknown) {
  let parsed = input;
  if (Buffer.isBuffer(parsed)) parsed = parsed.toString("utf8");
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new RequestBodyError(400);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RequestBodyError(400);
  }
  return parsed as Record<string, unknown>;
}

async function withTimeout(operation: Promise<void>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      operation,
      new Promise<void>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Referral visit write timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
) {
  response.statusCode = statusCode;
  setResponseHeaders(response);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function setResponseHeaders(response: ServerResponse) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

class RequestBodyError extends Error {
  constructor(readonly statusCode: number) {
    super("Invalid request body");
  }
}

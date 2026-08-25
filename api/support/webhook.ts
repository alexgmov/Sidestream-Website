import { waitUntil } from "@vercel/functions";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { Webhook } from "svix";
import {
  loadSupportRuntimeConfig,
  SupportConfigurationError,
  type SupportRuntimeConfig,
} from "../_lib/support-config.js";
import {
  retrieveReceivedSupportEmail,
  type ReceivedSupportEmail,
} from "../_lib/support-email.js";
import { recordInboundSupportMessage } from "../_lib/support-ledger.js";
import { processSupportQueues } from "../_lib/support-queue.js";

const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

type SupportWebhookEvent = Readonly<{
  type: string;
  data?: Readonly<{ email_id?: string }>;
}>;

type SupportWebhookDependencies = Readonly<{
  loadConfig: () => SupportRuntimeConfig;
  verifyWebhook: (
    rawBody: string,
    headers: IncomingHttpHeaders,
    webhookSecret: string,
  ) => SupportWebhookEvent;
  retrieveEmail: (emailId: string, config: SupportRuntimeConfig) => Promise<ReceivedSupportEmail>;
  recordMessage: typeof recordInboundSupportMessage;
  processQueues: typeof processSupportQueues;
  scheduleBackground: (operation: Promise<unknown>) => void;
  log: (entry: Record<string, unknown>) => void;
}>;

const defaultDependencies: SupportWebhookDependencies = {
  loadConfig: loadSupportRuntimeConfig,
  verifyWebhook: verifyResendWebhook,
  retrieveEmail: (emailId, config) => retrieveReceivedSupportEmail({ emailId, config }),
  recordMessage: recordInboundSupportMessage,
  processQueues: processSupportQueues,
  scheduleBackground: waitUntil,
  log: (entry) => console.error(JSON.stringify(entry)),
};

export function createSupportWebhookHandler(
  overrides: Partial<SupportWebhookDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };
  return async function supportWebhookHandler(
    request: IncomingMessage & { body?: unknown },
    response: ServerResponse,
  ) {
    setWebhookHeaders(response);
    if ((request.method || "POST").toUpperCase() !== "POST") {
      response.setHeader("Allow", "POST");
      return sendJson(response, 405, { error: "Method not allowed" });
    }

    let config: SupportRuntimeConfig;
    try {
      config = dependencies.loadConfig();
    } catch (error) {
      const code = error instanceof SupportConfigurationError
        ? "support_automation_unavailable"
        : "support_configuration_failed";
      return sendJson(response, 503, { error: "Support automation unavailable", code });
    }

    let rawBody: string;
    try {
      rawBody = await readRawWebhookBody(request);
    } catch (error) {
      return sendJson(response, error instanceof RequestTooLargeError ? 413 : 400, {
        error: error instanceof RequestTooLargeError ? "Request too large" : "Invalid request body",
      });
    }
    const providerEventId = singleHeader(request.headers["svix-id"]);
    if (!providerEventId || providerEventId.length > 180) {
      return sendJson(response, 400, { error: "Missing webhook identifier" });
    }

    let event: SupportWebhookEvent;
    try {
      event = dependencies.verifyWebhook(rawBody, request.headers, config.resendWebhookSecret);
    } catch {
      return sendJson(response, 400, { error: "Invalid webhook signature" });
    }
    if (event.type !== "email.received") {
      return sendJson(response, 200, { received: true, ignored: true });
    }
    const emailId = event.data?.email_id;
    if (!emailId) return sendJson(response, 400, { error: "Missing received email ID" });

    let email: ReceivedSupportEmail;
    try {
      email = await dependencies.retrieveEmail(emailId, config);
    } catch {
      return sendJson(response, 503, { error: "Received email unavailable" });
    }
    if (!email.recipients.includes(config.inboundAddress)) {
      return sendJson(response, 200, { received: true, ignored: true });
    }

    let recorded: Awaited<ReturnType<typeof recordInboundSupportMessage>>;
    try {
      recorded = await dependencies.recordMessage({
        providerEventId,
        providerMessageId: email.providerMessageId,
        requesterEmail: email.requesterEmail,
        subject: email.subject,
        body: email.body,
        attachmentCount: email.attachmentCount,
        htmlOnly: email.htmlOnly,
      }, config.dataSecret);
    } catch {
      return sendJson(response, 503, { error: "Support intake unavailable" });
    }

    const processing = dependencies.processQueues({
      config,
      jobLimit: 1,
      notificationLimit: 5,
    }).catch(() => {
      dependencies.log({
        event: "support_background_processing_failed",
        messageId: recorded.messageId,
      });
    });
    try {
      dependencies.scheduleBackground(processing);
    } catch {
      dependencies.log({
        event: "support_background_schedule_failed",
        messageId: recorded.messageId,
      });
    }
    return sendJson(response, 200, {
      received: true,
      ticketId: recorded.threadId,
      ...(recorded.inserted ? {} : { duplicate: true }),
    });
  };
}

function verifyResendWebhook(
  rawBody: string,
  headers: IncomingHttpHeaders,
  webhookSecret: string,
) {
  const requiredHeaders = {
    "svix-id": singleHeader(headers["svix-id"]),
    "svix-timestamp": singleHeader(headers["svix-timestamp"]),
    "svix-signature": singleHeader(headers["svix-signature"]),
  };
  if (Object.values(requiredHeaders).some((value) => !value)) {
    throw new Error("Missing webhook signature headers");
  }
  return new Webhook(webhookSecret).verify(rawBody, requiredHeaders) as SupportWebhookEvent;
}

async function readRawWebhookBody(request: IncomingMessage & { body?: unknown }) {
  if (typeof request.body === "string" || Buffer.isBuffer(request.body)) {
    const body = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : request.body;
    if (Buffer.byteLength(body) > MAX_WEBHOOK_BODY_BYTES) throw new RequestTooLargeError();
    return body;
  }
  if (request.body !== undefined) {
    throw new Error("Webhook body was parsed before signature verification");
  }
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new RequestTooLargeError();
  }
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_WEBHOOK_BODY_BYTES) throw new RequestTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function singleHeader(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value.length === 1 ? value[0]?.trim() || "" : "";
  return value?.trim() || "";
}

function setWebhookHeaders(response: ServerResponse) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(response: ServerResponse, statusCode: number, payload: Record<string, unknown>) {
  setWebhookHeaders(response);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

class RequestTooLargeError extends Error {}

export default createSupportWebhookHandler();

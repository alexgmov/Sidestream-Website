import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import {
  consumeBlobRateLimit,
  writeDeterministicDownloadLeadFallback,
} from "./_lib/download-lead-blob.js";
import {
  buildCanonicalDownloadLead,
  DownloadLeadConfigurationError,
  DownloadLeadValidationError,
  DOWNLOAD_LEAD_RATE_LIMIT_PER_EMAIL,
  DOWNLOAD_LEAD_RATE_LIMIT_PER_IP,
  DOWNLOAD_LEAD_RATE_LIMIT_WINDOW_SECONDS,
  getDeterministicLeadBlobPathname,
  MAX_DOWNLOAD_LEAD_BODY_BYTES,
  type CanonicalDownloadLead,
  type DownloadLeadPayload,
} from "./_lib/download-leads.js";
import {
  applyRateLimitHeaders,
  sendRateLimitExceeded,
  type RateLimitResult,
} from "./_lib/rate-limit.js";

const RESOLVE_WAITLIST_SOURCE = "davinci-resolve-waitlist";
export const RESOLVE_WAITLIST_BLOB_PREFIX = "sidestream/resolve-waitlist/v1";

type BlobWaitlistRequest = IncomingMessage & { method?: string };

export type BlobWaitlistHandlerDependencies = Readonly<{
  now: () => Date;
  consumeLimit: (
    lead: CanonicalDownloadLead,
    options: { ipAddress: string; now: Date },
  ) => Promise<RateLimitResult>;
  storeLead: (pathname: string, lead: CanonicalDownloadLead) => Promise<void>;
  log: (entry: Record<string, string | number>) => void;
}>;

export type BlobWaitlistConfiguration = Readonly<{
  source: string;
  blobPrefix: string;
  rateLimitScope: string;
  logEvent: string;
}>;

class RequestBodyError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function createResolveWaitlistHandler(
  overrides: Partial<BlobWaitlistHandlerDependencies> = {},
) {
  return createBlobWaitlistHandler({
    source: RESOLVE_WAITLIST_SOURCE,
    blobPrefix: RESOLVE_WAITLIST_BLOB_PREFIX,
    rateLimitScope: "resolve-waitlist",
    logEvent: "resolve_waitlist_capture",
  }, overrides);
}

export function createBlobWaitlistHandler(
  configuration: BlobWaitlistConfiguration,
  overrides: Partial<BlobWaitlistHandlerDependencies> = {},
) {
  const defaultDependencies: BlobWaitlistHandlerDependencies = {
    now: () => new Date(),
    consumeLimit: (lead, options) => consumeWaitlistRateLimit(
      configuration.rateLimitScope,
      lead,
      options,
    ),
    storeLead: writeDeterministicDownloadLeadFallback,
    log: (entry) => console.info(JSON.stringify(entry)),
  };
  const dependencies = { ...defaultDependencies, ...overrides };

  return async function blobWaitlistHandler(
    request: BlobWaitlistRequest,
    response: ServerResponse,
  ) {
    const method = (request.method || "GET").toUpperCase();
    if (method !== "POST") {
      response.setHeader("Allow", "POST");
      return sendJson(response, 405, { error: "Method not allowed" });
    }
    if (!isJsonContentType(firstHeaderValue(request.headers["content-type"]))) {
      return sendJson(response, 415, {
        error: "Content-Type must be application/json",
        code: "unsupported_media_type",
      });
    }

    let payload: DownloadLeadPayload;
    try {
      const body = await readRequestBody(request, MAX_DOWNLOAD_LEAD_BODY_BYTES);
      payload = JSON.parse(body) as DownloadLeadPayload;
    } catch (error) {
      const bodyError = error instanceof RequestBodyError ? error : null;
      return sendJson(response, bodyError?.statusCode || 400, {
        error: bodyError?.message || "Invalid JSON payload",
        code: bodyError?.code || "invalid_json",
      });
    }

    const now = dependencies.now();
    let lead: CanonicalDownloadLead;
    try {
      lead = buildCanonicalDownloadLead(
        { ...payload, source: configuration.source },
        {
          capturedAt: now,
          referrer: firstHeaderValue(request.headers.referer),
        },
      );
    } catch (error) {
      if (error instanceof DownloadLeadValidationError) {
        return sendJson(response, 400, {
          error: "Invalid waitlist payload",
          code: error.code,
        });
      }
      if (error instanceof DownloadLeadConfigurationError) {
        dependencies.log({
          event: configuration.logEvent,
          outcome: "configuration_error",
          count: 1,
        });
        return sendJson(response, 503, {
          error: "Waitlist temporarily unavailable",
          code: "waitlist_unavailable",
        });
      }
      throw error;
    }

    let rateLimit: RateLimitResult;
    try {
      rateLimit = await dependencies.consumeLimit(lead, {
        ipAddress: getClientIp(request),
        now,
      });
    } catch (error) {
      dependencies.log({
        event: configuration.logEvent,
        outcome: "rate_limit_unavailable",
        count: 1,
        errorCode: safeOperationalErrorCode(error),
      });
      return sendJson(response, 503, {
        error: "Waitlist temporarily unavailable",
        code: "waitlist_unavailable",
      });
    }

    if (!rateLimit.allowed) {
      dependencies.log({
        event: configuration.logEvent,
        outcome: "rate_limited",
        count: 1,
      });
      return sendRateLimitExceeded(response, rateLimit);
    }
    applyRateLimitHeaders(response, rateLimit);

    const pathname = getDeterministicLeadBlobPathname(
      lead.leadKey,
      configuration.blobPrefix,
    );
    try {
      await dependencies.storeLead(pathname, lead);
      dependencies.log({
        event: configuration.logEvent,
        outcome: "accepted",
        count: 1,
      });
      return sendJson(response, 200, { ok: true });
    } catch (error) {
      dependencies.log({
        event: configuration.logEvent,
        outcome: "storage_unavailable",
        count: 1,
        errorCode: safeOperationalErrorCode(error),
      });
      return sendJson(response, 503, {
        error: "Waitlist temporarily unavailable",
        code: "waitlist_unavailable",
      });
    }
  };
}

const handler = createResolveWaitlistHandler();
export default handler;

async function consumeWaitlistRateLimit(
  scope: string,
  lead: CanonicalDownloadLead,
  options: { ipAddress: string; now: Date },
) {
  return consumeBlobRateLimit({
    scope,
    dimensions: [
      {
        name: "email",
        value: lead.email,
        limit: DOWNLOAD_LEAD_RATE_LIMIT_PER_EMAIL,
      },
      {
        name: "ip",
        value: options.ipAddress || "unknown",
        limit: DOWNLOAD_LEAD_RATE_LIMIT_PER_IP,
      },
    ],
    windowSeconds: DOWNLOAD_LEAD_RATE_LIMIT_WINDOW_SECONDS,
    now: options.now,
  });
}

function getClientIp(request: IncomingMessage) {
  const candidates = [
    firstHeaderValue(request.headers["x-forwarded-for"]).split(",")[0],
    firstHeaderValue(request.headers["x-real-ip"]),
    firstHeaderValue(request.headers["cf-connecting-ip"]),
    firstHeaderValue(request.headers["x-vercel-forwarded-for"]).split(",")[0],
    request.socket?.remoteAddress || "",
  ];
  for (const candidate of candidates) {
    const ipAddress = normalizeIpAddress(candidate);
    if (ipAddress) return ipAddress;
  }
  return "unknown";
}

function normalizeIpAddress(value: string) {
  let candidate = value.trim();
  if (!candidate || candidate.toLowerCase() === "unknown") return "";
  if (candidate.startsWith("[") && candidate.includes("]")) {
    candidate = candidate.slice(1, candidate.indexOf("]"));
  }
  const ipv4WithPort = candidate.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (ipv4WithPort) candidate = ipv4WithPort[1];
  return isIP(candidate) ? candidate : "";
}

function isJsonContentType(value: string) {
  return value.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function readRequestBody(request: IncomingMessage, maxBytes: number) {
  const contentLength = firstHeaderValue(request.headers["content-length"]);
  if (contentLength) {
    if (!/^\d+$/.test(contentLength)) {
      throw new RequestBodyError(400, "invalid_content_length", "Invalid Content-Length");
    }
    if (Number(contentLength) > maxBytes) {
      throw new RequestBodyError(413, "payload_too_large", "Request body too large");
    }
  }
  return new Promise<string>((resolve, reject) => {
    let size = 0;
    let body = "";
    let settled = false;
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      if (settled) return;
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        settled = true;
        reject(new RequestBodyError(413, "payload_too_large", "Request body too large"));
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      if (!body) {
        reject(new RequestBodyError(400, "invalid_json", "Invalid JSON payload"));
        return;
      }
      resolve(body);
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function safeOperationalErrorCode(error: unknown) {
  const name = error instanceof Error ? error.name : "operation_error";
  return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? name : "operation_error";
}

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(payload));
}

import {
  BlobError,
  BlobPreconditionFailedError,
  get,
  put,
} from "@vercel/blob";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import {
  buildCanonicalDownloadLead,
  captureDownloadLeadInPostgres,
  DownloadLeadConfigurationError,
  DownloadLeadIdempotencyConflictError,
  DownloadLeadValidationError,
  getDeterministicLeadBlobPathname,
  MAX_DOWNLOAD_LEAD_BODY_BYTES,
  MAX_REPLAY_BLOB_BYTES,
  mergeFallbackLeads,
  parseReplayBlob,
  parseIdempotencyKey,
  serializeFallbackLead,
  type CanonicalDownloadLead,
  type DownloadLeadCaptureResult,
  type DownloadLeadPayload,
} from "./_lib/download-leads.js";
import {
  isPostgresConfigured,
  safePostgresErrorCode,
} from "./_lib/postgres.js";
import {
  applyRateLimitHeaders,
  sendRateLimitExceeded,
} from "./_lib/rate-limit.js";

type LeadRequest = IncomingMessage & { method?: string };

type DownloadLeadHandlerDependencies = Readonly<{
  now: () => Date;
  postgresConfigured: () => boolean;
  capturePostgres: (
    lead: CanonicalDownloadLead,
    options: { ipAddress: string; now: Date },
  ) => Promise<DownloadLeadCaptureResult>;
  writeFallback: (pathname: string, lead: CanonicalDownloadLead) => Promise<void>;
  log: (entry: Record<string, string | number>) => void;
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

const defaultDependencies: DownloadLeadHandlerDependencies = {
  now: () => new Date(),
  postgresConfigured: () => isPostgresConfigured(),
  capturePostgres: (lead, options) => captureDownloadLeadInPostgres(lead, options),
  writeFallback: writeDeterministicFallback,
  log: (entry) => console.info(JSON.stringify(entry)),
};

export function createDownloadLeadHandler(
  overrides: Partial<DownloadLeadHandlerDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };

  return async function downloadLeadHandler(
    request: LeadRequest,
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
      const idempotencyKey = parseIdempotencyKey(
        request.headers["idempotency-key"],
      );
      lead = buildCanonicalDownloadLead(payload, {
        capturedAt: now,
        referrer: firstHeaderValue(request.headers.referer),
        idempotencyKey,
      });
    } catch (error) {
      if (error instanceof DownloadLeadValidationError) {
        return sendJson(response, 400, {
          error: "Invalid lead payload",
          code: error.code,
        });
      }
      if (error instanceof DownloadLeadConfigurationError) {
        dependencies.log({
          event: "download_lead_capture",
          outcome: "configuration_error",
          count: 1,
        });
        return sendJson(response, 503, {
          error: "Lead capture temporarily unavailable",
          code: "capture_unavailable",
        });
      }
      throw error;
    }

    const ipAddress = getClientIp(request);
    let postgresErrorCode = "not_configured";
    let postgresAvailable = false;
    try {
      postgresAvailable = dependencies.postgresConfigured();
    } catch (error) {
      postgresErrorCode = safePostgresErrorCode(error);
    }

    if (postgresAvailable) {
      try {
        const result = await dependencies.capturePostgres(lead, { ipAddress, now });
        if (!result.rateLimit.allowed) {
          dependencies.log({
            event: "download_lead_capture",
            outcome: "rate_limited",
            count: 1,
          });
          return sendRateLimitExceeded(response, result.rateLimit);
        }
        applyRateLimitHeaders(response, result.rateLimit);
        return sendJson(response, 200, { ok: true });
      } catch (error) {
        if (error instanceof DownloadLeadIdempotencyConflictError) {
          return sendJson(response, 409, {
            error: "Idempotency key conflict",
            code: "idempotency_conflict",
          });
        }
        postgresErrorCode = safePostgresErrorCode(error);
      }
    }

    const pathname = getDeterministicLeadBlobPathname(lead.leadKey);
    try {
      await dependencies.writeFallback(pathname, lead);
      dependencies.log({
        event: "download_lead_capture",
        outcome: "blob_fallback",
        count: 1,
        databaseCode: postgresErrorCode,
      });
      return sendJson(response, 200, { ok: true, queued: true });
    } catch (error) {
      dependencies.log({
        event: "download_lead_capture",
        outcome: "failed",
        count: 1,
        databaseCode: postgresErrorCode,
        blobCode: safeOperationalErrorCode(error),
      });
      return sendJson(response, 503, {
        error: "Lead capture temporarily unavailable",
        code: error instanceof BlobError ? "blob_unavailable" : "capture_unavailable",
      });
    }
  };
}

const handler = createDownloadLeadHandler();
export default handler;

async function writeDeterministicFallback(
  pathname: string,
  incoming: CanonicalDownloadLead,
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await get(pathname, { access: "private", useCache: false });
    if (!current) {
      try {
        await put(pathname, serializeFallbackLead(incoming), {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: false,
          contentType: "application/json; charset=utf-8",
          cacheControlMaxAge: 60,
        });
        return;
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) continue;
        throw error;
      }
    }
    if (current.statusCode !== 200 || !current.stream) {
      throw new BlobError("Fallback Blob could not be read consistently");
    }
    if (current.blob.size > MAX_REPLAY_BLOB_BYTES) {
      throw new BlobError("Fallback Blob exceeds the bounded replay size");
    }
    const existing = parseReplayBlob(await new Response(current.stream).text(), {
      uploadedAt: current.blob.uploadedAt,
    });
    const merged = mergeFallbackLeads(existing, incoming);
    if (merged === existing) return;
    try {
      await put(pathname, serializeFallbackLead(merged), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        ifMatch: current.blob.etag,
        contentType: "application/json; charset=utf-8",
        cacheControlMaxAge: 60,
      });
      return;
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) continue;
      throw error;
    }
  }
  throw new BlobError("Fallback Blob could not be updated after bounded retries");
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
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json";
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

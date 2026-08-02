import { BlobError } from "@vercel/blob";
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
  getDeterministicLeadBlobPathname,
  MAX_DOWNLOAD_LEAD_BODY_BYTES,
  parseIdempotencyKey,
  type CanonicalDownloadLead,
  type DownloadLeadExperimentAssignment,
  type DownloadLeadPayload,
} from "./_lib/download-leads.js";
import {
  DownloadLinkEmailConfigurationError,
  DownloadLinkEmailDeliveryError,
  sendDownloadLinkEmail,
} from "./_lib/download-link-email.js";
import {
  applyRateLimitHeaders,
  sendRateLimitExceeded,
  type RateLimitResult,
} from "./_lib/rate-limit.js";
import {
  PAID_ACQUISITION_COOKIE_NAME,
  validatePaidAcquisitionAssignmentCookie,
} from "./_lib/paid-acquisition.js";
import {
  ACQUISITION_SECRET_NAME,
  createBrowserAcquisitionCookie,
  readBrowserAcquisitionCookie,
  serializeBrowserAcquisitionCookie,
  verifyBrowserAcquisitionCookie,
  type BrowserAcquisitionCookie,
} from "./_lib/acquisition-cookie.js";
import {
  buildAcquisitionHandoffUrl,
  createAcquisitionHandoff,
  verifyAcquisitionHandoff,
} from "./_lib/acquisition-handoff.js";

const MOBILE_DOWNLOAD_SOURCE = "mobile-download-handoff";
const EMAIL_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const EMAIL_RATE_LIMIT_PER_EMAIL = 3;
const EMAIL_RATE_LIMIT_PER_IP = 10;
const validateAssignmentCookie =
  validatePaidAcquisitionAssignmentCookie as unknown as (
    cookieValue: string,
    options: { secret: string; now: number },
  ) => DownloadLeadExperimentAssignment;

type DownloadLinkRequest = IncomingMessage & { method?: string };
type Environment = Readonly<Record<string, string | undefined>>;

type DownloadLinkHandlerDependencies = Readonly<{
  now: () => Date;
  consumeLimit: (
    lead: CanonicalDownloadLead,
    options: { ipAddress: string; now: Date },
  ) => Promise<RateLimitResult>;
  storeLead: (lead: CanonicalDownloadLead) => Promise<void>;
  sendEmail: (
    lead: CanonicalDownloadLead,
    links?: Readonly<{ macUrl: string; windowsUrl: string }>,
  ) => Promise<void>;
  getAcquisitionSecret: () => string;
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

const defaultDependencies: DownloadLinkHandlerDependencies = {
  now: () => new Date(),
  consumeLimit: consumeMobileDownloadLinkRateLimit,
  storeLead: async (lead) => {
    await writeDeterministicDownloadLeadFallback(
      getDeterministicLeadBlobPathname(lead.leadKey),
      lead,
    );
  },
  sendEmail: async (lead, links) => {
    if (!lead.idempotencyKeyHash) {
      throw new DownloadLinkEmailConfigurationError("Missing idempotency hash");
    }
    await sendDownloadLinkEmail({
      recipient: lead.email,
      idempotencyKeyHash: lead.idempotencyKeyHash,
      links,
    });
  },
  getAcquisitionSecret: () => process.env[ACQUISITION_SECRET_NAME]?.trim() || "",
  log: (entry) => console.info(JSON.stringify(entry)),
};

export function createDownloadLinkHandler(
  overrides: Partial<DownloadLinkHandlerDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };

  return async function downloadLinkHandler(
    request: DownloadLinkRequest,
    response: ServerResponse,
  ) {
    const method = (request.method || "GET").toUpperCase();
    if (method === "GET") {
      return serveAcquisitionHandoff(request, response, dependencies);
    }
    if (method !== "POST") {
      response.setHeader("Allow", "GET, POST");
      return sendJson(response, 405, { error: "Method not allowed" });
    }
    if (!isJsonContentType(firstHeaderValue(request.headers["content-type"]))) {
      return sendJson(response, 415, {
        error: "Content-Type must be application/json",
        code: "unsupported_media_type",
      });
    }

    let payload: DownloadLeadPayload & { handoffOnly?: unknown };
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
    if (isExactHandoffOnlyPayload(payload)) {
      return createEmailOptionalHandoff(request, response, dependencies, now);
    }
    if (hasHandoffOnlyKey(payload)) {
      return sendJson(response, 400, {
        error: "Invalid computer handoff request",
        code: "invalid_handoff_request",
      });
    }
    let lead: CanonicalDownloadLead;
    try {
      const idempotencyKey = parseIdempotencyKey(
        request.headers["idempotency-key"],
      );
      if (!idempotencyKey) {
        throw new DownloadLeadValidationError(
          "missing_idempotency_key",
          "Idempotency-Key is required",
        );
      }
      lead = buildCanonicalDownloadLead(
        { ...payload, source: MOBILE_DOWNLOAD_SOURCE },
        {
          capturedAt: now,
          referrer: firstHeaderValue(request.headers.referer),
          idempotencyKey,
          experimentAssignment: resolvePaidAcquisitionAssignment(
            request.headers.cookie,
            now,
          ),
        },
      );
    } catch (error) {
      if (error instanceof DownloadLeadValidationError) {
        return sendJson(response, 400, {
          error: "Invalid email request",
          code: error.code,
        });
      }
      if (error instanceof DownloadLeadConfigurationError) {
        dependencies.log({
          event: "mobile_download_link_email",
          outcome: "configuration_error",
          count: 1,
        });
        return sendJson(response, 503, {
          error: "Email delivery temporarily unavailable",
          code: "email_unavailable",
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
        event: "mobile_download_link_email",
        outcome: "rate_limit_storage_failed",
        count: 1,
        storageCode: error instanceof BlobError ? "blob_error" : "storage_error",
      });
      return sendJson(response, 503, {
        error: "Email delivery temporarily unavailable",
        code: "email_unavailable",
      });
    }
    if (!rateLimit.allowed) {
      dependencies.log({
        event: "mobile_download_link_email",
        outcome: "rate_limited",
        count: 1,
      });
      return sendRateLimitExceeded(response, rateLimit);
    }
    applyRateLimitHeaders(response, rateLimit);

    try {
      await dependencies.storeLead(lead);
    } catch (error) {
      dependencies.log({
        event: "mobile_download_link_email",
        outcome: "lead_storage_failed",
        count: 1,
        storageCode: error instanceof BlobError ? "blob_error" : "storage_error",
      });
      return sendJson(response, 503, {
        error: "Email delivery temporarily unavailable",
        code: "email_unavailable",
      });
    }

    try {
      const links = createEmailHandoffLinks(request, dependencies, now);
      if (links?.setCookie) response.setHeader("Set-Cookie", links.setCookie);
      await dependencies.sendEmail(lead, links?.links);
      dependencies.log({
        event: "mobile_download_link_email",
        outcome: "accepted",
        count: 1,
      });
      return sendJson(response, 200, { ok: true });
    } catch (error) {
      if (error instanceof DownloadLinkEmailConfigurationError) {
        dependencies.log({
          event: "mobile_download_link_email",
          outcome: "email_configuration_error",
          count: 1,
        });
        return sendJson(response, 503, {
          error: "Email delivery temporarily unavailable",
          code: "email_unavailable",
        });
      }
      const providerStatus = error instanceof DownloadLinkEmailDeliveryError
        ? error.providerStatus
        : null;
      dependencies.log({
        event: "mobile_download_link_email",
        outcome: "provider_failed",
        count: 1,
        providerStatus: providerStatus || 0,
      });
      return sendJson(response, 502, {
        error: "Email could not be sent",
        code: "email_send_failed",
      });
    }
  };
}

const handler = createDownloadLinkHandler();
export default handler;

export function resolvePaidAcquisitionAssignment(
  cookieHeader: string | string[] | undefined,
  now: Date,
  environment: Environment = process.env,
): DownloadLeadExperimentAssignment | null {
  const cookieValue = readSingleCookie(
    cookieHeader,
    PAID_ACQUISITION_COOKIE_NAME,
  );
  if (!cookieValue) return null;
  const secret =
    environment.SIDESTREAM_PAID_ACQUISITION_ASSIGNMENT_SECRET?.trim() || "";
  try {
    const assignment = validateAssignmentCookie(cookieValue, {
      secret,
      now: Math.floor(now.getTime() / 1_000),
    });
    return Object.freeze({
      experimentId: assignment.experimentId,
      cohort: assignment.cohort,
      assignmentIdHash: assignment.assignmentIdHash,
    });
  } catch {
    return null;
  }
}

function serveAcquisitionHandoff(
  request: DownloadLinkRequest,
  response: ServerResponse,
  dependencies: DownloadLinkHandlerDependencies,
) {
  try {
    const requestUrl = new URL(
      request.url || "/api/send-download-links",
      "https://sidestream.tv",
    );
    const tokens = requestUrl.searchParams.getAll("handoff");
    if (tokens.length !== 1 || requestUrl.searchParams.size !== 1) {
      return sendJson(response, 404, { error: "Download handoff not found" });
    }
    const now = dependencies.now();
    const secret = dependencies.getAcquisitionSecret();
    const handoff = verifyAcquisitionHandoff(tokens[0], { secret, now });
    const cookie = verifyBrowserAcquisitionCookie(
      handoff.acquisitionCookieValue,
      { secret, now },
    );
    const platform = handoff.platform || platformFromUserAgent(
      firstHeaderValue(request.headers["user-agent"]),
    );
    response.statusCode = 302;
    response.setHeader(
      "Location",
      platform === "windows" ? "/api/download?platform=win32-x64" : "/api/download",
    );
    response.setHeader("Set-Cookie", serializeBrowserAcquisitionCookie(cookie));
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.end();
  } catch {
    return sendJson(response, 404, { error: "Download handoff not found" });
  }
}

function createEmailOptionalHandoff(
  request: DownloadLinkRequest,
  response: ServerResponse,
  dependencies: DownloadLinkHandlerDependencies,
  now: Date,
) {
  try {
    const resolved = resolveOrCreateHandoffCookie(request, dependencies, now);
    const token = createAcquisitionHandoff({
      acquisitionCookieValue: resolved.cookie.value,
      platform: null,
    }, {
      secret: resolved.secret,
      now,
    });
    if (resolved.setCookie) response.setHeader("Set-Cookie", resolved.setCookie);
    return sendJson(response, 200, {
      ok: true,
      handoffUrl: buildAcquisitionHandoffUrl(token),
    });
  } catch {
    return sendJson(response, 503, {
      error: "Computer handoff temporarily unavailable",
      code: "handoff_unavailable",
    });
  }
}

function createEmailHandoffLinks(
  request: DownloadLinkRequest,
  dependencies: DownloadLinkHandlerDependencies,
  now: Date,
) {
  try {
    const resolved = resolveOrCreateHandoffCookie(request, dependencies, now);
    const makeUrl = (platform: "macos" | "windows") => buildAcquisitionHandoffUrl(
      createAcquisitionHandoff({
        acquisitionCookieValue: resolved.cookie.value,
        platform,
      }, {
        secret: resolved.secret,
        now,
      }),
    );
    return {
      links: Object.freeze({
        macUrl: makeUrl("macos"),
        windowsUrl: makeUrl("windows"),
      }),
      setCookie: resolved.setCookie,
    };
  } catch {
    // Preserve the existing direct installer email if attribution is unavailable.
    return null;
  }
}

function resolveOrCreateHandoffCookie(
  request: DownloadLinkRequest,
  dependencies: DownloadLinkHandlerDependencies,
  now: Date,
) {
  const secret = dependencies.getAcquisitionSecret();
  const existing = readBrowserAcquisitionCookie(request.headers.cookie);
  if (existing) {
    try {
      return {
        cookie: verifyBrowserAcquisitionCookie(existing, { secret, now }),
        secret,
        setCookie: "",
      };
    } catch {
      // Invalid browser state is replaced with a fresh, direct first touch.
    }
  }
  const cookie = createBrowserAcquisitionCookie({}, { secret, now });
  return {
    cookie,
    secret,
    setCookie: serializeBrowserAcquisitionCookie(cookie),
  };
}

function platformFromUserAgent(userAgent: string) {
  return /windows/i.test(userAgent) ? "windows" : "macos";
}

async function consumeMobileDownloadLinkRateLimit(
  lead: CanonicalDownloadLead,
  options: { ipAddress: string; now: Date },
): Promise<RateLimitResult> {
  return consumeBlobRateLimit({
    scope: "mobile-download-link-email",
    dimensions: [
      { name: "email", value: lead.email, limit: EMAIL_RATE_LIMIT_PER_EMAIL },
      {
        name: "ip",
        value: options.ipAddress || "unknown",
        limit: EMAIL_RATE_LIMIT_PER_IP,
      },
    ],
    windowSeconds: EMAIL_RATE_LIMIT_WINDOW_SECONDS,
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

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function readSingleCookie(
  value: string | string[] | undefined,
  name: string,
) {
  const header = Array.isArray(value) ? value.join(";") : value || "";
  const matches: string[] = [];
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator === -1) continue;
    if (segment.slice(0, separator).trim() !== name) continue;
    matches.push(segment.slice(separator + 1).trim());
  }
  return matches.length === 1 && matches[0] ? matches[0] : "";
}

function isExactHandoffOnlyPayload(value: unknown) {
  return isPlainObject(value) &&
    Object.keys(value).length === 1 &&
    value.handoffOnly === true;
}

function hasHandoffOnlyKey(value: unknown) {
  return isPlainObject(value) && Object.hasOwn(value, "handoffOnly");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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

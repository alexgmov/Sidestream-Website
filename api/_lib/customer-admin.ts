import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_JSON_BODY_BYTES = 16 * 1024;

type CustomerAdminRequest = IncomingMessage & Readonly<{
  body?: unknown;
  rawHeaders?: string[];
}>;

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export class CustomerAdminRequestError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "CustomerAdminRequestError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function loadCustomerAdminSecret(
  environment: RuntimeEnvironment = process.env,
) {
  const secret = environment.SIDESTREAM_CRM_ADMIN_SECRET || "";
  if (
    secret.length < 16 ||
    secret.length > 512 ||
    !/^[\x21-\x7e]+$/.test(secret)
  ) {
    throw new Error("SIDESTREAM_CRM_ADMIN_SECRET is not configured");
  }
  return secret;
}

export function authorizeCustomerAdminRequest(
  request: CustomerAdminRequest,
  response: ServerResponse,
  getSecret: () => string = loadCustomerAdminSecret,
) {
  setCustomerAdminResponseHeaders(response);

  if (hasBrowserOrigin(request)) {
    sendCustomerAdminJson(response, 403, {
      error: "Browser access is forbidden",
      code: "browser_origin_forbidden",
    });
    return null;
  }

  if ((request.method || "GET").toUpperCase() !== "POST") {
    response.setHeader("Allow", "POST");
    sendCustomerAdminJson(response, 405, {
      error: "Method not allowed",
      code: "method_not_allowed",
    });
    return null;
  }

  let secret: string;
  try {
    secret = getSecret();
  } catch {
    sendCustomerAdminJson(response, 503, {
      error: "Customer administration is not configured",
      code: "customer_admin_unavailable",
    });
    return null;
  }

  if (!hasSingleValidBearerCredential(request, secret)) {
    sendCustomerAdminJson(response, 401, {
      error: "Unauthorized",
      code: "unauthorized",
    });
    return null;
  }

  return secret;
}

export async function readCustomerAdminJson(request: CustomerAdminRequest) {
  if (request.body !== undefined) {
    let byteLength: number;
    try {
      const serialized = Buffer.isBuffer(request.body)
        ? request.body
        : typeof request.body === "string"
          ? Buffer.from(request.body)
          : Buffer.from(JSON.stringify(request.body));
      byteLength = serialized.byteLength;
    } catch {
      throw new CustomerAdminRequestError(400, "invalid_json", "Malformed JSON body");
    }
    if (byteLength > MAX_JSON_BODY_BYTES) {
      throw new CustomerAdminRequestError(
        413,
        "request_too_large",
        "Request body is too large",
      );
    }
    return parseJsonObject(request.body);
  }

  const declaredLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new CustomerAdminRequestError(
      413,
      "request_too_large",
      "Request body is too large",
    );
  }

  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_JSON_BODY_BYTES) {
      throw new CustomerAdminRequestError(
        413,
        "request_too_large",
        "Request body is too large",
      );
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  return parseJsonObject(Buffer.concat(chunks).toString("utf8"));
}

export function setCustomerAdminResponseHeaders(response: ServerResponse) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Vary", "Authorization, Origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

export function sendCustomerAdminJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
) {
  setCustomerAdminResponseHeaders(response);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function hasBrowserOrigin(request: CustomerAdminRequest) {
  const origin = request.headers.origin;
  return Array.isArray(origin) ? origin.length > 0 : typeof origin === "string";
}

function hasSingleValidBearerCredential(
  request: CustomerAdminRequest,
  secret: string,
) {
  const authorization = request.headers.authorization;
  if (!authorization || Array.isArray(authorization)) return false;

  const rawHeaders = request.rawHeaders;
  if (Array.isArray(rawHeaders) && rawHeaders.length > 0) {
    let authorizationCount = 0;
    for (let index = 0; index < rawHeaders.length; index += 2) {
      if (rawHeaders[index]?.toLowerCase() === "authorization") {
        authorizationCount += 1;
      }
    }
    if (authorizationCount > 1) return false;
  }

  const actualDigest = createHash("sha256").update(authorization).digest();
  const expectedDigest = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function parseJsonObject(input: unknown): Record<string, unknown> {
  let parsed = input;
  if (Buffer.isBuffer(parsed)) parsed = parsed.toString("utf8");
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new CustomerAdminRequestError(400, "invalid_json", "Malformed JSON body");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CustomerAdminRequestError(400, "invalid_json", "JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

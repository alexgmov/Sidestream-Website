import { BlobError, put } from "@vercel/blob";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const LEADS_PREFIX_ENV = "SIDESTREAM_DOWNLOAD_LEADS_BLOB_PREFIX";
const DEFAULT_LEADS_PREFIX = "sidestream/download-leads";
const MAX_BODY_BYTES = 8 * 1024;

type LeadRequest = IncomingMessage & {
  method?: string;
};

type DownloadLeadPayload = {
  email?: unknown;
  page?: unknown;
  source?: unknown;
};

export default async function handler(
  request: LeadRequest,
  response: ServerResponse,
) {
  const method = (request.method || "GET").toUpperCase();

  if (method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: "Method not allowed" });
  }

  let payload: DownloadLeadPayload;
  try {
    payload = JSON.parse(await readRequestBody(request)) as DownloadLeadPayload;
  } catch (error) {
    return sendJson(response, 400, { error: "Invalid JSON payload" });
  }

  const email = normalizeEmail(payload.email);
  if (!isValidEmail(email)) {
    return sendJson(response, 400, { error: "Invalid email address" });
  }

  const now = new Date();
  const lead = {
    email,
    capturedAt: now.toISOString(),
    page: cleanOptionalString(payload.page, 240),
    source: cleanOptionalString(payload.source, 300),
    referrer: cleanOptionalString(request.headers.referer, 500),
  };
  const pathname = [
    getLeadPrefix(),
    now.toISOString().slice(0, 10),
    `${now.getTime()}-${randomUUID()}.json`,
  ].join("/");

  try {
    await put(pathname, JSON.stringify(lead, null, 2), {
      access: "private",
      contentType: "application/json; charset=utf-8",
    });

    return sendJson(response, 200, { ok: "true" });
  } catch (error) {
    if (error instanceof BlobError) {
      const body: Record<string, string> = {
        error: "Lead capture is not configured correctly",
      };

      if (process.env.VERCEL_ENV === "development") {
        body.message = error.message;
      }

      return sendJson(response, 500, body);
    }

    throw error;
  }
}

function getLeadPrefix() {
  return (
    process.env[LEADS_PREFIX_ENV]?.trim().replace(/^\/+|\/+$/g, "") ||
    DEFAULT_LEADS_PREFIX
  );
}

function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function cleanOptionalString(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength).replace(/[\u0000-\u001f\u007f]/g, "");
}

function readRequestBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let size = 0;
    let body = "";

    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, string>,
) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

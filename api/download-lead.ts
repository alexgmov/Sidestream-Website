import { BlobError, put } from "@vercel/blob";
import { createHmac, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Pool } from "pg";

const LEADS_PREFIX_ENV = "SIDESTREAM_DOWNLOAD_LEADS_BLOB_PREFIX";
const DEFAULT_LEADS_PREFIX = "sidestream/download-leads";
const SUPABASE_LEADS_TABLE = "public.sidestream_download_leads";
const MAX_BODY_BYTES = 8 * 1024;

let pool: Pool | null = null;

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
  const leadKey = randomUUID();
  const lead = {
    leadKey,
    email,
    emailHash: hashEmail(email),
    capturedAt: now.toISOString(),
    page: cleanOptionalString(payload.page, 240),
    source: cleanOptionalString(payload.source, 300),
    referrer: cleanOptionalString(request.headers.referer, 500),
    userAgent: cleanOptionalString(request.headers["user-agent"], 500),
  };
  const storageTargets: string[] = [];
  let supabaseError = "";

  if (isSupabaseConfigured()) {
    try {
      await recordSupabaseLead(lead, storageTargets.concat("supabase"));
      storageTargets.push("supabase");
    } catch (error) {
      supabaseError = error instanceof Error ? error.message : "Unknown Supabase error";
      console.error("Sidestream download lead Supabase capture failed", supabaseError);
    }
  }

  if (storageTargets.length) {
    return sendJson(response, 200, { ok: "true", storage: storageTargets.join(",") });
  }

  const pathname = leadBlobPathname(now, leadKey);
  try {
    await put(pathname, JSON.stringify({ ...lead, storageTargets: ["vercel_blob"] }, null, 2), {
      access: "private",
      contentType: "application/json; charset=utf-8",
    });

    return sendJson(response, 200, { ok: "true", storage: "vercel_blob" });
  } catch (error) {
    if (error instanceof BlobError) {
      const body: Record<string, string> = {
        error: "Lead capture is not configured correctly",
      };

      if (process.env.VERCEL_ENV === "development") {
        body.message = error.message;
        if (supabaseError) body.supabase = supabaseError;
      }

      return sendJson(response, 500, body);
    }

    throw error;
  }
}

async function recordSupabaseLead(
  lead: {
    leadKey: string;
    email: string;
    emailHash: string;
    capturedAt: string;
    page: string;
    source: string;
    referrer: string;
    userAgent: string;
  },
  storageTargets: string[],
) {
  const client = await getPool().connect();

  try {
    await client.query(
      `
        insert into ${SUPABASE_LEADS_TABLE} (
          lead_key,
          email,
          email_hash,
          captured_at,
          source_page,
          cta_source,
          referrer,
          user_agent,
          storage_targets,
          context,
          created_at,
          updated_at
        )
        values ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9::text[], $10::jsonb, now(), now())
        on conflict (lead_key) do update set
          email = excluded.email,
          email_hash = excluded.email_hash,
          captured_at = excluded.captured_at,
          source_page = excluded.source_page,
          cta_source = excluded.cta_source,
          referrer = excluded.referrer,
          user_agent = excluded.user_agent,
          storage_targets = excluded.storage_targets,
          context = ${SUPABASE_LEADS_TABLE}.context || excluded.context,
          updated_at = now()
      `,
      [
        lead.leadKey,
        lead.email,
        lead.emailHash,
        lead.capturedAt,
        lead.page || null,
        lead.source || null,
        lead.referrer || null,
        lead.userAgent || null,
        storageTargets,
        JSON.stringify({ source: "download_email_gate" }),
      ],
    );
  } finally {
    client.release();
  }
}

function getPool() {
  if (!pool) {
    const connectionString = normalizeConnectionString(process.env.POSTGRES_URL || "");
    pool = new Pool({
      connectionString,
      max: Number(process.env.POSTGRES_POOL_MAX || 1),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : false,
    });
  }

  return pool;
}

function isSupabaseConfigured() {
  const url = process.env.POSTGRES_URL || "";
  return Boolean(url && !url.includes("[YOUR-PASSWORD]"));
}

function normalizeConnectionString(connectionString: string) {
  if (!connectionString) return "";

  try {
    const url = new URL(connectionString);
    if (/^(prefer|require)$/i.test(url.searchParams.get("sslmode") || "")) {
      url.searchParams.delete("sslmode");
    }
    return url.toString();
  } catch {
    return connectionString;
  }
}

function shouldUseSsl(connectionString: string) {
  if (process.env.POSTGRES_SSL === "0") return false;
  if (/sslmode=(disable|false)/i.test(connectionString)) return false;
  return !/localhost|127\.0\.0\.1|::1/.test(connectionString);
}

function hashEmail(email: string) {
  const secret = process.env.SIDESTREAM_LEAD_HASH_SECRET || process.env.POSTGRES_URL || "sidestream-download-leads-dev-salt";
  return createHmac("sha256", secret).update(email).digest("hex");
}

function leadBlobPathname(now: Date, leadKey: string) {
  return [
    getLeadPrefix(),
    now.toISOString().slice(0, 10),
    `${now.getTime()}-${leadKey}.json`,
  ].join("/");
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

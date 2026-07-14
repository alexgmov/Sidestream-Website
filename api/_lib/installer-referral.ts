import { attachDatabasePool } from "@vercel/functions";
import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { Pool } from "pg";
import type { ReleasePlatform } from "./release-manifest.js";

const INSTALLER_REQUESTS_TABLE = "public.sidestream_installer_requests";
const HASH_SECRET_ENV = "SIDESTREAM_INSTALLER_ANALYTICS_HASH_SECRET";
const MAX_CAMPAIGN_VALUE_LENGTH = 100;
const POSTGRES_URL_ENV_NAMES = [
  "SIDESTREAM_POSTGRES_URL",
  "SIDESTREAM_POSTGRES_PRISMA_URL",
  "SIDESTREAM_POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
] as const;
const SCANNER_USER_AGENT_PATTERN = new RegExp(
  [
    "googleimageproxy",
    "google-inspectiontool",
    "proofpoint",
    "mimecast",
    "barracuda",
    "microsoft office",
    "microsoftoffice",
    "officeexistence",
    "safelinks",
    "urlscan",
    "link(?:ed)?inbot",
    "(?:^|[^a-z])bot(?:[^a-z]|$)",
    "crawler",
    "spider",
    "curl/",
    "wget/",
  ].join("|"),
  "i",
);

let pool: Pool | null = null;

export type InstallerReferralEvent = {
  requestedAt: string;
  platform: "macos" | "win32-x64";
  utmSource: "gmail";
  utmMedium: "email";
  utmCampaign: string;
  utmContent: "pilot" | "main" | null;
  requestHash: string;
  likelyScanner: boolean;
};

type GmailReferralTags = Pick<
  InstallerReferralEvent,
  "utmSource" | "utmMedium" | "utmCampaign" | "utmContent"
>;

export function buildInstallerReferralEvent(
  request: IncomingMessage,
  requestUrl: URL,
  platform: ReleasePlatform,
  options: { now?: Date; secret?: string } = {},
): InstallerReferralEvent | null {
  const tags = parseGmailReferral(requestUrl.searchParams);
  if (!tags) return null;

  const requestedAt = options.now || new Date();
  const normalizedPlatform = platform === "windows" ? "win32-x64" : "macos";
  const clientIp = getClientIp(request);
  const userAgent = firstHeaderValue(request.headers["user-agent"]).trim().slice(0, 2_000);
  const secret = options.secret || getHashSecret();
  const fingerprintScope = [
    requestedAt.toISOString().slice(0, 10),
    normalizedPlatform,
    tags.utmSource,
    tags.utmCampaign,
    tags.utmContent || "",
    clientIp,
    userAgent,
  ].join("\n");

  return {
    requestedAt: requestedAt.toISOString(),
    platform: normalizedPlatform,
    ...tags,
    requestHash: createHmac("sha256", secret).update(fingerprintScope).digest("hex"),
    likelyScanner: isLikelyScanner(request),
  };
}

export async function recordInstallerReferral(event: InstallerReferralEvent) {
  await getPool().query(
    `
      insert into ${INSTALLER_REQUESTS_TABLE} (
        requested_at,
        platform,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_content,
        request_hash,
        likely_scanner
      )
      values ($1::timestamptz, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      event.requestedAt,
      event.platform,
      event.utmSource,
      event.utmMedium,
      event.utmCampaign,
      event.utmContent,
      event.requestHash,
      event.likelyScanner,
    ],
  );
}

export function parseGmailReferral(searchParams: URLSearchParams): GmailReferralTags | null {
  const utmSource = normalizeCampaignValue(searchParams.get("utm_source"));
  const utmMedium = normalizeCampaignValue(searchParams.get("utm_medium"));
  const utmCampaign = normalizeCampaignValue(searchParams.get("utm_campaign"));
  const rawContent = searchParams.get("utm_content");
  const normalizedContent = rawContent === null
    ? null
    : normalizeCampaignValue(rawContent);
  const utmContent = normalizedContent === "pilot" || normalizedContent === "main"
    ? normalizedContent
    : null;

  if (
    utmSource !== "gmail" ||
    utmMedium !== "email" ||
    !utmCampaign ||
    (rawContent !== null && utmContent === null)
  ) {
    return null;
  }

  return {
    utmSource,
    utmMedium,
    utmCampaign,
    utmContent,
  };
}

export function isLikelyScanner(request: IncomingMessage) {
  const purposeHeaders = [
    firstHeaderValue(request.headers.purpose),
    firstHeaderValue(request.headers["sec-purpose"]),
    firstHeaderValue(request.headers["x-purpose"]),
    firstHeaderValue(request.headers["x-moz"]),
  ].join(" ");

  if (/prefetch|preview/i.test(purposeHeaders)) return true;

  return SCANNER_USER_AGENT_PATTERN.test(
    firstHeaderValue(request.headers["user-agent"]),
  );
}

function getPool() {
  if (!pool) {
    const connectionString = normalizeConnectionString(getPostgresConnectionString());
    if (!connectionString) {
      throw new Error("Installer referral Postgres connection is not configured");
    }

    pool = new Pool({
      connectionString,
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 800,
      query_timeout: 800,
      statement_timeout: 800,
      ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : false,
    });
    pool.on("error", (error) => {
      console.error("Sidestream installer referral Postgres pool error", error);
    });
    attachDatabasePool(pool);
  }

  return pool;
}

function getPostgresConnectionString() {
  for (const name of POSTGRES_URL_ENV_NAMES) {
    const value = process.env[name]?.trim();
    if (value && !value.includes("[YOUR-") && value !== "changeme") {
      return value;
    }
  }

  return "";
}

function getHashSecret() {
  const secret = process.env[HASH_SECRET_ENV]?.trim();
  if (secret && secret.length >= 32) return secret;

  if (process.env.VERCEL_ENV === "development" || process.env.NODE_ENV === "test") {
    return "sidestream-installer-analytics-development-only";
  }

  throw new Error(`Missing or weak ${HASH_SECRET_ENV}; expected at least 32 characters`);
}

function normalizeCampaignValue(value: string | null) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized.length > MAX_CAMPAIGN_VALUE_LENGTH) return "";
  return /^[a-z0-9][a-z0-9._-]*$/.test(normalized) ? normalized : "";
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

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

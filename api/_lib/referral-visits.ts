import {
  BlobPreconditionFailedError,
  put,
} from "@vercel/blob";
import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { isLikelyScanner } from "./installer-referral.js";

const REFERRAL_BLOB_PREFIX = "sidestream/referrals/v1";
const HASH_SECRET_ENV = "SIDESTREAM_INSTALLER_ANALYTICS_HASH_SECRET";

export type ReferralVisitSource =
  | "manychat"
  | "instagram-bio"
  | "instagram-alex"
  | "meta-ads-1";

export type ReferralVisitEvent = Readonly<{
  source: ReferralVisitSource;
  visitedAt: string;
  visitorHash: string;
  likelyScanner: boolean;
}>;

export function parseReferralVisitSource(value: unknown): ReferralVisitSource | null {
  if (typeof value !== "string") return null;
  const source = value.trim().toLowerCase();
  return source === "manychat" ||
    source === "instagram-bio" ||
    source === "instagram-alex" ||
    source === "meta-ads-1"
    ? source
    : null;
}

export function buildReferralVisitEvent(
  request: IncomingMessage,
  source: ReferralVisitSource,
  options: { now?: Date; secret?: string } = {},
): ReferralVisitEvent {
  const visitedAt = options.now || new Date();
  const userAgent = firstHeaderValue(request.headers["user-agent"])
    .trim()
    .slice(0, 2_000);
  const fingerprintScope = [
    visitedAt.toISOString().slice(0, 10),
    source,
    getClientIp(request),
    userAgent,
  ].join("\n");

  return Object.freeze({
    source,
    visitedAt: visitedAt.toISOString(),
    visitorHash: createHmac("sha256", options.secret || getHashSecret())
      .update(fingerprintScope)
      .digest("hex"),
    likelyScanner: isLikelyScanner(request),
  });
}

export async function recordReferralVisit(event: ReferralVisitEvent) {
  const visitDay = event.visitedAt.slice(0, 10);
  const classification = event.likelyScanner ? "scanner" : "human";
  const pathname = [
    REFERRAL_BLOB_PREFIX,
    event.source,
    visitDay,
    classification,
    `${event.visitorHash}.json`,
  ].join("/");

  try {
    await put(pathname, JSON.stringify({ version: 1, ...event }), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/json; charset=utf-8",
      cacheControlMaxAge: 60,
    });
    return Object.freeze({ created: true, pathname });
  } catch (error) {
    if (error instanceof BlobPreconditionFailedError) {
      return Object.freeze({ created: false, pathname });
    }
    throw error;
  }
}

function getHashSecret() {
  const secret = process.env[HASH_SECRET_ENV]?.trim();
  if (secret && secret.length >= 32) return secret;

  if (process.env.VERCEL_ENV === "development" || process.env.NODE_ENV === "test") {
    return "sidestream-referral-analytics-development-only";
  }

  throw new Error(`Missing or weak ${HASH_SECRET_ENV}; expected at least 32 characters`);
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

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

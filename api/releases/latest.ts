import type { IncomingMessage, ServerResponse } from "node:http";
import {
  readReleaseManifest,
  resolveReleasePlatform,
  toPublicReleaseManifest,
} from "../_lib/release-manifest.js";

const SUPPORTED_CHANNELS = new Set(["stable"]);

type ReleaseRequest = IncomingMessage & {
  method?: string;
  url?: string;
};

export default async function handler(
  request: ReleaseRequest,
  response: ServerResponse,
) {
  setCorsHeaders(response);

  const method = (request.method || "GET").toUpperCase();

  if (method === "OPTIONS") {
    response.setHeader("Allow", "GET, HEAD, OPTIONS");
    response.statusCode = 204;
    response.end();
    return;
  }

  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD, OPTIONS");
    return sendJson(response, 405, { error: "Release manifest accepts GET only" });
  }

  const requestUrl = new URL(request.url || "/api/releases/latest", "https://sidestream.tv");
  const channel = sanitizeLabel(requestUrl.searchParams.get("channel") || "stable");
  const platform = resolveReleasePlatform(sanitizeLabel(requestUrl.searchParams.get("platform") || ""));

  if (!SUPPORTED_CHANNELS.has(channel)) {
    return sendJson(response, 404, { error: "Release channel not found" });
  }

  if (!platform) {
    return sendJson(response, 404, { error: "Platform release not found" });
  }

  let manifest;

  try {
    manifest = readReleaseManifest(platform);
  } catch (error) {
    console.error("[sidestream releases] manifest unavailable:", error);
    return sendJson(response, 503, { error: "Release manifest is not available" });
  }

  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (method === "HEAD") {
    response.statusCode = 200;
    response.end();
    return;
  }

  return sendJson(response, 200, toPublicReleaseManifest(manifest));
}

function setCorsHeaders(response: ServerResponse) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Max-Age", "86400");
}

function sanitizeLabel(value: string) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 40);
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

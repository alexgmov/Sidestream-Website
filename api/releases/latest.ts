import type { IncomingMessage, ServerResponse } from "node:http";
import {
  readReleaseManifest,
  resolveReleasePlatform,
  toPublicReleaseManifest,
} from "../_lib/release-manifest.js";
import type {
  ReleaseManifest,
} from "../_lib/release-manifest.js";

const SUPPORTED_CHANNELS = new Set(["stable"]);

type ReleaseRequest = IncomingMessage & {
  method?: string;
  url?: string;
};

type ReleaseDependencies = {
  logManifestError: (error: unknown) => void;
};

export function createReleaseHandler(
  overrides: Partial<ReleaseDependencies> = {},
) {
  const dependencies: ReleaseDependencies = {
    logManifestError: (error) => {
      console.error("[sidestream releases] manifest unavailable:", error);
    },
    ...overrides,
  };

  return async function handler(
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
      return sendJson(response, 405, {
        error: "Release manifest accepts GET and HEAD only",
      });
    }

    const requestUrl = new URL(
      request.url || "/api/releases/latest",
      "https://sidestream.tv",
    );
    const channel = sanitizeLabel(
      requestUrl.searchParams.get("channel") || "stable",
    );
    const platform = resolveReleasePlatform(
      requestUrl.searchParams.get("platform"),
    );

    if (!SUPPORTED_CHANNELS.has(channel)) {
      return sendJson(response, 404, { error: "Release channel not found" });
    }

    if (!platform) {
      return sendJson(response, 404, { error: "Platform release not found" });
    }

    let manifest: ReleaseManifest;

    try {
      manifest = readReleaseManifest(platform);
    } catch (error) {
      dependencies.logManifestError(error);
      return sendJson(response, 503, {
        error: "Release manifest is not available",
      });
    }

    const publicManifest = toPublicReleaseManifest(manifest);
    const body = JSON.stringify(publicManifest);
    setManifestHeaders(response, manifest, Buffer.byteLength(body));

    if (method === "HEAD") {
      response.statusCode = 200;
      response.end();
      return;
    }

    response.statusCode = 200;
    response.end(body);
  };
}

export default createReleaseHandler();

function setCorsHeaders(response: ServerResponse) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Max-Age", "86400");
}

function sanitizeLabel(value: string) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 40);
}

function setManifestHeaders(
  response: ServerResponse,
  manifest: ReleaseManifest,
  contentLength: number,
) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(contentLength));
  response.setHeader("Last-Modified", new Date(manifest.publishedAt).toUTCString());
  response.setHeader("X-Sidestream-Platform", manifest.platform);
  response.setHeader("X-Sidestream-Sha256", manifest.artifact.sha256);
  response.setHeader("X-Sidestream-Version", manifest.version);
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
) {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Length", String(Buffer.byteLength(body)));
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(body);
}

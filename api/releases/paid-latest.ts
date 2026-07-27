import type { IncomingMessage, ServerResponse } from "node:http";
import {
  readPaidReleaseManifest,
  selectPaidReleasePlatform,
  toPublicPaidReleaseManifest,
} from "../_lib/paid-release-manifest.js";
import type {
  PaidReleaseManifest,
} from "../_lib/paid-release-manifest.js";

type PaidReleaseRequest = IncomingMessage & {
  method?: string;
  url?: string;
};

type PaidReleaseDependencies = {
  logManifestError: (error: unknown) => void;
};

export function createPaidReleaseHandler(
  overrides: Partial<PaidReleaseDependencies> = {},
) {
  const dependencies: PaidReleaseDependencies = {
    logManifestError: (error) => {
      console.error("[sidestream paid releases] manifest unavailable:", error);
    },
    ...overrides,
  };

  return async function handler(
    request: PaidReleaseRequest,
    response: ServerResponse,
  ) {
    const method = (request.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      return sendJson(response, 405, { error: "method_not_allowed" });
    }

    const requestUrl = new URL(
      request.url || "/api/releases/paid-latest",
      "https://sidestream.tv",
    );
    const platform = selectPaidReleasePlatform(requestUrl.searchParams);
    if (!platform) {
      return sendJson(response, 404, { error: "artifact_not_found" });
    }

    let manifest: PaidReleaseManifest;
    try {
      manifest = readPaidReleaseManifest(platform);
    } catch (error) {
      dependencies.logManifestError(error);
      return sendJson(response, 404, { error: "artifact_not_found" });
    }

    const body = JSON.stringify(toPublicPaidReleaseManifest(manifest));
    setManifestHeaders(response, manifest, Buffer.byteLength(body));

    response.statusCode = 200;
    if (method === "HEAD") {
      response.end();
      return;
    }

    response.end(body);
  };
}

export default createPaidReleaseHandler();

function setManifestHeaders(
  response: ServerResponse,
  manifest: PaidReleaseManifest,
  contentLength: number,
) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(contentLength));
  response.setHeader("X-Sidestream-Paid-Platform", manifest.platform);
  response.setHeader("X-Sidestream-Paid-Sha256", manifest.sha256);
  response.setHeader("X-Sidestream-Paid-Version", manifest.version);
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, string>,
) {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(Buffer.byteLength(body)));
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(body);
}

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  getPaidArtifactPathname,
  readPaidReleaseManifest,
  selectPaidReleasePlatform,
} from "./paid-release-manifest.js";
import type {
  PaidReleaseManifest,
} from "./paid-release-manifest.js";

const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const SIGNED_DOWNLOAD_TTL_MS = 5 * 60 * 1000;

// This internal helper signs generic installer bits only. The calling HTTP
// route owns receipt/payment validation and entitlement checks.
type PaidDownloadRequest = IncomingMessage & {
  method?: string;
  url?: string;
};

type PaidArtifactMetadata = {
  contentType?: string | null;
  etag?: string;
  size?: number | null;
};

type PaidDownloadDependencies = {
  headArtifact: (pathname: string) => Promise<PaidArtifactMetadata | null>;
  createSignedUrl: (pathname: string) => Promise<string>;
  logArtifactError: (error: unknown) => void;
};

class PaidArtifactUnavailableError extends Error {}

export function createPaidDownloadHandler(
  overrides: Partial<PaidDownloadDependencies> = {},
) {
  const dependencies: PaidDownloadDependencies = {
    headArtifact: headPaidArtifact,
    createSignedUrl: createSignedPaidDownloadUrl,
    logArtifactError: (error) => {
      console.error("[sidestream paid download] artifact unavailable:", error);
    },
    ...overrides,
  };

  return async function handler(
    request: PaidDownloadRequest,
    response: ServerResponse,
  ) {
    const method = (request.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      return sendJson(response, 405, { error: "method_not_allowed" });
    }

    const requestUrl = new URL(
      request.url || "/api/paid-download",
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
      dependencies.logArtifactError(error);
      return sendJson(response, 404, { error: "artifact_not_found" });
    }

    const pathname = getPaidArtifactPathname(manifest);

    try {
      const metadata = await dependencies.headArtifact(pathname);
      validateArtifactMetadata(metadata, manifest);

      if (method === "HEAD") {
        setArtifactHeaders(response, metadata, manifest);
        response.statusCode = 200;
        response.end();
        return;
      }

      const signedDownloadUrl = await dependencies.createSignedUrl(pathname);
      if (!isSafeSignedDownloadUrl(signedDownloadUrl)) {
        throw new PaidArtifactUnavailableError("invalid signed artifact URL");
      }

      response.statusCode = 302;
      response.setHeader("Location", signedDownloadUrl);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.end();
    } catch (error) {
      if (
        error instanceof PaidArtifactUnavailableError ||
        isBlobNotFoundError(error)
      ) {
        dependencies.logArtifactError(error);
        return sendJson(response, 404, { error: "artifact_not_found" });
      }

      dependencies.logArtifactError(error);
      if (isBlobError(error)) {
        return sendJson(response, 503, {
          error: "temporarily_unavailable",
        });
      }

      return sendJson(response, 503, { error: "temporarily_unavailable" });
    }
  };
}

async function headPaidArtifact(pathname: string) {
  const { head } = await import("@vercel/blob");
  return head(pathname);
}

export async function createSignedPaidDownloadUrl(pathname: string) {
  const {
    getDownloadUrl,
    issueSignedToken,
    presignUrl,
  } = await import("@vercel/blob");
  const validUntil = Date.now() + SIGNED_DOWNLOAD_TTL_MS;
  const signedToken = await issueSignedToken({
    pathname,
    operations: ["get"],
    validUntil,
  });
  const { presignedUrl } = await presignUrl(signedToken, {
    access: "private",
    operation: "get",
    pathname,
    validUntil,
  });

  return getDownloadUrl(presignedUrl);
}

function validateArtifactMetadata(
  metadata: PaidArtifactMetadata | null,
  manifest: PaidReleaseManifest,
): asserts metadata is PaidArtifactMetadata {
  if (
    !metadata ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size !== manifest.sizeBytes
  ) {
    throw new PaidArtifactUnavailableError(
      "paid artifact metadata does not match manifest",
    );
  }
}

function setArtifactHeaders(
  response: ServerResponse,
  metadata: PaidArtifactMetadata,
  manifest: PaidReleaseManifest,
) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    "Content-Disposition",
    `attachment; filename="${manifest.filename}"`,
  );
  response.setHeader(
    "Content-Type",
    metadata.contentType || DEFAULT_CONTENT_TYPE,
  );
  response.setHeader("Content-Length", String(manifest.sizeBytes));
  response.setHeader("X-Sidestream-Paid-Platform", manifest.platform);
  response.setHeader("X-Sidestream-Paid-Sha256", manifest.sha256);
  response.setHeader("X-Sidestream-Paid-Version", manifest.version);
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (metadata.etag) response.setHeader("ETag", metadata.etag);
}

function isSafeSignedDownloadUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password;
  } catch {
    return false;
  }
}

function isBlobNotFoundError(error: unknown) {
  return error instanceof Error && error.name === "BlobNotFoundError";
}

function isBlobError(error: unknown) {
  return error instanceof Error &&
    (error.name === "BlobError" || error.name.startsWith("Blob"));
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

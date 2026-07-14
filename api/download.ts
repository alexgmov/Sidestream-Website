import {
  BlobError,
  BlobNotFoundError,
  getDownloadUrl,
  head,
  issueSignedToken,
  presignUrl,
} from "@vercel/blob";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  getReleaseInstallerPathname,
  resolveReleasePlatform,
} from "./_lib/release-manifest.js";

const INSTALLER_PATHNAME_ENV = "SIDESTREAM_INSTALLER_BLOB_PATHNAME";
const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const SIGNED_DOWNLOAD_TTL_MS = 5 * 60 * 1000;

type DownloadRequest = IncomingMessage & {
  method?: string;
  url?: string;
};

export default async function handler(
  request: DownloadRequest,
  response: ServerResponse,
) {
  const method = (request.method || "GET").toUpperCase();

  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return sendText(response, 405, "Method not allowed");
  }

  const requestUrl = new URL(request.url || "/api/download", "https://sidestream.tv");
  const platform = resolveReleasePlatform(requestUrl.searchParams.get("platform"));

  if (!platform) {
    return sendText(response, 404, "Platform installer not found");
  }

  const fallbackPathname = platform === "macos" ? process.env[INSTALLER_PATHNAME_ENV] : undefined;
  const pathname = getReleaseInstallerPathname(platform, fallbackPathname);
  if (!pathname) {
    return sendJson(response, 500, {
      error: `Missing ${INSTALLER_PATHNAME_ENV}`,
    });
  }

  try {
    const metadata = await head(pathname);

    if (method === "HEAD") {
      setDownloadHeaders(response, {
        contentType: metadata.contentType,
        etag: metadata.etag,
        filename: filenameFromPathname(pathname),
        size: metadata.size,
      });
      response.statusCode = 200;
      response.end();
      return;
    }

    if (headerValue(request.headers["if-none-match"]) === metadata.etag) {
      response.statusCode = 304;
      response.end();
      return;
    }

    response.statusCode = 302;
    response.setHeader("Location", await createSignedDownloadUrl(pathname));
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.end();
  } catch (error) {
    if (error instanceof BlobNotFoundError) {
      return sendText(response, 404, "Installer not found");
    }

    if (error instanceof BlobError) {
      const payload = {
        error: "Blob download is not configured correctly",
      };

      if (process.env.VERCEL_ENV === "development") {
        Object.assign(payload, { message: error.message });
      }

      return sendJson(response, 500, payload);
    }

    throw error;
  }
}

async function createSignedDownloadUrl(pathname: string) {
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

function setDownloadHeaders(
  response: ServerResponse,
  options: {
    contentType?: string | null;
    etag?: string;
    filename: string;
    size?: number | null;
  },
) {
  response.setHeader("Cache-Control", "private, no-cache, max-age=0, must-revalidate");
  response.setHeader("Content-Disposition", `attachment; filename="${options.filename}"`);
  response.setHeader("Content-Type", options.contentType || DEFAULT_CONTENT_TYPE);
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (typeof options.size === "number") {
    response.setHeader("Content-Length", String(options.size));
  }

  if (options.etag) {
    response.setHeader("ETag", options.etag);
  }
}

function filenameFromPathname(pathname: string) {
  const filename = pathname.split("/").filter(Boolean).pop() || "Sidestream-Installer.dmg";
  return filename.replace(/["\\\r\n]/g, "_");
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
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

function sendText(response: ServerResponse, statusCode: number, message: string) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(message);
}

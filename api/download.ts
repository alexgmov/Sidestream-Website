import {
  BlobError,
  BlobNotFoundError,
  getDownloadUrl,
  head,
  issueSignedToken,
  presignUrl,
} from "@vercel/blob";
import { waitUntil } from "@vercel/functions";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  getReleaseInstallerPathname,
  resolveReleasePlatform,
} from "./_lib/release-manifest.js";
import type { ReleasePlatform } from "./_lib/release-manifest.js";
import {
  buildInstallerReferralEvent,
  parseGmailReferral,
  recordInstallerReferral,
} from "./_lib/installer-referral.js";
import type { InstallerReferralEvent } from "./_lib/installer-referral.js";

const INSTALLER_PATHNAME_ENV = "SIDESTREAM_INSTALLER_BLOB_PATHNAME";
const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const SIGNED_DOWNLOAD_TTL_MS = 5 * 60 * 1000;
const REFERRAL_WRITE_TIMEOUT_MS = 1_000;

type DownloadRequest = IncomingMessage & {
  method?: string;
  url?: string;
};

type DownloadDependencies = {
  headInstaller: (pathname: string) => Promise<{
    contentType?: string | null;
    etag?: string;
    size?: number | null;
  }>;
  createSignedUrl: (pathname: string) => Promise<string>;
  recordReferral: (event: InstallerReferralEvent) => Promise<void>;
  trackingTimeoutMs: number;
  logTrackingError: (error: unknown) => void;
  scheduleBackground: (operation: Promise<void>) => void;
};

export function createDownloadHandler(
  overrides: Partial<DownloadDependencies> = {},
) {
  const dependencies: DownloadDependencies = {
    headInstaller: head,
    createSignedUrl: createSignedDownloadUrl,
    recordReferral: recordInstallerReferral,
    trackingTimeoutMs: REFERRAL_WRITE_TIMEOUT_MS,
    logTrackingError: (error) => {
      console.error("Sidestream installer referral capture failed", error);
    },
    scheduleBackground: waitUntil,
    ...overrides,
  };

  return async function handler(
    request: DownloadRequest,
    response: ServerResponse,
  ) {
    const method = (request.method || "GET").toUpperCase();

    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      return sendText(response, 405, "Method not allowed");
    }

    const requestUrl = new URL(
      request.url || "/api/download",
      "https://sidestream.tv",
    );
    const platform = resolveReleasePlatform(
      requestUrl.searchParams.get("platform"),
    );

    if (!platform) {
      return sendText(response, 404, "Platform installer not found");
    }

    const fallbackPathname = platform === "macos"
      ? process.env[INSTALLER_PATHNAME_ENV]
      : undefined;
    const pathname = getReleaseInstallerPathname(platform, fallbackPathname);
    if (!pathname) {
      return sendJson(response, 500, {
        error: `Missing ${INSTALLER_PATHNAME_ENV}`,
      });
    }

    try {
      const metadata = await dependencies.headInstaller(pathname);

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

      const signedDownloadUrl = await dependencies.createSignedUrl(pathname);
      response.statusCode = 302;
      response.setHeader("Location", signedDownloadUrl);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.end();

      if (parseGmailReferral(requestUrl.searchParams)) {
        try {
          dependencies.scheduleBackground(
            captureReferralAfterResponse(
              request,
              requestUrl,
              platform,
              dependencies,
            ),
          );
        } catch (error) {
          dependencies.logTrackingError(error);
        }
      }
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
  };
}

export default createDownloadHandler();

async function captureReferralAfterResponse(
  request: DownloadRequest,
  requestUrl: URL,
  platform: ReleasePlatform,
  dependencies: Pick<
    DownloadDependencies,
    "recordReferral" | "trackingTimeoutMs" | "logTrackingError"
  >,
) {
  try {
    const event = buildInstallerReferralEvent(request, requestUrl, platform);
    if (!event) return;

    await withTimeout(
      dependencies.recordReferral(event),
      dependencies.trackingTimeoutMs,
    );
  } catch (error) {
    dependencies.logTrackingError(error);
  }
}

async function withTimeout(operation: Promise<void>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      operation,
      new Promise<void>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Installer referral write timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
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

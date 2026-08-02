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
  readReleaseManifest,
  resolveReleasePlatform,
} from "./_lib/release-manifest.js";
import type {
  ReleaseManifest,
  ReleasePlatform,
} from "./_lib/release-manifest.js";
import {
  buildInstallerReferralEvent,
  isLikelyScanner,
  parseGmailReferral,
  recordInstallerReferral,
} from "./_lib/installer-referral.js";
import type { InstallerReferralEvent } from "./_lib/installer-referral.js";
import {
  createBrowserAcquisitionCookie,
  normalizeBrowserAcquisitionAttribution,
  readBrowserAcquisitionCookie,
  serializeBrowserAcquisitionCookie,
  verifyBrowserAcquisitionCookie,
  ACQUISITION_SECRET_NAME,
  type BrowserAcquisitionCookie,
} from "./_lib/acquisition-cookie.js";
import {
  createAnonymousAcquisitionAssignment,
  createAnonymousAcquisitionSession,
  recordAnonymousAcquisitionInstallerRequest,
} from "./_lib/anonymous-acquisition.js";

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
  recordAcquisition: (event: AnonymousAcquisitionDownloadEvent) => Promise<void>;
  getAcquisitionSecret: () => string;
  now: () => Date;
  trackingTimeoutMs: number;
  logTrackingError: (error: unknown) => void;
  logManifestError: (error: unknown) => void;
  scheduleBackground: (operation: Promise<void>) => void;
};

export type AnonymousAcquisitionDownloadEvent = Readonly<{
  cookie: BrowserAcquisitionCookie;
  platform: "macos" | "windows";
  requestedAt: Date;
}>;

class ReleaseArtifactMetadataError extends Error {}

export function createDownloadHandler(
  overrides: Partial<DownloadDependencies> = {},
) {
  const dependencies: DownloadDependencies = {
    headInstaller: head,
    createSignedUrl: createSignedDownloadUrl,
    recordReferral: recordInstallerReferral,
    recordAcquisition: persistAnonymousAcquisitionDownload,
    getAcquisitionSecret: () => process.env[ACQUISITION_SECRET_NAME]?.trim() || "",
    now: () => new Date(),
    trackingTimeoutMs: REFERRAL_WRITE_TIMEOUT_MS,
    logTrackingError: (error) => {
      console.error("Sidestream installer referral capture failed", error);
    },
    logManifestError: (error) => {
      console.error("[sidestream download] release manifest unavailable:", error);
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

    let manifest: ReleaseManifest;
    try {
      manifest = readReleaseManifest(platform);
    } catch (error) {
      dependencies.logManifestError(error);
      return sendText(response, 503, "Release manifest is not available");
    }

    const pathname = manifest.artifact.pathname;

    try {
      const metadata = await dependencies.headInstaller(pathname);
      validateArtifactMetadata(metadata, manifest);

      if (method === "HEAD") {
        setDownloadHeaders(response, {
          contentType: metadata.contentType,
          etag: metadata.etag,
          manifest,
        });
        response.statusCode = 200;
        response.end();
        return;
      }

      if (headerValue(request.headers["if-none-match"]) === metadata.etag) {
        response.setHeader("Cache-Control", "private, no-cache, max-age=0, must-revalidate");
        response.setHeader("X-Content-Type-Options", "nosniff");
        if (metadata.etag) response.setHeader("ETag", metadata.etag);
        response.statusCode = 304;
        response.end();
        return;
      }

      const signedDownloadUrl = await dependencies.createSignedUrl(pathname);
      const acquisition = resolveAcquisitionForDownload(
        request,
        requestUrl,
        dependencies,
      );
      response.statusCode = 302;
      response.setHeader("Location", signedDownloadUrl);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (acquisition?.setCookie) {
        response.setHeader("Set-Cookie", acquisition.setCookie);
      }
      response.end();

      if (acquisition && !isLikelyScanner(request)) {
        try {
          dependencies.scheduleBackground(
            captureAcquisitionAfterResponse(
              acquisition.cookie,
              platform,
              acquisition.requestedAt,
              dependencies,
            ),
          );
        } catch (error) {
          dependencies.logTrackingError(error);
        }
      }

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
      if (error instanceof ReleaseArtifactMetadataError) {
        dependencies.logManifestError(error);
        return sendText(response, 503, "Installer metadata does not match release manifest");
      }

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

function resolveAcquisitionForDownload(
  request: DownloadRequest,
  requestUrl: URL,
  dependencies: Pick<
    DownloadDependencies,
    "getAcquisitionSecret" | "now" | "logTrackingError"
  >,
) {
  try {
    const secret = dependencies.getAcquisitionSecret();
    const secretLength = Buffer.byteLength(secret, "utf8");
    if (secretLength < 32 || secretLength > 512) return null;
    const requestedAt = dependencies.now();
    const existing = readBrowserAcquisitionCookie(request.headers.cookie);
    if (existing) {
      try {
        return {
          cookie: verifyBrowserAcquisitionCookie(existing, { secret, now: requestedAt }),
          requestedAt,
          setCookie: "",
        };
      } catch {
        // A forged or expired cookie has no authority over the fresh first touch.
      }
    }
    const cookie = createBrowserAcquisitionCookie({
      attribution: normalizeBrowserAcquisitionAttribution(requestUrl.searchParams),
    }, { secret, now: requestedAt });
    return {
      cookie,
      requestedAt,
      setCookie: serializeBrowserAcquisitionCookie(cookie),
    };
  } catch (error) {
    dependencies.logTrackingError(error);
    return null;
  }
}

async function captureAcquisitionAfterResponse(
  cookie: BrowserAcquisitionCookie,
  platform: ReleasePlatform,
  requestedAt: Date,
  dependencies: Pick<
    DownloadDependencies,
    "recordAcquisition" | "trackingTimeoutMs" | "logTrackingError"
  >,
) {
  try {
    await withTimeout(
      dependencies.recordAcquisition({ cookie, platform, requestedAt }),
      dependencies.trackingTimeoutMs,
    );
  } catch (error) {
    dependencies.logTrackingError(error);
  }
}

async function persistAnonymousAcquisitionDownload(
  event: AnonymousAcquisitionDownloadEvent,
) {
  const secret = process.env[ACQUISITION_SECRET_NAME]?.trim() || "";
  const assignment = event.cookie.experiment
    ? createAnonymousAcquisitionAssignment({
        ...event.cookie.experiment,
        secret,
      })
    : null;
  await createAnonymousAcquisitionSession({
    token: event.cookie.token,
    attribution: event.cookie.attribution,
    assignment,
    assignmentSecret: assignment ? secret : undefined,
    firstSeenAt: new Date(event.cookie.issuedAt * 1000),
    expiresAt: new Date(event.cookie.expiresAt * 1000),
  });
  await recordAnonymousAcquisitionInstallerRequest({
    token: event.cookie.token,
    platform: event.platform,
    requestedAt: event.requestedAt,
  });
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
    manifest: ReleaseManifest;
  },
) {
  const { manifest } = options;
  response.setHeader("Cache-Control", "private, no-cache, max-age=0, must-revalidate");
  response.setHeader(
    "Content-Disposition",
    `attachment; filename="${manifest.artifact.filename}"`,
  );
  response.setHeader("Content-Type", options.contentType || DEFAULT_CONTENT_TYPE);
  response.setHeader("Content-Length", String(manifest.artifact.sizeBytes));
  response.setHeader("Last-Modified", new Date(manifest.publishedAt).toUTCString());
  response.setHeader("X-Sidestream-Platform", manifest.platform);
  response.setHeader("X-Sidestream-Sha256", manifest.artifact.sha256);
  response.setHeader("X-Sidestream-Version", manifest.version);
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (options.etag) {
    response.setHeader("ETag", options.etag);
  }
}

function validateArtifactMetadata(
  metadata: { size?: number | null },
  manifest: ReleaseManifest,
) {
  if (
    !Number.isSafeInteger(metadata.size) ||
    metadata.size !== manifest.artifact.sizeBytes
  ) {
    throw new ReleaseArtifactMetadataError(
      "Blob size does not match the validated release manifest",
    );
  }
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

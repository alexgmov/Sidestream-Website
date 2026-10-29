import { waitUntil } from "@vercel/functions";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createInstallerDownloadUrl,
  headInstallerArtifact,
  InstallerArtifactNotFoundError,
  InstallerDeliveryError,
} from "./_lib/installer-delivery.js";
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
  resolveBrowserAcquisitionCookie,
  serializeBrowserAcquisitionCookie,
  ACQUISITION_SECRET_NAME,
  type BrowserAcquisitionCookie,
} from "./_lib/acquisition-cookie.js";
import {
  createAnonymousAcquisitionAssignment,
  createAnonymousAcquisitionSession,
  recordAnonymousAcquisitionInstallerRequest,
} from "./_lib/anonymous-acquisition.js";
import {
  AcquisitionIntegrityError,
  addTrustedDeliveryEvidence,
  recordAcquisitionStage,
} from "./_lib/acquisition-integrity.js";
import { ensureBrowserAcquisition } from "./acquisition/_lib.js";
import { readMacDownloadRollout, selectMacDownloadManifest, type MacDownloadRollout } from "./_lib/mac-download-rollout.js";

const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const REFERRAL_WRITE_TIMEOUT_MS = 1_000;

type DownloadRequest = IncomingMessage & {
  method?: string;
  url?: string;
};

type DownloadDependencies = {
  readManifest: (platform: ReleasePlatform) => ReleaseManifest | null;
  trackAcquisition: boolean;
  readMacRollout: () => MacDownloadRollout | null;
  logDownloadSelection: (selection: { rolloutId: string; version: string; cohort: "stable" | "pilot" }) => void;
  headInstaller: (pathname: string) => Promise<{
    contentType?: string | null;
    etag?: string;
    sha256?: string;
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
    readManifest: readReleaseManifest,
    trackAcquisition: true,
    readMacRollout: readMacDownloadRollout,
    logDownloadSelection: (selection) => console.info("[sidestream mac download cohort]", JSON.stringify(selection)),
    headInstaller: headInstallerArtifact,
    createSignedUrl: createInstallerDownloadUrl,
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
      const selected = dependencies.readManifest(platform);
      if (!selected) return sendText(response, 404, "Release installer not available");
      manifest = selected;
    } catch (error) {
      dependencies.logManifestError(error);
      return sendText(response, 503, "Release manifest is not available");
    }

    const baseline = manifest;
    let macPilot: MacDownloadRollout | null = null;
    const acquisition = dependencies.trackAcquisition ? resolveAcquisitionForDownload(
      request, requestUrl, dependencies, method === "GET",
    ) : null;
    if (dependencies.trackAcquisition && platform === "macos" && manifest.channel === "stable" &&
        requestUrl.searchParams.get("release") !== "stable") {
      try {
        macPilot = dependencies.readMacRollout();
        manifest = selectMacDownloadManifest(manifest, macPilot, acquisition?.cookie.token,
          dependencies.getAcquisitionSecret());
      } catch {
        dependencies.logManifestError(new Error("Mac download pilot configuration unavailable; serving stable"));
      }
    }
    const ifNoneMatch = headerValue(request.headers["if-none-match"]) ||
      headerValue(request.headers["x-sidestream-origin-if-none-match"]);
    const prepareDelivery = async (selected: ReleaseManifest) => {
      const metadata = await dependencies.headInstaller(selected.artifact.pathname);
      validateArtifactMetadata(metadata, selected);
      const unchanged = method === "GET" && ifNoneMatch === metadata.etag;
      const signedDownloadUrl = method === "GET" && !unchanged
        ? await dependencies.createSignedUrl(selected.artifact.pathname) : null;
      return { metadata, unchanged, signedDownloadUrl };
    };

    try {
      let delivery;
      try {
        delivery = await prepareDelivery(manifest);
      } catch (error) {
        if (manifest === baseline) throw error;
        dependencies.logManifestError(new Error("Mac download pilot artifact unavailable; serving stable"));
        manifest = baseline;
        delivery = await prepareDelivery(manifest);
      }
      const { metadata, unchanged, signedDownloadUrl } = delivery;
      response.setHeader("X-Sidestream-Version", manifest.version);
      response.setHeader("X-Sidestream-Sha256", manifest.artifact.sha256);
      if (platform === "macos" && baseline.channel === "stable") {
        response.setHeader("Vary", "Cookie");
        response.setHeader("X-Sidestream-Download-Cohort", manifest === baseline ? "stable" : "pilot");
      }

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

      if (unchanged) {
        if (acquisition?.setCookie) response.setHeader("Set-Cookie", acquisition.setCookie);
        response.setHeader("Cache-Control", "private, no-cache, max-age=0, must-revalidate");
        response.setHeader("X-Content-Type-Options", "nosniff");
        if (metadata.etag) response.setHeader("ETag", metadata.etag);
        response.statusCode = 304;
        response.end();
        return;
      }

      response.statusCode = 302;
      response.setHeader("Location", signedDownloadUrl!);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (acquisition?.setCookie) {
        response.setHeader("Set-Cookie", acquisition.setCookie);
      }
      response.end();

      if (macPilot && !isLikelyScanner(request) && baseline.version === macPilot.baselineVersion &&
          baseline.artifact.sha256 === macPilot.baselineSha256) {
        try { dependencies.logDownloadSelection({ rolloutId: macPilot.rolloutId, version: manifest.version,
          cohort: manifest === baseline ? "stable" : "pilot" }); } catch { /* observation must not block delivery */ }
      }
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

      if (dependencies.trackAcquisition && parseGmailReferral(requestUrl.searchParams)) {
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

      if (error instanceof InstallerArtifactNotFoundError) {
        return sendText(response, 404, "Installer not found");
      }

      if (error instanceof InstallerDeliveryError) {
        const payload = {
          error: "Installer delivery is not configured correctly",
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
  createIfMissing = true,
) {
  try {
    const secret = dependencies.getAcquisitionSecret();
    const secretLength = Buffer.byteLength(secret, "utf8");
    if (secretLength < 32 || secretLength > 512) return null;
    const requestedAt = dependencies.now();
    const existing = readBrowserAcquisitionCookie(request.headers.cookie);
    if (existing) {
      try {
        const resolved = resolveBrowserAcquisitionCookie(existing, { secret, now: requestedAt });
        return {
          cookie: resolved.cookie,
          requestedAt,
          setCookie: resolved.promoted
            ? serializeBrowserAcquisitionCookie(resolved.cookie)
            : "",
        };
      } catch {
        // A forged or expired cookie has no authority over the fresh first touch.
      }
    }
    if (!createIfMissing) return null;
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
  await Promise.all([
    (async () => {
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
    })(),
    persistCanonicalInstallerRequest(event),
  ]);
}

async function persistCanonicalInstallerRequest(
  event: AnonymousAcquisitionDownloadEvent,
) {
  const stageInput = {
    acquisitionId: event.cookie.acquisitionId,
    stage: "installer_requested" as const,
    stableServerReference: `installer-request:${event.cookie.acquisitionId}:${event.platform}`,
    occurredAt: event.requestedAt,
  };
  try {
    await recordAcquisitionStage(stageInput);
  } catch (error) {
    if (!(error instanceof AcquisitionIntegrityError) || error.code !== "acquisition_not_found") {
      throw error;
    }
    await ensureBrowserAcquisition(event.cookie);
    await recordAcquisitionStage(stageInput);
  }
  await addTrustedDeliveryEvidence({
    acquisitionId: event.cookie.acquisitionId,
    evidence: "installer_redirect",
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
  response.setHeader("X-Sidestream-Release-Category", manifest.channel);
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (options.etag) {
    response.setHeader("ETag", options.etag);
  }
}

function validateArtifactMetadata(
  metadata: { sha256?: string; size?: number | null },
  manifest: ReleaseManifest,
) {
  if (
    !Number.isSafeInteger(metadata.size) ||
    metadata.size !== manifest.artifact.sizeBytes ||
    (metadata.sha256 !== undefined && metadata.sha256 !== manifest.artifact.sha256)
  ) {
    throw new ReleaseArtifactMetadataError(
      "artifact metadata does not match the validated release manifest",
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

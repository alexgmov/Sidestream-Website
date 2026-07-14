import fs from "node:fs";
import path from "node:path";

const DEFAULT_MANIFEST_PATHS = {
  macos: path.join(process.cwd(), "data", "release-manifest.json"),
  windows: path.join(process.cwd(), "data", "release-manifest.windows.json"),
} as const;
const SIDESTREAM_ORIGIN = "https://sidestream.tv";

export type ReleasePlatform = keyof typeof DEFAULT_MANIFEST_PATHS;

export type ReleaseManifest = {
  schemaVersion: 1;
  product: "sidestream";
  channel: "stable";
  version: string;
  minSupportedVersion: string;
  critical: boolean;
  rolloutPercent: number;
  publishedAt: string;
  releaseNotesUrl: string;
  artifact: {
    type: string;
    url: string;
    pathname?: string;
    sha256: string;
    sizeBytes: number;
  };
};

export function resolveReleasePlatform(value?: string | null): ReleasePlatform | null {
  const platform = String(value || "").trim().toLowerCase();

  if (!platform || ["darwin-arm64", "darwin-x64", "macos", "macos-arm64", "macos-x64"].includes(platform)) {
    return "macos";
  }

  if (["win32-x64", "windows", "windows-x64"].includes(platform)) {
    return "windows";
  }

  return null;
}

export function readReleaseManifest(platform: ReleasePlatform = "macos") {
  const manifestPath = getManifestPath(platform);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ReleaseManifest;
  validateReleaseManifest(manifest);
  return manifest;
}

export function getReleaseInstallerPathname(
  platform: ReleasePlatform = "macos",
  fallbackPathname?: string,
) {
  try {
    const manifestPathname = readReleaseManifest(platform).artifact.pathname?.trim();

    if (manifestPathname) {
      return manifestPathname;
    }
  } catch (error) {
    if (!fallbackPathname) {
      throw error;
    }
  }

  return fallbackPathname?.trim() || "";
}

function getManifestPath(platform: ReleasePlatform) {
  if (platform === "windows") {
    return process.env.SIDESTREAM_WINDOWS_RELEASE_MANIFEST_PATH || DEFAULT_MANIFEST_PATHS.windows;
  }

  return process.env.SIDESTREAM_RELEASE_MANIFEST_PATH || DEFAULT_MANIFEST_PATHS.macos;
}

export function toPublicReleaseManifest(manifest: ReleaseManifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    product: manifest.product,
    channel: manifest.channel,
    version: manifest.version,
    minSupportedVersion: manifest.minSupportedVersion,
    critical: manifest.critical,
    rolloutPercent: manifest.rolloutPercent,
    publishedAt: manifest.publishedAt,
    releaseNotesUrl: manifest.releaseNotesUrl,
    artifact: {
      type: manifest.artifact.type,
      url: manifest.artifact.url,
      sha256: manifest.artifact.sha256,
      sizeBytes: manifest.artifact.sizeBytes,
    },
  };
}

function validateReleaseManifest(manifest: ReleaseManifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("manifest object missing");
  if (manifest.schemaVersion !== 1) throw new Error("unsupported manifest schema");
  if (manifest.product !== "sidestream") throw new Error("manifest product mismatch");
  if (manifest.channel !== "stable") throw new Error("unsupported release channel");
  if (!isSemver(manifest.version)) throw new Error("invalid release version");
  if (!isSemver(manifest.minSupportedVersion)) throw new Error("invalid minimum supported version");
  if (!Number.isFinite(Number(manifest.rolloutPercent))) throw new Error("invalid rollout percent");
  if (!isSidestreamUrl(manifest.releaseNotesUrl)) throw new Error("release notes URL must use sidestream.tv");
  if (!manifest.artifact || typeof manifest.artifact !== "object") throw new Error("artifact missing");
  if (!isSidestreamUrl(manifest.artifact.url)) throw new Error("artifact URL must use sidestream.tv");
  if (!/^[a-f0-9]{64}$/i.test(String(manifest.artifact.sha256 || ""))) {
    throw new Error("artifact sha256 missing");
  }
  if (!Number.isFinite(Number(manifest.artifact.sizeBytes)) || Number(manifest.artifact.sizeBytes) <= 0) {
    throw new Error("artifact size missing");
  }
}

function isSemver(value: string) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(value || ""));
}

function isSidestreamUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === SIDESTREAM_ORIGIN;
  } catch {
    return false;
  }
}

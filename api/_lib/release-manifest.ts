import fs from "node:fs";
import path from "node:path";
import macosReleaseManifest from "../../data/release-manifest.json" with { type: "json" };
import windowsReleaseManifest from "../../data/release-manifest.windows.json" with { type: "json" };

const DEFAULT_MANIFESTS = {
  macos: macosReleaseManifest,
  windows: windowsReleaseManifest,
} as const;
const SIDESTREAM_ORIGIN = "https://sidestream.tv";

const PLATFORM_CONTRACTS = {
  macos: {
    aliases: new Set<string>([
      "darwin-arm64",
      "darwin-x64",
      "macos",
      "macos-arm64",
      "macos-x64",
    ]),
    artifactType: "dmg",
    extension: ".dmg",
    filenamePlatform: "Mac",
    publicPlatform: "macos",
  },
  windows: {
    aliases: new Set<string>(["win32-x64", "windows", "windows-x64"]),
    artifactType: "exe",
    extension: ".exe",
    filenamePlatform: "Windows",
    publicPlatform: "win32-x64",
  },
} as const;

export type ReleasePlatform = keyof typeof DEFAULT_MANIFESTS;
export type PublicReleasePlatform =
  (typeof PLATFORM_CONTRACTS)[ReleasePlatform]["publicPlatform"];

export type ReleaseManifest = {
  schemaVersion: 1;
  product: "sidestream";
  channel: "stable";
  platform: PublicReleasePlatform;
  version: string;
  minSupportedVersion: string;
  critical: boolean;
  rolloutPercent: number;
  publishedAt: string;
  releaseNotesUrl: string;
  artifact: {
    type: "dmg" | "exe";
    url: string;
    pathname: string;
    filename: string;
    sha256: string;
    sizeBytes: number;
  };
};

export function resolveReleasePlatform(
  value?: string | null,
): ReleasePlatform | null {
  if (value === null || value === undefined) {
    return "macos";
  }

  const platform = String(value).trim().toLowerCase();
  if (PLATFORM_CONTRACTS.macos.aliases.has(platform)) {
    return "macos";
  }

  if (PLATFORM_CONTRACTS.windows.aliases.has(platform)) {
    return "windows";
  }

  return null;
}

export function readReleaseManifest(
  platform: ReleasePlatform = "macos",
): ReleaseManifest {
  const manifestPath = getManifestOverridePath(platform);
  const source = manifestPath
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown
    : DEFAULT_MANIFESTS[platform] as unknown;
  return parseReleaseManifest(source, platform);
}

export function parseReleaseManifest(
  source: unknown,
  expectedPlatform: ReleasePlatform,
): ReleaseManifest {
  const manifest = requireRecord(source, "manifest object missing");
  const artifact = requireRecord(manifest.artifact, "artifact missing");
  const contract = PLATFORM_CONTRACTS[expectedPlatform];

  if (manifest.schemaVersion !== 1) {
    throw new Error("unsupported manifest schema");
  }
  if (manifest.product !== "sidestream") {
    throw new Error("manifest product mismatch");
  }
  if (manifest.channel !== "stable") {
    throw new Error("unsupported release channel");
  }

  const declaredPlatform = optionalString(manifest.platform);
  if (
    declaredPlatform !== null &&
    resolveReleasePlatform(declaredPlatform) !== expectedPlatform
  ) {
    throw new Error("manifest platform mismatch");
  }

  const version = requireString(manifest.version, "invalid release version");
  if (!isSemver(version)) throw new Error("invalid release version");

  const minSupportedVersion = requireString(
    manifest.minSupportedVersion,
    "invalid minimum supported version",
  );
  if (!isSemver(minSupportedVersion)) {
    throw new Error("invalid minimum supported version");
  }

  if (typeof manifest.critical !== "boolean") {
    throw new Error("invalid critical flag");
  }
  if (
    !Number.isInteger(manifest.rolloutPercent) ||
    Number(manifest.rolloutPercent) < 0 ||
    Number(manifest.rolloutPercent) > 100
  ) {
    throw new Error("invalid rollout percent");
  }

  const publishedAt = requireString(
    manifest.publishedAt,
    "invalid published time",
  );
  if (!isCanonicalIsoTimestamp(publishedAt)) {
    throw new Error("invalid published time");
  }

  const releaseNotesUrl = requireString(
    manifest.releaseNotesUrl,
    "release notes URL missing",
  );
  if (!isSidestreamUrl(releaseNotesUrl)) {
    throw new Error("release notes URL must use sidestream.tv");
  }

  if (artifact.type !== contract.artifactType) {
    throw new Error("artifact type does not match platform");
  }

  const artifactUrl = requireString(artifact.url, "artifact URL missing");
  if (!isCanonicalDownloadUrl(artifactUrl, expectedPlatform)) {
    throw new Error("artifact URL does not match platform");
  }

  const pathname = requireString(
    artifact.pathname,
    "artifact pathname missing",
  );
  const filename = validateArtifactPathname(
    pathname,
    version,
    contract.filenamePlatform,
    contract.extension,
  );
  const declaredFilename = optionalString(artifact.filename);
  if (declaredFilename !== null && declaredFilename !== filename) {
    throw new Error("artifact filename does not match pathname");
  }

  const sha256 = requireString(artifact.sha256, "artifact sha256 missing");
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error("artifact sha256 missing");
  }

  if (!Number.isSafeInteger(artifact.sizeBytes) || Number(artifact.sizeBytes) <= 0) {
    throw new Error("artifact size missing");
  }

  return {
    schemaVersion: 1,
    product: "sidestream",
    channel: "stable",
    platform: contract.publicPlatform,
    version,
    minSupportedVersion,
    critical: manifest.critical,
    rolloutPercent: Number(manifest.rolloutPercent),
    publishedAt,
    releaseNotesUrl,
    artifact: {
      type: contract.artifactType,
      url: artifactUrl,
      pathname,
      filename,
      sha256: sha256.toLowerCase(),
      sizeBytes: Number(artifact.sizeBytes),
    },
  };
}

export function toPublicReleaseManifest(manifest: ReleaseManifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    product: manifest.product,
    channel: manifest.channel,
    platform: manifest.platform,
    version: manifest.version,
    minSupportedVersion: manifest.minSupportedVersion,
    critical: manifest.critical,
    rolloutPercent: manifest.rolloutPercent,
    publishedAt: manifest.publishedAt,
    releaseNotesUrl: manifest.releaseNotesUrl,
    artifact: {
      type: manifest.artifact.type,
      url: manifest.artifact.url,
      filename: manifest.artifact.filename,
      sha256: manifest.artifact.sha256,
      sizeBytes: manifest.artifact.sizeBytes,
    },
  };
}

function getManifestOverridePath(platform: ReleasePlatform) {
  if (platform === "windows") {
    return process.env.SIDESTREAM_WINDOWS_RELEASE_MANIFEST_PATH || null;
  }

  return process.env.SIDESTREAM_RELEASE_MANIFEST_PATH || null;
}

function validateArtifactPathname(
  pathname: string,
  version: string,
  filenamePlatform: "Mac" | "Windows",
  expectedExtension: ".dmg" | ".exe",
) {
  if (
    pathname.startsWith("/") ||
    pathname.includes("\\") ||
    pathname.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("invalid artifact pathname");
  }

  const filename = path.posix.basename(pathname);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(filename)) {
    throw new Error("invalid artifact filename");
  }

  const expectedFilename = new RegExp(
    `^Sidestream-${escapeRegExp(version)}-${filenamePlatform}(?:-[A-Za-z0-9]+)*-Installer\\${expectedExtension}$`,
    "i",
  );
  if (!expectedFilename.test(filename)) {
    throw new Error("artifact filename does not match version or platform");
  }

  return filename;
}

function isCanonicalDownloadUrl(value: string, platform: ReleasePlatform) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.origin !== SIDESTREAM_ORIGIN ||
      url.pathname !== "/api/download" ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return false;
    }

    const parameters = [...url.searchParams.entries()];
    if (platform === "macos") return parameters.length === 0;

    return parameters.length === 1 &&
      parameters[0][0] === "platform" &&
      parameters[0][1] === PLATFORM_CONTRACTS.windows.publicPlatform;
  } catch {
    return false;
  }
}

function isSemver(value: string) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function isCanonicalIsoTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isSidestreamUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.origin === SIDESTREAM_ORIGIN &&
      !url.username &&
      !url.password;
  } catch {
    return false;
  }
}

function requireRecord(value: unknown, message: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }

  return value as Record<string, unknown>;
}

function requireString(value: unknown, message: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value.trim();
}

function optionalString(value: unknown) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("invalid optional manifest string");
  }
  return value.trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

import fs from "node:fs";
import path from "node:path";

export const PAID_RELEASE_PLATFORMS = [
  "macos-universal",
  "windows-x64",
] as const;

export type PaidReleasePlatform = (typeof PAID_RELEASE_PLATFORMS)[number];

export type PublicPaidReleaseManifest = {
  schemaVersion: 1;
  platform: PaidReleasePlatform;
  version: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
};

export type PaidReleaseManifest = PublicPaidReleaseManifest & {
  artifactPathname: string;
};

const DEFAULT_MANIFEST_PATHS: Record<PaidReleasePlatform, string> = {
  "macos-universal": path.join(
    process.cwd(),
    "data",
    "release-manifest.paid.json",
  ),
  "windows-x64": path.join(
    process.cwd(),
    "data",
    "release-manifest.paid.windows.json",
  ),
};

const MANIFEST_SOURCE_KEYS = new Set([
  "artifactPathname",
  "filename",
  "platform",
  "schemaVersion",
  "sha256",
  "sizeBytes",
  "version",
]);
export function resolvePaidReleasePlatform(
  value?: string | null,
): PaidReleasePlatform | null {
  if (value === "macos-universal" || value === "windows-x64") {
    return value;
  }

  return null;
}

export function selectPaidReleasePlatform(
  searchParams: URLSearchParams,
): PaidReleasePlatform | null {
  const entries = [...searchParams.entries()];
  if (
    entries.length !== 1 ||
    entries[0][0] !== "platform"
  ) {
    return null;
  }

  return resolvePaidReleasePlatform(entries[0][1]);
}

export function readPaidReleaseManifest(
  platform: PaidReleasePlatform,
): PaidReleaseManifest {
  const source = JSON.parse(
    fs.readFileSync(getManifestPath(platform), "utf8"),
  ) as unknown;
  return parsePaidReleaseManifest(source, platform);
}

export function parsePaidReleaseManifest(
  source: unknown,
  expectedPlatform: PaidReleasePlatform,
): PaidReleaseManifest {
  const manifest = requireRecord(source);
  const keys = Object.keys(manifest);
  if (
    keys.length !== MANIFEST_SOURCE_KEYS.size ||
    keys.some((key) => !MANIFEST_SOURCE_KEYS.has(key))
  ) {
    throw new Error("invalid paid release manifest fields");
  }

  if (manifest.schemaVersion !== 1) {
    throw new Error("unsupported paid release manifest schema");
  }
  if (manifest.platform !== expectedPlatform) {
    throw new Error("paid release manifest platform mismatch");
  }

  const version = requireExactString(manifest.version, "invalid paid release version");
  if (
    version.length > 32 ||
    !/^[0-9A-Za-z._-]+$/.test(version)
  ) {
    throw new Error("invalid paid release version");
  }

  const filename = requireExactString(
    manifest.filename,
    "invalid paid artifact filename",
  );
  if (
    filename.length > 120 ||
    !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(filename) ||
    !filename.endsWith(expectedPlatform === "macos-universal" ? ".dmg" : ".exe")
  ) {
    throw new Error("invalid paid artifact filename");
  }

  if (
    !Number.isSafeInteger(manifest.sizeBytes) ||
    Number(manifest.sizeBytes) < 1 ||
    Number(manifest.sizeBytes) > 1_073_741_824
  ) {
    throw new Error("invalid paid artifact size");
  }

  const sha256 = requireExactString(
    manifest.sha256,
    "invalid paid artifact sha256",
  );
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("invalid paid artifact sha256");
  }

  const artifactPathname = requireExactString(
    manifest.artifactPathname,
    "invalid paid artifact pathname",
  );
  if (
    artifactPathname.length > 255 ||
    !artifactPathname.startsWith("sidestream/") ||
    !artifactPathname.endsWith(`/${filename}`) ||
    !/^[0-9A-Za-z][0-9A-Za-z._+/-]*$/.test(artifactPathname) ||
    artifactPathname.includes("//") ||
    artifactPathname.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("invalid paid artifact pathname");
  }

  return {
    schemaVersion: 1,
    platform: expectedPlatform,
    version,
    filename,
    sizeBytes: Number(manifest.sizeBytes),
    sha256,
    artifactPathname,
  };
}

export function toPublicPaidReleaseManifest(
  manifest: PaidReleaseManifest,
): PublicPaidReleaseManifest {
  return {
    schemaVersion: manifest.schemaVersion,
    platform: manifest.platform,
    version: manifest.version,
    filename: manifest.filename,
    sizeBytes: manifest.sizeBytes,
    sha256: manifest.sha256,
  };
}

export function getPaidArtifactPathname(manifest: PaidReleaseManifest) {
  return manifest.artifactPathname;
}

function getManifestPath(platform: PaidReleasePlatform) {
  if (platform === "windows-x64") {
    return process.env.SIDESTREAM_PAID_WINDOWS_RELEASE_MANIFEST_PATH ||
      DEFAULT_MANIFEST_PATHS[platform];
  }

  return process.env.SIDESTREAM_PAID_RELEASE_MANIFEST_PATH ||
    DEFAULT_MANIFEST_PATHS[platform];
}

function requireRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("paid release manifest object missing");
  }

  return value as Record<string, unknown>;
}

function requireExactString(value: unknown, message: string) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim()
  ) {
    throw new Error(message);
  }

  return value;
}

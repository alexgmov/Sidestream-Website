import {
  readReleaseManifest,
  type ReleaseManifest,
  type ReleasePlatform,
} from "./release-manifest.js";

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

const RELEASE_PLATFORMS: Record<PaidReleasePlatform, ReleasePlatform> = {
  "macos-universal": "macos",
  "windows-x64": "windows",
};

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
  return toPaidReleaseManifest(
    readReleaseManifest(RELEASE_PLATFORMS[platform]),
    platform,
  );
}

export function toPaidReleaseManifest(
  releaseManifest: ReleaseManifest,
  expectedPlatform: PaidReleasePlatform,
): PaidReleaseManifest {
  const expectedReleasePlatform = expectedPlatform === "macos-universal"
    ? "macos"
    : "win32-x64";
  if (releaseManifest.platform !== expectedReleasePlatform) {
    throw new Error("paid release manifest platform mismatch");
  }

  return {
    schemaVersion: 1,
    platform: expectedPlatform,
    version: releaseManifest.version,
    filename: releaseManifest.artifact.filename,
    sizeBytes: releaseManifest.artifact.sizeBytes,
    sha256: releaseManifest.artifact.sha256,
    artifactPathname: releaseManifest.artifact.pathname,
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

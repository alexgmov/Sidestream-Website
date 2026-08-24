import { createHmac, timingSafeEqual } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import {
  readPaidReleaseManifest,
  type PaidReleasePlatform,
} from "./paid-release-manifest.js";
import {
  readReleaseManifest,
  type ReleasePlatform,
} from "./release-manifest.js";

export const INSTALLER_PROVIDER_ENV = "SIDESTREAM_INSTALLER_PROVIDER";
export const INSTALLER_SIGNING_SECRET_ENV = "SIDESTREAM_DOWNLOAD_SIGNING_SECRET";
export const INSTALLER_ARTIFACT_ROOT_ENV = "SIDESTREAM_ARTIFACT_ROOT";
export const HETZNER_DOWNLOAD_ORIGIN = "https://downloads.sidestream.tv";
export const HETZNER_DOWNLOAD_PATH_PREFIX = "/v1/";
export const HETZNER_INTERNAL_PATH_PREFIX = "/__sidestream_artifacts/";

const DEFAULT_ARTIFACT_ROOT = "/srv/sidestream/artifacts";
const SIGNED_DOWNLOAD_TTL_SECONDS = 5 * 60;
const MAX_SIGNED_DOWNLOAD_LIFETIME_SECONDS = SIGNED_DOWNLOAD_TTL_SECONDS + 30;
const SIGNATURE_CONTEXT = "sidestream-installer-download-v1";
const SAFE_ARTIFACT_PATHNAME = /^[0-9A-Za-z][0-9A-Za-z._+/-]*$/;

export type InstallerProvider = "blob" | "hetzner";

export type InstallerArtifactRecord = Readonly<{
  pathname: string;
  filename: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  platform: "macos" | "windows";
  access: "free" | "paid";
}>;

export type InstallerArtifactMetadata = Readonly<{
  contentType?: string | null;
  etag?: string;
  lastModified?: Date;
  sha256?: string;
  size?: number | null;
}>;

export type AuthorizedInstallerDownload = Readonly<{
  artifact: InstallerArtifactRecord;
  etag: string;
  internalPath: string;
  lastModified: Date;
}>;

export class InstallerDeliveryError extends Error {}
export class InstallerDeliveryConfigurationError extends InstallerDeliveryError {}
export class InstallerArtifactNotFoundError extends InstallerDeliveryError {}
export class InstallerArtifactMismatchError extends InstallerDeliveryError {}
export class InstallerAuthorizationError extends InstallerDeliveryError {}

export function resolveInstallerProvider(
  value = process.env[INSTALLER_PROVIDER_ENV],
): InstallerProvider {
  const provider = String(value || "blob").trim().toLowerCase();
  if (provider === "blob" || provider === "hetzner") return provider;
  throw new InstallerDeliveryConfigurationError(
    `${INSTALLER_PROVIDER_ENV} must be blob or hetzner`,
  );
}

export function listManifestInstallerArtifacts(): readonly InstallerArtifactRecord[] {
  const freePlatforms: readonly ReleasePlatform[] = ["macos", "windows"];
  const paidPlatforms: readonly PaidReleasePlatform[] = [
    "macos-universal",
    "windows-x64",
  ];
  const records = [
    ...freePlatforms.map((platform) => {
      const manifest = readReleaseManifest(platform);
      return Object.freeze({
        pathname: manifest.artifact.pathname,
        filename: manifest.artifact.filename,
        sha256: manifest.artifact.sha256,
        sizeBytes: manifest.artifact.sizeBytes,
        contentType: contentTypeForFilename(manifest.artifact.filename),
        platform: platform === "windows" ? "windows" as const : "macos" as const,
        access: "free" as const,
      });
    }),
    ...paidPlatforms.map((platform) => {
      const manifest = readPaidReleaseManifest(platform);
      return Object.freeze({
        pathname: manifest.artifactPathname,
        filename: manifest.filename,
        sha256: manifest.sha256,
        sizeBytes: manifest.sizeBytes,
        contentType: contentTypeForFilename(manifest.filename),
        platform: platform === "windows-x64" ? "windows" as const : "macos" as const,
        access: "paid" as const,
      });
    }),
  ];

  const pathnames = new Set<string>();
  for (const record of records) {
    validateArtifactPathname(record.pathname);
    if (pathnames.has(record.pathname)) {
      throw new InstallerDeliveryConfigurationError(
        "installer manifests contain a duplicate artifact pathname",
      );
    }
    pathnames.add(record.pathname);
  }
  return Object.freeze(records);
}

export function findManifestInstallerArtifact(pathname: string) {
  const normalized = validateArtifactPathname(pathname);
  const artifact = listManifestInstallerArtifacts().find(
    (candidate) => candidate.pathname === normalized,
  );
  if (!artifact) {
    throw new InstallerArtifactNotFoundError("artifact is not selected by a current manifest");
  }
  return artifact;
}

export async function headInstallerArtifact(
  pathname: string,
  options: Readonly<{
    provider?: InstallerProvider;
    artifactRoot?: string;
  }> = {},
): Promise<InstallerArtifactMetadata> {
  const artifact = findManifestInstallerArtifact(pathname);
  const provider = options.provider || resolveInstallerProvider();
  if (provider === "blob") {
    try {
      const { head } = await import("@vercel/blob");
      const metadata = await head(artifact.pathname);
      return Object.freeze({
        contentType: metadata.contentType,
        etag: metadata.etag,
        sha256: artifact.sha256,
        size: metadata.size,
      });
    } catch (error) {
      if (isBlobNotFoundError(error)) {
        throw new InstallerArtifactNotFoundError("installer Blob was not found");
      }
      throw new InstallerDeliveryError("installer Blob metadata is unavailable", { cause: error });
    }
  }

  const local = await readLocalArtifact(artifact, options.artifactRoot);
  return Object.freeze({
    contentType: artifact.contentType,
    etag: sha256Etag(artifact.sha256),
    lastModified: local.lastModified,
    sha256: artifact.sha256,
    size: local.size,
  });
}

export async function createInstallerDownloadUrl(
  pathname: string,
  options: Readonly<{
    provider?: InstallerProvider;
    nowMs?: number;
    signingSecret?: string;
  }> = {},
) {
  const artifact = findManifestInstallerArtifact(pathname);
  const provider = options.provider || resolveInstallerProvider();
  if (provider === "blob") {
    try {
      const {
        getDownloadUrl,
        issueSignedToken,
        presignUrl,
      } = await import("@vercel/blob");
      const validUntil = (options.nowMs ?? Date.now()) + SIGNED_DOWNLOAD_TTL_SECONDS * 1000;
      const signedToken = await issueSignedToken({
        pathname: artifact.pathname,
        operations: ["get"],
        validUntil,
      });
      const { presignedUrl } = await presignUrl(signedToken, {
        access: "private",
        operation: "get",
        pathname: artifact.pathname,
        validUntil,
      });
      return getDownloadUrl(presignedUrl);
    } catch (error) {
      throw new InstallerDeliveryError("installer Blob signing is unavailable", { cause: error });
    }
  }

  return createHetznerSignedDownloadUrl(artifact.pathname, options);
}

export function createHetznerSignedDownloadUrl(
  pathname: string,
  options: Readonly<{
    nowMs?: number;
    signingSecret?: string;
  }> = {},
) {
  const artifact = findManifestInstallerArtifact(pathname);
  const secret = configuredSigningSecret(options.signingSecret);
  const nowMs = boundedNow(options.nowMs);
  const expires = Math.floor(nowMs / 1000) + SIGNED_DOWNLOAD_TTL_SECONDS;
  const signature = signArtifactPath(artifact.pathname, expires, secret);
  const url = new URL(`${HETZNER_DOWNLOAD_PATH_PREFIX}${artifact.pathname}`, HETZNER_DOWNLOAD_ORIGIN);
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("signature", signature);
  return url.toString();
}

export async function authorizeHetznerInstallerDownload(
  input: Readonly<{
    method?: string;
    rawUrl: string;
    nowMs?: number;
    signingSecret?: string;
    artifactRoot?: string;
  }>,
): Promise<AuthorizedInstallerDownload> {
  const method = String(input.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    throw new InstallerAuthorizationError("unsupported installer method");
  }
  const nowMs = boundedNow(input.nowMs);
  const secret = configuredSigningSecret(input.signingSecret);
  const rawUrl = String(input.rawUrl || "");
  if (!rawUrl || rawUrl.includes("#")) {
    throw new InstallerAuthorizationError("malformed installer URL");
  }
  const rawPath = rawUrl.split("?", 1)[0];
  if (
    !rawPath.startsWith(HETZNER_DOWNLOAD_PATH_PREFIX) ||
    rawPath.includes("%") ||
    rawPath.includes("\\") ||
    rawPath.includes("//")
  ) {
    throw new InstallerAuthorizationError("invalid installer path");
  }
  const pathname = rawPath.slice(HETZNER_DOWNLOAD_PATH_PREFIX.length);
  const artifact = findManifestInstallerArtifact(pathname);
  if (rawPath !== `${HETZNER_DOWNLOAD_PATH_PREFIX}${artifact.pathname}`) {
    throw new InstallerAuthorizationError("installer path is not canonical");
  }

  let url: URL;
  try {
    url = new URL(rawUrl, HETZNER_DOWNLOAD_ORIGIN);
  } catch {
    throw new InstallerAuthorizationError("malformed installer URL");
  }
  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== 2 ||
    url.searchParams.getAll("expires").length !== 1 ||
    url.searchParams.getAll("signature").length !== 1
  ) {
    throw new InstallerAuthorizationError("invalid installer authorization fields");
  }
  const expiresText = url.searchParams.get("expires") || "";
  const suppliedSignature = url.searchParams.get("signature") || "";
  if (!/^[0-9]{10}$/.test(expiresText) || !/^[0-9A-Za-z_-]{43}$/.test(suppliedSignature)) {
    throw new InstallerAuthorizationError("malformed installer authorization");
  }
  const expires = Number(expiresText);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (
    !Number.isSafeInteger(expires) ||
    expires <= nowSeconds ||
    expires > nowSeconds + MAX_SIGNED_DOWNLOAD_LIFETIME_SECONDS
  ) {
    throw new InstallerAuthorizationError("installer authorization expired");
  }
  const expectedSignature = signArtifactPath(artifact.pathname, expires, secret);
  if (!safeEqual(expectedSignature, suppliedSignature)) {
    throw new InstallerAuthorizationError("invalid installer signature");
  }

  const local = await readLocalArtifact(artifact, input.artifactRoot);
  return Object.freeze({
    artifact,
    etag: sha256Etag(artifact.sha256),
    internalPath: `${HETZNER_INTERNAL_PATH_PREFIX}${artifact.pathname}`,
    lastModified: local.lastModified,
  });
}

function signArtifactPath(pathname: string, expires: number, secret: string) {
  return createHmac("sha256", secret)
    .update(`${SIGNATURE_CONTEXT}\n${pathname}\n${expires}`, "utf8")
    .digest("base64url");
}

function safeEqual(expected: string, supplied: string) {
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes);
}

async function readLocalArtifact(
  artifact: InstallerArtifactRecord,
  configuredRoot?: string,
) {
  const root = path.resolve(configuredArtifactRoot(configuredRoot));
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    throw new InstallerDeliveryConfigurationError("installer artifact root is unavailable", {
      cause: error,
    });
  }
  const candidate = path.resolve(canonicalRoot, ...artifact.pathname.split("/"));
  if (!candidate.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new InstallerArtifactNotFoundError("installer artifact path escaped its root");
  }
  try {
    const candidateInfo = await lstat(candidate);
    if (!candidateInfo.isFile() || candidateInfo.isSymbolicLink()) {
      throw new InstallerArtifactMismatchError("installer artifact is not an immutable file");
    }
    const canonicalCandidate = await realpath(candidate);
    if (!canonicalCandidate.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new InstallerArtifactMismatchError("installer artifact resolves outside its root");
    }
    if (candidateInfo.size !== artifact.sizeBytes) {
      throw new InstallerArtifactMismatchError("installer artifact size does not match its manifest");
    }
    return Object.freeze({
      lastModified: candidateInfo.mtime,
      size: candidateInfo.size,
    });
  } catch (error) {
    if (error instanceof InstallerDeliveryError) throw error;
    if (isMissingFileError(error)) {
      throw new InstallerArtifactNotFoundError("installer artifact was not found", { cause: error });
    }
    throw new InstallerDeliveryError("installer artifact metadata is unavailable", { cause: error });
  }
}

function validateArtifactPathname(value: string) {
  const pathname = String(value || "");
  if (
    !pathname ||
    pathname.length > 255 ||
    pathname.startsWith("/") ||
    !pathname.startsWith("sidestream/") ||
    !SAFE_ARTIFACT_PATHNAME.test(pathname) ||
    pathname.includes("//") ||
    pathname.includes("\\") ||
    pathname.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new InstallerArtifactNotFoundError("invalid installer artifact pathname");
  }
  return pathname;
}

function configuredSigningSecret(value?: string) {
  const secret = value ?? process.env[INSTALLER_SIGNING_SECRET_ENV] ?? "";
  const bytes = Buffer.byteLength(secret, "utf8");
  if (bytes < 32 || bytes > 512 || secret.includes("\0")) {
    throw new InstallerDeliveryConfigurationError(
      `${INSTALLER_SIGNING_SECRET_ENV} must contain 32-512 bytes`,
    );
  }
  return secret;
}

function configuredArtifactRoot(value?: string) {
  const root = String(value ?? process.env[INSTALLER_ARTIFACT_ROOT_ENV] ?? DEFAULT_ARTIFACT_ROOT);
  if (!path.isAbsolute(root) || root.includes("\0")) {
    throw new InstallerDeliveryConfigurationError(
      `${INSTALLER_ARTIFACT_ROOT_ENV} must be an absolute path`,
    );
  }
  return root;
}

function boundedNow(value?: number) {
  const nowMs = value ?? Date.now();
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new InstallerDeliveryConfigurationError("invalid signing clock");
  }
  return nowMs;
}

function sha256Etag(sha256: string) {
  return `"sha256-${sha256}"`;
}

function contentTypeForFilename(filename: string) {
  return filename.toLowerCase().endsWith(".dmg")
    ? "application/x-apple-diskimage"
    : "application/vnd.microsoft.portable-executable";
}

function isBlobNotFoundError(error: unknown) {
  return error instanceof Error && error.name === "BlobNotFoundError";
}

function isMissingFileError(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR"),
  );
}

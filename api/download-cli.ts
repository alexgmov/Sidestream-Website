import type { IncomingMessage, ServerResponse } from "node:http";
import registry from "../data/cli-downloads.json" with { type: "json" };

type CliArtifact = Readonly<{
  version: string;
  filename: string;
  pathname: string;
  sizeBytes: number;
  sha256: string;
}>;
type CliRegistry = { schemaVersion: 1; releases: Record<string, CliArtifact> };
type Dependencies = {
  readRegistry: () => unknown;
  headArtifact: (pathname: string) => Promise<{ pathname: string; size: number }>;
  createSignedUrl: (pathname: string) => Promise<string>;
};
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const URL_TTL_MS = 5 * 60 * 1000;

export function parseCliDownloads(value: unknown): CliRegistry {
  if (!value || typeof value !== "object") throw new Error("Invalid CLI registry");
  const candidate = value as CliRegistry;
  if (candidate.schemaVersion !== 1 || !candidate.releases || typeof candidate.releases !== "object" || Array.isArray(candidate.releases)) {
    throw new Error("Invalid CLI registry");
  }
  for (const [release, artifact] of Object.entries(candidate.releases)) {
    if (!SAFE_ID.test(release) || !artifact ||
      !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(artifact.version) ||
      !/^Sidestream-CLI-[A-Za-z0-9._-]+\.tar\.gz$/.test(artifact.filename) ||
      artifact.pathname !== `sidestream/cli/${release}/${artifact.filename}` ||
      !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 1 || artifact.sizeBytes > 1_073_741_824 ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error("Invalid CLI artifact");
    }
  }
  return candidate;
}

export function createCliDownloadHandler(overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = {
    readRegistry: () => registry,
    headArtifact: async (pathname) => {
      const { head } = await import("@vercel/blob");
      return head(pathname);
    },
    createSignedUrl: async (pathname) => {
      const { issueSignedToken, presignUrl, getDownloadUrl } = await import("@vercel/blob");
      const validUntil = Date.now() + URL_TTL_MS;
      const signedToken = await issueSignedToken({ pathname, operations: ["get"], validUntil });
      const { presignedUrl } = await presignUrl(signedToken, {
        access: "private", operation: "get", pathname, validUntil,
      });
      return getDownloadUrl(presignedUrl);
    },
    ...overrides,
  };

  return async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    const method = (request.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      return sendError(response, 405, "Method not allowed");
    }
    let release: string | null;
    try {
      const url = new URL(request.url || "/api/download-cli", "https://sidestream.tv");
      release = url.searchParams.get("release");
      if (!release || !SAFE_ID.test(release) || url.searchParams.size !== 1 || url.searchParams.getAll("release").length !== 1) {
        return sendError(response, 404, "CLI release not found", method === "HEAD");
      }
    } catch {
      return sendError(response, 404, "CLI release not found", method === "HEAD");
    }
    try {
      const releases = parseCliDownloads(dependencies.readRegistry()).releases;
      if (!Object.hasOwn(releases, release)) return sendError(response, 404, "CLI release not found", method === "HEAD");
      const artifact = releases[release];
      if (method === "HEAD") {
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/gzip");
        response.setHeader("Content-Length", String(artifact.sizeBytes));
        response.setHeader("Content-Disposition", `attachment; filename="${artifact.filename}"`);
        response.setHeader("ETag", `"sha256-${artifact.sha256}"`);
        response.setHeader("X-Sidestream-Sha256", artifact.sha256);
        response.setHeader("X-Sidestream-Version", artifact.version);
        response.end();
        return;
      }
      const metadata = await dependencies.headArtifact(artifact.pathname);
      if (metadata.pathname !== artifact.pathname || metadata.size !== artifact.sizeBytes) throw new Error("CLI metadata mismatch");
      const signedUrl = await dependencies.createSignedUrl(artifact.pathname);
      response.statusCode = 302;
      response.setHeader("Location", signedUrl);
      response.end();
    } catch {
      // Never reflect provider errors: they may contain signed URLs or credentials.
      response.setHeader("Retry-After", "60");
      return sendError(response, 503, "CLI download is temporarily unavailable", method === "HEAD");
    }
  };
}

export default createCliDownloadHandler();

function sendError(response: ServerResponse, status: number, message: string, head = false) {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Content-Length", String(Buffer.byteLength(message)));
  response.end(head ? undefined : message);
}

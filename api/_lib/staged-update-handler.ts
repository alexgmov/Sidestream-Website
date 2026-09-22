import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import catalogDefault from "../../data/staged-update-catalog.json" with { type: "json" };
import { artifactPath, hash, openEnvelope, parsePolicy, parseScope, releaseId, renewPolicy, scopeKey } from "./staged-updates.js";
import type { Envelope, Keys, Release, Scope } from "./staged-updates.js";

export type Catalog = { schema: string; keys: Keys; policies: Record<string, Envelope> };
type Dependencies = {
  enabled: () => boolean; catalog: () => Catalog; now: () => number;
  signer: () => { keyId: string; privateKey: string };
  artifactUrl: (release: Release) => Promise<string>;
};
async function blobUrl(release: Release) {
  const { head, issueSignedToken, presignUrl, getDownloadUrl } = await import("@vercel/blob");
  const pathname = artifactPath(release);
  const metadata = await head(pathname);
  if (metadata.size !== release.artifact.sizeBytes) throw new Error("artifact_size");
  const validUntil = Date.now() + 300000;
  const token = await issueSignedToken({ pathname, operations: ["get"], validUntil });
  const { presignedUrl } = await presignUrl(token, { access: "private", operation: "get", pathname, validUntil });
  return getDownloadUrl(presignedUrl);
}
export function createStagedUpdateHandler(mode: "policy" | "artifact", overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = {
    enabled: () => process.env.SIDESTREAM_STAGED_UPDATES_TEST_ENABLED === "1",
    catalog: () => process.env.SIDESTREAM_STAGED_UPDATES_CATALOG
      ? JSON.parse(fs.readFileSync(process.env.SIDESTREAM_STAGED_UPDATES_CATALOG, "utf8")) as Catalog
      : catalogDefault as Catalog,
    now: () => Math.floor(Date.now() / 1000),
    signer: () => ({ keyId: process.env.SIDESTREAM_STAGED_UPDATES_KEY_ID || "", privateKey: process.env.SIDESTREAM_STAGED_UPDATES_PRIVATE_KEY || "" }),
    artifactUrl: blobUrl,
    ...overrides,
  };
  return async function handler(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    const send = (code: number, value: unknown) => { response.statusCode = code; response.end(request.method === "HEAD" ? undefined : JSON.stringify(value)); };
    if (!["GET", "HEAD"].includes(request.method || "GET")) {
      response.setHeader("Allow", "GET, HEAD"); return send(405, { error: "method_not_allowed" });
    }
    if (!dependencies.enabled()) return send(503, { error: "staged_updates_disabled" });
    try {
      const url = new URL(request.url || "/", "https://sidestream.tv");
      const required = ["channel", "platform", "arch", "flavor", ...(mode === "artifact" ? ["releaseId", "sha256"] : [])];
      if ([...url.searchParams.keys()].length !== required.length || required.some(key => url.searchParams.getAll(key).length !== 1)) {
        return send(400, { error: "invalid_scope" });
      }
      const scope: Scope = parseScope(Object.fromEntries(required.slice(0, 4).map(key => [key, url.searchParams.get(key)])));
      // Production has no enabling flag in this implementation.
      if (scope.channel !== "test") return send(404, { error: "channel_unavailable" });
      const catalog = dependencies.catalog();
      if (catalog.schema !== "sidestream.staged-catalog.v1") throw new Error("catalog_schema");
      const envelope = catalog.policies[scopeKey(scope)];
      if (!envelope) return send(404, { error: "policy_unavailable" });
      const { keyId, privateKey } = dependencies.signer();
      const fresh = renewPolicy(envelope, catalog.keys, scope, dependencies.now(), keyId, privateKey);
      if (mode === "policy") return send(200, fresh);
      const { policy, releases } = parsePolicy(openEnvelope(fresh, "policy", catalog.keys), catalog.keys, scope, dependencies.now());
      const id = url.searchParams.get("releaseId"), digest = url.searchParams.get("sha256");
      releaseId(id); hash(digest);
      if (!policy.download || policy.download.releaseId !== id || policy.download.sha256 !== digest || policy.download.percent === 0 ||
          policy.revoked.some(item => item.releaseId === id && item.sha256 === digest)) return send(403, { error: "download_not_authorized" });
      const release = releases.get(id);
      if (!release) throw new Error("release_missing");
      const location = await dependencies.artifactUrl(release);
      const destination = new URL(location);
      if (destination.protocol !== "https:" && !(destination.protocol === "http:" && destination.hostname === "127.0.0.1")) throw new Error("delivery_tls");
      response.setHeader("Location", location); response.statusCode = 307; response.end();
    } catch {
      return send(503, { error: "staged_updates_unavailable" });
    }
  };
}

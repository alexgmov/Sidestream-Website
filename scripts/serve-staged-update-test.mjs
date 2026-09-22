#!/usr/bin/env node
// Local qualification only. Uses the real Website handlers and signer, with
// immutable local artifacts standing in for private Blob delivery.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { compileApiFixture } from "../tests/helpers/compile-api-fixture.mjs";

const flags = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!["--catalog", "--artifacts", "--private-key", "--key-id", "--port"].includes(key) || !process.argv[i + 1] || flags[key]) throw new Error("invalid_argument");
  flags[key] = process.argv[i + 1];
}
for (const key of ["--catalog", "--artifacts", "--private-key", "--key-id"]) if (!flags[key]) throw new Error("missing_" + key);
const port = Number(flags["--port"] || 8894);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("invalid_port");
const privateFile = path.resolve(flags["--private-key"]), info = fs.lstatSync(privateFile);
if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077)) throw new Error("private_key_permissions");
const compiled = path.resolve("node_modules/.tmp/staged-update-local");
compileApiFixture(["api/_lib/staged-update-handler.ts"], compiled);
const { createStagedUpdateHandler } = await import(pathToFileURL(path.join(compiled, "api/_lib/staged-update-handler.js")));
const tokenKey = randomBytes(32), available = new Map();
const signature = (filename, expires) => createHmac("sha256", tokenKey).update(filename + ":" + expires).digest("hex");
const dependencies = {
  enabled: () => true,
  catalog: () => JSON.parse(fs.readFileSync(flags["--catalog"], "utf8")),
  signer: () => ({ keyId: flags["--key-id"], privateKey: fs.readFileSync(privateFile, "utf8") }),
  artifactUrl: async release => {
    const file = path.join(path.resolve(flags["--artifacts"]), release.artifact.filename);
    const metadata = fs.lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size !== release.artifact.sizeBytes) throw new Error("artifact_identity");
    available.set(release.artifact.filename, release.artifact);
    const expires = Math.floor(Date.now() / 1000) + 300;
    return `http://127.0.0.1:${port}/artifact/${release.artifact.filename}?expires=${expires}&signature=${signature(release.artifact.filename, expires)}`;
  },
};
const policy = createStagedUpdateHandler("policy", dependencies), artifact = createStagedUpdateHandler("artifact", dependencies);
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (url.pathname === "/api/releases/staged") return await policy(request, response);
    if (url.pathname === "/api/releases/staged-artifact") return await artifact(request, response);
    const filename = url.pathname.slice("/artifact/".length), item = available.get(filename);
    const expires = Number(url.searchParams.get("expires")), sig = url.searchParams.get("signature") || "";
    if (!["GET", "HEAD"].includes(request.method) || !url.pathname.startsWith("/artifact/") || !item ||
        !Number.isSafeInteger(expires) || expires <= Date.now() / 1000 || expires > Date.now() / 1000 + 300 ||
        !/^[0-9a-f]{64}$/.test(sig) || !timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(signature(filename, expires), "hex"))) {
      response.writeHead(403); return response.end();
    }
    const etag = '"' + item.sha256 + '"';
    let start = 0;
    if (request.headers.range && request.headers["if-range"] === etag) {
      if (!/^bytes=[0-9]+-$/.test(request.headers.range)) { response.writeHead(416); return response.end(); }
      start = Number(request.headers.range.slice(6, -1));
      if (!Number.isSafeInteger(start) || start >= item.sizeBytes) { response.writeHead(416); return response.end(); }
    }
    const headers = { "Content-Length": item.sizeBytes - start, "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "ETag": etag, "Accept-Ranges": "bytes" };
    if (start) headers["Content-Range"] = `bytes ${start}-${item.sizeBytes - 1}/${item.sizeBytes}`;
    response.writeHead(start ? 206 : 200, headers);
    if (request.method === "HEAD") return response.end();
    const stream = fs.createReadStream(path.join(path.resolve(flags["--artifacts"]), filename), { start });
    stream.on("error", () => response.destroy()); response.on("close", () => stream.destroy()); stream.pipe(response);
  } catch { if (!response.headersSent) response.writeHead(503); response.end(); }
});
server.listen(port, "127.0.0.1", () => console.log(`Test policy and artifacts: http://127.0.0.1:${port} (loopback only; Production unavailable)`));

#!/usr/bin/env node
import http from "node:http";
import path from "node:path";
import process from "node:process";
import {
  LauncherAttributionError,
  createRenamedLauncherLedger
} from "../api/_lib/renamed-launcher-attribution.mjs";

const host = "127.0.0.1";
const port = Number(process.env.SIDESTREAM_LAUNCHER_PROOF_PORT || 7791);
const ledgerPath = String(process.env.SIDESTREAM_LAUNCHER_PROOF_LEDGER || "");
const signingSecret = String(process.env.SIDESTREAM_LAUNCHER_PROOF_SIGNING_SECRET || "");
const operatorSecret = String(process.env.SIDESTREAM_LAUNCHER_PROOF_OPERATOR_SECRET || "");
const traceRequests = process.env.SIDESTREAM_LAUNCHER_PROOF_TRACE === "1";

if (process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production") {
  throw new Error("The renamed-launcher proof server is disabled in Production.");
}
if (!path.isAbsolute(ledgerPath)) {
  throw new Error("SIDESTREAM_LAUNCHER_PROOF_LEDGER must be an absolute local path.");
}
if (Buffer.byteLength(operatorSecret, "utf8") < 24) {
  throw new Error("SIDESTREAM_LAUNCHER_PROOF_OPERATOR_SECRET must be at least 24 bytes.");
}

const ledger = createRenamedLauncherLedger({
  filePath: ledgerPath,
  signingSecret
});

function send(response, status, body) {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "X-Content-Type-Options": "nosniff"
  });
  response.end(payload);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024) {
        reject(new LauncherAttributionError("request_too_large", 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new LauncherAttributionError("invalid_json", 400));
      }
    });
    request.on("error", reject);
  });
}

function requireOperator(request) {
  const expected = `Bearer ${operatorSecret}`;
  if (request.headers.authorization !== expected) {
    throw new LauncherAttributionError("unauthorized", 401);
  }
}

const server = http.createServer(async (request, response) => {
  if (traceRequests) {
    console.log(`request ${request.method || "UNKNOWN"} ${request.url || "/"}`);
  }
  try {
    if (request.socket.remoteAddress !== "127.0.0.1" && request.socket.remoteAddress !== "::1") {
      throw new LauncherAttributionError("loopback_only", 403);
    }
    if (request.method === "GET" && request.url === "/health") {
      send(response, 200, { ok: true, environment: "test-local" });
      return;
    }
    if (request.method !== "POST") {
      throw new LauncherAttributionError("method_not_allowed", 405);
    }

    const body = await readJson(request);
    if (request.url === "/api/test/launcher-attribution/issue") {
      requireOperator(request);
      send(response, 201, ledger.issue(body));
      return;
    }
    if (request.url === "/api/test/launcher-attribution/redeem") {
      send(response, 200, ledger.redeem(body));
      return;
    }
    if (request.url === "/api/test/launcher-attribution/installer-complete") {
      send(response, 200, ledger.recordInstallerCompleted(body));
      return;
    }
    if (request.url === "/api/test/launcher-attribution/bind") {
      send(response, 200, ledger.bindFirstPluginOpen(body));
      return;
    }
    if (request.url === "/api/test/launcher-attribution/status") {
      requireOperator(request);
      send(response, 200, ledger.status(body));
      return;
    }

    throw new LauncherAttributionError("not_found", 404);
  } catch (error) {
    const status = error instanceof LauncherAttributionError ? error.status : 500;
    const code = error instanceof LauncherAttributionError ? error.code : "internal_error";
    if (traceRequests) {
      console.log(`response ${status} ${code}`);
    }
    send(response, status, { ok: false, error: code });
  }
});

server.listen(port, host, () => {
  console.log(`Renamed-launcher proof server listening on http://${host}:${port}`);
  console.log(`Ledger: ${ledgerPath}`);
});

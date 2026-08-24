import { timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { queryPostgres } from "../api/_lib/postgres.js";
import {
  authorizeHetznerInstallerDownload,
  InstallerAuthorizationError,
  InstallerDeliveryError,
  resolveInstallerProvider,
} from "../api/_lib/installer-delivery.js";

type ApiResponse = ServerResponse & {
  status: (statusCode: number) => ApiResponse;
  json: (payload: unknown) => void;
  send: (payload: unknown) => void;
};
type ApiHandler = (request: IncomingMessage, response: ApiResponse) => unknown;
type Route = Readonly<{ pattern: RegExp; handler: ApiHandler }>;

const host = configuredHost(process.env.HOST);
const port = boundedPort(process.env.PORT);
const originSecret = configuredOriginSecret(process.env.SIDESTREAM_ORIGIN_AUTH_SECRET);
const deployedSha = configuredSha(process.env.SIDESTREAM_DEPLOYED_SHA);
const installerProvider = resolveInstallerProvider();
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../api");
const routes = await loadRoutes(apiRoot);

const server = createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  const rawPath = String(request.url || "/").split("?", 1)[0];
  const pathname = new URL(request.url || "/", "http://internal.invalid").pathname;

  if (pathname === "/healthz") {
    return serveHealth(request, response);
  }
  if (rawPath.startsWith("/v1/")) {
    return serveSignedInstaller(request, response);
  }
  if (!pathname.startsWith("/api/")) {
    return sendJson(response, 404, { error: "Not found" });
  }
  if (!authorizedOriginRequest(request, originSecret)) {
    return sendJson(response, 404, { error: "Not found" });
  }

  const route = routes.find((candidate) => candidate.pattern.test(pathname));
  if (!route) return sendJson(response, 404, { error: "API route not found" });
  attachResponseHelpers(response);
  try {
    await route.handler(request, response as ApiResponse);
    if (!response.writableEnded && !response.headersSent) {
      sendJson(response, 500, { error: "API handler returned without a response" });
    }
  } catch (error) {
    console.error("Sidestream API handler failed", safeErrorCode(error));
    if (!response.writableEnded) {
      if (!response.headersSent) sendJson(response, 500, { error: "API request failed" });
      else response.end();
    }
  }
});

server.requestTimeout = 70_000;
server.headersTimeout = 75_000;
server.keepAliveTimeout = 5_000;
server.listen(port, host, () => {
  console.log(`Sidestream Website API listening on ${host}:${port} at ${deployedSha || "unknown-sha"}`);
});

async function serveHealth(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return sendJson(response, 405, { error: "Method not allowed" });
  }
  try {
    await queryPostgres("select 1");
    return sendJson(response, 200, {
      ok: true,
      service: "sidestream-website-api",
      database: "reachable",
      deployedSha,
      installerProvider,
    }, request.method === "HEAD");
  } catch (error) {
    console.error("Sidestream health check failed", safeErrorCode(error));
    return sendJson(response, 503, {
      ok: false,
      service: "sidestream-website-api",
      database: "unreachable",
      deployedSha,
      installerProvider,
    }, request.method === "HEAD");
  }
}

async function serveSignedInstaller(
  request: IncomingMessage,
  response: ServerResponse,
) {
  const method = String(request.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return sendJson(response, 405, { error: "Method not allowed" });
  }
  try {
    const authorization = await authorizeHetznerInstallerDownload({
      method,
      rawUrl: request.url || "",
    });
    response.statusCode = 200;
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${authorization.artifact.filename}"`,
    );
    response.setHeader("Content-Type", authorization.artifact.contentType);
    response.setHeader("ETag", authorization.etag);
    response.setHeader("Last-Modified", authorization.lastModified.toUTCString());
    response.setHeader("X-Accel-Redirect", authorization.internalPath);
    response.setHeader("X-Accel-Expires", "0");
    response.end();
  } catch (error) {
    if (
      error instanceof InstallerAuthorizationError ||
      error instanceof InstallerDeliveryError
    ) {
      return sendJson(response, 404, { error: "Not found" });
    }
    console.error("Sidestream installer authorization failed", safeErrorCode(error));
    return sendJson(response, 503, { error: "Installer unavailable" });
  }
}

async function loadRoutes(root: string) {
  if (!existsSync(root)) throw new Error(`Compiled API directory is missing: ${root}`);
  const files = recursiveFiles(root).filter((file) => file.endsWith(".js"));
  const loaded: Route[] = [];
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (relative.startsWith("_lib/") || relative === "acquisition/_lib.js") continue;
    const module = await import(pathToFileURL(file).href);
    if (typeof module.default !== "function") continue;
    loaded.push(Object.freeze({
      pattern: routePattern(relative),
      handler: module.default as ApiHandler,
    }));
  }
  return Object.freeze(loaded);
}

function recursiveFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? recursiveFiles(target) : [target];
  });
}

function routePattern(relativeFile: string) {
  let route = relativeFile.replace(/\.js$/, "").replace(/\/index$/, "");
  route = route.split("/").map((segment) => {
    if (/^\[[A-Za-z][A-Za-z0-9_]*\]$/.test(segment)) return "[^/]+";
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("/");
  return new RegExp(`^/api/${route}/?$`);
}

function attachResponseHelpers(response: ServerResponse) {
  const apiResponse = response as ApiResponse;
  apiResponse.status = (statusCode: number) => {
    apiResponse.statusCode = statusCode;
    return apiResponse;
  };
  apiResponse.json = (payload: unknown) => sendJson(
    apiResponse,
    apiResponse.statusCode || 200,
    payload,
  );
  apiResponse.send = (payload: unknown) => {
    if (Buffer.isBuffer(payload) || typeof payload === "string") return apiResponse.end(payload);
    return sendJson(apiResponse, apiResponse.statusCode || 200, payload);
  };
}

function authorizedOriginRequest(request: IncomingMessage, secret: string) {
  const supplied = firstHeader(request.headers["x-sidestream-origin-auth"]);
  if (!supplied || supplied.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(secret));
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : String(value || "").split(",", 1)[0].trim();
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  headOnly = false,
) {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(headOnly ? undefined : body);
}

function configuredOriginSecret(value: string | undefined) {
  const secret = value?.trim() || "";
  if (secret.length < 32 || secret.length > 512 || !/^[\x21-\x7e]+$/.test(secret)) {
    throw new Error("SIDESTREAM_ORIGIN_AUTH_SECRET must be 32-512 printable non-space ASCII characters");
  }
  return secret;
}

function configuredHost(value: string | undefined) {
  const candidate = value?.trim() || "127.0.0.1";
  if (candidate !== "127.0.0.1" && candidate !== "::1") {
    throw new Error("The Website API may listen only on loopback");
  }
  return candidate;
}

function boundedPort(value: string | undefined) {
  const parsed = Number(value || 3101);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65_535) {
    throw new Error("PORT must be an integer from 1024 to 65535");
  }
  return parsed;
}

function configuredSha(value: string | undefined) {
  const candidate = value?.trim().toLowerCase() || "";
  return /^[0-9a-f]{40}$/.test(candidate) ? candidate : "";
}

function safeErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return "runtime_error";
  const code = "code" in error ? String(error.code || "") : "";
  if (/^[A-Za-z0-9_]{1,32}$/.test(code)) return code;
  const name = "name" in error ? String(error.name || "") : "";
  return /^[A-Za-z0-9_]{1,32}$/.test(name) ? name : "runtime_error";
}

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));

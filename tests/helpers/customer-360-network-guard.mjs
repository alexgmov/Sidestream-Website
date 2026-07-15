import http from "node:http";
import https from "node:https";
import net from "node:net";
import { requireSafeTestDatabaseUrl } from "../../scripts/run-postgres-integration.mjs";

const connectionString = requireSafeTestDatabaseUrl(process.env);
const postgresUrl = new URL(connectionString);
const allowedHost = postgresUrl.hostname.toLowerCase();
const allowedPort = Number(postgresUrl.port || 5432);
const originalSocketConnect = net.Socket.prototype.connect;

function blocked(kind, target) {
  throw new Error(
    `${kind} is forbidden in the Customer 360 Postgres harness: ${String(target)}`,
  );
}

function connectTarget(arguments_) {
  const first = arguments_[0];
  if (typeof first === "number") {
    return { port: first, host: String(arguments_[1] || "localhost").toLowerCase() };
  }
  if (typeof first === "string") return { path: first };
  if (first && typeof first === "object") {
    if (first.path) return { path: first.path };
    return {
      port: Number(first.port),
      host: String(first.host || first.hostname || "localhost").toLowerCase(),
    };
  }
  return {};
}

net.Socket.prototype.connect = function guardedConnect(...arguments_) {
  const target = connectTarget(arguments_);
  if (target.path || target.host !== allowedHost || target.port !== allowedPort) {
    blocked("External TCP network access", target.path || `${target.host}:${target.port}`);
  }
  return originalSocketConnect.apply(this, arguments_);
};

for (const [module, protocol] of [[http, "HTTP"], [https, "HTTPS"]]) {
  module.request = (...arguments_) => blocked(`${protocol} request`, arguments_[0]);
  module.get = (...arguments_) => blocked(`${protocol} GET`, arguments_[0]);
}

globalThis.fetch = async (input) => blocked("fetch", input);
globalThis.WebSocket = class BlockedWebSocket {
  constructor(url) {
    blocked("WebSocket", url);
  }
};
globalThis.__SIDESTREAM_CUSTOMER_360_NETWORK_GUARD__ = Object.freeze({
  allowedProtocol: "postgres",
  allowedHost,
  allowedPort,
  stripe: "blocked",
  vercel: "blocked",
});

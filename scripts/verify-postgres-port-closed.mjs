#!/usr/bin/env node

import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

export class PostgresPortBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = "PostgresPortBoundaryError";
  }
}

export function parsePortBoundaryArguments(argv) {
  const options = { host: "", port: 5432, timeoutMs: 3_000, help: false };
  const valueOptions = new Set(["--host", "--port", "--timeout-ms"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    const name = [...valueOptions].find(
      (candidate) => argument === candidate || argument.startsWith(`${candidate}=`),
    );
    if (!name) throw new PostgresPortBoundaryError(`Unknown port-boundary option: ${argument}`);
    const inline = argument.startsWith(`${name}=`);
    const value = inline ? argument.slice(name.length + 1) : argv[index + 1];
    if (!value || (!inline && value.startsWith("--"))) {
      throw new PostgresPortBoundaryError(`${name} requires a value.`);
    }
    if (!inline) index += 1;
    if (name === "--host") options.host = value;
    if (name === "--port") options.port = boundedInteger(value, name, 1, 65_535);
    if (name === "--timeout-ms") options.timeoutMs = boundedInteger(value, name, 250, 30_000);
  }
  if (!options.help) validatePublicHost(options.host);
  return Object.freeze(options);
}

export function classifyPortProbeOutcome(outcome) {
  if (outcome === "connected") {
    return Object.freeze({ safe: false, outcome: "open" });
  }
  if (["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "timeout"].includes(outcome)) {
    return Object.freeze({ safe: true, outcome: "not-reachable" });
  }
  throw new PostgresPortBoundaryError(
    "The public PostgreSQL port probe was inconclusive; do not treat it as closed.",
  );
}

export async function probePublicPostgresPort({
  host,
  port = 5432,
  timeoutMs = 3_000,
  createConnection = net.createConnection,
}) {
  validatePublicHost(host);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      try {
        resolve(classifyPortProbeOutcome(outcome));
      } catch (error) {
        reject(error);
      }
    };
    const socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish("connected"));
    socket.once("timeout", () => finish("timeout"));
    socket.once("error", (error) => finish(String(error?.code || "unknown")));
  });
}

function validatePublicHost(host) {
  const value = String(host || "").trim();
  if (!value || /[\s/]/.test(value) || value.includes("://")) {
    throw new PostgresPortBoundaryError("--host must be one public hostname or IP address.");
  }
  if (["localhost", "127.0.0.1", "::1"].includes(value.toLowerCase())) {
    throw new PostgresPortBoundaryError(
      "The port-boundary probe must run against the server's public hostname or IP.",
    );
  }
}

function boundedInteger(value, name, minimum, maximum) {
  if (!/^\d+$/.test(String(value))) {
    throw new PostgresPortBoundaryError(`${name} must be an integer.`);
  }
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    throw new PostgresPortBoundaryError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

async function main() {
  const options = parsePortBoundaryArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run verify:database-port-closed -- --host <public-host-or-ip> [--port 5432]");
    return;
  }
  const result = await probePublicPostgresPort(options);
  if (!result.safe) {
    throw new PostgresPortBoundaryError(
      `FAIL: PostgreSQL port ${options.port} accepted a public TCP connection.`,
    );
  }
  console.log(
    `PASS: PostgreSQL port ${options.port} was not reachable from this external probe.`,
  );
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error(error instanceof PostgresPortBoundaryError
      ? error.message
      : "The public PostgreSQL port probe failed inconclusively.");
    process.exitCode = 1;
  });
}

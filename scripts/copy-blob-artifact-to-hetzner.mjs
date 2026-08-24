#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RUNTIME_PATH = "/etc/sidestream/website-runtime.json";
const ARTIFACT_ROOT = "/srv/sidestream/artifacts";
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}
if (typeof process.getuid === "function" && process.getuid() !== 0) {
  fail("Blob-to-Hetzner copying must run as root.");
}

const pathname = normalizeArtifactPath(required(args.pathname, "--pathname"));
const expectedSize = normalizeSize(required(args.size, "--size"));
const expectedSha256 = normalizeSha256(required(args.sha256, "--sha256"));
const runtime = readProtectedRuntime();
const token = runtime.BLOB_READ_WRITE_TOKEN;
if (typeof token !== "string" || token.length < 20) fail("Blob token is unavailable.");

const incomingDirectory = path.join(ARTIFACT_ROOT, ".incoming");
fs.mkdirSync(incomingDirectory, { recursive: true, mode: 0o700 });
fs.chmodSync(incomingDirectory, 0o700);
const temporaryPath = path.join(
  incomingDirectory,
  `${Date.now()}-${process.pid}-${path.basename(pathname)}`,
);

try {
  const { get } = await import("@vercel/blob");
  const result = await get(pathname, { access: "private", token, useCache: false });
  if (!result || result.statusCode !== 200) fail(`Blob artifact was not found: ${pathname}`);
  if (result.blob.pathname !== pathname || result.blob.size !== expectedSize) {
    fail(`Blob metadata mismatch: ${pathname}`);
  }
  await pipeline(
    Readable.fromWeb(result.stream),
    fs.createWriteStream(temporaryPath, { flags: "wx", mode: 0o400 }),
  );
  const finalized = spawnSync(process.execPath, [
    path.join(SCRIPT_DIRECTORY, "finalize-hetzner-artifact.mjs"),
    "--source", temporaryPath,
    "--pathname", pathname,
    "--size", String(expectedSize),
    "--sha256", expectedSha256,
  ], { stdio: "inherit" });
  if (finalized.error) throw finalized.error;
  if (finalized.status !== 0) fail(`Artifact finalization exited with status ${finalized.status}.`);
} finally {
  fs.rmSync(temporaryPath, { force: true });
}

process.stdout.write(`Copied and verified Blob artifact on Hetzner: ${pathname}\n`);

function readProtectedRuntime() {
  const info = fs.lstatSync(RUNTIME_PATH);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    fail(`${RUNTIME_PATH} must be a regular root-only file with mode 0600.`);
  }
  return JSON.parse(fs.readFileSync(RUNTIME_PATH, "utf8"));
}

function normalizeArtifactPath(value) {
  const pathname = String(value || "");
  if (
    pathname.length < 1 || pathname.length > 255 ||
    !pathname.startsWith("sidestream/") ||
    !/^[0-9A-Za-z][0-9A-Za-z._+/-]*$/.test(pathname) ||
    pathname.includes("//") ||
    pathname.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) fail(`Invalid artifact pathname: ${value}`);
  return pathname;
}

function normalizeSize(value) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1 || size > 1_073_741_824) fail("Invalid size.");
  return size;
}

function normalizeSha256(value) {
  const sha256 = String(value || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail("Invalid sha256.");
  return sha256;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) parsed[token.slice(2)] = true;
    else {
      parsed[token.slice(2)] = next;
      index += 1;
    }
  }
  return parsed;
}

function required(value, flag) {
  const text = String(value || "").trim();
  if (!text) fail(`Missing ${flag}.`);
  return text;
}

function fail(message) {
  throw new Error(message);
}

function printUsage() {
  process.stdout.write("node scripts/copy-blob-artifact-to-hetzner.mjs --pathname sidestream/version/file --size BYTES --sha256 HEX\n");
}

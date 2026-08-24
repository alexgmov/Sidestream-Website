#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const RUNTIME_PATH = "/etc/sidestream/website-runtime.json";
const ARTIFACT_ROOT = "/srv/sidestream/artifacts";
const SERVICE = "sidestream-website.service";
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await main();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printUsage();
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    fail("Provider changes must run as root.");
  }
  const provider = normalizeProvider(required(args.provider, "--provider"));
  const runtime = readProtectedRuntime();
  const currentProvider = normalizeProvider(runtime.SIDESTREAM_INSTALLER_PROVIDER || "blob");
  const artifacts = readSelectedArtifacts();

  if (provider === "hetzner") {
    validateSigningConfiguration(runtime);
    for (const artifact of artifacts) await verifyLocalArtifact(artifact);
  } else {
    await verifyBlobArtifacts(artifacts, runtime.BLOB_READ_WRITE_TOKEN);
  }
  process.stdout.write(`Validated ${artifacts.length} active artifacts for provider=${provider}.\n`);

  if (args["apply-provider"] !== provider) {
    process.stdout.write(`Dry run only. Current provider=${currentProvider}; requested provider=${provider}.\n`);
    process.stdout.write(`To apply, repeat with --apply-provider=${provider}.\n`);
    return;
  }
  if (currentProvider === provider) {
    process.stdout.write(`Provider is already ${provider}; no runtime change made.\n`);
    return;
  }

  const backupDirectory = "/etc/sidestream/backups";
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDirectory, 0o700);
  const backupPath = path.join(
    backupDirectory,
    `website-runtime.${new Date().toISOString().replace(/[:.]/g, "-")}.${currentProvider}.json`,
  );
  fs.copyFileSync(RUNTIME_PATH, backupPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backupPath, 0o600);

  runtime.SIDESTREAM_INSTALLER_PROVIDER = provider;
  runtime.SIDESTREAM_ARTIFACT_ROOT = runtime.SIDESTREAM_ARTIFACT_ROOT || ARTIFACT_ROOT;
  const temporaryPath = `${RUNTIME_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(runtime, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fs.chownSync(temporaryPath, 0, 0);
  fs.renameSync(temporaryPath, RUNTIME_PATH);

  run("systemctl", ["restart", SERVICE]);
  run("systemctl", ["is-active", "--quiet", SERVICE]);
  const health = await fetchHealth();
  if (health.installerProvider !== provider || health.ok !== true) {
    fail(`Service health did not confirm provider=${provider}. Roll back with the documented Blob command.`);
  }
  process.stdout.write(`Applied provider=${provider}; health confirmed sha=${health.deployedSha || "unknown"}.\n`);
  process.stdout.write(`Protected rollback snapshot: ${backupPath}\n`);
}

function readProtectedRuntime() {
  const info = fs.lstatSync(RUNTIME_PATH);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    fail(`${RUNTIME_PATH} must be a regular root-only file with mode 0600.`);
  }
  const runtime = JSON.parse(fs.readFileSync(RUNTIME_PATH, "utf8"));
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) fail("Runtime JSON is invalid.");
  return runtime;
}

function readSelectedArtifacts() {
  const dataDirectory = path.join(REPOSITORY_ROOT, "data");
  const manifests = [
    JSON.parse(fs.readFileSync(path.join(dataDirectory, "release-manifest.json"), "utf8")),
    JSON.parse(fs.readFileSync(path.join(dataDirectory, "release-manifest.windows.json"), "utf8")),
    JSON.parse(fs.readFileSync(path.join(dataDirectory, "release-manifest.paid.json"), "utf8")),
    JSON.parse(fs.readFileSync(path.join(dataDirectory, "release-manifest.paid.windows.json"), "utf8")),
  ];
  return manifests.map((manifest) => {
    const pathname = manifest.artifact?.pathname || manifest.artifactPathname;
    const sha256 = manifest.artifact?.sha256 || manifest.sha256;
    const size = manifest.artifact?.sizeBytes || manifest.sizeBytes;
    return {
      pathname: normalizeArtifactPath(pathname),
      sha256: normalizeSha256(sha256),
      size: normalizeSize(size),
    };
  });
}

async function verifyLocalArtifact(artifact) {
  const filePath = path.resolve(ARTIFACT_ROOT, ...artifact.pathname.split("/"));
  if (!filePath.startsWith(`${ARTIFACT_ROOT}${path.sep}`)) fail("Artifact escaped its root.");
  const info = fs.lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink()) fail(`Unsafe artifact: ${artifact.pathname}`);
  if (info.size !== artifact.size) fail(`Size mismatch: ${artifact.pathname}`);
  const sha256 = await hashFile(filePath);
  if (sha256 !== artifact.sha256) fail(`sha256 mismatch: ${artifact.pathname}`);
}

async function verifyBlobArtifacts(artifacts, token) {
  if (typeof token !== "string" || token.length < 20) fail("Blob rollback token is unavailable.");
  const { get } = await import("@vercel/blob");
  for (const artifact of artifacts) {
    const result = await get(artifact.pathname, {
      access: "private",
      token,
      useCache: false,
    });
    if (
      !result ||
      result.statusCode !== 200 ||
      result.blob.pathname !== artifact.pathname ||
      result.blob.size !== artifact.size
    ) {
      fail(`Blob rollback artifact mismatch: ${artifact.pathname}`);
    }
    const hash = crypto.createHash("sha256");
    for await (const chunk of Readable.fromWeb(result.stream)) hash.update(chunk);
    if (hash.digest("hex") !== artifact.sha256) {
      fail(`Blob rollback artifact sha256 mismatch: ${artifact.pathname}`);
    }
  }
}

function validateSigningConfiguration(runtime) {
  const secret = runtime.SIDESTREAM_DOWNLOAD_SIGNING_SECRET;
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    fail("SIDESTREAM_DOWNLOAD_SIGNING_SECRET is missing or too short.");
  }
  const root = runtime.SIDESTREAM_ARTIFACT_ROOT || ARTIFACT_ROOT;
  if (root !== ARTIFACT_ROOT) fail(`SIDESTREAM_ARTIFACT_ROOT must be ${ARTIFACT_ROOT}.`);
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function fetchHealth() {
  const response = await fetch("http://127.0.0.1:3101/healthz", {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) fail(`Local health check returned HTTP ${response.status}.`);
  return response.json();
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} exited with status ${result.status}.`);
}

function normalizeProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (provider !== "blob" && provider !== "hetzner") fail("Provider must be blob or hetzner.");
  return provider;
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

function normalizeSha256(value) {
  const sha256 = String(value || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail("Invalid artifact sha256.");
  return sha256;
}

function normalizeSize(value) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1 || size > 1_073_741_824) fail("Invalid artifact size.");
  return size;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const [name, inline] = token.slice(2).split("=", 2);
    if (inline !== undefined) parsed[name] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      parsed[name] = argv[index + 1];
      index += 1;
    } else parsed[name] = true;
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
  process.stdout.write([
    "Dry-run validation:",
    "  node scripts/set-installer-provider.mjs --provider hetzner",
    "",
    "Apply after the dry run passes:",
    "  node scripts/set-installer-provider.mjs --provider hetzner --apply-provider=hetzner",
    "",
    "Rollback:",
    "  node scripts/set-installer-provider.mjs --provider blob --apply-provider=blob",
    "",
  ].join("\n"));
}

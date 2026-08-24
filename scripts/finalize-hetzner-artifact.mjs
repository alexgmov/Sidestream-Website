#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_ROOT = "/srv/sidestream/artifacts";

await main();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printUsage();
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    fail("Artifact finalization must run as root.");
  }

  const root = configuredRoot(args.root || process.env.SIDESTREAM_ARTIFACT_ROOT);
  const pathname = normalizeArtifactPath(required(args.pathname, "--pathname"));
  const expectedSha256 = normalizeSha256(required(args.sha256, "--sha256"));
  const expectedSize = normalizeSize(required(args.size, "--size"));
  const target = resolveInside(root, pathname);

  if (args["verify-only"] === true) {
    await verifyArtifact(target, expectedSize, expectedSha256);
    process.stdout.write(`Verified immutable Hetzner artifact: ${pathname}\n`);
    return;
  }

  const source = path.resolve(required(args.source, "--source"));
  const incomingRoot = path.join(root, ".incoming");
  if (!source.startsWith(`${incomingRoot}${path.sep}`)) {
    fail(`--source must be inside ${incomingRoot}`);
  }
  await verifyArtifact(source, expectedSize, expectedSha256);
  ensureDestinationDirectories(root, path.dirname(target));

  if (fs.existsSync(target)) {
    try {
      await verifyArtifact(target, expectedSize, expectedSha256);
    } catch {
      fail(`Refusing to replace an immutable artifact with different bytes: ${pathname}`);
    }
    fs.rmSync(source);
    process.stdout.write(`Artifact already finalized with identical bytes: ${pathname}\n`);
    return;
  }

  fs.chmodSync(source, 0o400);
  fs.chownSync(source, 0, 0);
  fs.renameSync(source, target);
  fs.chmodSync(target, 0o444);
  fs.chownSync(target, 0, 0);
  await verifyArtifact(target, expectedSize, expectedSha256);
  process.stdout.write(`Finalized immutable Hetzner artifact: ${pathname}\n`);
}

async function verifyArtifact(filePath, expectedSize, expectedSha256) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`Artifact does not exist: ${filePath}`);
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) fail(`Artifact is not a regular file: ${filePath}`);
  if (stats.size !== expectedSize) {
    fail(`Artifact size mismatch for ${filePath}: expected ${expectedSize}, got ${stats.size}`);
  }
  const actualSha256 = await hashFile(filePath);
  if (actualSha256 !== expectedSha256) {
    fail(`Artifact sha256 mismatch for ${filePath}: expected ${expectedSha256}, got ${actualSha256}`);
  }
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

function ensureDestinationDirectories(root, destinationDirectory) {
  const relative = path.relative(root, destinationDirectory);
  let current = root;
  fs.mkdirSync(root, { recursive: true, mode: 0o555 });
  fs.chownSync(root, 0, 0);
  fs.chmodSync(root, 0o555);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current)) {
      const info = fs.lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink()) fail(`Unsafe artifact directory: ${current}`);
    } else {
      fs.mkdirSync(current, { mode: 0o555 });
    }
    fs.chownSync(current, 0, 0);
    fs.chmodSync(current, 0o555);
  }
}

function configuredRoot(value) {
  const configured = String(value || DEFAULT_ROOT);
  if (!path.isAbsolute(configured) || configured.includes("\0")) fail("Invalid artifact root.");
  const root = path.resolve(configured);
  if (root === "/") fail("Invalid artifact root.");
  return root;
}

function resolveInside(root, pathname) {
  const target = path.resolve(root, ...pathname.split("/"));
  if (!target.startsWith(`${root}${path.sep}`)) fail("Artifact pathname escaped its root.");
  return target;
}

function normalizeArtifactPath(value) {
  const pathname = String(value || "");
  if (
    pathname.length < 1 ||
    pathname.length > 255 ||
    !pathname.startsWith("sidestream/") ||
    !/^[0-9A-Za-z][0-9A-Za-z._+/-]*$/.test(pathname) ||
    pathname.includes("//") ||
    pathname.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) fail(`Invalid artifact pathname: ${value}`);
  return pathname;
}

function normalizeSha256(value) {
  const sha256 = String(value || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail("--sha256 must be 64 lowercase hex characters.");
  return sha256;
}

function normalizeSize(value) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1 || size > 1_073_741_824) {
    fail("--size must be an integer from 1 byte through 1 GiB.");
  }
  return size;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) parsed[name] = true;
    else {
      parsed[name] = next;
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
  process.stdout.write([
    "Finalize an already-uploaded installer:",
    "  node scripts/finalize-hetzner-artifact.mjs --source /srv/sidestream/artifacts/.incoming/upload --pathname sidestream/1.2.3/file.dmg --size 123 --sha256 HEX",
    "",
    "Verify a finalized installer:",
    "  node scripts/finalize-hetzner-artifact.mjs --verify-only --pathname sidestream/1.2.3/file.dmg --size 123 --sha256 HEX",
    "",
  ].join("\n"));
}

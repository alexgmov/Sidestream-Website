#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printUsage();
  process.exit(0);
}

const artifactPath = path.resolve(required(args.artifact, "--artifact"));
const pathname = normalizeArtifactPath(required(args.pathname, "--pathname"));
const sshTarget = normalizeSshTarget(
  args.target || process.env.SIDESTREAM_ARTIFACT_SSH_TARGET || "root@2.29.9.121",
);
const sshKey = path.resolve(
  args.identity || process.env.SIDESTREAM_ARTIFACT_SSH_KEY ||
    path.join(process.env.HOME || "", ".ssh", "sidestream_hetzner_ed25519"),
);
if (!fs.statSync(artifactPath).isFile()) fail(`Artifact is not a file: ${artifactPath}`);
if (!fs.existsSync(sshKey)) fail(`SSH identity does not exist: ${sshKey}`);

const size = fs.statSync(artifactPath).size;
const sha256 = hashFile(artifactPath);
const incomingName = `${Date.now()}-${process.pid}-${path.basename(pathname)}`;
const remoteSource = `/srv/sidestream/artifacts/.incoming/${incomingName}`;
const remoteFinalizer = "/srv/sidestream/website-backend/scripts/finalize-hetzner-artifact.mjs";
const sshArgs = ["-i", sshKey, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"];

run("ssh", [...sshArgs, sshTarget, "install", "-d", "-o", "root", "-g", "root", "-m", "700", "/srv/sidestream/artifacts/.incoming"]);
run("scp", [...sshArgs, artifactPath, `${sshTarget}:${remoteSource}`]);
try {
  run("ssh", [
    ...sshArgs,
    sshTarget,
    "node",
    remoteFinalizer,
    "--source",
    remoteSource,
    "--pathname",
    pathname,
    "--size",
    String(size),
    "--sha256",
    sha256,
  ]);
} catch (error) {
  run("ssh", [...sshArgs, sshTarget, "rm", "-f", remoteSource], true);
  throw error;
}

process.stdout.write(`Uploaded and verified ${pathname}\n`);
process.stdout.write(`size=${size} sha256=${sha256}\n`);

function run(command, commandArgs, ignoreFailure = false) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0 && !ignoreFailure) {
    fail(`${command} exited with status ${result.status}`);
  }
}

function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
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

function normalizeSshTarget(value) {
  const target = String(value || "").trim();
  if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$/.test(target)) fail("Invalid SSH target.");
  return target;
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
  process.stdout.write("node scripts/upload-hetzner-artifact.mjs --artifact /path/to/installer --pathname sidestream/1.2.3/installer.dmg [--target root@host] [--identity /path/to/key]\n");
}

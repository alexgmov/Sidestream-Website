#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, "..");
const MANIFEST_PATHS = {
  macos: process.env.SIDESTREAM_RELEASE_MANIFEST_PATH ||
    path.join(ROOT_DIR, "data", "release-manifest.json"),
  windows: process.env.SIDESTREAM_WINDOWS_RELEASE_MANIFEST_PATH ||
    path.join(ROOT_DIR, "data", "release-manifest.windows.json"),
};
const PLATFORM_DEFAULTS = {
  macos: {
    artifactType: "dmg",
    artifactUrl: "https://sidestream.tv/api/download",
    releaseNotesUrl: "https://sidestream.tv/",
  },
  windows: {
    artifactType: "exe",
    artifactUrl: "https://sidestream.tv/api/download?platform=win32-x64",
    releaseNotesUrl: "https://sidestream.tv/api/download?platform=win32-x64",
  },
};
const REQUIRED_GATES = ["verified", "uploaded", "smoke-tested"];

main();

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  const platform = normalizePlatform(args.platform || "macos");
  const platformDefaults = PLATFORM_DEFAULTS[platform];
  const missingGates = REQUIRED_GATES.filter((name) => args[name] !== true);
  if (missingGates.length) {
    fail(`Refusing to publish. Missing release gates: ${missingGates.join(", ")}`);
  }

  if (platform === "macos" && args.signed !== true) {
    fail("Refusing to publish the Mac release without --signed.");
  }

  if (platform === "windows" && args.signed !== true && args["unsigned-beta-approved"] !== true) {
    fail("Refusing to publish the Windows beta without --signed or --unsigned-beta-approved.");
  }

  const artifactPath = required(args.artifact, "--artifact");
  const artifactUrl = args["artifact-url"] || platformDefaults.artifactUrl;
  const pathname = normalizeBlobPath(required(args.pathname, "--pathname"));
  const version = normalizeVersion(required(args.version, "--version"));
  const minSupportedVersion = normalizeVersion(args["min-supported-version"] || "1.0.0");
  const channel = sanitizeLabel(args.channel || "stable");
  const rolloutPercent = normalizeRolloutPercent(args["rollout-percent"] || 100);
  const releaseNotesUrl = args["release-notes-url"] || platformDefaults.releaseNotesUrl;
  const publishedAt = args["published-at"] || new Date().toISOString();
  const artifactType = sanitizeLabel(args["artifact-type"] || platformDefaults.artifactType);
  const critical = parseBoolean(args.critical);
  const manifestPath = MANIFEST_PATHS[platform];

  if (channel !== "stable") fail("Only the stable Sidestream release channel is supported right now.");
  if (!isSemver(version)) fail(`Invalid --version "${version}". Use x.y.z semver.`);
  if (!isSemver(minSupportedVersion)) fail(`Invalid --min-supported-version "${minSupportedVersion}".`);
  if (!isSidestreamUrl(artifactUrl)) fail("--artifact-url must use https://sidestream.tv.");
  if (!isSidestreamUrl(releaseNotesUrl)) fail("--release-notes-url must use https://sidestream.tv.");
  if (!fs.existsSync(artifactPath)) fail(`Artifact not found: ${artifactPath}`);

  const stats = fs.statSync(artifactPath);
  if (!stats.isFile() || stats.size <= 0) fail(`Artifact is not a readable file: ${artifactPath}`);

  const manifest = {
    schemaVersion: 1,
    product: "sidestream",
    channel,
    version,
    minSupportedVersion,
    critical,
    rolloutPercent,
    publishedAt,
    releaseNotesUrl,
    artifact: {
      type: artifactType,
      url: artifactUrl,
      pathname,
      sha256: hashFile(artifactPath),
      sizeBytes: stats.size,
    },
  };

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Published Sidestream ${version} ${channel} ${platform} manifest to ${manifestPath}`);
  console.log(`Artifact URL: ${manifest.artifact.url}`);
  console.log(`Blob pathname: ${manifest.artifact.pathname}`);
  console.log(`Artifact sha256: ${manifest.artifact.sha256}`);
  console.log(`Artifact size: ${manifest.artifact.sizeBytes}`);
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;

    const name = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[name] = true;
      continue;
    }

    parsed[name] = next;
    index += 1;
  }

  return parsed;
}

function required(value, flag) {
  const text = String(value || "").trim();
  if (!text) fail(`Missing ${flag}.`);
  return text;
}

function normalizeVersion(value) {
  return String(value || "").trim().replace(/^v/i, "");
}

function normalizePlatform(value) {
  const platform = sanitizeLabel(value);

  if (["macos", "darwin-arm64", "darwin-x64", "macos-arm64", "macos-x64"].includes(platform)) {
    return "macos";
  }

  if (["windows", "windows-x64", "win32-x64"].includes(platform)) {
    return "windows";
  }

  fail(`Unsupported --platform "${value}". Use macos or win32-x64.`);
}

function sanitizeLabel(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 40);
}

function normalizeBlobPath(value) {
  const pathname = String(value || "").trim().replace(/^\/+/, "");

  if (!pathname || pathname.includes("..")) {
    fail(`Invalid blob pathname "${value}".`);
  }

  return pathname;
}

function normalizeRolloutPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
    fail("--rollout-percent must be between 0 and 100.");
  }
  return Math.round(numeric);
}

function parseBoolean(value) {
  if (value === true) return true;
  const text = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "critical"].includes(text);
}

function isSemver(value) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(value || ""));
}

function isSidestreamUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === "https://sidestream.tv";
  } catch {
    return false;
  }
}

function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function fail(message) {
  console.error(message);
  console.error("");
  printUsage();
  process.exit(1);
}

function printUsage() {
  console.log([
    "Mac release:",
    "  npm run release:publish-manifest -- \\",
    "    --platform macos \\",
    "    --version 1.0.12 \\",
    "    --artifact /path/to/Sidestream-1.0.12-Mac-Installer.dmg \\",
    "    --pathname sidestream/1.0.12/Sidestream-1.0.12-Mac-Installer.dmg \\",
    `    --artifact-url ${PLATFORM_DEFAULTS.macos.artifactUrl} \\`,
    `    --release-notes-url ${PLATFORM_DEFAULTS.macos.releaseNotesUrl} \\`,
    "    --signed --verified --uploaded --smoke-tested",
    "",
    "Windows private beta:",
    "  npm run release:publish-manifest -- \\",
    "    --platform win32-x64 \\",
    "    --version 1.0.13 \\",
    "    --artifact /path/to/Sidestream-1.0.13-Windows-Beta-Installer.exe \\",
    "    --pathname sidestream/1.0.13/Sidestream-1.0.13-Windows-Beta-Installer.exe \\",
    "    --unsigned-beta-approved --verified --uploaded --smoke-tested",
  ].join("\n"));
}

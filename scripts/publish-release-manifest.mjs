#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
const REQUIRED_GATES = ["verified", "smoke-tested"];

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
  const pathname = normalizeArtifactPath(required(args.pathname, "--pathname"));
  const version = normalizeVersion(required(args.version, "--version"));
  const minSupportedVersion = normalizeVersion(args["min-supported-version"] || "1.0.12");
  const channel = sanitizeLabel(args.channel || "stable");
  const rolloutPercent = normalizeRolloutPercent(args["rollout-percent"] || 100);
  const releaseNotesUrl = args["release-notes-url"] || platformDefaults.releaseNotesUrl;
  const publishedAt = args["published-at"] || new Date().toISOString();
  const artifactType = sanitizeLabel(args["artifact-type"] || platformDefaults.artifactType);
  const critical = parseBoolean(args.critical);
  const manifestPath = MANIFEST_PATHS[platform];
  const deliveryProvider = normalizeDeliveryProvider(
    args.provider || process.env.SIDESTREAM_INSTALLER_PROVIDER || "hetzner",
  );

  if (channel !== "stable") fail("Only the stable Sidestream release channel is supported right now.");
  if (!isSemver(version)) fail(`Invalid --version "${version}". Use x.y.z semver.`);
  if (!isSemver(minSupportedVersion)) fail(`Invalid --min-supported-version "${minSupportedVersion}".`);
  if (!isSidestreamUrl(artifactUrl)) fail("--artifact-url must use https://sidestream.tv.");
  if (!isSidestreamUrl(releaseNotesUrl)) fail("--release-notes-url must use https://sidestream.tv.");
  if (!fs.existsSync(artifactPath)) fail(`Artifact not found: ${artifactPath}`);

  const stats = fs.statSync(artifactPath);
  if (!stats.isFile() || stats.size <= 0) fail(`Artifact is not a readable file: ${artifactPath}`);

  const artifactSha256 = hashFile(artifactPath);
  if (deliveryProvider === "hetzner") {
    verifyHetznerArtifact({
      identity: args.identity,
      pathname,
      sha256: artifactSha256,
      size: stats.size,
      target: args.target,
    });
  } else if (args.uploaded !== true) {
    fail("Blob rollback publishing requires the explicit --uploaded gate.");
  }

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
      sha256: artifactSha256,
      sizeBytes: stats.size,
    },
  };

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Published Sidestream ${version} ${channel} ${platform} manifest to ${manifestPath}`);
  console.log(`Artifact URL: ${manifest.artifact.url}`);
  console.log(`Delivery provider verified: ${deliveryProvider}`);
  console.log(`Artifact pathname: ${manifest.artifact.pathname}`);
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

function normalizeArtifactPath(value) {
  const pathname = String(value || "").trim();
  if (
    pathname.length < 1 || pathname.length > 255 ||
    !pathname.startsWith("sidestream/") ||
    !/^[0-9A-Za-z][0-9A-Za-z._+/-]*$/.test(pathname) ||
    pathname.includes("//") ||
    pathname.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) fail(`Invalid artifact pathname "${value}".`);
  return pathname;
}

function normalizeDeliveryProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (provider !== "hetzner" && provider !== "blob") {
    fail("--provider must be hetzner or blob.");
  }
  return provider;
}

function verifyHetznerArtifact({ identity, pathname, sha256, size, target }) {
  const sshTarget = normalizeSshTarget(
    target || process.env.SIDESTREAM_ARTIFACT_SSH_TARGET || "root@2.29.9.121",
  );
  const sshKey = path.resolve(
    identity || process.env.SIDESTREAM_ARTIFACT_SSH_KEY ||
      path.join(process.env.HOME || "", ".ssh", "sidestream_hetzner_ed25519"),
  );
  if (!fs.existsSync(sshKey)) fail(`SSH identity does not exist: ${sshKey}`);
  const result = spawnSync("ssh", [
    "-i", sshKey,
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    sshTarget,
    "node",
    "/srv/sidestream/website-backend/scripts/finalize-hetzner-artifact.mjs",
    "--verify-only",
    "--pathname", pathname,
    "--size", String(size),
    "--sha256", sha256,
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) fail("Hetzner artifact verification failed; the manifest was not changed.");
}

function normalizeSshTarget(value) {
  const target = String(value || "").trim();
  if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$/.test(target)) fail("Invalid SSH target.");
  return target;
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
    "    --signed --verified --smoke-tested --provider hetzner",
    "",
    "Windows private beta:",
    "  npm run release:publish-manifest -- \\",
    "    --platform win32-x64 \\",
    "    --version 1.0.13 \\",
    "    --artifact /path/to/Sidestream-1.0.13-Windows-Beta-Installer.exe \\",
    "    --pathname sidestream/1.0.13/Sidestream-1.0.13-Windows-Beta-Installer.exe \\",
    "    --unsigned-beta-approved --verified --smoke-tested --provider hetzner",
    "",
    "Run release:upload-hetzner before publishing. Blob rollback publishing also requires --provider blob --uploaded.",
  ].join("\n"));
}

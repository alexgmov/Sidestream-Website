#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createNextRolloutState,
  evaluateReleaseRollout,
} from "./release-rollout-policy.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_POLICY_PATH = path.join(ROOT_DIR, "config", "release-rollout-policy.json");
const DEFAULT_MANIFEST_PATH = path.join(ROOT_DIR, "data", "release-manifest.json");
const DEFAULT_STATE_PATH = path.join(ROOT_DIR, "data", "release-rollout-state.json");
const DEFAULT_PUBLIC_MANIFEST_URL = "https://sidestream.tv/api/releases/latest";
const DEFAULT_ANALYTICS_URL =
  "https://static.121.9.29.2.clients.your-server.de/analytics/api/overview/timeseries?profile=production";

await main();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printUsage();

  const expectedVersion = required(args.version, "--version");
  const expectedRollout = boundedInteger(
    required(args["expected-rollout"], "--expected-rollout"),
    "--expected-rollout",
    0,
    100,
  );
  const maxRollout = boundedInteger(
    required(args["max-rollout"], "--max-rollout"),
    "--max-rollout",
    1,
    100,
  );
  const apply = args.apply === true;
  const policyPath = resolveRepoPath(args.policy || DEFAULT_POLICY_PATH, "--policy");
  const manifestPath = resolveRepoPath(args.manifest || DEFAULT_MANIFEST_PATH, "--manifest");
  const statePath = resolveRepoPath(args.state || DEFAULT_STATE_PATH, "--state");
  const publicManifestFile = args["public-manifest-file"]
    ? resolveRepoPath(args["public-manifest-file"], "--public-manifest-file")
    : null;
  const analyticsFile = args["analytics-file"]
    ? resolveRepoPath(args["analytics-file"], "--analytics-file")
    : null;

  if (apply && (publicManifestFile || analyticsFile)) {
    fail("--apply refuses file-backed public manifest or analytics fixtures");
  }

  const policy = readJson(policyPath, "release rollout policy");
  const localManifest = readJson(manifestPath, "local release manifest");
  const state = fs.existsSync(statePath) ? readJson(statePath, "release rollout state") : null;
  if (localManifest.version !== expectedVersion) {
    fail(`Local manifest version is ${localManifest.version}; expected ${expectedVersion}.`);
  }
  if (localManifest.rolloutPercent !== expectedRollout) {
    fail(
      `Local manifest rollout is ${localManifest.rolloutPercent}; expected ${expectedRollout}.`,
    );
  }

  const publicManifest = publicManifestFile
    ? readJson(publicManifestFile, "public release manifest fixture")
    : await fetchJson(
      args["public-manifest-url"] || DEFAULT_PUBLIC_MANIFEST_URL,
      "public release manifest",
      "https://sidestream.tv",
    );
  const analytics = analyticsFile
    ? readJson(analyticsFile, "analytics fixture")
    : await fetchJson(
      args["analytics-url"] || DEFAULT_ANALYTICS_URL,
      "production rollout analytics",
      "https://static.121.9.29.2.clients.your-server.de",
    );

  const evaluation = evaluateReleaseRollout({
    analytics,
    localManifest,
    maxRollout,
    policy,
    publicManifest,
    state,
  });
  const output = { ...evaluation, applied: false };

  if (apply && evaluation.decision === "advance") {
    requireApplyFlags(args, evaluation);
    verifyCanonicalSource();
    const nextState = createNextRolloutState({ evaluation, localManifest });
    const nextManifest = {
      ...localManifest,
      rolloutPercent: evaluation.nextRolloutPercent,
    };
    writeJsonPairAtomically({
      manifestPath,
      manifestValue: nextManifest,
      statePath,
      stateValue: nextState,
    });
    output.applied = true;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    printHumanSummary(output, { manifestPath, statePath });
  }
}

function requireApplyFlags(args, evaluation) {
  if (args["enable-auto-advance"] !== true) {
    fail("Advancing requires --enable-auto-advance.");
  }
  if (String(args["confirm-version"] || "") !== evaluation.version) {
    fail(`Advancing requires --confirm-version ${evaluation.version}.`);
  }
  const confirmedRollout = boundedInteger(
    args["confirm-rollout"],
    "--confirm-rollout",
    0,
    100,
  );
  if (confirmedRollout !== evaluation.currentRolloutPercent) {
    fail(`Advancing requires --confirm-rollout ${evaluation.currentRolloutPercent}.`);
  }
}

function verifyCanonicalSource() {
  runGit(["fetch", "origin", "main", "--prune"]);
  const branch = runGit(["branch", "--show-current"]).trim();
  const status = runGit(["status", "--porcelain", "--untracked-files=all"]).trim();
  const head = runGit(["rev-parse", "HEAD"]).trim();
  const originMain = runGit(["rev-parse", "origin/main"]).trim();
  if (branch !== "main") fail(`Rollout apply requires local main; current branch is ${branch || "detached"}.`);
  if (status) fail("Rollout apply requires a clean working tree.");
  if (head !== originMain) fail(`Rollout apply requires HEAD ${head} to equal origin/main ${originMain}.`);
}

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "git failed").trim();
    fail(detail);
  }
  return String(result.stdout || "");
}

async function fetchJson(value, label, requiredOrigin) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} URL is invalid.`);
  }
  if (url.protocol !== "https:" || url.origin !== requiredOrigin) {
    fail(`${label} URL must use ${requiredOrigin}.`);
  }

  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    fail(`${label} request failed: ${safeError(error)}`);
  }
  if (!response.ok) fail(`${label} returned HTTP ${response.status}.`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 5 * 1024 * 1024) {
    fail(`${label} exceeded the 5 MiB response limit.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} did not return valid JSON.`);
  }
}

function writeJsonPairAtomically({ manifestPath, manifestValue, statePath, stateValue }) {
  const manifestOriginal = fs.readFileSync(manifestPath, "utf8");
  const stateOriginal = fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : null;
  const nonce = `${process.pid}-${Date.now()}`;
  const manifestTemp = `${manifestPath}.${nonce}.tmp`;
  const stateTemp = `${statePath}.${nonce}.tmp`;
  fs.writeFileSync(manifestTemp, `${JSON.stringify(manifestValue, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
  fs.writeFileSync(stateTemp, `${JSON.stringify(stateValue, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });

  try {
    fs.renameSync(manifestTemp, manifestPath);
    fs.renameSync(stateTemp, statePath);
  } catch (error) {
    fs.writeFileSync(manifestPath, manifestOriginal, "utf8");
    if (stateOriginal === null) fs.rmSync(statePath, { force: true });
    else fs.writeFileSync(statePath, stateOriginal, "utf8");
    throw error;
  } finally {
    fs.rmSync(manifestTemp, { force: true });
    fs.rmSync(stateTemp, { force: true });
  }
}

function printHumanSummary(output, { manifestPath, statePath }) {
  const rate = output.metrics.intentSuccessRate === null
    ? "unavailable"
    : `${(output.metrics.intentSuccessRate * 100).toFixed(1)}%`;
  process.stdout.write([
    `Decision: ${output.decision.toUpperCase()}`,
    `Release: ${output.version} at ${output.currentRolloutPercent}%`,
    `Cap: ${output.maxRolloutPercent}%`,
    `Next step: ${output.nextRolloutPercent === null ? "none" : `${output.nextRolloutPercent}%`}`,
    `Closed intents: ${output.metrics.closedDownloadIntents}`,
    `Additional closed intents at this step: ${output.metrics.additionalClosedDownloadIntents}`,
    `Intent users: ${output.metrics.intentUsers}`,
    `Intent success: ${rate}`,
    `Hours at current rollout: ${output.metrics.hoursAtCurrentRollout}`,
    `Analytics refreshed: ${output.metrics.analyticsRefreshedAt}`,
  ].join("\n") + "\n");

  if (output.blockers.length) {
    process.stdout.write(`Blockers: ${output.blockers.join(", ")}\n`);
  }
  if (output.applied) {
    process.stdout.write([
      `Updated ${path.relative(ROOT_DIR, manifestPath)} to ${output.nextRolloutPercent}%.`,
      `Recorded the step baseline in ${path.relative(ROOT_DIR, statePath)}.`,
      "No commit, push, Vercel deployment, or Hetzner restart was performed.",
      "Run the documented production checks and same-SHA deployment sequence next.",
    ].join("\n") + "\n");
  } else if (output.decision === "advance") {
    process.stdout.write("Dry run only. Pass the documented apply and confirmation flags to write one step.\n");
  } else {
    process.stdout.write("No files changed.\n");
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const [name, inline] = token.slice(2).split("=", 2);
    if (inline !== undefined) {
      parsed[name] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) parsed[name] = true;
    else {
      parsed[name] = next;
      index += 1;
    }
  }
  return parsed;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label} is unreadable: ${safeError(error)}`);
  }
}

function resolveRepoPath(value, flag) {
  const resolved = path.resolve(value);
  if (resolved !== ROOT_DIR && !resolved.startsWith(`${ROOT_DIR}${path.sep}`)) {
    fail(`${flag} must stay inside the Sidestream Website repository.`);
  }
  return resolved;
}

function required(value, flag) {
  const text = String(value || "").trim();
  if (!text) fail(`Missing ${flag}.`);
  return text;
}

function boundedInteger(value, flag, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < minimum || numeric > maximum) {
    fail(`${flag} must be an integer between ${minimum} and ${maximum}.`);
  }
  return numeric;
}

function safeError(error) {
  return error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 200) : "unknown error";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function printUsage() {
  console.log([
    "Dry-run one guarded rollout evaluation:",
    "  npm run release:rollout -- \\",
    "    --version 1.0.21 \\",
    "    --expected-rollout 25 \\",
    "    --max-rollout 100",
    "",
    "Apply at most one passing step:",
    "  npm run release:rollout -- \\",
    "    --version 1.0.21 \\",
    "    --expected-rollout 25 \\",
    "    --max-rollout 50 \\",
    "    --enable-auto-advance \\",
    "    --apply \\",
    "    --confirm-version 1.0.21 \\",
    "    --confirm-rollout 25",
    "",
    "The command never commits, pushes, deploys Vercel, or restarts Hetzner.",
  ].join("\n"));
}

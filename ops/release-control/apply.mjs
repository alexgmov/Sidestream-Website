import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateChange } from "./server.mjs";

const run = promisify(execFile);
const root = "/srv/sidestream/website-backend";
const command = async (file, args) => (await run(file, args, { cwd: root, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const change = validateChange(JSON.parse(process.argv[2] || "null"));
if (await command("git", ["branch", "--show-current"]) !== "main" || await command("git", ["status", "--porcelain"])) throw new Error("Clean main required.");
await command("git", ["fetch", "origin", "main", "--prune"]);
await command("git", ["pull", "--ff-only", "origin", "main"]);
if (await command("git", ["rev-parse", "HEAD"]) !== await command("git", ["rev-parse", "origin/main"])) throw new Error("Synchronized main required.");
await command("npm", ["run", "verify:production-source"]);
const names = ["data/release-manifest.windows.json", "data/release-rollout-state.windows.json", "README.md"];
const original = await Promise.all(names.map((name) => readFile(path.join(root, name), "utf8")));
const manifest = JSON.parse(original[0]);
const pilot = JSON.parse(original[1]);
if (manifest.version !== change.version || manifest.artifact.sha256 !== change.artifactSha256 || manifest.rolloutPercent !== change.expectedPercent
  || manifest.critical !== false || pilot.status !== "active" || pilot.version !== manifest.version || pilot.artifactSha256 !== manifest.artifact.sha256
  || pilot.approvedRolloutPercent !== manifest.rolloutPercent) throw new Error("Release binding changed.");
if (process.argv[3] === "--check") {
  await command("npm", ["run", "test:release-rollout"]);
  await command("npm", ["run", "test:entitlement"]);
  await command("npm", ["run", "build"]);
  await command("npm", ["run", "build:hetzner-api"]);
  console.log("PASS: release publication preflight; no source files changed.");
  process.exit(0);
}
manifest.rolloutPercent = change.rolloutPercent;
pilot.approvedRolloutPercent = change.rolloutPercent;
pilot.rolloutApprovedAt = new Date().toISOString();
const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const readme = original[2].replace(/Windows pilot \(owner-approved \d+%\)/, `Windows pilot (owner-approved ${change.rolloutPercent}%)`)
  + `\n- ${date}: Owner dashboard Save changed Windows ${change.version} update notices from ${change.expectedPercent}% to ${change.rolloutPercent}%. Installer bytes and cumulative observation start are unchanged. Public release and Production SHA verification are required before Save reports success.\n`;
let committed = false;
try {
  await writeFile(path.join(root, names[0]), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(path.join(root, names[1]), JSON.stringify(pilot, null, 2) + "\n");
  await writeFile(path.join(root, names[2]), readme);
  await command("npm", ["run", "test:release-rollout"]);
  await command("npm", ["run", "test:entitlement"]);
  await command("npm", ["run", "build"]);
  await command("npm", ["run", "build:hetzner-api"]);
  await command("git", ["diff", "--check"]);
  const changed = (await command("git", ["diff", "--name-only"])).split("\n").sort();
  if (changed.join() !== [...names].sort().join()) throw new Error("Unexpected changed files.");
  await command("git", ["add", "--", ...names]);
  const ownerEmail = await command("git", ["log", "-1", "--format=%ae"]);
  await command("git", ["-c", "user.name=Sidestream Dashboard", "-c", `user.email=${ownerEmail}`, "commit", "-m", `Owner dashboard: Windows ${change.version} update notices ${change.rolloutPercent}%`]);
  committed = true;
  await command("git", ["push", "origin", "main:main"]);
  console.log(await command("git", ["rev-parse", "HEAD"]));
} catch (error) {
  // Only restore this operation's exact files before its commit. A committed
  // or pushed change is retained for audit and deliberate recovery.
  if (!committed) {
    await Promise.all(names.map((name, index) => writeFile(path.join(root, name), original[index])));
    await command("git", ["reset", "--", ...names]);
  }
  throw error;
}

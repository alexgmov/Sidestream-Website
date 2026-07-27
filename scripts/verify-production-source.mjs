#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PRODUCTION_SOURCE = Object.freeze({
  remote: "origin",
  branch: "codex/release-1.0.14",
  projectId: "prj_x9sRcnoAAfF6VPxseJYLBgxhhPyh",
  orgId: "team_ZcKImJwvlcCrE15nTEOWT2NC",
  projectName: "sidestream",
});

export async function verifyProductionSource(root = process.cwd()) {
  const status = runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.trim()) {
    throw new Error(
      "Production deployment requires a clean worktree. Commit or isolate every tracked and untracked change first.",
    );
  }

  const head = runGit(root, ["rev-parse", "HEAD"]).trim();
  const remoteRef = `refs/heads/${PRODUCTION_SOURCE.branch}`;
  const remoteLine = runGit(root, [
    "ls-remote",
    "--exit-code",
    PRODUCTION_SOURCE.remote,
    remoteRef,
  ]).trim();
  const remoteHead = remoteLine.split(/\s+/u)[0] || "";
  if (!/^[0-9a-f]{40}$/u.test(remoteHead)) {
    throw new Error(`Could not resolve ${PRODUCTION_SOURCE.remote}/${PRODUCTION_SOURCE.branch}`);
  }
  if (head !== remoteHead) {
    throw new Error(
      `Production source mismatch: HEAD ${head} must exactly match ${PRODUCTION_SOURCE.remote}/${PRODUCTION_SOURCE.branch} ${remoteHead}. Merge and push the candidate to the canonical release branch before deploying.`,
    );
  }

  const projectPath = path.join(root, ".vercel", "project.json");
  let project;
  try {
    project = JSON.parse(await readFile(projectPath, "utf8"));
  } catch (error) {
    throw new Error(
      "Production deployment requires a valid .vercel/project.json. Link this checkout to the pinned sidestream project first.",
      { cause: error },
    );
  }
  for (const [key, expected] of [
    ["projectId", PRODUCTION_SOURCE.projectId],
    ["orgId", PRODUCTION_SOURCE.orgId],
    ["projectName", PRODUCTION_SOURCE.projectName],
  ]) {
    if (project?.[key] !== expected) {
      throw new Error(
        `Vercel project mismatch: ${key} must be ${expected}, received ${String(project?.[key] || "")}`,
      );
    }
  }

  return {
    head,
    branch: `${PRODUCTION_SOURCE.remote}/${PRODUCTION_SOURCE.branch}`,
    projectName: PRODUCTION_SOURCE.projectName,
  };
}

function runGit(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const message = error?.stderr?.trim() || error?.message || "unknown git error";
    throw new Error(`Production source verification failed: ${message}`, { cause: error });
  }
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "Verify that this clean checkout exactly matches the pinned remote release branch and Vercel project.",
    );
    return;
  }
  const result = await verifyProductionSource();
  console.log(
    `PASS: ${result.head} matches ${result.branch} and the pinned ${result.projectName} Vercel project.`,
  );
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

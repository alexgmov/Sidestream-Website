#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function resolveBuildGitSha({
  explicitSha,
  vercelSha,
  gitSha,
}) {
  const candidate = explicitSha || vercelSha || gitSha || "";
  if (!/^[0-9a-f]{40}$/u.test(candidate)) {
    throw new Error(`Build requires a full 40-character Git SHA, received ${candidate || "nothing"}`);
  }
  return candidate;
}

export function resolveBuildGitShaFromSources({
  explicitSha,
  vercelSha,
  readGitSha,
}) {
  if (explicitSha || vercelSha) {
    return resolveBuildGitSha({ explicitSha, vercelSha, gitSha: "" });
  }
  return resolveBuildGitSha({
    explicitSha: "",
    vercelSha: "",
    gitSha: readGitSha(),
  });
}

export async function generateProductionVersion(
  root = process.cwd(),
  dependencies = {},
) {
  const readGitSha =
    dependencies.readGitSha ||
    (() =>
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim());
  const resolvedSha = resolveBuildGitShaFromSources({
    explicitSha: process.env.SIDESTREAM_BUILD_GIT_SHA,
    vercelSha: process.env.VERCEL_GIT_COMMIT_SHA,
    readGitSha,
  });
  const outputDirectory = path.join(root, "dist");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    path.join(outputDirectory, "version.json"),
    `${JSON.stringify({ gitSha: resolvedSha })}\n`,
    "utf8",
  );
  return { gitSha: resolvedSha };
}

async function main() {
  const result = await generateProductionVersion();
  console.log(`Generated dist/version.json for ${result.gitSha}`);
}

const entryUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

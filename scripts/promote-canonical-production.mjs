#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const DEFAULT_PRODUCTION_ALIAS =
  "sidestream-alex-3685s-projects.vercel.app";
const CANONICAL_ALIAS = "sidestream.tv";

export function assertPromotionCandidate({ deployment, expectedSha, reportedSha }) {
  if (deployment?.target !== "production" || deployment?.readyState !== "READY") {
    throw new Error("Default Vercel alias is not a Ready Production deployment");
  }
  if (!deployment?.url || !/^sidestream-[a-z0-9-]+\.vercel\.app$/u.test(deployment.url)) {
    throw new Error("Default Vercel alias returned an unexpected deployment URL");
  }
  if (reportedSha !== expectedSha) {
    throw new Error(
      `Default Vercel deployment reports ${reportedSha || "no SHA"}; expected ${expectedSha}`,
    );
  }
}

export async function promoteCanonicalProduction({
  expectedSha,
  root = process.cwd(),
  runVercel = async (args) => {
    const { stdout } = await execFileAsync("npx", ["vercel@latest", ...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  },
}) {
  const inspectOutput = await runVercel([
    "inspect",
    DEFAULT_PRODUCTION_ALIAS,
    "--format=json",
    "--scope",
    "alex-3685s-projects",
  ]);
  const deployment = JSON.parse(inspectOutput);
  const version = JSON.parse(
    await runVercel([
      "curl",
      "/version.json",
      "--deployment",
      deployment.url,
    ]),
  );
  assertPromotionCandidate({
    deployment,
    expectedSha,
    reportedSha: version?.gitSha,
  });
  await runVercel([
    "alias",
    "set",
    deployment.url,
    CANONICAL_ALIAS,
    "--scope",
    "alex-3685s-projects",
  ]);
  return {
    deploymentId: deployment.id,
    deploymentUrl: deployment.url,
    gitSha: expectedSha,
  };
}

async function main() {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  const result = await promoteCanonicalProduction({
    expectedSha: stdout.trim(),
  });
  console.log(
    `PASS: promoted ${result.deploymentId} (${result.gitSha}) to ${CANONICAL_ALIAS}.`,
  );
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

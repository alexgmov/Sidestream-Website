#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

export const PRODUCTION_SOURCE = Object.freeze({
  branch: "main",
  projectId: "prj_x9sRcnoAAfF6VPxseJYLBgxhhPyh",
  orgId: "team_ZcKImJwvlcCrE15nTEOWT2NC",
  projectName: "sidestream",
  requiredAncestors: Object.freeze([
    "81a3190f6fbabb684cde605a4e256d2fa6295fe5",
    "d3d1e82ebd640bf8d6e30df7d54628e4206300a0",
  ]),
});

const BROWSER_UI_MARKERS = Object.freeze([
  "text/html",
  "<!doctype html",
  "<html",
]);
const ALLOWED_ROOT_HTML = new Set(["account.html", "index.html", "thank-you.html"]);

export function assertCheckoutSourceContract(input) {
  const {
    checkoutStart,
    account,
    entitlement,
    readme,
    unexpectedRootPages,
  } = input;

  for (const marker of [
    "/api/auth/google/start",
    "createCheckoutIntent",
    "createOrReuseCheckoutSession",
  ]) {
    if (!checkoutStart.includes(marker)) {
      throw new Error(`Checkout start is missing required direct-flow marker: ${marker}`);
    }
  }
  for (const marker of BROWSER_UI_MARKERS) {
    if (checkoutStart.includes(marker)) {
      throw new Error(`Checkout start contains browser UI marker: ${marker}`);
    }
  }
  if (unexpectedRootPages.length > 0) {
    throw new Error(
      `Unexpected deployable root HTML: ${unexpectedRootPages.join(", ")}`,
    );
  }
  if (!account.includes("isZeroTotalCheckoutWithoutPaymentIntent")) {
    throw new Error("Checkout fulfillment is missing the zero-total Session verifier");
  }
  for (const marker of [
    'session.payment_status === "paid"',
    'session.payment_status === "no_payment_required"',
    "session.amount_total === 0",
    "session.payment_intent",
  ]) {
    if (!entitlement.includes(marker)) {
      throw new Error(`Entitlement verifier is missing required marker: ${marker}`);
    }
  }
  for (const step of [
    "1. The user clicks Upgrade.",
    "2. Google authentication establishes the Sidestream account session.",
    "3. The browser opens Stripe Checkout for payment.",
  ]) {
    if (!readme.includes(step)) {
      throw new Error(`README is missing the canonical checkout step: ${step}`);
    }
  }
}

export async function verifyCheckoutContract(root = process.cwd()) {
  const [checkoutStart, account, entitlement, readme, rootEntries] =
    await Promise.all([
      readFile(path.join(root, "api/checkout/start.ts"), "utf8"),
      readFile(path.join(root, "api/_lib/account.ts"), "utf8"),
      readFile(path.join(root, "api/_lib/entitlement.ts"), "utf8"),
      readFile(path.join(root, "README.md"), "utf8"),
      readdir(root, { withFileTypes: true }),
    ]);

  assertCheckoutSourceContract({
    checkoutStart,
    account,
    entitlement,
    readme,
    unexpectedRootPages: rootEntries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".html") &&
          !ALLOWED_ROOT_HTML.has(entry.name),
      )
      .map((entry) => entry.name),
  });

  return {
    checkoutRoute: "direct",
    zeroTotalStatuses: 2,
    rootHtmlPages: ALLOWED_ROOT_HTML.size,
  };
}

export async function verifyProductionSource(root = process.cwd()) {
  const checkout = await verifyCheckoutContract(root);
  const git = (args) =>
    execFileAsync("git", args, { cwd: root, encoding: "utf8" });

  const { stdout: status } = await git(["status", "--porcelain"]);
  if (status.trim()) {
    throw new Error("Production deploy requires a clean working tree");
  }

  const { stdout: headOutput } = await git(["rev-parse", "HEAD"]);
  const head = headOutput.trim();
  const remoteRef = `refs/heads/${PRODUCTION_SOURCE.branch}`;
  const { stdout: remoteOutput } = await git([
    "ls-remote",
    "origin",
    remoteRef,
  ]);
  const remoteHead = remoteOutput.trim().split(/\s+/u)[0] || "";
  if (!remoteHead) {
    throw new Error(`Could not resolve origin/${PRODUCTION_SOURCE.branch}`);
  }
  if (head !== remoteHead) {
    throw new Error(
      `Production deploy requires HEAD ${head} to equal origin/${PRODUCTION_SOURCE.branch} ${remoteHead}`,
    );
  }

  for (const ancestor of PRODUCTION_SOURCE.requiredAncestors) {
    try {
      await git(["merge-base", "--is-ancestor", ancestor, head]);
    } catch {
      throw new Error(
        `Production source is missing required checkout baseline ${ancestor}`,
      );
    }
  }

  let project;
  try {
    project = JSON.parse(
      await readFile(path.join(root, ".vercel/project.json"), "utf8"),
    );
  } catch (error) {
    throw new Error("Production deploy requires a valid .vercel/project.json", {
      cause: error,
    });
  }
  for (const key of ["projectId", "orgId", "projectName"]) {
    if (project[key] !== PRODUCTION_SOURCE[key]) {
      throw new Error(
        `Vercel ${key} mismatch: expected ${PRODUCTION_SOURCE[key]}, received ${project[key] || "missing"}`,
      );
    }
  }

  return {
    branch: PRODUCTION_SOURCE.branch,
    head,
    project: PRODUCTION_SOURCE.projectName,
    checkout,
  };
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "Run with --checkout-only for the source contract, or without flags before a Production deployment.",
    );
    return;
  }

  if (process.argv.includes("--checkout-only")) {
    const result = await verifyCheckoutContract();
    console.log(
      `PASS: checkout source is ${result.checkoutRoute}; both zero-total statuses are supported; root HTML is allowlisted.`,
    );
    return;
  }

  const result = await verifyProductionSource();
  console.log(
    `PASS: clean ${result.head} equals origin/${result.branch}, targets Vercel project ${result.project}, and preserves the checkout contract.`,
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

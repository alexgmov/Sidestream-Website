#!/usr/bin/env node

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OUTPUT_ROOT = path.resolve(".vercel/output");
const REQUIRED_FUNCTIONS = Object.freeze([
  "api/checkout/start.func",
  "api/checkout/complete.func",
  "api/download.func",
  "api/releases/latest.func",
  "api/internal/stripe-events/process.func",
  "api/internal/download-leads/replay.func",
  "api/internal/maintenance.func",
  "api/internal/customer-usage/sync.func",
  "api/internal/customers/index.func",
  "api/internal/customers/[customerId].func",
]);
const ALLOWED_ROOT_HTML = new Set([
  "account.html",
  "index.html",
  "paid-thank-you.html",
  "thank-you.html",
]);

export async function verifyVercelBuild(outputRoot = OUTPUT_ROOT) {
  const configPath = path.join(outputRoot, "config.json");
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      "Missing valid .vercel/output/config.json. A human must run `npx vercel build` first; acceptance does not require credentials or .vercel state.",
      { cause: error },
    );
  }
  if (!config || typeof config !== "object") {
    throw new Error("Vercel build output config is invalid");
  }

  for (const relativeFunction of REQUIRED_FUNCTIONS) {
    const functionPath = path.join(outputRoot, "functions", relativeFunction);
    const metadata = await stat(functionPath).catch(() => null);
    if (!metadata?.isDirectory()) {
      throw new Error(`Vercel build omitted function ${relativeFunction}`);
    }
  }

  const checkoutStartBundle = await readBundle(
    path.join(outputRoot, "functions", "api/checkout/start.func"),
  );
  if (!checkoutStartBundle.includes("/api/auth/google/start")) {
    throw new Error("Vercel checkout-start bundle omitted the Google authentication redirect");
  }
  for (const marker of ["createCheckoutIntent", "createOrReuseCheckoutSession"]) {
    if (!checkoutStartBundle.includes(marker)) {
      throw new Error(
        `Vercel checkout-start bundle omitted direct Stripe marker: ${marker}`,
      );
    }
  }

  const checkoutCompleteBundle = await readBundle(
    path.join(outputRoot, "functions", "api/checkout/complete.func"),
  );
  for (const marker of ["no_payment_required", "amount_total"]) {
    if (!checkoutCompleteBundle.includes(marker)) {
      throw new Error(
        `Vercel checkout-complete bundle omitted zero-total fulfillment marker: ${marker}`,
      );
    }
  }

  const staticRootEntries = await readdir(
    path.join(outputRoot, "static"),
    { withFileTypes: true },
  );
  const unexpectedRootPages = staticRootEntries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".html") &&
        !ALLOWED_ROOT_HTML.has(entry.name),
    )
    .map((entry) => entry.name);
  if (unexpectedRootPages.length > 0) {
    throw new Error(
      `Vercel static output contains unexpected root HTML: ${unexpectedRootPages.join(", ")}`,
    );
  }
  const version = JSON.parse(
    await readFile(path.join(outputRoot, "static", "version.json"), "utf8"),
  );
  if (!/^[0-9a-f]{40}$/u.test(version?.gitSha || "")) {
    throw new Error("Vercel static output contains no valid Production Git SHA");
  }

  const bundledFiles = await listFiles(path.join(outputRoot, "functions"));
  for (const manifest of ["release-manifest.json", "release-manifest.windows.json"]) {
    if (!bundledFiles.some((filename) => path.basename(filename) === manifest)) {
      throw new Error(`Vercel build omitted ${manifest} from the function bundles`);
    }
  }
  return {
    functions: REQUIRED_FUNCTIONS.length,
    manifests: 2,
    checkoutContract: true,
    gitSha: version.gitSha,
  };
}

async function readBundle(directory) {
  const files = await listFiles(directory);
  const javascriptFiles = files.filter((filename) =>
    /\.(?:c|m)?js$/u.test(filename)
  );
  if (javascriptFiles.length === 0) {
    throw new Error(`Vercel function bundle contains no JavaScript: ${directory}`);
  }
  return (await Promise.all(
    javascriptFiles.map((filename) => readFile(filename, "utf8")),
  )).join("\n");
}

async function listFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("Run `npx vercel build`, then `npm run verify:vercel-build`.");
    return;
  }
  const result = await verifyVercelBuild();
  console.log(
    `PASS: human-built Vercel output contains ${result.functions} functions, ${result.manifests} release manifests, the direct checkout contract, and version ${result.gitSha}.`,
  );
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

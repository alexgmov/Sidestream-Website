#!/usr/bin/env node

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OUTPUT_ROOT = path.resolve(".vercel/output");
const REQUIRED_FUNCTIONS = Object.freeze([
  "api/download.func",
  "api/resolve-waitlist.func",
  "api/after-effects-waitlist.func",
  "api/releases/latest.func",
  "api/internal/stripe-events/process.func",
  "api/internal/download-leads/replay.func",
  "api/internal/maintenance.func",
  "api/internal/customer-usage/sync.func",
  "api/internal/customers/index.func",
  "api/internal/customers/[customerId].func",
]);
const REQUIRED_INDEX_MARKERS = Object.freeze([
  ["Resolve waitlist CTA", "data-resolve-waitlist-open"],
  ["Resolve waitlist modal", 'id="resolve-waitlist-gate"'],
  ["Resolve waitlist browser route", 'fetch("/api/resolve-waitlist"'],
  ["After Effects waitlist CTA", "data-after-effects-waitlist-open"],
  ["After Effects waitlist modal", 'id="after-effects-waitlist-gate"'],
  ["After Effects waitlist browser route", 'fetch("/api/after-effects-waitlist"'],
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

  const bundledFiles = await listFiles(path.join(outputRoot, "functions"));
  for (const manifest of ["release-manifest.json", "release-manifest.windows.json"]) {
    if (!bundledFiles.some((filename) => path.basename(filename) === manifest)) {
      throw new Error(`Vercel build omitted ${manifest} from the function bundles`);
    }
  }

  const indexPath = path.join(outputRoot, "static", "index.html");
  const indexHtml = await readFile(indexPath, "utf8").catch(() => null);
  if (indexHtml === null) {
    throw new Error("Vercel build omitted static/index.html");
  }
  for (const [label, marker] of REQUIRED_INDEX_MARKERS) {
    if (!indexHtml.includes(marker)) {
      throw new Error(`Vercel build omitted ${label}`);
    }
  }

  return {
    functions: REQUIRED_FUNCTIONS.length,
    manifests: 2,
    indexMarkers: REQUIRED_INDEX_MARKERS.length,
  };
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
    `PASS: human-built Vercel output contains ${result.functions} functions, ${result.manifests} release manifests, and ${result.indexMarkers} required landing-page markers.`,
  );
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

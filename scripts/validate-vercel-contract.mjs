#!/usr/bin/env node

import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPOSITORY_ROOT = path.resolve(".");
const INTERNAL_CRONS = Object.freeze([
  {
    path: "/api/internal/stripe-events/process",
    schedule: "*/5 * * * *",
    source: "api/internal/stripe-events/process.ts",
  },
  {
    path: "/api/internal/download-leads/replay",
    schedule: "*/10 * * * *",
    source: "api/internal/download-leads/replay.ts",
  },
  {
    path: "/api/internal/maintenance",
    schedule: "13 4 * * *",
    source: "api/internal/maintenance.ts",
  },
  {
    path: "/api/internal/customer-usage/sync",
    schedule: "27 5 * * *",
    source: "api/internal/customer-usage/sync.ts",
  },
]);

const PROTECTED_ADMIN_ROUTES = Object.freeze([
  {
    path: "/api/internal/upgrade-pricing-report",
    source: "api/internal/upgrade-pricing-report.ts",
    testSource: "tests/upgrade-pricing-report.test.mjs",
  },
  {
    path: "/api/internal/customer-summary",
    source: "api/internal/customer-summary.ts",
    testSource: "tests/customer-360/summary.test.mjs",
  },
  {
    path: "/api/internal/customers",
    source: "api/internal/customers/index.ts",
    testSource: "tests/customer-360/query-api.test.mjs",
  },
  {
    path: "/api/internal/customers/[customerId]",
    source: "api/internal/customers/[customerId].ts",
    testSource: "tests/customer-360/query-api.test.mjs",
  },
  {
    path: "/api/internal/customers/funnel",
    source: "api/internal/customers/funnel.ts",
    testSource: "tests/customer-360/acquisition-funnel.test.mjs",
  },
  {
    path: "/api/internal/customers/lookup",
    source: "api/internal/customers/lookup.ts",
    testSource: "tests/customer-360/query-api.test.mjs",
  },
]);

const PROTECTED_OPERATIONAL_ROUTES = Object.freeze([
  {
    path: "/api/internal/hetzner-secret-export",
    source: "api/internal/hetzner-secret-export.ts",
    guardSource: "api/_lib/hetzner-secret-export.ts",
    testSource: "tests/hetzner-secret-export.test.mjs",
  },
]);

const RELEASE_SOURCES = Object.freeze([
  "api/download.ts",
  "api/releases/latest.ts",
  "api/_lib/release-manifest.ts",
  "data/release-manifest.json",
  "data/release-manifest.windows.json",
]);

export async function validateVercelContract(root = REPOSITORY_ROOT) {
  const vercelPath = path.join(root, "vercel.json");
  const vercel = JSON.parse(await readFile(vercelPath, "utf8"));
  const configuredCrons = Array.isArray(vercel.crons) ? vercel.crons : [];
  requireCondition(
    configuredCrons.length === INTERNAL_CRONS.length,
    `vercel.json must configure exactly ${INTERNAL_CRONS.length} protected internal crons`,
  );

  for (const expected of INTERNAL_CRONS) {
    const configured = configuredCrons.find((cron) => cron?.path === expected.path);
    requireCondition(Boolean(configured), `Missing Vercel cron ${expected.path}`);
    requireCondition(
      configured.schedule === expected.schedule,
      `Unexpected schedule for ${expected.path}`,
    );

    const source = await readFile(path.join(root, expected.source), "utf8");
    requireCondition(/CRON_SECRET/.test(source), `${expected.source} must use CRON_SECRET`);
    requireCondition(/authorization/i.test(source), `${expected.source} must inspect authorization`);
    requireCondition(/Bearer /.test(source), `${expected.source} must require Bearer auth`);
    requireCondition(
      /(?:method|toUpperCase\(\))\s*!==\s*"GET"/.test(source),
      `${expected.source} must explicitly admit Vercel Cron GET`,
    );
    requireCondition(
      !/SIDESTREAM_(?:DOWNLOAD_LEADS_REPLAY|STRIPE_EVENTS_PROCESS|MAINTENANCE|CUSTOMER_USAGE)_SECRET/.test(source),
      `${expected.source} must not introduce a second scheduler secret`,
    );
  }

  for (const expected of PROTECTED_ADMIN_ROUTES) {
    requireCondition(
      !configuredCrons.some((cron) => cron?.path === expected.path),
      `${expected.path} is an on-demand admin route and must not be a Vercel cron`,
    );
    const source = await readFile(path.join(root, expected.source), "utf8");
    requireCondition(
      /authorizeCustomerAdminRequest/.test(source),
      `${expected.source} must use the shared customer admin guard`,
    );
    requireCondition(
      /(?:method|authorizeCustomerAdminRequest)/.test(source),
      `${expected.source} must have an explicit protected request boundary`,
    );
  }

  for (const expected of PROTECTED_OPERATIONAL_ROUTES) {
    requireCondition(
      !configuredCrons.some((cron) => cron?.path === expected.path),
      `${expected.path} is a one-time operational route and must not be a Vercel cron`,
    );
    const [routeSource, guardSource, testSource] = await Promise.all([
      readFile(path.join(root, expected.source), "utf8"),
      readFile(path.join(root, expected.guardSource), "utf8"),
      readFile(path.join(root, expected.testSource), "utf8"),
    ]);
    requireCondition(
      /createHetznerSecretExportHandler/.test(routeSource),
      `${expected.source} must use the encrypted export guard`,
    );
    for (const marker of [
      "SIDESTREAM_HETZNER_EXPORT_TOKEN",
      "SIDESTREAM_HETZNER_EXPORT_PUBLIC_KEY",
      "SIDESTREAM_HETZNER_EXPORT_NOT_AFTER",
      "timingSafeEqual",
      "publicEncrypt",
      "no-store",
    ]) {
      requireCondition(
        guardSource.includes(marker),
        `${expected.guardSource} is missing ${marker}`,
      );
    }
    requireCondition(
      !/Access-Control-Allow-Origin/i.test(guardSource),
      `${expected.guardSource} must not enable browser CORS`,
    );
    requireCondition(
      testSource.includes(expected.path) ||
        testSource.includes("one-time export is POST-only"),
      `${expected.testSource} must cover the protected operational route`,
    );
  }

  const adminGuardSource = await readFile(
    path.join(root, "api/_lib/customer-admin.ts"),
    "utf8",
  );
  for (const marker of [
    "SIDESTREAM_CRM_ADMIN_SECRET",
    "authorization",
    "Bearer ${secret}",
    "timingSafeEqual",
    "browser_origin_forbidden",
    "Cache-Control",
    "no-store",
  ]) {
    requireCondition(
      adminGuardSource.includes(marker),
      `Customer admin guard is missing ${marker}`,
    );
  }
  requireCondition(
    !/Access-Control-Allow-Origin/i.test(adminGuardSource),
    "Customer admin routes must not enable browser CORS",
  );
  requireCondition(
    /toUpperCase\(\)\s*!==\s*"POST"/.test(adminGuardSource),
    "Customer admin routes must remain POST-only",
  );

  const internalRouteFiles = await listTypeScriptFiles(path.join(root, "api", "internal"));
  const expectedRouteFiles = [
    ...INTERNAL_CRONS.map((cron) => cron.source),
    ...PROTECTED_ADMIN_ROUTES.map((route) => route.source),
    ...PROTECTED_OPERATIONAL_ROUTES.map((route) => route.source),
  ].sort();
  const actualRouteFiles = internalRouteFiles
    .map((filename) => path.relative(root, filename).split(path.sep).join("/"))
    .sort();
  requireCondition(
    JSON.stringify(actualRouteFiles) === JSON.stringify(expectedRouteFiles),
    `Every api/internal route must be classified as a cron or protected admin route: ${actualRouteFiles.join(", ")}`,
  );

  const authTestSource = await readFile(path.join(root, "tests/vercel-contract.test.mjs"), "utf8");
  for (const expected of INTERNAL_CRONS) {
    requireCondition(
      authTestSource.includes(expected.path),
      `Missing auth coverage marker for ${expected.path}`,
    );
  }
  requireCondition(
    authTestSource.includes("missing and incorrect CRON_SECRET"),
    "Cron contract tests must cover missing and incorrect authorization",
  );
  requireCondition(
    authTestSource.includes("GET-only Vercel cron routes"),
    "Cron contract tests must cover the allowed method surface",
  );
  for (const expected of PROTECTED_ADMIN_ROUTES) {
    const adminTestSource = await readFile(path.join(root, expected.testSource), "utf8");
    requireCondition(
      adminTestSource.includes(expected.path),
      `Missing admin auth coverage marker for ${expected.path}`,
    );
    requireCondition(
      /POST-only|unsupported methods/.test(adminTestSource),
      `Missing POST-only method coverage for ${expected.path}`,
    );
  }
  const queryAdminTestSource = await readFile(
    path.join(root, "tests/customer-360/query-api.test.mjs"),
    "utf8",
  );
  requireCondition(
    queryAdminTestSource.includes("missing, wrong, and multiple SIDESTREAM_CRM_ADMIN_SECRET"),
    "Customer admin tests must cover missing, incorrect, and multiple authorization",
  );

  for (const filename of RELEASE_SOURCES) {
    await access(path.join(root, filename));
  }
  const [downloadSource, releasesSource, sharedReleaseSource] = await Promise.all([
    readFile(path.join(root, "api/download.ts"), "utf8"),
    readFile(path.join(root, "api/releases/latest.ts"), "utf8"),
    readFile(path.join(root, "api/_lib/release-manifest.ts"), "utf8"),
  ]);
  requireCondition(
    downloadSource.includes('from "./_lib/release-manifest.js"'),
    "/api/download must use the shared release resolver",
  );
  requireCondition(
    releasesSource.includes('from "../_lib/release-manifest.js"'),
    "/api/releases/latest must use the shared release resolver",
  );
  requireCondition(
    sharedReleaseSource.includes('"release-manifest.json"') &&
      sharedReleaseSource.includes('"release-manifest.windows.json"'),
    "The release resolver must include both manifest source files",
  );

  const [macManifest, windowsManifest] = await Promise.all([
    readJson(path.join(root, "data/release-manifest.json")),
    readJson(path.join(root, "data/release-manifest.windows.json")),
  ]);
  requireCondition(
    macManifest?.artifact?.url === "https://sidestream.tv/api/download",
    "The Mac manifest must point to /api/download",
  );
  requireCondition(
    windowsManifest?.artifact?.url ===
      "https://sidestream.tv/api/download?platform=win32-x64",
    "The Windows manifest must point to the platform-scoped download route",
  );
  await access(path.join(root, "scripts/verify-vercel-build.mjs"));

  return {
    crons: INTERNAL_CRONS.length,
    adminRoutes: PROTECTED_ADMIN_ROUTES.length,
    operationalRoutes: PROTECTED_OPERATIONAL_ROUTES.length,
    internalRoutes: actualRouteFiles.length,
    releaseEndpoints: 2,
  };
}

async function listTypeScriptFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listTypeScriptFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(entryPath);
  }
  return files;
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const result = await validateVercelContract();
  console.log(
    `PASS: Vercel contract covers ${result.crons} crons, ${result.adminRoutes} protected admin routes, ${result.operationalRoutes} protected operational routes, ${result.internalRoutes} internal routes, and ${result.releaseEndpoints} release endpoints.`,
  );
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

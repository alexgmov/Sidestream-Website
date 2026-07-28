#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

const VERSION_URL = "https://sidestream.tv/version.json";
const CHECKOUT_URL = "https://sidestream.tv/api/checkout/start";

export async function verifyLiveProduction({
  expectedSha,
  fetchImpl = fetch,
}) {
  const versionResponse = await fetchImpl(VERSION_URL, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!versionResponse.ok) {
    throw new Error(`Live version check failed with ${versionResponse.status}`);
  }
  const version = await versionResponse.json();
  if (version?.gitSha !== expectedSha) {
    throw new Error(
      `Canonical Production reports ${version?.gitSha || "no SHA"}; expected ${expectedSha}`,
    );
  }

  const checkoutResponse = await fetchImpl(CHECKOUT_URL, {
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const location = checkoutResponse.headers.get("location") || "";
  if (![302, 303, 307, 308].includes(checkoutResponse.status)) {
    throw new Error(
      `Live Checkout returned ${checkoutResponse.status}; expected a server redirect without intermediate HTML`,
    );
  }
  if (!location.includes("/api/auth/google/start") && !location.startsWith("https://checkout.stripe.com/")) {
    throw new Error(`Live Checkout redirected to an unexpected location: ${location || "missing"}`);
  }
  return {
    gitSha: expectedSha,
    checkoutStatus: checkoutResponse.status,
    checkoutLocation: location,
  };
}

async function main() {
  const expectedSha = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const result = await verifyLiveProduction({ expectedSha });
  console.log(
    `PASS: sidestream.tv reports ${result.gitSha} and Checkout redirects with ${result.checkoutStatus}.`,
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

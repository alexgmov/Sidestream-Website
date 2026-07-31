#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatOfferDecimal,
  formatOfferPrice,
  SIDESTREAM_PRICING_CONTRACT,
} from "../config/pricing-contract.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const globalOffer = SIDESTREAM_PRICING_CONTRACT.global;

function pricingSurfaces(offer) {
  const globalDisplay = formatOfferPrice(offer);
  const globalDecimal = formatOfferDecimal(offer);
  return [
  {
    path: "index.html",
    transform(source) {
      let output = source.replace(
        /("name": "Sidestream Unlimited",\s*"price": ")[^"]+("[\s\S]*?"priceSpecification": \{\s*"@type": "UnitPriceSpecification",\s*"price": ")[^"]+("\s*,\s*"priceCurrency": "USD")/g,
        (_match, beforePrice, beforeSpecificationPrice, afterPrice) =>
          `${beforePrice}${globalDecimal}${beforeSpecificationPrice}${globalDecimal}${afterPrice}`,
      );
      output = output.replace(
        /(<span class="amt" data-checkout-offer-price aria-live="polite">)[^<]+(<\/span>)/,
        (_match, beforePrice, afterPrice) => `${beforePrice}${globalDisplay}${afterPrice}`,
      );
      return output;
    },
  },
  {
    path: "public/llms.txt",
    transform(source) {
      return source.replace(
        /(Sidestream Unlimited as a )[^ ]+( one-time paid upgrade)/,
        (_match, beforePrice, afterPrice) => `${beforePrice}${globalDisplay}${afterPrice}`,
      );
    },
  },
  ];
}

export async function getPricingSurfaceResults(offer = globalOffer) {
  return Promise.all(pricingSurfaces(offer).map(async (surface) => {
    const absolutePath = path.join(repositoryRoot, surface.path);
    const actual = await readFile(absolutePath, "utf8");
    const expected = surface.transform(actual);
    return { ...surface, absolutePath, actual, expected };
  }));
}

async function run() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check") || args.length > 1) {
    throw new Error("Usage: node scripts/sync-pricing-contract.mjs [--check]");
  }
  const check = args[0] === "--check";
  const results = await getPricingSurfaceResults();
  const stale = results.filter((result) => result.actual !== result.expected);
  if (check && stale.length) {
    throw new Error(
      `Pricing surfaces are stale: ${stale.map((result) => result.path).join(", ")}. Run npm run pricing:sync.`,
    );
  }
  if (check) {
    console.log("Pricing surfaces match the canonical contract.");
    return;
  }
  await Promise.all(stale.map((result) => writeFile(result.absolutePath, result.expected)));
  console.log(stale.length
    ? `Updated ${stale.map((result) => result.path).join(", ")}.`
    : "Pricing surfaces already match the canonical contract.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  formatOfferDecimal,
  formatOfferPrice,
  SIDESTREAM_PRICING_CONTRACT,
} from "../config/pricing-contract.mjs";
import { getPricingSurfaceResults } from "../scripts/sync-pricing-contract.mjs";

const repositoryRoot = new URL("..", import.meta.url);

test("one contract owns Free, global, India, and Stripe lookup truth", () => {
  const contract = SIDESTREAM_PRICING_CONTRACT;
  assert.equal(contract.free.amountMinor, 0);
  assert.equal(formatOfferPrice(contract.free), "$0");
  assert.equal(formatOfferPrice(contract.global), "$24.99");
  assert.equal(formatOfferDecimal(contract.global), "24.99");
  assert.equal(contract.global.lookupKey, "sidestream_pro_once_2499");
  assert.equal(formatOfferPrice(contract.india), "₹799");
  assert.equal(contract.india.priceSource.variable, "SIDESTREAM_PRO_INDIA_PRICE_ID");
  assert.deepEqual(contract.checkoutCatalog, [contract.india, contract.global]);
});

test("ordinary Upgrade and paid acquisition both enter the shared offer resolver", async () => {
  const [ordinaryCheckout, paidCheckout, account] = await Promise.all([
    readFile(new URL("api/checkout/start.ts", repositoryRoot), "utf8"),
    readFile(new URL("api/paid-acquisition/checkout.ts", repositoryRoot), "utf8"),
    readFile(new URL("api/_lib/account.ts", repositoryRoot), "utf8"),
  ]);
  assert.match(ordinaryCheckout, /createCheckoutIntent\(\{[\s\S]*buyerCountry: getTrustedCheckoutCountry/);
  assert.match(paidCheckout, /createCheckoutIntentConfirmation\(\{[\s\S]*buyerCountry: getTrustedCheckoutCountry/);
  assert.match(account, /selectCheckoutOffer\(buyerCountry\)/);
  assert.match(account, /SIDESTREAM_GLOBAL_CHECKOUT_OFFER\.lookupKey/);
});

test("a hypothetical $14.99 contract makes every generated public surface fail the drift check", async () => {
  const hypothetical = {
    ...SIDESTREAM_PRICING_CONTRACT.global,
    amountMinor: 1499,
    lookupKey: "sidestream_pro_once_1499",
  };
  const results = await getPricingSurfaceResults(hypothetical);
  assert.deepEqual(
    results.filter((result) => result.actual !== result.expected).map((result) => result.path),
    ["index.html", "public/llms.txt"],
  );
  assert.match(results[0].expected, /\$14\.99/);
  assert.match(results[0].expected, /"price": "14\.99"/);
  assert.match(results[1].expected, /\$14\.99 one-time paid upgrade/);
});

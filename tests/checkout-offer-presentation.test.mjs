import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { invokeHandler } from "./helpers/http.mjs";

const INDIA_PRICE_ENV = "SIDESTREAM_PRO_INDIA_PRICE_ID";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
let handler;
let temporaryModuleDirectory;

before(async () => {
  temporaryModuleDirectory = await mkdtemp(
    join(repositoryRoot, "tests", ".checkout-offer-presentation-"),
  );
  const routePath = join(repositoryRoot, "api", "checkout", "offer.ts");
  const checkoutOffersUrl = pathToFileURL(
    join(repositoryRoot, "api", "_lib", "checkout-offers.ts"),
  ).href;
  const source = (await readFile(routePath, "utf8")).replace(
    "../_lib/checkout-offers.js",
    checkoutOffersUrl,
  );
  const modulePath = join(temporaryModuleDirectory, "offer-under-test.ts");
  await writeFile(modulePath, source, { mode: 0o600 });
  ({ default: handler } = await import(pathToFileURL(modulePath).href));
});

after(async () => {
  if (temporaryModuleDirectory) {
    await rm(temporaryModuleDirectory, { recursive: true, force: true });
  }
});

test("the public offer presentation uses only the trusted country header", async () => {
  const previous = process.env[INDIA_PRICE_ENV];
  process.env[INDIA_PRICE_ENV] = "price_india";
  try {
    const india = await invokeHandler(handler, {
      url: "/api/checkout/offer?country=US&currency=USD&amount=1",
      headers: { "x-vercel-ip-country": "IN" },
    });
    assert.equal(india.response.statusCode, 200);
    assert.deepEqual(india.response.json, {
      formattedPrice: "₹799",
      currency: "INR",
    });
    assert.equal(
      india.response.getHeader("cache-control"),
      "private, no-store, max-age=0",
    );
    assert.equal(india.response.getHeader("vary"), "x-vercel-ip-country");
    assert.doesNotMatch(india.response.body, /price_india|sidestream-unlimited-india/);

    const forged = await invokeHandler(handler, {
      url: "/api/checkout/offer?country=IN&currency=INR&amount=79900",
      headers: { "x-vercel-ip-country": "US" },
    });
    assert.deepEqual(forged.response.json, {
      formattedPrice: "$24.99",
      currency: "USD",
    });
  } finally {
    restoreEnvironment(previous);
  }
});

test("India safely receives the global presentation without its approved Price", async () => {
  const previous = process.env[INDIA_PRICE_ENV];
  delete process.env[INDIA_PRICE_ENV];
  try {
    const result = await invokeHandler(handler, {
      headers: { "x-vercel-ip-country": "IN" },
    });
    assert.deepEqual(result.response.json, {
      formattedPrice: "$24.99",
      currency: "USD",
    });
  } finally {
    restoreEnvironment(previous);
  }
});

test("the presentation route supports HEAD and rejects writes", async () => {
  const head = await invokeHandler(handler, {
    method: "HEAD",
    headers: { "x-vercel-ip-country": "US" },
  });
  assert.equal(head.response.statusCode, 200);
  assert.equal(head.response.body, "");
  assert.ok(Number(head.response.getHeader("content-length")) > 0);

  const post = await invokeHandler(handler, {
    method: "POST",
    body: { country: "IN", amountMinor: 79900 },
  });
  assert.equal(post.response.statusCode, 405);
  assert.equal(post.response.getHeader("allow"), "GET, HEAD");
});

test("the landing page renders a global fallback and updates text only", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(
    html,
    /data-checkout-offer-price aria-live="polite">\$24\.99<\/span>/,
  );
  assert.match(html, /fetch\("\/api\/checkout\/offer"/);
  assert.match(
    html,
    /checkoutOfferPrices\.forEach\(\(price\) => \{\s*price\.textContent = offer\.formattedPrice/,
  );
  assert.doesNotMatch(
    html,
    /checkout\/start[^"'`\n]*(?:country|currency|amount|offer|price)/i,
  );
});

function restoreEnvironment(previous) {
  if (previous === undefined) delete process.env[INDIA_PRICE_ENV];
  else process.env[INDIA_PRICE_ENV] = previous;
}

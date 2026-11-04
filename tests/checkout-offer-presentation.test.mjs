import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { invokeHandler } from "./helpers/http.mjs";

const INDIA_PRICE_ENV = "SIDESTREAM_PRO_INDIA_PRICE_ID";
const BRAZIL_PRICE_ENV = "SIDESTREAM_PRO_BRAZIL_PRICE_ID";
const SOUTH_KOREA_PRICE_ENV = "SIDESTREAM_PRO_SOUTH_KOREA_PRICE_ID";
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
  const previousBrazil = process.env[BRAZIL_PRICE_ENV];
  const previousSouthKorea = process.env[SOUTH_KOREA_PRICE_ENV];
  process.env[INDIA_PRICE_ENV] = "price_india";
  process.env[BRAZIL_PRICE_ENV] = "price_brazil";
  process.env[SOUTH_KOREA_PRICE_ENV] = "price_south_korea";
  try {
    const india = await invokeHandler(handler, {
      url: "/api/checkout/offer?country=US&currency=USD&amount=1",
      headers: { "x-vercel-ip-country": "IN" },
    });
    assert.equal(india.response.statusCode, 200);
    assert.deepEqual(india.response.json, {
      formattedPrice: "₹499",
      currency: "INR",
      billingCadence: "one_time",
    });
    assert.equal(
      india.response.getHeader("cache-control"),
      "private, no-store, max-age=0",
    );
    assert.equal(india.response.getHeader("vary"), "x-vercel-ip-country");
    assert.doesNotMatch(india.response.body, /price_india|sidestream-unlimited-india/);

    const forged = await invokeHandler(handler, {
      url: "/api/checkout/offer?country=IN&currency=INR&amount=49900",
      headers: { "x-vercel-ip-country": "US" },
    });
    assert.deepEqual(forged.response.json, {
      formattedPrice: "$39.99",
      currency: "USD",
      billingCadence: "one_time",
    });

    const brazil = await invokeHandler(handler, {
      url: "/api/checkout/offer?country=US&currency=USD&amount=1",
      headers: { "x-vercel-ip-country": "BR" },
    });
    assert.deepEqual(brazil.response.json, {
      formattedPrice: "R$ 25",
      currency: "BRL",
      billingCadence: "one_time",
    });
    assert.doesNotMatch(brazil.response.body, /price_brazil|sidestream-unlimited-brazil/);

    const southKorea = await invokeHandler(handler, {
      url: "/api/checkout/offer?country=US&currency=USD&amount=1",
      headers: { "x-vercel-ip-country": "KR" },
    });
    assert.deepEqual(southKorea.response.json, {
      formattedPrice: "₩24,900",
      currency: "KRW",
      billingCadence: "one_time",
    });
    assert.doesNotMatch(
      southKorea.response.body,
      /price_south_korea|sidestream-unlimited-south-korea/,
    );
  } finally {
    restoreEnvironment(previous);
    restoreNamedEnvironment(BRAZIL_PRICE_ENV, previousBrazil);
    restoreNamedEnvironment(SOUTH_KOREA_PRICE_ENV, previousSouthKorea);
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
      formattedPrice: "$39.99",
      currency: "USD",
      billingCadence: "one_time",
    });
  } finally {
    restoreEnvironment(previous);
  }
});

test("the plan chooser presents exact capabilities and trusted regional one-time pricing", async () => {
  const variables = [INDIA_PRICE_ENV, BRAZIL_PRICE_ENV, SOUTH_KOREA_PRICE_ENV];
  const previous = variables.map((name) => process.env[name]);
  variables.forEach((name, index) => { process.env[name] = `price_region_${index}`; });
  try {
    for (const [country, formattedPrice, currency] of [
      ["US", "$39.99", "USD"],
      ["IN", "₹499", "INR"],
      ["BR", "R$ 25", "BRL"],
      ["KR", "₩24,900", "KRW"],
    ]) {
      const result = await invokeHandler(handler, {
        url: "/api/checkout/offer?view=plans&country=IN&currency=EUR&amount=1&price=price_forged&plan=free&billingCadence=year",
        headers: { "x-vercel-ip-country": country },
      });
      assert.equal(result.response.statusCode, 200);
      assert.deepEqual(result.response.json, {
        plans: {
          free: {
            id: "free", name: "Free", formattedPrice: "$0", currency: "USD",
            billingCadence: "free", downloadLimit: 10, maxVideoHeight: 1080,
            socialDownloads: false,
          },
          pro_monthly: {
            id: "pro_monthly", name: "Pro", formattedPrice: "$9.99", currency: "USD",
            billingCadence: "month", downloadLimit: null, maxVideoHeight: 2160,
            socialDownloads: false,
          },
          unlimited_one_time: {
            id: "unlimited_one_time", name: "Unlimited", formattedPrice, currency,
            billingCadence: "one_time", downloadLimit: null, maxVideoHeight: 2160,
            socialDownloads: true,
          },
        },
      });
      assert.equal(result.response.getHeader("cache-control"), "private, no-store, max-age=0");
      assert.equal(result.response.getHeader("vary"), "x-vercel-ip-country");
      assert.doesNotMatch(result.response.body, /price_region_|price_forged|prod_|stripe/i);
    }

    delete process.env[INDIA_PRICE_ENV];
    const fallback = await invokeHandler(handler, {
      url: "/api/checkout/offer?view=plans&country=IN&currency=INR&amount=49900",
      headers: { "x-vercel-ip-country": "IN" },
    });
    assert.equal(fallback.response.json.plans.unlimited_one_time.formattedPrice, "$39.99");
    assert.equal(fallback.response.json.plans.unlimited_one_time.currency, "USD");
    assert.equal(fallback.response.json.plans.pro_monthly.formattedPrice, "$9.99");

    const head = await invokeHandler(handler, {
      method: "HEAD", url: "/api/checkout/offer?view=plans",
    });
    assert.equal(head.response.statusCode, 200);
    assert.equal(head.response.body, "");
    assert.ok(Number(head.response.getHeader("content-length")) > 0);
  } finally {
    variables.forEach((name, index) => restoreNamedEnvironment(name, previous[index]));
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
    body: { country: "IN", amountMinor: 49900 },
  });
  assert.equal(post.response.statusCode, 405);
  assert.equal(post.response.getHeader("allow"), "GET, HEAD");
});

test("the landing page renders a global fallback and updates text only", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(
    html,
    /data-checkout-offer-price aria-live="polite">\$39\.99<\/span>/,
  );
  assert.match(html, /data-checkout-offer-cadence>one-time<\/span>/);
  assert.match(html, /data-checkout-offer-annual-term hidden>Renews automatically/);
  assert.match(html, /\.plan li\[hidden\] \{ display: none; \}/);
  assert.match(html, /Cancel anytime from your Sidestream account/);
  assert.match(html, /fetch\("\/api\/checkout\/offer"/);
  assert.match(
    html,
    /checkoutOfferPrices\.forEach\(\(price\) => \{\s*price\.textContent = offer\.formattedPrice/,
  );
  assert.match(html, /offer\.billingCadence === "year" \? "per year" : "one-time"/);
  assert.match(html, /term\.hidden = offer\.billingCadence !== "year"/);
  assert.doesNotMatch(
    html,
    /checkout\/start[^"'`\n]*(?:country|currency|amount|offer|price)/i,
  );
});

function restoreEnvironment(previous) {
  restoreNamedEnvironment(INDIA_PRICE_ENV, previous);
}

function restoreNamedEnvironment(name, previous) {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

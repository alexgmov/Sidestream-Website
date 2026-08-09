import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadInjectedHandler } from "./helpers/handler-loader.mjs";
import { invokeHandler } from "./helpers/http.mjs";

const paidThankYouUrl = new URL("../paid-thank-you.html", import.meta.url);
const originalThankYouUrl = new URL("../thank-you.html", import.meta.url);
const accountSourceUrl = new URL("../api/_lib/account.ts", import.meta.url);

test("paid thank-you is a phone-first computer and email handoff", async () => {
  const html = await readFile(paidThankYouUrl, "utf8");

  assert.match(html, /<meta name="robots" content="noindex, nofollow" \/>/);
  assert.match(html, /Finish setup on your computer\./);
  assert.doesNotMatch(html, /Payment complete/);
  assert.doesNotMatch(html, /class="complete"/);
  assert.doesNotMatch(html, /Do not download Sidestream to this phone\./);
  assert.doesNotMatch(html, /class="phone-note"/);
  assert.match(html, /“Sidestream Unlimited”/);
  assert.match(html, /same email you used at Checkout/);
  assert.doesNotMatch(html, /You are finished on this phone\./);
  assert.doesNotMatch(html, /Your receipt comes from Stripe\./);
  assert.doesNotMatch(html, /class="done"/);
  assert.doesNotMatch(html, /href="\/api\/download|Download latest/);
});

test("the original thank-you page and ordinary recovery copy remain intact", async () => {
  const html = await readFile(originalThankYouUrl, "utf8");

  assert.match(html, /Return to Premiere/);
  assert.match(html, /Still seeing Free/);
  assert.match(html, /Upgrade or Restore Purchase/);
  assert.match(html, /You won’t be charged again/);
  assert.match(html, /href="\/api\/download">Download latest/);
  assert.doesNotMatch(html, /Finish setup on your computer/);
});

test("Checkout completion routes only server-verified paid acquisition to the new page", async () => {
  for (const [paidAcquisition, expectedPath] of [
    [true, "/paid-thank-you.html"],
    [false, "/thank-you.html"],
    [undefined, "/thank-you.html"],
  ]) {
    const handler = await loadCompleteHandler(paidAcquisition);
    const result = await invokeHandler(handler, {
      method: "GET",
      url: "/api/checkout/complete?session_id=cs_verified",
    });

    assert.equal(result.response.statusCode, 303);
    const destination = new URL(result.response.getHeader("location"));
    assert.equal(destination.pathname, expectedPath);
    assert.equal(destination.searchParams.get("checkout"), "success");
  }

  const accountSource = await readFile(accountSourceUrl, "utf8");
  assert.match(
    accountSource,
    /paidAcquisition:\s*paidAcquisitionCheckout/,
  );
});

async function loadCompleteHandler(paidAcquisition) {
  return loadInjectedHandler(
    new URL("../api/checkout/complete.ts", import.meta.url),
    {
      "../_lib/account.js": {
        cleanString(value, maxLength) {
          return typeof value === "string"
            ? value.trim().slice(0, maxLength)
            : "";
        },
        async fulfillCheckoutSession() {
          return {
            fulfilled: true,
            activationBound: false,
            paidAcquisition,
          };
        },
        getBaseUrl() {
          return "https://sidestream.test";
        },
        methodNotAllowed(response, allowed) {
          response.statusCode = 405;
          response.setHeader("Allow", allowed);
          response.end();
        },
        redirect(response, location, statusCode = 303) {
          response.statusCode = statusCode;
          response.setHeader("Location", location);
          response.end();
        },
        sendJson(response, statusCode, payload) {
          response.statusCode = statusCode;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify(payload));
        },
      },
    },
  );
}

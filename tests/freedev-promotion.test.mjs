import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("FREEDEV creates a promotion code with Stripe's current coupon envelope", async () => {
  const source = await readFile(
    new URL("../scripts/ensure-freedev-promo.mjs", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /promotionCodes\.create\(\{/,
  );
  assert.match(
    source,
    /promotion:\s*\{\s*type:\s*["']coupon["']\s*,\s*coupon:\s*coupon\.id\s*,?\s*\}/,
  );
  assert.doesNotMatch(
    source,
    /promotionCodes\.create\(\{\s*coupon:\s*coupon\.id/,
  );
  assert.match(source, /promotionCode\.promotion\?\.type\s*===\s*["']coupon["']/);
});

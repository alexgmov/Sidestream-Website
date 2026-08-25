import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  getConfiguredDownloadCreditPack,
  isDownloadCreditServiceEnabled,
  serializeDownloadCreditPack,
} from "../api/_lib/download-credit-pack.ts";

const files = {
  helper: new URL("../api/_lib/download-credits.ts", import.meta.url),
  completion: new URL("../credit-complete.html", import.meta.url),
  response: new URL("../api/_lib/download-credit-response.ts", import.meta.url),
  sync: new URL("../api/credits/sync.ts", import.meta.url),
  reserve: new URL("../api/credits/reserve.ts", import.meta.url),
  finalize: new URL("../api/credits/finalize.ts", import.meta.url),
  purchase: new URL("../api/credits/purchase.ts", import.meta.url),
  stripeEvents: new URL("../api/_lib/stripe-events.ts", import.meta.url),
};

test("server credit helper owns starter grants, costs, and atomic lifecycle", async () => {
  const source = await readFile(files.helper, "utf8");
  assert.match(source, /STARTER_DOWNLOAD_CREDITS = 1_000/);
  assert.match(source, /video: 100/);
  assert.match(source, /audio: 100/);
  assert.match(source, /CREDIT_RESERVATION_TTL_DAYS = 7/);
  assert.match(source, /hashPrivateIdentifier\(deviceId\)/);
  assert.match(source, /pg_advisory_xact_lock/);
  assert.match(source, /await client\.query\("begin"\)/);
  assert.match(source, /await client\.query\("commit"\)/);
  assert.match(source, /await client\.query\("rollback"\)/);
  assert.match(source, /'starter_grant'/);
  assert.match(source, /'legacy_usage_import'/);
  assert.match(source, /'download_reserved'/);
  assert.match(source, /'download_committed'/);
  assert.match(source, /'download_released'/);
  assert.match(source, /'download_expired'/);
  assert.match(source, /available_credits >= \$2/);
  assert.match(source, /allowed: existing\.status === "reserved"/);
  assert.match(source, /stripeCheckoutSessionId/);
  assert.match(source, /'purchase_grant'/);
  assert.match(source, /sidestream_purchase_kind: "download_credit_pack"/);
  assert.match(source, /session\.payment_status !== "paid"/);
  assert.match(source, /session\.livemode !== \(environment\.namespace === "production"\)/);
  assert.match(source, /grantPurchasedDownloadCreditsForWallet/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|sidestream\.downloadCredits/);
});

test("credit pack configuration is explicit and omits Stripe identity from client payloads", () => {
  assert.equal(isDownloadCreditServiceEnabled({}), false);
  assert.equal(isDownloadCreditServiceEnabled({
    SIDESTREAM_DOWNLOAD_CREDITS_ENABLED: "1",
  }), true);
  assert.equal(isDownloadCreditServiceEnabled({
    SIDESTREAM_DOWNLOAD_CREDITS_ENABLED: "true",
  }), false);
  assert.equal(getConfiguredDownloadCreditPack({}), null);
  assert.equal(getConfiguredDownloadCreditPack({
    SIDESTREAM_CREDIT_PACK_PRICE_ID: "price_too_short",
    SIDESTREAM_CREDIT_PACK_CREDITS: "1000",
  }), null);
  const pack = getConfiguredDownloadCreditPack({
    SIDESTREAM_CREDIT_PACK_PRICE_ID: "price_1234567890",
    SIDESTREAM_CREDIT_PACK_CREDITS: "1500",
    SIDESTREAM_CREDIT_PACK_LABEL: "1,500 more credits",
  });
  assert.equal(pack, null);
  const approvedPack = getConfiguredDownloadCreditPack({
    SIDESTREAM_CREDIT_PACK_PRICE_ID: "price_1234567890",
    SIDESTREAM_CREDIT_PACK_CREDITS: "1000",
    SIDESTREAM_CREDIT_PACK_LABEL: "ignored browser-facing override",
  });
  assert.deepEqual(approvedPack, {
    key: "standard",
    credits: 1000,
    label: "1,000 more credits",
    currency: "usd",
    unitAmountMinor: 499,
    priceLabel: "$4.99 one-time",
    priceId: "price_1234567890",
  });
  assert.deepEqual(serializeDownloadCreditPack(approvedPack), {
    key: "standard",
    credits: 1000,
    label: "1,000 more credits",
    priceLabel: "$4.99 one-time",
  });
});

test("credit APIs are namespace-bound, rate-limited, and identity-minimal", async () => {
  const sources = await Promise.all([
    readFile(files.sync, "utf8"),
    readFile(files.reserve, "utf8"),
    readFile(files.finalize, "utf8"),
  ]);
  for (const source of sources) {
    assert.match(source, /if \(\(request\.method \|\| "POST"\)\.toUpperCase\(\) !== "POST"\)/);
    assert.match(source, /resolveRequestLicenseEnvironment\(request\)/);
    assert.match(source, /isDownloadCreditServiceEnabled\(\)/);
    assert.match(source, /cleanString\(payload\.deviceId, 240\)/);
    assert.match(source, /consumeRateLimit/);
    assert.match(source, /credits_unavailable/);
    assert.doesNotMatch(source, /account(Id|_id)\s*:/i);
    assert.doesNotMatch(source, /device(Id|_id|Hash)\s*:/i);
  }
  assert.match(sources[1], /normalizeCreditReservationKey/);
  assert.match(sources[1], /normalizeDownloadCreditFormat/);
  assert.match(sources[2], /value === "committed" \|\| value === "released"/);
});

test("credit responses expose balances and reservation state without wallet identity", async () => {
  const source = await readFile(files.response, "utf8");
  for (const field of [
    "availableCredits",
    "reservedCredits",
    "totalGrantedCredits",
    "totalSpentCredits",
    "starterCredits",
    "costs",
    "reservationKey",
    "reservationStatus",
    "creditCost",
  ]) {
    assert.match(source, new RegExp(`\\b${field}\\b`));
  }
  assert.doesNotMatch(source, /wallet(Id|_id)|account(Id|_id)|device(Id|_id|Hash)/i);
});

test("credit Checkout is exact-priced, rate-limited, and fulfilled only by signed Stripe events", async () => {
  const [helper, purchase, stripeEvents, completion] = await Promise.all([
    readFile(files.helper, "utf8"),
    readFile(files.purchase, "utf8"),
    readFile(files.stripeEvents, "utf8"),
    readFile(files.completion, "utf8"),
  ]);
  assert.match(helper, /price\.currency !== pack\.currency/);
  assert.match(helper, /price\.unit_amount !== pack\.unitAmountMinor/);
  assert.match(purchase, /getConfiguredDownloadCreditPack\(\)/);
  assert.match(purchase, /createDownloadCreditPackCheckout/);
  assert.match(purchase, /scope: "credits:purchase"/);
  assert.match(purchase, /credit_purchases_unavailable/);
  assert.match(purchase, /credit-complete\.html\?status=success/);
  assert.match(purchase, /credit-complete\.html\?status=cancelled/);
  assert.doesNotMatch(purchase, /price(Id|_id)\s*:\s*payload/i);
  assert.match(stripeEvents, /fulfillDownloadCreditPackCheckout\(event\.data\.object, environment\)/);
  assert.match(stripeEvents, /credit_pack_purchase_granted/);
  assert.match(completion, /Credits added/);
  assert.match(completion, /Purchase cancelled/);
  assert.match(completion, /return to Sidestream/i);
});

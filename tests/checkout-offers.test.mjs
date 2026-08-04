import assert from "node:assert/strict";
import test from "node:test";
import {
  SIDESTREAM_CHECKOUT_OFFER_CATALOG,
  getCheckoutOfferPresentation,
  getTrustedCheckoutCountry,
  selectCheckoutOffer,
} from "../api/_lib/checkout-offers.ts";
import {
  verifyApprovedCheckoutPurchase,
} from "../api/_lib/entitlement.ts";

const GLOBAL = {
  sessionId: "cs_global",
  acquisitionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  intentId: "11111111-1111-4111-8111-111111111111",
  accountId: "22222222-2222-4222-8222-222222222222",
  offerId: "sidestream-unlimited-global",
  country: "US",
  currency: "usd",
  amountMinor: 1999,
  priceId: "price_global",
  productId: "prod_sidestream",
  paidPlanKeys: ["sidestream_pro", "sidestream_unlimited"],
};

const INDIA = {
  ...GLOBAL,
  sessionId: "cs_india",
  intentId: "33333333-3333-4333-8333-333333333333",
  offerId: "sidestream-unlimited-india",
  country: "IN",
  currency: "inr",
  amountMinor: 49900,
  priceId: "price_india",
};

const BRAZIL = {
  ...GLOBAL,
  sessionId: "cs_brazil",
  intentId: "44444444-4444-4444-8444-444444444444",
  offerId: "sidestream-unlimited-brazil",
  country: "BR",
  currency: "brl",
  amountMinor: 2500,
  priceId: "price_brazil",
};

const SOUTH_KOREA = {
  ...GLOBAL,
  sessionId: "cs_south_korea",
  intentId: "55555555-5555-4555-8555-555555555555",
  offerId: "sidestream-unlimited-south-korea",
  country: "KR",
  currency: "krw",
  amountMinor: 24900,
  priceId: "price_south_korea",
};

test("the server-owned catalog selects regional offers only from configured trusted country state", () => {
  assert.deepEqual(
    SIDESTREAM_CHECKOUT_OFFER_CATALOG.map((entry) => entry.offerId),
    [
      "sidestream-unlimited-india",
      "sidestream-unlimited-brazil",
      "sidestream-unlimited-south-korea",
      "sidestream-unlimited-global",
    ],
  );
  assert.deepEqual(
    SIDESTREAM_CHECKOUT_OFFER_CATALOG.map((entry) => [
      entry.currency,
      entry.amountMinor,
    ]),
    [["inr", 49900], ["brl", 2500], ["krw", 24900], ["usd", 1999]],
  );
  assert.equal(
    selectCheckoutOffer("IN", {}).entry.offerId,
    "sidestream-unlimited-global",
  );
  assert.equal(
    selectCheckoutOffer("IN", {
      SIDESTREAM_PRO_INDIA_PRICE_ID: "price_india",
    }).entry.offerId,
    "sidestream-unlimited-india",
  );
  assert.equal(
    selectCheckoutOffer("US", {
      SIDESTREAM_PRO_INDIA_PRICE_ID: "price_india",
    }).entry.offerId,
    "sidestream-unlimited-global",
  );
  assert.equal(
    selectCheckoutOffer("BR", {
      SIDESTREAM_PRO_BRAZIL_PRICE_ID: "price_brazil",
    }).entry.offerId,
    "sidestream-unlimited-brazil",
  );
  assert.equal(
    selectCheckoutOffer("BR", {}).entry.offerId,
    "sidestream-unlimited-global",
  );
  assert.equal(
    selectCheckoutOffer("KR", {
      SIDESTREAM_PRO_SOUTH_KOREA_PRICE_ID: "price_south_korea",
    }).entry.offerId,
    "sidestream-unlimited-south-korea",
  );
  assert.equal(
    selectCheckoutOffer("KR", {}).entry.offerId,
    "sidestream-unlimited-global",
  );
  assert.equal(getTrustedCheckoutCountry({ "x-vercel-ip-country": " in " }), "IN");
  assert.equal(getTrustedCheckoutCountry({ "x-vercel-ip-country": "forged" }), "ZZ");
  assert.deepEqual(
    getCheckoutOfferPresentation("IN", {
      SIDESTREAM_PRO_INDIA_PRICE_ID: "price_india",
    }),
    { formattedPrice: "₹499", currency: "INR" },
  );
  assert.deepEqual(
    getCheckoutOfferPresentation("BR", {
      SIDESTREAM_PRO_BRAZIL_PRICE_ID: "price_brazil",
    }),
    { formattedPrice: "R$ 25", currency: "BRL" },
  );
  assert.deepEqual(
    getCheckoutOfferPresentation("KR", {
      SIDESTREAM_PRO_SOUTH_KOREA_PRICE_ID: "price_south_korea",
    }),
    { formattedPrice: "₩24,900", currency: "KRW" },
  );
  assert.deepEqual(
    getCheckoutOfferPresentation("IN", {}),
    { formattedPrice: "$19.99", currency: "USD" },
  );
});

test("global and regional purchases verify against their exact stored offer snapshots", () => {
  const globalSession = checkoutSession(GLOBAL);
  assert.deepEqual(
    verifyApprovedCheckoutPurchase(
      globalSession,
      { amountPaid: 1999, currency: "usd" },
      GLOBAL,
    ),
    { isApprovedPurchase: true },
  );

  const indiaSession = checkoutSession(INDIA);
  assert.deepEqual(
    verifyApprovedCheckoutPurchase(
      indiaSession,
      { amountPaid: 49900, currency: "inr" },
      INDIA,
    ),
    { isApprovedPurchase: true },
  );

  const brazilSession = checkoutSession(BRAZIL);
  assert.deepEqual(
    verifyApprovedCheckoutPurchase(
      brazilSession,
      { amountPaid: 2500, currency: "brl" },
      BRAZIL,
    ),
    { isApprovedPurchase: true },
  );

  const southKoreaSession = checkoutSession(SOUTH_KOREA);
  assert.deepEqual(
    verifyApprovedCheckoutPurchase(
      southKoreaSession,
      { amountPaid: 24900, currency: "krw" },
      SOUTH_KOREA,
    ),
    { isApprovedPurchase: true },
  );
});

test("forged regional metadata and cross-region Prices fail closed", () => {
  const indiaSession = checkoutSession(INDIA);
  const forgedCountry = {
    ...indiaSession,
    metadata: {
      ...indiaSession.metadata,
      sidestream_offer_country: "US",
    },
  };
  assert.equal(
    verifyApprovedCheckoutPurchase(
      forgedCountry,
      { amountPaid: 49900, currency: "inr" },
      INDIA,
    ).isApprovedPurchase,
    false,
  );

  const forgedAcquisition = {
    ...indiaSession,
    metadata: {
      ...indiaSession.metadata,
      sidestream_acquisition_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    },
  };
  assert.deepEqual(
    verifyApprovedCheckoutPurchase(
      forgedAcquisition,
      { amountPaid: 49900, currency: "inr" },
      INDIA,
    ),
    {
      isApprovedPurchase: false,
      reason: "acquisition_id_mismatch",
    },
  );

  const crossRegionPrice = {
    ...indiaSession,
    line_items: {
      data: [{
        quantity: 1,
        price: { id: "price_global", product: "prod_sidestream" },
      }],
      has_more: false,
    },
  };
  assert.deepEqual(
    verifyApprovedCheckoutPurchase(
      crossRegionPrice,
      { amountPaid: 49900, currency: "inr" },
      INDIA,
    ),
    {
      isApprovedPurchase: false,
      reason: "line_item_price_mismatch",
    },
  );
});

test("failed payment verification rejects while exact zero-total promotions remain valid", () => {
  const failed = {
    ...checkoutSession(GLOBAL),
    payment_status: "unpaid",
  };
  assert.deepEqual(
    verifyApprovedCheckoutPurchase(
      failed,
      { amountPaid: 1999, currency: "usd" },
      GLOBAL,
    ),
    {
      isApprovedPurchase: false,
      reason: "payment_incomplete",
    },
  );

  const promotedIndia = {
    ...checkoutSession(INDIA),
    payment_status: "no_payment_required",
    payment_intent: null,
    amount_total: 0,
    total_details: {
      amount_discount: INDIA.amountMinor,
      amount_shipping: 0,
      amount_tax: 0,
    },
  };
  assert.deepEqual(
    verifyApprovedCheckoutPurchase(promotedIndia, null, INDIA),
    { isApprovedPurchase: true },
  );
  assert.deepEqual(
    verifyApprovedCheckoutPurchase(
      { ...promotedIndia, currency: "usd" },
      null,
      INDIA,
    ),
    {
      isApprovedPurchase: false,
      reason: "offer_amount_session_currency",
    },
  );
});

function checkoutSession(offer) {
  return {
    id: offer.sessionId,
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    payment_intent: `pi_${offer.sessionId}`,
    amount_subtotal: offer.amountMinor,
    amount_total: offer.amountMinor,
    currency: offer.currency,
    total_details: {
      amount_discount: 0,
      amount_shipping: 0,
      amount_tax: 0,
    },
    metadata: {
      sidestream_acquisition_id: offer.acquisitionId,
      sidestream_plan: "sidestream_pro",
      sidestream_price_id: offer.priceId,
      sidestream_product_id: offer.productId,
      sidestream_checkout_intent_id: offer.intentId,
      sidestream_account_id: offer.accountId,
      sidestream_offer_id: offer.offerId,
      sidestream_offer_country: offer.country,
      sidestream_offer_currency: offer.currency,
      sidestream_offer_amount_minor: String(offer.amountMinor),
    },
    line_items: {
      data: [{
        quantity: 1,
        price: {
          id: offer.priceId,
          product: offer.productId,
        },
      }],
      has_more: false,
    },
  };
}

import path from "node:path";
import Stripe from "stripe";
import { readRegularFile } from "./lib/safe-file.mjs";

await loadEnvFile(process.env.SIDESTREAM_ENV_FILE);
await loadEnvFile(process.env.SIDESTREAM_STRIPE_ENV_FILE);

const PROMO_CODE = normalizePromotionCode(
  process.env.SIDESTREAM_FREEDEV_PROMO_CODE || "FREEDEV",
);
const COUPON_ID = process.env.SIDESTREAM_FREEDEV_COUPON_ID ||
  "sidestream_freedev_100";
const PRICE_LOOKUP_KEY = "sidestream_pro_once_999";
const replace = process.argv.includes("--replace");
const stripeSecretKey = requireEnv("STRIPE_SECRET_KEY");
const mode = "sandbox";

if (!/^sk_test_[A-Za-z0-9_]+$/.test(stripeSecretKey)) {
  fail("FREEDEV is sandbox-only and requires an sk_test_ Stripe key.");
}

const stripe = new Stripe(stripeSecretKey, { apiVersion: Stripe.API_VERSION });
const stripeAccountId = requireEnv("SIDESTREAM_STRIPE_ACCOUNT_ID");
const productId = requireEnv("SIDESTREAM_PRO_PRODUCT_ID");
const priceId = requireEnv("SIDESTREAM_PRO_PRICE_ID");
await verifyExactSandboxAccount(stripeAccountId);
await verifyExactSandboxProductAndPrice(productId, priceId);
const activePromotionCode = await findPromotionCode(true);

if (activePromotionCode) {
  const coupon = await getPromotionCodeCoupon(activePromotionCode);
  if (isFreedevCoupon(coupon, productId) && isFreedevPromotion(activePromotionCode)) {
    console.log(
      `FREEDEV promotion code already active in ${mode}: ${activePromotionCode.id}`,
    );
    process.exit(0);
  }

  if (!replace) {
    fail(
      `Active promotion code ${PROMO_CODE} already exists but is not a 100% once coupon. Re-run with --replace to deactivate it before creating the dev code.`,
    );
  }

  await stripe.promotionCodes.update(activePromotionCode.id, { active: false });
  console.log(`Deactivated conflicting promotion code: ${activePromotionCode.id}`);
}

const coupon = await getOrCreateFreedevCoupon();
const promotionCode = await stripe.promotionCodes.create({
  coupon: coupon.id,
  code: PROMO_CODE,
  active: true,
  metadata: {
    sidestream_purpose: "sandbox_free_dev_checkout",
    sidestream_price_lookup_key: PRICE_LOOKUP_KEY,
    sidestream_price_id: priceId,
    sidestream_product_id: productId,
    sidestream_stripe_account_id: stripeAccountId,
  },
});

console.log(`Created FREEDEV promotion code in ${mode}: ${promotionCode.id}`);

async function getOrCreateFreedevCoupon() {
  const existingCoupon = await retrieveCoupon(COUPON_ID);
  if (existingCoupon) {
    if (!isFreedevCoupon(existingCoupon, productId)) {
      fail(`Coupon ${COUPON_ID} exists but is not a 100% once coupon.`);
    }
    return existingCoupon;
  }

  const couponParams = {
    id: COUPON_ID,
    name: process.env.SIDESTREAM_FREEDEV_COUPON_NAME ||
      "Sidestream FREEDEV 100% off",
    percent_off: 100,
    duration: "once",
    metadata: {
      sidestream_purpose: "sandbox_free_dev_checkout",
      sidestream_price_lookup_key: PRICE_LOOKUP_KEY,
      sidestream_price_id: priceId,
      sidestream_product_id: productId,
      sidestream_stripe_account_id: stripeAccountId,
    },
    applies_to: { products: [productId] },
  };

  return stripe.coupons.create(couponParams);
}

async function verifyExactSandboxAccount(expectedAccountId) {
  if (!/^acct_[A-Za-z0-9_]{4,196}$/.test(expectedAccountId)) {
    fail("Configured Stripe Test account ID is invalid.");
  }
  const account = await stripe.accounts.retrieve();
  if (account.id !== expectedAccountId) {
    fail("Stripe key does not belong to the reviewed Test account.");
  }
}

async function verifyExactSandboxProductAndPrice(expectedProductId, expectedPriceId) {
  const [product, price] = await Promise.all([
    stripe.products.retrieve(expectedProductId),
    stripe.prices.retrieve(expectedPriceId),
  ]);
  if (product.deleted || !product.active || product.id !== expectedProductId) {
    fail("Configured FREEDEV Product is not the exact active Sidestream Pro Product.");
  }
  if (
    price.id !== expectedPriceId || !price.active ||
    normalizeStripeId(price.product) !== expectedProductId ||
    price.type !== "one_time" || price.recurring ||
    price.unit_amount !== 999 || price.currency !== "usd" ||
    price.lookup_key !== PRICE_LOOKUP_KEY
  ) {
    fail("Configured FREEDEV Price is not the exact active Sidestream Pro $9.99 one-time Price.");
  }
}

async function findPromotionCode(active) {
  const promotionCodes = await stripe.promotionCodes.list({
    code: PROMO_CODE,
    active,
    limit: 100,
  });
  return promotionCodes.data.find(
    (promotionCode) => promotionCode.code.toUpperCase() === PROMO_CODE,
  ) || null;
}

async function getPromotionCodeCoupon(promotionCode) {
  if (promotionCode.coupon && typeof promotionCode.coupon !== "string") {
    return promotionCode.coupon;
  }
  return stripe.coupons.retrieve(promotionCode.coupon);
}

async function retrieveCoupon(couponId) {
  try {
    return await stripe.coupons.retrieve(couponId);
  } catch (error) {
    if (isStripeMissingResource(error)) return null;
    throw error;
  }
}

function isFreedevCoupon(coupon, expectedProductId) {
  return Boolean(
    coupon &&
    coupon.valid !== false &&
    coupon.percent_off === 100 &&
    coupon.duration === "once" &&
    Array.isArray(coupon.applies_to?.products) &&
    coupon.applies_to.products.length === 1 &&
    coupon.applies_to.products[0] === expectedProductId &&
    coupon.metadata?.sidestream_purpose === "sandbox_free_dev_checkout" &&
    coupon.metadata?.sidestream_price_lookup_key === PRICE_LOOKUP_KEY &&
    coupon.metadata?.sidestream_price_id === priceId &&
    coupon.metadata?.sidestream_product_id === expectedProductId &&
    coupon.metadata?.sidestream_stripe_account_id === stripeAccountId,
  );
}

function isFreedevPromotion(promotionCode) {
  return promotionCode?.metadata?.sidestream_purpose === "sandbox_free_dev_checkout" &&
    promotionCode.metadata.sidestream_price_lookup_key === PRICE_LOOKUP_KEY &&
    promotionCode.metadata.sidestream_price_id === priceId &&
    promotionCode.metadata.sidestream_product_id === productId &&
    promotionCode.metadata.sidestream_stripe_account_id === stripeAccountId;
}

function normalizeStripeId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return typeof value.id === "string" ? value.id : "";
}

function normalizePromotionCode(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) fail("SIDESTREAM_FREEDEV_PROMO_CODE cannot be empty.");
  return normalized;
}

function getValidEnvValue(name) {
  const value = process.env[name]?.trim();
  if (!value || value.includes("[YOUR-") || value === "changeme") return "";
  return value;
}

function requireEnv(name) {
  const value = getValidEnvValue(name);
  if (!value) fail(`Missing ${name}.`);
  return value;
}

async function loadEnvFile(filePath) {
  if (!filePath) return;

  const absolutePath = path.resolve(filePath);
  let text = "";
  try {
    text = await readRegularFile(absolutePath, {
      maximumBytes: 64 * 1024,
      requirePrivate: true,
    });
  } catch (error) {
    fail(`Could not read env file ${absolutePath}: ${error.message}`);
  }

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.trim().replace(/^['"]|['"]$/g, "");
  }
}

function isStripeMissingResource(error) {
  return Boolean(
    error &&
    error.type === "StripeInvalidRequestError" &&
    (error.statusCode === 404 || /^No such /.test(error.message || "")),
  );
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

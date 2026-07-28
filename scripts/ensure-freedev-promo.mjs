import fs from "node:fs";
import path from "node:path";
import Stripe from "stripe";

loadEnvFile(process.env.SIDESTREAM_ENV_FILE);
loadEnvFile(process.env.SIDESTREAM_STRIPE_ENV_FILE);

const PROMO_CODE = normalizePromotionCode(
  process.env.SIDESTREAM_FREEDEV_PROMO_CODE || "FREEDEV",
);
const COUPON_ID = process.env.SIDESTREAM_FREEDEV_COUPON_ID ||
  "sidestream_freedev_100";
const PRICE_LOOKUP_KEY = "sidestream_pro_once_2499";
const SIDESTREAM_PRO_DEFAULT_PRODUCT_ID = "prod_UpwXh6oO1OmPyQ";
const allowLive = process.argv.includes("--allow-live");
const replace = process.argv.includes("--replace");
const skipLive = process.argv.includes("--skip-live");
const stripeSecretKey = requireEnv("STRIPE_SECRET_KEY");
const mode = stripeSecretKey.startsWith("sk_live_") ? "live" : "sandbox";

if (mode === "live" && !allowLive) {
  if (skipLive) {
    console.log("Skipping FREEDEV setup because STRIPE_SECRET_KEY is live mode.");
    process.exit(0);
  }
  fail("Refusing to create a FREEDEV promotion code with a live Stripe key. Use --allow-live only if this is intentional.");
}

const stripe = new Stripe(stripeSecretKey, { apiVersion: Stripe.API_VERSION });
const activePromotionCode = await findPromotionCode(true);

if (activePromotionCode) {
  const coupon = await getPromotionCodeCoupon(activePromotionCode);
  if (isFreedevCoupon(coupon)) {
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
  },
});

console.log(`Created FREEDEV promotion code in ${mode}: ${promotionCode.id}`);

async function getOrCreateFreedevCoupon() {
  const existingCoupon = await retrieveCoupon(COUPON_ID);
  if (existingCoupon) {
    if (!isFreedevCoupon(existingCoupon)) {
      fail(`Coupon ${COUPON_ID} exists but is not a 100% once coupon.`);
    }
    return existingCoupon;
  }

  const productId = await findSidestreamProProductId();
  const couponParams = {
    id: COUPON_ID,
    name: process.env.SIDESTREAM_FREEDEV_COUPON_NAME ||
      "Sidestream FREEDEV 100% off",
    percent_off: 100,
    duration: "once",
    metadata: {
      sidestream_purpose: "sandbox_free_dev_checkout",
      sidestream_price_lookup_key: PRICE_LOOKUP_KEY,
    },
  };

  if (productId) {
    couponParams.applies_to = { products: [productId] };
  } else {
    console.warn(
      `No active ${PRICE_LOOKUP_KEY} price found; creating FREEDEV coupon without a product restriction.`,
    );
  }

  return stripe.coupons.create(couponParams);
}

async function findSidestreamProProductId() {
  const configuredPriceId = getValidEnvValue("SIDESTREAM_PRO_PRICE_ID") ||
    getValidEnvValue("SIDESTREAM_UNLIMITED_PRICE_ID");
  if (configuredPriceId) {
    const price = await stripe.prices.retrieve(configuredPriceId);
    const productId = normalizeStripeId(price.product);
    if (productId) return productId;
  }

  const configuredProductId = getValidEnvValue("SIDESTREAM_PRO_PRODUCT_ID") ||
    SIDESTREAM_PRO_DEFAULT_PRODUCT_ID;
  const product = await retrieveProduct(configuredProductId);
  if (product?.active) return product.id;

  const prices = await stripe.prices.list({
    active: true,
    lookup_keys: [PRICE_LOOKUP_KEY],
    limit: 10,
  });
  const price = prices.data.find((item) => item.lookup_key === PRICE_LOOKUP_KEY);
  return price ? normalizeStripeId(price.product) : "";
}

async function retrieveProduct(productId) {
  try {
    const product = await stripe.products.retrieve(productId);
    return product && !product.deleted ? product : null;
  } catch (error) {
    if (isStripeMissingResource(error)) return null;
    throw error;
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

function isFreedevCoupon(coupon) {
  return Boolean(
    coupon &&
    coupon.valid !== false &&
    coupon.percent_off === 100 &&
    coupon.duration === "once",
  );
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

function loadEnvFile(filePath) {
  if (!filePath) return;

  const absolutePath = path.resolve(filePath);
  let text = "";
  try {
    text = fs.readFileSync(absolutePath, "utf8");
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

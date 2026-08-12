import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  selectCheckoutOffer,
  selectMonthlyCheckoutPrice,
} from "../api/_lib/checkout-offers.ts";
import {
  getCheckoutParametersFingerprint,
  getCheckoutSessionIdempotencyKey,
  getStripeRecurringPriceIdempotencyKey,
} from "../api/_lib/entitlement.ts";
import { SIDESTREAM_PRICING_CONTRACT } from "../config/pricing-contract.mjs";

test("regional monthly Price configuration follows only the trusted server-owned offer", () => {
  const environment = {
    SIDESTREAM_PRO_INDIA_PRICE_ID: "price_india_once",
    SIDESTREAM_PRO_INDIA_MONTHLY_PRICE_ID: "price_india_monthly",
  };
  const trusted = selectCheckoutOffer("IN", environment);
  assert.equal(trusted.entry, SIDESTREAM_PRICING_CONTRACT.india);
  assert.deepEqual(selectMonthlyCheckoutPrice(trusted.entry, environment), {
    kind: "environment",
    configuredPriceId: "price_india_monthly",
  });

  const forged = selectCheckoutOffer("browser-selected-country", environment);
  assert.equal(forged.entry, SIDESTREAM_PRICING_CONTRACT.global);
  assert.deepEqual(selectMonthlyCheckoutPrice(forged.entry, environment), {
    kind: "lookup",
    configuredPriceId: "",
  });
});

test("monthly Price and Checkout idempotency rotate across exact term and request changes", () => {
  const basePriceKey = getStripeRecurringPriceIdempotencyKey({
    productId: "prod_sidestream",
    currency: "usd",
    amountMinor: 999,
    interval: "month",
    intervalCount: 1,
    usageType: "licensed",
    livemode: false,
  });
  assert.equal(basePriceKey, getStripeRecurringPriceIdempotencyKey({
    productId: "prod_sidestream",
    currency: "usd",
    amountMinor: 999,
    interval: "month",
    intervalCount: 1,
    usageType: "licensed",
    livemode: false,
  }));
  assert.notEqual(basePriceKey, getStripeRecurringPriceIdempotencyKey({
    productId: "prod_sidestream",
    currency: "usd",
    amountMinor: 1099,
    interval: "month",
    intervalCount: 1,
    usageType: "licensed",
    livemode: false,
  }));

  const control = {
    mode: "payment",
    line_items: [{ price: "price_once", quantity: 1 }],
    metadata: { variant: "control_one_time" },
  };
  const monthly = {
    mode: "subscription",
    line_items: [{ price: "price_monthly", quantity: 1 }],
    metadata: { variant: "monthly_half" },
    subscription_data: { metadata: { variant: "monthly_half" } },
  };
  const checkoutKey = (parameters) => getCheckoutSessionIdempotencyKey({
    kind: "account",
    intentId: "11111111-1111-4111-8111-111111111111",
    attempt: 0,
    parametersFingerprint: getCheckoutParametersFingerprint(parameters),
  });
  assert.notEqual(checkoutKey(control), checkoutKey(monthly));
  assert.notEqual(
    checkoutKey(monthly),
    checkoutKey({
      ...monthly,
      line_items: [{ price: "price_monthly_v2", quantity: 1 }],
    }),
  );
});

test("authenticated Upgrade owns assignment, immutable lineage, and active-owner routing", async () => {
  const [route, account] = await Promise.all([
    source("api/checkout/start.ts"),
    source("api/_lib/account.ts"),
  ]);
  const sessionIndex = route.indexOf("const session = await getSession(request)");
  const ownerIndex = route.indexOf("if (session.license.active)");
  const intentIndex = route.indexOf("createCheckoutIntent({");
  assert.ok(sessionIndex >= 0 && ownerIndex > sessionIndex && intentIndex > ownerIndex);
  assert.match(route, /\/api\/auth\/google\/start/);
  assert.match(route, /\/api\/activation\/claim/);
  assert.match(route, /checkout", "already_owned"/);
  assert.match(route, /isLegacyVercelHost\(request\.headers\.host\)/);
  assert.match(route, /acceptedHandoffToken/);
  assert.doesNotMatch(route, /searchParams\.get\("(?:variant|country|currency|amount|price|product|billing)/i);

  assert.match(account, /sidestream_upgrade_pricing_assignments/);
  assert.match(account, /on conflict \(experiment_id, account_id\) do nothing/);
  assert.match(account, /decideUpgradePricing\(\{/);
  assert.match(account, /if \(options\.session\.license\.active\) return null/);
  assert.match(account, /if \(options\.session\?\.license\.active\)/);
  for (const column of [
    "upgrade_pricing_snapshot_version",
    "upgrade_pricing_experiment_id",
    "upgrade_pricing_decision_reason",
    "upgrade_pricing_assignment_id",
    "upgrade_pricing_assignment_bucket",
    "upgrade_pricing_rollout_basis_points",
    "upgrade_pricing_assigned_at",
    "upgrade_pricing_variant",
    "upgrade_pricing_billing_model",
    "upgrade_pricing_country",
    "upgrade_pricing_currency",
    "upgrade_pricing_amount_minor",
    "upgrade_pricing_stripe_product_id",
    "upgrade_pricing_stripe_price_id",
    "upgrade_pricing_account_id",
    "upgrade_pricing_acquisition_id",
    "upgrade_pricing_checkout_intent_id",
    "upgrade_pricing_activation_session_id",
  ]) {
    assert.match(account, new RegExp(column), column);
  }
});

test("every Upgrade experiment Stripe metadata key fits the provider limit", async () => {
  const account = await source("api/_lib/account.ts");
  const keys = [...new Set(account.match(/sidestream_upgrade_[a-z0-9_]+/g) || [])];
  assert.ok(keys.length >= 18);
  for (const key of keys) {
    assert.ok(key.length <= 40, `${key} is ${key.length} characters`);
  }
});

test("control request remains exact while monthly uses only recurring-safe parameters", async () => {
  const account = await source("api/_lib/account.ts");
  const builderStart = account.indexOf("export function buildUpgradeCheckoutSessionParameters");
  const workerStart = account.indexOf("export async function createOrReuseCheckoutSession", builderStart);
  const builder = account.slice(builderStart, workerStart);
  const subscriptionStart = builder.indexOf('if (options.billingModel === "subscription")');
  const paymentStart = builder.indexOf('mode: "payment"', subscriptionStart);
  const subscriptionBranch = builder.slice(subscriptionStart, paymentStart);
  const paymentBranch = builder.slice(paymentStart);

  assert.match(subscriptionBranch, /mode: "subscription"/);
  assert.match(subscriptionBranch, /subscription_data: \{ metadata \}/);
  for (const forbidden of [
    "allow_promotion_codes",
    "customer_creation",
    "custom_text",
    "invoice_creation",
    "payment_intent_data",
  ]) {
    assert.doesNotMatch(subscriptionBranch, new RegExp(forbidden), forbidden);
  }
  assert.match(paymentBranch, /mode: "payment"/);
  assert.match(paymentBranch, /customer_creation: "always"/);
  assert.match(paymentBranch, /allow_promotion_codes: true/);
  assert.match(paymentBranch, /invoice_creation:/);
  assert.match(paymentBranch, /payment_intent_data: \{ metadata \}/);
  assert.match(paymentBranch, /One-time payment\. No subscription\./);
});

test("monthly Price validation, exposure timing, and legacy separation fail closed", async () => {
  const account = await source("api/_lib/account.ts");
  for (const marker of [
    "price.livemode === isLiveStripeMode()",
    "normalizeStripeId(price.product) === expected.productId",
    "price.active === true",
    "price.lookup_key === expected.lookupKey",
    "price.currency === expected.currency",
    "price.unit_amount === expected.amountMinor",
    'price.type === "recurring"',
    'price.recurring?.interval === UPGRADE_PRICING_MONTHLY_INTERVAL',
    "price.recurring?.interval_count === UPGRADE_PRICING_MONTHLY_INTERVAL_COUNT",
    "price.recurring?.usage_type === UPGRADE_PRICING_MONTHLY_USAGE_TYPE",
  ]) {
    assert.match(account, new RegExp(escapeRegExp(marker)), marker);
  }
  assert.match(account, /upgrade_pricing_monthly_price_unavailable/);
  assert.match(account, /recordUpgradePricingExposure/);
  assert.match(account, /on conflict \(experiment_id, checkout_intent_id\) do nothing/);
  assert.ok(
    account.indexOf("set state = 'open'") <
      account.lastIndexOf("await recordUpgradePricingExposure"),
  );
  const experimentIndex = account.indexOf("await reconcileUpgradePricingSubscription(");
  const legacyIndex = account.indexOf("Historical subscription reconciliation remains", experimentIndex);
  assert.ok(experimentIndex >= 0 && legacyIndex > experimentIndex);
  assert.match(account, /Historical subscription reconciliation remains a separate allowlisted/);
});

test("acquisition and activation lineage stay attached to the exact locked Session", async () => {
  const account = await source("api/_lib/account.ts");
  assert.match(account, /sidestream_acquisition_id: row\.acquisition_id/);
  assert.match(account, /sidestream_checkout_intent_id: row\.id/);
  assert.match(account, /metadata\.sidestream_activation_key = activationKey/);
  assert.match(account, /attachCheckoutSessionToActivation\(\{/);
  assert.match(account, /replaceCheckoutSessionId: replacementSessionId \|\| undefined/);
  assert.match(account, /parametersFingerprint: getCheckoutParametersFingerprint\(checkoutParams\)/);
});

async function source(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

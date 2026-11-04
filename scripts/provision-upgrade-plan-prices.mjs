import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import Stripe from "stripe";
import { SIDESTREAM_PRICING_CONTRACT } from "../config/pricing-contract.mjs";

const DEFAULT_PRODUCT_ID = "prod_UpwXh6oO1OmPyQ";

export class PriceProvisioningError extends Error {
  constructor(code) {
    super(code);
    this.name = "PriceProvisioningError";
    this.code = code;
  }
}

export function upgradePlanPriceSpecs(contract = SIDESTREAM_PRICING_CONTRACT) {
  const offer = contract.global;
  if (
    offer?.currency !== "usd" ||
    !Number.isSafeInteger(offer.amountMinor) || offer.amountMinor <= 0 ||
    !Number.isSafeInteger(offer.monthlyAmountMinor) || offer.monthlyAmountMinor <= 0 ||
    offer.lookupKey !== `sidestream_pro_once_${offer.amountMinor}`
  ) {
    throw new PriceProvisioningError("invalid_pricing_contract");
  }
  return [
    {
      plan: "pro",
      nickname: "Sidestream Pro monthly",
      currency: "usd",
      unitAmount: offer.monthlyAmountMinor,
      lookupKey: `sidestream_pro_monthly_usd_${offer.monthlyAmountMinor}`,
      type: "recurring",
    },
    {
      plan: "unlimited",
      nickname: "Sidestream Unlimited one-time",
      currency: "usd",
      unitAmount: offer.amountMinor,
      lookupKey: offer.lookupKey,
      type: "one_time",
    },
  ];
}

function priceId(value) {
  return typeof value === "string" && /^price_[A-Za-z0-9]+$/.test(value)
    ? value : null;
}

function mismatches(price, spec, productId, livemode) {
  const reasons = [];
  if (!priceId(price?.id)) reasons.push("invalid_price_id");
  if (price?.active !== true) reasons.push("inactive");
  if (price?.livemode !== livemode) reasons.push("wrong_mode");
  const actualProduct = typeof price?.product === "string" ? price.product : price?.product?.id;
  if (actualProduct !== productId) reasons.push("wrong_product");
  if (price?.lookup_key !== spec.lookupKey) reasons.push("wrong_lookup_key");
  if (price?.currency !== spec.currency) reasons.push("wrong_currency");
  if (price?.unit_amount !== spec.unitAmount) reasons.push("wrong_amount");
  if (price?.type !== spec.type) reasons.push("wrong_type");
  if (price?.billing_scheme !== "per_unit" || price?.custom_unit_amount != null ||
    price?.transform_quantity != null || price?.tiers_mode != null) {
    reasons.push("non_fixed_unit_pricing");
  }
  if (spec.type === "recurring") {
    if (price?.recurring?.interval !== "month" ||
      price.recurring.interval_count !== 1 || price.recurring.usage_type !== "licensed" ||
      price.recurring.meter != null || price.recurring.trial_period_days != null) {
      reasons.push("wrong_recurring_terms");
    }
  } else if (price?.recurring != null) {
    reasons.push("unexpected_recurring_terms");
  }
  return reasons;
}

function creationParameters(spec, productId) {
  return {
    product: productId,
    active: true,
    currency: spec.currency,
    unit_amount: spec.unitAmount,
    lookup_key: spec.lookupKey,
    nickname: spec.nickname,
    billing_scheme: "per_unit",
    ...(spec.type === "recurring" ? {
      recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
    } : {}),
  };
}

export function priceCreationIdempotencyKey(mode, parameters) {
  const digest = createHash("sha256").update(JSON.stringify({ mode, parameters })).digest("hex");
  return `sidestream-upgrade-price-v1-${digest}`;
}

async function providerRead(operation) {
  try {
    return await operation();
  } catch {
    // Stripe messages may echo credentials. Never expose provider errors.
    throw new PriceProvisioningError("stripe_read_failed");
  }
}

export async function provisionUpgradePlanPrices({
  stripe,
  mode,
  productId = DEFAULT_PRODUCT_ID,
  apply = false,
  allowLive = false,
  contract = SIDESTREAM_PRICING_CONTRACT,
}) {
  if (mode !== "live" && mode !== "test") throw new PriceProvisioningError("invalid_stripe_mode");
  if (typeof productId !== "string" || !/^prod_[A-Za-z0-9]+$/.test(productId)) {
    throw new PriceProvisioningError("invalid_product_id");
  }
  if (apply && mode === "live" && !allowLive) {
    throw new PriceProvisioningError("live_apply_requires_allow_live");
  }
  const specs = upgradePlanPriceSpecs(contract);
  const livemode = mode === "live";
  const product = await providerRead(() => stripe.products.retrieve(productId));
  if (product?.id !== productId || product?.deleted || product?.active !== true ||
    product?.livemode !== livemode) {
    throw new PriceProvisioningError("product_must_be_active_in_selected_mode");
  }

  // Do not filter active/product/currency: an inactive or mismatched lookup is a conflict.
  const listed = await providerRead(() => stripe.prices.list({
    lookup_keys: specs.map((spec) => spec.lookupKey),
    limit: 100,
  }));
  if (!Array.isArray(listed?.data) || listed.has_more !== false ||
    listed.data.some((price) => !specs.some((spec) => spec.lookupKey === price?.lookup_key))) {
    throw new PriceProvisioningError("unexpected_price_list");
  }
  const report = {
    mode,
    dryRun: !apply,
    productId,
    status: "dry-run",
    prices: specs.map((spec) => {
      const matches = listed.data.filter((price) => price.lookup_key === spec.lookupKey);
      const reasons = matches.length > 1 ? ["duplicate_lookup_key"] : matches.length === 1
        ? mismatches(matches[0], spec, productId, livemode) : [];
      return {
        plan: spec.plan,
        lookupKey: spec.lookupKey,
        currency: spec.currency,
        unitAmount: spec.unitAmount,
        type: spec.type,
        ...(spec.type === "recurring" ? { interval: "month", intervalCount: 1 } : {}),
        status: reasons.length ? "conflict" : matches.length ? "match" : "missing",
        ...(matches.length === 1 && priceId(matches[0].id) ? { priceId: matches[0].id } : {}),
        ...(reasons.length ? { reasons } : {}),
      };
    }),
  };
  // Preflight both plans before creating either; never repair/reassign a conflicting lookup.
  if (report.prices.some((price) => price.status === "conflict")) {
    report.status = "blocked";
    return report;
  }
  if (!apply) return report;

  report.status = "unchanged";
  for (const [index, spec] of specs.entries()) {
    const result = report.prices[index];
    if (result.status !== "missing") continue;
    const parameters = creationParameters(spec, productId);
    let created;
    try {
      created = await stripe.prices.create(parameters, {
        idempotencyKey: priceCreationIdempotencyKey(mode, parameters),
      });
    } catch {
      result.status = "failed";
      result.reasons = ["stripe_create_failed"];
      report.status = "failed";
      return report;
    }
    const reasons = mismatches(created, spec, productId, livemode);
    if (priceId(created?.id)) result.priceId = created.id;
    if (reasons.length) {
      result.status = "conflict";
      result.reasons = reasons;
      report.status = "blocked";
      return report;
    }
    result.status = "created";
    report.status = "applied";
  }
  return report;
}

export function stripeKeyMode(key) {
  if (/^(?:sk|rk)_live_[A-Za-z0-9]+$/.test(key || "")) return "live";
  if (/^(?:sk|rk)_test_[A-Za-z0-9]+$/.test(key || "")) return "test";
  throw new PriceProvisioningError("missing_or_invalid_stripe_secret_key");
}

function loadEnvFile(filePath) {
  if (!filePath) return;
  let contents;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch {
    throw new PriceProvisioningError("env_file_unreadable");
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    if (argv.some((argument) => !["--apply", "--allow-live", "--help"].includes(argument))) {
      throw new PriceProvisioningError("unknown_argument");
    }
    if (argv.includes("--help")) {
      console.log("Usage: node scripts/provision-upgrade-plan-prices.mjs [--apply] [--allow-live]\nDefault: read-only Stripe inspection. Set STRIPE_SECRET_KEY and optionally SIDESTREAM_PRO_PRODUCT_ID.\nOptional env files: SIDESTREAM_ENV_FILE, SIDESTREAM_STRIPE_ENV_FILE. Live writes require --apply --allow-live.");
      return 0;
    }
    loadEnvFile(process.env.SIDESTREAM_ENV_FILE);
    loadEnvFile(process.env.SIDESTREAM_STRIPE_ENV_FILE);
    const key = process.env.STRIPE_SECRET_KEY?.trim();
    const mode = stripeKeyMode(key);
    const report = await provisionUpgradePlanPrices({
      stripe: new Stripe(key, { apiVersion: Stripe.API_VERSION, maxNetworkRetries: 2, timeout: 20_000 }),
      mode,
      productId: process.env.SIDESTREAM_PRO_PRODUCT_ID?.trim() || DEFAULT_PRODUCT_ID,
      apply: argv.includes("--apply"),
      allowLive: argv.includes("--allow-live"),
    });
    console.log(JSON.stringify(report, null, 2));
    return ["blocked", "failed"].includes(report.status) ? 1 : 0;
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof PriceProvisioningError ? error.code : "price_provisioning_failed",
    }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}

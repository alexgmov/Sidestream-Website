import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  provisionUpgradePlanPrices,
  stripeKeyMode,
  upgradePlanPriceSpecs,
} from "../scripts/provision-upgrade-plan-prices.mjs";

const productId = "prod_UpgradeTests";
const contract = { global: {
  currency: "usd", amountMinor: 3999, monthlyAmountMinor: 999,
  lookupKey: "sidestream_pro_once_3999",
} };
const specs = upgradePlanPriceSpecs(contract);

function price(spec, overrides = {}) {
  return {
    id: `price_${spec.plan}`, active: true, livemode: false,
    product: productId, lookup_key: spec.lookupKey,
    currency: spec.currency, unit_amount: spec.unitAmount, type: spec.type,
    billing_scheme: "per_unit", custom_unit_amount: null,
    transform_quantity: null, tiers_mode: null,
    recurring: spec.type === "recurring" ? {
      interval: "month", interval_count: 1, usage_type: "licensed",
      meter: null, trial_period_days: null,
    } : null,
    ...overrides,
  };
}

function fixture({ prices = [], product = {}, list = {}, failCreateAt = 0 } = {}) {
  const calls = { retrieve: [], list: [], create: [] };
  const records = [...prices];
  const stripe = {
    products: { retrieve: async (id) => {
      calls.retrieve.push(id);
      return { id: productId, active: true, livemode: false, ...product };
    } },
    prices: {
      list: async (parameters) => {
        calls.list.push(parameters);
        return { data: records, has_more: false, ...list };
      },
      create: async (parameters, options) => {
        calls.create.push({ parameters, options });
        if (calls.create.length === failCreateAt) throw new Error("Do not log sk_live_secret or provider message");
        const spec = specs.find((item) => item.lookupKey === parameters.lookup_key);
        const created = price(spec, { livemode: product.livemode === true });
        records.push(created);
        return created;
      },
    },
  };
  return { calls, stripe };
}

function run(mock, options = {}) {
  return provisionUpgradePlanPrices({
    stripe: mock.stripe, mode: "test", productId, contract, ...options,
  });
}

test("default dry run reports missing prices and never writes", async () => {
  const mock = fixture();
  const report = await run(mock);
  assert.equal(report.dryRun, true);
  assert.equal(report.status, "dry-run");
  assert.deepEqual(report.prices.map((item) => item.status), ["missing", "missing"]);
  assert.deepEqual(mock.calls.list, [{ lookup_keys: specs.map((item) => item.lookupKey), limit: 100 }]);
  assert.equal(mock.calls.create.length, 0);
});

test("apply creates exact monthly and one-time prices, then safely reuses them", async () => {
  const mock = fixture();
  const first = await run(mock, { apply: true });
  assert.equal(first.status, "applied");
  assert.deepEqual(first.prices.map((item) => item.status), ["created", "created"]);
  assert.deepEqual(mock.calls.create[0].parameters, {
    product: productId, active: true, currency: "usd", unit_amount: 999,
    lookup_key: "sidestream_pro_monthly_usd_999", nickname: "Sidestream Pro monthly",
    billing_scheme: "per_unit", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
  });
  assert.deepEqual(mock.calls.create[1].parameters, {
    product: productId, active: true, currency: "usd", unit_amount: 3999,
    lookup_key: "sidestream_pro_once_3999", nickname: "Sidestream Unlimited one-time",
    billing_scheme: "per_unit",
  });
  assert.ok(mock.calls.create.every(({ parameters }) => !Object.hasOwn(parameters, "transfer_lookup_key")));
  const second = await run(mock, { apply: true });
  assert.equal(second.status, "unchanged");
  assert.deepEqual(second.prices.map((item) => item.status), ["match", "match"]);
  assert.equal(mock.calls.create.length, 2);
});

test("fresh retries use stable separate idempotency keys", async () => {
  const first = fixture();
  const retry = fixture();
  await run(first, { apply: true });
  await run(retry, { apply: true });
  assert.deepEqual(first.calls.create.map(({ options }) => options), retry.calls.create.map(({ options }) => options));
  assert.notEqual(first.calls.create[0].options.idempotencyKey, first.calls.create[1].options.idempotencyKey);
});

test("preflight refuses conflicting lookup before creating the other missing price", async (t) => {
  for (const overrides of [
    { active: false }, { product: "prod_Wrong" }, { currency: "eur" },
    { unit_amount: 1999 }, { livemode: true }, { type: "recurring" },
    { transform_quantity: { divide_by: 10, round: "up" } },
    { billing_scheme: "tiered" }, { recurring: { interval: "year" } },
  ]) {
    await t.test(JSON.stringify(overrides), async () => {
      const mock = fixture({ prices: [price(specs[1], overrides)] });
      const report = await run(mock, { apply: true });
      assert.equal(report.status, "blocked");
      assert.equal(report.prices[0].status, "missing");
      assert.equal(report.prices[1].status, "conflict");
      assert.equal(mock.calls.create.length, 0);
    });
  }
});

test("dry run reports conflicts without exposing arbitrary provider fields", async () => {
  const mock = fixture({ prices: [price(specs[0], {
    recurring: { interval: "year", interval_count: 1, usage_type: "licensed" },
    nickname: "sk_live_doNotPrint", metadata: { secret: "sk_live_doNotPrint" },
  })] });
  const report = await run(mock);
  assert.equal(report.status, "blocked");
  assert.ok(report.prices[0].reasons.includes("wrong_recurring_terms"));
  assert.equal(JSON.stringify(report).includes("sk_live_doNotPrint"), false);
  assert.equal(mock.calls.create.length, 0);
});

test("live apply requires explicit allow-live before making even a read", async () => {
  const mock = fixture({ product: { livemode: true } });
  await assert.rejects(run(mock, { mode: "live", apply: true }), { code: "live_apply_requires_allow_live" });
  assert.deepEqual(mock.calls, { retrieve: [], list: [], create: [] });
  const dryRun = await run(mock, { mode: "live" });
  assert.equal(dryRun.status, "dry-run");
  assert.equal(mock.calls.create.length, 0);
  const applied = await run(mock, { mode: "live", apply: true, allowLive: true });
  assert.equal(applied.status, "applied");
});

test("deleted, inactive, or wrong-mode product blocks all price access", async (t) => {
  for (const product of [{ deleted: true }, { active: false }, { livemode: true }, { id: "prod_Wrong" }]) {
    await t.test(JSON.stringify(product), async () => {
      const mock = fixture({ product });
      await assert.rejects(run(mock, { apply: true }), { code: "product_must_be_active_in_selected_mode" });
      assert.equal(mock.calls.list.length, 0);
      assert.equal(mock.calls.create.length, 0);
    });
  }
});

test("duplicate or incomplete lookup responses fail closed", async () => {
  const duplicate = fixture({ prices: [price(specs[0]), price(specs[0])] });
  assert.equal((await run(duplicate, { apply: true })).status, "blocked");
  assert.equal(duplicate.calls.create.length, 0);
  const incomplete = fixture({ list: { has_more: true } });
  await assert.rejects(run(incomplete, { apply: true }), { code: "unexpected_price_list" });
  assert.equal(incomplete.calls.create.length, 0);
});

test("partial provider failure reports the created price without raw error details", async () => {
  const mock = fixture({ failCreateAt: 2 });
  const report = await run(mock, { apply: true });
  assert.equal(report.status, "failed");
  assert.deepEqual(report.prices.map((item) => item.status), ["created", "failed"]);
  assert.equal(report.prices[0].priceId, "price_pro");
  assert.deepEqual(report.prices[1].reasons, ["stripe_create_failed"]);
  assert.equal(JSON.stringify(report).includes("sk_live_secret"), false);
});

test("a mismatched create response stops before creating the next price", async () => {
  const mock = fixture();
  mock.stripe.prices.create = async (...args) => {
    mock.calls.create.push(args);
    return price(specs[0], { unit_amount: 499 });
  };
  const report = await run(mock, { apply: true });
  assert.equal(report.status, "blocked");
  assert.equal(report.prices[0].status, "conflict");
  assert.deepEqual(report.prices[0].reasons, ["wrong_amount"]);
  assert.equal(mock.calls.create.length, 1);
});

test("read errors are replaced with a fixed safe error", async () => {
  const mock = fixture();
  mock.stripe.products.retrieve = async () => { throw new Error("Invalid API Key provided: sk_live_secret"); };
  await assert.rejects(run(mock), (error) => {
    assert.equal(error.code, "stripe_read_failed");
    assert.equal(error.message.includes("sk_live_secret"), false);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("contract supplies amounts and rejects a mismatched one-time lookup", () => {
  const changed = { global: { ...contract.global, amountMinor: 4999, monthlyAmountMinor: 1299, lookupKey: "sidestream_pro_once_4999" } };
  assert.deepEqual(upgradePlanPriceSpecs(changed).map(({ unitAmount, lookupKey }) => ({ unitAmount, lookupKey })), [
    { unitAmount: 1299, lookupKey: "sidestream_pro_monthly_usd_1299" },
    { unitAmount: 4999, lookupKey: "sidestream_pro_once_4999" },
  ]);
  assert.throws(() => upgradePlanPriceSpecs({ global: { ...changed.global, lookupKey: "sidestream_pro_once_3999" } }), { code: "invalid_pricing_contract" });
});

test("both secret and restricted Stripe keys receive the correct live gate", () => {
  assert.equal(stripeKeyMode("sk_test_placeholder"), "test");
  assert.equal(stripeKeyMode("rk_test_placeholder"), "test");
  assert.equal(stripeKeyMode("sk_live_placeholder"), "live");
  assert.equal(stripeKeyMode("rk_live_placeholder"), "live");
  assert.throws(() => stripeKeyMode("pk_live_placeholder"), { code: "missing_or_invalid_stripe_secret_key" });
});

test("CLI rejects live apply without a gate and never prints the key", () => {
  const key = "sk_live_placeholder"; // Deliberately nonfunctional test credential.
  const result = spawnSync(process.execPath, [
    new URL("../scripts/provision-upgrade-plan-prices.mjs", import.meta.url).pathname,
    "--apply",
  ], { encoding: "utf8", env: { PATH: process.env.PATH, STRIPE_SECRET_KEY: key } });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr), { error: "live_apply_requires_allow_live" });
  assert.equal(`${result.stdout}${result.stderr}`.includes(key), false);
});

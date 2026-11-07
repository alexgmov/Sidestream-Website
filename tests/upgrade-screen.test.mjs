import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../upgrade.html", import.meta.url), "utf8");
const controller = html.match(/<script id="upgrade-controller">([\s\S]*?)<\/script>/)?.[1];
assert.ok(controller, "Exercise the shipped pricing controller");

function element(dataset = {}) {
  return {
    dataset, attributes: { "aria-disabled": "true", tabindex: "-1" },
    listeners: {}, hidden: true, textContent: "", href: undefined,
    addEventListener(name, listener) { this.listeners[name] = listener; },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    removeAttribute(name) {
      delete this.attributes[name];
      if (name === "href") this.href = undefined;
    },
  };
}

function plans() {
  return {
    plans: {
      free: { id: "free", name: "Free", formattedPrice: "$0", currency: "USD", billingCadence: "free", downloadLimit: 10, maxVideoHeight: 1080, socialDownloads: false },
      pro_monthly: { id: "pro_monthly", name: "Pro", formattedPrice: "$9.99", currency: "USD", billingCadence: "month", downloadLimit: null, maxVideoHeight: 2160, socialDownloads: false },
      unlimited_one_time: { id: "unlimited_one_time", name: "Unlimited", formattedPrice: "$34.99", currency: "USD", billingCadence: "one_time", downloadLimit: null, maxVideoHeight: 2160, socialDownloads: true },
    },
  };
}

function fixture({ search = "", fetchImpl } = {}) {
  const links = [element({ checkoutPlan: "pro_monthly" }), element({ checkoutPlan: "unlimited_one_time" })];
  const returns = [element(), element()];
  const status = element();
  const retry = element();
  const prices = Object.fromEntries(links.map(({ dataset }) => [dataset.checkoutPlan, element()]));
  const currencies = Object.fromEntries(links.map(({ dataset }) => [dataset.checkoutPlan, element()]));
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  const ready = vm.runInNewContext(controller, {
    URL, URLSearchParams, AbortController,
    document: {
      querySelectorAll(selector) {
        if (selector === "[data-checkout-plan]") return links;
        if (selector === "[data-pricing-return]") return returns;
        throw new Error(`Unexpected selector: ${selector}`);
      },
      querySelector(selector) {
        const match = selector.match(/^\[data-upgrade-(price|currency)="([a-z_]+)"\]$/);
        assert.ok(match);
        return (match[1] === "price" ? prices : currencies)[match[2]];
      },
      getElementById(id) {
        if (id === "pricing-status") return status;
        if (id === "retry-pricing") return retry;
        throw new Error(`Unexpected id: ${id}`);
      },
    },
    window: {
      location: { href: `https://sidestream.tv/upgrade.html${search}` },
      setTimeout(callback, delay) {
        assert.equal(delay, 10000);
        timers.set(++timerId, callback);
        return timerId;
      },
      clearTimeout(id) { timers.delete(id); },
    },
    async fetch(url, options) {
      requests.push({ url, options });
      assert.equal(url, "/api/checkout/offer?view=plans");
      assert.equal(options.credentials, "same-origin");
      assert.equal(options.cache, "no-store");
      return fetchImpl ? fetchImpl(url, options) : { ok: true, json: async () => plans() };
    },
  });
  return { ready, links, returns, status, retry, prices, currencies, requests, timers };
}

function assertUnavailable(fixture) {
  for (const link of fixture.links) {
    assert.equal(link.href, undefined);
    assert.equal(link.getAttribute("aria-disabled"), "true");
    let prevented = false;
    link.listeners.click({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
}

test("paid navigation waits for verified server presentation and preserves only safe continuation fields", async () => {
  let resolveFetch;
  const f = fixture({
    search: "?activation=opaque-activation&handoff=opaque.a%2Bb&from=account&amount=1&currency=INR&plan=forged&next=https://example.org",
    fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }),
  });
  assertUnavailable(f);
  resolveFetch({ ok: true, json: async () => plans() });
  await f.ready;
  for (const link of f.links) {
    const target = new URL(link.href, "https://sidestream.tv");
    assert.equal(target.pathname, "/api/checkout/start");
    assert.deepEqual([...target.searchParams], [
      ["activation", "opaque-activation"], ["handoff", "opaque.a+b"], ["plan", link.dataset.checkoutPlan],
    ]);
    assert.equal(link.getAttribute("aria-disabled"), "false");
    assert.equal(link.getAttribute("tabindex"), null);
  }
  assert.ok(f.returns.every((link) => link.href === "/account.html"));
  assert.equal(f.prices.pro_monthly.textContent, "$9.99");
  assert.equal(f.status.textContent, "");
  assert.equal(f.timers.size, 0);
});

test("regional one-time display follows the server while monthly remains USD", async () => {
  const payload = plans();
  Object.assign(payload.plans.unlimited_one_time, { formattedPrice: "₹499", currency: "INR" });
  const f = fixture({ fetchImpl: async () => ({ ok: true, json: async () => payload }) });
  await f.ready;
  assert.equal(f.prices.unlimited_one_time.textContent, "₹499");
  assert.equal(f.currencies.unlimited_one_time.textContent, "INR");
  assert.equal(f.currencies.pro_monthly.textContent, "USD");
  assert.ok(f.returns.every((link) => link.href === "/"));
});

test("ambiguous or malformed continuation values cannot start a disconnected purchase", async () => {
  for (const search of [
    "?activation=first&activation=second", "?handoff=one&handoff=two", "?activation=",
    "?handoff=%0Asecret", `?activation=${"a".repeat(161)}`, `?handoff=${"a".repeat(8193)}`,
  ]) {
    const f = fixture({ search });
    await f.ready;
    assertUnavailable(f);
    assert.equal(f.requests.length, 0);
    assert.match(f.status.textContent, /upgrade link is invalid/);
    assert.equal(f.retry.hidden, true);
  }
});

test("wrong billing cadence, capabilities, currency, or missing plan fails closed", async () => {
  const mutations = [
    (p) => { p.plans.pro_monthly.billingCadence = "one_time"; },
    (p) => { p.plans.pro_monthly.currency = "INR"; },
    (p) => { p.plans.pro_monthly.downloadLimit = 10; },
    (p) => { p.plans.unlimited_one_time.socialDownloads = false; },
    (p) => { p.plans.unlimited_one_time.id = "forged"; },
    (p) => { p.plans.unlimited_one_time.formattedPrice = "\n$1"; },
    (p) => { p.plans.free.maxVideoHeight = 2160; },
    (p) => { delete p.plans.unlimited_one_time; },
  ];
  for (const mutate of mutations) {
    const payload = plans();
    mutate(payload);
    const f = fixture({ fetchImpl: async () => ({ ok: true, json: async () => payload }) });
    await f.ready;
    assertUnavailable(f);
    assert.equal(f.retry.hidden, false);
    assert.match(f.status.textContent, /couldn't load current prices/);
  }
});

test("failed offer requests expose retry and a successful retry enables the selected paths", async () => {
  let fail = true;
  const f = fixture({ fetchImpl: async () => ({ ok: !fail, json: async () => plans() }) });
  await f.ready;
  assertUnavailable(f);
  assert.equal(f.retry.hidden, false);
  fail = false;
  await f.retry.listeners.click();
  assert.equal(f.retry.hidden, true);
  assert.equal(f.links[0].href, "/api/checkout/start?plan=pro_monthly");
  assert.equal(f.links[1].href, "/api/checkout/start?plan=unlimited_one_time");
});

test("a timed-out offer request aborts and keeps purchase disabled", async () => {
  const f = fixture({ fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("Aborted")));
  }) });
  for (const timeout of f.timers.values()) timeout();
  await f.ready;
  assertUnavailable(f);
  assert.equal(f.retry.hidden, false);
  assert.equal(f.timers.size, 0);
});

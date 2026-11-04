import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../account.html", import.meta.url), "utf8");
const controller = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(controller, "Exercise the account page's shipped controller");

async function loadAccount(license) {
  const elements = new Map();
  const confirmations = [];
  const alerts = [];
  const posts = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      dataset: {}, textContent: "", hidden: false, disabled: false, listeners: {},
      classList: { toggle() {} },
      addEventListener(type, listener) { this.listeners[type] = listener; },
    });
    return elements.get(id);
  }
  await vm.runInNewContext(controller, {
    document: { getElementById: element },
    window: {
      location: { pathname: "/account.html", search: "" },
      confirm(message) { confirmations.push(message); return true; },
      alert(message) { alerts.push(message); },
    },
    async fetch(url, options) {
      let payload;
      if (url === "/api/auth/session") {
        payload = {
          authenticated: true, user: { email: "editor@example.test" }, license,
          billing: { hasCustomer: license.active, canCancelSubscription: license.active },
        };
      } else if (url === "/api/account/device") {
        payload = { active: false, devices: [] };
      } else if (url === "/api/billing/subscription/cancel") {
        posts.push({ url, options });
        payload = { currentPeriodEnd: "2026-12-04T12:00:00Z" };
      } else throw new Error(`Unexpected request: ${url}`);
      return { ok: true, json: async () => payload };
    },
  });
  return { element, confirmations, alerts, posts };
}

test("Pro retains its plan name in active status, cancellation confirmation, and paid-through status", async () => {
  const page = await loadAccount({
    active: true, purchasePlan: "pro_monthly", currentPeriodEnd: "2026-12-04T12:00:00Z",
  });
  assert.equal(page.element("account-plan").textContent, "Pro");
  await page.element("cancel-subscription-button").listeners.click();
  assert.match(page.confirmations[0], /keep Pro access until/);
  assert.match(page.element("account-plan").textContent, /^Pro - cancels /);
  assert.match(page.alerts[0], /Pro access continues until/);
  assert.equal(page.posts.length, 1);
  assert.equal(page.posts[0].options.body, "{}");
  assert.equal(page.element("cancel-subscription-button").hidden, true);
});

test("scheduled Pro and historical paid licenses keep distinct labels while inactive plans show Free", async () => {
  for (const [purchasePlan, label] of [
    ["pro_monthly", "Pro"], ["unlimited_one_time", "Unlimited"],
    ["legacy_paid", "Unlimited"], [undefined, "Unlimited"],
  ]) {
    const page = await loadAccount({
      active: true, purchasePlan, cancelAtPeriodEnd: true,
      currentPeriodEnd: "2026-12-04T12:00:00Z",
    });
    assert.ok(page.element("account-plan").textContent.startsWith(`${label} - cancels `));
    assert.equal(page.element("upgrade-link").hidden, true);
  }
  const free = await loadAccount({ active: false, purchasePlan: "pro_monthly" });
  assert.equal(free.element("account-plan").textContent, "Free");
  assert.equal(free.element("upgrade-link").hidden, false);
});

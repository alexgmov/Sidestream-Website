import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadInjectedHandler } from "./helpers/handler-loader.mjs";
import { invokeHandler } from "./helpers/http.mjs";

test("subscription cancellation is authenticated, subscription-only, and owner-bound", async () => {
  const calls = { retrieve: [], update: [] };
  let providerSubscription = subscription();
  const dependencies = {
    canCancelAccountSubscription(session) {
      return Boolean(
        session.stripeSubscriptionId &&
        session.license.active &&
        !session.license.cancelAtPeriodEnd
      );
    },
    getStripe() {
      return {
        subscriptions: {
          async retrieve(id, params, options) {
            calls.retrieve.push({ id, params, options });
            return providerSubscription;
          },
          async update(id, params, options) {
            calls.update.push({ id, params, options });
            providerSubscription = { ...providerSubscription, cancel_at_period_end: true };
            return providerSubscription;
          },
        },
      };
    },
    getStripeRequestOptions() {
      return { apiVersion: "contract-version" };
    },
    methodNotAllowed(response, allowed) {
      response.setHeader("Allow", allowed);
      return dependencies.sendJson(response, 405, { error: "Method not allowed" });
    },
    async requireSession(request, response) {
      if (request.session) return request.session;
      dependencies.sendJson(response, 401, { error: "Authentication required" });
      return null;
    },
    sendJson(response, statusCode, payload) {
      response.statusCode = statusCode;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify(payload));
    },
  };
  const handler = await loadInjectedHandler(
    new URL("../api/billing/subscription/cancel.ts", import.meta.url),
    { "../../_lib/account.js": dependencies },
  );

  const wrongMethod = await invokeHandler(handler, {
    method: "GET",
    url: "/api/billing/subscription/cancel",
  });
  assert.equal(wrongMethod.response.statusCode, 405);
  assert.equal(wrongMethod.response.getHeader("allow"), "POST");

  const unauthenticated = await invokeHandler(handler, {
    method: "POST",
    url: "/api/billing/subscription/cancel",
  });
  assert.equal(unauthenticated.response.statusCode, 401);

  const oneTime = await invokeHandler(handler, {
    method: "POST",
    url: "/api/billing/subscription/cancel",
    session: accountSession({ stripeSubscriptionId: "" }),
  });
  assert.equal(oneTime.response.statusCode, 400);
  assert.equal(calls.retrieve.length, 0);
  assert.equal(calls.update.length, 0);

  providerSubscription = subscription({ customer: "cus_someone_else" });
  const wrongOwner = await invokeHandler(handler, {
    method: "POST",
    url: "/api/billing/subscription/cancel",
    session: accountSession(),
  });
  assert.equal(wrongOwner.response.statusCode, 403);
  assert.equal(calls.retrieve.length, 1);
  assert.equal(calls.update.length, 0);

  providerSubscription = subscription();
  const canceled = await invokeHandler(handler, {
    method: "POST",
    url: "/api/billing/subscription/cancel",
    session: accountSession(),
  });
  assert.equal(canceled.response.statusCode, 200);
  assert.equal(canceled.response.json.ok, true);
  assert.equal(canceled.response.json.cancelAtPeriodEnd, true);
  assert.equal(canceled.response.json.alreadyScheduled, false);
  assert.equal(canceled.response.json.currentPeriodEnd, "2027-01-15T08:00:00.000Z");
  assert.deepEqual(calls.update.at(-1), {
    id: "sub_owned",
    params: { cancel_at_period_end: true },
    options: { apiVersion: "contract-version" },
  });

  const providerAlreadyScheduled = await invokeHandler(handler, {
    method: "POST",
    url: "/api/billing/subscription/cancel",
    session: accountSession(),
  });
  assert.equal(providerAlreadyScheduled.response.statusCode, 200);
  assert.equal(providerAlreadyScheduled.response.json.alreadyScheduled, true);
  assert.equal(calls.update.length, 1);

  const databaseAlreadyScheduled = await invokeHandler(handler, {
    method: "POST",
    url: "/api/billing/subscription/cancel",
    session: accountSession({ cancelAtPeriodEnd: true }),
  });
  assert.equal(databaseAlreadyScheduled.response.statusCode, 200);
  assert.equal(databaseAlreadyScheduled.response.json.alreadyScheduled, true);
  assert.equal(calls.retrieve.length, 3);
  assert.equal(calls.update.length, 1);
});

test("the account page exposes cancellation only through the subscription capability", async () => {
  const [accountPage, accountSource] = await Promise.all([
    readFile(new URL("../account.html", import.meta.url), "utf8"),
    readFile(new URL("../api/_lib/account.ts", import.meta.url), "utf8"),
  ]);

  assert.match(accountPage, /id="cancel-subscription-button"[^>]*hidden/);
  assert.match(
    accountPage,
    /cancelSubscriptionButton\.hidden = !session\.billing\.canCancelSubscription/,
  );
  assert.match(accountPage, /\/api\/billing\/subscription\/cancel/);
  assert.match(accountPage, /Cancel your Sidestream subscription\?/);
  assert.match(accountSource, /hasSubscription: Boolean\(session\.stripeSubscriptionId\)/);
  assert.match(accountSource, /canCancelSubscription: canCancelAccountSubscription\(session\)/);
});

function accountSession(overrides = {}) {
  return {
    accountId: "account-owner",
    email: "owner@example.test",
    name: "Owner",
    avatarUrl: "",
    stripeCustomerId: "cus_owned",
    stripeSubscriptionId: overrides.stripeSubscriptionId ?? "sub_owned",
    license: {
      active: overrides.active ?? true,
      plan: "sidestream_pro",
      status: "active",
      currentPeriodEnd: "2027-01-15T08:00:00.000Z",
      cancelAtPeriodEnd: overrides.cancelAtPeriodEnd ?? false,
      graceUntil: "",
      features: { subscription: true },
    },
  };
}

function subscription(overrides = {}) {
  return {
    id: overrides.id ?? "sub_owned",
    customer: overrides.customer ?? "cus_owned",
    cancel_at_period_end: overrides.cancelAtPeriodEnd ?? false,
    items: {
      data: [{ current_period_end: 1_800_000_000 }],
    },
  };
}

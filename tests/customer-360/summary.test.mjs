import assert from "node:assert/strict";
import test from "node:test";
import { loadInjectedModule } from "../helpers/handler-loader.mjs";
import { invokeHandler } from "../helpers/http.mjs";

const ADMIN_SECRET = "customer-summary-admin-secret-2026";

const summaryModule = await loadInjectedModule(
  new URL("../../api/_lib/customer-summary.ts", import.meta.url),
  {
    "./postgres.js": {
      withPostgresTransaction: async () => {
        throw new Error("Customer summary tests inject a transaction");
      },
    },
    "./account.js": {
      getStripe: () => {
        throw new Error("Customer summary tests inject Stripe pages");
      },
    },
  },
);
const routeModule = await loadInjectedModule(
  new URL("../../api/internal/customer-summary.ts", import.meta.url),
  {
    "../_lib/customer-summary.js": summaryModule,
  },
);

test("summary counts active Unlimited accounts, paid accounts, and successful payments", async () => {
  let sql = "";
  const result = await summaryModule.queryCustomerSummary(
    { licenseNamespace: "production" },
    {
      runtimeNamespace: () => "production",
      listPaymentIntents: async (startingAfter) => startingAfter
        ? {
            data: [{ id: "pi_3", status: "succeeded" }],
            has_more: false,
          }
        : {
            data: [
              { id: "pi_1", status: "succeeded" },
              { id: "pi_2", status: "requires_payment_method" },
            ],
            has_more: true,
          },
      transaction: async (callback) => callback({
        query: async (text) => {
          sql = text;
          return {
            rows: [{
              unlimited_access_users: "41",
              paid_users: "37",
              paid_unlimited_access_users: "36",
            }],
          };
        },
      }),
    },
  );

  assert.deepEqual(result, {
    licenseNamespace: "production",
    totals: {
      unlimitedAccessUsers: "41",
      paidUsers: "37",
      paidUnlimitedAccessUsers: "36",
      successfulPayments: "2",
    },
  });
  assert.match(sql, /plan_key in \('sidestream_pro', 'sidestream_unlimited'\)/);
  assert.match(sql, /to_jsonb\(l\) \? 'entitlement_status'/);
  assert.doesNotMatch(sql, /count\(distinct stripe_payment_intent_id\)/);
});

test("summary rejects unknown keys and a namespace that does not match its deployment", async () => {
  await assert.rejects(
    summaryModule.queryCustomerSummary(
      { licenseNamespace: "production", email: "forbidden@example.com" },
      { runtimeNamespace: () => "production" },
    ),
    (error) => error?.code === "unknown_request_key",
  );
  await assert.rejects(
    summaryModule.queryCustomerSummary(
      { licenseNamespace: "test" },
      { runtimeNamespace: () => "production" },
    ),
    (error) => error?.code === "invalid_namespace",
  );
});

test("summary route is private, POST-only, no-store, and returns the compact totals", async () => {
  let calls = 0;
  const handler = routeModule.createCustomerSummaryHandler({
    getAdminSecret: () => ADMIN_SECRET,
    querySummary: async () => {
      calls += 1;
      return {
        licenseNamespace: "production",
        totals: {
          unlimitedAccessUsers: "41",
          paidUsers: "37",
          paidUnlimitedAccessUsers: "36",
          successfulPayments: "39",
        },
      };
    },
  });

  for (const method of ["GET", "PUT", "OPTIONS"]) {
    const result = await invokeHandler(handler, {
      method,
      url: "/api/internal/customer-summary",
      headers: { authorization: `Bearer ${ADMIN_SECRET}` },
    });
    assert.equal(result.response.statusCode, 405);
    assert.equal(result.response.getHeader("allow"), "POST");
  }

  const browser = await invokeHandler(handler, {
    method: "POST",
    url: "/api/internal/customer-summary",
    headers: {
      authorization: `Bearer ${ADMIN_SECRET}`,
      origin: "https://sidestream.tv",
    },
    body: { licenseNamespace: "production" },
  });
  assert.equal(browser.response.statusCode, 403);

  const accepted = await invokeHandler(handler, {
    method: "POST",
    url: "/api/internal/customer-summary",
    headers: { authorization: `Bearer ${ADMIN_SECRET}` },
    body: { licenseNamespace: "production" },
  });
  assert.equal(accepted.response.statusCode, 200);
  assert.equal(accepted.response.getHeader("cache-control"), "no-store, max-age=0");
  assert.equal(accepted.response.json.totals.successfulPayments, "39");
  assert.equal(calls, 1);
});

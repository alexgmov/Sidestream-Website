import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadInjectedModule } from "../helpers/handler-loader.mjs";
import { invokeHandler } from "../helpers/http.mjs";

const ADMIN_SECRET = "customer-admin-integration-secret-2026";
const LIST_PATH = "/api/internal/customers";
const DETAIL_PATH = "/api/internal/customers/00000000-0000-4000-8000-000000000001";

const queryModule = await loadInjectedModule(
  new URL("../../api/_lib/customer-query.ts", import.meta.url),
  {
    "./postgres.js": {
      withPostgresTransaction: async () => {
        throw new Error("Customer query tests inject a transaction");
      },
    },
  },
);
const [listModule, detailModule] = await Promise.all([
  loadInjectedModule(new URL("../../api/internal/customers/index.ts", import.meta.url), {
    "../../_lib/customer-query.js": queryModule,
  }),
  loadInjectedModule(new URL("../../api/internal/customers/[customerId].ts", import.meta.url), {
    "../../_lib/customer-query.js": queryModule,
  }),
]);

test("missing, wrong, and multiple SIDESTREAM_CRM_ADMIN_SECRET credentials fail closed", async () => {
  for (const route of createAdminRoutes()) {
    for (const authorization of [
      undefined,
      "Bearer wrong-customer-admin-secret",
      [`Bearer ${ADMIN_SECRET}`, `Bearer ${ADMIN_SECRET}`],
      `Bearer ${ADMIN_SECRET}, Bearer ${ADMIN_SECRET}`,
    ]) {
      const result = await invokeHandler(route.handler, {
        method: "POST",
        url: route.path,
        headers: authorization === undefined ? {} : { authorization },
        body: { licenseNamespace: "test" },
      });
      assert.equal(result.response.statusCode, 401, route.path);
      assert.equal(result.response.json.code, "unauthorized", route.path);
      assertCustomerHeaders(result.response);
    }
    assert.equal(route.work(), 0, route.path);
  }

  for (const route of createAdminRoutes({
    getAdminSecret: () => {
      throw new Error("missing configuration");
    },
  })) {
    const result = await invokeHandler(route.handler, {
      method: "POST",
      url: route.path,
      headers: { authorization: `Bearer ${ADMIN_SECRET}` },
      body: { licenseNamespace: "test" },
    });
    assert.equal(result.response.statusCode, 503, route.path);
    assert.equal(result.response.json.code, "customer_admin_unavailable", route.path);
    assertCustomerHeaders(result.response);
  }
});

test("browser CORS, unsupported methods, and malformed JSON are rejected with no-store", async () => {
  for (const route of createAdminRoutes()) {
    const browser = await invokeHandler(route.handler, {
      method: "POST",
      url: route.path,
      headers: {
        authorization: `Bearer ${ADMIN_SECRET}`,
        origin: "https://sidestream.tv",
      },
      body: { licenseNamespace: "test" },
    });
    assert.equal(browser.response.statusCode, 403, route.path);
    assert.equal(browser.response.json.code, "browser_origin_forbidden", route.path);
    assertCustomerHeaders(browser.response);

    for (const method of ["GET", "PUT", "OPTIONS"]) {
      const unsupported = await invokeHandler(route.handler, {
        method,
        url: route.path,
        headers: { authorization: `Bearer ${ADMIN_SECRET}` },
      });
      assert.equal(unsupported.response.statusCode, 405, `${route.path} ${method}`);
      assert.equal(unsupported.response.getHeader("allow"), "POST");
      assertCustomerHeaders(unsupported.response);
    }

    const malformed = await invokeHandler(route.handler, {
      method: "POST",
      url: route.path,
      headers: { authorization: `Bearer ${ADMIN_SECRET}` },
      body: "{not-json",
    });
    assert.equal(malformed.response.statusCode, 400, route.path);
    assert.equal(malformed.response.json.code, "invalid_json", route.path);
    assertCustomerHeaders(malformed.response);
  }
});

test("authorized list and detail responses stay compact and no-store", async () => {
  const customer = { customerId: "00000000-0000-4000-8000-000000000001" };
  const [listRoute, detailRoute] = createAdminRoutes({ customer });
  const list = await invokeHandler(listRoute.handler, {
    method: "POST",
    url: listRoute.path,
    headers: { authorization: `Bearer ${ADMIN_SECRET}` },
    body: { licenseNamespace: "test" },
  });
  assert.equal(list.response.statusCode, 200);
  assert.deepEqual(list.response.json, { customers: [customer], nextCursor: null });
  assertCustomerHeaders(list.response);

  const detail = await invokeHandler(detailRoute.handler, {
    method: "POST",
    url: detailRoute.path,
    headers: { authorization: `Bearer ${ADMIN_SECRET}` },
    body: { licenseNamespace: "test" },
  });
  assert.equal(detail.response.statusCode, 200);
  assert.deepEqual(detail.response.json, { customer });
  assertCustomerHeaders(detail.response);
});

test("list defaults to 50, caps at 100, and signs filters into stable cursors", async () => {
  const first = profileRow("00000000-0000-4000-8000-000000000002", {
    contact_email: "one@example.com",
    sort_activity_at: "2026-07-15T12:00:00.000Z",
    profile_created_at: "2026-07-15T10:00:00.000Z",
  });
  const second = profileRow("00000000-0000-4000-8000-000000000001", {
    sort_activity_at: "2026-07-15T11:00:00.000Z",
    profile_created_at: "2026-07-15T09:00:00.000Z",
  });
  const defaultMock = mockTransaction([[first]], []);
  const defaultPage = await queryModule.queryCustomerList(
    { licenseNamespace: "test" },
    ADMIN_SECRET,
    { transaction: defaultMock.transaction },
  );
  assert.equal(defaultPage.customers.length, 1);
  assert.equal(defaultMock.profileCalls[0].params.at(-1), 51);

  await assert.rejects(
    queryModule.queryCustomerList(
      { licenseNamespace: "test", limit: 101 },
      ADMIN_SECRET,
      { transaction: defaultMock.transaction },
    ),
    (error) => error?.code === "invalid_limit",
  );

  const firstPageMock = mockTransaction([[first, second]], []);
  const firstPage = await queryModule.queryCustomerList(
    {
      licenseNamespace: "test",
      limit: 1,
      filters: { billingModel: "one_time" },
    },
    ADMIN_SECRET,
    { transaction: firstPageMock.transaction },
  );
  assert.equal(firstPage.customers[0].customerId, first.customer_id);
  assert.ok(firstPage.nextCursor);
  assert.match(firstPageMock.profileCalls[0].sql, /order by sort_activity_at desc, profile_created_at desc, customer_id desc/);

  const nextPageMock = mockTransaction([[second]], []);
  await queryModule.queryCustomerList(
    {
      licenseNamespace: "test",
      limit: 1,
      cursor: firstPage.nextCursor,
      filters: { billingModel: "one_time" },
    },
    ADMIN_SECRET,
    { transaction: nextPageMock.transaction },
  );
  assert.equal(nextPageMock.profileCalls[0].params[6], "2026-07-15T12:00:00.000Z");
  assert.equal(nextPageMock.profileCalls[0].params[7], "2026-07-15T10:00:00.000Z");
  assert.equal(nextPageMock.profileCalls[0].params[8], first.customer_id);

  const tampered = `A${firstPage.nextCursor.slice(1)}`;
  await assert.rejects(
    queryModule.queryCustomerList(
      {
        licenseNamespace: "test",
        limit: 1,
        cursor: tampered,
        filters: { billingModel: "one_time" },
      },
      ADMIN_SECRET,
      { transaction: nextPageMock.transaction },
    ),
    (error) => error?.code === "invalid_cursor",
  );
  await assert.rejects(
    queryModule.queryCustomerList(
      {
        licenseNamespace: "test",
        limit: 1,
        cursor: firstPage.nextCursor,
        filters: { billingModel: "one_time", hasEmail: true },
      },
      ADMIN_SECRET,
      { transaction: nextPageMock.transaction },
    ),
    (error) => error?.code === "invalid_cursor",
  );
});

test("NULL-heavy profiles and currency partitions map without raw source fields", async () => {
  const row = profileRow("00000000-0000-4000-8000-000000000010", {
    payload: { secret: "must-not-cross" },
    install_id_hash: "a".repeat(64),
  });
  const money = [
    moneyRow(row.customer_id, "eur", "500"),
    moneyRow(row.customer_id, "usd", "999"),
  ];
  const mock = mockTransaction([[row]], money);
  const result = await queryModule.queryCustomerList(
    { licenseNamespace: "test" },
    ADMIN_SECRET,
    { transaction: mock.transaction },
  );
  assert.deepEqual(result.customers[0].money.map((entry) => entry.currency), ["eur", "usd"]);
  assert.equal(result.customers[0].name, null);
  assert.equal(result.customers[0].usage.firstDownloadAttemptAt, null);
  assert.equal(result.customers[0].usage.firstDownloadSucceededAt, null);
  assert.doesNotMatch(JSON.stringify(result), /must-not-cross|install_id_hash|payload/);

  const source = await readFile(
    new URL("../../api/_lib/customer-query.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /select\s+\*/i);
  assert.doesNotMatch(
    source,
    /\b(?:data_points|identity_evidence|link_value|install_id_hash)\b|select[^;]*\bpayload\b/is,
  );
  assert.match(source, /select \$\{PROFILE_COLUMNS\}/);
  assert.match(source, /select \$\{MONEY_COLUMNS\}/);
});

function createAdminRoutes(options = {}) {
  let listWork = 0;
  let detailWork = 0;
  const getAdminSecret = options.getAdminSecret || (() => ADMIN_SECRET);
  const customer = options.customer || {
    customerId: "00000000-0000-4000-8000-000000000001",
  };
  return [
    {
      path: LIST_PATH,
      handler: listModule.createCustomerListHandler({
        getAdminSecret,
        listCustomers: async () => {
          listWork += 1;
          return { customers: [customer], nextCursor: null };
        },
      }),
      work: () => listWork,
    },
    {
      path: DETAIL_PATH,
      handler: detailModule.createCustomerDetailHandler({
        getAdminSecret,
        getCustomer: async () => {
          detailWork += 1;
          return customer;
        },
      }),
      work: () => detailWork,
    },
  ];
}

function profileRow(customerId, overrides = {}) {
  return {
    customer_id: customerId,
    license_namespace: "test",
    display_name: null,
    contact_email: null,
    profile_created_at: "2026-07-15T10:00:00.000Z",
    profile_updated_at: "2026-07-15T10:00:00.000Z",
    first_seen_at: null,
    last_activity_at: null,
    install_count: "0",
    first_install_seen_at: null,
    last_install_seen_at: null,
    platform_summary: null,
    app_version_summary: null,
    entitlement_status: null,
    billing_model: null,
    first_paid_at: null,
    last_paid_at: null,
    first_upgraded_at: null,
    last_upgraded_at: null,
    commerce_synced_at: null,
    first_download_attempt_at: null,
    first_download_succeeded_at: null,
    download_outcome_numerator: null,
    download_outcome_denominator: null,
    last_use_at: null,
    active_days_7: null,
    active_days_30: null,
    download_frequency_30d: null,
    usage_synced_at: null,
    usage_source_freshness_at: null,
    data_quality_flags: ["usage_not_synced", "missing_install_membership"],
    sort_activity_at: "2026-07-15T10:00:00.000Z",
    ...overrides,
  };
}

function moneyRow(customerId, currency, grossPaidMinor) {
  return {
    customer_id: customerId,
    currency,
    gross_paid_minor: grossPaidMinor,
    off_stripe_paid_minor: "0",
    refunded_minor: "0",
    disputed_minor: "0",
    net_paid_minor: grossPaidMinor,
    paid_transaction_count: "1",
    first_paid_at: "2026-07-15T10:00:00.000Z",
    last_paid_at: "2026-07-15T10:00:00.000Z",
    materialized_at: "2026-07-15T10:00:00.000Z",
  };
}

function mockTransaction(profilePages, moneyRows) {
  const pages = [...profilePages];
  const profileCalls = [];
  return {
    profileCalls,
    transaction: async (callback) => callback({
      query: async (sql, params = []) => {
        if (sql.includes("sidestream_customer_360_profile_read_model")) {
          profileCalls.push({ sql, params });
          return { rows: pages.shift() || [] };
        }
        if (sql.includes("sidestream_customer_360_money_read_model")) {
          const ids = new Set(params[0]);
          return { rows: moneyRows.filter((row) => ids.has(row.customer_id)) };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    }),
  };
}

function assertCustomerHeaders(response) {
  assert.equal(response.getHeader("cache-control"), "no-store, max-age=0");
  assert.equal(response.getHeader("pragma"), "no-cache");
  assert.equal(response.getHeader("vary"), "Authorization, Origin");
  assert.equal(response.getHeader("access-control-allow-origin"), undefined);
}

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadInjectedModule } from "./helpers/handler-loader.mjs";
import { sortCompiledApiRouteFiles } from "../server/route-order.ts";
import {
  parseMetaSpendCsv,
  summarizeMetaSpendRows,
} from "../scripts/import-meta-ad-spend.mjs";

const reportModule = await loadInjectedModule(
  new URL("../api/_lib/meta-roas-report.ts", import.meta.url),
  { "./postgres.js": { withPostgresTransaction: async () => ({ rows: [] }) } },
);
const customerAdminModule = await loadInjectedModule(
  new URL("../api/_lib/customer-admin.ts", import.meta.url),
  {},
);
const routeModule = await loadInjectedModule(
  new URL("../api/internal/meta-roas-report.ts", import.meta.url),
  {
    "../_lib/customer-admin.js": customerAdminModule,
    "../_lib/meta-roas-report.js": reportModule,
  },
);

const INPUT = Object.freeze({
  licenseNamespace: "production",
  from: "2026-08-01T00:00:00.000Z",
  through: "2026-08-31T00:00:00.000Z",
  asOf: "2026-08-31T12:00:00.000Z",
  campaign: null,
});

test("creative report isolates currency and calculates verified net ROAS and CAC", () => {
  const report = reportModule.buildMetaRoasReport(INPUT, [
    traffic("campaign-a", "1001", 20, 5, 3),
    traffic("campaign-a", "1002", 10, 2, 1),
  ], [
    purchase("campaign-a", "1001", "usd", 2, 3998),
    purchase("campaign-a", "1002", "usd", 1, 1899),
    purchase("campaign-a", "1001", "inr", 1, 159900),
  ], [
    spend("campaign-a", "1001", "usd", 2000, 10000, 300),
    spend("campaign-a", "1002", "usd", 2500, 9000, 220),
    spend("campaign-a", "1001", "inr", 80000, 8000, 200),
  ]);

  const creative = report.creatives.find((row) => row.creativeKey === "1001");
  const usd = creative.moneyByCurrency.find((row) => row.currency === "usd");
  assert.equal(usd.purchasedCustomers, "2");
  assert.equal(usd.netRevenueMinor, "3998");
  assert.equal(usd.spendMinor, "2000");
  assert.equal(usd.roas, 1.999);
  assert.equal(usd.cacMinor, 1000);
  assert.equal(usd.status, "ready");
  assert.equal(report.totals.byCurrency.some((row) => row.currency === "all"), false);
  assert.equal(report.totals.byCurrency.find((row) => row.currency === "usd").roas, 1.310444);
  assert.equal(report.totals.traffic.acquisitions, "30");
  assert.equal(report.reportDefinition.recommendedMetaUrlParameter, "utm_content={{ad.id}}");
});

test("missing creative and spend remain explicit instead of becoming false ROAS", () => {
  const report = reportModule.buildMetaRoasReport(INPUT, [
    traffic("campaign-a", null, 4, 1, 0),
    traffic("campaign-a", "1003", 8, 0, 0),
  ], [purchase("campaign-a", "1003", "usd", 1, 1999)], []);
  assert.equal(report.integrity.missingCreativeAcquisitions, "4");
  const money = report.creatives.find((row) => row.creativeKey === "1003").moneyByCurrency[0];
  assert.equal(money.roas, null);
  assert.equal(money.status, "missing_spend");
  assert.equal(report.integrity.creativeCurrencyRowsMissingSpend, 2);
});

test("request validation bounds namespace, time window, campaign, and unknown fields", () => {
  assert.deepEqual(reportModule.parseMetaRoasReportRequest(INPUT), INPUT);
  assert.throws(
    () => reportModule.parseMetaRoasReportRequest({ ...INPUT, licenseNamespace: "preview" }),
    /licenseNamespace/,
  );
  assert.throws(
    () => reportModule.parseMetaRoasReportRequest({ ...INPUT, through: INPUT.from }),
    /through must be after from/,
  );
  assert.throws(
    () => reportModule.parseMetaRoasReportRequest({ ...INPUT, campaign: "bad value" }),
    /campaign is invalid/,
  );
  assert.throws(
    () => reportModule.parseMetaRoasReportRequest({ ...INPUT, email: "x@example.com" }),
    /Unsupported field/,
  );
});

test("query uses one repeatable-read snapshot and all three bounded datasets", async () => {
  const observed = [];
  const report = await reportModule.queryMetaRoasReport(INPUT, {
    transaction: async (callback) => callback({
      async query(sql, parameters) {
        observed.push({ sql, parameters });
        if (sql.includes("sidestream_meta_ad_spend_daily")) return { rows: [] };
        if (sql.includes("purchase_candidates")) return { rows: [] };
        return { rows: [] };
      },
    }),
  });
  assert.equal(observed.length, 3);
  assert.ok(observed.every((entry) => entry.parameters[0] === "production"));
  assert.equal(report.platform, "meta");
});

test("protected route is POST-only and keeps browser callers out", async () => {
  const handler = routeModule.createMetaRoasReportHandler({
    getAdminSecret: () => "meta-roas-test-secret-long-enough",
    queryReport: async () => ({ schemaVersion: 1 }),
  });
  const unauthorized = await invoke(handler, { method: "GET" });
  assert.equal(unauthorized.statusCode, 405);
  const browser = await invoke(handler, {
    headers: {
      authorization: "Bearer meta-roas-test-secret-long-enough",
      origin: "https://sidestream.tv",
    },
  });
  assert.equal(browser.statusCode, 403);
  const allowed = await invoke(handler, {
    headers: { authorization: "Bearer meta-roas-test-secret-long-enough" },
    body: INPUT,
  });
  assert.equal(allowed.statusCode, 200);
});

test("Hetzner route ordering places static customer routes before the dynamic detail route", () => {
  const ordered = sortCompiledApiRouteFiles([
    "/compiled/api/internal/customers/[customerId].js",
    "/compiled/api/internal/customers/funnel.js",
    "/compiled/api/internal/customers/index.js",
  ]);
  assert.ok(ordered.indexOf("/compiled/api/internal/customers/funnel.js") <
    ordered.indexOf("/compiled/api/internal/customers/[customerId].js"));
});

test("spend migration is private, additive, currency-safe, and keyed to creative", async () => {
  const migration = await readFile(new URL(
    "../db/migrations/20260831120000_add_meta_ad_spend.sql",
    import.meta.url,
  ), "utf8");
  assert.match(migration, /create table public\.sidestream_meta_ad_spend_daily/i);
  assert.match(migration, /creative_key text not null/i);
  assert.match(migration, /spend_minor bigint not null/i);
  assert.match(migration, /currency ~ '\^\[a-z\]\{3\}\$'/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on table public\.sidestream_meta_ad_spend_daily from public/i);
  assert.doesNotMatch(migration, /\b(email|ip_address|stripe_customer)\b/i);
});

test("Meta spend CSV import contract is exact, integer-only, and replay-keyed", () => {
  const rows = parseMetaSpendCsv([
    "spend_day,campaign,creative_key,ad_id,currency,spend_minor,impressions,clicks",
    "2026-08-30,sidestream_direct_offer_test,2385001,2385001,usd,1234,10000,225",
    "2026-08-31,sidestream_direct_offer_test,2385001,2385001,usd,2345,12000,260",
  ].join("\n"));
  assert.equal(rows.length, 2);
  assert.deepEqual(summarizeMetaSpendRows(rows), {
    rows: 2,
    campaigns: 1,
    creatives: 1,
    currencies: ["usd"],
    firstDay: "2026-08-30",
    lastDay: "2026-08-31",
  });
  assert.throws(() => parseMetaSpendCsv(
    "spend_day,campaign,creative_key,ad_id,currency,spend_minor,impressions,clicks\n" +
    "2026-08-30,campaign,bad creative,1,usd,1,1,1",
  ), /creative_key/);
  assert.throws(() => parseMetaSpendCsv(
    "spend_day,campaign,creative_key,ad_id,currency,spend_minor,impressions,clicks\n" +
    "2026-08-30,campaign,1,1,usd,1.25,1,1",
  ), /spend_minor/);
});

function traffic(campaign, creative_key, acquisition_count, checkout_start_count, payment_stage_count) {
  return {
    campaign,
    creative_key,
    acquisition_count,
    landing_count: acquisition_count,
    email_handoff_count: 0,
    installer_request_count: 0,
    installation_claim_count: 0,
    authentication_count: 0,
    checkout_start_count,
    checkout_complete_count: payment_stage_count,
    payment_stage_count,
  };
}

function purchase(campaign, creative_key, currency, purchased_customer_count, net_revenue_minor) {
  return { campaign, creative_key, currency, purchased_customer_count, net_revenue_minor };
}

function spend(campaign, creative_key, currency, spend_minor, impressions, clicks) {
  return {
    campaign,
    creative_key,
    currency,
    spend_minor,
    impressions,
    clicks,
    spend_days: 30,
    latest_imported_at: "2026-08-31T10:00:00.000Z",
  };
}

async function invoke(handler, { method = "POST", headers = {}, body = {} } = {}) {
  const request = Object.assign(new EventEmitter(), {
    method,
    headers,
    rawHeaders: Object.entries(headers).flat(),
    body,
  });
  const response = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(payload = "") { this.payload = payload; },
  };
  await handler(request, response);
  return response;
}

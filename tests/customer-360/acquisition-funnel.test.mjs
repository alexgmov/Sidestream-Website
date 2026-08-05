import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadInjectedModule } from "../helpers/handler-loader.mjs";
import { invokeHandler } from "../helpers/http.mjs";

const ADMIN_SECRET = "acquisition-funnel-admin-secret-2026";
const VALID_BODY = {
  licenseNamespace: "test",
  cohortStart: "2026-07-01T00:00:00Z",
  cohortEnd: "2026-08-01T00:00:00Z",
  observationEnd: "2026-09-01T00:00:00Z",
  journeyLimit: 2,
};
const CURSOR_SECRET = "acquisition-funnel-cursor-secret-2026";

const funnelModule = await loadInjectedModule(
  new URL("../../api/_lib/acquisition-funnel.ts", import.meta.url),
  {
    "./postgres.js": {
      withPostgresTransaction: async () => {
        throw new Error("Funnel tests inject a transaction");
      },
    },
  },
);
const routeModule = await loadInjectedModule(
  new URL("../../api/internal/customers/funnel.ts", import.meta.url),
  {
    "../../_lib/acquisition-funnel.js": funnelModule,
  },
);

test("funnel route is POST-only, non-browser, secret-protected, and no-store", async () => {
  let calls = 0;
  const handler = routeModule.createAcquisitionFunnelHandler({
    getAdminSecret: () => ADMIN_SECRET,
    queryFunnel: async () => {
      calls += 1;
      return { groups: [], journeys: [] };
    },
  });

  for (const method of ["GET", "PUT", "OPTIONS"]) {
    const result = await invokeHandler(handler, {
      method,
      url: "/api/internal/customers/funnel",
      headers: { authorization: `Bearer ${ADMIN_SECRET}` },
    });
    assert.equal(result.response.statusCode, 405);
    assert.equal(result.response.getHeader("allow"), "POST");
    assertPrivateHeaders(result.response);
  }

  for (const authorization of [undefined, "Bearer incorrect-secret"]) {
    const result = await invokeHandler(handler, {
      method: "POST",
      url: "/api/internal/customers/funnel",
      headers: authorization ? { authorization } : {},
      body: VALID_BODY,
    });
    assert.equal(result.response.statusCode, 401);
    assert.equal(result.response.json.code, "unauthorized");
  }

  const browser = await invokeHandler(handler, {
    method: "POST",
    url: "/api/internal/customers/funnel",
    headers: {
      authorization: `Bearer ${ADMIN_SECRET}`,
      origin: "https://sidestream.tv",
    },
    body: VALID_BODY,
  });
  assert.equal(browser.response.statusCode, 403);
  assert.equal(browser.response.json.code, "browser_origin_forbidden");
  assert.equal(calls, 0);

  const accepted = await invokeHandler(handler, {
    method: "POST",
    url: "/api/internal/customers/funnel",
    headers: { authorization: `Bearer ${ADMIN_SECRET}` },
    body: VALID_BODY,
  });
  assert.equal(accepted.response.statusCode, 200);
  assert.deepEqual(accepted.response.json, { groups: [], journeys: [] });
  assertPrivateHeaders(accepted.response);
  assert.equal(calls, 1);
});

test("request contract rejects unknown keys and unbounded or non-UTC windows", async () => {
  const invalidRequests = [
    [{ ...VALID_BODY, email: "forbidden@example.com" }, "unknown_request_key"],
    [{ ...VALID_BODY, licenseNamespace: "preview" }, "invalid_namespace"],
    [{ ...VALID_BODY, cohortStart: "2026-07-01T00:00:00-07:00" }, "invalid_cohort_window"],
    [{ ...VALID_BODY, cohortEnd: VALID_BODY.cohortStart }, "invalid_cohort_window"],
    [{ ...VALID_BODY, observationEnd: undefined }, "invalid_cohort_window"],
    [{
      ...VALID_BODY,
      observationEnd: "2026-09-01T12:00:00Z",
    }, "invalid_cohort_window"],
    [{
      ...VALID_BODY,
      observationEnd: "2026-07-31T00:00:00Z",
    }, "invalid_cohort_window"],
    [{
      ...VALID_BODY,
      cohortStart: "2025-01-01T00:00:00Z",
      cohortEnd: "2026-08-01T00:00:00Z",
    }, "invalid_cohort_window"],
    [{
      ...VALID_BODY,
      cohortStart: "2024-01-01T00:00:00Z",
      cohortEnd: "2024-02-01T00:00:00Z",
      observationEnd: "2026-01-01T00:00:00Z",
    }, "invalid_cohort_window"],
    [{ ...VALID_BODY, journeyLimit: 101 }, "invalid_journey_limit"],
    [{ ...VALID_BODY, journeyLimit: 1.5 }, "invalid_journey_limit"],
    [{ ...VALID_BODY, cohortBasis: "payment_time_guess" }, "invalid_cohort_basis"],
    [{ ...VALID_BODY, journeyCursor: "forged.cursor" }, "invalid_journey_cursor"],
  ];

  for (const [request, code] of invalidRequests) {
    await assert.rejects(
      funnelModule.queryAcquisitionFunnel(request, {
        transaction: async () => {
          throw new Error("invalid input reached the database");
        },
      }),
      (error) => error?.code === code,
    );
  }
});

test("aggregate and journey output exposes all ratios without raw linkage", async () => {
  const sqlCalls = [];
  const transaction = async (callback) => callback({
    query: async (sql, params) => {
      sqlCalls.push({ sql, params });
      if (sql.includes("group by\n        source")) {
        return {
          rows: [
            {
              source: "manychat",
              medium: "dm",
              campaign: "launch",
              experiment: "mc-mobile-paid-v1",
              cohort: "mc-paid-v1",
              attribution_confidence: "exact_paid_checkout",
              integrity_state: "historical_unlinked",
              profile_count: "2",
              first_opened_count: "2",
              completed_activation_count: "1",
              paid_customer_count: "1",
              return_eligible_count: "2",
              returned_count: "1",
              one_and_done_count: "1",
            },
            {
              source: "unknown",
              medium: null,
              campaign: null,
              experiment: null,
              cohort: null,
              attribution_confidence: "unattributed",
              integrity_state: "missing_internal_linkage",
              profile_count: "1",
              first_opened_count: "0",
              completed_activation_count: "0",
              paid_customer_count: "0",
              return_eligible_count: "0",
              returned_count: "0",
              one_and_done_count: "0",
            },
          ],
        };
      }
      if (sql.includes("from public.sidestream_acquisition_stages")) {
        return { rows: [{
          stage: "payment_settled",
          counting_grain: "payment",
          distinct_count: "1",
        }] };
      }
      if (sql.includes("select integrity_state, count(distinct id)")) {
        return { rows: [
          { integrity_state: "missing_internal_linkage", acquisition_count: "2" },
          { integrity_state: "historical_unlinked", acquisition_count: "1" },
        ] };
      }
      return {
        rows: [{
          customer_id: "00000000-0000-4000-8000-000000000001",
          source: "manychat",
          medium: "dm",
          campaign: "launch",
          experiment: "mc-mobile-paid-v1",
          cohort: "mc-paid-v1",
          attribution_confidence: "exact_paid_checkout",
          integrity_state: "historical_unlinked",
          first_attributed_at: "2026-07-01T12:00:00Z",
          first_installer_requested_at: null,
          first_installer_platform: null,
          first_install_at: "2026-07-02T12:00:00Z",
          first_purchase_at: "2026-07-03T12:00:00Z",
          cohort_at: "2026-07-02T12:00:00Z",
          first_open_at: "2026-07-02T13:00:00Z",
          activation_at: "2026-07-03T12:00:00Z",
          day_zero_download_attempts: "3",
          later_open_days: ["2026-07-05"],
          return_eligible: true,
          paid_customer: true,
          email: "must-not-cross@example.com",
          link_value: "must-not-cross",
        }],
      };
    },
  });

  const result = await funnelModule.queryAcquisitionFunnel(
    VALID_BODY,
    CURSOR_SECRET,
    { transaction },
  );
  assert.deepEqual(result.activationPercentage, {
    numerator: "1",
    denominator: "2",
    percentage: "50.00",
  });
  assert.deepEqual(result.paidCustomerPercentage, {
    numerator: "1",
    denominator: "3",
    percentage: "33.33",
  });
  assert.equal(result.totals.paidCustomers, "1");
  assert.deepEqual(result.firstOpenPercentage, {
    numerator: "2",
    denominator: "3",
    percentage: "66.67",
  });
  assert.deepEqual(result.returnPercentage, {
    numerator: "1",
    denominator: "2",
    percentage: "50.00",
  });
  assert.deepEqual(result.oneAndDonePercentage, {
    numerator: "1",
    denominator: "2",
    percentage: "50.00",
  });
  assert.deepEqual(result.attributionCoverage, {
    numerator: "2",
    denominator: "3",
    percentage: "66.67",
    paidAttributedProfiles: "2",
    anonymousAttributedProfiles: "0",
    freemiumAttributedProfiles: "0",
    unattributedProfiles: "1",
  });
  assert.deepEqual(result.coverage.unknown, {
    numerator: "1",
    denominator: "3",
    percentage: "33.33",
  });
  assert.equal(result.groups[0].activationPercentage.percentage, "50.00");
  assert.equal(result.groups[0].paidCustomers, "1");
  assert.equal(result.sourceTotals[0].paidCustomers, "1");
  assert.equal(result.stageCounts.length, 10);
  assert.equal(
    result.stageCounts.find((stage) => stage.stage === "payment_settled").count,
    "1",
  );
  assert.equal(result.integrityAlerts.missingInternalLinkage.acquisitionCount, "2");
  assert.equal(result.integrityAlerts.historicalUnlinked.acquisitionCount, "1");
  assert.equal(result.journeys[0].dayZeroDownloadAttempts, "3");
  assert.equal(result.journeys[0].returnEligible, true);
  assert.equal(result.journeys[0].returned, true);
  assert.equal(result.journeys[0].oneAndDone, false);
  assert.equal(result.journeys[0].completedActivation, true);
  assert.equal(result.journeys[0].paidCustomer, true);
  assert.equal(result.journeys[0].firstVisitAt, "2026-07-01T12:00:00.000Z");
  assert.equal(result.journeysTruncated, true);
  assert.doesNotMatch(
    JSON.stringify(result),
    /must-not-cross|"email"\s*:|link_value|install_id_hash|assignmentIdHash/i,
  );

  assert.equal(sqlCalls.length, 4);
  assert.match(sqlCalls[0].sql, /payment_state = 'active'/);
  assert.match(sqlCalls[0].sql, /join public\.sidestream_checkout_intents core/);
  assert.match(sqlCalls[0].sql, /left join public\.sidestream_acquisitions acquisition/);
  assert.match(
    sqlCalls[0].sql,
    /coalesce\(acquisition\.first_observed_source, 'manychat'\) as source/,
  );
  assert.match(sqlCalls[0].sql, /claim\.claim_state = 'claimed'/);
  assert.match(sqlCalls[0].sql, /lead\.cta_source = 'mobile-download-handoff'/);
  assert.match(sqlCalls[0].sql, /sidestream_anonymous_acquisition_sessions/);
  assert.match(sqlCalls[0].sql, /'exact_paid_checkout'/);
  assert.match(sqlCalls[0].sql, /'exact_anonymous_claim'/);
  assert.match(sqlCalls[0].sql, /'exact_verified_email'/);
  assert.match(sqlCalls[0].sql, /first_touch_medium is distinct from 'installation_claim'/);
  assert.match(sqlCalls[0].sql, /paid\.first_attributed_at <= cohort\.cohort_at/);
  assert.match(sqlCalls[0].sql, /lead\.first_captured_at <= cohort\.cohort_at/);
  assert.match(sqlCalls[0].sql, /lead\.last_captured_at <= cohort\.cohort_at/);
  assert.match(sqlCalls[0].sql, /account\.email = profile\.contact_email/);
  assert.match(
    sqlCalls[0].sql,
    /where first_open_at is not null and activation_at is not null/,
  );
  assert.match(sqlCalls[0].sql, /money\.net_paid_minor > 0/);
  assert.match(sqlCalls[0].sql, /money\.first_paid_at < \$4::timestamptz/);
  assert.match(sqlCalls[0].sql, /order by[\s\S]*paid\.first_attributed_at[\s\S]*paid\.entry_id/);
  assert.match(sqlCalls[1].sql, /order by cohort_at, profile_id[\s\S]*limit \$6/);
  assert.deepEqual(sqlCalls[1].params, [
    "test",
    "2026-07-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
    "2026-09-01T00:00:00.000Z",
    "first_install",
    3,
    null,
    null,
  ]);
});

test("journey cursors are deterministic and bind namespace, basis, limit, and window", async () => {
  const rows = [1, 2].map((value) => ({
    customer_id: `00000000-0000-4000-8000-00000000000${value}`,
    source: "website_direct_or_unknown",
    medium: null,
    campaign: null,
    experiment: null,
    cohort: null,
    attribution_confidence: "exact_sidestream_entry",
    integrity_state: "intact",
    first_attributed_at: "2026-07-01T00:00:00Z",
    first_installer_requested_at: null,
    first_installer_platform: null,
    cohort_at: `2026-07-0${value}T00:00:00Z`,
    first_install_at: `2026-07-0${value}T00:00:00Z`,
    first_purchase_at: null,
    first_open_at: null,
    activation_at: null,
    day_zero_download_attempts: "0",
    later_open_days: [],
    return_eligible: false,
    paid_customer: false,
  }));
  const group = {
    source: "website_direct_or_unknown",
    medium: null,
    campaign: null,
    experiment: null,
    cohort: null,
    attribution_confidence: "exact_sidestream_entry",
    integrity_state: "intact",
    profile_count: "2",
    first_opened_count: "0",
    completed_activation_count: "0",
    paid_customer_count: "0",
    return_eligible_count: "0",
    returned_count: "0",
    one_and_done_count: "0",
  };
  const transaction = async (callback) => callback({
    query: async (sql) => ({
      rows: sql.includes("group by\n        source") ? [group]
        : sql.includes("from attributed_profiles") ? rows
          : [],
    }),
  });
  const request = { ...VALID_BODY, journeyLimit: 1 };
  const first = await funnelModule.queryAcquisitionFunnel(
    request,
    CURSOR_SECRET,
    { transaction },
  );
  const repeated = await funnelModule.queryAcquisitionFunnel(
    request,
    CURSOR_SECRET,
    { transaction },
  );
  assert.equal(first.nextJourneyCursor, repeated.nextJourneyCursor);
  assert.ok(first.nextJourneyCursor);
  await assert.rejects(funnelModule.queryAcquisitionFunnel({
    ...request,
    cohortBasis: "first_purchase",
    journeyCursor: first.nextJourneyCursor,
  }, CURSOR_SECRET, { transaction }), (error) => error?.code === "invalid_journey_cursor");
});

test("zero first-open denominator returns an explicit null percentage", async () => {
  const result = await funnelModule.queryAcquisitionFunnel({
    ...VALID_BODY,
    journeyLimit: undefined,
  }, {
    transaction: async (callback) => callback({
      query: async (sql) => ({
        rows: sql.includes("group by\n        source") ? [{
          source: "unknown",
          medium: null,
          campaign: null,
          experiment: null,
          cohort: null,
          attribution_confidence: "unattributed",
          profile_count: "1",
          first_opened_count: "0",
          completed_activation_count: "0",
          paid_customer_count: "0",
          return_eligible_count: "0",
          returned_count: "0",
          one_and_done_count: "0",
        }] : [],
      }),
    }),
  });
  assert.deepEqual(result.activationPercentage, {
    numerator: "0",
    denominator: "0",
    percentage: null,
  });
  assert.equal(result.journeyLimit, 50);
});

test("source uses explicit columns and never selects raw identity values into output", async () => {
  const source = await readFile(
    new URL("../../api/_lib/acquisition-funnel.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /select\s+\*/i);
  assert.doesNotMatch(source, /\b(?:referrer|user_agent|ip_address)\b/i);
  assert.doesNotMatch(source, /\b(?:similarity|levenshtein|soundex)\s*\(/i);
  assert.doesNotMatch(source, /(?:payload|data_points)\s*->[^\n]*(?:source|utm_source)/i);
});

function assertPrivateHeaders(response) {
  assert.equal(response.getHeader("cache-control"), "no-store, max-age=0");
  assert.equal(response.getHeader("pragma"), "no-cache");
  assert.equal(response.getHeader("vary"), "Authorization, Origin");
  assert.equal(response.getHeader("access-control-allow-origin"), undefined);
}

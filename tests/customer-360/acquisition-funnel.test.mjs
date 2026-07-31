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
              attribution_confidence: "verified_paid",
              profile_count: "2",
              first_opened_count: "2",
              completed_activation_count: "1",
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
              profile_count: "1",
              first_opened_count: "0",
              completed_activation_count: "0",
              return_eligible_count: "0",
              returned_count: "0",
              one_and_done_count: "0",
            },
          ],
        };
      }
      return {
        rows: [{
          customer_id: "00000000-0000-4000-8000-000000000001",
          source: "manychat",
          medium: "dm",
          campaign: "launch",
          experiment: "mc-mobile-paid-v1",
          cohort: "mc-paid-v1",
          attribution_confidence: "verified_paid",
          first_attributed_at: "2026-07-01T12:00:00Z",
          first_install_at: "2026-07-02T12:00:00Z",
          first_open_at: "2026-07-02T13:00:00Z",
          activation_at: "2026-07-03T12:00:00Z",
          day_zero_download_attempts: "3",
          later_open_days: ["2026-07-05"],
          return_eligible: true,
          email: "must-not-cross@example.com",
          link_value: "must-not-cross",
        }],
      };
    },
  });

  const result = await funnelModule.queryAcquisitionFunnel(VALID_BODY, { transaction });
  assert.deepEqual(result.activationPercentage, {
    numerator: "1",
    denominator: "2",
    percentage: "50.00",
  });
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
    freemiumAttributedProfiles: "0",
    unattributedProfiles: "1",
  });
  assert.equal(result.groups[0].activationPercentage.percentage, "50.00");
  assert.equal(result.journeys[0].dayZeroDownloadAttempts, "3");
  assert.equal(result.journeys[0].returnEligible, true);
  assert.equal(result.journeys[0].returned, true);
  assert.equal(result.journeys[0].oneAndDone, false);
  assert.equal(result.journeysTruncated, true);
  assert.doesNotMatch(
    JSON.stringify(result),
    /must-not-cross|email|link_value|install_id_hash|assignmentIdHash/i,
  );

  assert.equal(sqlCalls.length, 2);
  assert.match(sqlCalls[0].sql, /payment_state = 'active'/);
  assert.match(sqlCalls[0].sql, /claim\.claim_state = 'claimed'/);
  assert.match(sqlCalls[0].sql, /lead\.cta_source = 'mobile-download-handoff'/);
  assert.match(sqlCalls[0].sql, /paid\.first_attributed_at <= cohort\.first_install_at/);
  assert.match(sqlCalls[0].sql, /lead\.first_captured_at <= cohort\.first_install_at/);
  assert.match(sqlCalls[0].sql, /lead\.last_captured_at <= cohort\.first_install_at/);
  assert.match(sqlCalls[0].sql, /account\.email = profile\.contact_email/);
  assert.match(
    sqlCalls[0].sql,
    /where first_open_at is not null and activation_at is not null/,
  );
  assert.match(sqlCalls[0].sql, /order by[\s\S]*paid\.first_attributed_at[\s\S]*paid\.entry_id/);
  assert.match(sqlCalls[1].sql, /order by first_install_at, profile_id[\s\S]*limit \$5/);
  assert.deepEqual(sqlCalls[1].params, [
    "test",
    "2026-07-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
    "2026-09-01T00:00:00.000Z",
    2,
  ]);
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
});

function assertPrivateHeaders(response) {
  assert.equal(response.getHeader("cache-control"), "no-store, max-age=0");
  assert.equal(response.getHeader("pragma"), "no-cache");
  assert.equal(response.getHeader("vary"), "Authorization, Origin");
  assert.equal(response.getHeader("access-control-allow-origin"), undefined);
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPreviewDeploymentVerification,
  parsePreviewDeploymentArguments,
  READ_ONLY_MODE,
  ROUTE_PRESENCE_PROBES,
  usageSyncConfirmationForHost,
  USAGE_SYNC_MODE,
  validatePreviewTarget,
  verifyCustomer360PreviewDeployment,
} from "../../scripts/verify-customer-360-preview-deployment.mjs";

const ORIGIN = "https://sidestream-git-c360-preview-team.vercel.app";
const HOST = "sidestream-git-c360-preview-team.vercel.app";
const ADMIN_SECRET = "fixture-preview-admin-secret";
const CRON_SECRET = "fixture-preview-cron-secret";

test("Preview target validation refuses every Production, local, and ambiguous origin", () => {
  const refused = [
    ["https://sidestream.tv", "sidestream.tv"],
    ["https://www.sidestream.tv", "www.sidestream.tv"],
    ["https://sidestream-xi.vercel.app", "sidestream-xi.vercel.app"],
    ["https://SIDESTREAM.TV./", "sidestream.tv"],
    ["http://preview.example.com", "preview.example.com"],
    ["https://localhost", "localhost"],
    ["https://preview.localhost", "preview.localhost"],
    ["https://127.0.0.1", "127.0.0.1"],
    ["https://[::1]", "[::1]"],
    ["https://user:password@preview.example.com", "preview.example.com"],
    ["https://preview.example.com/#fragment", "preview.example.com"],
    ["https://preview.example.com/api/internal/customers", "preview.example.com"],
    ["https://preview.example.com/?selector=test", "preview.example.com"],
    ["https://preview.example.com", "different.example.com"],
    ["https://preview.example.com", "https://preview.example.com"],
  ];

  for (const [origin, host] of refused) {
    assert.throws(
      () => validatePreviewTarget(origin, host),
      { name: "PreviewDeploymentInputError" },
      `${origin} with ${host}`,
    );
  }
  assert.deepEqual(validatePreviewTarget(ORIGIN, HOST), {
    origin: ORIGIN,
    hostname: HOST,
  });
});

test("CLI parsing rejects duplicate, positional, secret, and mode-ambiguous selectors", () => {
  const base = ["--origin", ORIGIN, "--expected-deployment-host", HOST];
  const refused = [
    [...base, "--origin", ORIGIN],
    [...base, "--expected-deployment-host", HOST],
    [...base, "--mode", READ_ONLY_MODE, "--mode", USAGE_SYNC_MODE],
    [...base, "--confirm", usageSyncConfirmationForHost(HOST)],
    [...base, "--mode", "write"],
    [...base, "--mode", USAGE_SYNC_MODE],
    [...base, "--mode", USAGE_SYNC_MODE, "--confirm", "yes"],
    [ORIGIN, "--expected-deployment-host", HOST],
    ["--origin", ORIGIN, HOST],
    [...base, "--cron-secret", CRON_SECRET],
    [...base, "--admin-secret", ADMIN_SECRET],
    [`--origin=${ORIGIN}`, "--expected-deployment-host", HOST],
  ];
  for (const argv of refused) {
    assert.throws(
      () => parsePreviewDeploymentArguments(argv),
      { name: "PreviewDeploymentInputError" },
    );
  }

  assert.deepEqual(parsePreviewDeploymentArguments(base), {
    origin: ORIGIN,
    expectedDeploymentHost: HOST,
    mode: READ_ONLY_MODE,
    confirmation: undefined,
  });
  const confirmation = usageSyncConfirmationForHost(HOST);
  assert.deepEqual(parsePreviewDeploymentArguments([
    ...base,
    "--mode",
    USAGE_SYNC_MODE,
    "--confirm",
    confirmation,
  ]), {
    origin: ORIGIN,
    expectedDeploymentHost: HOST,
    mode: USAGE_SYNC_MODE,
    confirmation,
  });
});

test("invalid configuration and missing environment secrets make no requests", async () => {
  let requestCount = 0;
  const dependencies = {
    environment: {},
    fetch: async () => {
      requestCount += 1;
      throw new Error("network must not be called");
    },
    createSignal: () => undefined,
  };

  let result = await verifyCustomer360PreviewDeployment({
    origin: "https://sidestream.tv",
    expectedDeploymentHost: "sidestream.tv",
  }, dependencies);
  assert.equal(result.pass, false);
  assert.equal(result.requestCount, 0);
  assert.equal(requestCount, 0);

  result = await verifyCustomer360PreviewDeployment({
    origin: ORIGIN,
    expectedDeploymentHost: HOST,
  }, dependencies);
  assert.equal(result.pass, false);
  assert.deepEqual(result.checks, [
    { id: "configuration.admin_secret", pass: false },
  ]);
  assert.equal(result.requestCount, 0);
  assert.equal(requestCount, 0);

  result = await verifyCustomer360PreviewDeployment({
    origin: ORIGIN,
    expectedDeploymentHost: HOST,
    mode: USAGE_SYNC_MODE,
    confirmation: usageSyncConfirmationForHost(HOST),
  }, {
    ...dependencies,
    environment: { SIDESTREAM_CRM_ADMIN_SECRET: ADMIN_SECRET },
  });
  assert.deepEqual(result.checks, [
    { id: "configuration.cron_secret", pass: false },
  ]);
  assert.equal(result.requestCount, 0);
  assert.equal(requestCount, 0);
});

test("default mode executes the complete read-only request contract without an authorized mutation", async () => {
  const fixture = createFetchFixture();
  const result = await verifyCustomer360PreviewDeployment({
    origin: ORIGIN,
    expectedDeploymentHost: HOST,
  }, {
    environment: {
      SIDESTREAM_CRM_ADMIN_SECRET: ADMIN_SECRET,
      CRON_SECRET,
    },
    fetch: fixture.fetch,
    createSignal: () => undefined,
  });

  assert.equal(result.pass, true, formatPreviewDeploymentVerification(result));
  assert.equal(result.mode, READ_ONLY_MODE);
  assert.equal(result.requestCount, 8 + ROUTE_PRESENCE_PROBES.length);
  assert.equal(fixture.authorizedUsageSyncRequests, 0);
  assert.deepEqual(
    fixture.requests.map(({ pathname, method }) => [pathname, method]),
    [
      ["/", "HEAD"],
      ["/api/internal/customers", "POST"],
      ["/api/internal/customers", "POST"],
      ["/api/internal/customer-usage/sync", "GET"],
      ["/api/internal/customer-usage/sync", "GET"],
      ["/api/internal/customers", "POST"],
      ["/api/internal/customers", "POST"],
      ["/api/internal/customers", "POST"],
      ...ROUTE_PRESENCE_PROBES.map((probe) => [
        new URL(probe.path, ORIGIN).pathname,
        probe.method,
      ]),
    ],
  );
  assertRequestShapes(fixture.requests);
});

test("usage-sync is an explicit host-bound final GET using only the environment secret", async () => {
  const fixture = createFetchFixture();
  const confirmation = usageSyncConfirmationForHost(HOST);
  const result = await verifyCustomer360PreviewDeployment({
    origin: ORIGIN,
    expectedDeploymentHost: HOST,
    mode: USAGE_SYNC_MODE,
    confirmation,
  }, {
    environment: {
      SIDESTREAM_CRM_ADMIN_SECRET: ADMIN_SECRET,
      CRON_SECRET,
    },
    fetch: fixture.fetch,
    createSignal: () => undefined,
  });

  assert.equal(result.pass, true, formatPreviewDeploymentVerification(result));
  assert.equal(result.mode, USAGE_SYNC_MODE);
  assert.equal(result.requestCount, 9 + ROUTE_PRESENCE_PROBES.length);
  assert.equal(fixture.authorizedUsageSyncRequests, 1);
  const finalRequest = fixture.requests.at(-1);
  assert.equal(finalRequest.pathname, "/api/internal/customer-usage/sync");
  assert.equal(finalRequest.search, "");
  assert.equal(finalRequest.method, "GET");
  assert.equal(finalRequest.body, undefined);
  assert.equal(finalRequest.authorization, `Bearer ${CRON_SECRET}`);
  assert.equal(finalRequest.originHeader, null);
  assert.equal(finalRequest.redirect, "manual");
  assert.equal(finalRequest.credentials, "omit");
});

test("a failed read-only gate prevents the authorized usage-sync request", async () => {
  const fixture = createFetchFixture({ malformedList: true });
  const result = await verifyCustomer360PreviewDeployment({
    origin: ORIGIN,
    expectedDeploymentHost: HOST,
    mode: USAGE_SYNC_MODE,
    confirmation: usageSyncConfirmationForHost(HOST),
  }, {
    environment: {
      SIDESTREAM_CRM_ADMIN_SECRET: ADMIN_SECRET,
      CRON_SECRET,
    },
    fetch: fixture.fetch,
    createSignal: () => undefined,
  });

  assert.equal(result.pass, false);
  assert.equal(
    result.checks.find((entry) => entry.id === "admin.list_shape")?.pass,
    false,
  );
  assert.equal(
    result.checks.some((entry) => entry.id === "usage_sync.once"),
    false,
  );
  assert.equal(fixture.authorizedUsageSyncRequests, 0);
});

test("formatted results and failures never expose secrets, headers, bodies, or thrown messages", async () => {
  const sentinel = "NEVER_PRINT_OPERATOR_SECRET";
  const result = await verifyCustomer360PreviewDeployment({
    origin: ORIGIN,
    expectedDeploymentHost: HOST,
  }, {
    environment: {
      SIDESTREAM_CRM_ADMIN_SECRET: `${sentinel}_ADMIN`,
      CRON_SECRET: `${sentinel}_CRON`,
    },
    fetch: async () => {
      throw new Error(`${sentinel}_FETCH_ERROR`);
    },
    createSignal: () => undefined,
  });
  const output = formatPreviewDeploymentVerification(result);

  assert.equal(result.pass, false);
  assert.doesNotMatch(output, new RegExp(sentinel));
  assert.doesNotMatch(output, /Bearer|Authorization|https:\/\//i);
  assert.equal(
    output.split("\n").every((line) => /^(?:PASS|FAIL) [a-z0-9_.-]+$/.test(line)),
    true,
  );
});

function createFetchFixture(options = {}) {
  const requests = [];
  let authorizedUsageSyncRequests = 0;

  const fetch = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    const headers = new Headers(init.headers);
    const request = {
      pathname: url.pathname,
      search: url.search,
      method: init.method,
      body: init.body,
      authorization: headers.get("authorization"),
      originHeader: headers.get("origin"),
      contentType: headers.get("content-type"),
      redirect: init.redirect,
      credentials: init.credentials,
      cache: init.cache,
    };
    requests.push(request);

    if (url.pathname === "/" && init.method === "HEAD") {
      return response(null, 200, {
        Server: "Vercel",
        "X-Vercel-Id": "sfo1::preview-fixture-123",
      });
    }

    if (url.pathname === "/api/internal/customers") {
      if (request.originHeader !== null) {
        return jsonResponse({ code: "browser_origin_forbidden" }, 403);
      }
      if (request.authorization === null || request.authorization === "Bearer wrong") {
        return jsonResponse({ code: "unauthorized" }, 401);
      }
      assert.equal(request.authorization, `Bearer ${ADMIN_SECRET}`);
      assert.equal(request.contentType, "application/json");
      const body = JSON.parse(request.body);
      if (body.licenseNamespace === "preview") {
        return jsonResponse({ code: "invalid_namespace" }, 400);
      }
      assert.deepEqual(body, { licenseNamespace: "test", limit: 1 });
      if (options.malformedList) {
        return jsonResponse({ customers: [], nextCursor: null, leaked: true }, 200);
      }
      return jsonResponse({ customers: [customerFixture()], nextCursor: null }, 200);
    }

    if (url.pathname === "/api/internal/customer-usage/sync") {
      if (request.authorization === null || request.authorization === "Bearer wrong") {
        return jsonResponse({ code: "unauthorized" }, 401);
      }
      assert.equal(request.authorization, `Bearer ${CRON_SECRET}`);
      authorizedUsageSyncRequests += 1;
      return jsonResponse({
        ok: true,
        outcome: "completed",
        licenseNamespace: "test",
        batches: 1,
        sourceRowsScanned: 2,
        dailyBucketsWritten: 2,
        profilesRefreshed: 1,
        sourceFreshnessAt: "2026-07-17T10:00:00.000Z",
      }, 200);
    }

    const probe = ROUTE_PRESENCE_PROBES.find((entry) =>
      new URL(entry.path, ORIGIN).pathname === url.pathname &&
      new URL(entry.path, ORIGIN).search === url.search &&
      entry.method === init.method
    );
    assert.ok(probe, `unexpected fixture request ${init.method} ${url.pathname}${url.search}`);
    return response(null, probe.status, probe.allow ? { Allow: probe.allow } : {});
  };

  return {
    fetch,
    requests,
    get authorizedUsageSyncRequests() {
      return authorizedUsageSyncRequests;
    },
  };
}

function assertRequestShapes(requests) {
  for (const request of requests) {
    assert.equal(request.redirect, "manual");
    assert.equal(request.credentials, "omit");
    assert.equal(request.cache, "no-store");
  }

  const customerRequests = requests.filter((request) =>
    request.pathname === "/api/internal/customers"
  );
  assert.equal(customerRequests.length, 5);
  assert.deepEqual(customerRequests.map((request) => request.method), [
    "POST",
    "POST",
    "POST",
    "POST",
    "POST",
  ]);
  assert.equal(customerRequests[0].authorization, null);
  assert.equal(customerRequests[1].authorization, "Bearer wrong");
  assert.equal(customerRequests[2].originHeader, "https://operator-browser-origin.invalid");
  assert.equal(customerRequests[2].authorization, null);
  assert.deepEqual(JSON.parse(customerRequests[3].body), {
    licenseNamespace: "preview",
    limit: 1,
  });
  assert.deepEqual(JSON.parse(customerRequests[4].body), {
    licenseNamespace: "test",
    limit: 1,
  });

  const usageRequests = requests.filter((request) =>
    request.pathname === "/api/internal/customer-usage/sync"
  );
  assert.equal(usageRequests.length, 2);
  assert.deepEqual(usageRequests.map((request) => request.authorization), [
    null,
    "Bearer wrong",
  ]);
  assert.equal(usageRequests.every((request) => request.body === undefined), true);
}

function response(body, status, headers = {}) {
  return new Response(body, { status, headers });
}

function jsonResponse(body, status) {
  return response(JSON.stringify(body), status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
  });
}

function customerFixture() {
  return {
    customerId: "123e4567-e89b-42d3-a456-426614174000",
    licenseNamespace: "test",
    name: null,
    email: null,
    profileLifecycle: {
      createdAt: "2026-07-17T08:00:00.000Z",
      updatedAt: "2026-07-17T09:00:00.000Z",
      firstSeenAt: null,
      lastActivityAt: null,
    },
    installLifecycle: {
      installCount: "1",
      firstSeenAt: "2026-07-16T08:00:00.000Z",
      lastSeenAt: "2026-07-17T09:00:00.000Z",
      platform: "macos",
      appVersion: "1.0.14",
    },
    billingModel: "one_time",
    entitlementStatus: "active",
    firstPaidAt: "2026-07-16T10:00:00.000Z",
    lastPaidAt: "2026-07-16T10:00:00.000Z",
    firstUpgradedAt: "2026-07-16T10:00:00.000Z",
    lastUpgradedAt: "2026-07-16T10:00:00.000Z",
    commerceSyncedAt: "2026-07-17T09:30:00.000Z",
    money: [{
      currency: "usd",
      grossPaidMinor: "999",
      offStripePaidMinor: "0",
      refundedMinor: "0",
      disputedMinor: "0",
      netPaidMinor: "999",
      paidTransactionCount: "1",
      firstPaidAt: "2026-07-16T10:00:00.000Z",
      lastPaidAt: "2026-07-16T10:00:00.000Z",
      materializedAt: "2026-07-17T09:30:00.000Z",
    }],
    usage: {
      firstDownloadAttemptAt: "2026-07-16T11:00:00.000Z",
      firstDownloadSucceededAt: "2026-07-16T11:00:00.000Z",
      downloadOutcomeNumerator: "1",
      downloadOutcomeDenominator: "1",
      lastUseAt: "2026-07-17T08:30:00.000Z",
      activeDays7: "2",
      activeDays30: "2",
      downloadFrequency30d: "0.500000",
      syncedAt: "2026-07-17T10:00:00.000Z",
      sourceFreshnessAt: "2026-07-17T09:59:00.000Z",
    },
    dataQualityFlags: [],
  };
}

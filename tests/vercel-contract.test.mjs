import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadInjectedModule } from "./helpers/handler-loader.mjs";
import { invokeHandler } from "./helpers/http.mjs";
import { validateVercelContract } from "../scripts/validate-vercel-contract.mjs";
import { hasFatalProviderDiagnostic } from "../scripts/verify-vercel-build.mjs";

const CRON_SECRET = "integration-cron-secret";
const INTERNAL_CRON_PATHS = Object.freeze([
  "/api/internal/stripe-events/process",
  "/api/internal/download-leads/replay",
  "/api/internal/maintenance",
  "/api/internal/customer-usage/sync",
]);

const modules = await loadCronModules();

test("the static Vercel contract includes every protected cron and both release routes", async () => {
  const result = await validateVercelContract();
  assert.deepEqual(result, {
    crons: 4,
    adminRoutes: 2,
    internalRoutes: 6,
    releaseEndpoints: 2,
  });
});

test("customer list and detail are protected on-demand admin routes, never crons", async () => {
  const result = await validateVercelContract();
  assert.equal(result.adminRoutes, 2);
  assert.equal(result.crons, 4);
});

test("the human-only bundle verifier requires both customer functions", async () => {
  const source = await readFile(
    new URL("../scripts/verify-vercel-build.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /api\/internal\/customers\/index\.func/);
  assert.match(source, /api\/internal\/customers\/\[customerId\]\.func/);
  assert.match(source, /Run `npm run build:vercel`/);
  assert.match(source, /fatal TypeScript or compilation diagnostic/);
});

test("the Vercel build gate treats provider compiler diagnostics as fatal", () => {
  assert.equal(hasFatalProviderDiagnostic("Build completed successfully"), false);
  assert.equal(hasFatalProviderDiagnostic("api/example.ts(1,2): error TS2322: mismatch"), true);
  assert.equal(hasFatalProviderDiagnostic("TypeScript error: invalid handler"), true);
  assert.equal(hasFatalProviderDiagnostic("Failed to compile\nroute output"), true);
});

test("missing and incorrect CRON_SECRET authorization is rejected by every internal route", async () => {
  const previousSecret = process.env.CRON_SECRET;
  try {
    process.env.CRON_SECRET = CRON_SECRET;
    for (const route of createRoutes()) {
      for (const authorization of [undefined, "Bearer incorrect-cron-secret"]) {
        const result = await invokeHandler(route.handler, {
          method: "GET",
          url: route.path,
          headers: authorization ? { authorization } : {},
        });
        assert.equal(result.response.statusCode, 401, route.path);
      }
      assert.equal(route.work(), 0, route.path);
    }

    delete process.env.CRON_SECRET;
    for (const route of createRoutes()) {
      const result = await invokeHandler(route.handler, {
        method: "GET",
        url: route.path,
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      });
      assert.equal(result.response.statusCode, 503, route.path);
      assert.equal(route.work(), 0, route.path);
    }
  } finally {
    restoreEnvironment("CRON_SECRET", previousSecret);
  }
});

test("GET-only Vercel cron routes stay bounded while lead replay retains protected manual POST", async () => {
  const previousSecret = process.env.CRON_SECRET;
  try {
    process.env.CRON_SECRET = CRON_SECRET;
    const routes = createRoutes({ includeReplayBlob: true });
    for (const route of routes) {
      const result = await invokeHandler(route.handler, {
        method: "GET",
        url: route.path,
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      });
      assert.equal(result.response.statusCode, 200, route.path);
      assert.equal(route.work(), 1, route.path);
    }

    for (const route of routes.filter((candidate) => candidate.path !== INTERNAL_CRON_PATHS[1])) {
      const result = await invokeHandler(route.handler, {
        method: "POST",
        url: route.path,
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      });
      assert.equal(result.response.statusCode, 405, route.path);
      assert.equal(result.response.getHeader("allow"), "GET", route.path);
    }

    const replay = routes.find((route) => route.path === INTERNAL_CRON_PATHS[1]);
    const invalidMethod = await invokeHandler(replay.handler, {
      method: "PUT",
      url: replay.path,
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    assert.equal(invalidMethod.response.statusCode, 405);
    assert.equal(invalidMethod.response.getHeader("allow"), "GET, POST");
    assert.deepEqual(replay.pageInput(), {
      prefix: "sidestream/download-leads/",
      cursor: undefined,
      limit: 25,
    });
    assert.equal(replay.deleted(), 1);
  } finally {
    restoreEnvironment("CRON_SECRET", previousSecret);
  }
});

function createRoutes(options = {}) {
  let stripeRuns = 0;
  let maintenanceRuns = 0;
  let replayRuns = 0;
  let replayDeletes = 0;
  let replayPageInput = null;
  let usageRuns = 0;
  const blob = {
    pathname: "sidestream/download-leads/lead_v1_test.json",
    etag: "test-etag",
    size: 2,
    uploadedAt: new Date("2026-07-14T00:00:00.000Z"),
  };

  return [
    {
      path: INTERNAL_CRON_PATHS[0],
      handler: modules.stripe.createStripeEventProcessHandler({
        drainQueue: async () => {
          stripeRuns += 1;
          return { claimed: 0, processed: 0, ignored: 0, retryable: 0, deadLetter: 0 };
        },
      }),
      work: () => stripeRuns,
    },
    {
      path: INTERNAL_CRON_PATHS[1],
      handler: modules.replay.createDownloadLeadReplayHandler({
        listPage: async (input) => {
          replayRuns += 1;
          replayPageInput = input;
          return {
            blobs: options.includeReplayBlob ? [blob] : [],
            hasMore: false,
          };
        },
        readBlob: async () => "{}",
        transaction: async (callback) => callback({}),
        upsertLead: async () => ({ outcome: "inserted" }),
        deleteBlob: async () => {
          replayDeletes += 1;
        },
        log: () => {},
      }),
      work: () => replayRuns,
      deleted: () => replayDeletes,
      pageInput: () => replayPageInput,
    },
    {
      path: INTERNAL_CRON_PATHS[2],
      handler: modules.maintenance.createMaintenanceHandler({
        getConfiguration: () => ({}),
        runJob: async () => {
          maintenanceRuns += 1;
          return {
            outcome: "completed",
            durationMs: 1,
            batchSize: 25,
            hasMore: false,
            counts: {},
          };
        },
        log: () => {},
        clock: () => 0,
      }),
      work: () => maintenanceRuns,
    },
    {
      path: INTERNAL_CRON_PATHS[3],
      handler: modules.usage.createCustomerUsageSyncHandler({
        runSync: async () => {
          usageRuns += 1;
          return {
            outcome: "completed",
            licenseNamespace: "test",
            batches: 1,
            sourceRowsScanned: 2,
            dailyBucketsWritten: 1,
            profilesRefreshed: 1,
            sourceFreshnessAt: "2026-07-15T00:00:00.000Z",
          };
        },
        log: () => {},
      }),
      work: () => usageRuns,
    },
  ];
}

async function loadCronModules() {
  class DownloadLeadConfigurationError extends Error {}
  class DownloadLeadValidationError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  const [stripe, replay, maintenance, usage] = await Promise.all([
    loadInjectedModule(new URL("../api/internal/stripe-events/process.ts", import.meta.url), {
      "../../_lib/stripe-events.js": {
        drainStripeEventQueue: async () => {
          throw new Error("The test must inject a queue drain");
        },
      },
    }),
    loadInjectedModule(new URL("../api/internal/download-leads/replay.ts", import.meta.url), {
      "@vercel/blob": {
        del: async () => {},
        get: async () => null,
        list: async () => ({ blobs: [], hasMore: false }),
      },
      "../../_lib/download-leads.js": {
        classifyLeadBlobPathname: () => "canonical-v2",
        createReplayReceiptHash: () => "a".repeat(64),
        DownloadLeadConfigurationError,
        DownloadLeadValidationError,
        getDownloadLeadBlobPrefix: () => "sidestream/download-leads",
        getDownloadLeadHashSecret: () => "lead-test-secret-that-is-long-enough",
        getDeterministicLeadBlobPathname: () =>
          "sidestream/download-leads/lead_v1_test.json",
        MAX_REPLAY_BLOB_BYTES: 16 * 1024,
        parseReplayBlob: () => ({ leadKey: "lead_v1_test" }),
        upsertCanonicalDownloadLead: async () => ({ outcome: "inserted" }),
      },
      "../../_lib/postgres.js": {
        withPostgresTransaction: async (callback) => callback({}),
      },
    }),
    loadInjectedModule(new URL("../api/internal/maintenance.ts", import.meta.url), {
      "../_lib/maintenance.js": {
        loadMaintenanceConfiguration: () => ({}),
        runMaintenanceJob: async () => {
          throw new Error("The test must inject a maintenance job");
        },
      },
    }),
    loadInjectedModule(new URL("../api/internal/customer-usage/sync.ts", import.meta.url), {
      "../../_lib/customer-usage.js": {
        runCustomerUsageSync: async () => {
          throw new Error("The test must inject a customer usage sync");
        },
      },
    }),
  ]);
  return { stripe, replay, maintenance, usage };
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

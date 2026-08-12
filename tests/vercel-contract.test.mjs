import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadInjectedModule } from "./helpers/handler-loader.mjs";
import { invokeHandler } from "./helpers/http.mjs";
import { validateVercelContract } from "../scripts/validate-vercel-contract.mjs";
import {
  assertProductionAncestry,
  assertCheckoutSourceContract,
  PRODUCTION_SOURCE,
  readLiveProductionVersion,
  verifyCheckoutContract,
} from "../scripts/verify-production-source.mjs";
import {
  resolveBuildGitSha,
  resolveBuildGitShaFromSources,
} from "../scripts/generate-production-version.mjs";
import {
  verifyLiveProduction,
  verifyLiveProductionWithRetry,
} from "../scripts/verify-production-live.mjs";
import {
  assertPromotionCandidate,
  promoteCanonicalProduction,
} from "../scripts/promote-canonical-production.mjs";

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
    adminRoutes: 6,
    internalRoutes: 10,
    releaseEndpoints: 2,
  });
});

test("every Customer 360 and experiment read is a protected on-demand admin route", async () => {
  const result = await validateVercelContract();
  assert.equal(result.adminRoutes, 6);
  assert.equal(result.crons, 4);
});

test("the human-only bundle verifier requires both customer functions", async () => {
  const source = await readFile(
    new URL("../scripts/verify-vercel-build.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /api\/internal\/customers\/index\.func/);
  assert.match(source, /api\/internal\/customers\/\[customerId\]\.func/);
  assert.match(source, /A human must run `npx vercel build` first/);
});

test("the source checkout contract is direct and retains both zero-total Stripe statuses", async () => {
  const result = await verifyCheckoutContract();
  assert.deepEqual(result, {
    checkoutRoute: "direct",
    zeroTotalStatuses: 2,
    rootHtmlPages: 4,
  });
});

test("the checkout contract rejects browser UI and unexpected deployable root pages", () => {
  const valid = {
    checkoutStart:
      "/api/auth/google/start createCheckoutIntent createOrReuseCheckoutSession",
    account: "isZeroTotalCheckoutWithoutPaymentIntent",
    entitlement: [
      'session.payment_status === "paid"',
      'session.payment_status === "no_payment_required"',
      "session.amount_total === 0",
      "session.payment_intent",
    ].join("\n"),
    readme: [
      "1. The user clicks Upgrade.",
      "2. Google authentication establishes the Sidestream account session.",
      "3. The browser opens Stripe Checkout for payment.",
    ].join("\n"),
    unexpectedRootPages: [],
  };

  assert.doesNotThrow(() => assertCheckoutSourceContract(valid));
  assert.throws(
    () =>
      assertCheckoutSourceContract({
        ...valid,
        checkoutStart: `${valid.checkoutStart} text/html`,
      }),
    /browser UI marker/u,
  );
  assert.throws(
    () =>
      assertCheckoutSourceContract({
        ...valid,
        unexpectedRootPages: ["unexpected.html"],
      }),
    /Unexpected deployable root HTML/u,
  );
});

test("the Production source is remote main with immutable checkout baselines and project identity", () => {
  assert.equal(PRODUCTION_SOURCE.branch, "main");
  assert.equal(PRODUCTION_SOURCE.versionUrl, "https://sidestream.tv/version.json");
  assert.deepEqual(PRODUCTION_SOURCE.requiredAncestors, [
    "81a3190f6fbabb684cde605a4e256d2fa6295fe5",
    "d3d1e82ebd640bf8d6e30df7d54628e4206300a0",
  ]);
  assert.equal(
    PRODUCTION_SOURCE.projectId,
    "prj_x9sRcnoAAfF6VPxseJYLBgxhhPyh",
  );
  assert.equal(PRODUCTION_SOURCE.orgId, "team_ZcKImJwvlcCrE15nTEOWT2NC");
  assert.equal(PRODUCTION_SOURCE.projectName, "sidestream");
});

test("the Production ancestry gate rejects divergent candidates", () => {
  const productionSha = "a".repeat(40);
  const candidateSha = "b".repeat(40);
  assert.doesNotThrow(() =>
    assertProductionAncestry({ productionSha, candidateSha, isAncestor: true }),
  );
  assert.throws(
    () =>
      assertProductionAncestry({
        productionSha,
        candidateSha,
        isAncestor: false,
      }),
    /does not descend from live Production/u,
  );
});

test("the live version reader requires an exact Git SHA", async () => {
  const gitSha = "c".repeat(40);
  assert.deepEqual(
    await readLiveProductionVersion(async () =>
      new Response(JSON.stringify({ gitSha }), { status: 200 })
    ),
    { gitSha },
  );
  assert.equal(
    await readLiveProductionVersion(async () => new Response("", { status: 404 })),
    null,
  );
  await assert.rejects(
    readLiveProductionVersion(async () =>
      new Response(JSON.stringify({ gitSha: "short" }), { status: 200 })
    ),
    /valid gitSha/u,
  );
});

test("the build version resolver rejects missing or abbreviated SHAs", () => {
  assert.equal(
    resolveBuildGitSha({
      explicitSha: "d".repeat(40),
      vercelSha: "",
      gitSha: "e".repeat(40),
    }),
    "d".repeat(40),
  );
  assert.throws(
    () => resolveBuildGitSha({ explicitSha: "", vercelSha: "", gitSha: "abc1234" }),
    /40-character Git SHA/u,
  );
});

test("Vercel commit metadata avoids the Git fallback when .git is unavailable", () => {
  const vercelSha = "5".repeat(40);
  let gitReads = 0;
  assert.equal(
    resolveBuildGitShaFromSources({
      explicitSha: "",
      vercelSha,
      readGitSha: () => {
        gitReads += 1;
        throw new Error("git is unavailable");
      },
    }),
    vercelSha,
  );
  assert.equal(gitReads, 0);
});

test("post-deploy verification requires the expected SHA and direct Checkout redirect", async () => {
  const gitSha = "f".repeat(40);
  const responses = [
    new Response(JSON.stringify({ gitSha }), { status: 200 }),
    new Response("", {
      status: 302,
      headers: { location: "/api/auth/google/start?return_to=%2Fapi%2Fcheckout%2Fstart" },
    }),
  ];
  const result = await verifyLiveProduction({
    expectedSha: gitSha,
    fetchImpl: async () => responses.shift(),
  });
  assert.equal(result.gitSha, gitSha);
  assert.equal(result.checkoutStatus, 302);
});

test("post-deploy verification retries bounded alias propagation", async () => {
  const gitSha = "3".repeat(40);
  let versionReads = 0;
  let waits = 0;
  const result = await verifyLiveProductionWithRetry({
    expectedSha: gitSha,
    attempts: 3,
    delayMs: 1,
    wait: async () => {
      waits += 1;
    },
    fetchImpl: async (url) => {
      if (url.endsWith("/version.json")) {
        versionReads += 1;
        return new Response(
          JSON.stringify({
            gitSha: versionReads === 1 ? "4".repeat(40) : gitSha,
          }),
          { status: 200 },
        );
      }
      return new Response("", {
        status: 302,
        headers: { location: "/api/auth/google/start?next=%2Fapi%2Fcheckout%2Fstart" },
      });
    },
  });
  assert.equal(result.gitSha, gitSha);
  assert.equal(versionReads, 2);
  assert.equal(waits, 1);
});

test("canonical promotion requires a Ready Production deployment with the expected SHA", async () => {
  const gitSha = "1".repeat(40);
  const deployment = {
    id: "dpl_test",
    target: "production",
    readyState: "READY",
    url: "sidestream-test123-alex-3685s-projects.vercel.app",
  };
  assert.doesNotThrow(() =>
    assertPromotionCandidate({ deployment, expectedSha: gitSha, reportedSha: gitSha }),
  );
  assert.throws(
    () =>
      assertPromotionCandidate({
        deployment,
        expectedSha: gitSha,
        reportedSha: "2".repeat(40),
      }),
    /expected/u,
  );

  const calls = [];
  const result = await promoteCanonicalProduction({
    expectedSha: gitSha,
    runVercel: async (args) => {
      calls.push(args);
      if (args[0] === "inspect") return JSON.stringify(deployment);
      if (args[0] === "curl") return JSON.stringify({ gitSha });
      return "";
    },
  });
  assert.equal(result.deploymentId, "dpl_test");
  assert.deepEqual(calls[2].slice(0, 4), [
    "alias",
    "set",
    deployment.url,
    "sidestream.tv",
  ]);
});

test("the built checkout verifier checks authentication, Stripe creation, fulfillment, and root pages", async () => {
  const source = await readFile(
    new URL("../scripts/verify-vercel-build.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /api\/checkout\/start\.func/u);
  assert.match(source, /api\/checkout\/complete\.func/u);
  assert.match(source, /\/api\/auth\/google\/start/u);
  assert.match(source, /createOrReuseCheckoutSession/u);
  assert.match(source, /no_payment_required/u);
  assert.match(source, /Unexpected root HTML|unexpected root HTML/u);
  assert.match(source, /version\.json/u);
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

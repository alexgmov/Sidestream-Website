import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import {
  CONFIGURATION_SELECTORS,
  CUSTOMER_360_READ_FUNCTIONS,
  CUSTOMER_360_SOURCE_FILES,
  CUSTOMER_360_TABLES,
  classifyProtectedProbe,
  executeReadinessCli,
  formatReadinessReport,
  inspectConfiguration,
  inspectCustomer360Database,
  parseReadinessArguments,
  probeCustomer360Api,
  runReadinessCheck,
  validateHttpsOrigin,
} from "../../scripts/check-customer-360-readiness.mjs";

const TEST_DATABASE =
  "postgres://disposable:database-secret@test-db.invalid:5433/customer_360";
const RUNTIME_DATABASE =
  "postgres://runtime:production-secret@runtime-db.invalid:5432/sidestream";
const TELEMETRY_DATABASE =
  "postgres://reader:telemetry-secret@telemetry-db.invalid:5432/telemetry";

test("arguments accept only a strict HTTPS origin and explicit read-only modes", () => {
  assert.deepEqual(parseReadinessArguments([
    "--origin",
    "https://preview.sidestream.example",
    "--test-database",
    "--require-ready",
  ]), {
    origin: "https://preview.sidestream.example",
    testDatabase: true,
    requireReady: true,
  });
  assert.equal(
    validateHttpsOrigin("https://preview.sidestream.example/"),
    "https://preview.sidestream.example",
  );
  for (const value of [
    "http://preview.sidestream.example",
    "https://preview.sidestream.example/path",
    "https://user:password@preview.sidestream.example",
    "https://preview.sidestream.example?secret=value",
  ]) {
    assert.throws(() => validateHttpsOrigin(value), /strict HTTPS origin/);
  }
  assert.throws(() => parseReadinessArguments(["--unknown"]), /Unknown/);
});

test("configuration reports selector presence and validity without values", () => {
  const environment = readyEnvironment();
  const report = inspectConfiguration(environment);
  assert.equal(report.ready, true);
  assert.deepEqual(Object.keys(report.selectors), [...CONFIGURATION_SELECTORS]);
  for (const selector of Object.values(report.selectors)) {
    assert.deepEqual(selector, { present: true, valid: true });
  }
  const output = formatReadinessReport({ configuration: report });
  for (const sensitiveValue of Object.values(environment)) {
    assert.doesNotMatch(output, new RegExp(escapeRegExp(sensitiveValue)));
  }

  assert.equal(inspectConfiguration({
    ...environment,
    SIDESTREAM_LICENSE_NAMESPACE: "production",
  }).ready, false);
  assert.equal(inspectConfiguration({
    ...environment,
    VERCEL_ENV: "production",
  }).ready, false);
  assert.equal(inspectConfiguration({
    ...environment,
    SIDESTREAM_CRM_ADMIN_SECRET: ` ${environment.SIDESTREAM_CRM_ADMIN_SECRET}`,
  }).ready, false);
  assert.equal(inspectConfiguration({
    ...environment,
    SIDESTREAM_POSTGRES_URL: TEST_DATABASE,
  }).ready, false);
  assert.equal(inspectConfiguration({
    ...environment,
    SIDESTREAM_POSTGRES_URL: TELEMETRY_DATABASE,
  }).selectors.SIDESTREAM_TELEMETRY_POSTGRES_URL.valid, false);
});

test("API probes are unauthenticated, use exact methods, and never follow redirects", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const usage = url.pathname.endsWith("/customer-usage/sync");
    return jsonResponse(401, { code: "unauthorized", usage });
  };
  const report = await probeCustomer360Api(
    "https://preview.sidestream.example",
    { fetchImpl },
  );
  assert.equal(report.ready, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.body, "{}");
  assert.equal(requests[1].options.method, "GET");
  for (const request of requests) {
    assert.equal(request.options.redirect, "manual");
    const headerNames = Object.keys(request.options.headers)
      .map((name) => name.toLowerCase());
    assert.equal(headerNames.includes("authorization"), false);
  }
});

test("401 and documented 503 responses are classified exactly", () => {
  assert.deepEqual(
    classifyProtectedProbe(401, "unauthorized", "customer_admin_unavailable"),
    {
      ready: true,
      configured: true,
      protected: true,
      statusCode: 401,
    },
  );
  assert.deepEqual(
    classifyProtectedProbe(
      503,
      "customer_admin_unavailable",
      "customer_admin_unavailable",
    ),
    {
      ready: false,
      configured: false,
      protected: true,
      statusCode: 503,
    },
  );
  for (const [status, code] of [
    [401, "customer_admin_unavailable"],
    [503, "unauthorized"],
    [503, "customer_usage_sync_unavailable"],
    [302, "unauthorized"],
    [200, "unauthorized"],
  ]) {
    assert.equal(
      classifyProtectedProbe(status, code, "customer_admin_unavailable").ready,
      false,
    );
  }
});

test("test database inspection reuses the deployed-database separation guard", async () => {
  let poolCreated = false;
  const report = await inspectCustomer360Database({
    environment: {
      SIDESTREAM_TEST_POSTGRES_URL: TEST_DATABASE,
      SIDESTREAM_POSTGRES_URL:
        "postgres://runtime:different-secret@test-db.invalid:5433/production",
    },
    createPool: async () => {
      poolCreated = true;
      throw new Error("must not connect");
    },
  });
  assert.equal(report.ready, false);
  assert.equal(report.connected, false);
  assert.equal(poolCreated, false);

  const productionMatch = await inspectCustomer360Database({
    environment: {
      SIDESTREAM_TEST_POSTGRES_URL: RUNTIME_DATABASE,
      SIDESTREAM_POSTGRES_URL: RUNTIME_DATABASE,
    },
    createPool: async () => {
      poolCreated = true;
      throw new Error("must not connect");
    },
  });
  assert.equal(productionMatch.ready, false);
  assert.equal(productionMatch.connected, false);
});

test("database inspection verifies schema and ledger in a rolled-back read-only transaction", async () => {
  const manifest = [
    { filename: "20260715120000_add_customer_360_core.sql", checksum: "a".repeat(64) },
    { filename: "20260715124000_add_customer_360_read_model.sql", checksum: "b".repeat(64) },
  ];
  const { createPool, queries, state } = fakeDatabase({
    manifest,
    counts: {
      live_profiles: 4,
      merged_profiles: 1,
      identity_links: 7,
      installs: 5,
      pending_identity_reviews: 0,
    },
  });
  const report = await inspectCustomer360Database({
    environment: {
      SIDESTREAM_TEST_POSTGRES_URL: TEST_DATABASE,
      SIDESTREAM_POSTGRES_URL: RUNTIME_DATABASE,
    },
    createPool,
    migrationManifest: manifest,
  });
  assert.equal(report.ready, true);
  assert.equal(report.transactionReadOnly, true);
  assert.equal(report.schema.presentTableCount, CUSTOMER_360_TABLES.length);
  assert.equal(
    report.schema.presentReadFunctionCount,
    CUSTOMER_360_READ_FUNCTIONS.length,
  );
  assert.deepEqual(report.backfill.counts, {
    liveProfiles: 4,
    mergedProfiles: 1,
    identityLinks: 7,
    installs: 5,
    pendingIdentityReviews: 0,
  });
  assert.match(queries[0].text, /^begin read only$/i);
  assert.match(queries.at(-1).text, /^rollback$/i);
  assert.equal(
    queries.some((query) => /\b(commit|insert|update|delete|alter|create|drop)\b/i
      .test(query.text)),
    false,
  );
  assert.equal(state.released, true);
  assert.equal(state.ended, true);
});

test("database inspection rolls back and redacts failures", async () => {
  const queries = [];
  let released = false;
  let ended = false;
  const report = await inspectCustomer360Database({
    environment: {
      SIDESTREAM_TEST_POSTGRES_URL: TEST_DATABASE,
      SIDESTREAM_POSTGRES_URL: RUNTIME_DATABASE,
    },
    migrationManifest: [],
    createPool: async () => ({
      connect: async () => ({
        query: async (text) => {
          queries.push(text);
          if (/^begin/i.test(text)) return { rows: [] };
          if (/^rollback/i.test(text)) return { rows: [] };
          throw new Error(`${TEST_DATABASE} ${RUNTIME_DATABASE}`);
        },
        release: () => {
          released = true;
        },
      }),
      end: async () => {
        ended = true;
      },
    }),
  });
  assert.equal(report.ready, false);
  assert.deepEqual(queries, ["begin read only", "show transaction_read_only", "rollback"]);
  assert.equal(released, true);
  assert.equal(ended, true);
  const output = formatReadinessReport(report);
  assert.doesNotMatch(output, /database-secret|production-secret|postgres:/);
});

test("default reporting is zero while --require-ready is deterministic", async () => {
  const dependencies = deterministicDependencies();
  let output = "";
  assert.equal(await executeReadinessCli([], {
    ...dependencies,
    writeOutput: (value) => {
      output += value;
    },
  }), 0);
  assert.equal(JSON.parse(output).ready, true);

  assert.equal(await executeReadinessCli(["--require-ready"], {
    ...dependencies,
    environment: {},
    writeOutput: () => {},
  }), 1);
  assert.equal(await executeReadinessCli([], {
    ...dependencies,
    environment: {},
    writeOutput: () => {},
  }), 0);

  const blockedApi = await runReadinessCheck({
    origin: "https://preview.sidestream.example",
    testDatabase: false,
    requireReady: false,
  }, {
    ...dependencies,
    fetchImpl: async () => jsonResponse(503, {
      code: "customer_admin_unavailable",
    }),
  });
  assert.equal(blockedApi.ready, false);
});

test("the real CLI never prints configured secrets or connection URLs", () => {
  const environment = {
    ...process.env,
    ...readyEnvironment(),
  };
  const result = spawnSync(process.execPath, [
    path.resolve("scripts/check-customer-360-readiness.mjs"),
  ], {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  for (const value of [
    environment.SIDESTREAM_CRM_ADMIN_SECRET,
    environment.CRON_SECRET,
    environment.SIDESTREAM_TEST_POSTGRES_URL,
    environment.SIDESTREAM_TELEMETRY_POSTGRES_URL,
  ]) {
    assert.equal(result.stdout.includes(value), false);
    assert.equal(result.stderr.includes(value), false);
  }
});

function readyEnvironment() {
  return {
    SIDESTREAM_CRM_ADMIN_SECRET: "crm-admin-secret-for-readiness",
    CRON_SECRET: "cron-secret-for-readiness",
    SIDESTREAM_TELEMETRY_POSTGRES_URL: TELEMETRY_DATABASE,
    SIDESTREAM_TEST_POSTGRES_URL: TEST_DATABASE,
    SIDESTREAM_LICENSE_NAMESPACE: "test",
    SIDESTREAM_TEST_API_HOSTS: "preview.sidestream.example",
    VERCEL_ENV: "preview",
  };
}

function deterministicDependencies() {
  return {
    environment: readyEnvironment(),
    repositoryRoot: process.cwd(),
    fileAccess: async (filename) => {
      const relative = path.relative(process.cwd(), filename).split(path.sep).join("/");
      if (!CUSTOMER_360_SOURCE_FILES.includes(relative)) {
        throw new Error("unexpected source file");
      }
    },
  };
}

function jsonResponse(status, body) {
  return {
    status,
    json: async () => body,
  };
}

function fakeDatabase({ manifest, counts }) {
  const queries = [];
  const state = { released: false, ended: false };
  const createPool = async () => ({
    connect: async () => ({
      query: async (text, values = []) => {
        queries.push({ text, values });
        if (/^begin read only$/i.test(text)) return { rows: [] };
        if (/^show transaction_read_only$/i.test(text)) {
          return { rows: [{ transaction_read_only: "on" }] };
        }
        if (/from pg_class/.test(text)) {
          return {
            rows: [
              ...CUSTOMER_360_TABLES.map((name) => ({ name })),
              { name: "sidestream_schema_migrations" },
            ],
          };
        }
        if (/from pg_proc/.test(text)) {
          return { rows: CUSTOMER_360_READ_FUNCTIONS.map((name) => ({ name })) };
        }
        if (/from public\.sidestream_schema_migrations/.test(text)) {
          return {
            rows: manifest.map((migration) => ({
              filename: migration.filename,
              checksum_sha256: migration.checksum,
            })),
          };
        }
        if (/live_profiles/.test(text)) return { rows: [counts] };
        if (/^rollback$/i.test(text)) return { rows: [] };
        throw new Error("unexpected query");
      },
      release: () => {
        state.released = true;
      },
    }),
    end: async () => {
      state.ended = true;
    },
  });
  return { createPool, queries, state };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

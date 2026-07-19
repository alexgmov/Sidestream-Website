import assert from "node:assert/strict";
import test from "node:test";
import { loadInjectedModule } from "../helpers/handler-loader.mjs";

const fixturePools = [];

class FixturePool {
  constructor(options) {
    this.options = options;
    this.listeners = new Map();
    fixturePools.push(this);
  }

  on(event, listener) {
    this.listeners.set(event, listener);
    return this;
  }
}

const {
  buildTelemetryPoolOptions,
  getCustomerUsageTelemetryPool,
} = await loadInjectedModule(
  new URL("../../api/_lib/customer-usage.ts", import.meta.url),
  {
    pg: { Pool: FixturePool },
    "./postgres.js": {
      getPostgresPool: () => {
        throw new Error("Telemetry TLS fixtures must not open the runtime database");
      },
      RUNTIME_POSTGRES_URL_ENV_NAMES: [],
    },
  },
);

test("remote telemetry uses authenticated TLS defaults for common sslmode aliases", () => {
  const fixtures = [
    "postgres://reader:secret@telemetry.example.invalid/telemetry",
    "postgres://reader:secret@telemetry.example.invalid/telemetry?sslmode=prefer",
    "postgres://reader:secret@telemetry.example.invalid/telemetry?sslmode=require",
    "postgres://reader:secret@telemetry.example.invalid/telemetry?sslmode=verify-ca",
    "postgres://reader:secret@telemetry.example.invalid/telemetry?sslmode=verify-full",
    "postgres://reader:secret@telemetry.example.invalid/telemetry?ssl=true",
    "postgres://reader:secret@telemetry.example.invalid/telemetry?ssl=1",
  ];

  for (const fixture of fixtures) {
    const options = buildTelemetryPoolOptions(fixture);
    const normalized = new URL(options.connectionString);
    assert.deepEqual(options.ssl, { rejectUnauthorized: true }, fixture);
    assert.equal(normalized.searchParams.has("sslmode"), false, fixture);
    assert.equal(normalized.searchParams.has("ssl"), false, fixture);
    assert.equal(options.max, 1);
    assert.equal(options.connectionTimeoutMillis, 5_000);
    assert.equal(options.idleTimeoutMillis, 10_000);
    assert.equal(options.query_timeout, 15_000);
    assert.equal(options.statement_timeout, 15_000);
    assert.equal(options.options, "-c default_transaction_read_only=on");
  }
});

test("remote telemetry rejects TLS downgrades and pool-security overrides", () => {
  const unsafeQueries = [
    "sslmode=disable",
    "sslmode=false",
    "sslmode=no-verify",
    "sslmode=allow",
    "ssl=false",
    "ssl=0",
    "ssl=no-verify",
    "uselibpqcompat=true&sslmode=prefer",
    "uselibpqcompat=1&sslmode=require",
    "uselibpqcompat=true&sslmode=verify-ca",
    "sslrootcert=%2Ftmp%2Fprivate-ca.pem",
    "sslcert=%2Ftmp%2Fclient-cert.pem",
    "sslkey=%2Ftmp%2Fclient-key.pem",
    "rejectUnauthorized=false",
    "checkServerIdentity=false",
    "host=localhost&sslmode=disable",
    "options=-c%20default_transaction_read_only%3Doff",
    "connectionTimeoutMillis=0",
    "query_timeout=0",
    "statement_timeout=0",
  ];

  for (const query of unsafeQueries) {
    const fixture = `postgres://reader:do-not-print@telemetry.example.invalid/telemetry?${query}`;
    assert.throws(
      () => buildTelemetryPoolOptions(fixture),
      (error) => {
        assert.doesNotMatch(error.message, /do-not-print|private-ca|client-cert|client-key/i);
        return /authenticated TLS|unsafe TLS configuration|unsupported connection parameter/.test(error.message);
      },
      query,
    );
  }
});

test("only loopback targets may explicitly disable TLS", () => {
  const nonTlsFixtures = [
    "postgres://reader:secret@localhost/telemetry",
    "postgres://reader:secret@localhost/telemetry?sslmode=disable",
    "postgres://reader:secret@127.0.0.1:5432/telemetry?sslmode=false",
    "postgres://reader:secret@[::1]:5432/telemetry?ssl=0",
  ];
  for (const fixture of nonTlsFixtures) {
    assert.equal(buildTelemetryPoolOptions(fixture).ssl, false, fixture);
  }

  assert.deepEqual(
    buildTelemetryPoolOptions(
      "postgres://reader:secret@localhost/telemetry?sslmode=require",
    ).ssl,
    { rejectUnauthorized: true },
  );
  assert.throws(
    () => buildTelemetryPoolOptions(
      "postgres://reader:secret@localhost/telemetry?sslmode=no-verify",
    ),
    /unsafe TLS configuration|unsupported connection parameter/,
  );
});

test("malformed telemetry URLs fail without reflecting connection secrets", () => {
  const fixtures = [
    "not-a-postgres-url-with-secret-marker",
    "https://reader:secret-marker@example.invalid/telemetry",
    "postgres://reader:secret-marker@example.invalid",
    "postgres:///telemetry?password=secret-marker",
  ];

  for (const fixture of fixtures) {
    assert.throws(
      () => buildTelemetryPoolOptions(fixture),
      (error) => {
        assert.match(error.message, /valid Postgres URL|identify one Postgres host and database|must use postgres/);
        assert.doesNotMatch(error.message, /secret-marker|reader@example/i);
        return true;
      },
      fixture,
    );
  }
});

test("the telemetry pool is fixture-only and logs only bounded error codes", () => {
  const fixture =
    "postgres://reader:pool-password@telemetry.example.invalid/telemetry?sslmode=require";
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const pool = getCustomerUsageTelemetryPool(fixture);
    assert.equal(pool, fixturePools.at(-1));
    assert.deepEqual(pool.options.ssl, { rejectUnauthorized: true });
    assert.equal(typeof pool.listeners.get("error"), "function");
    pool.listeners.get("error")({
      code: "pool-password",
      certificate: "certificate-body-must-not-print",
    });
    pool.listeners.get("error")({ code: "ECONNRESET" });
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(logged, [
    ["Sidestream telemetry read pool error", "database_error"],
    ["Sidestream telemetry read pool error", "ECONNRESET"],
  ]);
  assert.doesNotMatch(JSON.stringify(logged), /pool-password|private-ca|certificate-body/i);
});

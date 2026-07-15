import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  buildPostgresPoolOptions,
  normalizePostgresConnectionString,
  resolveRuntimePostgresTarget,
} from "../api/_lib/postgres.ts";

const rateLimitModule = await loadRateLimitModule();
const {
  consumeRateLimit,
  prepareRateLimitRequest,
  sendRateLimitExceeded,
} = rateLimitModule;

const pooledUrl = "postgres://runtime:secret@pool.example.invalid:6543/sidestream?sslmode=require";
const directUrl = "postgres://migration:secret@db.example.invalid:5432/sidestream";

async function loadRateLimitModule() {
  const sourceUrl = new URL("../api/_lib/rate-limit.ts", import.meta.url);
  const postgresUrl = new URL("../api/_lib/postgres.ts", import.meta.url).href;
  const source = (await readFile(sourceUrl, "utf8"))
    .replace(JSON.stringify("./postgres.js"), JSON.stringify(postgresUrl));
  const directory = await mkdtemp(join(tmpdir(), "sidestream-rate-limit-test-"));
  const modulePath = join(directory, "rate-limit-under-test.ts");
  await writeFile(modulePath, source, { mode: 0o600 });
  try {
    return await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("runtime resolution prefers pooled URLs and production refuses direct-only fallback", () => {
  const target = resolveRuntimePostgresTarget({
    SIDESTREAM_POSTGRES_URL: pooledUrl,
    SIDESTREAM_POSTGRES_URL_NON_POOLING: directUrl,
    VERCEL_ENV: "production",
  });
  assert.equal(target.environmentVariable, "SIDESTREAM_POSTGRES_URL");
  assert.equal(target.pooled, true);
  assert.doesNotMatch(target.connectionString, /sslmode=/i);

  assert.throws(() => resolveRuntimePostgresTarget({
    SIDESTREAM_POSTGRES_URL_NON_POOLING: directUrl,
    VERCEL_ENV: "production",
  }), /pooled Postgres URL.*forbidden/i);
  assert.equal(resolveRuntimePostgresTarget({
    POSTGRES_URL_NON_POOLING: directUrl,
    VERCEL_ENV: "development",
  })?.pooled, false);
});

test("pool defaults remove the max=1 bottleneck and reject unsafe size/timeout values", () => {
  const target = resolveRuntimePostgresTarget({ POSTGRES_URL: pooledUrl });
  const defaults = buildPostgresPoolOptions(target, {});
  assert.equal(defaults.max, 4);
  assert.ok(defaults.max > 1);
  assert.equal(defaults.connectionTimeoutMillis, 5_000);
  assert.equal(defaults.query_timeout, 10_000);
  assert.equal(defaults.statement_timeout, 10_000);

  assert.equal(buildPostgresPoolOptions(target, {
    POSTGRES_POOL_MAX: "12",
    POSTGRES_CONNECTION_TIMEOUT_MS: "750",
    POSTGRES_QUERY_TIMEOUT_MS: "1250",
    POSTGRES_STATEMENT_TIMEOUT_MS: "1500",
  }).max, 12);
  assert.throws(
    () => buildPostgresPoolOptions(target, { POSTGRES_POOL_MAX: "1" }),
    /POSTGRES_POOL_MAX must be between 2 and 20/,
  );
  assert.throws(
    () => buildPostgresPoolOptions(target, { POSTGRES_QUERY_TIMEOUT_MS: "unbounded" }),
    /must be an integer/,
  );
});

test("connection parsing is strict and never needs to expose a credential", () => {
  assert.equal(
    normalizePostgresConnectionString("postgres://user:pass@localhost:5432/app?sslmode=disable"),
    "postgres://user:pass@localhost:5432/app?sslmode=disable",
  );
  assert.throws(() => normalizePostgresConnectionString("https://example.invalid/db"), /must use postgres/);
  assert.throws(() => normalizePostgresConnectionString("not-a-url"), /is invalid/);
});

test("account and lead capture share the serverless-aware runtime pool", async () => {
  const [postgresSource, accountSource, leadSource] = await Promise.all([
    readFile(new URL("../api/_lib/postgres.ts", import.meta.url), "utf8"),
    readFile(new URL("../api/_lib/account.ts", import.meta.url), "utf8"),
    readFile(new URL("../api/download-lead.ts", import.meta.url), "utf8"),
  ]);
  assert.match(postgresSource, /attachDatabasePool\(runtimePool\)/);
  assert.match(postgresSource, /let runtimePool: Pool \| null = null/);
  assert.match(accountSource, /from "\.\/postgres\.js"/);
  assert.match(leadSource, /from "\.\/_lib\/postgres\.js"/);
  assert.doesNotMatch(accountSource, /new Pool\s*\(/);
  assert.doesNotMatch(leadSource, /new Pool\s*\(/);
});

test("rate-limit dimensions become deterministic HMACs before any database call", () => {
  const options = {
    scope: "download-lead",
    dimensions: [
      { name: "email", value: "person@example.com", limit: 5 },
      { name: "ip", value: "203.0.113.4", limit: 20 },
    ],
    windowSeconds: 600,
    now: new Date("2026-07-14T20:05:00.000Z"),
    secret: "a".repeat(32),
  };
  const first = prepareRateLimitRequest(options);
  const second = prepareRateLimitRequest(options);
  assert.deepEqual(first, second);
  assert.equal(first.windowStartedAt, "2026-07-14T20:00:00.000Z");
  assert.equal(first.windowExpiresAt, "2026-07-14T20:10:00.000Z");
  assert.equal(first.entries.length, 2);
  assert.ok(first.entries.every((entry) => /^[0-9a-f]{64}$/.test(entry.dimensionHash)));
  assert.doesNotMatch(JSON.stringify(first), /person@example\.com|203\.0\.113\.4/);
});

test("atomic rate-limit consumption exposes deterministic 429 retry support", async () => {
  let capturedSql = "";
  let capturedParams = [];
  const runner = {
    async query(sql, params) {
      capturedSql = sql;
      capturedParams = params;
      const requested = JSON.parse(params[0]);
      return {
        rows: requested.map((entry) => ({
          dimension_hash: entry.dimension_hash,
          max_requests: entry.max_requests,
          request_count: entry.max_requests + 1,
        })),
      };
    },
  };
  const result = await consumeRateLimit({
    scope: "download-lead",
    dimensions: [{ name: "email", value: "person@example.com", limit: 5 }],
    windowSeconds: 600,
    now: new Date("2026-07-14T20:05:00.000Z"),
    secret: "b".repeat(32),
    runner,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.retryAfterSeconds, 300);
  assert.match(capturedSql, /on conflict[\s\S]+request_count = rate_limit\.request_count \+ 1/i);
  assert.doesNotMatch(JSON.stringify(capturedParams), /person@example\.com/);

  const headers = new Map();
  let payload = "";
  const response = {
    statusCode: 0,
    setHeader(name, value) { headers.set(name, String(value)); },
    end(value) { payload = String(value); },
  };
  sendRateLimitExceeded(response, result);
  assert.equal(response.statusCode, 429);
  assert.equal(headers.get("Retry-After"), "300");
  assert.equal(JSON.parse(payload).code, "rate_limited");
});

test("the operational migration stores only rate-limit HMAC keys and bounded windows", async () => {
  const migration = await readFile(new URL(
    "../db/migrations/20260713200000_add_api_operational_controls.sql",
    import.meta.url,
  ), "utf8");
  assert.match(migration, /create table if not exists public\.sidestream_api_rate_limits/);
  assert.match(migration, /dimension_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(migration, /window_seconds between 1 and 86400/);
  assert.match(migration, /sidestream_api_rate_limits_expiry_idx/);
  assert.doesNotMatch(migration, /\b(?:email|ip_address|raw_ip)\s+(?:text|inet)\b/i);
});

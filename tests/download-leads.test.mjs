import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const testSecret = "download-lead-tests-use-a-stable-secret-value";
let compiledDirectory;
let createDownloadLeadHandler;
let createDownloadLinkHandler;
let createDownloadLeadReplayHandler;
let helpers;
let emailHelpers;
const originalEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  SIDESTREAM_LEAD_HASH_SECRET: process.env.SIDESTREAM_LEAD_HASH_SECRET,
  SIDESTREAM_RATE_LIMIT_HASH_SECRET: process.env.SIDESTREAM_RATE_LIMIT_HASH_SECRET,
};

before(async () => {
  process.env.NODE_ENV = "test";
  process.env.SIDESTREAM_LEAD_HASH_SECRET = testSecret;
  process.env.SIDESTREAM_RATE_LIMIT_HASH_SECRET = testSecret;
  mkdirSync(path.join(repoRoot, "node_modules", ".tmp"), { recursive: true });
  compiledDirectory = mkdtempSync(
    path.join(repoRoot, "node_modules", ".tmp", "download-leads-test-"),
  );
  execFileSync(path.join(repoRoot, "node_modules", ".bin", "tsc"), [
    "-p",
    "tsconfig.node.json",
    "--noEmit",
    "false",
    "--outDir",
    compiledDirectory,
    "--tsBuildInfoFile",
    path.join(compiledDirectory, "tsconfig.tsbuildinfo"),
  ]);
  helpers = await import(
    pathToFileURL(path.join(compiledDirectory, "api", "_lib", "download-leads.js")).href
  );
  ({ createDownloadLeadHandler } = await import(
    pathToFileURL(path.join(compiledDirectory, "api", "download-lead.js")).href
  ));
  ({ createDownloadLinkHandler } = await import(
    pathToFileURL(path.join(compiledDirectory, "api", "send-download-links.js")).href
  ));
  emailHelpers = await import(
    pathToFileURL(path.join(compiledDirectory, "api", "_lib", "download-link-email.js")).href
  );
  ({ createDownloadLeadReplayHandler } = await import(
    pathToFileURL(
      path.join(compiledDirectory, "api", "internal", "download-leads", "replay.js"),
    ).href
  ));
});

after(() => {
  if (compiledDirectory) rmSync(compiledDirectory, { recursive: true, force: true });
  restoreEnvironment("NODE_ENV");
  restoreEnvironment("SIDESTREAM_LEAD_HASH_SECRET");
  restoreEnvironment("SIDESTREAM_RATE_LIMIT_HASH_SECRET");
});

test("canonical identity normalizes email/source and strips sensitive URL query data", () => {
  const options = {
    capturedAt: new Date("2026-07-14T12:00:00.000Z"),
    idempotencyKey: "capture-attempt-1",
    referrer: "https://sidestream.tv/download?email=private@example.com#fragment",
    secret: testSecret,
  };
  const first = helpers.buildCanonicalDownloadLead({
    email: "  Person@Example.COM ",
    page: "/landing?email=private@example.com",
    source: "Windows-Waitlist",
    utmCampaign: "Launch_One",
  }, options);
  const second = helpers.buildCanonicalDownloadLead({
    email: "person@example.com",
    page: "/landing",
    source: "windows-waitlist",
    utm_campaign: "launch_one",
  }, options);

  assert.equal(first.email, "person@example.com");
  assert.equal(first.ctaSource, "windows-waitlist");
  assert.equal(first.sourcePage, "/landing");
  assert.equal(first.referrer, "https://sidestream.tv/download");
  assert.equal(first.utmCampaign, "launch_one");
  assert.equal(first.leadKey, second.leadKey);
  assert.equal(first.idempotencyKeyHash, second.idempotencyKeyHash);
  assert.match(first.leadKey, /^lead_v1_[0-9a-f]{64}$/);
  assert.equal(first.leadKey.includes("person"), false);

  const pathname = helpers.getDeterministicLeadBlobPathname(
    first.leadKey,
    "sidestream/download-leads",
  );
  assert.match(
    pathname,
    /^sidestream\/download-leads\/fallback-v2\/[0-9a-f]{2}\/[0-9a-f]{64}\.json$/,
  );
});

test("lead validation rejects oversized and malformed fields before persistence", () => {
  assert.throws(
    () => helpers.buildCanonicalDownloadLead({
      email: `${"a".repeat(315)}@x.com`,
      source: "download-email-gate",
    }, { secret: testSecret }),
    (error) => error.code === "email_too_long",
  );
  assert.throws(
    () => helpers.buildCanonicalDownloadLead({
      email: "person@example.com",
      page: `/${"x".repeat(241)}`,
    }, { secret: testSecret }),
    (error) => error.code === "page_too_long",
  );
  assert.throws(
    () => helpers.buildCanonicalDownloadLead({
      email: "person@example.com",
      source: "not a safe source",
    }, { secret: testSecret }),
    (error) => error.code === "invalid_source",
  );
  assert.throws(
    () => helpers.parseIdempotencyKey("x".repeat(129)),
    (error) => error.code === "invalid_idempotency_key",
  );
});

test("deterministic fallback merging preserves capture range, count, and latest campaign", () => {
  const first = helpers.buildCanonicalDownloadLead({
    email: "person@example.com",
    source: "download-email-gate",
    utmCampaign: "first",
  }, {
    capturedAt: new Date("2026-07-14T12:00:00.000Z"),
    idempotencyKey: "attempt-1",
    secret: testSecret,
  });
  const latest = helpers.buildCanonicalDownloadLead({
    email: "person@example.com",
    source: "download-email-gate",
    utmCampaign: "latest",
  }, {
    capturedAt: new Date("2026-07-14T12:05:00.000Z"),
    idempotencyKey: "attempt-2",
    secret: testSecret,
  });
  const merged = helpers.mergeFallbackLeads(first, latest);
  assert.equal(merged.firstCapturedAt, first.capturedAt);
  assert.equal(merged.lastCapturedAt, latest.capturedAt);
  assert.equal(merged.submissionCount, 2);
  assert.equal(merged.utmCampaign, "latest");
  assert.equal(helpers.mergeFallbackLeads(merged, latest), merged);
});

test("historical replay parsing supports mapped formats and discards raw IP/user-agent fields", () => {
  const prefix = "sidestream/download-leads";
  assert.equal(
    helpers.classifyLeadBlobPathname(
      `${prefix}/2026-06-26/1750951234567-123e4567-e89b-42d3-a456-426614174000.json`,
      prefix,
    ),
    "legacy-date-uuid",
  );
  assert.equal(
    helpers.classifyLeadBlobPathname(
      `${prefix}/2026-06-26/1750951234567-123e4567-e89b-42d3-a456-426614174000-random99.json`,
      prefix,
    ),
    "legacy-date-uuid-suffix",
  );
  assert.equal(
    helpers.classifyLeadBlobPathname(`${prefix}/lead-private@example.com.json`, prefix),
    "unmapped",
  );

  const parsed = helpers.parseReplayBlob(JSON.stringify({
    email: "Legacy@Example.com",
    capturedAt: "2026-06-26T10:00:00.000Z",
    page: "/",
    source: "windows-waitlist",
    ipAddress: "203.0.113.77",
    userAgent: "private-agent",
  }), {
    uploadedAt: new Date("2026-06-26T10:01:00.000Z"),
    secret: testSecret,
  });
  const serialized = JSON.stringify(parsed);
  assert.equal(parsed.email, "legacy@example.com");
  assert.equal(serialized.includes("203.0.113.77"), false);
  assert.equal(serialized.includes("private-agent"), false);
});

test("database capture hashes both limiter dimensions before canonical upsert in one transaction", async () => {
  const queries = [];
  const runner = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("sidestream_api_rate_limits")) {
        const entries = JSON.parse(params[0]);
        return {
          rows: entries.map((entry) => ({
            dimension_hash: entry.dimension_hash,
            max_requests: entry.max_requests,
            request_count: 1,
          })),
        };
      }
      if (sql.includes("sidestream_download_leads")) {
        return { rows: [{ inserted: true }] };
      }
      throw new Error("unexpected query");
    },
  };
  const lead = helpers.buildCanonicalDownloadLead({
    email: "person@example.com",
    source: "windows-waitlist",
  }, {
    capturedAt: new Date("2026-07-14T12:00:00.000Z"),
    secret: testSecret,
  });
  let transactionCount = 0;
  const result = await helpers.captureDownloadLeadInPostgres(lead, {
    ipAddress: "203.0.113.9",
    now: new Date("2026-07-14T12:00:00.000Z"),
    transaction: async (callback) => {
      transactionCount += 1;
      return callback(runner);
    },
  });

  assert.equal(transactionCount, 1);
  assert.equal(result.rateLimit.allowed, true);
  assert.equal(result.upsert.outcome, "inserted");
  assert.equal(queries.length, 2);
  assert.match(queries[0].sql, /sidestream_api_rate_limits/);
  assert.match(queries[1].sql, /on conflict \(email, cta_source\)/);
  const limiterParameters = JSON.stringify(queries[0].params);
  assert.equal(limiterParameters.includes("person@example.com"), false);
  assert.equal(limiterParameters.includes("203.0.113.9"), false);
});

test("bounded Idempotency-Key receipts suppress repeats and reject identity reuse", async () => {
  const lead = helpers.buildCanonicalDownloadLead({
    email: "person@example.com",
    source: "download-email-gate",
  }, {
    idempotencyKey: "attempt-123",
    secret: testSecret,
  });
  let canonicalWrites = 0;
  let receiptExists = false;
  let receiptIdentity = "";
  const runner = {
    query: async (sql, params) => {
      if (sql.includes("sidestream_download_lead_idempotency") && sql.includes("insert into")) {
        if (receiptExists) return { rows: [] };
        receiptExists = true;
        receiptIdentity = params[1];
        return { rows: [{ lead_identity_hash: receiptIdentity }] };
      }
      if (sql.includes("select lead_identity_hash")) {
        return { rows: [{ lead_identity_hash: receiptIdentity }] };
      }
      if (sql.includes("insert into public.sidestream_download_leads")) {
        canonicalWrites += 1;
        return { rows: [{ inserted: true }] };
      }
      throw new Error("unexpected query");
    },
  };

  assert.equal((await helpers.upsertCanonicalDownloadLead(runner, lead)).outcome, "inserted");
  assert.equal((await helpers.upsertCanonicalDownloadLead(runner, lead)).outcome, "idempotent");
  assert.equal(canonicalWrites, 1);

  receiptIdentity = `lead_v1_${"f".repeat(64)}`;
  await assert.rejects(
    helpers.upsertCanonicalDownloadLead(runner, lead),
    (error) => error.name === "DownloadLeadIdempotencyConflictError",
  );
});

test("replay receipts seed idempotence for blobs already recorded by the legacy migrator", async () => {
  const lead = helpers.buildCanonicalDownloadLead({
    email: "legacy@example.com",
    source: "windows-waitlist",
  }, { secret: testSecret });
  let canonicalWrites = 0;
  let receiptWrites = 0;
  const runner = {
    query: async (sql) => {
      if (sql.includes("migrated_from_blob_pathname")) {
        return { rows: [{ migrated: true }] };
      }
      if (sql.includes("sidestream_download_lead_replay_receipts")) {
        receiptWrites += 1;
        return { rows: [{ lead_identity_hash: lead.leadKey }] };
      }
      if (sql.includes("insert into public.sidestream_download_leads")) {
        canonicalWrites += 1;
        return { rows: [{ inserted: true }] };
      }
      throw new Error("unexpected query");
    },
  };
  const result = await helpers.upsertCanonicalDownloadLead(runner, lead, {
    replayReceiptHash: "a".repeat(64),
    migratedBlobPathname: "sidestream/download-leads/2026-06-26/legacy.json",
  });
  assert.equal(result.outcome, "idempotent");
  assert.equal(receiptWrites, 1);
  assert.equal(canonicalWrites, 0);
});

test("capture route validates media type/body size before touching Postgres or Blob", async () => {
  let storageCalls = 0;
  const handler = createDownloadLeadHandler({
    postgresConfigured: () => {
      storageCalls += 1;
      return false;
    },
    writeFallback: async () => {
      storageCalls += 1;
    },
    log: () => {},
  });
  const unsupported = await invoke(handler, {
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ email: "person@example.com" }),
  });
  assert.equal(unsupported.status, 415);

  const oversized = await invoke(handler, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "person@example.com", padding: "x".repeat(9_000) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal(storageCalls, 0);
});

test("capture route returns Retry-After for a consumed database limit", async () => {
  let fallbackCalls = 0;
  const handler = createDownloadLeadHandler({
    postgresConfigured: () => true,
    capturePostgres: async () => ({
      rateLimit: {
        allowed: false,
        limit: 5,
        remaining: 0,
        retryAfterSeconds: 42,
        resetAt: "2026-07-14T12:10:00.000Z",
      },
      upsert: null,
    }),
    writeFallback: async () => {
      fallbackCalls += 1;
    },
    log: () => {},
  });
  const response = await invoke(handler, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "person@example.com" }),
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "42");
  assert.equal(response.body.code, "rate_limited");
  assert.equal(fallbackCalls, 0);
});

test("database outage writes one deterministic private-safe fallback identity", async () => {
  const fallbackWrites = [];
  const logs = [];
  const now = new Date("2026-07-14T12:00:00.000Z");
  const handler = createDownloadLeadHandler({
    now: () => now,
    postgresConfigured: () => true,
    capturePostgres: async () => {
      const error = new Error("database unavailable for private@example.com");
      error.code = "ECONNRESET";
      throw error;
    },
    writeFallback: async (pathname, lead) => fallbackWrites.push({
      pathname,
      body: helpers.serializeFallbackLead(lead),
    }),
    log: (entry) => logs.push(entry),
  });
  const request = {
    headers: {
      "content-type": "application/json",
      "idempotency-key": "same-attempt",
      "x-forwarded-for": "203.0.113.88",
      "user-agent": "private-agent",
    },
    body: JSON.stringify({
      email: "private@example.com",
      source: "windows-waitlist",
    }),
  };
  const first = await invoke(handler, request);
  const second = await invoke(handler, request);

  assert.equal(first.status, 200);
  assert.equal(first.body.queued, true);
  assert.equal(second.status, 200);
  assert.equal(fallbackWrites.length, 2);
  assert.equal(fallbackWrites[0].pathname, fallbackWrites[1].pathname);
  assert.equal(fallbackWrites[0].body, fallbackWrites[1].body);
  assert.equal(fallbackWrites[0].body.includes("203.0.113.88"), false);
  assert.equal(fallbackWrites[0].body.includes("private-agent"), false);
  const operationalOutput = JSON.stringify({ logs, first, second });
  assert.equal(operationalOutput.includes("private@example.com"), false);
  assert.equal(operationalOutput.includes("203.0.113.88"), false);
});

test("mobile download email builder sends both stable installers through Resend", async () => {
  let request;
  const result = await emailHelpers.sendDownloadLinkEmail({
    recipient: "person@example.com",
    idempotencyKeyHash: "a".repeat(64),
    environment: { RESEND_API_KEY: "resend-test-key" },
    fetchImpl: async (input, init) => {
      request = { input: String(input), init };
      return new Response(JSON.stringify({ id: "email-test-id" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.deepEqual(result, { emailId: "email-test-id" });
  assert.equal(request.input, "https://api.resend.com/emails");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers.Authorization, "Bearer resend-test-key");
  assert.equal(
    request.init.headers["Idempotency-Key"],
    `mobile-download-links/${"a".repeat(64)}`,
  );
  const message = JSON.parse(request.init.body);
  assert.equal(message.from, "Sidestream <downloads@alexg.mov>");
  assert.equal(message.reply_to, "alex@alexg.mov");
  assert.deepEqual(message.to, ["person@example.com"]);
  assert.match(message.html, /Download for Mac/);
  assert.match(message.html, /Download for Windows/);
  assert.equal((message.html.match(/border-radius:999px/g) || []).length, 2);
  assert.equal((message.html.match(/class="download-link"/g) || []).length, 2);
  assert.equal((message.html.match(/background:#ffffff;color:#000000/g) || []).length, 2);
  assert.match(message.html, /background:#ff2a2a !important/);
  assert.match(message.text, /platform=win32-x64/);
  assert.match(message.text, /utm_source=mobile_handoff/);
});

test("mobile download route requires idempotency and fails closed without durable rate limiting", async () => {
  let sendCalls = 0;
  const handler = createDownloadLinkHandler({
    consumeLimit: async () => {
      throw new Error("Blob unavailable");
    },
    storeLead: async () => {},
    sendEmail: async () => {
      sendCalls += 1;
    },
    log: () => {},
  });
  const missingIdempotency = await invoke(handler, {
    path: "/api/send-download-links",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "person@example.com" }),
  });
  assert.equal(missingIdempotency.status, 400);
  assert.equal(missingIdempotency.body.code, "missing_idempotency_key");

  const unavailable = await invoke(handler, {
    path: "/api/send-download-links",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "mobile-attempt-1",
    },
    body: JSON.stringify({ email: "person@example.com" }),
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.code, "email_unavailable");
  assert.equal(sendCalls, 0);
});

test("mobile download route fixes the lead source, rate limits, and never logs the email", async () => {
  const captured = [];
  const sent = [];
  const logs = [];
  const allowedRateLimit = {
    allowed: true,
    limit: 3,
    remaining: 2,
    retryAfterSeconds: 0,
    resetAt: "2026-07-14T13:00:00.000Z",
  };
  const handler = createDownloadLinkHandler({
    now: () => new Date("2026-07-14T12:00:00.000Z"),
    consumeLimit: async (lead, options) => {
      captured.push({ lead, options });
      return allowedRateLimit;
    },
    storeLead: async (lead) => captured.push({ storedLead: lead }),
    sendEmail: async (lead) => {
      sent.push(lead);
    },
    log: (entry) => logs.push(entry),
  });
  const response = await invoke(handler, {
    path: "/api/send-download-links",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "mobile-attempt-2",
      "x-forwarded-for": "203.0.113.92",
    },
    body: JSON.stringify({
      email: "Person@Example.com",
      source: "attacker-controlled-source",
      page: "/?email=private@example.com",
      utmSource: "instagram",
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
  assert.equal(response.headers.get("ratelimit-limit"), "3");
  assert.equal(captured.length, 2);
  assert.equal(captured[0].lead.email, "person@example.com");
  assert.equal(captured[0].lead.ctaSource, "mobile-download-handoff");
  assert.equal(captured[0].lead.sourcePage, "/");
  assert.equal(captured[0].lead.utmSource, "instagram");
  assert.equal(captured[0].options.ipAddress, "203.0.113.92");
  assert.equal(captured[1].storedLead, captured[0].lead);
  assert.equal(sent.length, 1);
  assert.equal(JSON.stringify(logs).includes("person@example.com"), false);
  assert.deepEqual(logs, [{
    event: "mobile_download_link_email",
    outcome: "accepted",
    count: 1,
  }]);
});

test("mobile download route does not call Resend after a consumed rate limit", async () => {
  let sendCalls = 0;
  const handler = createDownloadLinkHandler({
    consumeLimit: async () => ({
      allowed: false,
      limit: 3,
      remaining: 0,
      retryAfterSeconds: 900,
      resetAt: "2026-07-14T13:00:00.000Z",
    }),
    storeLead: async () => {},
    sendEmail: async () => {
      sendCalls += 1;
    },
    log: () => {},
  });
  const response = await invoke(handler, {
    path: "/api/send-download-links",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "mobile-attempt-3",
    },
    body: JSON.stringify({ email: "person@example.com" }),
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "900");
  assert.equal(sendCalls, 0);
});

test("mobile download route sanitizes provider failures", async () => {
  const logs = [];
  const handler = createDownloadLinkHandler({
    consumeLimit: async () => ({
      allowed: true,
      limit: 3,
      remaining: 2,
      retryAfterSeconds: 0,
      resetAt: "2026-07-14T13:00:00.000Z",
    }),
    storeLead: async () => {},
    sendEmail: async () => {
      throw new emailHelpers.DownloadLinkEmailDeliveryError(
        "private@example.com was rejected",
        422,
      );
    },
    log: (entry) => logs.push(entry),
  });
  const response = await invoke(handler, {
    path: "/api/send-download-links",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "mobile-attempt-4",
    },
    body: JSON.stringify({ email: "private@example.com" }),
  });
  assert.equal(response.status, 502);
  assert.equal(response.body.code, "email_send_failed");
  assert.equal(JSON.stringify({ logs, response }).includes("private@example.com"), false);
  assert.deepEqual(logs, [{
    event: "mobile_download_link_email",
    outcome: "provider_failed",
    count: 1,
    providerStatus: 422,
  }]);
});

test("protected replay pages mapped blobs, isolates bad data, and deletes only committed rows", async () => {
  const prefix = "sidestream/download-leads";
  const canonicalLead = helpers.buildCanonicalDownloadLead({
    email: "canonical@example.com",
    source: "download-email-gate",
  }, { secret: testSecret });
  const canonicalPath = helpers.getDeterministicLeadBlobPathname(canonicalLead.leadKey, prefix);
  const legacyPath = `${prefix}/2026-06-26/1750951234567-123e4567-e89b-42d3-a456-426614174000.json`;
  const malformedPath = `${prefix}/2026-06-27/1750951234568-123e4567-e89b-42d3-a456-426614174001.json`;
  const failedPath = `${prefix}/2026-06-28/1750951234569-123e4567-e89b-42d3-a456-426614174002.json`;
  const unmappedPath = `${prefix}/email-private@example.com.json`;
  const blobs = [canonicalPath, legacyPath, malformedPath, failedPath, unmappedPath]
    .map((pathname) => fakeBlob(pathname));
  const bodies = new Map([
    [canonicalPath, helpers.serializeFallbackLead(canonicalLead)],
    [legacyPath, JSON.stringify({
      email: "legacy@example.com",
      source: "windows-waitlist",
      capturedAt: "2026-06-26T10:00:00.000Z",
    })],
    [malformedPath, "{not-json"],
    [failedPath, JSON.stringify({
      email: "database-failure@example.com",
      source: "download-email-gate",
    })],
  ]);
  const events = [];
  const readPaths = [];
  const deletedPaths = [];
  const logs = [];
  let activeEmail = "";
  const handler = createDownloadLeadReplayHandler({
    getCronSecret: () => "replay-route-secret-that-is-long-enough",
    listPage: async ({ limit }) => {
      assert.equal(limit, 5);
      return { blobs, cursor: "cursor-next", hasMore: true };
    },
    readBlob: async (blob) => {
      readPaths.push(blob.pathname);
      return bodies.get(blob.pathname);
    },
    transaction: async (callback) => {
      const result = await callback({});
      events.push(`commit:${activeEmail}`);
      return result;
    },
    upsertLead: async (_client, lead) => {
      activeEmail = lead.email;
      events.push(`upsert:${lead.email}`);
      if (lead.email === "database-failure@example.com") {
        throw new Error("database failed");
      }
      return {
        outcome: lead.email === "legacy@example.com" ? "idempotent" : "inserted",
      };
    },
    deleteBlob: async (blob) => {
      events.push(`delete:${activeEmail}`);
      deletedPaths.push(blob.pathname);
    },
    log: (entry) => logs.push(entry),
  });

  const response = await invoke(handler, {
    path: "/api/internal/download-leads/replay",
    headers: {
      authorization: "Bearer replay-route-secret-that-is-long-enough",
      "content-type": "application/json",
    },
    body: JSON.stringify({ limit: 5, disposition: "delete" }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.summary, {
    listed: 5,
    mapped: 4,
    replayed: 1,
    idempotent: 1,
    malformed: 1,
    unmapped: 1,
    readFailed: 0,
    databaseFailed: 1,
    deleted: 2,
    deleteFailed: 0,
  });
  assert.equal(response.body.nextCursor, "cursor-next");
  assert.equal(readPaths.includes(unmappedPath), false);
  assert.deepEqual(deletedPaths, [canonicalPath, legacyPath]);
  assert.ok(events.indexOf("commit:canonical@example.com") < events.indexOf("delete:canonical@example.com"));
  assert.ok(events.indexOf("commit:legacy@example.com") < events.indexOf("delete:legacy@example.com"));
  assert.equal(deletedPaths.includes(malformedPath), false);
  assert.equal(deletedPaths.includes(failedPath), false);
  assert.equal(logs.length, 1);
  assert.equal(JSON.stringify(logs).includes("@example.com"), false);
});

test("replay rejects bad authorization and overlarge batches before listing Blob", async () => {
  let listCalls = 0;
  const handler = createDownloadLeadReplayHandler({
    getCronSecret: () => "replay-route-secret-that-is-long-enough",
    listPage: async () => {
      listCalls += 1;
      return { blobs: [], hasMore: false };
    },
    log: () => {},
  });
  const unauthorized = await invoke(handler, {
    headers: {
      authorization: "Bearer wrong-secret-that-is-still-long-enough",
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(unauthorized.status, 401);

  const overlarge = await invoke(handler, {
    headers: {
      authorization: "Bearer replay-route-secret-that-is-long-enough",
      "content-type": "application/json",
    },
    body: JSON.stringify({ limit: 101 }),
  });
  assert.equal(overlarge.status, 400);
  assert.equal(overlarge.body.code, "invalid_limit");
  assert.equal(listCalls, 0);
});

test("migration deterministically aggregates duplicates before adding canonical uniqueness", () => {
  const migration = readFileSync(
    path.join(repoRoot, "db", "migrations", "20260713205000_harden_download_leads.sql"),
    "utf8",
  );
  const normalize = migration.indexOf("update public.sidestream_download_leads");
  const rank = migration.indexOf("create temporary table sidestream_download_lead_dedupe");
  const aggregate = migration.indexOf("sum(submission_count) over canonical_lead");
  const removeDuplicates = migration.indexOf("delete from public.sidestream_download_leads as duplicate");
  const unique = migration.indexOf("sidestream_download_leads_email_cta_unique");
  assert.ok(normalize >= 0 && rank > normalize && aggregate > rank);
  assert.ok(removeDuplicates > aggregate && unique > removeDuplicates);
  assert.match(migration, /first_captured_at timestamptz/);
  assert.match(migration, /last_captured_at timestamptz/);
  assert.match(migration, /submission_count bigint not null default 1/);
  assert.match(migration, /sidestream_download_lead_idempotency/);
  assert.match(migration, /sidestream_download_lead_replay_receipts/);
  assert.match(migration, /edge\/WAF limit/);
  assert.match(migration, /does not mutate Vercel Firewall/);
});

test("runtime source uses deterministic private overwrite and aggregate structured logging", () => {
  const captureSource = readFileSync(path.join(repoRoot, "api", "download-lead.ts"), "utf8");
  const blobSource = readFileSync(
    path.join(repoRoot, "api", "_lib", "download-lead-blob.ts"),
    "utf8",
  );
  const replaySource = readFileSync(
    path.join(repoRoot, "api", "internal", "download-leads", "replay.ts"),
    "utf8",
  );
  assert.match(blobSource, /access: "private"/);
  assert.match(blobSource, /addRandomSuffix: false/);
  assert.match(blobSource, /allowOverwrite: true/);
  assert.match(blobSource, /ifMatch: current\.blob\.etag/);
  assert.doesNotMatch(captureSource, /console\.error\([^\n]*email/i);
  assert.doesNotMatch(replaySource, /console\.error/);
  assert.doesNotMatch(replaySource, /download_lead_replay_item/);
});

function fakeBlob(pathname) {
  return {
    pathname,
    size: 500,
    uploadedAt: new Date("2026-07-14T12:00:00.000Z"),
    etag: `etag-${pathname.length}`,
    url: "https://blob.example/private",
    downloadUrl: "https://blob.example/private?download=1",
  };
}

async function invoke(handler, options = {}) {
  let resolveHandler;
  let rejectHandler;
  const handlerDone = new Promise((resolve, reject) => {
    resolveHandler = resolve;
    rejectHandler = reject;
  });
  handlerDone.catch(() => {});
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).then(resolveHandler, (error) => {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: "handler failure" }));
      } else if (!response.writableEnded) {
        response.end();
      }
      rejectHandler(error);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}${options.path || "/api/download-lead"}`,
      {
        method: options.method || "POST",
        headers: options.headers || {},
        body: options.body,
      },
    );
    const text = await response.text();
    await handlerDone;
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) : null,
    };
  } finally {
    server.close();
  }
}

function restoreEnvironment(name) {
  if (originalEnvironment[name] === undefined) delete process.env[name];
  else process.env[name] = originalEnvironment[name];
}

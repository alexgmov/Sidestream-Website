import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  parseReportArguments,
  summarizeReferralBlobPathnames,
} from "../scripts/report-referral-visits.mjs";

const repoRoot = process.cwd();
let compiledDirectory;
let buildReferralVisitEvent;
let createReferralVisitHandler;
let parseReferralVisitSource;
const originalHashSecret = process.env.SIDESTREAM_INSTALLER_ANALYTICS_HASH_SECRET;

before(async () => {
  process.env.SIDESTREAM_INSTALLER_ANALYTICS_HASH_SECRET =
    "referral-visit-test-secret-that-is-long-enough";
  mkdirSync(path.join(repoRoot, "node_modules", ".tmp"), { recursive: true });
  compiledDirectory = mkdtempSync(
    path.join(repoRoot, "node_modules", ".tmp", "referral-visit-test-"),
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

  ({ createReferralVisitHandler } = await import(
    pathToFileURL(path.join(compiledDirectory, "api", "referral-visit.js")).href
  ));
  ({ buildReferralVisitEvent, parseReferralVisitSource } = await import(
    pathToFileURL(
      path.join(compiledDirectory, "api", "_lib", "referral-visits.js"),
    ).href
  ));
});

after(() => {
  if (compiledDirectory) rmSync(compiledDirectory, { recursive: true, force: true });
  if (originalHashSecret === undefined) {
    delete process.env.SIDESTREAM_INSTALLER_ANALYTICS_HASH_SECRET;
  } else {
    process.env.SIDESTREAM_INSTALLER_ANALYTICS_HASH_SECRET = originalHashSecret;
  }
});

test("ManyChat POST schedules a privacy-limited visit write without delaying the response", async () => {
  const recorded = [];
  const backgroundTasks = [];
  const handler = createReferralVisitHandler({
    recordVisit: async (event) => recorded.push(event),
    scheduleBackground: (operation) => backgroundTasks.push(operation),
    logTrackingError: () => assert.fail("tracking should not fail"),
  });
  const result = await invoke(handler, {
    body: { source: "ManyChat" },
    headers: {
      "user-agent": "Mozilla/5.0 Chrome/140.0",
      "x-forwarded-for": "203.0.113.7",
    },
  });

  assert.equal(result.response.status, 204);
  await result.handlerDone;
  await Promise.all(backgroundTasks);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].source, "manychat");
  assert.equal(recorded[0].likelyScanner, false);
  assert.match(recorded[0].visitorHash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(recorded[0]).includes("203.0.113.7"), false);
  assert.equal(JSON.stringify(recorded[0]).includes("Chrome/140.0"), false);
});

test("unsupported sources, methods, content types, and oversized bodies fail closed", async () => {
  for (const request of [
    { method: "GET", body: { source: "manychat" }, expected: 405 },
    { body: { source: "tiktok" }, expected: 400 },
    { body: { source: "manychat" }, contentType: "text/plain", expected: 415 },
    { rawBody: JSON.stringify({ source: "manychat", padding: "x".repeat(1_100) }), expected: 413 },
  ]) {
    let scheduled = 0;
    const handler = createReferralVisitHandler({
      scheduleBackground: () => { scheduled += 1; },
    });
    const result = await invoke(handler, request);
    await result.handlerDone;
    assert.equal(result.response.status, request.expected);
    assert.equal(scheduled, 0);
  }
});

test("numbered Meta sources are accepted only within the documented range", async () => {
  for (const source of ["meta-ads-1", "meta-ads-2", "meta-ads-999"]) {
    const recorded = [];
    const backgroundTasks = [];
    const handler = createReferralVisitHandler({
      recordVisit: async (event) => recorded.push(event),
      scheduleBackground: (operation) => backgroundTasks.push(operation),
      logTrackingError: () => assert.fail("tracking should not fail"),
    });
    const result = await invoke(handler, { body: { source } });

    assert.equal(result.response.status, 204);
    await result.handlerDone;
    await Promise.all(backgroundTasks);
    assert.equal(recorded[0]?.source, source);
  }

  for (const source of ["meta-ads-0", "meta-ads-01", "meta-ads-1000"]) {
    const result = await invoke(createReferralVisitHandler(), { body: { source } });
    assert.equal(result.response.status, 400);
    await result.handlerDone;
  }
});

test("daily visitor hashes are deterministic, source scoped, and rotate by day", () => {
  const request = fakeRequest({
    "user-agent": "Mozilla/5.0 Chrome/140.0",
    "x-forwarded-for": "203.0.113.9",
  });
  const first = buildReferralVisitEvent(request, "manychat", {
    now: new Date("2026-07-21T12:00:00.000Z"),
    secret: "secret-a",
  });
  const repeat = buildReferralVisitEvent(request, "manychat", {
    now: new Date("2026-07-21T23:00:00.000Z"),
    secret: "secret-a",
  });
  const nextDay = buildReferralVisitEvent(request, "manychat", {
    now: new Date("2026-07-22T00:00:00.000Z"),
    secret: "secret-a",
  });
  const instagramBio = buildReferralVisitEvent(request, "instagram-bio", {
    now: new Date("2026-07-21T12:00:00.000Z"),
    secret: "secret-a",
  });
  const alexInstagram = buildReferralVisitEvent(request, "instagram-alex", {
    now: new Date("2026-07-21T12:00:00.000Z"),
    secret: "secret-a",
  });
  const metaAdsOne = buildReferralVisitEvent(request, "meta-ads-1", {
    now: new Date("2026-07-21T12:00:00.000Z"),
    secret: "secret-a",
  });
  const metaAds999 = buildReferralVisitEvent(request, "meta-ads-999", {
    now: new Date("2026-07-21T12:00:00.000Z"),
    secret: "secret-a",
  });
  const redditOne = buildReferralVisitEvent(request, "reddit-1", {
    now: new Date("2026-07-21T12:00:00.000Z"),
    secret: "secret-a",
  });
  const redditTwo = buildReferralVisitEvent(request, "reddit-2", {
    now: new Date("2026-07-21T12:00:00.000Z"),
    secret: "secret-a",
  });

  assert.equal(first.visitorHash, repeat.visitorHash);
  assert.notEqual(first.visitorHash, nextDay.visitorHash);
  assert.notEqual(first.visitorHash, instagramBio.visitorHash);
  assert.notEqual(instagramBio.visitorHash, alexInstagram.visitorHash);
  assert.notEqual(alexInstagram.visitorHash, metaAdsOne.visitorHash);
  assert.notEqual(metaAdsOne.visitorHash, metaAds999.visitorHash);
  assert.notEqual(metaAds999.visitorHash, redditOne.visitorHash);
  assert.notEqual(redditOne.visitorHash, redditTwo.visitorHash);
  assert.equal(parseReferralVisitSource(" ManyChat "), "manychat");
  assert.equal(parseReferralVisitSource(" Instagram-Bio "), "instagram-bio");
  assert.equal(parseReferralVisitSource(" Instagram-Alex "), "instagram-alex");
  assert.equal(parseReferralVisitSource(" Meta-Ads-1 "), "meta-ads-1");
  assert.equal(parseReferralVisitSource(" Meta-Ads-2 "), "meta-ads-2");
  assert.equal(parseReferralVisitSource(" Meta-Ads-999 "), "meta-ads-999");
  assert.equal(parseReferralVisitSource("meta-ads-0"), null);
  assert.equal(parseReferralVisitSource("meta-ads-01"), null);
  assert.equal(parseReferralVisitSource("meta-ads-1000"), null);
  assert.equal(parseReferralVisitSource(" Reddit-1 "), "reddit-1");
  assert.equal(parseReferralVisitSource(" Reddit-2 "), "reddit-2");
  assert.equal(parseReferralVisitSource("gmail"), null);
});

test("referral report counts unique daily humans and scanners without exposing hashes", () => {
  const humanHash = "a".repeat(64);
  const scannerHash = "b".repeat(64);
  const summary = summarizeReferralBlobPathnames([
    `sidestream/referrals/v1/manychat/2026-07-20/human/${humanHash}.json`,
    `sidestream/referrals/v1/manychat/2026-07-20/scanner/${scannerHash}.json`,
    `sidestream/referrals/v1/manychat/2026-07-20/scanner/${humanHash}.json`,
    `sidestream/referrals/v1/manychat/2026-07-19/human/${"c".repeat(64)}.json`,
    "sidestream/referrals/v1/other/2026-07-20/human/not-relevant.json",
  ], {
    source: "manychat",
    fromDay: "2026-07-20",
    throughDay: "2026-07-21",
  });

  assert.deepEqual(summary.totals, {
    uniqueDailyVisitors: 2,
    uniqueDailyLikelyHumanVisitors: 1,
    uniqueDailyLikelyScannerVisitors: 2,
  });
  assert.equal(JSON.stringify(summary).includes(humanHash), false);
  assert.deepEqual(parseReportArguments(["--days", "2"], new Date("2026-07-21T12:00:00Z")), {
    source: "manychat",
    days: 2,
    fromDay: "2026-07-20",
    throughDay: "2026-07-21",
  });
});

test("landing page and Vercel config preserve short tracking routes", () => {
  const html = readFileSync(path.join(repoRoot, "index.html"), "utf8");
  const vercel = JSON.parse(readFileSync(path.join(repoRoot, "vercel.json"), "utf8"));
  assert.match(html, /fetch\("\/api\/referral-visit"/);
  assert.match(html, /utm_source/);
  assert.ok(vercel.redirects.some((redirect) =>
    redirect.source === "/m" &&
    redirect.destination === "https://sidestream.tv/?utm_source=manychat" &&
    redirect.permanent === false
  ));
  assert.ok(vercel.redirects.some((redirect) =>
    redirect.source === "/ig" &&
    redirect.destination === "https://sidestream.tv/?utm_source=instagram&utm_medium=social&utm_campaign=bio" &&
    redirect.permanent === false
  ));
  assert.ok(vercel.redirects.some((redirect) =>
    redirect.source === "/ig/" &&
    redirect.destination === "https://sidestream.tv/?utm_source=instagram&utm_medium=social&utm_campaign=bio" &&
    redirect.permanent === false
  ));
  assert.ok(vercel.redirects.some((redirect) =>
    redirect.source === "/alex" &&
    redirect.destination === "https://sidestream.tv/?utm_source=instagram&utm_medium=social&utm_campaign=alex-bio" &&
    redirect.permanent === false
  ));
  assert.ok(vercel.redirects.some((redirect) =>
    redirect.source === "/alex/" &&
    redirect.destination === "https://sidestream.tv/?utm_source=instagram&utm_medium=social&utm_campaign=alex-bio" &&
    redirect.permanent === false
  ));
  assert.ok(vercel.redirects.some((redirect) =>
    redirect.source === "/m/" &&
    redirect.destination === "https://sidestream.tv/?utm_source=manychat" &&
    redirect.permanent === false
  ));
  assert.ok(vercel.redirects.some((redirect) =>
    redirect.source === "/meta/:campaign([1-9]\\d{0,2})" &&
    redirect.destination === "https://sidestream.tv/?utm_source=meta&utm_medium=paid_social&utm_campaign=:campaign" &&
    redirect.permanent === false
  ));
  assert.ok(vercel.redirects.some((redirect) =>
    redirect.source === "/meta/:campaign([1-9]\\d{0,2})/" &&
    redirect.destination === "https://sidestream.tv/?utm_source=meta&utm_medium=paid_social&utm_campaign=:campaign" &&
    redirect.permanent === false
  ));
  assert.ok(vercel.redirects.some((redirect) =>
    redirect.source === "/reddit/1" &&
    redirect.destination === "https://sidestream.tv/?utm_source=reddit&utm_medium=social&utm_campaign=1" &&
    redirect.permanent === false
  ));
  assert.ok(vercel.redirects.some((redirect) =>
    redirect.source === "/reddit/1/" &&
    redirect.destination === "https://sidestream.tv/?utm_source=reddit&utm_medium=social&utm_campaign=1" &&
    redirect.permanent === false
  ));
  assert.ok(vercel.redirects.some((redirect) =>
    redirect.source === "/reddit/2" &&
    redirect.destination === "https://sidestream.tv/?utm_source=reddit&utm_medium=social&utm_campaign=2" &&
    redirect.permanent === false
  ));
  assert.ok(vercel.redirects.some((redirect) =>
    redirect.source === "/reddit/2/" &&
    redirect.destination === "https://sidestream.tv/?utm_source=reddit&utm_medium=social&utm_campaign=2" &&
    redirect.permanent === false
  ));
  assert.match(html, /instagram-bio/);
  assert.match(html, /instagram-alex/);
  assert.match(html, /meta-ads-\$\{utmCampaign\}/);
  assert.match(html, /\^\[1-9\]\\d\{0,2\}\$/);
  assert.match(html, /reddit-1/);
  assert.match(html, /reddit-2/);
});

function fakeRequest(headers = {}) {
  return { headers, socket: { remoteAddress: "127.0.0.1" } };
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
    Promise.resolve(handler(request, response)).then(resolveHandler, rejectHandler);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const headers = {
    "content-type": options.contentType || "application/json",
    "user-agent": "Mozilla/5.0 Chrome/140.0",
    "x-forwarded-for": "203.0.113.10",
    ...options.headers,
  };
  const body = options.rawBody ?? JSON.stringify(options.body || {});

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/referral-visit`, {
      method: options.method || "POST",
      headers,
      body: (options.method || "POST") === "GET" ? undefined : body,
    });
    await response.arrayBuffer();
    return { response, handlerDone };
  } finally {
    server.close();
  }
}

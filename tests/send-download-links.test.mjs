import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  ACQUISITION_COOKIE_NAME,
  createBrowserAcquisitionCookie,
  verifyBrowserAcquisitionCookie,
} from "../api/_lib/acquisition-cookie.ts";
import {
  createAcquisitionHandoff,
  createManyChatEmailDeliveryHandoff,
  verifyAcquisitionHandoff,
} from "../api/_lib/acquisition-handoff.ts";
import {
  buildDownloadLinkEmail,
  DownloadLinkEmailConfigurationError,
} from "../api/_lib/download-link-email.ts";

const SECRET = "mobile-computer-handoff-test-secret-012345678901234";
const NOW = new Date("2026-07-31T18:00:00.000Z");
const originalNodeEnvironment = process.env.NODE_ENV;
let compiledDirectory;
let createDownloadLinkHandler;
let createAcquisitionObservationHandler;
let createServerOwnedDeliveryEntryHandler;

before(async () => {
  process.env.NODE_ENV = "test";
  mkdirSync(path.join(process.cwd(), "node_modules", ".tmp"), { recursive: true });
  compiledDirectory = mkdtempSync(
    path.join(process.cwd(), "node_modules", ".tmp", "acquisition-handoff-test-"),
  );
  execFileSync(path.join(process.cwd(), "node_modules", ".bin", "tsc"), [
    "-p", "tsconfig.node.json",
    "--noEmit", "false",
    "--outDir", compiledDirectory,
    "--tsBuildInfoFile", path.join(compiledDirectory, "tsconfig.tsbuildinfo"),
  ]);
  ({ createDownloadLinkHandler } = await import(
    pathToFileURL(path.join(compiledDirectory, "api", "send-download-links.js")).href
  ));
  ({ createAcquisitionObservationHandler } = await import(
    pathToFileURL(path.join(compiledDirectory, "api", "acquisition", "observe.js")).href
  ));
  ({ createServerOwnedDeliveryEntryHandler } = await import(
    pathToFileURL(path.join(compiledDirectory, "api", "acquisition", "entry.js")).href
  ));
});

after(() => {
  if (compiledDirectory) rmSync(compiledDirectory, { recursive: true, force: true });
  if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnvironment;
});

test("email-optional POST returns one opaque computer link and no identity-bearing query", async () => {
  const handler = handoffHandler();
  const result = await invoke(handler, {
    method: "POST",
    body: JSON.stringify({ handoffOnly: true }),
  });
  assert.equal(result.response.status, 200);
  const payload = await result.response.json();
  assert.equal(payload.ok, true);
  const handoffUrl = new URL(payload.handoffUrl);
  assert.equal(handoffUrl.origin, "https://sidestream.tv");
  assert.equal(handoffUrl.pathname, "/api/send-download-links");
  assert.deepEqual([...handoffUrl.searchParams.keys()], ["handoff"]);
  for (const forbidden of ["utm_", "email", "campaign", "source", "profile", "receipt", "install"] ) {
    assert.equal(payload.handoffUrl.toLowerCase().includes(forbidden), false);
  }
  assert.match(result.response.headers.get("set-cookie"), new RegExp(`^${ACQUISITION_COOKIE_NAME}=`));
  await result.handlerDone;
});

test("no-email handoff records the same opaque acquisition ID without browser-selected delivery truth", async () => {
  const recorded = [];
  const handler = handoffHandler({
    recordHandoff: async (event) => recorded.push(event),
  });
  const result = await invoke(handler, {
    method: "POST",
    body: JSON.stringify({ handoffOnly: true }),
  });
  assert.equal(result.response.status, 200);
  const setCookie = result.response.headers.get("set-cookie");
  const cookieValue = setCookie.split(";", 1)[0].split("=").slice(1).join("=");
  const browser = verifyBrowserAcquisitionCookie(cookieValue, { secret: SECRET, now: NOW });
  await result.response.json();
  await result.handlerDone;
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].cookie.acquisitionId, browser.acquisitionId);
  assert.equal(recorded[0].kind, "secure_share_handoff");
  assert.equal("email" in recorded[0], false);
  assert.equal("entryChannel" in recorded[0], false);
});

test("email-optional POST rejects every identity or attribution field beside the exact handoff flag", async () => {
  for (const body of [
    { handoffOnly: true, email: "private@example.com" },
    { handoffOnly: true, utmSource: "instagram" },
    { handoffOnly: true, installIdHash: "1".repeat(64) },
    { handoffOnly: false },
  ]) {
    const result = await invoke(handoffHandler(), {
      method: "POST",
      body: JSON.stringify(body),
    });
    assert.equal(result.response.status, 400);
    assert.deepEqual(await result.response.json(), {
      error: "Invalid computer handoff request",
      code: "invalid_handoff_request",
    });
    assert.equal(result.response.headers.get("set-cookie"), null);
    await result.handlerDone;
  }
});

test("computer GET verifies the opaque handoff, sets the acquisition cookie, then selects the same installer route", async () => {
  const cookie = createBrowserAcquisitionCookie({
    attribution: { source: "instagram", medium: "social", campaign: "launch", content: null },
  }, { secret: SECRET, now: NOW, randomBytes: () => new Uint8Array(32).fill(4) });
  const token = createAcquisitionHandoff({
    acquisitionCookieValue: cookie.value,
    platform: null,
  }, { secret: SECRET, now: NOW });
  const handler = handoffHandler();
  const result = await invoke(handler, {
    path: `/api/send-download-links?handoff=${encodeURIComponent(token)}`,
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  assert.equal(result.response.status, 302);
  assert.equal(result.response.headers.get("location"), "/api/download?platform=win32-x64");
  assert.match(result.response.headers.get("set-cookie"), new RegExp(`^${ACQUISITION_COOKIE_NAME}=`));
  assert.equal(result.response.headers.get("cache-control"), "private, no-store");
  await result.response.arrayBuffer();
  await result.handlerDone;
});

test("forged, expired, duplicated, and identity-augmented handoffs fail closed", async () => {
  const cookie = createBrowserAcquisitionCookie({}, {
    secret: SECRET,
    now: NOW,
    randomBytes: () => new Uint8Array(32).fill(5),
  });
  const token = createAcquisitionHandoff({
    acquisitionCookieValue: cookie.value,
    platform: "macos",
  }, { secret: SECRET, now: NOW });
  const forgedToken = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
  assert.notEqual(forgedToken, token);
  for (const path of [
    `/api/send-download-links?handoff=${forgedToken}`,
    `/api/send-download-links?handoff=${token}&email=private%40example.com`,
    `/api/send-download-links?handoff=${token}&handoff=${token}`,
  ]) {
    const result = await invoke(handoffHandler(), { path });
    assert.equal(result.response.status, 404);
    await result.response.arrayBuffer();
    await result.handlerDone;
  }
  const expired = await invoke(handoffHandler({
    now: () => new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
  }), { path: `/api/send-download-links?handoff=${token}` });
  assert.equal(expired.response.status, 404);
  await expired.response.arrayBuffer();
  await expired.handlerDone;
});

test("email delivery receives separate signed Mac and Windows handoffs without putting email or UTM data in links", async () => {
  const cookie = createBrowserAcquisitionCookie({
    attribution: { source: "manychat", medium: "dm", campaign: "organic-instagram", content: "hero" },
  }, { secret: SECRET, now: NOW, randomBytes: () => new Uint8Array(32).fill(6) });
  let delivered;
  const handler = handoffHandler({
    sendEmail: async (lead, links) => {
      delivered = { lead, links };
    },
  });
  const result = await invoke(handler, {
    method: "POST",
    headers: { cookie: `${ACQUISITION_COOKIE_NAME}=${cookie.value}` },
    body: JSON.stringify({
      email: "person@example.com",
      page: "/",
      utmSource: "manychat",
      utmCampaign: "organic-instagram",
    }),
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), { ok: true });
  await result.handlerDone;
  assert.equal(delivered.lead.email, "person@example.com");
  for (const [platform, link] of Object.entries({
    macos: delivered.links.macUrl,
    windows: delivered.links.windowsUrl,
  })) {
    assert.equal(link.includes("person@example.com"), false);
    assert.equal(link.includes("utm_"), false);
    const url = new URL(link);
    const handoff = verifyAcquisitionHandoff(url.searchParams.get("handoff"), {
      secret: SECRET,
      now: NOW,
    });
    assert.equal(handoff.platform, platform);
    assert.equal(handoff.acquisitionCookieValue, cookie.value);
  }
});

test("email template accepts only Sidestream installer or opaque-handoff URLs", () => {
  const links = {
    macUrl: "https://sidestream.tv/api/send-download-links?handoff=opaque.mac",
    windowsUrl: "https://sidestream.tv/api/send-download-links?handoff=opaque.windows",
  };
  const message = buildDownloadLinkEmail("person@example.com", {}, links);
  assert.match(message.html, /handoff=opaque\.mac/);
  assert.match(message.text, /handoff=opaque\.windows/);
  assert.throws(
    () => buildDownloadLinkEmail("person@example.com", {}, {
      ...links,
      macUrl: "https://attacker.example/download",
    }),
    DownloadLinkEmailConfigurationError,
  );
});

test("landing observation synchronously ensures valid state but every observation failure stays nonblocking", async () => {
  const cookie = createBrowserAcquisitionCookie({}, {
    secret: SECRET,
    now: NOW,
    randomBytes: () => new Uint8Array(32).fill(8),
  });
  const observed = [];
  const handler = createAcquisitionObservationHandler({
    getSecret: () => SECRET,
    now: () => NOW,
    observe: async (value) => observed.push(value.acquisitionId),
  });
  const accepted = await invoke(handler, {
    method: "POST",
    path: "/api/acquisition/observe",
    headers: { cookie: `${ACQUISITION_COOKIE_NAME}=${cookie.value}` },
  });
  assert.equal(accepted.response.status, 204);
  await accepted.handlerDone;
  assert.deepEqual(observed, [cookie.acquisitionId]);

  const failed = await invoke(createAcquisitionObservationHandler({
    getSecret: () => SECRET,
    now: () => NOW,
    observe: async () => { throw new Error("database unavailable"); },
  }), {
    method: "POST",
    path: "/api/acquisition/observe",
    headers: { cookie: `${ACQUISITION_COOKIE_NAME}=${cookie.value}` },
  });
  assert.equal(failed.response.status, 204);
  await failed.handlerDone;
});

test("ManyChat delivery entry accepts only its opaque server envelope and restores the same acquisition ID", async () => {
  const acquisition = createBrowserAcquisitionCookie({}, {
    secret: SECRET,
    now: NOW,
    randomBytes: () => new Uint8Array(32).fill(9),
  });
  const token = createManyChatEmailDeliveryHandoff({
    acquisitionId: acquisition.acquisitionId,
    intendedIdentity: "private@example.com",
  }, { secret: SECRET, now: NOW });
  const ensured = [];
  const handler = createServerOwnedDeliveryEntryHandler({
    getSecret: () => SECRET,
    now: () => NOW,
    ensure: async (handoff) => ensured.push(handoff),
  });
  const result = await invoke(handler, {
    path: `/api/acquisition/entry?handoff=${encodeURIComponent(token)}`,
  });
  assert.equal(result.response.status, 302);
  assert.equal(result.response.headers.get("location"), "/");
  const setCookie = result.response.headers.get("set-cookie");
  const value = setCookie.split(";", 1)[0].split("=").slice(1).join("=");
  assert.equal(
    verifyBrowserAcquisitionCookie(value, { secret: SECRET, now: NOW }).acquisitionId,
    acquisition.acquisitionId,
  );
  assert.equal(ensured[0].entryChannel, "manychat_email");
  assert.equal(JSON.stringify(ensured[0]).includes("private@example.com"), false);
  await result.handlerDone;
});

function handoffHandler(overrides = {}) {
  return createDownloadLinkHandler({
    now: () => new Date(NOW),
    getAcquisitionSecret: () => SECRET,
    consumeLimit: async () => ({
      allowed: true,
      limit: 3,
      remaining: 2,
      retryAfterSeconds: 0,
      resetAt: "2026-07-31T19:00:00.000Z",
    }),
    storeLead: async () => {},
    sendEmail: async () => {},
    recordHandoff: async () => {},
    scheduleBackground: () => {},
    log: () => {},
    ...overrides,
  });
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
        response.end("handler failure");
      } else if (!response.writableEnded) {
        response.end();
      }
      rejectHandler(error);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const body = options.body;
  const headers = {
    ...(body ? {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      "idempotency-key": "mobile-download-test-attempt-1",
    } : {}),
    ...(options.headers || {}),
  };
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}${options.path || "/api/send-download-links"}`,
      {
        method: options.method || "GET",
        headers,
        body,
        redirect: "manual",
      },
    );
    return { response, handlerDone };
  } finally {
    server.close();
  }
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ACQUISITION_COOKIE_MAX_AGE_SECONDS,
  ACQUISITION_COOKIE_NAME,
  createBrowserAcquisitionCookie,
  normalizeBrowserAcquisitionAttribution,
  serializeBrowserAcquisitionCookie,
  verifyBrowserAcquisitionCookie,
} from "../api/_lib/acquisition-cookie.ts";
import {
  buildAcquisitionHandoffUrl,
  createAcquisitionHandoff,
  verifyAcquisitionHandoff,
} from "../api/_lib/acquisition-handoff.ts";

const SECRET = "anonymous-acquisition-browser-test-secret-0123456789";
const NOW_MS = Date.UTC(2026, 6, 31, 18, 0, 0);
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const TOKEN_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

const middlewareSource = await readFile(
  new URL("../middleware.ts", import.meta.url),
  "utf8",
);
const helperSource = `
  export function next() {
    return new Response(null, { headers: { "x-test-next": "1" } });
  }
  export function rewrite(url, init = {}) {
    const response = new Response(null, { headers: { "x-test-rewrite": String(url) } });
    for (const [name, value] of init.request?.headers || []) {
      response.headers.set("x-rewrite-" + name, value);
    }
    return response;
  }
`;
const helperUrl = `data:text/javascript;base64,${Buffer.from(helperSource).toString("base64")}`;
const middleware = await import(
  `data:text/javascript;base64,${Buffer.from(
    middlewareSource.replace('from "@vercel/functions"', `from "${helperUrl}"`),
  ).toString("base64")}`
);

test("browser attribution recognizes direct, named, and bounded custom sources", () => {
  assert.deepEqual(normalizeBrowserAcquisitionAttribution(new URLSearchParams()), {
    source: "direct",
    medium: null,
    campaign: null,
    content: null,
  });
  for (const source of [
    "instagram", "facebook", "linkedin", "reddit", "youtube", "google",
    "manychat", "manychat-instagram",
  ]) {
    assert.equal(
      normalizeBrowserAcquisitionAttribution(new URLSearchParams(`utm_source=${source}`)).source,
      source,
    );
  }
  assert.deepEqual(
    normalizeBrowserAcquisitionAttribution(new URLSearchParams(
      "utm_source=Creator_News&utm_medium=Social&utm_campaign=Launch_7&utm_content=Hero_A",
    )),
    {
      source: "creator_news",
      medium: "social",
      campaign: "Launch_7",
      content: "Hero_A",
    },
  );
  assert.deepEqual(
    normalizeBrowserAcquisitionAttribution(new URLSearchParams(
      "utm_source=reddit&utm_source=google&utm_campaign=attacker%0Avalue",
    )),
    { source: "direct", medium: null, campaign: null, content: null },
  );
});

test("signed cookie has 256-bit entropy, bounded lifetime, strict attributes, and fail-closed verification", () => {
  const cookie = createBrowserAcquisitionCookie({
    attribution: { source: "reddit", medium: "social", campaign: "launch", content: "hero" },
  }, {
    secret: SECRET,
    now: NOW_MS,
    randomBytes: () => TOKEN_BYTES,
  });
  assert.match(cookie.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(cookie.expiresAt - cookie.issuedAt, ACQUISITION_COOKIE_MAX_AGE_SECONDS);
  const header = serializeBrowserAcquisitionCookie(cookie);
  assert.match(header, new RegExp(`^${ACQUISITION_COOKIE_NAME}=`));
  for (const attribute of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=2592000"]) {
    assert.match(header, new RegExp(attribute));
  }
  assert.equal(
    verifyBrowserAcquisitionCookie(cookie.value, { secret: SECRET, now: NOW_MS }).token,
    cookie.token,
  );
  const forged = `${cookie.value.slice(0, -1)}${cookie.value.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => verifyBrowserAcquisitionCookie(forged, { secret: SECRET, now: NOW_MS }));
  assert.throws(() => verifyBrowserAcquisitionCookie(cookie.value, {
    secret: SECRET,
    now: (cookie.expiresAt * 1000),
  }));
});

test("middleware sets first touch once and preserves its signed experiment", async () => {
  const experiment = {
    experimentId: "mc-mobile-paid-v1",
    cohort: "paid",
    issuedAt: NOW_SECONDS,
    expiresAt: NOW_SECONDS + ACQUISITION_COOKIE_MAX_AGE_SECONDS,
  };
  const first = await middleware.routeBrowserAcquisitionForTest(
    new Request(
      "https://sidestream.tv/?utm_source=instagram&utm_medium=social&utm_campaign=Launch_One&utm_content=Hero",
    ),
    {
      nowMs: NOW_MS,
      tokenBytes: TOKEN_BYTES,
      acquisitionSecret: SECRET,
      experiment,
    },
  );
  const setCookie = first.headers.get("set-cookie");
  assert.ok(setCookie);
  const cookieValue = setCookie.split(";", 1)[0].split("=").slice(1).join("=");
  const verified = verifyBrowserAcquisitionCookie(cookieValue, { secret: SECRET, now: NOW_MS });
  assert.deepEqual(verified.attribution, {
    source: "instagram",
    medium: "social",
    campaign: "Launch_One",
    content: "Hero",
  });
  assert.deepEqual(verified.experiment, experiment);

  const replay = await middleware.routeBrowserAcquisitionForTest(
    new Request("https://sidestream.tv/?utm_source=google&utm_campaign=Overwrite", {
      headers: { cookie: `${ACQUISITION_COOKIE_NAME}=${cookieValue}` },
    }),
    {
      nowMs: NOW_MS + 60_000,
      tokenBytes: Uint8Array.from({ length: 32 }, () => 255),
      acquisitionSecret: SECRET,
      experiment: { ...experiment, cohort: "freemium" },
    },
  );
  assert.equal(replay.headers.get("set-cookie"), null);
});

test("forged browser state is replaced without blocking the page", async () => {
  const response = await middleware.routeBrowserAcquisitionForTest(
    new Request("https://sidestream.tv/?utm_source=youtube", {
      headers: { cookie: `${ACQUISITION_COOKIE_NAME}=forged.value` },
    }),
    { nowMs: NOW_MS, tokenBytes: TOKEN_BYTES, acquisitionSecret: SECRET },
  );
  assert.equal(response.headers.get("x-test-next"), "1");
  const value = response.headers.get("set-cookie").split(";", 1)[0]
    .split("=").slice(1).join("=");
  assert.equal(
    verifyBrowserAcquisitionCookie(value, { secret: SECRET, now: NOW_MS }).attribution.source,
    "youtube",
  );
});

test("mobile handoff is opaque, signed, expiring, and carries no source or identity in its URL", () => {
  const cookie = createBrowserAcquisitionCookie({
    attribution: { source: "manychat-instagram", medium: "dm", campaign: "organic", content: null },
  }, { secret: SECRET, now: NOW_MS, randomBytes: () => TOKEN_BYTES });
  let entropyCall = 0;
  const handoff = createAcquisitionHandoff({
    acquisitionCookieValue: cookie.value,
    platform: "windows",
  }, {
    secret: SECRET,
    now: NOW_MS,
    randomBytes: (size) => Uint8Array.from({ length: size }, () => ++entropyCall),
  });
  const url = buildAcquisitionHandoffUrl(handoff);
  for (const forbidden of ["manychat", "organic", "email", "profile", "receipt", "install"]) {
    assert.equal(url.toLowerCase().includes(forbidden), false);
  }
  assert.deepEqual(
    verifyAcquisitionHandoff(handoff, { secret: SECRET, now: NOW_MS }),
    {
      acquisitionCookieValue: cookie.value,
      platform: "windows",
      issuedAt: NOW_SECONDS,
      expiresAt: NOW_SECONDS + 7 * 24 * 60 * 60,
    },
  );
  assert.throws(() => verifyAcquisitionHandoff(`${handoff.slice(0, -1)}A`, {
    secret: SECRET,
    now: NOW_MS,
  }));
  assert.throws(() => verifyAcquisitionHandoff(handoff, {
    secret: SECRET,
    now: NOW_MS + 7 * 24 * 60 * 60 * 1000,
  }));
});

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ACQUISITION_COOKIE_MAX_AGE_SECONDS,
  ACQUISITION_COOKIE_NAME,
  LEGACY_ACQUISITION_COOKIE_NAME,
  createBrowserAcquisitionCookie,
  normalizeBrowserAcquisitionAttribution,
  normalizeExternalReferrerCategory,
  promoteLegacyBrowserAcquisitionCookie,
  readBrowserAcquisitionCookie,
  serializeBrowserAcquisitionCookie,
  verifyBrowserAcquisitionCookie,
} from "../api/_lib/acquisition-cookie.ts";
import {
  buildAcquisitionHandoffUrl,
  buildServerOwnedDeliveryHandoffUrl,
  createAcquisitionHandoff,
  createManyChatEmailDeliveryHandoff,
  createServerOwnedDeliveryHandoff,
  evaluateForwardedDeliveryHandoff,
  verifyAcquisitionHandoff,
  verifyServerOwnedDeliveryHandoff,
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

test("signed v2 cookie carries one opaque UUID plus bounded evidence and strict attributes", () => {
  const cookie = createBrowserAcquisitionCookie({
    attribution: { source: "reddit", medium: "social", campaign: "launch", content: "hero" },
  }, {
    secret: SECRET,
    now: NOW_MS,
    randomBytes: () => TOKEN_BYTES,
  });
  assert.match(cookie.acquisitionId, /^[0-9a-f-]{36}$/);
  assert.match(cookie.token, /^[A-Za-z0-9_-]{43}$/, "legacy bridge token is derived, not serialized");
  assert.equal(cookie.expiresAt - cookie.issuedAt, ACQUISITION_COOKIE_MAX_AGE_SECONDS);
  const header = serializeBrowserAcquisitionCookie(cookie);
  assert.match(header, new RegExp(`^${ACQUISITION_COOKIE_NAME}=`));
  for (const attribute of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=2592000"]) {
    assert.match(header, new RegExp(attribute));
  }
  assert.equal(
    verifyBrowserAcquisitionCookie(cookie.value, { secret: SECRET, now: NOW_MS }).acquisitionId,
    cookie.acquisitionId,
  );
  const payload = JSON.parse(Buffer.from(cookie.value.split(".")[0], "base64url"));
  assert.deepEqual(Object.keys(payload).sort(), [
    "acquisitionId", "experiment", "expiresAt", "firstTouch", "issuedAt", "v",
  ]);
  assert.equal(payload.v, 2);
  for (const forbidden of ["token", "email", "ip", "receipt", "install", "entryChannel"]) {
    assert.equal(JSON.stringify(payload).toLowerCase().includes(forbidden.toLowerCase()), false);
  }
  const forged = `${cookie.value.slice(0, -1)}${cookie.value.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => verifyBrowserAcquisitionCookie(forged, { secret: SECRET, now: NOW_MS }));
  assert.throws(() => verifyBrowserAcquisitionCookie(cookie.value, {
    secret: SECRET,
    now: (cookie.expiresAt * 1000),
  }));
});

test("valid v1 first touch promotes deterministically while malformed, duplicate, and expired state fails closed", () => {
  const legacy = createLegacyCookie({
    token: Buffer.from(TOKEN_BYTES).toString("base64url"),
    attribution: ["reddit", "social", "Original_7", "Hero"],
    experiment: null,
    issuedAt: NOW_SECONDS,
    expiresAt: NOW_SECONDS + ACQUISITION_COOKIE_MAX_AGE_SECONDS,
  });
  const first = promoteLegacyBrowserAcquisitionCookie(legacy, { secret: SECRET, now: NOW_MS });
  const second = promoteLegacyBrowserAcquisitionCookie(legacy, { secret: SECRET, now: NOW_MS });
  assert.equal(first.acquisitionId, second.acquisitionId);
  assert.deepEqual(first.attribution, {
    source: "reddit", medium: "social", campaign: "Original_7", content: "Hero",
  });
  assert.equal(first.promotedFromV1, true);
  assert.equal(readBrowserAcquisitionCookie(
    `${LEGACY_ACQUISITION_COOKIE_NAME}=${legacy}; ${LEGACY_ACQUISITION_COOKIE_NAME}=${legacy}`,
  ), "");
  assert.throws(() => promoteLegacyBrowserAcquisitionCookie(`${legacy}x`, {
    secret: SECRET,
    now: NOW_MS,
  }));
  assert.throws(() => promoteLegacyBrowserAcquisitionCookie(legacy, {
    secret: SECRET,
    now: (NOW_SECONDS + ACQUISITION_COOKIE_MAX_AGE_SECONDS) * 1000,
  }));
});

test("raw referrers collapse to bounded categories and never remain as URLs", () => {
  assert.equal(normalizeExternalReferrerCategory("https://www.google.com/search?q=sidestream"), "search");
  assert.equal(normalizeExternalReferrerCategory("https://sidestream.tv/private/path"), null);
  assert.equal(normalizeExternalReferrerCategory("https://news.example/private/path"), "other_external");
  assert.equal(normalizeExternalReferrerCategory("not a url"), null);
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
  const nonCanonicalSignature = mutateSignaturePadBits(handoff);
  assert.notEqual(nonCanonicalSignature, handoff);
  assert.equal(
    Buffer.from(nonCanonicalSignature.split(".").at(-1), "base64url").toString("hex"),
    Buffer.from(handoff.split(".").at(-1), "base64url").toString("hex"),
  );
  assert.throws(() => verifyAcquisitionHandoff(nonCanonicalSignature, {
    secret: SECRET,
    now: NOW_MS,
  }));
  assert.throws(() => verifyAcquisitionHandoff(handoff, {
    secret: SECRET,
    now: NOW_MS + 7 * 24 * 60 * 60 * 1000,
  }));
});

test("server-owned delivery handoff fixes ManyChat truth, preserves campaign, and flags only exact identity conflict", () => {
  const cookie = createBrowserAcquisitionCookie({}, {
    secret: SECRET,
    now: NOW_MS,
    randomBytes: () => TOKEN_BYTES,
  });
  const token = createManyChatEmailDeliveryHandoff({
    acquisitionId: cookie.acquisitionId,
    intendedIdentity: "Intended@Example.com",
  }, { secret: SECRET, now: NOW_MS });
  const url = buildServerOwnedDeliveryHandoffUrl(token);
  assert.deepEqual([...new URL(url).searchParams.keys()], ["handoff"]);
  assert.equal(url.includes("Intended"), false);
  const verified = verifyServerOwnedDeliveryHandoff(token, { secret: SECRET, now: NOW_MS });
  assert.deepEqual({
    source: verified.source,
    entryChannel: verified.entryChannel,
    canonicalEntryChannel: verified.canonicalEntryChannel,
    campaign: verified.campaign,
  }, {
    source: "manychat",
    entryChannel: "manychat_email",
    canonicalEntryChannel: "email_handoff",
    campaign: "manychat-email",
  });
  assert.deepEqual(
    evaluateForwardedDeliveryHandoff(verified, null, { secret: SECRET }),
    { possibleForwardedHandoff: false },
  );
  assert.deepEqual(
    evaluateForwardedDeliveryHandoff(verified, "intended@example.com", { secret: SECRET }),
    { possibleForwardedHandoff: false },
  );
  assert.deepEqual(
    evaluateForwardedDeliveryHandoff(verified, "forwarded@example.com", { secret: SECRET }),
    { possibleForwardedHandoff: true },
  );
  assert.throws(() => createServerOwnedDeliveryHandoff({
    acquisitionId: cookie.acquisitionId,
    entryChannel: "query_selected_channel",
    intendedIdentity: "person@example.com",
  }, { secret: SECRET, now: NOW_MS }));
  const future = createServerOwnedDeliveryHandoff({
    acquisitionId: cookie.acquisitionId,
    entryChannel: "facebook_lead_form",
    intendedIdentity: "person@example.com",
  }, { secret: SECRET, now: NOW_MS });
  assert.equal(
    verifyServerOwnedDeliveryHandoff(future, { secret: SECRET, now: NOW_MS }).entryChannel,
    "facebook_lead_form",
  );
});

function mutateSignaturePadBits(token) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const signature = token.split(".").at(-1);
  const finalIndex = alphabet.indexOf(signature.at(-1));
  assert.notEqual(finalIndex, -1);
  return `${token.slice(0, -1)}${alphabet[finalIndex ^ 1]}`;
}

function createLegacyCookie(payload) {
  const encoded = Buffer.from(JSON.stringify({ v: 1, ...payload }), "utf8").toString("base64url");
  const signature = createHmac("sha256", SECRET)
    .update(`sidestream-anonymous-acquisition-cookie-v1:${encoded}`, "utf8")
    .digest("base64url");
  return `${encoded}.${signature}`;
}

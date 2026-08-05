import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const COOKIE_NAME = "__Host-sidestream-mc-mobile-paid-v1";
const ACQUISITION_COOKIE_NAME = "__Host-sidestream-acquisition-v2";
const SECRET = "0123456789abcdef0123456789abcdef";
const ACQUISITION_SECRET = "meta-acquisition-test-secret-0123456789";
const NOW_MS = Date.UTC(2026, 6, 27, 7, 0, 0);
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const ANDROID_PHONE_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/138.0 Mobile Safari/537.36";
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/138.0 Safari/537.36";
const DEFAULT_NONCE = Uint8Array.from({ length: 16 }, (_, index) => index);

const middlewareSource = await readFile(
  new URL("../middleware.ts", import.meta.url),
  "utf8",
);
const vercel = JSON.parse(
  await readFile(new URL("../vercel.json", import.meta.url), "utf8"),
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
const importableSource = middlewareSource.replace(
  'from "@vercel/functions"',
  `from "${helperUrl}"`,
);
const middleware = await import(
  `data:text/javascript;base64,${Buffer.from(importableSource).toString("base64")}`
);

function request(path = "/mc", options = {}) {
  const headers = new Headers(options.headers);
  if (options.userAgent !== null) {
    headers.set("user-agent", options.userAgent ?? IPHONE_UA);
  }
  if (options.fetchDest !== null) {
    headers.set("sec-fetch-dest", options.fetchDest ?? "document");
  }
  if (options.cookie) headers.set("cookie", options.cookie);
  return new Request(`https://sidestream.tv${path}`, {
    method: options.method ?? "GET",
    headers,
  });
}

function deterministicRoute(input, options = {}) {
  return middleware.routePaidExperimentForTest(input, {
    secret: Object.hasOwn(options, "secret") ? options.secret : SECRET,
    nowMs: options.nowMs ?? NOW_MS,
    nonceBytes: options.nonceBytes ?? DEFAULT_NONCE,
  });
}

function cookiePair(response) {
  const header = response.headers.get("set-cookie");
  return header?.split(";", 1)[0] ?? null;
}

function cookieValue(response) {
  return cookiePair(response)?.slice(COOKIE_NAME.length + 1) ?? null;
}

function namedCookieValue(response, name) {
  const header = response.headers.get("set-cookie") || "";
  const match = header.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
  return match?.[1] || null;
}

function acquisitionPayload(response) {
  const value = namedCookieValue(response, ACQUISITION_COOKIE_NAME);
  assert.ok(value, "expected a signed acquisition cookie");
  return JSON.parse(Buffer.from(value.split(".", 1)[0], "base64url"));
}

function bucketForNonce(bytes) {
  const nonce = Buffer.from(bytes).toString("base64url");
  const digest = createHmac("sha256", SECRET)
    .update(`mc-mobile-paid-v1:${nonce}`)
    .digest();
  return Number(digest.readBigUInt64BE(0) % 10_000n);
}

function nonceForCohort(cohort) {
  for (let value = 0; value < 10_000; value += 1) {
    const bytes = new Uint8Array(16);
    new DataView(bytes.buffer).setUint32(12, value);
    const bucket = bucketForNonce(bytes);
    if (
      (cohort === "mc-control-v1" && bucket < 5_000) ||
      (cohort === "mc-paid-v1" && bucket >= 5_000)
    ) {
      return bytes;
    }
  }
  throw new Error(`Unable to find deterministic ${cohort} nonce`);
}

const CONTROL_NONCE = nonceForCohort("mc-control-v1");
const PAID_NONCE = nonceForCohort("mc-paid-v1");

test("Vercel middleware and the existing /m redirect remain exactly scoped", () => {
  assert.deepEqual(middleware.config, {
    matcher: [
      "/",
      "/index.html",
      "/mc",
      "/mc-preview",
      "/meta-default",
      "/meta-paid",
    ],
  });
  for (const source of ["/m", "/m/", "/mc/"]) {
    assert.deepEqual(
      vercel.redirects.find((redirect) => redirect.source === source),
      {
        source,
        destination: "https://sidestream.tv/?utm_source=manychat",
        permanent: false,
      },
    );
  }
  assert.equal(
    vercel.redirects.some((redirect) => redirect.source === "/mc"),
    false,
  );
  for (const source of ["/meta-default", "/meta-paid"]) {
    const headerRule = vercel.headers.find((rule) => rule.source === source);
    assert.deepEqual(headerRule?.headers, [
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
      { key: "Cache-Control", value: "private, no-store" },
    ]);
  }
  assert.doesNotMatch(
    middlewareSource,
    /(?:ipAddress|x-forwarded-for|edge-config|vercel\/flags|Math\.random|console\.)/i,
  );
});

test("fixed Meta links select the default and paid experiences without random assignment", async () => {
  const defaultResponse = await middleware.routeBrowserAcquisitionForTest(
    request("/meta-default", { userAgent: DESKTOP_UA }),
    {
      nowMs: NOW_MS,
      tokenBytes: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      nonceBytes: PAID_NONCE,
      paidSecret: SECRET,
      acquisitionSecret: ACQUISITION_SECRET,
    },
  );
  assert.equal(defaultResponse.status, 307);
  assert.equal(
    defaultResponse.headers.get("location"),
    "https://sidestream.tv/?utm_source=meta&utm_medium=social&utm_campaign=sidestream_direct_offer_test&utm_content=default",
  );
  assert.equal(namedCookieValue(defaultResponse, COOKIE_NAME), null);
  const defaultAcquisition = acquisitionPayload(defaultResponse);
  assert.deepEqual(defaultAcquisition.firstTouch.slice(0, 4), [
    "meta", "social", "sidestream_direct_offer_test", "default",
  ]);
  assert.deepEqual(defaultAcquisition.experiment.slice(0, 2), [
    "meta-direct-links-v1", "freemium",
  ]);

  const paidResponse = await middleware.routeBrowserAcquisitionForTest(
    request("/meta-paid", { userAgent: DESKTOP_UA }),
    {
      nowMs: NOW_MS,
      tokenBytes: Uint8Array.from({ length: 32 }, (_, index) => index + 33),
      nonceBytes: PAID_NONCE,
      paidSecret: SECRET,
      acquisitionSecret: ACQUISITION_SECRET,
    },
  );
  assert.equal(
    paidResponse.headers.get("x-test-rewrite"),
    "https://sidestream.tv/mobile-paid-prototype.html",
  );
  assert.equal(
    paidResponse.headers.get(
      "x-rewrite-x-sidestream-paid-acquisition-attribution",
    ),
    "utm_source=meta&utm_medium=social&utm_campaign=sidestream_direct_offer_test&utm_content=paid",
  );
  assert.match(namedCookieValue(paidResponse, COOKIE_NAME), /^1\./);
  const paidAcquisition = acquisitionPayload(paidResponse);
  assert.deepEqual(paidAcquisition.firstTouch.slice(0, 4), [
    "meta", "social", "sidestream_direct_offer_test", "paid",
  ]);
  assert.deepEqual(paidAcquisition.experiment.slice(0, 2), [
    "meta-direct-links-v1", "paid",
  ]);
  assert.notEqual(paidAcquisition.acquisitionId, defaultAcquisition.acquisitionId);
});

test("Meta journeys stay stable within a variant and restart when the selected ad changes", async () => {
  const first = await middleware.routeBrowserAcquisitionForTest(
    request("/meta-default", { userAgent: DESKTOP_UA }),
    {
      nowMs: NOW_MS,
      tokenBytes: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      paidSecret: SECRET,
      acquisitionSecret: ACQUISITION_SECRET,
    },
  );
  const firstValue = namedCookieValue(first, ACQUISITION_COOKIE_NAME);
  const firstPayload = acquisitionPayload(first);

  const replay = await middleware.routeBrowserAcquisitionForTest(
    request("/meta-default", {
      userAgent: DESKTOP_UA,
      cookie: `${ACQUISITION_COOKIE_NAME}=${firstValue}`,
    }),
    {
      nowMs: NOW_MS + 60_000,
      tokenBytes: Uint8Array.from({ length: 32 }, () => 255),
      paidSecret: SECRET,
      acquisitionSecret: ACQUISITION_SECRET,
    },
  );
  assert.equal(namedCookieValue(replay, ACQUISITION_COOKIE_NAME), null);

  const switched = await middleware.routeBrowserAcquisitionForTest(
    request("/meta-paid", {
      userAgent: DESKTOP_UA,
      cookie: `${ACQUISITION_COOKIE_NAME}=${firstValue}`,
    }),
    {
      nowMs: NOW_MS + 120_000,
      tokenBytes: Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
      nonceBytes: PAID_NONCE,
      paidSecret: SECRET,
      acquisitionSecret: ACQUISITION_SECRET,
    },
  );
  const switchedPayload = acquisitionPayload(switched);
  assert.notEqual(switchedPayload.acquisitionId, firstPayload.acquisitionId);
  assert.deepEqual(switchedPayload.experiment.slice(0, 2), [
    "meta-direct-links-v1", "paid",
  ]);
});

test("the fixed Meta paid link fails closed instead of contaminating the control", async () => {
  const response = await middleware.routeMetaAdLinkForTest(
    request("/meta-paid", { userAgent: DESKTOP_UA }),
    { nowMs: NOW_MS, nonceBytes: PAID_NONCE, secret: "short" },
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("location"), null);
  assert.match(await response.text(), /temporarily unavailable/);
});

test("only exact GET /mc can reach assignment", async () => {
  for (const path of [
    "/",
    "/m",
    "/mc/",
    "/mc-preview/",
    "/MC",
    "/m%63",
    "/api/download",
  ]) {
    const response = await deterministicRoute(request(path));
    assert.equal(response.headers.get("x-test-next"), "1", path);
    assert.equal(response.headers.has("set-cookie"), false, path);
  }

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await deterministicRoute(request("/mc", { method }));
    assert.equal(response.headers.get("x-test-next"), "1", method);
    assert.equal(response.headers.has("set-cookie"), false, method);
  }

  const head = await deterministicRoute(request("/mc", { method: "HEAD" }), {
    nonceBytes: PAID_NONCE,
  });
  assert.equal(head.status, 307);
  assert.equal(
    head.headers.get("location"),
    "https://sidestream.tv/?utm_source=manychat",
  );
  assert.equal(head.headers.has("set-cookie"), false);
});

test("the unlinked review route deterministically renders the paid landing on desktop", async () => {
  const review = await deterministicRoute(
    request("/mc-preview", { userAgent: DESKTOP_UA }),
    { nonceBytes: CONTROL_NONCE },
  );
  assert.equal(review.status, 200);
  assert.equal(
    review.headers.get("x-test-rewrite"),
    "https://sidestream.tv/mobile-paid-prototype.html",
  );
  assert.equal(
    review.headers.get(
      "x-rewrite-x-sidestream-paid-acquisition-attribution",
    ),
    "utm_source=manychat",
  );
  assert.match(review.headers.get("set-cookie"), new RegExp(`^${COOKIE_NAME}=`));

  const control = await deterministicRoute(request(), {
    nonceBytes: CONTROL_NONCE,
  });
  const reviewedAgain = await deterministicRoute(
    request("/mc-preview", {
      userAgent: DESKTOP_UA,
      cookie: cookiePair(control),
    }),
    { nonceBytes: CONTROL_NONCE },
  );
  assert.equal(reviewedAgain.status, 200);
  assert.match(
    reviewedAgain.headers.get("x-test-rewrite"),
    /mobile-paid-prototype/,
  );
  assert.ok(reviewedAgain.headers.has("set-cookie"));
});

test("mobile eligibility is conservative across navigation, bots, tablets, and hints", async () => {
  const ineligible = [
    { label: "missing destination", fetchDest: null },
    { label: "non-document destination", fetchDest: "empty" },
    { label: "missing UA", userAgent: null },
    { label: "desktop", userAgent: DESKTOP_UA },
    {
      label: "bot phone signature",
      userAgent: `${IPHONE_UA} Googlebot`,
    },
    {
      label: "scanner preview signature",
      userAgent: `${IPHONE_UA} facebookexternalhit`,
    },
    {
      label: "iPad",
      userAgent:
        "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    },
    {
      label: "Android tablet",
      userAgent:
        "Mozilla/5.0 (Linux; Android 15; Pixel Tablet) AppleWebKit/537.36 Chrome/138 Safari/537.36",
    },
    {
      label: "conflicting mobile hint",
      headers: { "sec-ch-ua-mobile": "?0" },
    },
    {
      label: "malformed mobile hint",
      headers: { "sec-ch-ua-mobile": "1" },
    },
    {
      label: "prefetch",
      headers: { purpose: "prefetch" },
    },
    {
      label: "prerender",
      headers: { "sec-purpose": "prefetch;prerender" },
    },
    {
      label: "mozilla prefetch",
      headers: { "x-moz": "prefetch" },
    },
  ];

  for (const scenario of ineligible) {
    const response = await deterministicRoute(request("/mc", scenario), {
      nonceBytes: PAID_NONCE,
    });
    assert.equal(response.status, 307, scenario.label);
    assert.equal(response.headers.has("set-cookie"), false, scenario.label);
    assert.equal(
      response.headers.get("location"),
      "https://sidestream.tv/?utm_source=manychat",
      scenario.label,
    );
  }

  for (const eligible of [
    request(),
    request("/mc", { userAgent: ANDROID_PHONE_UA }),
    request("/mc", { headers: { "sec-ch-ua-mobile": "?1" } }),
  ]) {
    const response = await deterministicRoute(eligible, {
      nonceBytes: PAID_NONCE,
    });
    assert.match(response.headers.get("x-test-rewrite"), /mobile-paid-prototype/);
    assert.ok(response.headers.has("set-cookie"));
  }
});

test("missing or short assignment secrets fail closed without assigning", async () => {
  for (const secret of [undefined, "", "short-secret"]) {
    const response = await deterministicRoute(request(), {
      secret,
      nonceBytes: PAID_NONCE,
    });
    assert.equal(response.status, 307);
    assert.equal(response.headers.has("set-cookie"), false);
    assert.equal(
      response.headers.get("location"),
      "https://sidestream.tv/?utm_source=manychat",
    );
  }
});

test("first eligible requests use the exact 50/50 bucket partition and secure cookie", async () => {
  assert.equal(middleware.cohortForBucket(0), "mc-control-v1");
  assert.equal(middleware.cohortForBucket(4_999), "mc-control-v1");
  assert.equal(middleware.cohortForBucket(5_000), "mc-paid-v1");
  assert.equal(middleware.cohortForBucket(9_999), "mc-paid-v1");
  assert.throws(() => middleware.cohortForBucket(10_000), RangeError);
  assert.ok(bucketForNonce(CONTROL_NONCE) < 5_000);
  assert.ok(bucketForNonce(PAID_NONCE) >= 5_000);

  const control = await deterministicRoute(request(), {
    nonceBytes: CONTROL_NONCE,
  });
  assert.equal(control.status, 307);
  assert.equal(
    control.headers.get("location"),
    "https://sidestream.tv/?utm_source=manychat",
  );

  const paid = await deterministicRoute(request(), { nonceBytes: PAID_NONCE });
  assert.equal(paid.status, 200);
  assert.equal(
    paid.headers.get("x-test-rewrite"),
    "https://sidestream.tv/mobile-paid-prototype.html",
  );
  assert.equal(paid.headers.has("location"), false);

  for (const response of [control, paid]) {
    const setCookie = response.headers.get("set-cookie");
    assert.match(setCookie, new RegExp(`^${COOKIE_NAME}=`));
    assert.match(setCookie, /; Max-Age=2592000/);
    assert.match(setCookie, /; Path=\//);
    assert.match(setCookie, /; Secure/);
    assert.match(setCookie, /; HttpOnly/);
    assert.match(setCookie, /; SameSite=Lax/);
    assert.doesNotMatch(setCookie, /Domain=/i);
    assert.ok(cookieValue(response).length <= 192);
    assert.doesNotMatch(
      setCookie,
      /(?:@|stripe|google|activation|user-agent|utm_|manychat)/i,
    );
  }
});

test("valid assignments are sticky and invalid values are safely replaced", async () => {
  const firstPaid = await deterministicRoute(request(), {
    nonceBytes: PAID_NONCE,
  });
  const paidCookie = cookiePair(firstPaid);
  assert.ok(paidCookie);

  const firstControl = await deterministicRoute(request(), {
    nonceBytes: CONTROL_NONCE,
  });
  const stickyControl = await deterministicRoute(
    request("/mc", { cookie: cookiePair(firstControl) }),
    { nonceBytes: PAID_NONCE },
  );
  assert.equal(stickyControl.status, 307);
  assert.equal(stickyControl.headers.has("set-cookie"), false);

  const sticky = await deterministicRoute(
    request("/mc?utm_campaign=returning", { cookie: paidCookie }),
    { nonceBytes: CONTROL_NONCE },
  );
  assert.equal(
    sticky.headers.get(
      "x-rewrite-x-sidestream-paid-acquisition-attribution",
    ),
    "utm_source=manychat&utm_campaign=returning",
  );
  assert.equal(sticky.headers.has("set-cookie"), false);

  const tamperedValue = cookieValue(firstPaid).replace(
    "mc-paid-v1",
    "mc-control-v1",
  );
  const replaced = await deterministicRoute(
    request("/mc", { cookie: `${COOKIE_NAME}=${tamperedValue}` }),
    { nonceBytes: CONTROL_NONCE },
  );
  assert.equal(replaced.status, 307);
  assert.ok(replaced.headers.has("set-cookie"));
  assert.notEqual(cookieValue(replaced), tamperedValue);

  const expired = await deterministicRoute(
    request("/mc", { cookie: paidCookie }),
    {
      nowMs: NOW_MS + 2_592_001_000,
      nonceBytes: CONTROL_NONCE,
    },
  );
  assert.equal(expired.status, 307);
  assert.ok(expired.headers.has("set-cookie"));

  const duplicate = await deterministicRoute(
    request("/mc", { cookie: `${paidCookie}; ${paidCookie}` }),
    { nonceBytes: CONTROL_NONCE },
  );
  assert.equal(duplicate.status, 307);
  assert.ok(duplicate.headers.has("set-cookie"));
});

test("eligibility is re-evaluated even when the visitor carries a paid cookie", async () => {
  const paid = await deterministicRoute(request(), { nonceBytes: PAID_NONCE });
  const response = await deterministicRoute(
    request("/mc", {
      userAgent: DESKTOP_UA,
      cookie: cookiePair(paid),
    }),
    { nonceBytes: PAID_NONCE },
  );
  assert.equal(response.status, 307);
  assert.equal(
    response.headers.get("location"),
    "https://sidestream.tv/?utm_source=manychat",
  );
  assert.equal(response.headers.has("set-cookie"), false);
  assert.equal(response.headers.has("x-test-rewrite"), false);
});

test("bounded attribution is normalized identically for both cohorts", async () => {
  const query =
    "?utm_source=attacker&utm_medium=dm&utm_campaign=Launch_1&utm_content=A.B-2&utm_id=abc_123&utm_term=identity&email=person%40example.com";
  const expected =
    "utm_source=manychat&utm_medium=dm&utm_campaign=Launch_1&utm_content=A.B-2&utm_id=abc_123";

  const control = await deterministicRoute(request(`/mc${query}`), {
    nonceBytes: CONTROL_NONCE,
  });
  assert.equal(
    control.headers.get("location"),
    `https://sidestream.tv/?${expected}`,
  );

  const paid = await deterministicRoute(request(`/mc${query}`), {
    nonceBytes: PAID_NONCE,
  });
  assert.equal(
    paid.headers.get("x-test-rewrite"),
    "https://sidestream.tv/mobile-paid-prototype.html",
  );
  assert.equal(
    paid.headers.get(
      "x-rewrite-x-sidestream-paid-acquisition-attribution",
    ),
    expected,
  );

  const ineligible = await deterministicRoute(
    request(`/mc${query}`, { userAgent: DESKTOP_UA }),
    { nonceBytes: PAID_NONCE },
  );
  assert.equal(
    ineligible.headers.get("location"),
    `https://sidestream.tv/?${expected}`,
  );
});

test("repeated, empty, malformed, unsafe, and over-length attribution is dropped", async () => {
  const overLength = `A${"b".repeat(64)}`;
  const response = await deterministicRoute(
    request(
      `/mc?utm_medium=DM&utm_medium=dm&utm_campaign=%ZZ&utm_content=${overLength}&utm_id=abc%20def&utm_source=anything&redirect=https%3A%2F%2Fevil.example`,
    ),
    { nonceBytes: CONTROL_NONCE },
  );
  assert.equal(
    response.headers.get("location"),
    "https://sidestream.tv/?utm_source=manychat",
  );

  const encoded = await deterministicRoute(
    request("/mc?utm%5fmedium=social&utm_campaign=A%2eB&utm_content=plus+space"),
    { nonceBytes: CONTROL_NONCE },
  );
  assert.equal(
    encoded.headers.get("location"),
    "https://sidestream.tv/?utm_source=manychat&utm_medium=social&utm_campaign=A.B",
  );
});

// @ts-nocheck -- Vercel compiles this self-contained Edge middleware outside
// the repo's Node/Vite tsconfig; deterministic routing tests own its contract.
import { next, rewrite } from "@vercel/functions";

const EXPERIMENT_ID = "mc-mobile-paid-v1";
const CONTROL_COHORT = "mc-control-v1";
const PAID_COHORT = "mc-paid-v1";
const ASSIGNMENT_SECRET_NAME =
  "SIDESTREAM_PAID_ACQUISITION_ASSIGNMENT_SECRET";
const COOKIE_NAME = "__Host-sidestream-mc-mobile-paid-v1";
const COOKIE_VERSION = "1";
const COOKIE_MAX_AGE_SECONDS = 2_592_000;
const REVIEW_PATH = "/mc-preview";
const META_DEFAULT_PATH = "/meta-default";
const META_PAID_PATH = "/meta-paid";
const META_EXPERIMENT_ID = "meta-direct-links-v1";
const META_CAMPAIGN = "sidestream_direct_offer_test";
const PAID_LANDING_PATH = "/api/paid-acquisition/landing";
const TEST_PAID_LANDING_PATH = "/mobile-paid-prototype.html";
const CONTROL_DESTINATION = "https://sidestream.tv/";
const ASSIGNMENT_SIGNATURE_CONTEXT =
  "sidestream-paid-acquisition-assignment-cookie-v1";
const LANDING_PROOF_CONTEXT = "sidestream-paid-acquisition-landing-proof-v1";
const INTERNAL_ASSIGNMENT_HEADER =
  "x-sidestream-paid-acquisition-assignment";
const INTERNAL_PROOF_HEADER = "x-sidestream-paid-acquisition-proof";
const INTERNAL_ATTRIBUTION_HEADER =
  "x-sidestream-paid-acquisition-attribution";
const ACQUISITION_COOKIE_NAME = "__Host-sidestream-acquisition-v2";
const LEGACY_ACQUISITION_COOKIE_NAME = "__Host-sidestream-acquisition-v1";
const ACQUISITION_SECRET_NAME = "SIDESTREAM_ANONYMOUS_ACQUISITION_SECRET";
const ACQUISITION_COOKIE_VERSION = 2;
const ACQUISITION_COOKIE_MAX_AGE_SECONDS = 2_592_000;
const ACQUISITION_SIGNATURE_CONTEXT =
  "sidestream-anonymous-acquisition-cookie-v2";
const LEGACY_ACQUISITION_SIGNATURE_CONTEXT =
  "sidestream-anonymous-acquisition-cookie-v1";
const LEGACY_ACQUISITION_PROMOTION_CONTEXT =
  "sidestream-anonymous-acquisition-v1-promotion-v2";
const BOT_SIGNATURES = [
  "bot",
  "crawler",
  "spider",
  "slurp",
  "headless",
  "lighthouse",
  "preview",
  "facebookexternalhit",
  "facebot",
  "whatsapp",
  "telegrambot",
  "discordbot",
  "googleinspectiontool",
  "curl",
];
const TABLET_SIGNATURES = [
  "ipad",
  "tablet",
  "kindle",
  "silk",
  "playbook",
];
const OPTIONAL_ATTRIBUTION_FIELDS = [
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_id",
];
const SAFE_CAMPAIGN_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BASE64URL_VALUE = /^[A-Za-z0-9_-]+$/;
export const DATABASE_CUTOVER_MODE = "target";
const DATABASE_CUTOVER_MODES = new Set(["source", "fenced", "target"]);
const HETZNER_ORIGIN_URL_NAME = "SIDESTREAM_HETZNER_ORIGIN_URL";
const HETZNER_ORIGIN_AUTH_SECRET_NAME = "SIDESTREAM_ORIGIN_AUTH_SECRET";
const ORIGIN_AUTH_HEADER = "x-sidestream-origin-auth";
const ORIGINAL_HOST_HEADER = "x-sidestream-original-host";
const ORIGINAL_IF_NONE_MATCH_HEADER = "x-sidestream-origin-if-none-match";
const encoder = new TextEncoder();
const acquisitionExperiments = new WeakMap();

export const config = {
  matcher: [
    "/",
    "/index.html",
    "/mc",
    "/mc-preview",
    "/meta-default",
    "/meta-paid",
    "/api/:path*",
  ],
};

export default async function paidAcquisitionMiddleware(request) {
  const runtime = productionRuntime();
  if (new URL(request.url).pathname.startsWith("/api/")) {
    return routeDatabaseApiRequest(request, runtime);
  }
  return routeBrowserRequest(request, runtime);
}

export function databaseApiDecision(mode = DATABASE_CUTOVER_MODE) {
  return DATABASE_CUTOVER_MODES.has(mode) ? mode : "fenced";
}

export function routeDatabaseApiForTest(request, overrides = {}) {
  return routeDatabaseApiRequest(request, {
    ...productionRuntime(),
    ...overrides,
  });
}

function routeDatabaseApiRequest(request, runtime) {
  const mode = databaseApiDecision(runtime.databaseCutoverMode);
  if (mode === "fenced") return databaseWriteFenceResponse();

  const headers = new Headers(request.headers);
  const originalIfNoneMatch = boundedIfNoneMatch(headers.get("if-none-match"));
  headers.delete(ORIGIN_AUTH_HEADER);
  headers.delete(ORIGINAL_HOST_HEADER);
  headers.delete(ORIGINAL_IF_NONE_MATCH_HEADER);
  if (mode === "source") {
    return next({ request: { headers } });
  }

  const origin = validHetznerOrigin(runtime.hetznerOriginUrl);
  const secret = validOriginAuthSecret(runtime.originAuthSecret);
  if (!origin || !secret) return databaseWriteFenceResponse();

  const requestUrl = new URL(request.url);
  const destination = new URL(origin);
  destination.pathname = `${origin.pathname.replace(/\/$/, "")}${requestUrl.pathname}`;
  destination.search = requestUrl.search;
  headers.delete("host");
  headers.set(ORIGIN_AUTH_HEADER, secret);
  headers.set(ORIGINAL_HOST_HEADER, requestUrl.host);
  if (originalIfNoneMatch) {
    headers.set(ORIGINAL_IF_NONE_MATCH_HEADER, originalIfNoneMatch);
  }
  headers.set("x-forwarded-host", requestUrl.host);
  headers.set("x-forwarded-proto", requestUrl.protocol.replace(":", ""));
  return rewrite(destination, { request: { headers } });
}

function boundedIfNoneMatch(value) {
  const etag = String(value || "").trim();
  return etag && etag.length <= 256 && /^[\x20-\x7e]+$/.test(etag) ? etag : "";
}

function databaseWriteFenceResponse() {
  return new Response(JSON.stringify({
    error: "Sidestream is briefly unavailable while its database is moved.",
    code: "database_cutover_in_progress",
  }), {
    status: 503,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": "60",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function validHetznerOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return null;
    }
    url.pathname = url.pathname.replace(/\/+$/, "") + "/";
    return url;
  } catch {
    return null;
  }
}

function validOriginAuthSecret(value) {
  const secret = String(value || "");
  return secret.length >= 32 && secret.length <= 512 && /^[\x21-\x7e]+$/.test(secret)
    ? secret
    : "";
}

// This seam is called directly by the local routing tests. No request header,
// cookie, query parameter, or Production environment variable can select it.
export function routePaidExperimentForTest(request, overrides) {
  const nonceBytes = new Uint8Array(overrides.nonceBytes);
  return routePaidExperiment(request, {
    now: () => overrides.nowMs,
    randomBytes: (length) => {
      if (length !== nonceBytes.length) {
        throw new Error("Unexpected deterministic nonce length");
      }
      return new Uint8Array(nonceBytes);
    },
    secret: overrides.secret,
    paidLandingPath: TEST_PAID_LANDING_PATH,
  });
}

export function routeMetaAdLinkForTest(request, overrides) {
  return routeMetaAdLink(request, {
    now: () => overrides.nowMs,
    randomBytes: () => new Uint8Array(overrides.nonceBytes),
    secret: overrides.secret,
    paidLandingPath: TEST_PAID_LANDING_PATH,
  });
}

export function routeBrowserAcquisitionForTest(request, overrides) {
  return routeBrowserRequest(request, {
    now: () => overrides.nowMs,
    randomBytes: (length) => new Uint8Array(
      length === 32 ? overrides.tokenBytes : overrides.nonceBytes || 16,
    ),
    secret: overrides.paidSecret,
    acquisitionSecret: overrides.acquisitionSecret,
    paidLandingPath: TEST_PAID_LANDING_PATH,
    acquisitionExperiment: overrides.experiment || null,
  });
}

export function cohortForBucket(bucket) {
  if (!Number.isInteger(bucket) || bucket < 0 || bucket > 9_999) {
    throw new RangeError("Assignment bucket must be an integer from 0 to 9999");
  }
  return bucket < 5_000 ? CONTROL_COHORT : PAID_COHORT;
}

async function routePaidExperiment(request, runtime) {
  const url = new URL(request.url);
  const isReview = url.pathname === REVIEW_PATH;
  if (url.pathname !== "/mc" && !isReview) return next();

  if (request.method !== "GET" && request.method !== "HEAD") {
    return next();
  }

  const attribution = normalizeAttribution(url.search);
  const fallback = () => controlRedirect(attribution);
  if (
    request.method === "HEAD" ||
    (!isReview && !isEligibleMobileBrowser(request))
  ) {
    return fallback();
  }

  const secretBytes = validSecretBytes(runtime.secret);
  if (!secretBytes) return fallback();

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    const nowSeconds = Math.floor(runtime.now() / 1_000);
    const suppliedCookie = readSingleCookie(
      request.headers.get("cookie"),
      COOKIE_NAME,
    );
    const existing = suppliedCookie
      ? await verifyAssignmentCookie(suppliedCookie, key, nowSeconds)
      : null;

    if (existing && (!isReview || existing.cohort === PAID_COHORT)) {
      return cohortResponse(existing.cohort, attribution, undefined, {
        ...runtime,
        key,
        assignmentCookieValue: suppliedCookie,
        experimentIssuedAtSeconds: existing.issuedAtSeconds,
      });
    }

    const nonceBytes = runtime.randomBytes(16);
    if (!(nonceBytes instanceof Uint8Array) || nonceBytes.length !== 16) {
      return fallback();
    }
    const nonce = bytesToBase64Url(nonceBytes);
    const cohort = isReview
      ? PAID_COHORT
      : await assignCohort(key, nonce);
    const cookie = await createAssignmentCookie(
      key,
      nonce,
      cohort,
      nowSeconds,
    );
    return cohortResponse(cohort, attribution, cookie, {
      ...runtime,
      key,
      experimentIssuedAtSeconds: nowSeconds,
      assignmentCookieValue: cookie
        .split(";", 1)[0]
        .slice(`${COOKIE_NAME}=`.length),
    });
  } catch {
    return fallback();
  }
}

async function routeMetaAdLink(request, runtime) {
  const url = new URL(request.url);
  const variant = url.pathname === META_DEFAULT_PATH
    ? "default"
    : url.pathname === META_PAID_PATH
      ? "paid"
      : null;
  if (!variant) return next();
  if (request.method !== "GET" && request.method !== "HEAD") return next();

  const attribution = metaAttribution(variant, url.search);
  const nowSeconds = Math.floor(runtime.now() / 1_000);
  if (variant === "default") {
    const response = controlRedirect(attribution);
    rememberAcquisitionExperiment(
      response,
      CONTROL_COHORT,
      nowSeconds,
      META_EXPERIMENT_ID,
    );
    return response;
  }
  if (request.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  }

  const secretBytes = validSecretBytes(runtime.secret);
  if (!secretBytes) return paidLinkUnavailable();
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    const suppliedCookie = readSingleCookie(
      request.headers.get("cookie"),
      COOKIE_NAME,
    );
    const existing = suppliedCookie
      ? await verifyAssignmentCookie(suppliedCookie, key, nowSeconds)
      : null;
    let assignmentCookieValue = suppliedCookie;
    let setCookie;
    let issuedAtSeconds = existing?.issuedAtSeconds ?? nowSeconds;
    if (!existing || existing.cohort !== PAID_COHORT) {
      const nonceBytes = runtime.randomBytes(16);
      if (!(nonceBytes instanceof Uint8Array) || nonceBytes.length !== 16) {
        return paidLinkUnavailable();
      }
      assignmentCookieValue = await createAssignmentCookie(
        key,
        bytesToBase64Url(nonceBytes),
        PAID_COHORT,
        nowSeconds,
      );
      setCookie = assignmentCookieValue;
      issuedAtSeconds = nowSeconds;
      assignmentCookieValue = assignmentCookieValue
        .split(";", 1)[0]
        .slice(`${COOKIE_NAME}=`.length);
    }
    return cohortResponse(PAID_COHORT, attribution, setCookie, {
      ...runtime,
      key,
      assignmentCookieValue,
      experimentIssuedAtSeconds: issuedAtSeconds,
      browserExperimentId: META_EXPERIMENT_ID,
    });
  } catch {
    return paidLinkUnavailable();
  }
}

async function routeBrowserRequest(request, runtime) {
  const url = new URL(request.url);
  const isMetaLink = url.pathname === META_DEFAULT_PATH ||
    url.pathname === META_PAID_PATH;
  const paidResponse = isMetaLink
    ? await routeMetaAdLink(request, runtime)
    : url.pathname === "/mc" || url.pathname === REVIEW_PATH
      ? await routePaidExperiment(request, runtime)
      : next();
  const experiment = acquisitionExperiments.get(paidResponse) ||
    runtime.acquisitionExperiment || null;
  const metaVariant = url.pathname === META_PAID_PATH ? "paid" : "default";
  return attachBrowserAcquisition(
    request,
    paidResponse,
    runtime,
    experiment,
    isMetaLink ? metaBrowserAttribution(metaVariant, url.search) : null,
    isMetaLink,
  );
}

function productionRuntime() {
  return {
    now: () => Date.now(),
    randomBytes: (length) => {
      const bytes = new Uint8Array(length);
      crypto.getRandomValues(bytes);
      return bytes;
    },
    secret: process.env[ASSIGNMENT_SECRET_NAME],
    acquisitionSecret: process.env[ACQUISITION_SECRET_NAME],
    paidLandingPath: PAID_LANDING_PATH,
    databaseCutoverMode: DATABASE_CUTOVER_MODE,
    hetznerOriginUrl: process.env[HETZNER_ORIGIN_URL_NAME],
    originAuthSecret: process.env[HETZNER_ORIGIN_AUTH_SECRET_NAME],
  };
}

function isEligibleMobileBrowser(request) {
  if (request.headers.get("sec-fetch-dest")?.trim().toLowerCase() !== "document") {
    return false;
  }
  for (const name of ["purpose", "sec-purpose", "x-moz"]) {
    const value = request.headers.get(name)?.toLowerCase() ?? "";
    if (value.includes("prefetch") || value.includes("prerender")) return false;
  }

  const userAgent = request.headers.get("user-agent")?.trim().toLowerCase() ?? "";
  if (!userAgent) return false;
  if (BOT_SIGNATURES.some((signature) => userAgent.includes(signature))) {
    return false;
  }
  if (
    TABLET_SIGNATURES.some((signature) => userAgent.includes(signature)) ||
    (userAgent.includes("android") && !userAgent.includes("mobile"))
  ) {
    return false;
  }

  const isPhone =
    userAgent.includes("iphone") ||
    userAgent.includes("ipod") ||
    userAgent.includes("windows phone") ||
    (userAgent.includes("android") && userAgent.includes("mobile"));
  if (!isPhone) return false;

  const mobileHint = request.headers.get("sec-ch-ua-mobile");
  return mobileHint === null || mobileHint.trim() === "?1";
}

function normalizeAttribution(rawSearch) {
  const values = new Map(
    OPTIONAL_ATTRIBUTION_FIELDS.map((field) => [field, []]),
  );
  const rawQuery = rawSearch.startsWith("?") ? rawSearch.slice(1) : rawSearch;

  for (const pair of rawQuery.split("&")) {
    if (!pair) continue;
    const separator = pair.indexOf("=");
    const rawName = separator === -1 ? pair : pair.slice(0, separator);
    const rawValue = separator === -1 ? "" : pair.slice(separator + 1);
    const name = strictQueryDecode(rawName);
    if (!name || !values.has(name)) continue;
    values.get(name).push(strictQueryDecode(rawValue));
  }

  const attribution = [["utm_source", "manychat"]];
  for (const field of OPTIONAL_ATTRIBUTION_FIELDS) {
    const candidates = values.get(field);
    if (candidates.length !== 1) continue;
    const value = candidates[0];
    if (!isValidAttributionValue(field, value)) continue;
    attribution.push([field, value]);
  }
  return attribution;
}

function metaCreativeKey(variant, rawSearch) {
  const content = normalizeAttribution(rawSearch)
    .find(([name]) => name === "utm_content")?.[1];
  return content || variant;
}

function metaAttribution(variant, rawSearch = "") {
  return [
    ["utm_source", "meta"],
    ["utm_medium", "social"],
    ["utm_campaign", META_CAMPAIGN],
    ["utm_content", metaCreativeKey(variant, rawSearch)],
  ];
}

function metaBrowserAttribution(variant, rawSearch = "") {
  return {
    source: "meta",
    medium: "social",
    campaign: META_CAMPAIGN,
    content: metaCreativeKey(variant, rawSearch),
  };
}

function strictQueryDecode(value) {
  if (!/^(?:[^%]|%[0-9A-Fa-f]{2})*$/.test(value)) return null;
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

function isValidAttributionValue(field, value) {
  if (!value) return false;
  if (field === "utm_medium") return value === "dm" || value === "social";
  return value.length <= 64 && SAFE_CAMPAIGN_VALUE.test(value);
}

function attributionUrl(base, attribution) {
  const url = new URL(base);
  url.search = "";
  for (const [name, value] of attribution) {
    url.searchParams.append(name, value);
  }
  return url;
}

function controlRedirect(attribution, cookie) {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    Location: attributionUrl(CONTROL_DESTINATION, attribution).toString(),
  });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 307, headers });
}

function paidLinkUnavailable() {
  const body = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"robots\" content=\"noindex,nofollow\"><title>Sidestream</title></head><body><main><h1>Sidestream is temporarily unavailable</h1><p>Please return to the original ad and try again.</p></main></body></html>";
  return new Response(body, {
    status: 503,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "text/html; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

async function cohortResponse(cohort, attribution, cookie, runtime) {
  if (cohort === CONTROL_COHORT) {
    const response = controlRedirect(attribution, cookie);
    rememberAcquisitionExperiment(
      response,
      cohort,
      runtime.experimentIssuedAtSeconds,
      runtime.browserExperimentId,
    );
    return response;
  }

  const destination = new URL(runtime.paidLandingPath, CONTROL_DESTINATION);
  const attributionQuery = new URLSearchParams(attribution).toString();
  const proof = bytesToBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        runtime.key,
        encoder.encode(
          `${LANDING_PROOF_CONTEXT}:${runtime.assignmentCookieValue}:${attributionQuery}`,
        ),
      ),
    ),
  );
  const requestHeaders = new Headers();
  requestHeaders.set(
    INTERNAL_ASSIGNMENT_HEADER,
    runtime.assignmentCookieValue,
  );
  requestHeaders.set(INTERNAL_ATTRIBUTION_HEADER, attributionQuery);
  requestHeaders.set(INTERNAL_PROOF_HEADER, proof);
  const response = rewrite(destination, {
    request: { headers: requestHeaders },
  });
  response.headers.set("Cache-Control", "private, no-store");
  if (cookie) response.headers.append("Set-Cookie", cookie);
  rememberAcquisitionExperiment(
    response,
    cohort,
    runtime.experimentIssuedAtSeconds,
    runtime.browserExperimentId,
  );
  return response;
}

function rememberAcquisitionExperiment(
  response,
  cohort,
  issuedAtSeconds,
  experimentId = EXPERIMENT_ID,
) {
  if (!Number.isSafeInteger(issuedAtSeconds)) return;
  acquisitionExperiments.set(response, {
    experimentId,
    cohort: cohort === PAID_COHORT ? "paid" : "freemium",
    issuedAt: issuedAtSeconds,
    expiresAt: issuedAtSeconds + COOKIE_MAX_AGE_SECONDS,
  });
}

async function attachBrowserAcquisition(
  request,
  response,
  runtime,
  experiment,
  attributionOverride = null,
  replaceExistingExperiment = false,
) {
  if (request.method !== "GET" || isSpeculativeRequest(request)) return response;
  const secretBytes = validSecretBytes(runtime.acquisitionSecret);
  if (!secretBytes) return response;
  try {
    const nowSeconds = Math.floor(runtime.now() / 1_000);
    const key = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    const existing = readSingleCookie(
      request.headers.get("cookie"),
      ACQUISITION_COOKIE_NAME,
    );
    const verifiedExisting = existing
      ? await readVerifiedAcquisitionCookie(existing, key, nowSeconds)
      : null;
    if (verifiedExisting) {
      const expectedExperiment = normalizeBrowserExperiment(
        experiment,
        nowSeconds,
      );
      const sameForcedExperiment = replaceExistingExperiment &&
        expectedExperiment &&
        Array.isArray(verifiedExisting.experiment) &&
        verifiedExisting.experiment[0] === expectedExperiment.experimentId &&
        verifiedExisting.experiment[1] === expectedExperiment.cohort;
      if (!replaceExistingExperiment || sameForcedExperiment) return response;
    }
    const legacy = existing || replaceExistingExperiment ? null : readSingleCookie(
      request.headers.get("cookie"),
      LEGACY_ACQUISITION_COOKIE_NAME,
    );
    if (legacy) {
      const promoted = await promoteLegacyAcquisitionCookie(
        legacy,
        key,
        nowSeconds,
      );
      if (promoted) {
        response.headers.append("Set-Cookie", promoted);
        return response;
      }
    }
    const tokenBytes = runtime.randomBytes(32);
    if (!(tokenBytes instanceof Uint8Array) || tokenBytes.length !== 32) {
      return response;
    }
    const issued = await createAcquisitionCookie(
      key,
      uuidFromBytes(tokenBytes.slice(0, 16)),
      attributionOverride ||
        normalizeBrowserAttribution(new URL(request.url).searchParams),
      attributionOverride
        ? "social"
        : normalizeReferrerCategory(request.headers.get("referer")),
      normalizeBrowserExperiment(experiment, nowSeconds),
      nowSeconds,
    );
    response.headers.append("Set-Cookie", issued);
  } catch {
    // Acquisition is intentionally best-effort and can never block the page.
  }
  return response;
}

function isSpeculativeRequest(request) {
  for (const name of ["purpose", "sec-purpose", "x-moz"]) {
    const value = request.headers.get(name)?.toLowerCase() || "";
    if (value.includes("prefetch") || value.includes("prerender")) return true;
  }
  return false;
}

function normalizeBrowserAttribution(searchParams) {
  try {
    const values = {};
    for (const key of ["source", "medium", "campaign", "content"]) {
      const candidates = searchParams.getAll(`utm_${key}`);
      if (candidates.length > 1) throw new Error("duplicate attribution");
      values[key] = candidates.length === 1 ? candidates[0] : null;
    }
    const source = values.source
      ? normalizeBrowserLower(values.source)
      : "direct";
    const medium = values.medium ? normalizeBrowserLower(values.medium) : null;
    const campaign = values.campaign ? normalizeBrowserMixed(values.campaign) : null;
    const content = values.content ? normalizeBrowserMixed(values.content) : null;
    return { source, medium, campaign, content };
  } catch {
    return { source: "direct", medium: null, campaign: null, content: null };
  }
}

function normalizeBrowserLower(value) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
    throw new Error("invalid attribution");
  }
  return normalized;
}

function normalizeBrowserMixed(value) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)) {
    throw new Error("invalid attribution");
  }
  return normalized;
}

function normalizeBrowserExperiment(value, nowSeconds) {
  if (!value) return null;
  if (
    typeof value.experimentId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value.experimentId) ||
    !["paid", "freemium"].includes(value.cohort) ||
    !Number.isSafeInteger(value.issuedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.issuedAt > nowSeconds ||
    value.expiresAt <= nowSeconds ||
    value.expiresAt > nowSeconds + ACQUISITION_COOKIE_MAX_AGE_SECONDS
  ) {
    return null;
  }
  return value;
}

async function createAcquisitionCookie(
  key,
  acquisitionId,
  attribution,
  externalReferrerCategory,
  experiment,
  issuedAt,
  suppliedExpiresAt,
) {
  const expiresAt = suppliedExpiresAt || issuedAt + ACQUISITION_COOKIE_MAX_AGE_SECONDS;
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({
    v: ACQUISITION_COOKIE_VERSION,
    acquisitionId,
    firstTouch: [
      attribution.source,
      attribution.medium,
      attribution.campaign,
      attribution.content,
      externalReferrerCategory,
    ],
    experiment: experiment
      ? [experiment.experimentId, experiment.cohort, experiment.issuedAt, experiment.expiresAt]
      : null,
    issuedAt,
    expiresAt,
  })));
  const signature = bytesToBase64Url(new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${ACQUISITION_SIGNATURE_CONTEXT}:${payload}`),
    ),
  ));
  return [
    `${ACQUISITION_COOKIE_NAME}=${payload}.${signature}`,
    `Max-Age=${ACQUISITION_COOKIE_MAX_AGE_SECONDS}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ");
}

async function readVerifiedAcquisitionCookie(value, key, nowSeconds) {
  const decoded = await verifyAcquisitionCookieEnvelope(
    value,
    key,
    ACQUISITION_SIGNATURE_CONTEXT,
  );
  if (!decoded) return null;
  const keys = Object.keys(decoded).sort().join(",");
  const valid = keys === "acquisitionId,experiment,expiresAt,firstTouch,issuedAt,v" &&
    decoded.v === ACQUISITION_COOKIE_VERSION &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(decoded.acquisitionId || "") &&
    Number.isSafeInteger(decoded.issuedAt) && decoded.issuedAt <= nowSeconds &&
    Number.isSafeInteger(decoded.expiresAt) && decoded.expiresAt > nowSeconds &&
    decoded.expiresAt - decoded.issuedAt === ACQUISITION_COOKIE_MAX_AGE_SECONDS &&
    Array.isArray(decoded.firstTouch) && decoded.firstTouch.length === 5 &&
    validStoredAttribution(decoded.firstTouch) &&
    validStoredExperiment(decoded.experiment, decoded.issuedAt, decoded.expiresAt);
  return valid ? decoded : null;
}

async function verifyAcquisitionCookieEnvelope(value, key, signatureContext) {
  if (value.length > 1024 || !/^[A-Za-z0-9_.-]+$/.test(value)) return false;
  const [payload, signatureValue, extra] = value.split(".");
  if (!payload || extra || !/^[A-Za-z0-9_-]{43}$/.test(signatureValue || "")) {
    return false;
  }
  const signature = base64UrlToBytes(signatureValue);
  if (signature?.length !== 32) return false;
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(`${signatureContext}:${payload}`),
  );
  if (!valid) return false;
  let decoded;
  try {
    decoded = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
  } catch {
    return false;
  }
  return decoded;
}

async function promoteLegacyAcquisitionCookie(value, key, nowSeconds) {
  const decoded = await verifyAcquisitionCookieEnvelope(
    value,
    key,
    LEGACY_ACQUISITION_SIGNATURE_CONTEXT,
  );
  if (!decoded) return null;
  const keys = Object.keys(decoded).sort().join(",");
  if (
    keys !== "attribution,expiresAt,experiment,issuedAt,token,v" ||
    decoded.v !== 1 ||
    !/^[A-Za-z0-9_-]{43}$/.test(decoded.token || "") ||
    !Number.isSafeInteger(decoded.issuedAt) || decoded.issuedAt > nowSeconds ||
    !Number.isSafeInteger(decoded.expiresAt) || decoded.expiresAt <= nowSeconds ||
    decoded.expiresAt - decoded.issuedAt !== ACQUISITION_COOKIE_MAX_AGE_SECONDS ||
    !Array.isArray(decoded.attribution) || decoded.attribution.length !== 4 ||
    !validStoredAttribution([...decoded.attribution, null]) ||
    !validStoredExperiment(decoded.experiment, decoded.issuedAt, decoded.expiresAt)
  ) {
    return null;
  }
  const digest = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${LEGACY_ACQUISITION_PROMOTION_CONTEXT}:${decoded.token}`),
  ));
  return createAcquisitionCookie(
    key,
    uuidFromBytes(digest.slice(0, 16)),
    {
      source: decoded.attribution[0],
      medium: decoded.attribution[1],
      campaign: decoded.attribution[2],
      content: decoded.attribution[3],
    },
    null,
    decoded.experiment
      ? {
          experimentId: decoded.experiment[0],
          cohort: decoded.experiment[1],
          issuedAt: decoded.experiment[2],
          expiresAt: decoded.experiment[3],
        }
      : null,
    decoded.issuedAt,
    decoded.expiresAt,
  );
}

function validStoredAttribution(firstTouch) {
  return typeof firstTouch[0] === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(firstTouch[0]) &&
    (firstTouch[1] === null || typeof firstTouch[1] === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(firstTouch[1])) &&
    (firstTouch[2] === null || typeof firstTouch[2] === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(firstTouch[2])) &&
    (firstTouch[3] === null || typeof firstTouch[3] === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(firstTouch[3])) &&
    (firstTouch[4] === null || ["search", "social", "messaging", "video", "community", "publisher", "other_external"].includes(firstTouch[4]));
}

function validStoredExperiment(value, issuedAt, expiresAt) {
  if (value === null) return true;
  return Array.isArray(value) && value.length === 4 &&
    typeof value[0] === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value[0]) &&
    ["paid", "freemium"].includes(value[1]) &&
    Number.isSafeInteger(value[2]) && Number.isSafeInteger(value[3]) &&
    value[2] <= issuedAt && value[3] > issuedAt && value[3] <= expiresAt;
}

function normalizeReferrerCategory(value) {
  if (!value || value.length > 2048) return null;
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    if (!hostname || hostname === "sidestream.tv" || hostname.endsWith(".sidestream.tv")) return null;
    if (/^(?:google|bing|search\.yahoo|duckduckgo|baidu|yandex)\./.test(hostname)) return "search";
    if (/(?:^|\.)(?:facebook|instagram|linkedin|x|twitter|threads)\.com$/.test(hostname)) return "social";
    if (/(?:^|\.)(?:manychat|messenger|whatsapp|telegram|discord|slack)\.(?:com|me|gg)$/.test(hostname)) return "messaging";
    if (/(?:^|\.)(?:youtube|youtu\.be|vimeo|tiktok)\.(?:com|be)$/.test(hostname)) return "video";
    if (/(?:^|\.)(?:reddit|quora)\.com$/.test(hostname)) return "community";
    if (/(?:^|\.)(?:medium|substack)\.com$/.test(hostname)) return "publisher";
    return "other_external";
  } catch {
    return null;
  }
}

function uuidFromBytes(input) {
  const bytes = new Uint8Array(input);
  if (bytes.length !== 16) throw new Error("invalid acquisition UUID entropy");
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validSecretBytes(secret) {
  if (typeof secret !== "string") return null;
  const bytes = encoder.encode(secret);
  return bytes.length >= 32 && bytes.length <= 512 ? bytes : null;
}

async function assignCohort(key, nonce) {
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${EXPERIMENT_ID}:${nonce}`),
    ),
  );
  let firstUnsigned64Bits = 0n;
  for (let index = 0; index < 8; index += 1) {
    firstUnsigned64Bits =
      (firstUnsigned64Bits << 8n) | BigInt(digest[index]);
  }
  return cohortForBucket(Number(firstUnsigned64Bits % 10_000n));
}

async function createAssignmentCookie(key, nonce, cohort, issuedAtSeconds) {
  const unsigned = [
    COOKIE_VERSION,
    nonce,
    cohort,
    String(issuedAtSeconds),
  ].join(".");
  const signature = bytesToBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(
          `${ASSIGNMENT_SIGNATURE_CONTEXT}:${unsigned.replaceAll(".", ":")}`,
        ),
      ),
    ),
  );
  const value = `${unsigned}.${signature}`;
  if (value.length > 192) throw new Error("Assignment cookie exceeds contract");
  return [
    `${COOKIE_NAME}=${value}`,
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ");
}

async function verifyAssignmentCookie(value, key, nowSeconds) {
  if (
    value.length > 192 ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    return null;
  }
  const parts = value.split(".");
  if (parts.length !== 5) return null;
  const [version, nonce, cohort, issuedAtValue, signatureValue] = parts;
  if (
    version !== COOKIE_VERSION ||
    ![CONTROL_COHORT, PAID_COHORT].includes(cohort) ||
    nonce.length !== 22 ||
    !BASE64URL_VALUE.test(nonce) ||
    !/^[0-9]{1,12}$/.test(issuedAtValue) ||
    signatureValue.length !== 43 ||
    !BASE64URL_VALUE.test(signatureValue)
  ) {
    return null;
  }

  const nonceBytes = base64UrlToBytes(nonce);
  const signature = base64UrlToBytes(signatureValue);
  if (nonceBytes?.length !== 16 || signature?.length !== 32) return null;

  const issuedAtSeconds = Number(issuedAtValue);
  if (
    !Number.isSafeInteger(issuedAtSeconds) ||
    issuedAtSeconds > nowSeconds ||
    nowSeconds - issuedAtSeconds > COOKIE_MAX_AGE_SECONDS
  ) {
    return null;
  }

  const unsigned = [version, nonce, cohort, issuedAtValue].join(".");
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(
      `${ASSIGNMENT_SIGNATURE_CONTEXT}:${unsigned.replaceAll(".", ":")}`,
    ),
  );
  return valid ? { cohort, issuedAtSeconds, nonce } : null;
}

function readSingleCookie(header, name) {
  if (!header) return null;
  const matches = [];
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator === -1) continue;
    if (segment.slice(0, separator).trim() !== name) continue;
    matches.push(segment.slice(separator + 1).trim());
  }
  return matches.length === 1 && matches[0] ? matches[0] : null;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  if (!BASE64URL_VALUE.test(value)) return null;
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(
      value.replaceAll("-", "+").replaceAll("_", "/") + padding,
    );
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

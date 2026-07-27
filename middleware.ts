import { next, rewrite } from "@vercel/functions";

const EXPERIMENT_ID = "mc-mobile-paid-v1";
const CONTROL_COHORT = "mc-control-v1";
const PAID_COHORT = "mc-paid-v1";
const ASSIGNMENT_SECRET_NAME =
  "SIDESTREAM_PAID_ACQUISITION_ASSIGNMENT_SECRET";
const COOKIE_NAME = "__Host-sidestream-mc-mobile-paid-v1";
const COOKIE_VERSION = "1";
const COOKIE_MAX_AGE_SECONDS = 2_592_000;
const PAID_LANDING_PATH = "/api/paid-acquisition/landing";
const TEST_PAID_LANDING_PATH = "/mobile-paid-prototype.html";
const CONTROL_DESTINATION = "https://sidestream.tv/";
const ASSIGNMENT_SIGNATURE_CONTEXT =
  "sidestream-paid-acquisition-assignment-cookie-v1";
const LANDING_PROOF_CONTEXT = "sidestream-paid-acquisition-landing-proof-v1";
const INTERNAL_ASSIGNMENT_HEADER =
  "x-sidestream-paid-acquisition-assignment";
const INTERNAL_PROOF_HEADER = "x-sidestream-paid-acquisition-proof";
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
const encoder = new TextEncoder();

export const config = {
  matcher: "/mc",
};

export default function paidAcquisitionMiddleware(request) {
  return routePaidExperiment(request, productionRuntime());
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

export function cohortForBucket(bucket) {
  if (!Number.isInteger(bucket) || bucket < 0 || bucket > 9_999) {
    throw new RangeError("Assignment bucket must be an integer from 0 to 9999");
  }
  return bucket < 5_000 ? CONTROL_COHORT : PAID_COHORT;
}

async function routePaidExperiment(request, runtime) {
  const url = new URL(request.url);
  if (url.pathname !== "/mc") return next();

  if (request.method !== "GET" && request.method !== "HEAD") {
    return next();
  }

  const attribution = normalizeAttribution(url.search);
  const fallback = () => controlRedirect(attribution);
  if (request.method === "HEAD" || !isEligibleMobileBrowser(request)) {
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

    if (existing) {
      return cohortResponse(existing.cohort, attribution, undefined, {
        ...runtime,
        key,
        assignmentCookieValue: suppliedCookie,
      });
    }

    const nonceBytes = runtime.randomBytes(16);
    if (!(nonceBytes instanceof Uint8Array) || nonceBytes.length !== 16) {
      return fallback();
    }
    const nonce = bytesToBase64Url(nonceBytes);
    const cohort = await assignCohort(key, nonce);
    const cookie = await createAssignmentCookie(
      key,
      nonce,
      cohort,
      nowSeconds,
    );
    return cohortResponse(cohort, attribution, cookie, {
      ...runtime,
      key,
      assignmentCookieValue: cookie
        .split(";", 1)[0]
        .slice(`${COOKIE_NAME}=`.length),
    });
  } catch {
    return fallback();
  }
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
    paidLandingPath: PAID_LANDING_PATH,
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

async function cohortResponse(cohort, attribution, cookie, runtime) {
  if (cohort === CONTROL_COHORT) return controlRedirect(attribution, cookie);

  const destination = attributionUrl(
    new URL(runtime.paidLandingPath, CONTROL_DESTINATION),
    attribution,
  );
  const proof = bytesToBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        runtime.key,
        encoder.encode(
          `${LANDING_PROOF_CONTEXT}:${runtime.assignmentCookieValue}:${destination.searchParams.toString()}`,
        ),
      ),
    ),
  );
  const requestHeaders = new Headers();
  requestHeaders.set(
    INTERNAL_ASSIGNMENT_HEADER,
    runtime.assignmentCookieValue,
  );
  requestHeaders.set(INTERNAL_PROOF_HEADER, proof);
  const response = rewrite(destination, {
    request: { headers: requestHeaders },
  });
  response.headers.set("Cache-Control", "private, no-store");
  if (cookie) response.headers.append("Set-Cookie", cookie);
  return response;
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

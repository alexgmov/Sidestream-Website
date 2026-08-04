import {
  createHmac,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from "node:crypto";

export const ACQUISITION_COOKIE_NAME = "__Host-sidestream-acquisition-v2";
export const LEGACY_ACQUISITION_COOKIE_NAME = "__Host-sidestream-acquisition-v1";
export const ACQUISITION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const ACQUISITION_SECRET_NAME = "SIDESTREAM_ANONYMOUS_ACQUISITION_SECRET";

const COOKIE_VERSION = 2;
const LEGACY_COOKIE_VERSION = 1;
const SIGNATURE_CONTEXT = "sidestream-anonymous-acquisition-cookie-v2";
const LEGACY_SIGNATURE_CONTEXT = "sidestream-anonymous-acquisition-cookie-v1";
const COMPATIBILITY_TOKEN_CONTEXT = "sidestream-anonymous-acquisition-compatibility-token-v2";
const LEGACY_PROMOTION_CONTEXT = "sidestream-anonymous-acquisition-v1-promotion-v2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const SAFE_LOWER_VALUE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_MIXED_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_EXPERIMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const NAMED_SOURCES = new Set([
  "direct",
  "instagram",
  "facebook",
  "linkedin",
  "reddit",
  "youtube",
  "google",
  "manychat",
  "manychat-instagram",
]);

export type ExternalReferrerCategory =
  | "search"
  | "social"
  | "messaging"
  | "video"
  | "community"
  | "publisher"
  | "other_external";

export type BrowserAcquisitionAttribution = Readonly<{
  source: string;
  medium: string | null;
  campaign: string | null;
  content: string | null;
}>;

export type BrowserAcquisitionExperiment = Readonly<{
  experimentId: string;
  cohort: "paid" | "freemium";
  issuedAt: number;
  expiresAt: number;
}>;

export type BrowserAcquisitionCookie = Readonly<{
  acquisitionId: string;
  /** Derived server-side for the legacy anonymous-claim bridge; never serialized. */
  token: string;
  attribution: BrowserAcquisitionAttribution;
  externalReferrerCategory: ExternalReferrerCategory | null;
  experiment: BrowserAcquisitionExperiment | null;
  issuedAt: number;
  expiresAt: number;
  value: string;
  promotedFromV1: boolean;
}>;

type CookieInput = Readonly<{
  acquisitionId?: string;
  attribution?: BrowserAcquisitionAttribution;
  externalReferrerCategory?: ExternalReferrerCategory | null;
  experiment?: BrowserAcquisitionExperiment | null;
}>;

type CookieOptions = Readonly<{
  secret: string;
  now?: number | Date;
  randomBytes?: (size: number) => Uint8Array;
}>;

export function normalizeBrowserAcquisitionAttribution(
  input: URLSearchParams | Readonly<Record<string, unknown>> | null | undefined,
): BrowserAcquisitionAttribution {
  try {
    const values = input instanceof URLSearchParams
      ? readUniqueSearchValues(input)
      : readObjectValues(input || {});
    const rawSource = values.source;
    const source = rawSource == null || rawSource === ""
      ? "direct"
      : normalizeLower(rawSource, SAFE_LOWER_VALUE);
    if (!NAMED_SOURCES.has(source) && !SAFE_LOWER_VALUE.test(source)) {
      throw new Error("invalid source");
    }
    const medium = optionalLower(values.medium);
    const campaign = optionalMixed(values.campaign);
    const content = optionalMixed(values.content);
    return Object.freeze({ source, medium, campaign, content });
  } catch {
    return Object.freeze({
      source: "direct",
      medium: null,
      campaign: null,
      content: null,
    });
  }
}

export function normalizeExternalReferrerCategory(
  value: unknown,
  siteHostname = "sidestream.tv",
): ExternalReferrerCategory | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) return null;
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    const ownHost = siteHostname.toLowerCase().replace(/^www\./, "");
    if (!hostname || hostname === ownHost || hostname.endsWith(`.${ownHost}`)) return null;
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

export function createBrowserAcquisitionCookie(
  input: CookieInput,
  options: CookieOptions,
): BrowserAcquisitionCookie {
  const secret = validSecret(options.secret);
  const now = epochSeconds(options.now ?? Date.now());
  const acquisitionId = input.acquisitionId
    ? validUuid(input.acquisitionId)
    : uuidFromEntropy((options.randomBytes || nodeRandomBytes)(32));
  return createV2Cookie({
    acquisitionId,
    attribution: normalizeBrowserAcquisitionAttribution(input.attribution || {}),
    externalReferrerCategory: strictReferrerCategory(input.externalReferrerCategory ?? null),
    experiment: input.experiment ?? null,
    issuedAt: now,
    expiresAt: now + ACQUISITION_COOKIE_MAX_AGE_SECONDS,
    promotedFromV1: false,
  }, secret);
}

export function verifyBrowserAcquisitionCookie(
  value: unknown,
  options: Readonly<{ secret: string; now?: number | Date }>,
): BrowserAcquisitionCookie {
  const secret = validSecret(options.secret);
  const now = epochSeconds(options.now ?? Date.now());
  const decoded = verifyEnvelope(value, secret, SIGNATURE_CONTEXT);
  if (!hasOnlyKeys(decoded, [
    "v", "acquisitionId", "firstTouch", "experiment", "issuedAt", "expiresAt",
  ])) {
    throw new Error("Anonymous acquisition cookie payload is invalid");
  }
  const issuedAt = epochSeconds(decoded.issuedAt);
  const expiresAt = epochSeconds(decoded.expiresAt);
  if (
    decoded.v !== COOKIE_VERSION ||
    issuedAt > now ||
    expiresAt <= now ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt !== ACQUISITION_COOKIE_MAX_AGE_SECONDS
  ) {
    throw new Error("Anonymous acquisition cookie is expired or invalid");
  }
  if (!Array.isArray(decoded.firstTouch) || decoded.firstTouch.length !== 5) {
    throw new Error("Anonymous acquisition first touch is invalid");
  }
  const [source, medium, campaign, content, referrerCategory] = decoded.firstTouch;
  return cookieResult({
    acquisitionId: validUuid(decoded.acquisitionId),
    attribution: strictAttribution({ source, medium, campaign, content }),
    externalReferrerCategory: strictReferrerCategory(referrerCategory),
    experiment: decoded.experiment == null
      ? null
      : decodeExperiment(decoded.experiment, issuedAt, expiresAt),
    issuedAt,
    expiresAt,
    value: value as string,
    promotedFromV1: false,
  }, secret);
}

export function resolveBrowserAcquisitionCookie(
  value: unknown,
  options: CookieOptions,
): Readonly<{ cookie: BrowserAcquisitionCookie; promoted: boolean }> {
  try {
    return Object.freeze({
      cookie: verifyBrowserAcquisitionCookie(value, options),
      promoted: false,
    });
  } catch {
    return Object.freeze({
      cookie: promoteLegacyBrowserAcquisitionCookie(value, options),
      promoted: true,
    });
  }
}

export function promoteLegacyBrowserAcquisitionCookie(
  value: unknown,
  options: CookieOptions,
): BrowserAcquisitionCookie {
  const secret = validSecret(options.secret);
  const now = epochSeconds(options.now ?? Date.now());
  const decoded = verifyEnvelope(value, secret, LEGACY_SIGNATURE_CONTEXT);
  if (!hasOnlyKeys(decoded, [
    "v", "token", "attribution", "experiment", "issuedAt", "expiresAt",
  ])) {
    throw new Error("Anonymous acquisition legacy cookie payload is invalid");
  }
  const issuedAt = epochSeconds(decoded.issuedAt);
  const expiresAt = epochSeconds(decoded.expiresAt);
  if (
    decoded.v !== LEGACY_COOKIE_VERSION ||
    typeof decoded.token !== "string" ||
    !LEGACY_TOKEN.test(decoded.token) ||
    issuedAt > now ||
    expiresAt <= now ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt !== ACQUISITION_COOKIE_MAX_AGE_SECONDS ||
    !Array.isArray(decoded.attribution) ||
    decoded.attribution.length !== 4
  ) {
    throw new Error("Anonymous acquisition legacy cookie is expired or invalid");
  }
  const [source, medium, campaign, content] = decoded.attribution;
  const digest = createHmac("sha256", secret)
    .update(`${LEGACY_PROMOTION_CONTEXT}:${decoded.token}`, "utf8")
    .digest();
  return createV2Cookie({
    acquisitionId: uuidFromBytes(digest.subarray(0, 16)),
    attribution: strictAttribution({ source, medium, campaign, content }),
    externalReferrerCategory: null,
    experiment: decoded.experiment == null
      ? null
      : decodeExperiment(decoded.experiment, issuedAt, expiresAt),
    issuedAt,
    expiresAt,
    promotedFromV1: true,
  }, secret);
}

export function serializeBrowserAcquisitionCookie(cookie: BrowserAcquisitionCookie) {
  return [
    `${ACQUISITION_COOKIE_NAME}=${cookie.value}`,
    `Max-Age=${ACQUISITION_COOKIE_MAX_AGE_SECONDS}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ");
}

export function serializeLegacyAcquisitionCookieRemoval() {
  return `${LEGACY_ACQUISITION_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function readBrowserAcquisitionCookie(
  cookieHeader: string | string[] | undefined,
): string {
  const header = Array.isArray(cookieHeader) ? cookieHeader.join(";") : cookieHeader || "";
  const current = readNamedCookie(header, ACQUISITION_COOKIE_NAME);
  if (current.invalid) return "";
  if (current.value) return current.value;
  const legacy = readNamedCookie(header, LEGACY_ACQUISITION_COOKIE_NAME);
  return legacy.invalid ? "" : legacy.value;
}

function createV2Cookie(input: Readonly<{
  acquisitionId: string;
  attribution: BrowserAcquisitionAttribution;
  externalReferrerCategory: ExternalReferrerCategory | null;
  experiment: BrowserAcquisitionExperiment | null;
  issuedAt: number;
  expiresAt: number;
  promotedFromV1: boolean;
}>, secret: Buffer) {
  const experiment = validateExperiment(input.experiment, input.issuedAt, input.expiresAt);
  const payload = Buffer.from(JSON.stringify({
    v: COOKIE_VERSION,
    acquisitionId: input.acquisitionId,
    firstTouch: [
      input.attribution.source,
      input.attribution.medium,
      input.attribution.campaign,
      input.attribution.content,
      input.externalReferrerCategory,
    ],
    experiment: experiment
      ? [experiment.experimentId, experiment.cohort, experiment.issuedAt, experiment.expiresAt]
      : null,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  }), "utf8").toString("base64url");
  const value = `${payload}.${sign(payload, secret, SIGNATURE_CONTEXT)}`;
  if (value.length > 1_024) throw new Error("Anonymous acquisition cookie is too large");
  return cookieResult({ ...input, experiment, value }, secret);
}

function cookieResult(input: Omit<BrowserAcquisitionCookie, "token">, secret: Buffer) {
  return Object.freeze({
    ...input,
    token: createHmac("sha256", secret)
      .update(`${COMPATIBILITY_TOKEN_CONTEXT}:${input.acquisitionId}`, "utf8")
      .digest("base64url"),
  });
}

function verifyEnvelope(value: unknown, secret: Buffer, context: string): Record<string, unknown> {
  if (typeof value !== "string" || value.length > 1_024 || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("Anonymous acquisition cookie is invalid");
  }
  const [payload, signature, extra] = value.split(".");
  if (!payload || !SIGNATURE.test(signature || "") || extra) {
    throw new Error("Anonymous acquisition cookie is invalid");
  }
  const expected = Buffer.from(sign(payload, secret, context), "base64url");
  const supplied = decodeCanonicalBase64Url(signature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error("Anonymous acquisition cookie signature is invalid");
  }
  try {
    const decoded = JSON.parse(decodeCanonicalBase64Url(payload).toString("utf8"));
    if (!isPlainObject(decoded)) throw new Error("invalid payload");
    return decoded;
  } catch {
    throw new Error("Anonymous acquisition cookie payload is invalid");
  }
}

function readNamedCookie(header: string, name: string) {
  const matches: string[] = [];
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator === -1) continue;
    if (segment.slice(0, separator).trim() !== name) continue;
    matches.push(segment.slice(separator + 1).trim());
  }
  return { value: matches.length === 1 && matches[0] ? matches[0] : "", invalid: matches.length > 1 };
}

function readUniqueSearchValues(search: URLSearchParams) {
  const result: Record<string, string | null> = {};
  for (const key of ["source", "medium", "campaign", "content"]) {
    const values = search.getAll(`utm_${key}`);
    if (values.length > 1) throw new Error("duplicate attribution");
    result[key] = values.length === 1 ? values[0] : null;
  }
  return result;
}

function readObjectValues(input: Readonly<Record<string, unknown>>) {
  return {
    source: input.source ?? input.utmSource ?? null,
    medium: input.medium ?? input.utmMedium ?? null,
    campaign: input.campaign ?? input.utmCampaign ?? null,
    content: input.content ?? input.utmContent ?? null,
  };
}

function strictAttribution(input: Readonly<Record<string, unknown>>) {
  if (typeof input.source !== "string" || !SAFE_LOWER_VALUE.test(input.source)) {
    throw new Error("Anonymous acquisition source is invalid");
  }
  return Object.freeze({
    source: input.source,
    medium: strictOptional(input.medium, SAFE_LOWER_VALUE),
    campaign: strictOptional(input.campaign, SAFE_MIXED_VALUE),
    content: strictOptional(input.content, SAFE_MIXED_VALUE),
  });
}

function strictReferrerCategory(value: unknown): ExternalReferrerCategory | null {
  if (value === null) return null;
  if (["search", "social", "messaging", "video", "community", "publisher", "other_external"].includes(value as string)) {
    return value as ExternalReferrerCategory;
  }
  throw new Error("Anonymous acquisition referrer category is invalid");
}

function optionalLower(value: unknown) {
  if (value == null || value === "") return null;
  return normalizeLower(value, SAFE_LOWER_VALUE);
}

function optionalMixed(value: unknown) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error("invalid attribution");
  const normalized = value.trim();
  if (!SAFE_MIXED_VALUE.test(normalized)) throw new Error("invalid attribution");
  return normalized;
}

function normalizeLower(value: unknown, pattern: RegExp) {
  if (typeof value !== "string") throw new Error("invalid attribution");
  const normalized = value.trim().toLowerCase();
  if (!pattern.test(normalized)) throw new Error("invalid attribution");
  return normalized;
}

function strictOptional(value: unknown, pattern: RegExp) {
  if (value == null) return null;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error("Anonymous acquisition attribution is invalid");
  }
  return value;
}

function validateExperiment(
  value: BrowserAcquisitionExperiment | null,
  cookieIssuedAt: number,
  cookieExpiresAt: number,
): BrowserAcquisitionExperiment | null {
  if (value == null) return null;
  const experimentId = value.experimentId;
  const cohort = value.cohort;
  const issuedAt = epochSeconds(value.issuedAt);
  const expiresAt = epochSeconds(value.expiresAt);
  if (
    typeof experimentId !== "string" || !SAFE_EXPERIMENT_ID.test(experimentId) ||
    (cohort !== "paid" && cohort !== "freemium") ||
    issuedAt > cookieIssuedAt || expiresAt <= cookieIssuedAt ||
    expiresAt > cookieExpiresAt || expiresAt <= issuedAt
  ) {
    throw new Error("Anonymous acquisition experiment is invalid");
  }
  return Object.freeze({ experimentId, cohort, issuedAt, expiresAt });
}

function decodeExperiment(value: unknown, cookieIssuedAt: number, cookieExpiresAt: number) {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error("Anonymous acquisition experiment is invalid");
  }
  return validateExperiment({
    experimentId: value[0],
    cohort: value[1],
    issuedAt: value[2],
    expiresAt: value[3],
  } as BrowserAcquisitionExperiment, cookieIssuedAt, cookieExpiresAt);
}

function sign(payload: string, secret: Buffer, context: string) {
  return createHmac("sha256", secret)
    .update(`${context}:${payload}`, "utf8")
    .digest("base64url");
}

function validSecret(value: unknown) {
  if (typeof value !== "string") throw new Error("Anonymous acquisition secret is missing");
  const secret = Buffer.from(value, "utf8");
  if (secret.length < 32 || secret.length > 512) {
    throw new Error("Anonymous acquisition secret is invalid");
  }
  return secret;
}

function validUuid(value: unknown) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error("Anonymous acquisition UUID is invalid");
  }
  return value.toLowerCase();
}

function uuidFromEntropy(value: Uint8Array) {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new Error("Anonymous acquisition entropy is invalid");
  }
  return uuidFromBytes(value.subarray(0, 16));
}

function uuidFromBytes(value: Uint8Array) {
  const bytes = Buffer.from(value);
  if (bytes.length !== 16) throw new Error("Anonymous acquisition entropy is invalid");
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function decodeCanonicalBase64Url(value: string) {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("Anonymous acquisition cookie encoding is invalid");
  }
  return decoded;
}

function epochSeconds(value: unknown) {
  const number = value instanceof Date
    ? Math.floor(value.getTime() / 1000)
    : typeof value === "number" && value > 10_000_000_000
      ? Math.floor(value / 1000)
      : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw new Error("Anonymous acquisition timestamp is invalid");
  }
  return number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const allowed = new Set(keys);
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => allowed.has(key));
}

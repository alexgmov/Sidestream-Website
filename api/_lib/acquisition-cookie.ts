import {
  createHmac,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from "node:crypto";

export const ACQUISITION_COOKIE_NAME = "__Host-sidestream-acquisition-v1";
export const ACQUISITION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const ACQUISITION_SECRET_NAME = "SIDESTREAM_ANONYMOUS_ACQUISITION_SECRET";

const COOKIE_VERSION = 1;
const SIGNATURE_CONTEXT = "sidestream-anonymous-acquisition-cookie-v1";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
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
  token: string;
  attribution: BrowserAcquisitionAttribution;
  experiment: BrowserAcquisitionExperiment | null;
  issuedAt: number;
  expiresAt: number;
  value: string;
}>;

type CookieInput = Readonly<{
  attribution?: BrowserAcquisitionAttribution;
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

export function createBrowserAcquisitionCookie(
  input: CookieInput,
  options: CookieOptions,
): BrowserAcquisitionCookie {
  const secret = validSecret(options.secret);
  const now = epochSeconds(options.now ?? Date.now());
  const expiresAt = now + ACQUISITION_COOKIE_MAX_AGE_SECONDS;
  const entropy = (options.randomBytes || nodeRandomBytes)(32);
  const token = Buffer.from(entropy).toString("base64url");
  if (entropy.length !== 32 || !TOKEN.test(token)) {
    throw new Error("Anonymous acquisition entropy is invalid");
  }
  const attribution = normalizeBrowserAcquisitionAttribution(input.attribution || {});
  const experiment = validateExperiment(input.experiment ?? null, now, expiresAt);
  const payload = Buffer.from(JSON.stringify({
    v: COOKIE_VERSION,
    token,
    attribution: [
      attribution.source,
      attribution.medium,
      attribution.campaign,
      attribution.content,
    ],
    experiment: experiment
      ? [experiment.experimentId, experiment.cohort, experiment.issuedAt, experiment.expiresAt]
      : null,
    issuedAt: now,
    expiresAt,
  }), "utf8").toString("base64url");
  const signature = sign(payload, secret);
  const value = `${payload}.${signature}`;
  if (value.length > 1024) throw new Error("Anonymous acquisition cookie is too large");
  return Object.freeze({ token, attribution, experiment, issuedAt: now, expiresAt, value });
}

export function verifyBrowserAcquisitionCookie(
  value: unknown,
  options: Readonly<{ secret: string; now?: number | Date }>,
): BrowserAcquisitionCookie {
  const secret = validSecret(options.secret);
  const now = epochSeconds(options.now ?? Date.now());
  if (typeof value !== "string" || value.length > 1024 || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("Anonymous acquisition cookie is invalid");
  }
  const [payload, signature, extra] = value.split(".");
  if (!payload || !SIGNATURE.test(signature || "") || extra) {
    throw new Error("Anonymous acquisition cookie is invalid");
  }
  const expected = Buffer.from(sign(payload, secret), "base64url");
  const supplied = Buffer.from(signature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error("Anonymous acquisition cookie signature is invalid");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Anonymous acquisition cookie payload is invalid");
  }
  if (!isPlainObject(decoded) || !hasOnlyKeys(decoded, [
    "v", "token", "attribution", "experiment", "issuedAt", "expiresAt",
  ])) {
    throw new Error("Anonymous acquisition cookie payload is invalid");
  }
  const issuedAt = epochSeconds(decoded.issuedAt);
  const expiresAt = epochSeconds(decoded.expiresAt);
  if (
    decoded.v !== COOKIE_VERSION ||
    typeof decoded.token !== "string" ||
    !TOKEN.test(decoded.token) ||
    issuedAt > now ||
    expiresAt <= now ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt !== ACQUISITION_COOKIE_MAX_AGE_SECONDS
  ) {
    throw new Error("Anonymous acquisition cookie is expired or invalid");
  }
  if (!Array.isArray(decoded.attribution) || decoded.attribution.length !== 4) {
    throw new Error("Anonymous acquisition attribution is invalid");
  }
  const [source, medium, campaign, content] = decoded.attribution;
  const attribution = strictAttribution({ source, medium, campaign, content });
  const experiment = decoded.experiment == null
    ? null
    : decodeExperiment(decoded.experiment, issuedAt, expiresAt);
  return Object.freeze({
    token: decoded.token,
    attribution,
    experiment,
    issuedAt,
    expiresAt,
    value,
  });
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

export function readBrowserAcquisitionCookie(
  cookieHeader: string | string[] | undefined,
): string {
  const header = Array.isArray(cookieHeader) ? cookieHeader.join(";") : cookieHeader || "";
  const matches: string[] = [];
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator === -1) continue;
    if (segment.slice(0, separator).trim() !== ACQUISITION_COOKIE_NAME) continue;
    matches.push(segment.slice(separator + 1).trim());
  }
  return matches.length === 1 && matches[0] ? matches[0] : "";
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
  const source = input.source;
  const medium = strictOptional(input.medium, SAFE_LOWER_VALUE);
  const campaign = strictOptional(input.campaign, SAFE_MIXED_VALUE);
  const content = strictOptional(input.content, SAFE_MIXED_VALUE);
  return Object.freeze({ source, medium, campaign, content });
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

function sign(payload: string, secret: Buffer) {
  return createHmac("sha256", secret)
    .update(`${SIGNATURE_CONTEXT}:${payload}`, "utf8")
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
  return Object.keys(value).every((key) => allowed.has(key));
}

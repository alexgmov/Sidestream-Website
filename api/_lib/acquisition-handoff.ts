import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from "node:crypto";

export const ACQUISITION_HANDOFF_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const VERSION = "1";
const ENCRYPTION_CONTEXT = "sidestream-anonymous-acquisition-handoff-encryption-v1";
const SIGNATURE_CONTEXT = "sidestream-anonymous-acquisition-handoff-signature-v1";
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export type AcquisitionHandoffPlatform = "macos" | "windows" | null;
export type AcquisitionHandoff = Readonly<{
  acquisitionCookieValue: string;
  platform: AcquisitionHandoffPlatform;
  issuedAt: number;
  expiresAt: number;
}>;

export function createAcquisitionHandoff(
  input: Readonly<{
    acquisitionCookieValue: string;
    platform?: AcquisitionHandoffPlatform;
  }>,
  options: Readonly<{
    secret: string;
    now?: number | Date;
    randomBytes?: (size: number) => Uint8Array;
  }>,
) {
  const secret = validSecret(options.secret);
  const now = epochSeconds(options.now ?? Date.now());
  const expiresAt = now + ACQUISITION_HANDOFF_MAX_AGE_SECONDS;
  const acquisitionCookieValue = validCookieValue(input.acquisitionCookieValue);
  const platform = validPlatform(input.platform ?? null);
  const randomBytes = options.randomBytes || nodeRandomBytes;
  const iv = Buffer.from(randomBytes(12));
  const nonce = Buffer.from(randomBytes(16)).toString("base64url");
  if (iv.length !== 12 || !/^[A-Za-z0-9_-]{22}$/.test(nonce)) {
    throw new Error("Acquisition handoff entropy is invalid");
  }
  const plaintext = Buffer.from(JSON.stringify({
    v: 1,
    acquisitionCookieValue,
    platform,
    issuedAt: now,
    expiresAt,
    nonce,
  }), "utf8");
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  cipher.setAAD(Buffer.from(ENCRYPTION_CONTEXT, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const unsigned = [
    VERSION,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
  const signature = sign(unsigned, secret);
  const token = `${unsigned}.${signature}`;
  if (token.length > 2048) throw new Error("Acquisition handoff is too large");
  return token;
}

export function verifyAcquisitionHandoff(
  token: unknown,
  options: Readonly<{ secret: string; now?: number | Date }>,
): AcquisitionHandoff {
  const secret = validSecret(options.secret);
  const now = epochSeconds(options.now ?? Date.now());
  if (typeof token !== "string" || token.length > 2048 || !/^[A-Za-z0-9_.-]+$/.test(token)) {
    throw new Error("Acquisition handoff is invalid");
  }
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error("Acquisition handoff is invalid");
  }
  const [version, ivValue, ciphertextValue, tagValue, signatureValue] = parts;
  if (![ivValue, ciphertextValue, tagValue, signatureValue].every((part) => BASE64URL.test(part))) {
    throw new Error("Acquisition handoff is invalid");
  }
  const unsigned = [version, ivValue, ciphertextValue, tagValue].join(".");
  const expected = Buffer.from(sign(unsigned, secret), "base64url");
  const supplied = Buffer.from(signatureValue, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error("Acquisition handoff signature is invalid");
  }

  let decoded: unknown;
  try {
    const iv = Buffer.from(ivValue, "base64url");
    const tag = Buffer.from(tagValue, "base64url");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("invalid envelope");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), iv);
    decipher.setAAD(Buffer.from(ENCRYPTION_CONTEXT, "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]);
    decoded = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error("Acquisition handoff payload is invalid");
  }
  if (!isPlainObject(decoded) || Object.keys(decoded).some((key) => ![
    "v", "acquisitionCookieValue", "platform", "issuedAt", "expiresAt", "nonce",
  ].includes(key))) {
    throw new Error("Acquisition handoff payload is invalid");
  }
  const issuedAt = epochSeconds(decoded.issuedAt);
  const expiresAt = epochSeconds(decoded.expiresAt);
  if (
    decoded.v !== 1 || issuedAt > now || expiresAt <= now || expiresAt <= issuedAt ||
    expiresAt - issuedAt !== ACQUISITION_HANDOFF_MAX_AGE_SECONDS ||
    typeof decoded.nonce !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(decoded.nonce)
  ) {
    throw new Error("Acquisition handoff is expired or invalid");
  }
  return Object.freeze({
    acquisitionCookieValue: validCookieValue(decoded.acquisitionCookieValue),
    platform: validPlatform(decoded.platform),
    issuedAt,
    expiresAt,
  });
}

export function buildAcquisitionHandoffUrl(token: string) {
  if (!token || token.length > 2048 || !/^[A-Za-z0-9_.-]+$/.test(token)) {
    throw new Error("Acquisition handoff token is invalid");
  }
  const url = new URL("https://sidestream.tv/api/send-download-links");
  url.searchParams.set("handoff", token);
  return url.toString();
}

function encryptionKey(secret: Buffer) {
  return createHash("sha256")
    .update(ENCRYPTION_CONTEXT, "utf8")
    .update(secret)
    .digest();
}

function sign(unsigned: string, secret: Buffer) {
  return createHmac("sha256", secret)
    .update(`${SIGNATURE_CONTEXT}:${unsigned}`, "utf8")
    .digest("base64url");
}

function validSecret(value: unknown) {
  if (typeof value !== "string") throw new Error("Acquisition handoff secret is missing");
  const secret = Buffer.from(value, "utf8");
  if (secret.length < 32 || secret.length > 512) {
    throw new Error("Acquisition handoff secret is invalid");
  }
  return secret;
}

function validCookieValue(value: unknown) {
  if (typeof value !== "string" || value.length < 80 || value.length > 1024 || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("Acquisition handoff cookie is invalid");
  }
  return value;
}

function validPlatform(value: unknown): AcquisitionHandoffPlatform {
  if (value === null || value === "macos" || value === "windows") return value;
  throw new Error("Acquisition handoff platform is invalid");
}

function epochSeconds(value: unknown) {
  const number = value instanceof Date
    ? Math.floor(value.getTime() / 1000)
    : typeof value === "number" && value > 10_000_000_000
      ? Math.floor(value / 1000)
      : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw new Error("Acquisition handoff timestamp is invalid");
  }
  return number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

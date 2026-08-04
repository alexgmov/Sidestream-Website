import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomUUID,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from "node:crypto";

export const ACQUISITION_HANDOFF_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const MANYCHAT_EMAIL_CAMPAIGN = "manychat-email";

const VERSION = "1";
const ENCRYPTION_CONTEXT = "sidestream-anonymous-acquisition-handoff-encryption-v1";
const SIGNATURE_CONTEXT = "sidestream-anonymous-acquisition-handoff-signature-v1";
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DELIVERY_VERSION = "d1";
const DELIVERY_ENCRYPTION_CONTEXT = "sidestream-server-owned-delivery-handoff-encryption-v1";
const DELIVERY_SIGNATURE_CONTEXT = "sidestream-server-owned-delivery-handoff-signature-v1";
const DELIVERY_IDENTITY_CONTEXT = "sidestream-server-owned-delivery-identity-v1";

export type AcquisitionHandoffPlatform = "macos" | "windows" | null;
export type AcquisitionHandoff = Readonly<{
  acquisitionCookieValue: string;
  platform: AcquisitionHandoffPlatform;
  issuedAt: number;
  expiresAt: number;
}>;

export type ServerOwnedDeliveryChannel = "manychat_email" | "facebook_lead_form";
export type ServerOwnedDeliveryHandoff = Readonly<{
  acquisitionId: string;
  source: "manychat" | "facebook";
  entryChannel: ServerOwnedDeliveryChannel;
  canonicalEntryChannel: "email_handoff";
  campaign: string;
  externalReferrerCategory: "messaging" | "social";
  intendedIdentityHash: string;
  issuedAt: number;
  expiresAt: number;
}>;

const DELIVERY_CHANNELS = Object.freeze({
  manychat_email: Object.freeze({
    source: "manychat" as const,
    canonicalEntryChannel: "email_handoff" as const,
    campaign: MANYCHAT_EMAIL_CAMPAIGN,
    externalReferrerCategory: "messaging" as const,
  }),
  facebook_lead_form: Object.freeze({
    source: "facebook" as const,
    canonicalEntryChannel: "email_handoff" as const,
    campaign: "facebook-lead-form",
    externalReferrerCategory: "social" as const,
  }),
});

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
  let supplied: Buffer;
  try {
    supplied = decodeCanonicalBase64Url(signatureValue);
  } catch {
    throw new Error("Acquisition handoff signature is invalid");
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error("Acquisition handoff signature is invalid");
  }

  let decoded: unknown;
  try {
    const iv = decodeCanonicalBase64Url(ivValue);
    const tag = decodeCanonicalBase64Url(tagValue);
    if (iv.length !== 12 || tag.length !== 16) throw new Error("invalid envelope");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), iv);
    decipher.setAAD(Buffer.from(ENCRYPTION_CONTEXT, "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(decodeCanonicalBase64Url(ciphertextValue)),
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

/**
 * This is deliberately a server-library boundary, not a request-payload parser.
 * Callers select an allowlisted integration in trusted code; browsers receive
 * only the resulting opaque envelope.
 */
export function createServerOwnedDeliveryHandoff(
  input: Readonly<{
    acquisitionId?: string;
    entryChannel: ServerOwnedDeliveryChannel;
    intendedIdentity: string;
  }>,
  options: Readonly<{
    secret: string;
    now?: number | Date;
    randomBytes?: (size: number) => Uint8Array;
  }>,
) {
  const secret = validSecret(options.secret);
  const acquisitionId = input.acquisitionId === undefined
    ? randomUUID()
    : validUuid(input.acquisitionId);
  const entryChannel = validDeliveryChannel(input.entryChannel);
  const channel = DELIVERY_CHANNELS[entryChannel];
  const intendedIdentityHash = hashDeliveryIdentity(input.intendedIdentity, secret);
  const issuedAt = epochSeconds(options.now ?? Date.now());
  const expiresAt = issuedAt + ACQUISITION_HANDOFF_MAX_AGE_SECONDS;
  const randomBytes = options.randomBytes || nodeRandomBytes;
  const iv = Buffer.from(randomBytes(12));
  const nonce = Buffer.from(randomBytes(16)).toString("base64url");
  if (iv.length !== 12 || !/^[A-Za-z0-9_-]{22}$/.test(nonce)) {
    throw new Error("Delivery handoff entropy is invalid");
  }
  const plaintext = Buffer.from(JSON.stringify({
    v: 1,
    acquisitionId,
    source: channel.source,
    entryChannel,
    campaign: channel.campaign,
    intendedIdentityHash,
    issuedAt,
    expiresAt,
    nonce,
  }), "utf8");
  const cipher = createCipheriv("aes-256-gcm", deliveryEncryptionKey(secret), iv);
  cipher.setAAD(Buffer.from(DELIVERY_ENCRYPTION_CONTEXT, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const unsigned = [
    DELIVERY_VERSION,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
  const signature = deliverySign(unsigned, secret);
  const token = `${unsigned}.${signature}`;
  if (token.length > 2_048) throw new Error("Delivery handoff is too large");
  return token;
}

export function createManyChatEmailDeliveryHandoff(
  input: Readonly<{ acquisitionId?: string; intendedIdentity: string }>,
  options: Readonly<{
    secret: string;
    now?: number | Date;
    randomBytes?: (size: number) => Uint8Array;
  }>,
) {
  return createServerOwnedDeliveryHandoff({
    ...input,
    entryChannel: "manychat_email",
  }, options);
}

export function verifyServerOwnedDeliveryHandoff(
  token: unknown,
  options: Readonly<{ secret: string; now?: number | Date }>,
): ServerOwnedDeliveryHandoff {
  const secret = validSecret(options.secret);
  const now = epochSeconds(options.now ?? Date.now());
  if (typeof token !== "string" || token.length > 2_048 || !/^[A-Za-z0-9_.-]+$/.test(token)) {
    throw new Error("Delivery handoff is invalid");
  }
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== DELIVERY_VERSION) {
    throw new Error("Delivery handoff is invalid");
  }
  const [version, ivValue, ciphertextValue, tagValue, signatureValue] = parts;
  if (![ivValue, ciphertextValue, tagValue, signatureValue].every((part) => BASE64URL.test(part))) {
    throw new Error("Delivery handoff is invalid");
  }
  const unsigned = [version, ivValue, ciphertextValue, tagValue].join(".");
  const expected = Buffer.from(deliverySign(unsigned, secret), "base64url");
  const supplied = decodeCanonicalBase64Url(signatureValue);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error("Delivery handoff signature is invalid");
  }
  let decoded: unknown;
  try {
    const iv = decodeCanonicalBase64Url(ivValue);
    const tag = decodeCanonicalBase64Url(tagValue);
    if (iv.length !== 12 || tag.length !== 16) throw new Error("invalid envelope");
    const decipher = createDecipheriv("aes-256-gcm", deliveryEncryptionKey(secret), iv);
    decipher.setAAD(Buffer.from(DELIVERY_ENCRYPTION_CONTEXT, "utf8"));
    decipher.setAuthTag(tag);
    decoded = JSON.parse(Buffer.concat([
      decipher.update(decodeCanonicalBase64Url(ciphertextValue)),
      decipher.final(),
    ]).toString("utf8"));
  } catch {
    throw new Error("Delivery handoff payload is invalid");
  }
  if (!isPlainObject(decoded) || !hasExactKeys(decoded, [
    "v", "acquisitionId", "source", "entryChannel", "campaign",
    "intendedIdentityHash", "issuedAt", "expiresAt", "nonce",
  ])) {
    throw new Error("Delivery handoff payload is invalid");
  }
  const entryChannel = validDeliveryChannel(decoded.entryChannel);
  const channel = DELIVERY_CHANNELS[entryChannel];
  const issuedAt = epochSeconds(decoded.issuedAt);
  const expiresAt = epochSeconds(decoded.expiresAt);
  if (
    decoded.v !== 1 ||
    decoded.source !== channel.source ||
    decoded.campaign !== channel.campaign ||
    typeof decoded.intendedIdentityHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(decoded.intendedIdentityHash) ||
    typeof decoded.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{22}$/.test(decoded.nonce) ||
    issuedAt > now || expiresAt <= now || expiresAt <= issuedAt ||
    expiresAt - issuedAt !== ACQUISITION_HANDOFF_MAX_AGE_SECONDS
  ) {
    throw new Error("Delivery handoff is expired or invalid");
  }
  return Object.freeze({
    acquisitionId: validUuid(decoded.acquisitionId),
    source: channel.source,
    entryChannel,
    canonicalEntryChannel: channel.canonicalEntryChannel,
    campaign: channel.campaign,
    externalReferrerCategory: channel.externalReferrerCategory,
    intendedIdentityHash: decoded.intendedIdentityHash,
    issuedAt,
    expiresAt,
  });
}

export function evaluateForwardedDeliveryHandoff(
  handoff: ServerOwnedDeliveryHandoff,
  exactVerifiedIdentity: string | null | undefined,
  options: Readonly<{ secret: string }>,
) {
  if (!exactVerifiedIdentity) return Object.freeze({ possibleForwardedHandoff: false });
  const secret = validSecret(options.secret);
  const exactHash = hashDeliveryIdentity(exactVerifiedIdentity, secret);
  return Object.freeze({
    possibleForwardedHandoff: !safeEqualHex(handoff.intendedIdentityHash, exactHash),
  });
}

export function buildServerOwnedDeliveryHandoffUrl(token: string) {
  if (!token || token.length > 2_048 || !/^[A-Za-z0-9_.-]+$/.test(token)) {
    throw new Error("Delivery handoff token is invalid");
  }
  const url = new URL("https://sidestream.tv/api/acquisition/entry");
  url.searchParams.set("handoff", token);
  return url.toString();
}

function encryptionKey(secret: Buffer) {
  return createHash("sha256")
    .update(ENCRYPTION_CONTEXT, "utf8")
    .update(secret)
    .digest();
}

function deliveryEncryptionKey(secret: Buffer) {
  return createHash("sha256")
    .update(DELIVERY_ENCRYPTION_CONTEXT, "utf8")
    .update(secret)
    .digest();
}

function sign(unsigned: string, secret: Buffer) {
  return createHmac("sha256", secret)
    .update(`${SIGNATURE_CONTEXT}:${unsigned}`, "utf8")
    .digest("base64url");
}

function deliverySign(unsigned: string, secret: Buffer) {
  return createHmac("sha256", secret)
    .update(`${DELIVERY_SIGNATURE_CONTEXT}:${unsigned}`, "utf8")
    .digest("base64url");
}

function decodeCanonicalBase64Url(value: string) {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("Acquisition handoff encoding is invalid");
  }
  return decoded;
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

function validUuid(value: unknown) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error("Delivery handoff acquisition ID is invalid");
  }
  return value.toLowerCase();
}

function validDeliveryChannel(value: unknown): ServerOwnedDeliveryChannel {
  if (value === "manychat_email" || value === "facebook_lead_form") return value;
  throw new Error("Delivery handoff channel is invalid");
}

function hashDeliveryIdentity(value: unknown, secret: Buffer) {
  if (typeof value !== "string") throw new Error("Delivery handoff identity is invalid");
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 320 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("Delivery handoff identity is invalid");
  }
  return createHmac("sha256", secret)
    .update(`${DELIVERY_IDENTITY_CONTEXT}:${normalized}`, "utf8")
    .digest("hex");
}

function safeEqualHex(left: string, right: string) {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
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

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const allowed = new Set(keys);
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => allowed.has(key));
}

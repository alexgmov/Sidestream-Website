import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";

const VERSION = "v1";

export function hashSupportEmail(email: string, secret: string) {
  return createHmac("sha256", deriveKey(secret, "email-hash"))
    .update(email.trim().toLowerCase())
    .digest("hex");
}

export function fingerprintSupportValue(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function encryptSupportText(plaintext: string, secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret, "encryption"), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ciphertext]
    .map((part) => typeof part === "string" ? part : part.toString("base64url"))
    .join(".");
}

export function decryptSupportText(serialized: string, secret: string) {
  const parts = serialized.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Unsupported support ciphertext");
  }
  const [, rawIv, rawTag, rawCiphertext] = parts;
  const iv = Buffer.from(rawIv, "base64url");
  const tag = Buffer.from(rawTag, "base64url");
  const ciphertext = Buffer.from(rawCiphertext, "base64url");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("Invalid support ciphertext");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(secret, "encryption"),
    iv,
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function deriveKey(secret: string, purpose: string) {
  if (secret.length < 32) throw new Error("Support data secret is too short");
  return createHash("sha256")
    .update(`sidestream-support:${purpose}:`)
    .update(secret)
    .digest();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

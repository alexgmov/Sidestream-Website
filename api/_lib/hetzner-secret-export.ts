import {
  constants,
  createCipheriv,
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  publicEncrypt,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { resolveRuntimePostgresTarget } from "./postgres.js";

const EXPORT_TOKEN_NAME = "SIDESTREAM_HETZNER_EXPORT_TOKEN";
const EXPORT_PUBLIC_KEY_NAME = "SIDESTREAM_HETZNER_EXPORT_PUBLIC_KEY";
const EXPORT_NOT_AFTER_NAME = "SIDESTREAM_HETZNER_EXPORT_NOT_AFTER";
const LICENSE_SECRET_NAME = "SIDESTREAM_LICENSE_HASH_SECRET";
const PROOF_CONTEXT = "sidestream-hetzner-hash-continuity-v1";
const EXCLUDED_SIDESTREAM_NAMES = new Set([
  EXPORT_TOKEN_NAME,
  EXPORT_PUBLIC_KEY_NAME,
  EXPORT_NOT_AFTER_NAME,
  "SIDESTREAM_HETZNER_ORIGIN_URL",
  "SIDESTREAM_ORIGIN_AUTH_SECRET",
]);

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
type ExportRequest = IncomingMessage & Readonly<{ rawHeaders?: string[] }>;

export function createHetznerSecretExportHandler(
  environment: RuntimeEnvironment = process.env,
  now: () => Date = () => new Date(),
) {
  return function hetznerSecretExportHandler(
    request: ExportRequest,
    response: ServerResponse,
  ) {
    setExportHeaders(response);
    if (hasBrowserOrigin(request)) {
      return sendJson(response, 403, { error: "Browser access is forbidden" });
    }
    if ((request.method || "GET").toUpperCase() !== "POST") {
      response.setHeader("Allow", "POST");
      return sendJson(response, 405, { error: "Method not allowed" });
    }

    const token = validPrintableSecret(environment[EXPORT_TOKEN_NAME], 32, 512);
    const notAfter = parseNotAfter(environment[EXPORT_NOT_AFTER_NAME]);
    if (!token || !notAfter || now().getTime() > notAfter.getTime()) {
      return sendJson(response, 503, { error: "Secret export is unavailable" });
    }
    if (!hasSingleBearerCredential(request, token)) {
      return sendJson(response, 401, { error: "Unauthorized" });
    }

    try {
      const payload = buildSecretExportPayload(environment, now());
      const envelope = encryptSecretExport(
        payload,
        String(environment[EXPORT_PUBLIC_KEY_NAME] || ""),
      );
      return sendJson(response, 200, envelope);
    } catch {
      return sendJson(response, 503, { error: "Secret export failed" });
    }
  };
}

export function buildSecretExportPayload(
  environment: RuntimeEnvironment,
  createdAt = new Date(),
) {
  const target = resolveRuntimePostgresTarget(environment);
  if (!target) throw new Error("Website Postgres target is unavailable");
  const licenseHashSecret = environment[LICENSE_SECRET_NAME] || target.connectionString;
  const values = Object.fromEntries(
    Object.entries(environment)
      .filter(([name, value]) => shouldExportEnvironmentValue(name, value))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  values[LICENSE_SECRET_NAME] = licenseHashSecret;
  return Object.freeze({
    version: 1,
    createdAt: createdAt.toISOString(),
    values,
    licenseHashContinuityProof: createHmac("sha256", licenseHashSecret)
      .update(PROOF_CONTEXT)
      .digest("hex"),
  });
}

export function encryptSecretExport(payload: unknown, publicKeyBase64: string) {
  const encodedKey = publicKeyBase64.trim();
  if (!/^[A-Za-z0-9+/=]{256,2048}$/.test(encodedKey)) {
    throw new Error("Export public key is invalid");
  }
  const publicKey = createPublicKey({
    key: Buffer.from(encodedKey, "base64"),
    format: "der",
    type: "spki",
  });
  if (publicKey.asymmetricKeyType !== "rsa") {
    throw new Error("Export public key must be RSA");
  }

  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const encryptedKey = publicEncrypt({
    key: publicKey,
    oaepHash: "sha256",
    padding: constants.RSA_PKCS1_OAEP_PADDING,
  }, key);
  key.fill(0);

  return Object.freeze({
    version: 1,
    algorithm: "RSA-OAEP-SHA256+A256GCM",
    encryptedKey: encryptedKey.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}

function shouldExportEnvironmentValue(name: string, value: string | undefined) {
  if (!value || EXCLUDED_SIDESTREAM_NAMES.has(name)) return false;
  return name.startsWith("SIDESTREAM_") ||
    name.startsWith("STRIPE_") ||
    name.startsWith("GOOGLE_") ||
    name.startsWith("RESEND_") ||
    name.startsWith("BLOB_") ||
    name.startsWith("POSTGRES_") ||
    name === "CRON_SECRET";
}

function parseNotAfter(value: string | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function validPrintableSecret(
  value: string | undefined,
  minimum: number,
  maximum: number,
) {
  const secret = value || "";
  return secret.length >= minimum && secret.length <= maximum && /^[\x21-\x7e]+$/.test(secret)
    ? secret
    : "";
}

function hasBrowserOrigin(request: ExportRequest) {
  const origin = request.headers.origin;
  return Array.isArray(origin) ? origin.length > 0 : typeof origin === "string";
}

function hasSingleBearerCredential(request: ExportRequest, token: string) {
  const authorization = request.headers.authorization;
  if (!authorization || Array.isArray(authorization)) return false;
  if (Array.isArray(request.rawHeaders) && request.rawHeaders.length > 0) {
    let count = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index]?.toLowerCase() === "authorization") count += 1;
    }
    if (count !== 1) return false;
  }
  const actual = createHash("sha256").update(authorization).digest();
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  return timingSafeEqual(actual, expected);
}

function setExportHeaders(response: ServerResponse) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Vary", "Authorization, Origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

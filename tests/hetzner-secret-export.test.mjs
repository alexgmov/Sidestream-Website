import assert from "node:assert/strict";
import {
  constants,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
} from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";

import { loadInjectedModule } from "./helpers/handler-loader.mjs";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const TOKEN = "0123456789abcdef0123456789abcdef";
const POSTGRES_URL = "postgres://website:password@source.example.invalid/neondb?sslmode=require";
const environment = Object.freeze({
  VERCEL_ENV: "production",
  SIDESTREAM_HETZNER_EXPORT_TOKEN: TOKEN,
  SIDESTREAM_HETZNER_EXPORT_PUBLIC_KEY: publicKey.toString("base64"),
  SIDESTREAM_HETZNER_EXPORT_NOT_AFTER: "2026-08-22T06:00:00.000Z",
  SIDESTREAM_POSTGRES_URL: POSTGRES_URL,
  STRIPE_SECRET_KEY: "stripe-secret",
  BLOB_READ_WRITE_TOKEN: "blob-secret",
  VERCEL_URL: "system-value-must-not-export",
});
const postgresStub = {
  resolveRuntimePostgresTarget: (input) => ({
    connectionString: new URL(input.SIDESTREAM_POSTGRES_URL).toString(),
    environmentVariable: "SIDESTREAM_POSTGRES_URL",
    pooled: true,
  }),
};
const exportModule = await loadInjectedModule(
  new URL("../api/_lib/hetzner-secret-export.ts", import.meta.url),
  { "./postgres.js": postgresStub },
);

test("the one-time export is POST-only, non-browser, bearer-protected, and expires", () => {
  const handler = exportModule.createHetznerSecretExportHandler(
    environment,
    () => new Date("2026-08-22T05:00:00.000Z"),
  );
  for (const options of [
    { method: "GET", authorization: `Bearer ${TOKEN}`, statusCode: 405 },
    { method: "POST", authorization: "Bearer wrong", statusCode: 401 },
    { method: "POST", authorization: `Bearer ${TOKEN}`, origin: "https://sidestream.tv", statusCode: 403 },
  ]) {
    const response = invoke(handler, options);
    assert.equal(response.statusCode, options.statusCode);
    assert.match(String(response.headers.get("cache-control")), /no-store/);
  }

  const expired = exportModule.createHetznerSecretExportHandler(
    environment,
    () => new Date("2026-08-22T06:00:01.000Z"),
  );
  assert.equal(invoke(expired, {
    method: "POST",
    authorization: `Bearer ${TOKEN}`,
  }).statusCode, 503);
});

test("the export encrypts selected runtime secrets and exact hash-continuity bytes", () => {
  const handler = exportModule.createHetznerSecretExportHandler(
    environment,
    () => new Date("2026-08-22T05:00:00.000Z"),
  );
  const response = invoke(handler, {
    method: "POST",
    authorization: `Bearer ${TOKEN}`,
  });
  assert.equal(response.statusCode, 200);
  const envelope = JSON.parse(response.body);
  const key = privateDecrypt({
    key: privateKey,
    oaepHash: "sha256",
    padding: constants.RSA_PKCS1_OAEP_PADDING,
  }, Buffer.from(envelope.encryptedKey, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const payload = JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8"));

  assert.equal(payload.values.SIDESTREAM_LICENSE_HASH_SECRET, new URL(POSTGRES_URL).toString());
  assert.equal(payload.values.STRIPE_SECRET_KEY, "stripe-secret");
  assert.equal(payload.values.BLOB_READ_WRITE_TOKEN, "blob-secret");
  assert.equal(payload.values.SIDESTREAM_HETZNER_EXPORT_TOKEN, undefined);
  assert.equal(payload.values.VERCEL_URL, undefined);
  assert.match(payload.licenseHashContinuityProof, /^[0-9a-f]{64}$/);
});

function invoke(handler, options) {
  const request = new EventEmitter();
  request.method = options.method;
  request.headers = {};
  request.rawHeaders = [];
  if (options.authorization) {
    request.headers.authorization = options.authorization;
    request.rawHeaders.push("Authorization", options.authorization);
  }
  if (options.origin) request.headers.origin = options.origin;
  const headers = new Map();
  const response = {
    statusCode: 200,
    body: "",
    headers,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value);
    },
    end(value = "") {
      this.body = String(value);
    },
  };
  handler(request, response);
  return response;
}

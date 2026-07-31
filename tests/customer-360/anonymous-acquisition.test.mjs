import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ANONYMOUS_ACQUISITION_PRIVACY_EXCLUSIONS,
  createAnonymousAcquisitionAssignment,
  generateAnonymousAcquisitionToken,
  hashAnonymousAcquisitionToken,
  isAnonymousAcquisitionDigest,
  normalizeAnonymousAcquisitionAttribution,
  verifyAnonymousAcquisitionAssignment,
} from "../../api/_lib/anonymous-acquisition.ts";

const SECRET = "anonymous-acquisition-test-secret-32-bytes-minimum";
const NOW = 1_785_456_000;

test("direct attribution is explicit and every UTM dimension is bounded", () => {
  assert.deepEqual(normalizeAnonymousAcquisitionAttribution(), {
    source: "direct",
    medium: null,
    campaign: null,
    content: null,
  });
  assert.deepEqual(normalizeAnonymousAcquisitionAttribution({
    source: "manychat-instagram",
    medium: "dm",
    campaign: "Launch_01",
    content: "cta.a",
  }), {
    source: "manychat-instagram",
    medium: "dm",
    campaign: "Launch_01",
    content: "cta.a",
  });
  for (const input of [
    { source: "UPPER" },
    { source: "x".repeat(65) },
    { medium: "paid social" },
    { campaign: "../escape" },
    { content: "x".repeat(65) },
    { referrer: "https://example.com" },
  ]) {
    assert.throws(
      () => normalizeAnonymousAcquisitionAttribution(input),
      (error) => error?.code === "invalid_attribution",
    );
  }
});

test("browser tokens become one-way digests and never accept low-entropy forms", () => {
  const token = generateAnonymousAcquisitionToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const digest = hashAnonymousAcquisitionToken(token);
  assert.equal(isAnonymousAcquisitionDigest(digest), true);
  assert.notEqual(digest, token);
  for (const invalid of ["", "raw-token", "a".repeat(42), "a".repeat(44)]) {
    assert.throws(
      () => hashAnonymousAcquisitionToken(invalid),
      (error) => error?.code === "invalid_token",
    );
  }
});

test("paid versus freemium assignment is accepted only with a valid bounded signature", () => {
  for (const cohort of ["paid", "freemium"]) {
    const signed = createAnonymousAcquisitionAssignment({
      experimentId: "anonymous-download-v1",
      cohort,
      issuedAt: NOW - 60,
      expiresAt: NOW + 600,
      secret: SECRET,
    });
    const verified = verifyAnonymousAcquisitionAssignment(signed, {
      secret: SECRET,
      now: NOW,
    });
    assert.equal(verified.experimentId, "anonymous-download-v1");
    assert.equal(verified.cohort, cohort);
    assert.match(verified.signatureHash, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(verified.signatureHash, new RegExp(signed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    assert.throws(
      () => verifyAnonymousAcquisitionAssignment(`${signed.slice(0, -1)}x`, {
        secret: SECRET,
        now: NOW,
      }),
      (error) => error?.code === "invalid_assignment",
    );
    assert.throws(
      () => verifyAnonymousAcquisitionAssignment(signed, {
        secret: SECRET,
        now: NOW + 601,
      }),
      (error) => error?.code === "invalid_assignment",
    );
  }
});

test("schema and server primitive enforce the reporting privacy boundary", async () => {
  const [migration, moduleSource] = await Promise.all([
    readFile(new URL(
      "../../db/migrations/20260731120000_add_anonymous_acquisition_sessions.sql",
      import.meta.url,
    ), "utf8"),
    readFile(new URL("../../api/_lib/anonymous-acquisition.ts", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all[^;]+from public/is);
  assert.match(migration, /conflict evidence is append-only/i);
  assert.doesNotMatch(migration, /\b(ip_address|raw_ip|user_agent|email|install_id_hash|receipt_hash|telemetry_payload|browser_token)\b/i);
  assert.doesNotMatch(moduleSource, /insert into public\.sidestream_customer_profiles/i);
  assert.doesNotMatch(moduleSource, /sidestream_(licenses|account_devices)/i);
  assert.deepEqual(ANONYMOUS_ACQUISITION_PRIVACY_EXCLUSIONS, [
    "ip", "userAgent", "email", "installIdHash", "installerReceiptHash",
    "telemetryPayload", "browserToken",
  ]);
});


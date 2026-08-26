import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ACQUISITION_PRIVACY_EXCLUSIONS,
  ACQUISITION_STAGES,
  ACQUISITION_STAGE_COUNTING_GRAINS,
  createCanonicalAcquisitionRoot,
  deriveAcquisitionStageDeduplicationKey,
  generateAcquisitionId,
  recordAcquisitionStage,
} from "../../api/_lib/acquisition-integrity.ts";

const FIRST_OBSERVED = "2026-08-03T12:00:00.000Z";

test("stage taxonomy declares exactly one canonical counting grain", () => {
  assert.deepEqual(ACQUISITION_STAGES, [
    "landing_observed",
    "email_handoff_created",
    "installer_requested",
    "installation_claimed",
    "authentication_completed",
    "checkout_started",
    "checkout_completed",
    "payment_settled",
    "refunded",
    "disputed",
  ]);
  assert.deepEqual(Object.keys(ACQUISITION_STAGE_COUNTING_GRAINS), ACQUISITION_STAGES);
  assert.equal(new Set(Object.values(ACQUISITION_STAGE_COUNTING_GRAINS)).size, 10);
});

test("deduplication keys are stable one-way, stage-scoped, and namespace-scoped", () => {
  const input = {
    licenseNamespace: "test",
    stage: "checkout_completed",
    stableServerReference: "server-checkout-session-123",
  };
  const first = deriveAcquisitionStageDeduplicationKey(input);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(deriveAcquisitionStageDeduplicationKey(input), first);
  assert.notEqual(deriveAcquisitionStageDeduplicationKey({
    ...input,
    stage: "checkout_started",
  }), first);
  assert.notEqual(deriveAcquisitionStageDeduplicationKey({
    ...input,
    licenseNamespace: "production",
  }), first);
  assert.doesNotMatch(first, /server-checkout-session-123/);
});

test("canonical creation defaults unknown external origin to truthful Sidestream website entry", async () => {
  const queries = [];
  const acquisitionId = generateAcquisitionId();
  const stored = {
    id: acquisitionId,
    license_namespace: "test",
    first_observed_source: "website_direct_or_unknown",
    first_observed_medium: null,
    first_observed_campaign: null,
    first_observed_content_creative: null,
    entry_channel: "website",
    first_observed_at: FIRST_OBSERVED,
    external_referrer_category: null,
    experiment_id: null,
    experiment_cohort: null,
    attribution_confidence: "exact_sidestream_entry",
    integrity_state: "intact",
    trusted_delivery_evidence: ["website_entry"],
  };
  const stage = {
    id: "10000000-0000-4000-8000-000000000001",
    acquisition_id: acquisitionId,
    license_namespace: "test",
    stage: "landing_observed",
    counting_grain: "acquisition",
    deduplication_key: "a".repeat(64),
    occurred_at: FIRST_OBSERVED,
    recorded_at: FIRST_OBSERVED,
  };
  const transaction = async (callback) => callback({
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (/select \* from public\.sidestream_acquisitions where id = \$1 for update/i.test(sql)) {
        return { rows: [stored] };
      }
      if (/select \* from public\.sidestream_acquisitions[\s\S]+for share/i.test(sql)) {
        return { rows: [stored] };
      }
      if (/select \* from public\.sidestream_acquisition_stages/i.test(sql)) {
        return { rows: [stage] };
      }
      return { rows: [] };
    },
  });
  const result = await createCanonicalAcquisitionRoot({
    acquisitionId,
    firstObservedAt: FIRST_OBSERVED,
    landingDeduplicationReference: "server-request-1",
  }, { transaction, namespace: "test" });
  assert.equal(result.firstObserved.source, "website_direct_or_unknown");
  assert.equal(result.entryChannel, "website");
  assert.equal(result.attributionConfidence, "exact_sidestream_entry");
  const insert = queries.find(({ sql }) => /insert into public\.sidestream_acquisitions/i.test(sql));
  assert.equal(insert.params[2], "website_direct_or_unknown");
  assert.equal(insert.params[6], "website");
  assert.equal(insert.params[11], "exact_sidestream_entry");
});

test("stage writes acquire the acquisition root before the child-stage lock", async () => {
  const acquisitionId = "00000000-0000-4000-8000-000000000901";
  const advisoryLocks = [];
  const root = {
    id: acquisitionId,
    license_namespace: "test",
    first_observed_source: "website_direct_or_unknown",
    first_observed_medium: null,
    first_observed_campaign: null,
    first_observed_content_creative: null,
    entry_channel: "website",
    first_observed_at: FIRST_OBSERVED,
    external_referrer_category: null,
    experiment_id: null,
    experiment_cohort: null,
    attribution_confidence: "exact_sidestream_entry",
    integrity_state: "intact",
    trusted_delivery_evidence: ["website_entry"],
  };
  const stage = {
    id: "10000000-0000-4000-8000-000000000901",
    acquisition_id: acquisitionId,
    license_namespace: "test",
    stage: "authentication_completed",
    counting_grain: "authentication",
    deduplication_key: "b".repeat(64),
    occurred_at: "2026-08-03T12:01:00.000Z",
    recorded_at: "2026-08-03T12:01:00.000Z",
  };
  const transaction = async (callback) => callback({
    async query(sql, params = []) {
      if (/pg_advisory_xact_lock/i.test(sql)) advisoryLocks.push(params[0]);
      if (/select \* from public\.sidestream_acquisitions[\s\S]+for share/i.test(sql)) {
        return { rows: [root] };
      }
      if (/select \* from public\.sidestream_acquisition_stages/i.test(sql)) {
        return { rows: [stage] };
      }
      return { rows: [] };
    },
  });

  await recordAcquisitionStage({
    acquisitionId,
    stage: "authentication_completed",
    stableServerReference: `google-account:${acquisitionId}:${acquisitionId}`,
    occurredAt: "2026-08-03T12:01:00.000Z",
  }, { transaction, namespace: "test" });

  assert.equal(advisoryLocks[0], `sidestream_acquisition_integrity:root:${acquisitionId}`);
  assert.match(advisoryLocks[1], /^sidestream_acquisition_integrity:stage:test:authentication_completed:/);
});

test("untrusted or sensitive request-shaped fields are rejected, not retained", async () => {
  for (const extra of [
    { email: "person@example.com" },
    { ip: "192.0.2.1" },
    { cookie: "secret" },
    { stripePayload: { id: "evt_raw" } },
    { telemetryPayload: { event: "raw" } },
  ]) {
    await assert.rejects(
      createCanonicalAcquisitionRoot({
        firstObservedAt: FIRST_OBSERVED,
        landingDeduplicationReference: "server-request-1",
        ...extra,
      }),
      (error) => error?.code === "invalid_request",
    );
  }
  assert.deepEqual(ACQUISITION_PRIVACY_EXCLUSIONS, [
    "ip", "userAgent", "cookie", "email", "stripePayload",
    "telemetryPayload", "installHash", "receiptHash",
  ]);
  await assert.rejects(
    createCanonicalAcquisitionRoot({
      firstObservedAt: FIRST_OBSERVED,
      landingDeduplicationReference: "legacy-collapsed-channel",
      source: "manychat",
      entryChannel: "email_handoff",
    }),
    (error) => error?.code === "invalid_entry_channel",
  );
});

test("migration encodes immutability, privacy, Checkout future enforcement, and no inferred history", async () => {
  const [migration, moduleSource] = await Promise.all([
    readFile(new URL(
      "../../db/migrations/20260803120000_add_acquisition_integrity.sql",
      import.meta.url,
    ), "utf8"),
    readFile(new URL("../../api/_lib/acquisition-integrity.ts", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /website_direct_or_unknown/);
  assert.match(
    migration,
    /entry_channel in \([\s\S]*'website'[\s\S]*'manychat_email'[\s\S]*'facebook_lead_form'/,
  );
  assert.doesNotMatch(migration, /entry_channel in \([^)]*'email_handoff'/s);
  assert.match(migration, /exact_sidestream_entry/);
  assert.match(migration, /missing_internal_linkage/);
  assert.match(migration, /historical_unlinked/);
  assert.match(migration, /Acquisition reporting evidence is append-only/);
  assert.match(migration, /Canonical acquisition first touch is immutable/);
  assert.match(migration, /before insert on public\.sidestream_checkout_intents/i);
  assert.match(migration, /Historical intents deliberately stay null/i);
  assert.match(migration, /enable row level security/gi);
  assert.match(migration, /revoke all[^;]+from public/is);
  assert.doesNotMatch(
    migration,
    /\b(raw_ip|ip_address|user_agent|cookie|email|stripe_payload|telemetry_payload|install_hash|receipt_hash)\b/i,
  );
  assert.doesNotMatch(moduleSource, /\b(create|alter|drop|truncate)\s+table\b/i);
  assert.doesNotMatch(moduleSource, /sidestream_(licenses|account_devices|customer_commerce)/i);
});

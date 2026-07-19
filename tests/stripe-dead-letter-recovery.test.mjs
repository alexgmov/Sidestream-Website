import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  STRIPE_EVENT_MAX_ATTEMPTS,
  STRIPE_EVENT_RECOVERY_ATTEMPT,
  atomicallyClaimStripeDeadLetter,
  buildRecoveryRequest,
  buildSafeRecoveryReport,
  createRecoveryPoolOptions,
  loadStripeEventsRuntime,
  parseRecoveryArgs,
  runStripeDeadLetterRecovery,
  selectRecoveryDatabase,
  snapshotFromRow,
  validateNewRecoveryState,
} from "../scripts/recover-stripe-dead-letter.mjs";

const EVENT_ID = "evt_dead_letter_001";
const RECOVERY_ID = "00000000-0000-4000-8000-000000000901";

test("CLI is exact-event, read-only by default, and exposes no bulk or Production mode", () => {
  const readOnly = parseRecoveryArgs(["--event-id", EVENT_ID]);
  assert.equal(readOnly.apply, false);
  assert.equal(readOnly.licenseNamespace, "test");
  assert.throws(() => parseRecoveryArgs([]), /exact Stripe --event-id/);
  assert.throws(() => parseRecoveryArgs(["--all"]), /Bulk replay/);
  assert.throws(
    () => parseRecoveryArgs(["--event-id", EVENT_ID, "--event-id", "evt_other_001"]),
    /only once/,
  );
  assert.throws(
    () => parseRecoveryArgs(["--event-id", EVENT_ID, "--max-attempts", "20"]),
    /cap overrides/,
  );
  assert.throws(
    () => parseRecoveryArgs([
      "--event-id", EVENT_ID,
      "--license-namespace", "production",
    ]),
    /Production recovery is disabled/,
  );
  assert.throws(
    () => parseRecoveryArgs([
      "--event-id", EVENT_ID,
      "--target-fingerprint", "a".repeat(64),
    ]),
    /Apply expectations require --apply/,
  );
});

test("apply requires every reviewed expectation and exact confirmation", () => {
  const snapshot = deadLetterSnapshot();
  const valid = validApplyArguments(snapshot);
  assert.equal(parseRecoveryArgs(valid).apply, true);

  for (const option of [
    "--license-namespace",
    "--target-fingerprint",
    "--expected-payload-digest",
    "--expected-terminal-state",
    "--reason",
    "--confirm",
  ]) {
    const index = valid.indexOf(option);
    const without = [...valid.slice(0, index), ...valid.slice(index + 2)];
    assert.throws(() => parseRecoveryArgs(without));
  }

  assert.throws(
    () => parseRecoveryArgs(replaceOption(valid, "--expected-terminal-state", "processed")),
    /dead_letter/,
  );
  assert.throws(
    () => parseRecoveryArgs(replaceOption(valid, "--reason", "customer_requested")),
    /reviewed reason code/,
  );
});

test("database selection accepts only an isolated Test URL, Test namespace, and test key", () => {
  const safeEnvironment = {
    SIDESTREAM_TEST_POSTGRES_URL: "postgres://test:secret@localhost:5432/sidestream_test",
    SIDESTREAM_LICENSE_NAMESPACE: "test",
    STRIPE_SECRET_KEY: "sk_test_fixture",
  };
  const selected = selectRecoveryDatabase(safeEnvironment, { apply: true });
  assert.equal(selected.local, true);
  assert.equal(createRecoveryPoolOptions(selected).ssl, false);

  assert.throws(
    () => selectRecoveryDatabase({ ...safeEnvironment, SIDESTREAM_LICENSE_NAMESPACE: "production" }, { apply: true }),
    /production_recovery_disabled/,
  );
  assert.throws(
    () => selectRecoveryDatabase({ ...safeEnvironment, VERCEL_ENV: "production" }, { apply: true }),
    /production_recovery_disabled/,
  );
  assert.throws(
    () => selectRecoveryDatabase({ ...safeEnvironment, STRIPE_SECRET_KEY: "sk_live_private" }, { apply: true }),
    /stripe_test_key_required/,
  );
  assert.throws(
    () => selectRecoveryDatabase({
      ...safeEnvironment,
      SIDESTREAM_POSTGRES_URL: safeEnvironment.SIDESTREAM_TEST_POSTGRES_URL,
    }, { apply: true }),
    /test_database_not_isolated/,
  );
  assert.deepEqual(
    createRecoveryPoolOptions({
      connectionString: "postgres://test:secret@db.example.test/sidestream_test?sslmode=require",
      local: false,
    }).ssl,
    { rejectUnauthorized: true },
  );
  assert.throws(() => createRecoveryPoolOptions({
    connectionString: "postgres://test:secret@db.example.test/sidestream_test?sslmode=disable",
    local: false,
  }), /test_database_url_invalid/);
  assert.deepEqual(
    createRecoveryPoolOptions({
      connectionString: "postgres://test:secret@db.example.test/sidestream_test?sslmode=verify-full",
      local: false,
    }).ssl,
    { rejectUnauthorized: true },
  );
});

test("safe reports exclude raw payload and every customer/provider identifier", () => {
  const snapshot = deadLetterSnapshot();
  const report = buildSafeRecoveryReport(snapshot);
  const serialized = JSON.stringify(report);
  assert.equal(report.eventType, "refund.failed");
  assert.equal(report.attemptCount, STRIPE_EVENT_MAX_ATTEMPTS);
  assert.match(report.payloadDigest, /^[0-9a-f]{64}$/);
  assert.match(report.targetFingerprint, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(
    serialized,
    /evt_dead_letter_001|re_private|cus_private|pi_private|private@example\.com/,
  );
  assert.equal("payload" in report, false);
  assert.equal("eventId" in report, false);
});

test("apply refuses changed targets, changed payloads, and incorrect confirmation", () => {
  const snapshot = deadLetterSnapshot();
  const options = validApplyOptions(snapshot);
  assert.match(buildRecoveryRequest(options, snapshot).requestDigest, /^[0-9a-f]{64}$/);
  assert.throws(
    () => buildRecoveryRequest({ ...options, targetFingerprint: "b".repeat(64) }, snapshot),
    /target_fingerprint_changed/,
  );
  assert.throws(
    () => buildRecoveryRequest({ ...options, expectedPayloadDigest: "b".repeat(64) }, snapshot),
    /payload_digest_changed/,
  );
  assert.throws(
    () => buildRecoveryRequest({ ...options, confirmation: "RECOVER-TEST-DEAD-LETTER:wrong" }, snapshot),
    /confirmation_mismatch/,
  );
});

test("livemode, redacted, identity-mismatched, and unresolved payloads fail closed", () => {
  assert.throws(() => deadLetterSnapshot({ payload: { livemode: true } }), /livemode_recovery_disabled/);
  assert.throws(() => deadLetterSnapshot({ payloadRedactedAt: "2026-07-17T01:00:00.000Z" }), /payload_redacted/);
  assert.throws(() => deadLetterSnapshot({ payload: { id: "evt_changed_private" } }), /payload_identity_mismatch/);
  assert.throws(() => deadLetterSnapshot({ payload: { type: "radar.early_fraud_warning.created" } }), /event_type_unresolved/);
});

test("one-field ingress evidence tampering fails closed before recovery authorization", () => {
  const original = databaseRow(deadLetterSnapshot());
  const mutations = [
    { event_type: "refund.created" },
    { ingress_event_id: "evt_tampered_001" },
    { ingress_event_type: "refund.created" },
    { ingress_created: original.ingress_created + 1 },
    { ingress_livemode: true },
    { ingress_api_version: "2025-01-01.unknown" },
    { ingress_payload_sha256: "0".repeat(64) },
    { ingress_raw_sha256: "1".repeat(64) },
    { raw_payload_text: `${original.raw_payload_text} ` },
    {
      payload_text: JSON.stringify({
        ...JSON.parse(original.payload_text),
        data: { object: { id: "re_tampered" } },
      }),
    },
  ];

  for (const mutation of mutations) {
    assert.throws(
      () => snapshotFromRow(
        { ...original, ...mutation },
        EVENT_ID,
        "a".repeat(64),
        "11111111-1111-4111-8111-111111111111",
      ),
      /payload_identity_mismatch|ingress_evidence_mismatch/,
      JSON.stringify(Object.keys(mutation)),
    );
  }
});

test("only an untouched attempt-8 dead letter may receive one attempt-9 authorization", () => {
  validateNewRecoveryState(deadLetterSnapshot());
  assert.throws(
    () => validateNewRecoveryState(deadLetterSnapshot({ processingStatus: "processed" })),
    /event_not_dead_letter/,
  );
  assert.throws(
    () => validateNewRecoveryState(deadLetterSnapshot({ attemptCount: 7 })),
    /attempt_cap_mismatch/,
  );
  assert.throws(
    () => validateNewRecoveryState(deadLetterSnapshot({ attemptCount: 9 })),
    /attempt_cap_mismatch/,
  );
  assert.throws(
    () => validateNewRecoveryState(deadLetterSnapshot({ pendingRecoveryAuditId: RECOVERY_ID })),
    /terminal_state_inconsistent/,
  );
});

test("atomic claim writes one digest-only audit row and claims only the exact event", async () => {
  const snapshot = deadLetterSnapshot();
  const statements = [];
  let auditParameters = null;
  const client = {
    async query(text, params = []) {
      statements.push(text.trim());
      if (text === "begin" || text === "commit" || text === "rollback") return { rows: [] };
      if (text.includes("to_regclass('public.sidestream_stripe_event_recovery_audit')")) {
        return {
          rows: [{
            audit_table: "sidestream_stripe_event_recovery_audit",
            queue_column: true,
            production_events_present: false,
            database_environment: "test",
            database_instance_id: "11111111-1111-4111-8111-111111111111",
          }],
        };
      }
      if (text.includes("from public.sidestream_stripe_events") && text.includes("for update")) {
        assert.deepEqual(params, [EVENT_ID]);
        return { rows: [databaseRow(snapshot)] };
      }
      if (text.includes("from public.sidestream_stripe_event_recovery_audit")) {
        return { rows: [] };
      }
      if (text.includes("insert into public.sidestream_stripe_event_recovery_audit")) {
        auditParameters = params;
        return { rows: [] };
      }
      if (text.includes("update public.sidestream_stripe_events")) {
        assert.equal(params[0], EVENT_ID);
        assert.equal(params[1], RECOVERY_ID);
        assert.equal(params[3], STRIPE_EVENT_MAX_ATTEMPTS);
        return { rows: [databaseRow(processingSnapshot())] };
      }
      throw new Error("unexpected query");
    },
  };

  const result = await atomicallyClaimStripeDeadLetter({
    client,
    eventId: EVENT_ID,
    cliOptions: validApplyOptions(snapshot),
    targetFingerprint: snapshot.targetFingerprint,
    createRecoveryId: () => RECOVERY_ID,
  });
  assert.equal(result.action, "claimed");
  assert.equal(result.claimed.attemptCount, STRIPE_EVENT_RECOVERY_ATTEMPT);
  assert.equal(statements[0], "begin");
  assert.equal(statements.at(-1), "commit");
  assert.ok(auditParameters);
  assert.doesNotMatch(JSON.stringify(auditParameters), new RegExp(EVENT_ID));
  assert.ok(statements.every((statement) => !/sidestream_licenses|sidestream_license_tokens/.test(statement)));
});

test("atomic claim refuses a database containing any livemode Stripe event", async () => {
  const statements = [];
  const client = {
    async query(text) {
      statements.push(text.trim());
      if (text === "begin" || text === "rollback") return { rows: [] };
      if (text.includes("to_regclass('public.sidestream_stripe_event_recovery_audit')")) {
        return {
          rows: [{
            audit_table: "sidestream_stripe_event_recovery_audit",
            queue_column: true,
            production_events_present: true,
            database_environment: "test",
            database_instance_id: "11111111-1111-4111-8111-111111111111",
          }],
        };
      }
      throw new Error("unexpected query");
    },
  };
  await assert.rejects(
    atomicallyClaimStripeDeadLetter({
      client,
      eventId: EVENT_ID,
      cliOptions: validApplyOptions(deadLetterSnapshot()),
      targetFingerprint: "a".repeat(64),
    }),
    /production_recovery_disabled/,
  );
  assert.equal(statements.at(-1), "rollback");
});

test("a concurrent attempt-9 invocation cannot process an active recovery lease", async () => {
  const initial = deadLetterSnapshot();
  const cliOptions = validApplyOptions(initial);
  const request = buildRecoveryRequest(cliOptions, initial);
  const active = processingSnapshot({
    recoveryRunnerLeaseExpiresAt: "2099-07-17T00:10:00.000Z",
  });
  const statements = [];
  const client = {
    async query(text) {
      statements.push(text.trim());
      if (text === "begin" || text === "commit") return { rows: [] };
      if (text.includes("to_regclass('public.sidestream_stripe_event_recovery_audit')")) {
        return {
          rows: [{
            audit_table: "sidestream_stripe_event_recovery_audit",
            queue_column: true,
            production_events_present: false,
            database_environment: "test",
            database_instance_id: active.databaseInstanceId,
          }],
        };
      }
      if (text.includes("from public.sidestream_stripe_events") && text.includes("for update")) {
        return { rows: [databaseRow(active)] };
      }
      if (text.includes("from public.sidestream_stripe_event_recovery_audit")) {
        return {
          rows: [{
            id: RECOVERY_ID,
            request_digest: request.requestDigest,
            event_reference_digest: request.eventReferenceDigest,
            event_type: request.eventType,
            payload_digest: request.payloadDigest,
            target_fingerprint: request.targetFingerprint,
            license_namespace: "test",
            reviewed_reason_code: request.reason,
            prior_processing_status: "dead_letter",
            prior_attempt_count: STRIPE_EVENT_MAX_ATTEMPTS,
            database_instance_id: active.databaseInstanceId,
          }],
        };
      }
      throw new Error("active recovery lease must not be mutated");
    },
  };

  const result = await atomicallyClaimStripeDeadLetter({
    client,
    eventId: EVENT_ID,
    cliOptions,
    targetFingerprint: active.targetFingerprint,
    createRunnerToken: () => "00000000-0000-4000-8000-000000000903",
  });
  assert.equal(result.action, "busy");
  assert.equal(result.claimed, null);
  assert.equal(statements.at(-1), "commit");
  assert.equal(statements.some((statement) => statement.startsWith("update ")), false);
});

test("lost response after atomic authorization resumes exactly once", async () => {
  const initial = deadLetterSnapshot();
  const cliOptions = validApplyOptions(initial);
  let state = initial;
  let auditRows = 0;
  let processCalls = 0;
  let loseAtomicResponse = true;

  const atomicClaim = async () => {
    if (!auditRows) {
      auditRows += 1;
      state = processingSnapshot();
      if (loseAtomicResponse) {
        loseAtomicResponse = false;
        throw new Error("simulated_lost_response");
      }
      return { action: "claimed", snapshot: state, claimed: claimedFrom(state) };
    }
    return { action: "resumed", snapshot: state, claimed: claimedFrom(state) };
  };
  const execute = () => runStripeDeadLetterRecovery({
    cliOptions,
    inspect: async () => state,
    atomicClaim,
    processClaimedEvent: async () => {
      processCalls += 1;
      state = processedSnapshot();
      return { status: "processed", outcome: "lifecycle_active", durationMs: 4 };
    },
  });

  await assert.rejects(execute(), /simulated_lost_response/);
  const retry = await execute();
  assert.equal(retry.action, "resumed");
  assert.equal(retry.processingStatus, "processed");
  assert.equal(auditRows, 1);
  assert.equal(processCalls, 1);
});

test("lost response after processing is an idempotent no-op replay", async () => {
  const initial = deadLetterSnapshot();
  const cliOptions = validApplyOptions(initial);
  let state = initial;
  let auditRows = 0;
  let processCalls = 0;

  const execute = () => runStripeDeadLetterRecovery({
    cliOptions,
    inspect: async () => state,
    atomicClaim: async () => {
      if (!auditRows) {
        auditRows += 1;
        state = processingSnapshot();
        return { action: "claimed", snapshot: state, claimed: claimedFrom(state) };
      }
      return { action: "already_applied", snapshot: state, claimed: null };
    },
    processClaimedEvent: async () => {
      processCalls += 1;
      state = processedSnapshot();
      throw new Error("simulated_result_lost");
    },
  });

  await assert.rejects(execute(), /simulated_result_lost/);
  const retry = await execute();
  assert.equal(retry.action, "already_applied");
  assert.equal(retry.processingStatus, "processed");
  assert.equal(auditRows, 1);
  assert.equal(processCalls, 1);
});

test("source delegates to the bounded processor and has no audit deletion or entitlement mutation", async () => {
  const [script, stripeEvents] = await Promise.all([
    readFile(new URL("../scripts/recover-stripe-dead-letter.mjs", import.meta.url), "utf8"),
    readFile(new URL("../api/_lib/stripe-events.ts", import.meta.url), "utf8"),
  ]);
  assert.match(script, /processClaimedStripeEvent\(claimed/);
  assert.match(script, /maxAttempts: STRIPE_EVENT_MAX_ATTEMPTS/);
  assert.match(script, /where event_id = \$1/);
  assert.match(script, /where payload ->> 'livemode' = 'true'/);
  assert.doesNotMatch(script, /update public\.sidestream_licenses/i);
  assert.doesNotMatch(script, /update public\.sidestream_license_tokens/i);
  assert.doesNotMatch(script, /delete\s+from\s+public\.sidestream_stripe_event_recovery_audit/i);
  const drain = stripeEvents.indexOf("export async function drainStripeEventQueue");
  const processor = stripeEvents.indexOf("export async function processClaimedStripeEvent");
  assert.ok(drain >= 0 && processor > drain);
  assert.match(stripeEvents.slice(drain, processor), /processClaimedStripeEvent\(row/);
});

test("apply-only runtime loader exposes the real bounded processor without network access", async () => {
  const runtime = await loadStripeEventsRuntime(new URL("..", import.meta.url).pathname);
  try {
    assert.equal(typeof runtime.stripeEvents.processClaimedStripeEvent, "function");
  } finally {
    await runtime.cleanup();
  }
});

function validApplyArguments(snapshot) {
  const report = buildSafeRecoveryReport(snapshot);
  return [
    "--apply",
    "--event-id", EVENT_ID,
    "--license-namespace", "test",
    "--target-fingerprint", snapshot.targetFingerprint,
    "--expected-payload-digest", snapshot.payloadDigest,
    "--expected-terminal-state", "dead_letter",
    "--reason", "handler_fix_verified",
    "--confirm", report.requiredConfirmation,
  ];
}

function validApplyOptions(snapshot) {
  return parseRecoveryArgs(validApplyArguments(snapshot));
}

function replaceOption(arguments_, name, value) {
  const result = [...arguments_];
  result[result.indexOf(name) + 1] = value;
  return result;
}

function deadLetterSnapshot(overrides = {}) {
  const payloadOverrides = overrides.payload || {};
  const payload = {
    id: EVENT_ID,
    type: "refund.failed",
    created: 1_752_710_400,
    livemode: false,
    api_version: "2026-06-24.dahlia",
    data: {
      object: {
        id: "re_private",
        customer: "cus_private",
        payment_intent: "pi_private",
        email: "private@example.com",
      },
    },
    ...payloadOverrides,
  };
  const processingStatus = overrides.processingStatus || "dead_letter";
  const attemptCount = overrides.attemptCount ?? STRIPE_EVENT_MAX_ATTEMPTS;
  const pendingRecoveryAuditId = overrides.pendingRecoveryAuditId ?? null;
  const terminal = ["dead_letter", "processed", "ignored"].includes(processingStatus);
  const payloadText = JSON.stringify(payload);
  const rawPayloadText = payloadText;
  return snapshotFromRow({
    event_type: payload.type,
    stripe_created_at: "2025-07-17T00:00:00.000Z",
    received_at: "2026-07-17T00:00:01.000Z",
    processed_at: processingStatus === "processed" ? "2026-07-17T00:06:00.000Z" : null,
    processing_status: processingStatus,
    attempt_count: attemptCount,
    claim_token: processingStatus === "processing" ? RECOVERY_ID : null,
    lease_expires_at: processingStatus === "processing" ? "2026-07-17T00:10:00.000Z" : null,
    next_attempt_at: "2026-07-17T00:05:00.000Z",
    last_error_code: "test_failure",
    outcome: processingStatus === "processed" ? "lifecycle_active" : "dead_letter",
    processing_started_at: "2026-07-17T00:04:00.000Z",
    processing_duration_ms: 20,
    terminal_at: terminal ? "2026-07-17T00:06:00.000Z" : null,
    payload_redacted_at: overrides.payloadRedactedAt ?? null,
    payload_text: payloadText,
    raw_payload_text: rawPayloadText,
    ingress_event_id: payload.id,
    ingress_event_type: payload.type,
    ingress_created: payload.created,
    ingress_livemode: payload.livemode,
    ingress_api_version: payload.api_version,
    ingress_payload_sha256: canonicalJsonDigest(payload),
    ingress_raw_sha256: sha256(rawPayloadText),
    recovery_runner_token: processingStatus === "processing"
      ? overrides.recoveryRunnerToken || "00000000-0000-4000-8000-000000000902"
      : null,
    recovery_runner_lease_expires_at: processingStatus === "processing"
      ? overrides.recoveryRunnerLeaseExpiresAt || "2026-07-17T00:10:00.000Z"
      : null,
    recovery_runner_epoch: processingStatus === "processing" ? 1 : 0,
    pending_recovery_audit_id: pendingRecoveryAuditId,
    updated_at: "2026-07-17T00:06:00.000Z",
  }, EVENT_ID, "a".repeat(64), "11111111-1111-4111-8111-111111111111");
}

function processingSnapshot(overrides = {}) {
  return deadLetterSnapshot({
    ...overrides,
    processingStatus: "processing",
    attemptCount: STRIPE_EVENT_RECOVERY_ATTEMPT,
    pendingRecoveryAuditId: RECOVERY_ID,
  });
}

function processedSnapshot() {
  return deadLetterSnapshot({
    processingStatus: "processed",
    attemptCount: STRIPE_EVENT_RECOVERY_ATTEMPT,
    pendingRecoveryAuditId: RECOVERY_ID,
  });
}

function claimedFrom(snapshot) {
  return {
    eventId: snapshot.eventId,
    eventType: snapshot.eventType,
    stripeCreatedAt: snapshot.stripeCreatedAt,
    payload: snapshot.payload,
    rawPayload: snapshot.rawPayloadText,
    ingressEventId: snapshot.ingressEventId,
    ingressEventType: snapshot.ingressEventType,
    ingressPayloadSha256: snapshot.ingressPayloadDigest,
    ingressRawSha256: snapshot.ingressRawDigest,
    ingressApiVersion: snapshot.ingressApiVersion,
    ingressLivemode: snapshot.ingressLivemode,
    ingressCreated: snapshot.ingressCreated,
    attemptCount: snapshot.attemptCount,
    claimToken: snapshot.claimToken,
  };
}

function databaseRow(snapshot) {
  return {
    event_type: snapshot.eventType,
    stripe_created_at: snapshot.stripeCreatedAt,
    received_at: snapshot.receivedAt,
    processed_at: snapshot.processedAt,
    processing_status: snapshot.processingStatus,
    attempt_count: snapshot.attemptCount,
    claim_token: snapshot.claimToken || null,
    lease_expires_at: snapshot.leaseExpiresAt,
    next_attempt_at: snapshot.nextAttemptAt,
    last_error_code: snapshot.lastErrorCode,
    outcome: snapshot.outcomeCode,
    processing_started_at: snapshot.processingStartedAt,
    processing_duration_ms: snapshot.processingDurationMs,
    terminal_at: snapshot.terminalAt,
    payload_redacted_at: snapshot.payloadRedactedAt,
    payload_text: snapshot.payloadText,
    raw_payload_text: snapshot.rawPayloadText,
    ingress_event_id: snapshot.ingressEventId,
    ingress_event_type: snapshot.ingressEventType,
    ingress_created: snapshot.ingressCreated,
    ingress_livemode: snapshot.ingressLivemode,
    ingress_api_version: snapshot.ingressApiVersion,
    ingress_payload_sha256: snapshot.ingressPayloadDigest,
    ingress_raw_sha256: snapshot.ingressRawDigest,
    recovery_runner_token: snapshot.recoveryRunnerToken || null,
    recovery_runner_lease_expires_at: snapshot.recoveryRunnerLeaseExpiresAt,
    recovery_runner_epoch: snapshot.recoveryRunnerEpoch,
    pending_recovery_audit_id: snapshot.pendingRecoveryAuditId || null,
    updated_at: snapshot.updatedAt,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJsonDigest(value) {
  return sha256(JSON.stringify(sortJsonValue(JSON.parse(JSON.stringify(value)))));
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, sortJsonValue(entry)]));
}

#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parsePostgresTarget } from "../api/_lib/postgres-target.ts";

export const TEST_DATABASE_ENV = "SIDESTREAM_TEST_POSTGRES_URL";
export const TEST_LICENSE_NAMESPACE = "test";
export const STRIPE_EVENT_MAX_ATTEMPTS = 8;
export const STRIPE_EVENT_RECOVERY_ATTEMPT = 9;
export const STRIPE_EVENT_RECOVERY_LEASE_MS = 5 * 60 * 1_000;
export const SUPPORTED_RECOVERY_API_VERSIONS = Object.freeze([
  "2026-06-24.dahlia",
]);
export const RECOVERY_REASONS = Object.freeze([
  "handler_fix_verified",
  "canonical_state_repair",
  "test_rehearsal",
]);

const RUNTIME_DATABASE_ENV_NAMES = Object.freeze([
  "SIDESTREAM_PRODUCTION_POSTGRES_URL",
  "SIDESTREAM_PRODUCTION_POSTGRES_PRISMA_URL",
  "SIDESTREAM_POSTGRES_URL",
  "SIDESTREAM_POSTGRES_PRISMA_URL",
  "SIDESTREAM_POSTGRES_URL_NON_POOLING",
  "SIDESTREAM_PREVIEW_POSTGRES_URL",
  "SIDESTREAM_PREVIEW_POSTGRES_PRISMA_URL",
  "SIDESTREAM_DEPLOYED_TEST_POSTGRES_URL",
  "SIDESTREAM_TEST_RUNTIME_POSTGRES_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
  "SIDESTREAM_TELEMETRY_POSTGRES_URL",
  "TELEMETRY_POSTGRES_URL",
  "DATABASE_URL",
  "PREVIEW_DATABASE_URL",
  "TEST_DATABASE_URL",
]);

const RECOVERABLE_EVENT_PREFIXES = Object.freeze([
  "checkout.session.",
  "payment_intent.",
  "charge.dispute.",
  "charge.",
  "refund.",
  "invoice.",
  "customer.subscription.",
  "customer.discount.",
  "discount.",
  "customer_cash_balance_transaction.",
  "customer.balance_transaction.",
]);

const TARGET_SQL = `
  select
    current_database() as database_name,
    current_user as database_user,
    coalesce(inet_server_addr()::text, 'local') as server_address,
    coalesce(inet_server_port(), 0) as server_port,
    identity.environment as database_environment,
    identity.instance_id::text as database_instance_id,
    identity.provider_resource_id
  from public.sidestream_database_identity identity
  where identity.singleton = true
`;

const EVENT_SELECT = `
  select
    event_type,
    stripe_created_at,
    received_at,
    processed_at,
    processing_status,
    attempt_count,
    claim_token,
    lease_expires_at,
    next_attempt_at,
    last_error_code,
    outcome,
    processing_started_at,
    processing_duration_ms,
    terminal_at,
    payload_redacted_at,
    payload::text as payload_text,
    raw_payload as raw_payload_text,
    ingress_event_id,
    ingress_event_type,
    ingress_created,
    ingress_livemode,
    ingress_api_version,
    ingress_payload_sha256,
    ingress_raw_sha256,
    recovery_runner_token,
    recovery_runner_lease_expires_at,
    recovery_runner_epoch,
    to_jsonb(public.sidestream_stripe_events) ->> 'pending_recovery_audit_id'
      as pending_recovery_audit_id,
    updated_at
  from public.sidestream_stripe_events
  where event_id = $1
`;

export class StripeDeadLetterRecoveryError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "StripeDeadLetterRecoveryError";
    this.code = code;
  }
}

export function parseRecoveryArgs(argv) {
  const options = {
    apply: false,
    selfTest: false,
    help: false,
    eventId: "",
    licenseNamespace: "",
    targetFingerprint: "",
    expectedPayloadDigest: "",
    expectedTerminalState: "",
    reason: "",
    confirmation: "",
  };
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      if (options.apply) throw cliError("duplicate_option", "--apply may be supplied only once.");
      options.apply = true;
    } else if (argument === "--self-test") {
      if (options.selfTest) throw cliError("duplicate_option", "--self-test may be supplied only once.");
      options.selfTest = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      const names = [
        ["--event-id", "eventId"],
        ["--license-namespace", "licenseNamespace"],
        ["--target-fingerprint", "targetFingerprint"],
        ["--expected-payload-digest", "expectedPayloadDigest"],
        ["--expected-terminal-state", "expectedTerminalState"],
        ["--reason", "reason"],
        ["--confirm", "confirmation"],
      ];
      const matched = names.find(([name]) =>
        argument === name || argument.startsWith(`${name}=`)
      );
      if (!matched) {
        throw cliError(
          "unsupported_selector",
          "Unknown option. Bulk replay, production recovery, cap overrides, and audit mutation are unavailable.",
        );
      }
      const [name, property] = matched;
      if (seen.has(name)) throw cliError("duplicate_option", `${name} may be supplied only once.`);
      seen.add(name);
      [options[property], index] = readOption(argv, index, name);
    }
  }

  if (options.selfTest || options.help) {
    if (argv.length !== 1) {
      throw cliError("exclusive_mode", "--self-test and --help must be used alone.");
    }
    return Object.freeze(options);
  }
  if (!/^evt_[A-Za-z0-9_]{3,251}$/.test(options.eventId)) {
    throw cliError("exact_event_required", "An exact Stripe --event-id is required.");
  }
  if (!options.licenseNamespace) options.licenseNamespace = TEST_LICENSE_NAMESPACE;
  if (options.licenseNamespace !== TEST_LICENSE_NAMESPACE) {
    throw cliError(
      "production_recovery_disabled",
      "Only licenseNamespace=test is supported; Production recovery is disabled.",
    );
  }

  const applyOnlyValues = [
    options.targetFingerprint,
    options.expectedPayloadDigest,
    options.expectedTerminalState,
    options.reason,
    options.confirmation,
  ];
  if (!options.apply) {
    if (applyOnlyValues.some(Boolean)) {
      throw cliError("read_only_options", "Apply expectations require --apply.");
    }
    return Object.freeze(options);
  }
  if (!seen.has("--license-namespace")) {
    throw cliError("explicit_test_namespace_required", "Apply requires --license-namespace test.");
  }
  if (!isHexDigest(options.targetFingerprint)) {
    throw cliError("target_fingerprint_required", "Apply requires the exact 64-character target fingerprint.");
  }
  if (!isHexDigest(options.expectedPayloadDigest)) {
    throw cliError("payload_digest_required", "Apply requires the exact 64-character payload digest.");
  }
  if (options.expectedTerminalState !== "dead_letter") {
    throw cliError(
      "dead_letter_expectation_required",
      "Apply requires --expected-terminal-state dead_letter.",
    );
  }
  if (!RECOVERY_REASONS.includes(options.reason)) {
    throw cliError(
      "reviewed_reason_required",
      `Apply requires a reviewed reason code: ${RECOVERY_REASONS.join(", ")}.`,
    );
  }
  if (!options.confirmation) {
    throw cliError("confirmation_required", "Apply requires the exact confirmation from read-only output.");
  }
  return Object.freeze(options);
}

export function selectRecoveryDatabase(environment = process.env, { apply = false } = {}) {
  if (
    configuredValue(environment.SIDESTREAM_LICENSE_NAMESPACE) &&
    configuredValue(environment.SIDESTREAM_LICENSE_NAMESPACE).toLowerCase() !== "test"
  ) {
    throw recoveryError("production_recovery_disabled");
  }
  if (apply && configuredValue(environment.VERCEL_ENV).toLowerCase() === "production") {
    throw recoveryError("production_recovery_disabled");
  }
  const connectionString = configuredValue(environment[TEST_DATABASE_ENV]);
  if (!connectionString) throw recoveryError("test_database_required");
  let selected;
  try {
    selected = parsePostgresTarget(connectionString, TEST_DATABASE_ENV);
  } catch {
    throw recoveryError("test_database_url_invalid");
  }
  for (const name of RUNTIME_DATABASE_ENV_NAMES) {
    const runtimeConnectionString = configuredValue(environment[name]);
    if (!runtimeConnectionString) continue;
    let runtime;
    try {
      runtime = parsePostgresTarget(runtimeConnectionString, name);
    } catch {
      throw recoveryError("runtime_database_url_invalid");
    }
    if (runtime.endpoint === selected.endpoint) {
      throw recoveryError("test_database_not_isolated");
    }
  }
  if (apply && !/^sk_test_[A-Za-z0-9_]+$/.test(configuredValue(environment.STRIPE_SECRET_KEY))) {
    throw recoveryError("stripe_test_key_required");
  }
  return Object.freeze({
    connectionString: selected.connectionString,
    local: selected.local,
    ssl: selected.ssl,
  });
}

export function createRecoveryPoolOptions(selected) {
  let target;
  try {
    target = parsePostgresTarget(selected.connectionString, TEST_DATABASE_ENV);
  } catch {
    throw recoveryError("test_database_url_invalid");
  }
  return Object.freeze({
    connectionString: target.connectionString,
    application_name: "sidestream-test-dead-letter-recovery",
    max: 2,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    ssl: target.ssl,
  });
}

export async function inspectStripeDeadLetter(query, eventId) {
  const targetResult = await query(TARGET_SQL);
  const target = targetResult.rows[0];
  if (!target) throw recoveryError("target_fingerprint_unavailable");
  if (
    target.database_environment !== "test" ||
    !isUuid(String(target.database_instance_id || "")) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,239}$/.test(String(target.provider_resource_id || ""))
  ) {
    throw recoveryError("database_test_identity_required");
  }
  const targetFingerprint = sha256([
    "sidestream-stripe-recovery-target:v2",
    target.server_address,
    target.server_port,
    target.database_name,
    target.database_user,
    target.database_instance_id,
    target.provider_resource_id,
  ].join("\0"));
  const result = await query(EVENT_SELECT, [eventId]);
  if (!result.rows[0]) throw recoveryError("event_not_found");
  return snapshotFromRow(
    result.rows[0],
    eventId,
    targetFingerprint,
    String(target.database_instance_id),
  );
}

export function snapshotFromRow(row, eventId, targetFingerprint, databaseInstanceId = "") {
  const payloadText = typeof row.payload_text === "string"
    ? row.payload_text
    : JSON.stringify(row.payload_text);
  if (!payloadText) throw recoveryError("payload_unavailable");
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    throw recoveryError("payload_unavailable");
  }
  const snapshot = {
    eventId,
    eventReferenceDigest: sha256(`sidestream-stripe-event-reference:v1\0${eventId}`),
    eventType: stringValue(row.event_type),
    stripeCreatedAt: timestampValue(row.stripe_created_at),
    receivedAt: timestampValue(row.received_at),
    processedAt: timestampValue(row.processed_at),
    processingStatus: stringValue(row.processing_status),
    attemptCount: Number(row.attempt_count),
    claimToken: stringValue(row.claim_token),
    leaseExpiresAt: timestampValue(row.lease_expires_at),
    nextAttemptAt: timestampValue(row.next_attempt_at),
    lastErrorCode: nullableCode(row.last_error_code, 120),
    outcomeCode: nullableCode(row.outcome, 160),
    processingStartedAt: timestampValue(row.processing_started_at),
    processingDurationMs: nullableNonnegativeInteger(row.processing_duration_ms),
    terminalAt: timestampValue(row.terminal_at),
    payloadRedactedAt: timestampValue(row.payload_redacted_at),
    payloadText,
    payload,
    payloadDigest: canonicalJsonDigest(payload),
    rawPayloadText: stringValue(row.raw_payload_text),
    ingressEventId: stringValue(row.ingress_event_id),
    ingressEventType: stringValue(row.ingress_event_type),
    ingressCreated: Number(row.ingress_created),
    ingressLivemode: row.ingress_livemode,
    ingressApiVersion: stringValue(row.ingress_api_version),
    ingressPayloadDigest: stringValue(row.ingress_payload_sha256),
    ingressRawDigest: stringValue(row.ingress_raw_sha256),
    recoveryRunnerToken: stringValue(row.recovery_runner_token),
    recoveryRunnerLeaseExpiresAt: timestampValue(row.recovery_runner_lease_expires_at),
    recoveryRunnerEpoch: Number(row.recovery_runner_epoch || 0),
    pendingRecoveryAuditId: stringValue(row.pending_recovery_audit_id),
    updatedAt: timestampValue(row.updated_at),
    targetFingerprint,
    databaseInstanceId,
  };
  validatePayloadIdentity(snapshot);
  return Object.freeze(snapshot);
}

export function buildSafeRecoveryReport(snapshot, extras = {}) {
  validatePayloadIdentity(snapshot);
  const report = {
    mode: extras.mode || "read-only",
    action: extras.action || "inspect",
    licenseNamespace: TEST_LICENSE_NAMESPACE,
    targetFingerprint: snapshot.targetFingerprint,
    eventReferenceDigest: snapshot.eventReferenceDigest,
    eventType: snapshot.eventType,
    processingStatus: snapshot.processingStatus,
    attemptCount: snapshot.attemptCount,
    timestamps: {
      stripeCreatedAt: snapshot.stripeCreatedAt,
      receivedAt: snapshot.receivedAt,
      processingStartedAt: snapshot.processingStartedAt,
      processedAt: snapshot.processedAt,
      terminalAt: snapshot.terminalAt,
      nextAttemptAt: snapshot.nextAttemptAt,
      leaseExpiresAt: snapshot.leaseExpiresAt,
      updatedAt: snapshot.updatedAt,
    },
    processingDurationMs: snapshot.processingDurationMs,
    lastErrorCode: snapshot.lastErrorCode,
    outcomeCode: snapshot.outcomeCode,
    payloadDigest: snapshot.payloadDigest,
    recoveryState: recoveryState(snapshot),
    requiredConfirmation: exactRecoveryConfirmation(snapshot),
  };
  if (extras.processingResult) {
    report.processingResult = {
      status: extras.processingResult.status,
      outcome: extras.processingResult.outcome,
      durationMs: extras.processingResult.durationMs,
    };
  }
  return Object.freeze(report);
}

export function buildRecoveryRequest(options, snapshot) {
  validatePayloadIdentity(snapshot);
  if (!options.apply) throw recoveryError("apply_required");
  if (options.licenseNamespace !== TEST_LICENSE_NAMESPACE) {
    throw recoveryError("production_recovery_disabled");
  }
  if (options.targetFingerprint !== snapshot.targetFingerprint) {
    throw recoveryError("target_fingerprint_changed");
  }
  if (options.expectedPayloadDigest !== snapshot.payloadDigest) {
    throw recoveryError("payload_digest_changed");
  }
  if (options.expectedTerminalState !== "dead_letter") {
    throw recoveryError("dead_letter_expectation_required");
  }
  if (!RECOVERY_REASONS.includes(options.reason)) {
    throw recoveryError("reviewed_reason_required");
  }
  if (options.confirmation !== exactRecoveryConfirmation(snapshot)) {
    throw recoveryError("confirmation_mismatch");
  }
  const requestDigest = sha256([
    "sidestream-stripe-dead-letter-recovery:v1",
    TEST_LICENSE_NAMESPACE,
    snapshot.targetFingerprint,
    snapshot.eventReferenceDigest,
    snapshot.payloadDigest,
    snapshot.databaseInstanceId,
    options.expectedTerminalState,
    options.reason,
  ].join("\0"));
  return Object.freeze({
    requestDigest,
    eventReferenceDigest: snapshot.eventReferenceDigest,
    eventType: snapshot.eventType,
    payloadDigest: snapshot.payloadDigest,
    targetFingerprint: snapshot.targetFingerprint,
    databaseInstanceId: snapshot.databaseInstanceId,
    licenseNamespace: TEST_LICENSE_NAMESPACE,
    expectedTerminalState: options.expectedTerminalState,
    reason: options.reason,
  });
}

export function validateNewRecoveryState(snapshot) {
  validatePayloadIdentity(snapshot);
  if (snapshot.processingStatus !== "dead_letter" || !snapshot.terminalAt) {
    throw recoveryError("event_not_dead_letter");
  }
  if (snapshot.attemptCount !== STRIPE_EVENT_MAX_ATTEMPTS) {
    throw recoveryError("attempt_cap_mismatch");
  }
  if (
    snapshot.claimToken ||
    snapshot.leaseExpiresAt ||
    snapshot.pendingRecoveryAuditId ||
    snapshot.recoveryRunnerToken ||
    snapshot.recoveryRunnerLeaseExpiresAt ||
    snapshot.recoveryRunnerEpoch !== 0
  ) {
    throw recoveryError("terminal_state_inconsistent");
  }
}

export async function atomicallyClaimStripeDeadLetter(options) {
  const {
    client,
    eventId,
    cliOptions,
    targetFingerprint,
    createRecoveryId = randomUUID,
    createRunnerToken = randomUUID,
  } = options;
  const runnerToken = createRunnerToken();
  if (!isUuid(runnerToken)) throw recoveryError("recovery_runner_token_invalid");
  await client.query("begin");
  try {
    const schema = await client.query(`
      select
        to_regclass('public.sidestream_stripe_event_recovery_audit')::text as audit_table,
        exists (
          select 1
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'sidestream_stripe_events'
            and column_name = 'pending_recovery_audit_id'
        ) as queue_column,
        exists (
          select 1
          from public.sidestream_stripe_events
          where payload ->> 'livemode' = 'true'
        ) as production_events_present,
        (select environment from public.sidestream_database_identity where singleton = true)
          as database_environment,
        (select instance_id::text from public.sidestream_database_identity where singleton = true)
          as database_instance_id
    `);
    if (!schema.rows[0]?.audit_table || schema.rows[0]?.queue_column !== true) {
      throw recoveryError("recovery_schema_missing");
    }
    if (schema.rows[0]?.production_events_present === true) {
      throw recoveryError("production_recovery_disabled");
    }
    if (
      schema.rows[0]?.database_environment !== "test" ||
      !isUuid(String(schema.rows[0]?.database_instance_id || ""))
    ) {
      throw recoveryError("database_test_identity_required");
    }
    const locked = await client.query(`${EVENT_SELECT}\nfor update`, [eventId]);
    if (!locked.rows[0]) throw recoveryError("event_not_found");
    const snapshot = snapshotFromRow(
      locked.rows[0],
      eventId,
      targetFingerprint,
      String(schema.rows[0].database_instance_id),
    );
    const request = buildRecoveryRequest(cliOptions, snapshot);
    const existingResult = await client.query(`
      select
        id,
        request_digest,
        event_reference_digest,
        event_type,
        payload_digest,
        target_fingerprint,
        license_namespace,
        reviewed_reason_code,
        prior_processing_status,
        prior_attempt_count,
        database_instance_id::text as database_instance_id
      from public.sidestream_stripe_event_recovery_audit
      where request_digest = $1
      for share
    `, [request.requestDigest]);
    const existing = existingResult.rows[0];
    if (existing) {
      validateExistingAudit(existing, request, snapshot);
      if (
        snapshot.processingStatus === "processing" &&
        snapshot.claimToken === String(existing.id)
      ) {
        if (
          snapshot.recoveryRunnerLeaseExpiresAt &&
          Date.parse(snapshot.recoveryRunnerLeaseExpiresAt) > Date.now()
        ) {
          await client.query("commit");
          return Object.freeze({ action: "busy", snapshot, claimed: null });
        }
        const reclaimed = await client.query(`
          update public.sidestream_stripe_events
          set recovery_runner_token = $3::uuid,
              recovery_runner_lease_expires_at =
                clock_timestamp() + ($4::bigint * interval '1 millisecond'),
              recovery_runner_epoch = recovery_runner_epoch + 1,
              updated_at = now()
          where event_id = $1
            and claim_token = $2::uuid
            and processing_status = 'processing'
            and recovery_runner_lease_expires_at <= clock_timestamp()
          returning event_id
        `, [eventId, existing.id, runnerToken, STRIPE_EVENT_RECOVERY_LEASE_MS]);
        if (!reclaimed.rows[0]) throw recoveryError("recovery_runner_claim_lost");
        const reclaimedRow = await client.query(EVENT_SELECT, [eventId]);
        const reclaimedSnapshot = snapshotFromRow(
          reclaimedRow.rows[0],
          eventId,
          targetFingerprint,
          String(schema.rows[0].database_instance_id),
        );
        await client.query("commit");
        return Object.freeze({
          action: "reclaimed",
          snapshot: reclaimedSnapshot,
          claimed: claimedRow(reclaimedSnapshot),
        });
      }
      if (["processed", "ignored", "dead_letter"].includes(snapshot.processingStatus)) {
        await client.query("commit");
        return Object.freeze({ action: "already_applied", snapshot, claimed: null });
      }
      throw recoveryError("recovery_state_inconsistent");
    }

    validateNewRecoveryState(snapshot);
    const recoveryId = createRecoveryId();
    if (!isUuid(recoveryId)) throw recoveryError("recovery_id_invalid");
    await client.query(`
      insert into public.sidestream_stripe_event_recovery_audit (
        id,
        request_digest,
        event_reference_digest,
        event_type,
        payload_digest,
        target_fingerprint,
        license_namespace,
        reviewed_reason_code,
        prior_processing_status,
        prior_attempt_count,
        prior_terminal_at,
        prior_last_error_code,
        prior_outcome_code,
        database_instance_id
      ) values (
        $1::uuid, $2, $3, $4, $5, $6, 'test', $7, $8, $9, $10, $11, $12,
        $13::uuid
      )
    `, [
      recoveryId,
      request.requestDigest,
      request.eventReferenceDigest,
      request.eventType,
      request.payloadDigest,
      request.targetFingerprint,
      request.reason,
      snapshot.processingStatus,
      snapshot.attemptCount,
      snapshot.terminalAt,
      snapshot.lastErrorCode,
      snapshot.outcomeCode,
      snapshot.databaseInstanceId,
    ]);
    const claimedResult = await client.query(`
      update public.sidestream_stripe_events
      set processing_status = 'processing',
          attempt_count = attempt_count + 1,
          claim_token = $2::uuid,
          lease_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
          next_attempt_at = clock_timestamp(),
          processing_started_at = clock_timestamp(),
          processing_duration_ms = null,
          processed_at = null,
          terminal_at = null,
          outcome = null,
          pending_recovery_audit_id = $2::uuid,
          recovery_runner_token = $5::uuid,
          recovery_runner_lease_expires_at =
            clock_timestamp() + ($3::bigint * interval '1 millisecond'),
          recovery_runner_epoch = 1,
          updated_at = now()
      where event_id = $1
        and processing_status = 'dead_letter'
        and attempt_count = $4
        and terminal_at is not null
        and claim_token is null
        and lease_expires_at is null
        and pending_recovery_audit_id is null
      returning
        event_type,
        stripe_created_at,
        received_at,
        processed_at,
        processing_status,
        attempt_count,
        claim_token,
        lease_expires_at,
        next_attempt_at,
        last_error_code,
        outcome,
        processing_started_at,
        processing_duration_ms,
        terminal_at,
        payload_redacted_at,
        payload::text as payload_text,
        raw_payload as raw_payload_text,
        ingress_event_id,
        ingress_event_type,
        ingress_created,
        ingress_livemode,
        ingress_api_version,
        ingress_payload_sha256,
        ingress_raw_sha256,
        recovery_runner_token,
        recovery_runner_lease_expires_at,
        recovery_runner_epoch,
        pending_recovery_audit_id,
        updated_at
    `, [
      eventId,
      recoveryId,
      STRIPE_EVENT_RECOVERY_LEASE_MS,
      STRIPE_EVENT_MAX_ATTEMPTS,
      runnerToken,
    ]);
    if (!claimedResult.rows[0]) throw recoveryError("dead_letter_claim_lost");
    const claimedSnapshot = snapshotFromRow(
      claimedResult.rows[0],
      eventId,
      targetFingerprint,
      String(schema.rows[0].database_instance_id),
    );
    await client.query("commit");
    return Object.freeze({
      action: "claimed",
      snapshot: claimedSnapshot,
      claimed: claimedRow(claimedSnapshot),
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

export async function runStripeDeadLetterRecovery(options) {
  const snapshot = await options.inspect();
  if (!options.cliOptions.apply) {
    return buildSafeRecoveryReport(snapshot);
  }
  buildRecoveryRequest(options.cliOptions, snapshot);
  const claim = await options.atomicClaim();
  let processingResult = null;
  if (claim.claimed) {
    processingResult = await options.processClaimedEvent(claim.claimed);
  }
  const current = await options.inspect();
  return buildSafeRecoveryReport(current, {
    mode: "apply",
    action: claim.action,
    processingResult,
  });
}

export async function runRecoverySelfTest() {
  let atomicCalls = 0;
  let processorCalls = 0;
  const eventId = "evt_self_test_private";
  const snapshot = selfTestSnapshot(eventId);
  const readOptions = parseRecoveryArgs(["--event-id", eventId]);
  const report = await runStripeDeadLetterRecovery({
    cliOptions: readOptions,
    inspect: async () => snapshot,
    atomicClaim: async () => {
      atomicCalls += 1;
      throw new Error("read-only self-test attempted a database write");
    },
    processClaimedEvent: async () => {
      processorCalls += 1;
      throw new Error("read-only self-test attempted event processing");
    },
  });
  const serialized = JSON.stringify(report);
  assert.equal(atomicCalls, 0);
  assert.equal(processorCalls, 0);
  assert.doesNotMatch(serialized, /evt_self_test_private|cus_private|private@example\.com/);
  assert.throws(() => parseRecoveryArgs(["--all"]), /Bulk replay/);
  assert.throws(
    () => parseRecoveryArgs(["--event-id", eventId, "--license-namespace", "production"]),
    /Production recovery is disabled/,
  );
  return Object.freeze({
    networkConnections: 0,
    databaseWrites: atomicCalls,
    processorCalls,
    safeReport: true,
  });
}

function validatePayloadIdentity(snapshot) {
  if (snapshot.payloadRedactedAt || snapshot.payload?.redacted === true) {
    throw recoveryError("payload_redacted");
  }
  if (
    !snapshot.payload ||
    typeof snapshot.payload !== "object" ||
    snapshot.payload.id !== snapshot.eventId ||
    snapshot.payload.type !== snapshot.eventType ||
    !Number.isSafeInteger(snapshot.payload.created) ||
    snapshot.payload.created < 0
  ) {
    throw recoveryError("payload_identity_mismatch");
  }
  const storedCreated = Math.floor(Date.parse(snapshot.stripeCreatedAt) / 1_000);
  if (
    snapshot.ingressEventId !== snapshot.eventId ||
    snapshot.ingressEventType !== snapshot.eventType ||
    snapshot.ingressCreated !== snapshot.payload.created ||
    snapshot.ingressCreated !== storedCreated ||
    snapshot.ingressLivemode !== snapshot.payload.livemode ||
    snapshot.ingressPayloadDigest !== snapshot.payloadDigest ||
    !snapshot.rawPayloadText ||
    snapshot.ingressRawDigest !== sha256(snapshot.rawPayloadText) ||
    snapshot.ingressApiVersion !== snapshot.payload.api_version ||
    !SUPPORTED_RECOVERY_API_VERSIONS.includes(snapshot.ingressApiVersion) ||
    !isUuid(snapshot.databaseInstanceId)
  ) {
    throw recoveryError("ingress_evidence_mismatch");
  }
  if (snapshot.payload.livemode !== false) {
    throw recoveryError("livemode_recovery_disabled");
  }
  if (!isResolvedStripeEventType(snapshot.eventType)) {
    throw recoveryError("event_type_unresolved");
  }
  if (!Number.isSafeInteger(snapshot.attemptCount) || snapshot.attemptCount < 0) {
    throw recoveryError("attempt_count_invalid");
  }
}

export function isResolvedStripeEventType(eventType) {
  return typeof eventType === "string" &&
    RECOVERABLE_EVENT_PREFIXES.some((prefix) => eventType.startsWith(prefix));
}

function validateExistingAudit(audit, request, snapshot) {
  const matches =
    String(audit.request_digest) === request.requestDigest &&
    String(audit.event_reference_digest) === request.eventReferenceDigest &&
    String(audit.event_type) === request.eventType &&
    String(audit.payload_digest) === request.payloadDigest &&
    String(audit.target_fingerprint) === request.targetFingerprint &&
    String(audit.license_namespace) === TEST_LICENSE_NAMESPACE &&
    String(audit.reviewed_reason_code) === request.reason &&
    String(audit.prior_processing_status) === request.expectedTerminalState &&
    Number(audit.prior_attempt_count) === STRIPE_EVENT_MAX_ATTEMPTS;
  const instanceMatches = String(audit.database_instance_id) === snapshot.databaseInstanceId;
  if (!matches || !instanceMatches) throw recoveryError("recovery_audit_mismatch");
  if (snapshot.pendingRecoveryAuditId !== String(audit.id)) {
    throw recoveryError("recovery_state_inconsistent");
  }
}

function claimedRow(snapshot) {
  if (
    snapshot.processingStatus !== "processing" ||
    snapshot.attemptCount !== STRIPE_EVENT_RECOVERY_ATTEMPT ||
    !isUuid(snapshot.claimToken)
  ) {
    throw recoveryError("recovery_claim_invalid");
  }
  return Object.freeze({
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
  });
}

function recoveryState(snapshot) {
  if (!snapshot.pendingRecoveryAuditId) return "not_authorized";
  if (snapshot.processingStatus === "processing") return "processing";
  if (["processed", "ignored", "dead_letter"].includes(snapshot.processingStatus)) {
    return "completed";
  }
  return "inconsistent";
}

function exactRecoveryConfirmation(snapshot) {
  return `RECOVER-TEST-DEAD-LETTER:${snapshot.eventReferenceDigest.slice(0, 16)}:${snapshot.payloadDigest.slice(0, 16)}`;
}

function selfTestSnapshot(eventId) {
  const payload = {
    id: eventId,
    type: "refund.failed",
    created: 1_752_710_400,
    livemode: false,
    api_version: SUPPORTED_RECOVERY_API_VERSIONS[0],
    data: {
      object: {
        id: "re_private",
        customer: "cus_private",
        email: "private@example.com",
      },
    },
  };
  return snapshotFromRow({
    event_type: payload.type,
    stripe_created_at: "2025-07-17T00:00:00.000Z",
    received_at: "2026-07-17T00:00:01.000Z",
    processed_at: null,
    processing_status: "dead_letter",
    attempt_count: STRIPE_EVENT_MAX_ATTEMPTS,
    claim_token: null,
    lease_expires_at: null,
    next_attempt_at: "2026-07-17T00:05:00.000Z",
    last_error_code: "test_failure",
    outcome: "dead_letter",
    processing_started_at: "2026-07-17T00:04:00.000Z",
    processing_duration_ms: 20,
    terminal_at: "2026-07-17T00:04:01.000Z",
    payload_redacted_at: null,
    payload_text: JSON.stringify(payload),
    raw_payload_text: JSON.stringify(payload),
    ingress_event_id: payload.id,
    ingress_event_type: payload.type,
    ingress_created: payload.created,
    ingress_livemode: payload.livemode,
    ingress_api_version: payload.api_version,
    ingress_payload_sha256: canonicalJsonDigest(payload),
    ingress_raw_sha256: sha256(JSON.stringify(payload)),
    recovery_runner_token: null,
    recovery_runner_lease_expires_at: null,
    recovery_runner_epoch: 0,
    pending_recovery_audit_id: null,
    updated_at: "2026-07-17T00:04:01.000Z",
  }, eventId, "a".repeat(64), "11111111-1111-4111-8111-111111111111");
}

async function loadPostgresModule() {
  try {
    return await import("pg");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      throw recoveryError("dependencies_unavailable");
    }
    throw error;
  }
}

export async function loadStripeEventsRuntime(worktreeRoot) {
  const dependencyRoot = await findDependencyRoot(worktreeRoot);
  const typescriptModule = await import("typescript").catch((error) => {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      throw recoveryError("dependencies_unavailable");
    }
    throw error;
  });
  const ts = typescriptModule.default || typescriptModule;
  const directory = await mkdtemp(path.join(tmpdir(), "sidestream-stripe-recovery-"));
  try {
    await writeFile(path.join(directory, "package.json"), '{"type":"module"}\n', { mode: 0o600 });
    await symlink(path.join(dependencyRoot, "node_modules"), path.join(directory, "node_modules"), "dir");
    const compilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      rootDir: worktreeRoot,
      outDir: directory,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      noEmitOnError: false,
    };
    const program = ts.createProgram([
      path.join(worktreeRoot, "api/_lib/stripe-events.ts"),
    ], compilerOptions);
    const emitResult = program.emit();
    const errors = program.getSyntacticDiagnostics()
      .concat(emitResult.diagnostics)
      .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    if (errors.length) {
      throw recoveryError("runtime_compile_failed");
    }
    const stripeEvents = await import(pathToFileURL(
      path.join(directory, "api/_lib/stripe-events.js"),
    ).href);
    return Object.freeze({
      stripeEvents,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function findDependencyRoot(worktreeRoot) {
  try {
    await access(path.join(worktreeRoot, "node_modules"));
    return worktreeRoot;
  } catch {
    throw recoveryError("dependencies_unavailable");
  }
}

function configureTestProcessingEnvironment(environment, connectionString) {
  for (const name of RUNTIME_DATABASE_ENV_NAMES) delete environment[name];
  environment[TEST_DATABASE_ENV] = connectionString;
  environment.SIDESTREAM_LICENSE_NAMESPACE = TEST_LICENSE_NAMESPACE;
  environment.VERCEL_ENV = "test";
  environment.SIDESTREAM_TEST_API_HOSTS = "stripe-recovery.test.invalid";
}

function printHelp() {
  console.log(`Usage:
  node scripts/recover-stripe-dead-letter.mjs --event-id evt_...
  node scripts/recover-stripe-dead-letter.mjs --apply --event-id evt_... \\
    --license-namespace test --target-fingerprint HEX64 \\
    --expected-payload-digest HEX64 --expected-terminal-state dead_letter \\
    --reason handler_fix_verified --confirm EXACT_CONFIRMATION
  node scripts/recover-stripe-dead-letter.mjs --self-test

Read-only inspection is the default. Output contains only digests, safe status,
event type, attempts, timestamps, and error/outcome codes. Apply accepts only
SIDESTREAM_TEST_POSTGRES_URL and a Stripe test key. Production and livemode
recovery, bulk replay, cap overrides, audit mutation, and direct entitlement
mutation are intentionally unavailable.`);
}

async function main() {
  const cliOptions = parseRecoveryArgs(process.argv.slice(2));
  if (cliOptions.help) {
    printHelp();
    return;
  }
  if (cliOptions.selfTest) {
    const result = await runRecoverySelfTest();
    console.log(`PASS: Stripe dead-letter recovery self-test ${JSON.stringify(result)}`);
    return;
  }

  const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const selected = selectRecoveryDatabase(process.env, { apply: cliOptions.apply });
  const { Pool } = await loadPostgresModule();
  const pool = new Pool(createRecoveryPoolOptions(selected));
  const client = await pool.connect();
  let runtime = null;
  try {
    const query = (text, params = []) => client.query(text, params);
    const inspect = () => inspectStripeDeadLetter(query, cliOptions.eventId);
    const report = await runStripeDeadLetterRecovery({
      cliOptions,
      inspect,
      atomicClaim: async () => {
        const initial = await inspect();
        return atomicallyClaimStripeDeadLetter({
          client,
          eventId: cliOptions.eventId,
          cliOptions,
          targetFingerprint: initial.targetFingerprint,
        });
      },
      processClaimedEvent: async (claimed) => {
        configureTestProcessingEnvironment(process.env, selected.connectionString);
        runtime ||= await loadStripeEventsRuntime(worktreeRoot);
        return runtime.stripeEvents.processClaimedStripeEvent(claimed, {
          maxAttempts: STRIPE_EVENT_MAX_ATTEMPTS,
          query,
          log: () => {},
        });
      },
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await runtime?.cleanup();
    client.release();
    await pool.end();
  }
}

function readOption(argv, index, name) {
  const argument = argv[index];
  if (argument.startsWith(`${name}=`)) {
    const value = argument.slice(name.length + 1);
    if (!value) throw cliError("missing_option_value", `${name} requires a value.`);
    return [value, index];
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw cliError("missing_option_value", `${name} requires a value.`);
  }
  return [value, index + 1];
}

function timestampValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw recoveryError("invalid_timestamp");
  return date.toISOString();
}

function nullableCode(value, maximum) {
  if (value === null || value === undefined || value === "") return null;
  const code = String(value);
  if (code.length > maximum || !/^[a-z0-9_]+$/.test(code)) {
    throw recoveryError("unsafe_status_code");
  }
  return code;
}

function nullableNonnegativeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw recoveryError("processing_duration_invalid");
  }
  return number;
}

function stringValue(value) {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function canonicalJsonDigest(value) {
  return sha256(JSON.stringify(sortJsonValue(JSON.parse(JSON.stringify(value)))));
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

function isHexDigest(value) {
  return /^[0-9a-f]{64}$/.test(value);
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

function configuredValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function recoveryError(code) {
  return new StripeDeadLetterRecoveryError(code);
}

function cliError(code, message) {
  return new StripeDeadLetterRecoveryError(code, message);
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedUrl) {
  main().catch((error) => {
    if (error instanceof StripeDeadLetterRecoveryError) {
      console.error(`${error.code}: ${error.message}`);
    } else {
      console.error("stripe_dead_letter_recovery_failed");
    }
    process.exitCode = 1;
  });
}

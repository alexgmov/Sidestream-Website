import type { PoolClient } from "pg";
import { acquireTransactionAdvisoryLock, queryPostgres, withPostgresTransaction } from "./postgres.js";
import {
  decryptSupportText,
  encryptSupportText,
  fingerprintSupportValue,
  hashSupportEmail,
} from "./support-crypto.js";
import type {
  SupportActionType,
  SupportAuditResult,
  SupportSafetyOutcome,
  SupportTriageResult,
} from "./support-safety.js";

export type SupportInboundMessage = Readonly<{
  providerEventId: string;
  providerMessageId: string;
  requesterEmail: string;
  subject: string;
  body: string;
  attachmentCount: number;
  htmlOnly: boolean;
}>;

export async function recordInboundSupportMessage(
  input: SupportInboundMessage,
  dataSecret: string,
) {
  return withPostgresTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, `support-inbound:${input.providerEventId}`);
    const existing = await client.query<{
      id: string;
      thread_id: string;
    }>(
      `select id, thread_id
         from public.sidestream_support_messages
        where provider_event_id = $1 or provider_message_id = $2
        limit 1`,
      [input.providerEventId, input.providerMessageId],
    );
    if (existing.rows[0]) {
      return Object.freeze({
        inserted: false,
        messageId: existing.rows[0].id,
        threadId: existing.rows[0].thread_id,
      });
    }

    const requesterEmailHash = hashSupportEmail(input.requesterEmail, dataSecret);
    const thread = await client.query<{ id: string }>(
      `insert into public.sidestream_support_threads (
         requester_email_hash,
         requester_email_ciphertext,
         subject_ciphertext
       ) values ($1, $2, $3)
       returning id`,
      [
        requesterEmailHash,
        encryptSupportText(input.requesterEmail, dataSecret),
        encryptSupportText(input.subject, dataSecret),
      ],
    );
    const threadId = requiredRowId(thread.rows[0], "support thread");
    const message = await client.query<{ id: string }>(
      `insert into public.sidestream_support_messages (
         thread_id,
         provider_event_id,
         provider_message_id,
         direction,
         body_ciphertext,
         attachment_count
       ) values ($1, $2, $3, 'inbound', $4, $5)
       returning id`,
      [
        threadId,
        input.providerEventId,
        input.providerMessageId,
        encryptSupportText(JSON.stringify({
          text: input.body,
          htmlOnly: input.htmlOnly,
        }), dataSecret),
        input.attachmentCount,
      ],
    );
    const messageId = requiredRowId(message.rows[0], "support message");
    await insertAuditEvent(client, {
      threadId,
      eventType: "inbound_received",
      idempotencyKey: `support_received:${fingerprintSupportValue(input.providerEventId)}`,
      details: { messageId, attachmentCount: input.attachmentCount },
    });
    return Object.freeze({ inserted: true, messageId, threadId });
  });
}

export async function loadSupportMessageForTriage(messageId: string, dataSecret: string) {
  const result = await queryPostgres<{
    id: string;
    thread_id: string;
    requester_email_hash: string;
    subject_ciphertext: string;
    body_ciphertext: string;
    attachment_count: number;
  }>(
    `select
       message.id,
       message.thread_id,
       thread.requester_email_hash,
       thread.subject_ciphertext,
       message.body_ciphertext,
       message.attachment_count
     from public.sidestream_support_messages message
     join public.sidestream_support_threads thread on thread.id = message.thread_id
     where message.id = $1 and message.direction = 'inbound'
     limit 1`,
    [messageId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Support message was not found");
  const decryptedBody = JSON.parse(decryptSupportText(row.body_ciphertext, dataSecret)) as {
    text?: unknown;
    htmlOnly?: unknown;
  };
  if (typeof decryptedBody.text !== "string" || typeof decryptedBody.htmlOnly !== "boolean") {
    throw new Error("Support message ciphertext is invalid");
  }
  return Object.freeze({
    messageId: row.id,
    threadId: row.thread_id,
    requesterEmailHash: row.requester_email_hash,
    subject: decryptSupportText(row.subject_ciphertext, dataSecret),
    body: decryptedBody.text,
    htmlOnly: decryptedBody.htmlOnly,
    attachmentCount: row.attachment_count,
  });
}

export async function recordSupportTriageOutcome(options: {
  messageId: string;
  threadId: string;
  outcome: SupportSafetyOutcome<SupportTriageResult>;
}) {
  return withPostgresTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, `support-triage:${options.messageId}`);
    const existing = await client.query<{ id: string }>(
      `select id
         from public.sidestream_support_action_requests
        where source_message_id = $1
        limit 1`,
      [options.messageId],
    );
    if (existing.rows[0]) return Object.freeze({ actionId: existing.rows[0].id, inserted: false });

    const resultForLedger = safeTriageEvidence(options.outcome.result);
    await client.query(
      `insert into public.sidestream_support_gate_runs (
         thread_id,
         source_message_id,
         stage,
         verdict,
         input_fingerprint,
         risk_codes,
         result,
         model
       ) values ($1, $2, 'triage', $3, $4, $5, $6::jsonb, $7)`,
      [
        options.threadId,
        options.messageId,
        options.outcome.result.verdict,
        fingerprintSupportValue(resultForLedger),
        [...options.outcome.riskCodes],
        JSON.stringify(resultForLedger),
        options.outcome.model,
      ],
    );
    const flagged = options.outcome.result.verdict === "flag";
    const action = await client.query<{ id: string }>(
      `insert into public.sidestream_support_action_requests (
         thread_id,
         source_message_id,
         action_type,
         status,
         candidate,
         requires_human
       ) values ($1, $2, $3, $4, $5::jsonb, $6)
       returning id`,
      [
        options.threadId,
        options.messageId,
        options.outcome.result.action.type,
        flagged ? "triage_flagged" : "proposed",
        JSON.stringify(options.outcome.result.action),
        options.outcome.result.humanApprovalRequired,
      ],
    );
    const actionId = requiredRowId(action.rows[0], "support action");
    await client.query(
      `update public.sidestream_support_threads
          set status = $2, updated_at = now()
        where id = $1`,
      [options.threadId, flagged ? "triage_flagged" : "triage_passed"],
    );
    await insertAuditEvent(client, {
      threadId: options.threadId,
      actionRequestId: actionId,
      eventType: flagged ? "triage_flagged" : "triage_passed",
      idempotencyKey: `support_triage:${options.messageId}`,
      details: { riskCodes: options.outcome.riskCodes },
    });
    return Object.freeze({ actionId, inserted: true });
  });
}

export async function recordSupportTriageError(options: {
  messageId: string;
  threadId: string;
  errorCode: string;
}) {
  const outcome: SupportSafetyOutcome<SupportTriageResult> = Object.freeze({
    model: "unavailable",
    riskCodes: Object.freeze([options.errorCode]),
    result: Object.freeze({
      verdict: "flag",
      promptInjectionRisk: "none",
      promptInjectionSignals: Object.freeze([]),
      category: "other",
      systematicIssue: false,
      humanApprovalRequired: true,
      summary: "The first safety gate failed closed.",
      proposedReply: "",
      action: Object.freeze({
        type: "none",
        justification: "Safety gate unavailable.",
        evidence: Object.freeze([options.errorCode]),
      }),
    }),
  });
  return recordSupportTriageOutcome({ ...options, outcome });
}

export async function loadSupportActionForAudit(actionId: string) {
  const result = await queryPostgres<{
    id: string;
    thread_id: string;
    action_type: SupportActionType;
    status: string;
    requester_email_hash: string;
  }>(
    `select
       action.id,
       action.thread_id,
       action.action_type,
       action.status,
       thread.requester_email_hash
     from public.sidestream_support_action_requests action
     join public.sidestream_support_threads thread on thread.id = action.thread_id
     where action.id = $1
     limit 1`,
    [actionId],
  );
  const row = result.rows[0];
  if (!row) throw new TypeError("Support action was not found");
  if (row.status !== "proposed" && row.status !== "audit_pending") {
    throw new TypeError(`Support action cannot be audited from status ${row.status}`);
  }
  if (row.action_type === "none") throw new TypeError("Support action has nothing to audit");
  return Object.freeze({
    actionId: row.id,
    threadId: row.thread_id,
    actionType: row.action_type,
    requesterEmailHash: row.requester_email_hash,
  });
}

export async function markSupportAuditPending(actionId: string) {
  await queryPostgres(
    `update public.sidestream_support_action_requests
        set status = 'audit_pending', updated_at = now()
      where id = $1 and status = 'proposed'`,
    [actionId],
  );
}

export async function recordSupportAuditOutcome(options: {
  actionId: string;
  threadId: string;
  artifact: unknown;
  outcome: SupportSafetyOutcome<SupportAuditResult>;
}) {
  return withPostgresTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, `support-audit:${options.actionId}`);
    const existing = await client.query<{ verdict: string }>(
      `select verdict
         from public.sidestream_support_gate_runs
        where action_request_id = $1 and stage = 'safety_audit'
        limit 1`,
      [options.actionId],
    );
    if (existing.rows[0]) {
      return Object.freeze({ inserted: false, verdict: existing.rows[0].verdict });
    }
    await client.query(
      `insert into public.sidestream_support_gate_runs (
         thread_id,
         action_request_id,
         stage,
         verdict,
         input_fingerprint,
         risk_codes,
         result,
         model
       ) values ($1, $2, 'safety_audit', $3, $4, $5, $6::jsonb, $7)`,
      [
        options.threadId,
        options.actionId,
        options.outcome.result.verdict,
        fingerprintSupportValue(options.artifact),
        [...options.outcome.riskCodes],
        JSON.stringify(options.outcome.result),
        options.outcome.model,
      ],
    );
    const flagged = options.outcome.result.verdict === "flag";
    await client.query(
      `update public.sidestream_support_action_requests
          set status = $2, requires_human = $3, updated_at = now()
        where id = $1`,
      [options.actionId, flagged ? "audit_flagged" : "audit_passed", options.outcome.result.humanApprovalRequired],
    );
    await client.query(
      `update public.sidestream_support_threads
          set status = $2, updated_at = now()
        where id = $1`,
      [options.threadId, flagged ? "audit_flagged" : "audit_passed"],
    );
    await insertAuditEvent(client, {
      threadId: options.threadId,
      actionRequestId: options.actionId,
      eventType: flagged ? "safety_audit_flagged" : "safety_audit_passed",
      idempotencyKey: `support_audit:${options.actionId}`,
      details: { riskCodes: options.outcome.riskCodes },
    });
    return Object.freeze({ inserted: true, verdict: options.outcome.result.verdict });
  });
}

export async function recordSupportAuditError(options: {
  actionId: string;
  threadId: string;
  artifact: unknown;
  errorCode: string;
}) {
  const outcome: SupportSafetyOutcome<SupportAuditResult> = Object.freeze({
    model: "unavailable",
    riskCodes: Object.freeze([options.errorCode]),
    result: Object.freeze({
      verdict: "flag",
      coreImpact: false,
      humanApprovalRequired: true,
      riskCodes: Object.freeze([options.errorCode]),
      findings: Object.freeze(["The independent safety audit failed closed."]),
      recommendation: "Stop automation and request human review.",
    }),
  });
  return recordSupportAuditOutcome({ ...options, outcome });
}

function safeTriageEvidence(result: SupportTriageResult) {
  return {
    verdict: result.verdict,
    promptInjectionRisk: result.promptInjectionRisk,
    promptInjectionSignals: result.promptInjectionSignals,
    category: result.category,
    systematicIssue: result.systematicIssue,
    humanApprovalRequired: result.humanApprovalRequired,
    action: result.action,
  };
}

async function insertAuditEvent(client: PoolClient, input: {
  threadId: string;
  actionRequestId?: string;
  eventType: string;
  idempotencyKey: string;
  details: Record<string, unknown>;
}) {
  await client.query(
    `insert into public.sidestream_support_audit_events (
       thread_id,
       action_request_id,
       event_type,
       idempotency_key,
       details
     ) values ($1, $2, $3, $4, $5::jsonb)
     on conflict (idempotency_key) do nothing`,
    [
      input.threadId,
      input.actionRequestId || null,
      input.eventType,
      input.idempotencyKey,
      JSON.stringify(input.details),
    ],
  );
}

function requiredRowId(row: { id: string } | undefined, name: string) {
  if (!row?.id) throw new Error(`Failed to create ${name}`);
  return row.id;
}

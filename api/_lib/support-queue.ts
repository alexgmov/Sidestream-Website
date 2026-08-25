import type { PoolClient } from "pg";
import { queryPostgres, withPostgresTransaction } from "./postgres.js";
import type { SupportRuntimeConfig } from "./support-config.js";
import {
  enqueueSupportSafetyAlert,
  insertAuditEvent,
} from "./support-ledger.js";
import { sendSupportSafetyAlert } from "./support-notifications.js";
import { triageSupportMessage } from "./support-workflow.js";

const SUPPORT_LEASE_SECONDS = 120;
const SUPPORT_MAX_PROCESSOR_BATCH = 25;
const SUPPORT_RETRY_BASE_MS = 30_000;
const SUPPORT_RETRY_MAX_MS = 30 * 60_000;

export type ClaimedSupportProcessingJob = Readonly<{
  id: string;
  threadId: string;
  messageId: string;
  leaseToken: string;
  attemptCount: number;
  cycleAttemptCount: number;
  maxAttempts: number;
}>;

export type ClaimedSupportNotification = Readonly<{
  id: string;
  threadId: string;
  actionRequestId: string | null;
  gate: "triage" | "safety_audit";
  referenceId: string;
  outcome: "flag" | "error";
  riskCodes: readonly string[];
  leaseToken: string;
  attemptCount: number;
  cycleAttemptCount: number;
  maxAttempts: number;
}>;

type QueueFailureResult = Readonly<{
  updated: boolean;
  state: "retry" | "dead_letter" | "stale_lease";
}>;

type SupportQueueDependencies = Readonly<{
  claimJob: typeof claimSupportProcessingJob;
  processJob: typeof triageSupportMessage;
  completeJob: typeof completeSupportProcessingJob;
  failJob: typeof failSupportProcessingJob;
  claimNotification: typeof claimSupportNotification;
  deliverNotification: typeof sendSupportSafetyAlert;
  completeNotification: typeof completeSupportNotification;
  failNotification: typeof failSupportNotification;
  countDeadLetters: typeof countSupportDeadLetters;
}>;

const defaultDependencies: SupportQueueDependencies = {
  claimJob: claimSupportProcessingJob,
  processJob: triageSupportMessage,
  completeJob: completeSupportProcessingJob,
  failJob: failSupportProcessingJob,
  claimNotification: claimSupportNotification,
  deliverNotification: sendSupportSafetyAlert,
  completeNotification: completeSupportNotification,
  failNotification: failSupportNotification,
  countDeadLetters: countSupportDeadLetters,
};

export function supportRetryDelayMs(cycleAttemptCount: number) {
  if (!Number.isInteger(cycleAttemptCount) || cycleAttemptCount < 1) {
    throw new TypeError("Support retry attempt is invalid");
  }
  return Math.min(
    SUPPORT_RETRY_MAX_MS,
    SUPPORT_RETRY_BASE_MS * (2 ** Math.min(cycleAttemptCount - 1, 16)),
  );
}

export async function processSupportQueues(options: {
  config: SupportRuntimeConfig;
  jobLimit?: number;
  notificationLimit?: number;
  dependencies?: Partial<SupportQueueDependencies>;
}) {
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const jobLimit = boundedProcessorLimit(options.jobLimit, 5);
  const notificationLimit = boundedProcessorLimit(options.notificationLimit, 10);
  const summary = {
    jobs: { claimed: 0, completed: 0, retried: 0, deadLettered: 0, staleLeases: 0 },
    notifications: { claimed: 0, delivered: 0, retried: 0, deadLettered: 0, staleLeases: 0 },
  };

  for (let index = 0; index < jobLimit; index += 1) {
    const job = await dependencies.claimJob();
    if (!job) break;
    summary.jobs.claimed += 1;
    try {
      await dependencies.processJob({ messageId: job.messageId, config: options.config });
      const completed = await dependencies.completeJob(job);
      if (completed) summary.jobs.completed += 1;
      else summary.jobs.staleLeases += 1;
    } catch {
      recordFailureSummary(summary.jobs, await dependencies.failJob(
        job,
        "triage_processing_failed",
      ));
    }
  }

  for (let index = 0; index < notificationLimit; index += 1) {
    const notification = await dependencies.claimNotification();
    if (!notification) break;
    summary.notifications.claimed += 1;
    try {
      await dependencies.deliverNotification({
        config: options.config,
        gate: notification.gate,
        referenceId: notification.referenceId,
        riskCodes: notification.riskCodes,
        outcome: notification.outcome,
      });
      const completed = await dependencies.completeNotification(notification);
      if (completed) summary.notifications.delivered += 1;
      else summary.notifications.staleLeases += 1;
    } catch {
      recordFailureSummary(summary.notifications, await dependencies.failNotification(
        notification,
        "alert_delivery_failed",
      ));
    }
  }

  const deadLetters = await dependencies.countDeadLetters();
  return Object.freeze({
    ok: true,
    limits: Object.freeze({ jobs: jobLimit, notifications: notificationLimit }),
    jobs: Object.freeze(summary.jobs),
    notifications: Object.freeze(summary.notifications),
    deadLetters,
    executed: false,
  });
}

export async function claimSupportProcessingJob() {
  const result = await queryPostgres<{
    id: string;
    thread_id: string;
    message_id: string;
    lease_token: string;
    attempt_count: number;
    cycle_attempt_count: number;
    max_attempts: number;
  }>(
    `with candidate as (
       select id
         from public.sidestream_support_processing_jobs
        where (
          state in ('pending', 'retry') and available_at <= now()
        ) or (
          state = 'processing' and lease_expires_at <= now()
        )
        order by
          case when state = 'processing' then 0 else 1 end,
          available_at,
          created_at
        for update skip locked
        limit 1
     )
     update public.sidestream_support_processing_jobs job
        set state = 'processing',
            attempt_count = job.attempt_count + 1,
            cycle_attempt_count = job.cycle_attempt_count + 1,
            lease_expires_at = now() + ($1 * interval '1 second'),
            lease_token = gen_random_uuid(),
            updated_at = now()
       from candidate
      where job.id = candidate.id
      returning
        job.id,
        job.thread_id,
        job.message_id,
        job.lease_token,
        job.attempt_count,
        job.cycle_attempt_count,
        job.max_attempts`,
    [SUPPORT_LEASE_SECONDS],
  );
  return result.rows[0] ? mapProcessingJob(result.rows[0]) : null;
}

export async function completeSupportProcessingJob(job: ClaimedSupportProcessingJob) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{ thread_id: string }>(
      `update public.sidestream_support_processing_jobs
          set state = 'completed',
              completed_at = now(),
              lease_expires_at = null,
              lease_token = null,
              last_error_code = null,
              updated_at = now()
        where id = $1
          and state = 'processing'
          and lease_token = $2
        returning thread_id`,
      [job.id, job.leaseToken],
    );
    if (!result.rows[0]) return false;
    await insertAuditEvent(client, {
      threadId: result.rows[0].thread_id,
      eventType: "support_processing_completed",
      idempotencyKey: `support_processing_completed:${job.id}`,
      details: { jobId: job.id, attemptCount: job.attemptCount },
    });
    return true;
  });
}

export async function failSupportProcessingJob(
  job: ClaimedSupportProcessingJob,
  errorCode: string,
): Promise<QueueFailureResult> {
  const safeErrorCode = safeQueueErrorCode(errorCode);
  const deadLetter = job.cycleAttemptCount >= job.maxAttempts;
  const retryAt = new Date(Date.now() + supportRetryDelayMs(job.cycleAttemptCount));
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{
      thread_id: string;
      message_id: string;
      state: "retry" | "dead_letter";
    }>(
      `update public.sidestream_support_processing_jobs
          set state = $3,
              available_at = $4,
              lease_expires_at = null,
              lease_token = null,
              last_error_code = $5,
              dead_letter_at = case when $3 = 'dead_letter' then now() else null end,
              updated_at = now()
        where id = $1
          and state = 'processing'
          and lease_token = $2
        returning thread_id, message_id, state`,
      [job.id, job.leaseToken, deadLetter ? "dead_letter" : "retry", retryAt, safeErrorCode],
    );
    const row = result.rows[0];
    if (!row) return Object.freeze({ updated: false, state: "stale_lease" as const });
    await insertAuditEvent(client, {
      threadId: row.thread_id,
      eventType: deadLetter ? "support_processing_dead_letter" : "support_processing_retry",
      idempotencyKey: `support_processing_attempt:${job.id}:${job.attemptCount}`,
      details: {
        jobId: job.id,
        attemptCount: job.attemptCount,
        outcome: row.state,
        errorCode: safeErrorCode,
      },
    });
    if (deadLetter) {
      await client.query(
        `update public.sidestream_support_threads
            set status = 'human_review', updated_at = now()
          where id = $1`,
        [row.thread_id],
      );
      await enqueueSupportSafetyAlert(client, {
        threadId: row.thread_id,
        gate: "triage",
        referenceId: row.message_id,
        riskCodes: ["triage_processing_dead_letter"],
        outcome: "error",
      });
    }
    return Object.freeze({ updated: true, state: row.state });
  });
}

export async function claimSupportNotification() {
  const result = await queryPostgres<{
    id: string;
    thread_id: string;
    action_request_id: string | null;
    gate: "triage" | "safety_audit";
    reference_id: string;
    outcome: "flag" | "error";
    risk_codes: string[];
    lease_token: string;
    attempt_count: number;
    cycle_attempt_count: number;
    max_attempts: number;
  }>(
    `with candidate as (
       select id
         from public.sidestream_support_notification_outbox
        where (
          state in ('pending', 'retry') and available_at <= now()
        ) or (
          state = 'processing' and lease_expires_at <= now()
        )
        order by
          case when state = 'processing' then 0 else 1 end,
          available_at,
          created_at
        for update skip locked
        limit 1
     )
     update public.sidestream_support_notification_outbox outbox
        set state = 'processing',
            attempt_count = outbox.attempt_count + 1,
            cycle_attempt_count = outbox.cycle_attempt_count + 1,
            lease_expires_at = now() + ($1 * interval '1 second'),
            lease_token = gen_random_uuid(),
            updated_at = now()
       from candidate
      where outbox.id = candidate.id
      returning
        outbox.id,
        outbox.thread_id,
        outbox.action_request_id,
        outbox.gate,
        outbox.reference_id,
        outbox.outcome,
        outbox.risk_codes,
        outbox.lease_token,
        outbox.attempt_count,
        outbox.cycle_attempt_count,
        outbox.max_attempts`,
    [SUPPORT_LEASE_SECONDS],
  );
  return result.rows[0] ? mapNotification(result.rows[0]) : null;
}

export async function completeSupportNotification(
  notification: ClaimedSupportNotification,
) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{ thread_id: string; action_request_id: string | null }>(
      `update public.sidestream_support_notification_outbox
          set state = 'delivered',
              delivered_at = now(),
              lease_expires_at = null,
              lease_token = null,
              last_error_code = null,
              updated_at = now()
        where id = $1
          and state = 'processing'
          and lease_token = $2
        returning thread_id, action_request_id`,
      [notification.id, notification.leaseToken],
    );
    const row = result.rows[0];
    if (!row) return false;
    await insertNotificationAttempt(client, notification, "delivered", null);
    await insertAuditEvent(client, {
      threadId: row.thread_id,
      actionRequestId: row.action_request_id || undefined,
      eventType: "support_alert_delivered",
      idempotencyKey: `support_alert_delivered:${notification.id}`,
      details: {
        outboxId: notification.id,
        attemptCount: notification.attemptCount,
        gate: notification.gate,
        outcome: notification.outcome,
      },
    });
    return true;
  });
}

export async function failSupportNotification(
  notification: ClaimedSupportNotification,
  errorCode: string,
): Promise<QueueFailureResult> {
  const safeErrorCode = safeQueueErrorCode(errorCode);
  const deadLetter = notification.cycleAttemptCount >= notification.maxAttempts;
  const retryAt = new Date(Date.now() + supportRetryDelayMs(notification.cycleAttemptCount));
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{
      thread_id: string;
      action_request_id: string | null;
      state: "retry" | "dead_letter";
    }>(
      `update public.sidestream_support_notification_outbox
          set state = $3,
              available_at = $4,
              lease_expires_at = null,
              lease_token = null,
              last_error_code = $5,
              dead_letter_at = case when $3 = 'dead_letter' then now() else null end,
              updated_at = now()
        where id = $1
          and state = 'processing'
          and lease_token = $2
        returning thread_id, action_request_id, state`,
      [
        notification.id,
        notification.leaseToken,
        deadLetter ? "dead_letter" : "retry",
        retryAt,
        safeErrorCode,
      ],
    );
    const row = result.rows[0];
    if (!row) return Object.freeze({ updated: false, state: "stale_lease" as const });
    await insertNotificationAttempt(
      client,
      notification,
      deadLetter ? "dead_letter" : "retry",
      safeErrorCode,
    );
    await insertAuditEvent(client, {
      threadId: row.thread_id,
      actionRequestId: row.action_request_id || undefined,
      eventType: deadLetter ? "support_alert_dead_letter" : "support_alert_retry",
      idempotencyKey: `support_alert_attempt:${notification.id}:${notification.attemptCount}`,
      details: {
        outboxId: notification.id,
        attemptCount: notification.attemptCount,
        outcome: row.state,
        errorCode: safeErrorCode,
      },
    });
    return Object.freeze({ updated: true, state: row.state });
  });
}

export async function recoverSupportProcessingDeadLetter(jobId: string) {
  return recoverSupportDeadLetter({ kind: "job", id: jobId });
}

export async function recoverSupportNotificationDeadLetter(notificationId: string) {
  return recoverSupportDeadLetter({ kind: "notification", id: notificationId });
}

export async function countSupportDeadLetters() {
  const result = await queryPostgres<{
    processing: number;
    notifications: number;
  }>(
    `select
       (select count(*)::integer
          from public.sidestream_support_processing_jobs
         where state = 'dead_letter') as processing,
       (select count(*)::integer
          from public.sidestream_support_notification_outbox
         where state = 'dead_letter') as notifications`,
  );
  return Object.freeze({
    processing: Number(result.rows[0]?.processing || 0),
    notifications: Number(result.rows[0]?.notifications || 0),
  });
}

async function recoverSupportDeadLetter(input: {
  kind: "job" | "notification";
  id: string;
}) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(input.id)) {
    throw new TypeError("Support dead-letter ID is invalid");
  }
  const table = input.kind === "job"
    ? "sidestream_support_processing_jobs"
    : "sidestream_support_notification_outbox";
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{
      thread_id: string;
      action_request_id?: string | null;
      recovery_count: number;
    }>(
      `update public.${table}
          set state = 'pending',
              cycle_attempt_count = 0,
              available_at = now(),
              dead_letter_at = null,
              last_error_code = null,
              recovery_count = recovery_count + 1,
              updated_at = now()
        where id = $1
          and state = 'dead_letter'
          and recovery_count < 3
        returning thread_id, ${input.kind === "notification" ? "action_request_id," : ""} recovery_count`,
      [input.id],
    );
    const row = result.rows[0];
    if (!row) return Object.freeze({ recovered: false });
    await insertAuditEvent(client, {
      threadId: row.thread_id,
      actionRequestId: row.action_request_id || undefined,
      eventType: input.kind === "job"
        ? "support_processing_dead_letter_recovered"
        : "support_alert_dead_letter_recovered",
      idempotencyKey: `support_${input.kind}_recovered:${input.id}:${row.recovery_count}`,
      details: {
        id: input.id,
        recoveryCount: row.recovery_count,
      },
    });
    return Object.freeze({ recovered: true, recoveryCount: row.recovery_count });
  });
}

async function insertNotificationAttempt(
  client: PoolClient,
  notification: ClaimedSupportNotification,
  outcome: "delivered" | "retry" | "dead_letter",
  errorCode: string | null,
) {
  await client.query(
    `insert into public.sidestream_support_notification_attempts (
       outbox_id,
       attempt_number,
       outcome,
       error_code
     ) values ($1, $2, $3, $4)
     on conflict (outbox_id, attempt_number) do nothing`,
    [notification.id, notification.attemptCount, outcome, errorCode],
  );
}

function mapProcessingJob(row: {
  id: string;
  thread_id: string;
  message_id: string;
  lease_token: string;
  attempt_count: number;
  cycle_attempt_count: number;
  max_attempts: number;
}): ClaimedSupportProcessingJob {
  return Object.freeze({
    id: row.id,
    threadId: row.thread_id,
    messageId: row.message_id,
    leaseToken: row.lease_token,
    attemptCount: Number(row.attempt_count),
    cycleAttemptCount: Number(row.cycle_attempt_count),
    maxAttempts: Number(row.max_attempts),
  });
}

function mapNotification(row: {
  id: string;
  thread_id: string;
  action_request_id: string | null;
  gate: "triage" | "safety_audit";
  reference_id: string;
  outcome: "flag" | "error";
  risk_codes: string[];
  lease_token: string;
  attempt_count: number;
  cycle_attempt_count: number;
  max_attempts: number;
}): ClaimedSupportNotification {
  return Object.freeze({
    id: row.id,
    threadId: row.thread_id,
    actionRequestId: row.action_request_id,
    gate: row.gate,
    referenceId: row.reference_id,
    outcome: row.outcome,
    riskCodes: Object.freeze([...row.risk_codes]),
    leaseToken: row.lease_token,
    attemptCount: Number(row.attempt_count),
    cycleAttemptCount: Number(row.cycle_attempt_count),
    maxAttempts: Number(row.max_attempts),
  });
}

function boundedProcessorLimit(value: number | undefined, fallback: number) {
  const normalized = value === undefined ? fallback : value;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > SUPPORT_MAX_PROCESSOR_BATCH) {
    throw new TypeError(`Support processor limit must be an integer from 1 to ${SUPPORT_MAX_PROCESSOR_BATCH}`);
  }
  return normalized;
}

function safeQueueErrorCode(value: string) {
  return /^[a-z0-9_:-]{1,100}$/i.test(value) ? value : "support_queue_error";
}

function recordFailureSummary(
  summary: { retried: number; deadLettered: number; staleLeases: number },
  result: QueueFailureResult,
) {
  if (result.state === "retry") summary.retried += 1;
  else if (result.state === "dead_letter") summary.deadLettered += 1;
  else summary.staleLeases += 1;
}

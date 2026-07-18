import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import * as account from "./account.js";
import {
  materializeCustomerCommerceEvent,
  type CustomerCommerceQuery,
} from "./customer-commerce.js";
import {
  resolveLicenseEnvironment,
  type LicenseEnvironmentServerState,
} from "./license-environment.js";

export const DEFAULT_STRIPE_EVENT_BATCH_SIZE = 10;
export const MAX_STRIPE_EVENT_BATCH_SIZE = 50;
export const DEFAULT_STRIPE_EVENT_LEASE_MS = 5 * 60 * 1_000;
export const DEFAULT_STRIPE_EVENT_MAX_ATTEMPTS = 8;
export const STRIPE_EVENT_RETRY_BASE_MS = 5_000;
export const STRIPE_EVENT_RETRY_CAP_MS = 15 * 60 * 1_000;

type StripeEventQueryResult = Readonly<{
  rows: readonly Record<string, any>[];
}>;

export type StripeEventQuery = (
  text: string,
  params?: readonly unknown[],
) => Promise<StripeEventQueryResult>;

export type ClaimedStripeEvent = Readonly<{
  eventId: string;
  eventType: string;
  stripeCreatedAt: Date | string;
  payload: Stripe.Event;
  attemptCount: number;
  claimToken: string;
}>;

type DeadLetteredStripeEvent = Readonly<{
  eventId: string;
  eventType: string;
  attemptCount: number;
}>;

type StripeEventClaimBatch = Readonly<{
  claimed: readonly ClaimedStripeEvent[];
  deadLettered: readonly DeadLetteredStripeEvent[];
}>;

export type StripeEventProcessingResult = Readonly<{
  status: "processed" | "ignored";
  outcome: string;
}>;

export type StripeEventDrainSummary = Readonly<{
  claimed: number;
  processed: number;
  ignored: number;
  retryable: number;
  deadLetter: number;
}>;

export type StripeEventLog = Readonly<{
  eventId: string;
  eventType: string;
  attempt: number;
  outcome: string;
  durationMs: number;
}>;

type StripeEventDrainOptions = Readonly<{
  batchSize?: number;
  leaseMs?: number;
  maxAttempts?: number;
  query?: StripeEventQuery;
  processEvent?: (event: Stripe.Event) => Promise<StripeEventProcessingResult>;
  createClaimToken?: () => string;
  random?: () => number;
  now?: () => number;
  log?: (entry: StripeEventLog) => void;
}>;

const runtimeQuery: StripeEventQuery = async (text, params = []) =>
  account.query(text, [...params]);

export async function recordStripeEvent(
  event: Stripe.Event,
  rawPayload: string,
  query: StripeEventQuery = runtimeQuery,
) {
  assertStripeEventIdentity(event);
  const result = await query(
    `
      insert into public.sidestream_stripe_events (
        event_id,
        event_type,
        stripe_created_at,
        payload,
        raw_payload,
        received_at,
        created_at,
        updated_at
      )
      values ($1, $2, to_timestamp($3), $4::jsonb, $5, now(), now(), now())
      on conflict (event_id) do nothing
      returning event_id
    `,
    [event.id, event.type, event.created, JSON.stringify(event), rawPayload],
  );
  return Boolean(result.rows[0]);
}

export async function claimStripeEvents(options: {
  batchSize?: number;
  leaseMs?: number;
  maxAttempts?: number;
  claimToken?: string;
  query?: StripeEventQuery;
} = {}): Promise<ClaimedStripeEvent[]> {
  const batch = await claimStripeEventBatch(options);
  return [...batch.claimed];
}

async function claimStripeEventBatch(options: {
  batchSize?: number;
  leaseMs?: number;
  maxAttempts?: number;
  claimToken?: string;
  query?: StripeEventQuery;
} = {}): Promise<StripeEventClaimBatch> {
  const query = options.query || runtimeQuery;
  const batchSize = boundedInteger(
    options.batchSize,
    DEFAULT_STRIPE_EVENT_BATCH_SIZE,
    1,
    MAX_STRIPE_EVENT_BATCH_SIZE,
  );
  const leaseMs = boundedInteger(
    options.leaseMs,
    DEFAULT_STRIPE_EVENT_LEASE_MS,
    1_000,
    15 * 60 * 1_000,
  );
  const maxAttempts = boundedInteger(
    options.maxAttempts,
    DEFAULT_STRIPE_EVENT_MAX_ATTEMPTS,
    1,
    20,
  );
  const claimToken = options.claimToken || randomUUID();
  if (!isUuid(claimToken)) throw new TypeError("Stripe event claim token must be a UUID");

  const result = await query(
    `
      with exhausted_candidates as materialized (
        select
          event_id,
          case
            when processing_status = 'processing' then lease_expires_at
            else next_attempt_at
          end as eligible_at
        from public.sidestream_stripe_events
        where terminal_at is null
          and attempt_count >= $4
          and (
            processing_status in ('received', 'retryable')
            or (
              processing_status = 'processing'
              and lease_expires_at <= clock_timestamp()
            )
          )
        order by
          case
            when processing_status = 'processing' then lease_expires_at
            else next_attempt_at
          end asc,
          stripe_created_at asc,
          event_id asc
        limit $1
        for update skip locked
      ),
      dead_lettered as (
        update public.sidestream_stripe_events as event
        set processing_status = 'dead_letter',
            last_error_code = 'claim_attempt_limit_exhausted',
            outcome = 'dead_letter',
            terminal_at = clock_timestamp(),
            claim_token = null,
            lease_expires_at = null,
            updated_at = now()
        from exhausted_candidates
        where event.event_id = exhausted_candidates.event_id
          and event.terminal_at is null
          and event.attempt_count >= $4
        returning
          event.event_id,
          event.event_type,
          event.stripe_created_at,
          event.payload,
          event.attempt_count,
          event.claim_token
      ),
      claimable_candidates as materialized (
        select
          event_id,
          case
            when processing_status = 'processing' then lease_expires_at
            else next_attempt_at
          end as eligible_at
        from public.sidestream_stripe_events
        where terminal_at is null
          and attempt_count < $4
          and (
            (
              processing_status in ('received', 'retryable')
              and next_attempt_at <= clock_timestamp()
            )
            or (
              processing_status = 'processing'
              and lease_expires_at <= clock_timestamp()
            )
          )
        order by
          case
            when processing_status = 'processing' then lease_expires_at
            else next_attempt_at
          end asc,
          stripe_created_at asc,
          event_id asc
        limit $1
        for update skip locked
      ),
      claimed as (
        update public.sidestream_stripe_events as event
        set processing_status = 'processing',
            attempt_count = event.attempt_count + 1,
            claim_token = $2::uuid,
            lease_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
            processing_started_at = clock_timestamp(),
            processing_duration_ms = null,
            outcome = null,
            updated_at = now()
        from claimable_candidates
        where event.event_id = claimable_candidates.event_id
          and event.terminal_at is null
          and event.attempt_count < $4
        returning
          event.event_id,
          event.event_type,
          event.stripe_created_at,
          event.payload,
          event.attempt_count,
          event.claim_token
      ),
      claim_results as (
        select
          'claimed'::text as claim_result,
          claimed.event_id,
          claimed.event_type,
          claimed.stripe_created_at,
          claimed.payload,
          claimed.attempt_count,
          claimed.claim_token,
          claimable_candidates.eligible_at
        from claimed
        join claimable_candidates using (event_id)
        union all
        select
          'dead_lettered'::text as claim_result,
          dead_lettered.event_id,
          dead_lettered.event_type,
          dead_lettered.stripe_created_at,
          dead_lettered.payload,
          dead_lettered.attempt_count,
          dead_lettered.claim_token,
          exhausted_candidates.eligible_at
        from dead_lettered
        join exhausted_candidates using (event_id)
      )
      select *
      from claim_results
      order by eligible_at asc, stripe_created_at asc, event_id asc
    `,
    [batchSize, claimToken, leaseMs, maxAttempts],
  );

  const claimed: ClaimedStripeEvent[] = [];
  const deadLettered: DeadLetteredStripeEvent[] = [];
  for (const row of result.rows) {
    if (row.claim_result === "dead_lettered") {
      deadLettered.push({
        eventId: String(row.event_id),
        eventType: String(row.event_type),
        attemptCount: Number(row.attempt_count),
      });
      continue;
    }
    claimed.push({
      eventId: String(row.event_id),
      eventType: String(row.event_type),
      stripeCreatedAt: row.stripe_created_at as Date | string,
      payload: row.payload as Stripe.Event,
      attemptCount: Number(row.attempt_count),
      claimToken: String(row.claim_token),
    });
  }
  return Object.freeze({ claimed, deadLettered });
}

export async function drainStripeEventQueue(
  options: StripeEventDrainOptions = {},
): Promise<StripeEventDrainSummary> {
  const query = options.query || runtimeQuery;
  const processEvent = options.processEvent ||
    ((event: Stripe.Event) => reconcileStripeEvent(event, query));
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  const log = options.log || logStripeEventOutcome;
  const maxAttempts = boundedInteger(
    options.maxAttempts,
    DEFAULT_STRIPE_EVENT_MAX_ATTEMPTS,
    1,
    20,
  );
  const claimBatch = await claimStripeEventBatch({
    batchSize: options.batchSize,
    leaseMs: options.leaseMs,
    maxAttempts,
    claimToken: options.createClaimToken?.(),
    query,
  });
  const claimed = claimBatch.claimed;
  const summary = {
    claimed: claimed.length,
    processed: 0,
    ignored: 0,
    retryable: 0,
    deadLetter: claimBatch.deadLettered.length,
  };

  for (const row of claimBatch.deadLettered) {
    log(Object.freeze({
      eventId: row.eventId,
      eventType: row.eventType,
      attempt: row.attemptCount,
      outcome: "dead_letter",
      durationMs: 0,
    }));
  }

  for (const row of claimed) {
    const startedAt = now();
    try {
      assertClaimedPayload(row);
      const result = await processEvent(row.payload);
      const durationMs = elapsedMilliseconds(startedAt, now());
      const completed = await markStripeEventTerminal(
        row,
        result,
        durationMs,
        query,
      );
      if (!completed) {
        log(stripeEventLog(row, "claim_lost", durationMs));
        continue;
      }
      summary[result.status] += 1;
      log(stripeEventLog(row, result.outcome, durationMs));
    } catch (error) {
      const durationMs = elapsedMilliseconds(startedAt, now());
      const errorCode = safeStripeEventErrorCode(error);
      const failure = await markStripeEventFailure({
        row,
        durationMs,
        errorCode,
        maxAttempts,
        retryDelayMs: computeStripeEventRetryDelayMs(row.attemptCount, random),
        query,
      });
      if (!failure) {
        log(stripeEventLog(row, "claim_lost", durationMs));
        continue;
      }
      if (failure === "dead_letter") summary.deadLetter += 1;
      else summary.retryable += 1;
      log(stripeEventLog(row, failure, durationMs));
    }
  }

  return Object.freeze(summary);
}

export async function reconcileStripeEvent(
  event: Stripe.Event,
  commerceQuery: CustomerCommerceQuery = runtimeQuery,
  serverEnv: LicenseEnvironmentServerState = process.env,
): Promise<StripeEventProcessingResult> {
  assertStripeEventIdentity(event);
  const environment = resolveLicenseEnvironment({ serverEnv });
  if (!environment) {
    throw new StripeEventProcessingError("commerce_environment_unresolved");
  }
  if (typeof event.livemode !== "boolean") {
    throw new StripeEventProcessingError("invalid_event_livemode");
  }
  const signedEventNamespace = event.livemode ? "production" : "test";
  if (signedEventNamespace !== environment.namespace) {
    throw new StripeEventProcessingError("stripe_event_namespace_mismatch");
  }
  // Preserve the inherited entitlement decision first. Commerce is an
  // independent projection: if its schema or normalization fails, the durable
  // queue retries the money work without changing the entitlement result.
  const entitlement = await reconcileInheritedEntitlement(event);
  const commerce = await materializeCustomerCommerceEvent(
    event,
    commerceQuery,
    environment.namespace,
  );
  if (entitlement) return entitlement;

  if (commerce.recognized) {
    return {
      status: "processed",
      outcome: commerce.applied > 0
        ? "commerce_reconciled"
        : "commerce_stale_noop",
    };
  }
  return { status: "ignored", outcome: "unsupported_event_type" };
}

async function reconcileInheritedEntitlement(
  event: Stripe.Event,
): Promise<StripeEventProcessingResult | null> {
  switch (event.type) {
    case "checkout.session.completed": {
      const result = await account.upsertLicenseFromCheckoutSession(
        event.data.object,
        { eventId: event.id, created: event.created },
      );
      if (!result.fulfilled) {
        return { status: "ignored", outcome: safeOutcome(`checkout_${result.reason}`) };
      }
      return {
        status: "processed",
        outcome: result.activationBound
          ? "checkout_fulfilled_activation_bound"
          : "checkout_fulfilled",
      };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscriptionId = stripeObjectId(event.data.object);
      if (!subscriptionId) {
        return { status: "ignored", outcome: "subscription_missing_id" };
      }
      const subscription = await account.getStripe().subscriptions.retrieve(
        subscriptionId,
        {},
        account.getStripeRequestOptions(),
      );
      const result = await account.upsertLicenseFromSubscription(
        subscription,
        undefined,
        { eventId: event.id, created: event.created },
      );
      if (!result.fulfilled) {
        return { status: "ignored", outcome: safeOutcome(`subscription_${result.reason}`) };
      }
      return {
        status: "processed",
        outcome: result.applied
          ? ("eligible" in result && result.eligible === false
            ? "subscription_quarantined"
            : "subscription_reconciled")
          : "subscription_stale_noop",
      };
    }
    case "charge.refunded":
    case "charge.updated":
    case "refund.created":
    case "refund.updated":
    case "refund.failed":
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed": {
      if (!("reconcileOneTimePaymentLifecycle" in account)) {
        return { status: "ignored", outcome: "lifecycle_reconciler_unavailable" };
      }
      const result = await account.reconcileOneTimePaymentLifecycle(
        event.type,
        event.data.object,
        { eventId: event.id, created: event.created },
      );
      if (!result.fulfilled) {
        return {
          status: "ignored",
          outcome: safeOutcome(`lifecycle_${result.reason}`),
        };
      }
      return {
        status: "processed",
        outcome: result.applied
          ? `lifecycle_${result.entitlementStatus}`
          : "lifecycle_stale_noop",
      };
    }
    default:
      return null;
  }
}

export function computeStripeEventRetryDelayMs(
  attemptCount: number,
  random: () => number = Math.random,
) {
  const normalizedAttempt = boundedInteger(attemptCount, 1, 1, 20);
  const exponentialCeiling = Math.min(
    STRIPE_EVENT_RETRY_CAP_MS,
    STRIPE_EVENT_RETRY_BASE_MS * (2 ** (normalizedAttempt - 1)),
  );
  const randomValue = Math.max(0, Math.min(1, Number(random())));
  const jitterFactor = 0.5 + (Number.isFinite(randomValue) ? randomValue : 0.5) * 0.5;
  return Math.min(
    STRIPE_EVENT_RETRY_CAP_MS,
    Math.max(1_000, Math.round(exponentialCeiling * jitterFactor)),
  );
}

async function markStripeEventTerminal(
  row: ClaimedStripeEvent,
  result: StripeEventProcessingResult,
  durationMs: number,
  query: StripeEventQuery,
) {
  const outcome = safeOutcome(result.outcome);
  const updated = await query(
    `
      update public.sidestream_stripe_events
      set processing_status = $3,
          processed_at = clock_timestamp(),
          terminal_at = clock_timestamp(),
          outcome = $4,
          processing_duration_ms = $5,
          claim_token = null,
          lease_expires_at = null,
          updated_at = now()
      where event_id = $1
        and claim_token = $2::uuid
        and processing_status = 'processing'
      returning event_id
    `,
    [row.eventId, row.claimToken, result.status, outcome, durationMs],
  );
  return Boolean(updated.rows[0]);
}

async function markStripeEventFailure(options: {
  row: ClaimedStripeEvent;
  durationMs: number;
  errorCode: string;
  maxAttempts: number;
  retryDelayMs: number;
  query: StripeEventQuery;
}) {
  const deadLetter = options.row.attemptCount >= options.maxAttempts;
  const status = deadLetter ? "dead_letter" : "retryable";
  const updated = await options.query(
    `
      update public.sidestream_stripe_events
      set processing_status = $3,
          next_attempt_at = case
            when $3 = 'dead_letter' then next_attempt_at
            else clock_timestamp() + ($4::bigint * interval '1 millisecond')
          end,
          last_error_code = $5,
          outcome = $6,
          processing_duration_ms = $7,
          terminal_at = case when $3 = 'dead_letter' then clock_timestamp() else null end,
          claim_token = null,
          lease_expires_at = null,
          updated_at = now()
      where event_id = $1
        and claim_token = $2::uuid
        and processing_status = 'processing'
      returning event_id
    `,
    [
      options.row.eventId,
      options.row.claimToken,
      status,
      options.retryDelayMs,
      options.errorCode,
      deadLetter ? "dead_letter" : "retry_scheduled",
      options.durationMs,
    ],
  );
  return updated.rows[0] ? status : null;
}

function assertStripeEventIdentity(event: Stripe.Event) {
  if (
    !event ||
    typeof event !== "object" ||
    typeof event.id !== "string" ||
    !event.id ||
    typeof event.type !== "string" ||
    !event.type ||
    !Number.isSafeInteger(event.created) ||
    event.created < 0
  ) {
    throw new StripeEventProcessingError("invalid_event_identity");
  }
}

function assertClaimedPayload(row: ClaimedStripeEvent) {
  assertStripeEventIdentity(row.payload);
  if (row.payload.id !== row.eventId || row.payload.type !== row.eventType) {
    throw new StripeEventProcessingError("payload_identity_mismatch");
  }
}

function stripeObjectId(value: unknown) {
  if (!value || typeof value !== "object" || !("id" in value)) return "";
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id.trim().slice(0, 255) : "";
}

function safeStripeEventErrorCode(error: unknown) {
  if (error instanceof StripeEventProcessingError) return error.code;
  if (error && typeof error === "object") {
    for (const key of ["code", "type", "name"] as const) {
      const value = key in error ? String((error as Record<string, unknown>)[key] || "") : "";
      const normalized = value
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toLowerCase();
      if (/^[a-z0-9_]{1,120}$/.test(normalized)) return normalized;
    }
  }
  return "processing_error";
}

function safeOutcome(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 160);
  return normalized || "unknown_outcome";
}

function stripeEventLog(
  row: ClaimedStripeEvent,
  outcome: string,
  durationMs: number,
): StripeEventLog {
  return Object.freeze({
    eventId: row.eventId,
    eventType: row.eventType,
    attempt: row.attemptCount,
    outcome,
    durationMs,
  });
}

function logStripeEventOutcome(entry: StripeEventLog) {
  console.info(JSON.stringify(entry));
}

function elapsedMilliseconds(startedAt: number, finishedAt: number) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return 0;
  return Math.max(0, Math.min(2_147_483_647, Math.round(finishedAt - startedAt)));
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

class StripeEventProcessingError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "StripeEventProcessingError";
    this.code = code;
  }
}

import { createHash, randomUUID } from "node:crypto";
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
export const SUPPORTED_STRIPE_EVENT_API_VERSIONS = Object.freeze([
  "2026-06-24.dahlia",
]);

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
  rawPayload: string;
  ingressEventId: string;
  ingressEventType: string;
  ingressPayloadSha256: string;
  ingressRawSha256: string;
  ingressApiVersion: string;
  ingressLivemode: boolean;
  ingressCreated: number;
  ingressEvidence?: "derived";
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

export type StripeEventClaimProcessingResult = Readonly<{
  status: "processed" | "ignored" | "retryable" | "dead_letter" | "claim_lost";
  outcome: string;
  durationMs: number;
}>;

export type StripeEventClaimProcessingOptions = Readonly<{
  maxAttempts?: number;
  query?: StripeEventQuery;
  processEvent?: (event: Stripe.Event) => Promise<StripeEventProcessingResult>;
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
  const payloadText = JSON.stringify(event);
  const apiVersion = typeof event.api_version === "string" ? event.api_version : "";
  let result: StripeEventQueryResult;
  try {
    result = await query(
      `
        insert into public.sidestream_stripe_events (
          event_id,
          event_type,
          stripe_created_at,
          payload,
          raw_payload,
          ingress_event_id,
          ingress_event_type,
          ingress_created,
          ingress_livemode,
          ingress_api_version,
          ingress_payload_sha256,
          ingress_raw_sha256,
          received_at,
          created_at,
          updated_at
        )
        values (
          $1, $2, to_timestamp($3), $4::jsonb, $5,
          $1, $2, $3, $6, $7, $8, $9,
          now(), now(), now()
        )
        on conflict (event_id) do nothing
        returning event_id
      `,
      [
        event.id,
        event.type,
        event.created,
        payloadText,
        rawPayload,
        event.livemode,
        apiVersion,
        canonicalJsonDigest(event),
        sha256(rawPayload),
      ],
    );
  } catch (error) {
    if (!isMissingOptionalStripeIngressColumn(error)) throw error;
    result = await query(
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
      [event.id, event.type, event.created, payloadText, rawPayload],
    );
  }
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
          event.raw_payload,
          to_jsonb(event) ? 'ingress_event_id' as ingress_evidence_supported,
          to_jsonb(event) -> 'ingress_event_id' as ingress_event_id,
          to_jsonb(event) -> 'ingress_event_type' as ingress_event_type,
          to_jsonb(event) -> 'ingress_payload_sha256' as ingress_payload_sha256,
          to_jsonb(event) -> 'ingress_raw_sha256' as ingress_raw_sha256,
          to_jsonb(event) -> 'ingress_api_version' as ingress_api_version,
          to_jsonb(event) -> 'ingress_livemode' as ingress_livemode,
          to_jsonb(event) -> 'ingress_created' as ingress_created,
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
        limit greatest($1 - (select count(*) from dead_lettered), 0)
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
          event.raw_payload,
          to_jsonb(event) ? 'ingress_event_id' as ingress_evidence_supported,
          to_jsonb(event) -> 'ingress_event_id' as ingress_event_id,
          to_jsonb(event) -> 'ingress_event_type' as ingress_event_type,
          to_jsonb(event) -> 'ingress_payload_sha256' as ingress_payload_sha256,
          to_jsonb(event) -> 'ingress_raw_sha256' as ingress_raw_sha256,
          to_jsonb(event) -> 'ingress_api_version' as ingress_api_version,
          to_jsonb(event) -> 'ingress_livemode' as ingress_livemode,
          to_jsonb(event) -> 'ingress_created' as ingress_created,
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
          claimed.raw_payload,
          claimed.ingress_evidence_supported,
          claimed.ingress_event_id,
          claimed.ingress_event_type,
          claimed.ingress_payload_sha256,
          claimed.ingress_raw_sha256,
          claimed.ingress_api_version,
          claimed.ingress_livemode,
          claimed.ingress_created,
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
          dead_lettered.raw_payload,
          dead_lettered.ingress_evidence_supported,
          dead_lettered.ingress_event_id,
          dead_lettered.ingress_event_type,
          dead_lettered.ingress_payload_sha256,
          dead_lettered.ingress_raw_sha256,
          dead_lettered.ingress_api_version,
          dead_lettered.ingress_livemode,
          dead_lettered.ingress_created,
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
    const eventId = String(row.event_id);
    const eventType = String(row.event_type);
    const payload = row.payload as Stripe.Event;
    const rawPayload = String(row.raw_payload || "");
    const derivesIngressEvidence = row.ingress_evidence_supported !== true;
    claimed.push({
      eventId,
      eventType,
      stripeCreatedAt: row.stripe_created_at as Date | string,
      payload,
      rawPayload,
      ingressEventId: derivesIngressEvidence ? eventId : String(row.ingress_event_id || ""),
      ingressEventType: derivesIngressEvidence ? eventType : String(row.ingress_event_type || ""),
      ingressPayloadSha256: String(row.ingress_payload_sha256 || ""),
      ingressRawSha256: String(row.ingress_raw_sha256 || ""),
      ingressApiVersion: derivesIngressEvidence
        ? (typeof payload?.api_version === "string" ? payload.api_version : "")
        : String(row.ingress_api_version || ""),
      ingressLivemode: derivesIngressEvidence
        ? payload?.livemode === true
        : row.ingress_livemode === true,
      ingressCreated: derivesIngressEvidence
        ? Number(payload?.created)
        : Number(row.ingress_created),
      ...(derivesIngressEvidence ? { ingressEvidence: "derived" as const } : {}),
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
    const result = await processClaimedStripeEvent(row, {
      maxAttempts,
      query,
      processEvent,
      random,
      now,
      log,
    });
    if (result.status === "processed" || result.status === "ignored") {
      summary[result.status] += 1;
    } else if (result.status === "dead_letter") {
      summary.deadLetter += 1;
    } else if (result.status === "retryable") {
      summary.retryable += 1;
    }
  }

  return Object.freeze(summary);
}

/**
 * Processes one already-claimed row with the same payload checks, CAS terminal
 * writes, retry delay, and absolute failure bound used by the queue drain.
 * Test-only recovery tooling may supply one exact audited claim; this function
 * never claims work, changes the attempt cap, or mutates entitlements directly.
 */
export async function processClaimedStripeEvent(
  row: ClaimedStripeEvent,
  options: StripeEventClaimProcessingOptions = {},
): Promise<StripeEventClaimProcessingResult> {
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
      return Object.freeze({ status: "claim_lost", outcome: "claim_lost", durationMs });
    }
    log(stripeEventLog(row, result.outcome, durationMs));
    return Object.freeze({
      status: result.status,
      outcome: safeOutcome(result.outcome),
      durationMs,
    });
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
      return Object.freeze({ status: "claim_lost", outcome: "claim_lost", durationMs });
    }
    log(stripeEventLog(row, failure, durationMs));
    return Object.freeze({ status: failure, outcome: failure, durationMs });
  }
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
  const projectionClock = await commerceQuery(`
    select to_char(clock_timestamp() at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as projection_observed_at
  `);
  const projectionObservedAt = String(
    projectionClock.rows[0]?.projection_observed_at || "",
  );
  const canonicalCommerceEvent = await retrieveCanonicalCommerceEvent(event);
  const commerce = await materializeCustomerCommerceEvent(
    canonicalCommerceEvent,
    commerceQuery,
    environment.namespace,
    { projectionObservedAt },
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

async function retrieveCanonicalCommerceEvent(event: Stripe.Event): Promise<Stripe.Event> {
  const objectId = stripeObjectId(event.data.object);
  if (!objectId) return event;
  const stripe = account.getStripe();
  let object: Stripe.Event["data"]["object"] | null = null;
  if (event.type.startsWith("checkout.session.")) {
    object = await stripe.checkout.sessions.retrieve(
      objectId,
      { expand: ["line_items.data.price.product"] },
      account.getStripeRequestOptions(),
    );
  } else if (event.type.startsWith("payment_intent.")) {
    object = await stripe.paymentIntents.retrieve(
      objectId,
      { expand: ["latest_charge"] },
      account.getStripeRequestOptions(),
    );
  } else if (event.type.startsWith("charge.dispute.")) {
    object = await stripe.disputes.retrieve(
      objectId,
      {},
      account.getStripeRequestOptions(),
    );
  } else if (event.type.startsWith("charge.")) {
    object = await stripe.charges.retrieve(
      objectId,
      { expand: ["payment_intent"] },
      account.getStripeRequestOptions(),
    );
  } else if (event.type.startsWith("refund.")) {
    object = await stripe.refunds.retrieve(
      objectId,
      { expand: ["charge", "payment_intent"] },
      account.getStripeRequestOptions(),
    );
  } else if (event.type.startsWith("invoice.")) {
    object = await stripe.invoices.retrieve(
      objectId,
      { expand: ["payments"] },
      account.getStripeRequestOptions(),
    );
  } else if (event.type.startsWith("customer.subscription.")) {
    object = await stripe.subscriptions.retrieve(
      objectId,
      {},
      account.getStripeRequestOptions(),
    );
  }
  if (!object || stripeObjectId(object) !== objectId) return event;
  return {
    ...event,
    data: { ...event.data, object },
  } as Stripe.Event;
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
      if (result.fulfilled === false) {
        return { status: "ignored", outcome: safeOutcome(`checkout_${result.reason}`) };
      }
      return {
        status: "processed",
        outcome: "activationBound" in result && result.activationBound
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
      if (result.fulfilled === false) {
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
        throw new StripeEventProcessingError("lifecycle_reconciler_unavailable");
      }
      const result = await account.reconcileOneTimePaymentLifecycle(
        event.type,
        event.data.object,
        { eventId: event.id, created: event.created },
      );
      if (result.fulfilled === false) {
        if (result.reason === "stale_event") {
          return { status: "processed", outcome: "lifecycle_stale_noop" };
        }
        throw new StripeEventProcessingError(
          safeOutcome(`lifecycle_${result.reason}`),
        );
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
  const storedCreated = Math.floor(new Date(row.stripeCreatedAt).getTime() / 1_000);
  if (row.ingressEvidence === "derived") {
    let signedPayload: unknown;
    try {
      signedPayload = JSON.parse(row.rawPayload);
    } catch {
      throw new StripeEventProcessingError("payload_identity_mismatch");
    }
    if (
      row.payload.id !== row.eventId ||
      row.payload.type !== row.eventType ||
      row.payload.created !== storedCreated ||
      typeof row.payload.livemode !== "boolean" ||
      canonicalJsonDigest(signedPayload) !== canonicalJsonDigest(row.payload)
    ) {
      throw new StripeEventProcessingError("payload_identity_mismatch");
    }
    const apiVersion = typeof row.payload.api_version === "string"
      ? row.payload.api_version
      : "";
    if (
      !SUPPORTED_STRIPE_EVENT_API_VERSIONS.includes(
        apiVersion as typeof SUPPORTED_STRIPE_EVENT_API_VERSIONS[number],
      )
    ) {
      throw new StripeEventProcessingError("unsupported_event_api_version");
    }
    return;
  }
  if (
    row.payload.id !== row.eventId ||
    row.payload.type !== row.eventType ||
    row.ingressEventId !== row.eventId ||
    row.ingressEventType !== row.eventType ||
    row.payload.created !== row.ingressCreated ||
    row.ingressCreated !== storedCreated ||
    row.payload.livemode !== row.ingressLivemode ||
    canonicalJsonDigest(row.payload) !== row.ingressPayloadSha256 ||
    !row.rawPayload ||
    sha256(row.rawPayload) !== row.ingressRawSha256
  ) {
    throw new StripeEventProcessingError("payload_identity_mismatch");
  }
  const apiVersion = typeof row.payload.api_version === "string"
    ? row.payload.api_version
    : "";
  if (
    apiVersion !== row.ingressApiVersion ||
    !SUPPORTED_STRIPE_EVENT_API_VERSIONS.includes(
      apiVersion as typeof SUPPORTED_STRIPE_EVENT_API_VERSIONS[number],
    )
  ) {
    throw new StripeEventProcessingError("unsupported_event_api_version");
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function isMissingOptionalStripeIngressColumn(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const postgresError = error as { code?: unknown; message?: unknown };
  const message = typeof postgresError.message === "string" ? postgresError.message : "";
  if (postgresError.code !== "42703" || !message) {
    return false;
  }
  return [
    "ingress_event_id",
    "ingress_event_type",
    "ingress_created",
    "ingress_livemode",
    "ingress_api_version",
    "ingress_payload_sha256",
    "ingress_raw_sha256",
  ].some((column) => message.includes(column));
}

function canonicalJsonDigest(value: unknown) {
  return sha256(JSON.stringify(sortJsonValue(JSON.parse(JSON.stringify(value)))));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
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

import { createHmac, timingSafeEqual } from "node:crypto";
import { withPostgresTransaction } from "./postgres.js";

const EXPERIMENT_ID = "upgrade-pricing-v1";
const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 366;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const VERSION_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:[-+][0-9A-Za-z.-]{1,40})?$/;
const VARIANTS = ["control_one_time", "monthly_half"] as const;

type Variant = typeof VARIANTS[number];
type Namespace = "production" | "test";
type QueryResult<Row> = Promise<{ rows: Row[] }>;
type QueryFunction = <Row = Record<string, unknown>>(
  sql: string,
  values?: unknown[],
) => QueryResult<Row>;

export type UpgradePricingReportRequest = Readonly<{
  namespace: Namespace;
  from: string;
  through: string;
  asOf: string;
  pageSize: number;
  cursor: string | null;
  modeledLtv: ModeledLtvAssumptions | null;
}>;

type ModeledLtvAssumptions = Readonly<{
  horizonMonths: number;
  monthlyChurnRate: number;
  feeRate: number;
  refundRate: number;
  fixedFeeMinorByCurrency: Readonly<Record<string, number>>;
}>;

export type UpgradePricingCohortObservation = Readonly<{
  intentId: string;
  assignmentId: string | null;
  accountId: string;
  acquisitionId: string;
  variant: Variant;
  billingModel: "one_time" | "subscription";
  country: string;
  currency: string;
  amountMinor: number;
  assignedAt: string | null;
  intentCreatedAt: string;
  exposedAt: string | null;
  sessionStarted: boolean;
  sessionAttempt: number;
  intentState: string;
  oneTimePaidAt: string | null;
  oneTimeGrossMinor: number;
  oneTimeRefundedMinor: number;
  subscriptionStatus: string | null;
  subscriptionEntitlementStatus: string | null;
  cancelAtPeriodEnd: boolean;
  entitlementActivated: boolean;
  activationCompletedAt: string | null;
  activationClientVersion: string | null;
  assignmentSnapshotDefect: boolean;
  exposureLineageDefect: boolean;
  acquisitionLineageDefect: boolean;
  activationLineageDefect: boolean;
}>;

export type UpgradePricingEventObservation = Readonly<{
  eventKey: string;
  intentId: string;
  objectKey: string;
  eventType: string;
  occurredAt: string;
  amountMinor: number;
  currency: string | null;
  status: string | null;
  billingReason: string | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}>;

type CohortDatabaseRow = Record<string, unknown>;
type EventDatabaseRow = Record<string, unknown>;

export class UpgradePricingReportValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "UpgradePricingReportValidationError";
    this.code = code;
  }
}

export const UPGRADE_PRICING_COHORT_SQL = `
  select
    intent.id::text as intent_id,
    intent.upgrade_pricing_assignment_id::text as assignment_id,
    intent.account_id::text as account_id,
    intent.acquisition_id::text as acquisition_id,
    intent.upgrade_pricing_variant as variant,
    intent.upgrade_pricing_billing_model as billing_model,
    intent.upgrade_pricing_country as country,
    intent.upgrade_pricing_currency as currency,
    intent.upgrade_pricing_amount_minor,
    intent.upgrade_pricing_assigned_at,
    intent.created_at as intent_created_at,
    exposure.exposed_at,
    (intent.stripe_checkout_session_id is not null) as session_started,
    intent.attempt as session_attempt,
    intent.state as intent_state,
    case
      when intent.upgrade_pricing_billing_model = 'one_time'
        and license.id is not null
      then coalesce(license.reconciled_at, license.created_at)
      else null
    end as one_time_paid_at,
    case
      when intent.upgrade_pricing_billing_model = 'one_time'
        then coalesce(license.amount_paid, 0)
      else 0
    end as one_time_gross_minor,
    case
      when intent.upgrade_pricing_billing_model = 'one_time'
        then coalesce(license.amount_refunded, 0)
      else 0
    end as one_time_refunded_minor,
    case when intent.upgrade_pricing_billing_model = 'subscription'
      then license.status else null end as subscription_status,
    case when intent.upgrade_pricing_billing_model = 'subscription'
      then license.entitlement_status else null end as subscription_entitlement_status,
    case when intent.upgrade_pricing_billing_model = 'subscription'
      then coalesce(license.cancel_at_period_end, false) else false end
      as cancel_at_period_end,
    (license.id is not null) as entitlement_activated,
    activation.completed_at as activation_completed_at,
    activation.app_version as activation_client_version,
    (
      intent.upgrade_pricing_assignment_id is not null
      and (
        assignment.id is null
        or assignment.account_id is distinct from intent.account_id
        or assignment.variant is distinct from intent.upgrade_pricing_variant
        or assignment.billing_model is distinct from intent.upgrade_pricing_billing_model
      )
    ) as assignment_snapshot_defect,
    (
      (license.id is not null and exposure.id is null)
      or (
        exposure.id is not null
        and (
        exposure.account_id is distinct from intent.account_id
        or exposure.assignment_id is distinct from intent.upgrade_pricing_assignment_id
        or exposure.variant is distinct from intent.upgrade_pricing_variant
        or exposure.billing_model is distinct from intent.upgrade_pricing_billing_model
        )
      )
    ) as exposure_lineage_defect,
    (
      acquisition.id is null
      or acquisition.id is distinct from intent.upgrade_pricing_acquisition_id
      or acquisition.license_namespace is distinct from $1
    ) as acquisition_lineage_defect,
    (
      intent.upgrade_pricing_activation_session_id is not null
      and (
        snapshot_activation.id is null
        or (
          snapshot_activation.account_id is not null
          and snapshot_activation.account_id is distinct from intent.account_id
        )
        or (
          snapshot_activation.stripe_checkout_session_id is not null
          and snapshot_activation.stripe_checkout_session_id
            is distinct from intent.stripe_checkout_session_id
        )
        or (
          snapshot_activation.license_id is not null
          and license.id is not null
          and snapshot_activation.license_id is distinct from license.id
        )
      )
    ) as activation_lineage_defect
  from public.sidestream_checkout_intents intent
  join public.sidestream_acquisitions acquisition
    on acquisition.id = intent.acquisition_id
    and acquisition.license_namespace = $1
  left join public.sidestream_upgrade_pricing_assignments assignment
    on assignment.id = intent.upgrade_pricing_assignment_id
  left join public.sidestream_upgrade_pricing_exposures exposure
    on exposure.checkout_intent_id = intent.id
    and exposure.experiment_id = intent.upgrade_pricing_experiment_id
  left join public.sidestream_activation_sessions snapshot_activation
    on snapshot_activation.id = intent.upgrade_pricing_activation_session_id
  left join lateral (
    select candidate.*
    from public.sidestream_licenses candidate
    where candidate.account_id = intent.account_id
      and candidate.stripe_checkout_session_id = intent.stripe_checkout_session_id
      and (
        intent.upgrade_pricing_billing_model = 'one_time'
        or (
          candidate.stripe_subscription_id is not null
          and coalesce(candidate.features ->> 'upgrade_pricing_v1', 'false') = 'true'
          and coalesce(candidate.features ->> 'subscription', 'false') = 'true'
        )
      )
    order by candidate.updated_at desc, candidate.id desc
    limit 1
  ) license on true
  left join lateral (
    select candidate.*
    from public.sidestream_activation_sessions candidate
    where candidate.completed_at is not null
      and candidate.account_id = intent.account_id
      and candidate.license_id = license.id
      and (
        candidate.id = intent.upgrade_pricing_activation_session_id
        or candidate.stripe_checkout_session_id = intent.stripe_checkout_session_id
      )
    order by
      (candidate.id = intent.upgrade_pricing_activation_session_id) desc,
      candidate.completed_at asc,
      candidate.id asc
    limit 1
  ) activation on true
  where intent.upgrade_pricing_snapshot_version = 1
    and intent.upgrade_pricing_experiment_id = '${EXPERIMENT_ID}'
    and intent.created_at >= $2::timestamptz
    and intent.created_at < $3::timestamptz
    and intent.created_at <= $4::timestamptz
  order by intent.created_at asc, intent.id asc
`;

export const UPGRADE_PRICING_EVENTS_SQL = `
  with normalized as (
    select
      event.event_id,
      event.event_type,
      event.stripe_created_at,
      coalesce(
        event.payload #>> '{data,object,metadata,sidestream_upgrade_intent_id}',
        event.payload #>> '{data,object,parent,subscription_details,metadata,sidestream_upgrade_intent_id}',
        event.payload #>> '{data,object,subscription_details,metadata,sidestream_upgrade_intent_id}',
        event.payload #>> '{data,object,lines,data,0,metadata,sidestream_upgrade_intent_id}',
        event.payload #>> '{data,object,metadata,sidestream_checkout_intent_id}',
        event.payload #>> '{data,object,parent,subscription_details,metadata,sidestream_checkout_intent_id}',
        event.payload #>> '{data,object,subscription_details,metadata,sidestream_checkout_intent_id}',
        event.payload #>> '{data,object,lines,data,0,metadata,sidestream_checkout_intent_id}'
      ) as intent_id,
      coalesce(event.payload #>> '{data,object,id}', event.event_id) as object_id,
      coalesce(
        nullif(event.payload #>> '{data,object,amount_paid}', ''),
        nullif(event.payload #>> '{data,object,amount_refunded}', ''),
        nullif(event.payload #>> '{data,object,amount}', ''),
        '0'
      ) as amount_minor,
      lower(nullif(event.payload #>> '{data,object,currency}', '')) as currency,
      nullif(event.payload #>> '{data,object,status}', '') as status,
      nullif(event.payload #>> '{data,object,billing_reason}', '') as billing_reason,
      coalesce(
        nullif(event.payload #>> '{data,object,period_end}', ''),
        nullif(event.payload #>> '{data,object,lines,data,0,period,end}', '')
      ) as period_end,
      case lower(event.payload #>> '{data,object,cancel_at_period_end}')
        when 'true' then true else false end as cancel_at_period_end
    from public.sidestream_stripe_events event
    where event.event_type in (
      'invoice.paid',
      'invoice.payment_failed',
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'refund.created',
      'refund.updated',
      'charge.refunded',
      'credit_note.created',
      'credit_note.updated'
    )
      and event.stripe_created_at <= $4::timestamptz
  )
  select
    normalized.event_id as event_key,
    normalized.intent_id,
    normalized.object_id as object_key,
    normalized.event_type,
    normalized.stripe_created_at as occurred_at,
    case when normalized.amount_minor ~ '^[0-9]{1,18}$'
      then normalized.amount_minor::bigint else 0 end as amount_minor,
    normalized.currency,
    normalized.status,
    normalized.billing_reason,
    case when normalized.period_end ~ '^[0-9]{1,12}$'
      then to_timestamp(normalized.period_end::double precision) else null end as period_end,
    normalized.cancel_at_period_end
  from normalized
  join public.sidestream_checkout_intents intent
    on intent.id::text = normalized.intent_id
  join public.sidestream_acquisitions acquisition
    on acquisition.id = intent.acquisition_id
    and acquisition.license_namespace = $1
  where intent.upgrade_pricing_snapshot_version = 1
    and intent.upgrade_pricing_experiment_id = '${EXPERIMENT_ID}'
    and intent.created_at >= $2::timestamptz
    and intent.created_at < $3::timestamptz
    and intent.created_at <= $4::timestamptz
  order by normalized.stripe_created_at asc, normalized.event_id asc
`;

export function parseUpgradePricingReportRequest(
  input: unknown,
  now = new Date(),
): UpgradePricingReportRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalid("invalid_request", "Report request must be an object");
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set([
    "namespace", "from", "through", "asOf", "pageSize", "cursor", "modeledLtv",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalid("unknown_field", `Unknown report field: ${key}`);
  }

  const namespace = record.namespace;
  if (namespace !== "production" && namespace !== "test") {
    throw invalid("invalid_namespace", "namespace must be production or test");
  }
  const asOfDate = parseDate(record.asOf ?? now.toISOString(), "asOf");
  if (asOfDate.getTime() > now.getTime() + 60_000) {
    throw invalid("invalid_as_of", "asOf cannot be in the future");
  }
  const throughDate = parseDate(record.through ?? asOfDate.toISOString(), "through");
  const defaultFrom = new Date(
    throughDate.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1_000,
  );
  const fromDate = parseDate(record.from ?? defaultFrom.toISOString(), "from");
  if (fromDate >= throughDate) {
    throw invalid("invalid_window", "from must be before through");
  }
  if (throughDate > asOfDate) {
    throw invalid("invalid_window", "through cannot be after asOf");
  }
  if (throughDate.getTime() - fromDate.getTime() > MAX_WINDOW_DAYS * 86_400_000) {
    throw invalid("invalid_window", `Report window cannot exceed ${MAX_WINDOW_DAYS} days`);
  }
  const pageSize = record.pageSize === undefined ? DEFAULT_PAGE_SIZE : Number(record.pageSize);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw invalid("invalid_page_size", `pageSize must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }
  const cursor = record.cursor === undefined || record.cursor === null
    ? null
    : stringValue(record.cursor, "cursor", 2_048);

  return Object.freeze({
    namespace,
    from: fromDate.toISOString(),
    through: throughDate.toISOString(),
    asOf: asOfDate.toISOString(),
    pageSize,
    cursor,
    modeledLtv: parseModeledLtv(record.modeledLtv),
  });
}

export async function queryUpgradePricingReport(
  input: unknown,
  cursorSecret: string,
  dependencies: Readonly<{
    query?: QueryFunction;
    transaction?: (callback: (query: QueryFunction) => Promise<unknown>) => Promise<unknown>;
    now?: Date;
  }> = {},
) {
  const request = parseUpgradePricingReportRequest(input, dependencies.now || new Date());
  const values = [request.namespace, request.from, request.through, request.asOf];
  const loadRows = async (runQuery: QueryFunction) => {
    const cohortResult = await runQuery<CohortDatabaseRow>(
      UPGRADE_PRICING_COHORT_SQL,
      values,
    );
    const eventResult = await runQuery<EventDatabaseRow>(
      UPGRADE_PRICING_EVENTS_SQL,
      values,
    );
    return { cohortResult, eventResult };
  };
  const { cohortResult, eventResult } = dependencies.query
    ? await loadRows(dependencies.query)
    : await withPostgresTransaction(
        async (client) => loadRows(<Row = Record<string, unknown>>(
          sql: string,
          parameters: unknown[] = [],
        ) => client.query<Row & Record<string, unknown>>(sql, parameters)),
        { isolationLevel: "repeatable read", readOnly: true },
      );
  return buildUpgradePricingReport(
    cohortResult.rows.map(normalizeCohortRow),
    eventResult.rows.map(normalizeEventRow),
    request,
    cursorSecret,
  );
}

export function buildUpgradePricingReport(
  cohortInput: readonly UpgradePricingCohortObservation[],
  eventInput: readonly UpgradePricingEventObservation[],
  requestInput: UpgradePricingReportRequest | unknown,
  cursorSecret: string,
) {
  if (typeof cursorSecret !== "string" || cursorSecret.length < 16) {
    throw new Error("A configured report cursor secret is required");
  }
  const request = isParsedRequest(requestInput)
    ? requestInput
    : parseUpgradePricingReportRequest(requestInput);
  const cohort = dedupeCohort(cohortInput);
  const cohortByIntent = new Map(cohort.map((row) => [row.intentId, row]));
  const events = dedupeEvents(eventInput)
    .filter((event) => cohortByIntent.has(event.intentId))
    .filter((event) => new Date(event.occurredAt).getTime() <= new Date(request.asOf).getTime());
  const eventsByIntent = groupBy(events, (event) => event.intentId);
  const asOfMs = new Date(request.asOf).getTime();

  const groups = new Map<string, MutableMetrics>();
  const allUp = new Map<Variant, MutableMetrics>(
    VARIANTS.map((variant) => [variant, createMetrics(variant, "ALL", "all")]),
  );
  const versionGroups = new Map<string, MutableVersionMetrics>();

  for (const row of cohort) {
    const groupKey = segmentKey(row.variant, row.country, row.currency);
    const segment = getOrCreate(groups, groupKey, () =>
      createMetrics(row.variant, row.country, row.currency));
    const variantTotal = allUp.get(row.variant)!;
    const intentEvents = eventsByIntent.get(row.intentId) || [];
    accumulateRow(segment, row, intentEvents, asOfMs);
    accumulateRow(variantTotal, row, intentEvents, asOfMs);

    if (row.activationCompletedAt && row.activationClientVersion) {
      const version = safeClientVersion(row.activationClientVersion);
      const key = `${row.variant}\u0000${version}`;
      const versionMetric = getOrCreate(versionGroups, key, () => ({
        variant: row.variant,
        clientVersion: version,
        exactLineageActivations: 0,
      }));
      versionMetric.exactLineageActivations += 1;
    }
  }

  const allSegments = [...groups.values()]
    .map(finalizeMetrics)
    .sort(compareSegment);
  const cursorAfterKey = request.cursor
    ? verifyCursor(request.cursor, request, cursorSecret)
    : null;
  const startIndex = cursorAfterKey
    ? allSegments.findIndex((segment) => segmentKeyOf(segment) > cursorAfterKey)
    : 0;
  const normalizedStart = startIndex < 0 ? allSegments.length : startIndex;
  const page = allSegments.slice(normalizedStart, normalizedStart + request.pageSize);
  const hasMore = normalizedStart + page.length < allSegments.length;
  const nextCursor = hasMore && page.length > 0
    ? signCursor(segmentKeyOf(page[page.length - 1]), request, cursorSecret)
    : null;

  const allUpRows = [...allUp.values()].map(finalizeMetrics);
  const currencyTotals = finalizeCurrencyTotals(allSegments);
  const report = {
    schemaVersion: 1,
    experimentId: EXPERIMENT_ID,
    mode: "observed" as const,
    namespace: request.namespace,
    observationWindow: {
      from: request.from,
      throughExclusive: request.through,
      asOf: request.asOf,
      matureNonConverterWindowsHours: [24, 168],
    },
    definitions: {
      assignmentGrain: "unique authenticated account with an immutable experiment intent snapshot",
      exposureGrain: "unique account with append-only opened Checkout evidence",
      activationDenominator: "unique exposed accounts in the same variant and country/currency segment",
      retentionDenominator: "successful subscribers whose prior paid invoice period end is at or before asOf",
      money: "integer minor units, never summed across currencies",
      sessionReuse: "started-or-reused is observable at the unique persisted Session grain; browser reuse calls are not durably counted",
      clientVersion: "only exact activation-session or Checkout-Session lineage; malformed versions are grouped as unknown",
    },
    allUpNonMoney: allUpRows.map(stripMoney),
    assignmentBalance: buildAssignmentBalance(allUpRows),
    clientVersionSegments: [...versionGroups.values()].sort((left, right) =>
      left.variant.localeCompare(right.variant) ||
      compareVersions(left.clientVersion, right.clientVersion)),
    segments: page,
    currencyTotals,
    relativeLift: {
      activation: buildActivationLift(allSegments, allUpRows),
      realizedRevenuePerExposed: buildRevenueLift(allSegments, currencyTotals),
    },
    modeledLtvScenarios: request.modeledLtv
      ? buildModeledLtvScenarios(allSegments, request.modeledLtv)
      : [],
    pagination: {
      pageSize: request.pageSize,
      returned: page.length,
      totalSegments: allSegments.length,
      nextCursor,
    },
  };
  assertPrivacySafe(report);
  return report;
}

type MutableMetrics = {
  variant: Variant;
  country: string;
  currency: string;
  accountIds: Set<string>;
  assignedAccountIds: Set<string>;
  exposedAccountIds: Set<string>;
  sessionIntentIds: Set<string>;
  sessionReplacementAttempts: number;
  oneTimePurchaserIds: Set<string>;
  firstSubscriptionPayerIds: Set<string>;
  activatedConverterIds: Set<string>;
  pendingIds: Set<string>;
  mature24HourNonConverterIds: Set<string>;
  mature7DayNonConverterIds: Set<string>;
  activeSubscriberIds: Set<string>;
  cancelAtPeriodEndIds: Set<string>;
  canceledBeforePaymentTwoIds: Set<string>;
  secondInvoiceSuccessIds: Set<string>;
  thirdInvoiceSuccessIds: Set<string>;
  secondInvoiceMatureIds: Set<string>;
  thirdInvoiceMatureIds: Set<string>;
  failedInvoiceKeys: Set<string>;
  recoveredInvoiceKeys: Set<string>;
  refundKeys: Set<string>;
  creditKeys: Set<string>;
  grossMinor: number;
  refundedMinor: number;
  creditedMinor: number;
  mrrMinor: number;
  amounts: Set<number>;
  integrity: Record<string, number>;
};

type MutableVersionMetrics = {
  variant: Variant;
  clientVersion: string;
  exactLineageActivations: number;
};

function createMetrics(variant: Variant, country: string, currency: string): MutableMetrics {
  return {
    variant,
    country,
    currency,
    accountIds: new Set(),
    assignedAccountIds: new Set(),
    exposedAccountIds: new Set(),
    sessionIntentIds: new Set(),
    sessionReplacementAttempts: 0,
    oneTimePurchaserIds: new Set(),
    firstSubscriptionPayerIds: new Set(),
    activatedConverterIds: new Set(),
    pendingIds: new Set(),
    mature24HourNonConverterIds: new Set(),
    mature7DayNonConverterIds: new Set(),
    activeSubscriberIds: new Set(),
    cancelAtPeriodEndIds: new Set(),
    canceledBeforePaymentTwoIds: new Set(),
    secondInvoiceSuccessIds: new Set(),
    thirdInvoiceSuccessIds: new Set(),
    secondInvoiceMatureIds: new Set(),
    thirdInvoiceMatureIds: new Set(),
    failedInvoiceKeys: new Set(),
    recoveredInvoiceKeys: new Set(),
    refundKeys: new Set(),
    creditKeys: new Set(),
    grossMinor: 0,
    refundedMinor: 0,
    creditedMinor: 0,
    mrrMinor: 0,
    amounts: new Set(),
    integrity: {
      assignmentSnapshot: 0,
      exposureLineage: 0,
      acquisitionLineage: 0,
      activationLineage: 0,
      eventCurrency: 0,
      eventOrder: 0,
      priceSnapshot: 0,
    },
  };
}

function accumulateRow(
  metrics: MutableMetrics,
  row: UpgradePricingCohortObservation,
  rawEvents: readonly UpgradePricingEventObservation[],
  asOfMs: number,
) {
  metrics.accountIds.add(row.accountId);
  if (row.assignmentId) metrics.assignedAccountIds.add(row.accountId);
  if (row.exposedAt) metrics.exposedAccountIds.add(row.accountId);
  if (row.sessionStarted) metrics.sessionIntentIds.add(row.intentId);
  metrics.sessionReplacementAttempts += Math.max(0, row.sessionAttempt);
  metrics.amounts.add(row.amountMinor);
  if (row.assignmentSnapshotDefect) metrics.integrity.assignmentSnapshot += 1;
  if (row.exposureLineageDefect) metrics.integrity.exposureLineage += 1;
  if (row.acquisitionLineageDefect) metrics.integrity.acquisitionLineage += 1;
  if (row.activationLineageDefect) metrics.integrity.activationLineage += 1;

  const materialized = materializeIntentEvents(rawEvents, row.currency, metrics.integrity);
  const paidInvoices = materialized.paidInvoices;
  const converted = row.billingModel === "one_time"
    ? Boolean(row.oneTimePaidAt)
    : paidInvoices.length > 0;

  if (row.billingModel === "one_time" && converted) {
    metrics.oneTimePurchaserIds.add(row.accountId);
    metrics.grossMinor += row.oneTimeGrossMinor;
    metrics.refundedMinor += Math.min(row.oneTimeRefundedMinor, row.oneTimeGrossMinor);
    if (row.oneTimeRefundedMinor > 0) {
      metrics.refundKeys.add(`one-time:${row.accountId}`);
    }
  }
  if (row.billingModel === "subscription") {
    if (paidInvoices.length > 0) metrics.firstSubscriptionPayerIds.add(row.accountId);
    if (paidInvoices.length > 1) metrics.secondInvoiceSuccessIds.add(row.accountId);
    if (paidInvoices.length > 2) metrics.thirdInvoiceSuccessIds.add(row.accountId);
    if (isMaturePeriod(paidInvoices[0]?.periodEnd, asOfMs)) {
      metrics.secondInvoiceMatureIds.add(row.accountId);
    }
    if (isMaturePeriod(paidInvoices[1]?.periodEnd, asOfMs)) {
      metrics.thirdInvoiceMatureIds.add(row.accountId);
    }
    for (const invoice of paidInvoices) metrics.grossMinor += invoice.amountMinor;
    if (row.subscriptionEntitlementStatus === "active" &&
        new Set(["active", "trialing"]).has(row.subscriptionStatus || "")) {
      metrics.activeSubscriberIds.add(row.accountId);
      metrics.mrrMinor += row.amountMinor;
    }
    if (row.cancelAtPeriodEnd || materialized.latestSubscription?.cancelAtPeriodEnd) {
      metrics.cancelAtPeriodEndIds.add(row.accountId);
    }
    if (materialized.latestSubscription?.terminal && paidInvoices.length < 2) {
      metrics.canceledBeforePaymentTwoIds.add(row.accountId);
    }
  }

  for (const failed of materialized.failedInvoices) metrics.failedInvoiceKeys.add(failed);
  for (const recovered of materialized.recoveredInvoices) metrics.recoveredInvoiceKeys.add(recovered);
  if (row.billingModel === "subscription") {
    for (const refund of materialized.refunds) {
      metrics.refundKeys.add(refund.objectKey);
      metrics.refundedMinor += refund.amountMinor;
    }
    for (const credit of materialized.credits) {
      metrics.creditKeys.add(credit.objectKey);
      metrics.creditedMinor += credit.amountMinor;
    }
  }

  if (row.entitlementActivated && row.exposedAt) {
    metrics.activatedConverterIds.add(row.accountId);
  }
  if (row.exposedAt && !converted) {
    metrics.pendingIds.add(row.accountId);
    const ageMs = asOfMs - new Date(row.exposedAt).getTime();
    if (ageMs >= 24 * 60 * 60 * 1_000) metrics.mature24HourNonConverterIds.add(row.accountId);
    if (ageMs >= 7 * 24 * 60 * 60 * 1_000) metrics.mature7DayNonConverterIds.add(row.accountId);
  }
}

function materializeIntentEvents(
  events: readonly UpgradePricingEventObservation[],
  expectedCurrency: string,
  integrity: Record<string, number>,
) {
  const invoices = new Map<string, UpgradePricingEventObservation[]>();
  const subscriptions: UpgradePricingEventObservation[] = [];
  const refunds = new Map<string, UpgradePricingEventObservation>();
  const chargeRefunds = new Map<string, UpgradePricingEventObservation>();
  const credits = new Map<string, UpgradePricingEventObservation>();

  for (const event of events) {
    if (event.currency && event.currency !== expectedCurrency) {
      integrity.eventCurrency += 1;
      continue;
    }
    if (event.eventType.startsWith("invoice.")) {
      const list = invoices.get(event.objectKey) || [];
      list.push(event);
      invoices.set(event.objectKey, list);
    } else if (event.eventType.startsWith("customer.subscription.")) {
      subscriptions.push(event);
    } else if (event.eventType.startsWith("refund.")) {
      setLatest(refunds, event);
    } else if (event.eventType === "charge.refunded") {
      setLatest(chargeRefunds, event);
    } else if (event.eventType.startsWith("credit_note.")) {
      setLatest(credits, event);
    }
  }

  const paidInvoices: UpgradePricingEventObservation[] = [];
  const failedInvoices = new Set<string>();
  const recoveredInvoices = new Set<string>();
  for (const [objectKey, invoiceEvents] of invoices) {
    invoiceEvents.sort(compareEvents);
    const paid = invoiceEvents.filter((event) => event.eventType === "invoice.paid");
    const failed = invoiceEvents.filter((event) => event.eventType === "invoice.payment_failed");
    if (failed.length > 0) failedInvoices.add(objectKey);
    const latestPaid = paid[paid.length - 1];
    if (latestPaid) paidInvoices.push(latestPaid);
    if (latestPaid && failed.some((event) => compareEvents(event, latestPaid) < 0)) {
      recoveredInvoices.add(objectKey);
    }
    if (paid.length > 1) integrity.eventOrder += paid.length - 1;
  }
  paidInvoices.sort(compareEvents);
  subscriptions.sort(compareEvents);
  const latestSubscriptionEvent = subscriptions[subscriptions.length - 1];
  const latestSubscription = latestSubscriptionEvent
    ? {
        cancelAtPeriodEnd: latestSubscriptionEvent.cancelAtPeriodEnd,
        terminal: latestSubscriptionEvent.eventType === "customer.subscription.deleted" ||
          new Set(["canceled", "unpaid", "incomplete_expired", "paused"]).has(
            latestSubscriptionEvent.status || "",
          ),
      }
    : null;
  const usableRefunds = refunds.size > 0 ? [...refunds.values()] : [...chargeRefunds.values()];
  return {
    paidInvoices,
    failedInvoices,
    recoveredInvoices,
    latestSubscription,
    refunds: usableRefunds.filter((event) => event.status !== "failed"),
    credits: [...credits.values()].filter((event) =>
      !new Set(["void", "failed", "canceled"]).has(event.status || "")),
  };
}

function finalizeMetrics(metrics: MutableMetrics) {
  const netMinor = Math.max(
    0,
    metrics.grossMinor - metrics.refundedMinor - metrics.creditedMinor,
  );
  const exposed = metrics.exposedAccountIds.size;
  return {
    variant: metrics.variant,
    country: metrics.country,
    currency: metrics.currency,
    counts: {
      uniqueEligibleAssigned: metrics.assignedAccountIds.size,
      uniqueExposed: exposed,
      checkoutSessionsStartedOrReused: metrics.sessionIntentIds.size,
      checkoutSessionReplacementAttempts: metrics.sessionReplacementAttempts,
      completedOneTimePurchases: metrics.oneTimePurchaserIds.size,
      firstSuccessfulSubscriptionPayments: metrics.firstSubscriptionPayerIds.size,
      entitlementActivations: metrics.activatedConverterIds.size,
      pending: metrics.pendingIds.size,
      mature24HourNonConverters: metrics.mature24HourNonConverterIds.size,
      mature7DayNonConverters: metrics.mature7DayNonConverterIds.size,
      activeSubscribers: metrics.activeSubscriberIds.size,
      cancelAtPeriodEnd: metrics.cancelAtPeriodEndIds.size,
      cancellationsBeforePaymentTwo: metrics.canceledBeforePaymentTwoIds.size,
      secondInvoiceSuccess: metrics.secondInvoiceSuccessIds.size,
      thirdInvoiceSuccess: metrics.thirdInvoiceSuccessIds.size,
      failedInvoices: metrics.failedInvoiceKeys.size,
      recoveredInvoices: metrics.recoveredInvoiceKeys.size,
      refunds: metrics.refundKeys.size,
      credits: metrics.creditKeys.size,
    },
    activation: rate(metrics.activatedConverterIds.size, exposed),
    retention: {
      paymentTwo: rate(
        intersectSize(metrics.secondInvoiceSuccessIds, metrics.secondInvoiceMatureIds),
        metrics.secondInvoiceMatureIds.size,
      ),
      paymentThree: rate(
        intersectSize(metrics.thirdInvoiceSuccessIds, metrics.thirdInvoiceMatureIds),
        metrics.thirdInvoiceMatureIds.size,
      ),
    },
    realizedMoney: {
      currency: metrics.currency,
      grossMinor: String(metrics.grossMinor),
      refundsMinor: String(metrics.refundedMinor),
      creditsMinor: String(metrics.creditedMinor),
      netMinor: String(netMinor),
      realizedRevenuePerExposed: decimalRate(netMinor, exposed),
      realizedRevenuePerExposedNumeratorMinor: String(netMinor),
      realizedRevenuePerExposedDenominator: exposed,
      mrrMinor: String(metrics.mrrMinor),
    },
    observedPriceMinor: metrics.amounts.size === 1
      ? String([...metrics.amounts][0])
      : null,
    integrityDefects: {
      ...metrics.integrity,
      priceSnapshot: metrics.amounts.size > 1 ? metrics.amounts.size : 0,
      total: Object.values(metrics.integrity).reduce((sum, value) => sum + value, 0) +
        (metrics.amounts.size > 1 ? metrics.amounts.size : 0),
    },
  };
}

function stripMoney(segment: ReturnType<typeof finalizeMetrics>) {
  const { realizedMoney: _money, observedPriceMinor: _price, ...nonMoney } = segment;
  return nonMoney;
}

function finalizeCurrencyTotals(segments: readonly ReturnType<typeof finalizeMetrics>[]) {
  const totals = new Map<string, {
    variant: Variant;
    currency: string;
    gross: bigint;
    refunds: bigint;
    credits: bigint;
    net: bigint;
    mrr: bigint;
    exposed: number;
  }>();
  for (const segment of segments) {
    const key = `${segment.variant}\u0000${segment.currency}`;
    const total = getOrCreate(totals, key, () => ({
      variant: segment.variant,
      currency: segment.currency,
      gross: 0n,
      refunds: 0n,
      credits: 0n,
      net: 0n,
      mrr: 0n,
      exposed: 0,
    }));
    total.gross += BigInt(segment.realizedMoney.grossMinor);
    total.refunds += BigInt(segment.realizedMoney.refundsMinor);
    total.credits += BigInt(segment.realizedMoney.creditsMinor);
    total.net += BigInt(segment.realizedMoney.netMinor);
    total.mrr += BigInt(segment.realizedMoney.mrrMinor);
    total.exposed += segment.counts.uniqueExposed;
  }
  return [...totals.values()]
    .map((total) => ({
      variant: total.variant,
      currency: total.currency,
      grossMinor: total.gross.toString(),
      refundsMinor: total.refunds.toString(),
      creditsMinor: total.credits.toString(),
      netMinor: total.net.toString(),
      realizedRevenuePerExposed: decimalRateBigInt(total.net, total.exposed),
      realizedRevenuePerExposedNumeratorMinor: total.net.toString(),
      realizedRevenuePerExposedDenominator: total.exposed,
      mrrMinor: total.mrr.toString(),
    }))
    .sort((left, right) =>
      left.currency.localeCompare(right.currency) || left.variant.localeCompare(right.variant));
}

function buildAssignmentBalance(allUp: readonly ReturnType<typeof finalizeMetrics>[]) {
  const control = allUp.find((row) => row.variant === "control_one_time")!;
  const monthly = allUp.find((row) => row.variant === "monthly_half")!;
  const total = control.counts.uniqueEligibleAssigned + monthly.counts.uniqueEligibleAssigned;
  return {
    controlOneTime: control.counts.uniqueEligibleAssigned,
    monthlyHalf: monthly.counts.uniqueEligibleAssigned,
    total,
    monthlyShare: rate(monthly.counts.uniqueEligibleAssigned, total),
    integrityDefects: control.integrityDefects.total + monthly.integrityDefects.total,
  };
}

function buildActivationLift(
  segments: readonly ReturnType<typeof finalizeMetrics>[],
  allUp: readonly ReturnType<typeof finalizeMetrics>[],
) {
  const dimensions = new Map<string, ReturnType<typeof finalizeMetrics>[]>();
  for (const segment of segments) {
    const key = `${segment.country}\u0000${segment.currency}`;
    getOrCreate(dimensions, key, () => []).push(segment);
  }
  const result = [...dimensions.entries()].flatMap(([key, rows]) => {
    const [country, currency] = key.split("\u0000");
    return comparison(rows, "activation", country, currency);
  });
  result.push(...comparison(allUp, "activation", "ALL", "all"));
  return result;
}

function buildRevenueLift(
  segments: readonly ReturnType<typeof finalizeMetrics>[],
  currencyTotals: ReturnType<typeof finalizeCurrencyTotals>,
) {
  const dimensions = new Map<string, ReturnType<typeof finalizeMetrics>[]>();
  for (const segment of segments) {
    const key = `${segment.country}\u0000${segment.currency}`;
    getOrCreate(dimensions, key, () => []).push(segment);
  }
  const result = [...dimensions.entries()].flatMap(([key, rows]) => {
    const control = rows.find((row) => row.variant === "control_one_time");
    const monthly = rows.find((row) => row.variant === "monthly_half");
    if (!control || !monthly) return [];
    const [country, currency] = key.split("\u0000");
    return [liftRecord(
      country,
      currency,
      BigInt(monthly.realizedMoney.netMinor),
      monthly.counts.uniqueExposed,
      BigInt(control.realizedMoney.netMinor),
      control.counts.uniqueExposed,
    )];
  });
  const currencies = new Set(currencyTotals.map((row) => row.currency));
  for (const currency of currencies) {
    const control = currencyTotals.find((row) =>
      row.currency === currency && row.variant === "control_one_time");
    const monthly = currencyTotals.find((row) =>
      row.currency === currency && row.variant === "monthly_half");
    if (control && monthly) {
      result.push(liftRecord(
        "ALL",
        currency,
        BigInt(monthly.netMinor),
        monthly.realizedRevenuePerExposedDenominator,
        BigInt(control.netMinor),
        control.realizedRevenuePerExposedDenominator,
      ));
    }
  }
  return result;
}

function comparison(
  rows: readonly ReturnType<typeof finalizeMetrics>[],
  field: "activation",
  country: string,
  currency: string,
) {
  const control = rows.find((row) => row.variant === "control_one_time");
  const monthly = rows.find((row) => row.variant === "monthly_half");
  if (!control || !monthly) return [];
  const left = monthly[field];
  const right = control[field];
  return [{
    country,
    currency,
    monthly: left,
    control: right,
    relativeLift: relativeRateLift(
      left.numerator,
      left.denominator,
      right.numerator,
      right.denominator,
    ),
  }];
}

function liftRecord(
  country: string,
  currency: string,
  monthlyNumerator: bigint,
  monthlyDenominator: number,
  controlNumerator: bigint,
  controlDenominator: number,
) {
  return {
    country,
    currency,
    monthly: {
      numeratorMinor: monthlyNumerator.toString(),
      denominator: monthlyDenominator,
      valueMinor: decimalRateBigInt(monthlyNumerator, monthlyDenominator),
    },
    control: {
      numeratorMinor: controlNumerator.toString(),
      denominator: controlDenominator,
      valueMinor: decimalRateBigInt(controlNumerator, controlDenominator),
    },
    relativeLift: relativeRevenueLift(
      monthlyNumerator,
      monthlyDenominator,
      controlNumerator,
      controlDenominator,
    ),
  };
}

function buildModeledLtvScenarios(
  segments: readonly ReturnType<typeof finalizeMetrics>[],
  assumptions: ModeledLtvAssumptions,
) {
  return segments.flatMap((segment) => {
    if (!segment.observedPriceMinor) return [];
    const price = Number(segment.observedPriceMinor);
    const fixedFee = assumptions.fixedFeeMinorByCurrency[segment.currency] || 0;
    const paymentCount = segment.variant === "control_one_time"
      ? 1
      : survivalPaymentCount(assumptions.horizonMonths, assumptions.monthlyChurnRate);
    const gross = price * paymentCount;
    const fees = gross * assumptions.feeRate + fixedFee * paymentCount;
    const refunds = gross * assumptions.refundRate;
    return [{
      status: "modeled_not_observed",
      variant: segment.variant,
      country: segment.country,
      currency: segment.currency,
      assumptions: {
        priceMinor: String(price),
        horizonMonths: assumptions.horizonMonths,
        monthlyChurnRate: assumptions.monthlyChurnRate,
        monthlySurvivalRate: 1 - assumptions.monthlyChurnRate,
        feeRate: assumptions.feeRate,
        fixedFeeMinor: String(fixedFee),
        refundRate: assumptions.refundRate,
      },
      modeled: {
        expectedPayments: round(paymentCount),
        grossLtvMinor: String(Math.round(gross)),
        feesMinor: String(Math.round(fees)),
        refundsMinor: String(Math.round(refunds)),
        netLtvMinor: String(Math.max(0, Math.round(gross - fees - refunds))),
      },
    }];
  });
}

function parseModeledLtv(value: unknown): ModeledLtvAssumptions | null {
  if (value === undefined || value === null || value === false) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("invalid_modeled_ltv", "modeledLtv must be an assumptions object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "horizonMonths", "monthlyChurnRate", "feeRate", "refundRate",
    "fixedFeeMinorByCurrency",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw invalid("invalid_modeled_ltv", `Unknown modeledLtv field: ${key}`);
  }
  const horizonMonths = boundedNumber(input.horizonMonths, "horizonMonths", 1, 120, true);
  const monthlyChurnRate = boundedNumber(input.monthlyChurnRate, "monthlyChurnRate", 0, 1);
  const feeRate = boundedNumber(input.feeRate, "feeRate", 0, 1);
  const refundRate = boundedNumber(input.refundRate, "refundRate", 0, 1);
  const fixedInput = input.fixedFeeMinorByCurrency;
  if (!fixedInput || typeof fixedInput !== "object" || Array.isArray(fixedInput)) {
    throw invalid(
      "invalid_modeled_ltv",
      "modeledLtv.fixedFeeMinorByCurrency must explicitly map currencies to minor-unit fees",
    );
  }
  const fixedFeeMinorByCurrency: Record<string, number> = {};
  for (const [currency, amount] of Object.entries(fixedInput as Record<string, unknown>)) {
    if (!/^[a-z]{3}$/.test(currency) || !Number.isSafeInteger(Number(amount)) ||
        Number(amount) < 0 || Number(amount) > 100_000) {
      throw invalid("invalid_modeled_ltv", "Invalid fixed fee currency or amount");
    }
    fixedFeeMinorByCurrency[currency] = Number(amount);
  }
  return Object.freeze({
    horizonMonths,
    monthlyChurnRate,
    feeRate,
    refundRate,
    fixedFeeMinorByCurrency: Object.freeze(fixedFeeMinorByCurrency),
  });
}

function normalizeCohortRow(row: CohortDatabaseRow): UpgradePricingCohortObservation {
  const variant = row.variant === "monthly_half" ? "monthly_half" : "control_one_time";
  return {
    intentId: String(row.intent_id || ""),
    assignmentId: row.assignment_id ? String(row.assignment_id) : null,
    accountId: String(row.account_id || ""),
    acquisitionId: String(row.acquisition_id || ""),
    variant,
    billingModel: row.billing_model === "subscription" ? "subscription" : "one_time",
    country: safeCountry(row.country),
    currency: safeCurrency(row.currency),
    amountMinor: safeInteger(row.upgrade_pricing_amount_minor),
    assignedAt: isoOrNull(row.upgrade_pricing_assigned_at),
    intentCreatedAt: iso(row.intent_created_at),
    exposedAt: isoOrNull(row.exposed_at),
    sessionStarted: Boolean(row.session_started),
    sessionAttempt: safeInteger(row.session_attempt),
    intentState: String(row.intent_state || "unknown").slice(0, 40),
    oneTimePaidAt: isoOrNull(row.one_time_paid_at),
    oneTimeGrossMinor: safeInteger(row.one_time_gross_minor),
    oneTimeRefundedMinor: safeInteger(row.one_time_refunded_minor),
    subscriptionStatus: safeTextOrNull(row.subscription_status, 40),
    subscriptionEntitlementStatus: safeTextOrNull(row.subscription_entitlement_status, 40),
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    entitlementActivated: Boolean(row.entitlement_activated),
    activationCompletedAt: isoOrNull(row.activation_completed_at),
    activationClientVersion: safeTextOrNull(row.activation_client_version, 80),
    assignmentSnapshotDefect: Boolean(row.assignment_snapshot_defect),
    exposureLineageDefect: Boolean(row.exposure_lineage_defect),
    acquisitionLineageDefect: Boolean(row.acquisition_lineage_defect),
    activationLineageDefect: Boolean(row.activation_lineage_defect),
  };
}

function normalizeEventRow(row: EventDatabaseRow): UpgradePricingEventObservation {
  return {
    eventKey: String(row.event_key || ""),
    intentId: String(row.intent_id || ""),
    objectKey: String(row.object_key || ""),
    eventType: String(row.event_type || ""),
    occurredAt: iso(row.occurred_at),
    amountMinor: safeInteger(row.amount_minor),
    currency: row.currency ? safeCurrency(row.currency) : null,
    status: safeTextOrNull(row.status, 80),
    billingReason: safeTextOrNull(row.billing_reason, 80),
    periodEnd: isoOrNull(row.period_end),
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
  };
}

function dedupeCohort(rows: readonly UpgradePricingCohortObservation[]) {
  const byIntent = new Map<string, UpgradePricingCohortObservation>();
  for (const row of rows) {
    if (!row.intentId || !row.accountId) continue;
    const existing = byIntent.get(row.intentId);
    if (!existing || row.intentCreatedAt < existing.intentCreatedAt) byIntent.set(row.intentId, row);
  }
  return [...byIntent.values()].sort((left, right) =>
    left.intentCreatedAt.localeCompare(right.intentCreatedAt) || left.intentId.localeCompare(right.intentId));
}

function dedupeEvents(rows: readonly UpgradePricingEventObservation[]) {
  const byEvent = new Map<string, UpgradePricingEventObservation>();
  for (const row of rows) {
    if (!row.eventKey || !row.intentId || !row.objectKey) continue;
    const existing = byEvent.get(row.eventKey);
    if (!existing || compareEvents(existing, row) < 0) byEvent.set(row.eventKey, row);
  }
  return [...byEvent.values()].sort(compareEvents);
}

function signCursor(lastKey: string, request: UpgradePricingReportRequest, secret: string) {
  const body = Buffer.from(JSON.stringify(cursorPayload(lastKey, request))).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyCursor(cursor: string, request: UpgradePricingReportRequest, secret: string) {
  const [body, signature, extra] = cursor.split(".");
  if (!body || !signature || extra) throw invalid("invalid_cursor", "Invalid report cursor");
  const expected = createHmac("sha256", secret).update(body).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    throw invalid("invalid_cursor", "Invalid report cursor");
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw invalid("invalid_cursor", "Invalid report cursor");
  }
  let payload: ReturnType<typeof cursorPayload>;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw invalid("invalid_cursor", "Invalid report cursor");
  }
  const expectedBinding = cursorPayload(payload.lastKey, request);
  if (JSON.stringify(payload) !== JSON.stringify(expectedBinding) ||
      typeof payload.lastKey !== "string" || payload.lastKey.length > 80) {
    throw invalid("invalid_cursor", "Cursor does not match this report query");
  }
  return payload.lastKey;
}

function cursorPayload(lastKey: string, request: UpgradePricingReportRequest) {
  return {
    version: 1,
    namespace: request.namespace,
    from: request.from,
    through: request.through,
    asOf: request.asOf,
    modeledLtv: request.modeledLtv,
    lastKey,
  };
}

function assertPrivacySafe(report: unknown) {
  const forbiddenKeys = /(?:email|ipAddress|activationKey|cookie|device|install|receipt|stripe|paymentSecret|providerPayload|accountId|intentId|eventKey|objectKey)/i;
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${path}[${index}]`));
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (forbiddenKeys.test(key)) throw new Error(`Unsafe report field at ${path}.${key}`);
      walk(child, `${path}.${key}`);
    }
  };
  walk(report, "report");
}

function invalid(code: string, message: string) {
  return new UpgradePricingReportValidationError(code, message);
}

function parseDate(value: unknown, name: string) {
  if (typeof value !== "string" || value.length > 40) {
    throw invalid("invalid_date", `${name} must be an ISO timestamp`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw invalid("invalid_date", `${name} must be an ISO timestamp`);
  }
  return date;
}

function stringValue(value: unknown, name: string, maxLength: number) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw invalid("invalid_string", `${name} is invalid`);
  }
  return value;
}

function boundedNumber(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  integer = false,
) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum ||
      (integer && !Number.isSafeInteger(number))) {
    throw invalid("invalid_modeled_ltv", `${name} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

function safeInteger(value: unknown) {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function safeCountry(value: unknown) {
  const country = String(value || "").toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : "ZZ";
}

function safeCurrency(value: unknown) {
  const currency = String(value || "").toLowerCase();
  return /^[a-z]{3}$/.test(currency) ? currency : "xxx";
}

function safeClientVersion(value: string) {
  return VERSION_PATTERN.test(value) ? value : "unknown";
}

function safeTextOrNull(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maxLength ? text : null;
}

function iso(value: unknown) {
  const date = new Date(value as string | number | Date);
  if (!Number.isFinite(date.getTime())) return new Date(0).toISOString();
  return date.toISOString();
}

function isoOrNull(value: unknown) {
  return value === null || value === undefined ? null : iso(value);
}

function isParsedRequest(value: unknown): value is UpgradePricingReportRequest {
  return Boolean(value && typeof value === "object" &&
    (value as UpgradePricingReportRequest).namespace &&
    (value as UpgradePricingReportRequest).from &&
    (value as UpgradePricingReportRequest).through &&
    (value as UpgradePricingReportRequest).asOf);
}

function groupBy<T>(items: readonly T[], key: (item: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const item of items) getOrCreate(grouped, key(item), () => []).push(item);
  return grouped;
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V) {
  let value = map.get(key);
  if (value === undefined) {
    value = create();
    map.set(key, value);
  }
  return value;
}

function setLatest(
  map: Map<string, UpgradePricingEventObservation>,
  event: UpgradePricingEventObservation,
) {
  const existing = map.get(event.objectKey);
  if (!existing || compareEvents(existing, event) < 0) map.set(event.objectKey, event);
}

function compareEvents(left: UpgradePricingEventObservation, right: UpgradePricingEventObservation) {
  return left.occurredAt.localeCompare(right.occurredAt) || left.eventKey.localeCompare(right.eventKey);
}

function segmentKey(variant: string, country: string, currency: string) {
  return `${country}|${currency}|${variant}`;
}

function segmentKeyOf(segment: { variant: string; country: string; currency: string }) {
  return segmentKey(segment.variant, segment.country, segment.currency);
}

function compareSegment(
  left: ReturnType<typeof finalizeMetrics>,
  right: ReturnType<typeof finalizeMetrics>,
) {
  return segmentKeyOf(left).localeCompare(segmentKeyOf(right));
}

function compareVersions(left: string, right: string) {
  if (left === "unknown") return 1;
  if (right === "unknown") return -1;
  return left.localeCompare(right, undefined, { numeric: true });
}

function rate(numerator: number, denominator: number) {
  return {
    numerator,
    denominator,
    rate: denominator > 0 ? round(numerator / denominator) : null,
  };
}

function decimalRate(numerator: number, denominator: number) {
  return denominator > 0 ? round(numerator / denominator) : null;
}

function decimalRateBigInt(numerator: bigint, denominator: number) {
  if (denominator <= 0) return null;
  return round(Number(numerator) / denominator);
}

function relativeRateLift(
  monthlyNumerator: number,
  monthlyDenominator: number,
  controlNumerator: number,
  controlDenominator: number,
) {
  if (monthlyDenominator <= 0 || controlDenominator <= 0 || controlNumerator <= 0) return null;
  const monthly = monthlyNumerator / monthlyDenominator;
  const control = controlNumerator / controlDenominator;
  return round((monthly - control) / control);
}

function relativeRevenueLift(
  monthlyNumerator: bigint,
  monthlyDenominator: number,
  controlNumerator: bigint,
  controlDenominator: number,
) {
  if (monthlyDenominator <= 0 || controlDenominator <= 0 || controlNumerator <= 0n) return null;
  const monthly = Number(monthlyNumerator) / monthlyDenominator;
  const control = Number(controlNumerator) / controlDenominator;
  return round((monthly - control) / control);
}

function round(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function intersectSize(left: Set<string>, right: Set<string>) {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

function isMaturePeriod(periodEnd: string | null | undefined, asOfMs: number) {
  if (!periodEnd) return false;
  const time = new Date(periodEnd).getTime();
  return Number.isFinite(time) && time <= asOfMs;
}

function survivalPaymentCount(months: number, churnRate: number) {
  let expected = 0;
  for (let month = 0; month < months; month += 1) expected += (1 - churnRate) ** month;
  return expected;
}

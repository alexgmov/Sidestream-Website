import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";
import {
  ACQUISITION_STAGES,
  ACQUISITION_STAGE_COUNTING_GRAINS,
  type AcquisitionStage,
} from "./acquisition-integrity.js";
import { withPostgresTransaction } from "./postgres.js";

const DEFAULT_JOURNEY_LIMIT = 50;
const MAX_JOURNEY_LIMIT = 100;
const MAX_COHORT_WINDOW_MS = 366 * 24 * 60 * 60 * 1_000;
const MAX_OBSERVATION_SPAN_MS = 730 * 24 * 60 * 60 * 1_000;
const MAX_SOURCE_GROUPS = 100;
const FUNNEL_CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 2_048;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

type LicenseNamespace = "production" | "test";

type FunnelInput = Readonly<{
  licenseNamespace: LicenseNamespace;
  cohortBasis: "first_install" | "first_purchase";
  cohortStart: string;
  cohortEnd: string;
  observationEnd: string;
  journeyLimit: number;
  journeyCursor: FunnelCursor | null;
  filterHash: string;
}>;

type FunnelCursor = Readonly<{
  v: 1;
  filterHash: string;
  cohortAt: string;
  customerId: string;
}>;

type FunnelQueryClient = Readonly<{
  query<Row extends QueryResultRow = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}>;

type FunnelDependencies = Readonly<{
  transaction: <T>(callback: (client: FunnelQueryClient) => Promise<T>) => Promise<T>;
}>;

type FunnelGroupRow = QueryResultRow & Readonly<{
  source: string;
  medium: string | null;
  campaign: string | null;
  experiment: string | null;
  cohort: string | null;
  attribution_confidence: string;
  integrity_state: string;
  profile_count: string | number | bigint;
  first_opened_count: string | number | bigint;
  completed_activation_count: string | number | bigint;
  paid_customer_count: string | number | bigint;
  return_eligible_count: string | number | bigint;
  returned_count: string | number | bigint;
  one_and_done_count: string | number | bigint;
  first_day_download_attempt_count: string | number | bigint;
  first_day_activated_count: string | number | bigint;
  browse_only_count: string | number | bigint;
  single_download_count: string | number | bigint;
  multi_download_count: string | number | bigint;
}>;

type FunnelJourneyRow = QueryResultRow & Readonly<{
  customer_id: string;
  source: string;
  medium: string | null;
  campaign: string | null;
  experiment: string | null;
  cohort: string | null;
  attribution_confidence: string;
  first_attributed_at: Date | string | null;
  first_installer_requested_at: Date | string | null;
  first_installer_platform: string | null;
  cohort_at: Date | string;
  first_install_at: Date | string | null;
  first_purchase_at: Date | string | null;
  first_open_at: Date | string | null;
  activation_at: Date | string | null;
  day_zero_download_attempts: string | number | bigint;
  later_open_days: string[] | null;
  return_eligible: boolean;
  paid_customer: boolean;
  integrity_state: string;
}>;

type FunnelStageRow = QueryResultRow & Readonly<{
  stage: AcquisitionStage;
  counting_grain: string;
  distinct_count: string | number | bigint;
}>;

type FunnelIntegrityRow = QueryResultRow & Readonly<{
  integrity_state: string;
  acquisition_count: string | number | bigint;
}>;

export class AcquisitionFunnelValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AcquisitionFunnelValidationError";
    this.code = code;
  }
}

const defaultDependencies: FunnelDependencies = {
  transaction: (callback) => withPostgresTransaction(callback, {
    isolationLevel: "repeatable read",
    readOnly: true,
  }),
};

const EMPTY_PAID_TELEMETRY_BINDINGS = `(
  select
    null::uuid as checkout_id,
    null::uuid as acquisition_id,
    null::uuid as profile_id_at_binding,
    null::uuid as install_membership_id,
    null::text as install_id_hash,
    null::text as license_namespace
  where false
)`;

const FUNNEL_CTES = (paidTelemetryBindingsRelation: string) => `
  with profile_landmarks as (
    select
      profile.id as profile_id,
      min(install.first_seen_at) as first_install_at,
      min(money.first_paid_at) as first_purchase_at
    from public.sidestream_customer_profiles profile
    left join public.sidestream_customer_installs install
      on install.profile_id = profile.id
      and install.license_namespace = profile.license_namespace
    left join public.sidestream_customer_money_totals money
      on money.profile_id = profile.id
      and money.license_namespace = profile.license_namespace
      and money.first_paid_at is not null
    where profile.license_namespace = $1
      and profile.merged_into is null
    group by profile.id
  ),
  cohort_profiles as (
    select
      profile_id,
      first_install_at,
      first_purchase_at,
      case when $5::text = 'first_purchase'
        then first_purchase_at else first_install_at end as cohort_at
    from profile_landmarks
    where case when $5::text = 'first_purchase'
      then first_purchase_at else first_install_at end >= $2::timestamptz
      and case when $5::text = 'first_purchase'
        then first_purchase_at else first_install_at end < $3::timestamptz
  ),
  profile_usage as (
    select
      cohort.profile_id,
      min(usage.first_app_use_at) as first_open_at
    from cohort_profiles cohort
    left join public.sidestream_customer_installs install
      on install.profile_id = cohort.profile_id
      and install.license_namespace = $1
    left join public.sidestream_customer_usage_daily usage
      on usage.license_namespace = install.license_namespace
      and usage.install_id_hash = install.install_id_hash
      and usage.activity_day < ($4::timestamptz at time zone 'UTC')::date
    group by cohort.profile_id
  ),
  usage_detail as (
    select
      cohort.profile_id,
      cohort.cohort_at,
      cohort.first_install_at,
      cohort.first_purchase_at,
      profile_usage.first_open_at,
      coalesce(
        sum(usage.download_attempt_count) filter (
          where profile_usage.first_open_at is not null
            and usage.activity_day =
              (profile_usage.first_open_at at time zone 'UTC')::date
        ),
        0
      ) as day_zero_download_attempts,
      coalesce(
        sum(usage.download_success_count) filter (
          where profile_usage.first_open_at is not null
            and usage.activity_day =
              (profile_usage.first_open_at at time zone 'UTC')::date
        ),
        0
      ) as day_zero_download_successes,
      coalesce(
        array_agg(
          distinct to_char(usage.activity_day, 'YYYY-MM-DD')
          order by to_char(usage.activity_day, 'YYYY-MM-DD')
        ) filter (
          where profile_usage.first_open_at is not null
            and usage.first_app_use_at is not null
            and usage.activity_day >
              (profile_usage.first_open_at at time zone 'UTC')::date
        ),
        array[]::text[]
      ) as later_open_days,
      (
        profile_usage.first_open_at is not null
        and (
          (profile_usage.first_open_at at time zone 'UTC')::date + 1
        ) < ($4::timestamptz at time zone 'UTC')::date
      ) as return_eligible
    from cohort_profiles cohort
    join profile_usage on profile_usage.profile_id = cohort.profile_id
    left join public.sidestream_customer_installs install
      on install.profile_id = cohort.profile_id
      and install.license_namespace = $1
    left join public.sidestream_customer_usage_daily usage
      on usage.license_namespace = install.license_namespace
      and usage.install_id_hash = install.install_id_hash
      and usage.activity_day < ($4::timestamptz at time zone 'UTC')::date
    group by
      cohort.profile_id,
      cohort.cohort_at,
      cohort.first_install_at,
      cohort.first_purchase_at,
      profile_usage.first_open_at
  ),
  activations as (
    select
      link.profile_id,
      min(activation.completed_at) as activation_at
    from public.sidestream_customer_identity_links link
    join cohort_profiles cohort on cohort.profile_id = link.profile_id
    join public.sidestream_activation_sessions activation
      on link.link_type = 'activation_record'
      and link.link_value ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and activation.id = link.link_value::uuid
      and activation.completed_at is not null
      and activation.completed_at < $4::timestamptz
    where link.license_namespace = $1
    group by link.profile_id
  ),
  paid_customers as (
    select distinct money.profile_id
    from public.sidestream_customer_money_totals money
    join cohort_profiles cohort on cohort.profile_id = money.profile_id
    where money.license_namespace = $1
      and money.net_paid_minor > 0
      and money.first_paid_at is not null
      and money.first_paid_at < $4::timestamptz
  ),
  verified_paid_checkouts as (
    select
      checkout.id as checkout_id,
      checkout.installer_receipt_hash,
      checkout.verified_checkout_session_ref,
      core.acquisition_id,
      entry.id as entry_id,
      entry.created_at as first_attributed_at,
      coalesce(acquisition.first_observed_source, 'manychat') as source,
      coalesce(acquisition.first_observed_medium, entry.utm_medium) as medium,
      coalesce(acquisition.first_observed_campaign, entry.utm_campaign) as campaign,
      coalesce(acquisition.experiment_id, entry.experiment_id) as experiment_id,
      coalesce(acquisition.experiment_cohort, entry.cohort) as cohort,
      coalesce(acquisition.integrity_state, 'historical_unlinked') as integrity_state
    from public.sidestream_paid_acquisition_checkouts checkout
    join public.sidestream_paid_acquisition_entries entry
      on entry.id = checkout.entry_id
      and entry.environment = checkout.environment
      and entry.experiment_id = checkout.experiment_id
      and entry.cohort = checkout.cohort
      and entry.assignment_id_hash = checkout.assignment_id_hash
      and entry.entry_token_hash = checkout.entry_token_hash
      and entry.attribution_hash = checkout.attribution_hash
    join public.sidestream_checkout_intents core
      on core.id = checkout.checkout_intent_ref
    left join public.sidestream_acquisitions acquisition
      on acquisition.id = core.acquisition_id
      and acquisition.license_namespace = checkout.environment
    where checkout.environment = $1
      and checkout.payment_state = 'active'
      and checkout.completed_at is not null
      and checkout.verified_checkout_session_ref is not null
  ),
  paid_profile_edges as (
    select link.profile_id, paid.checkout_id
    from verified_paid_checkouts paid
    join public.sidestream_customer_identity_links link
      on link.license_namespace = $1
      and link.link_type = 'installer_receipt_hash'
      and paid.installer_receipt_hash is not null
      and link.link_value = paid.installer_receipt_hash

    union

    select link.profile_id, paid.checkout_id
    from verified_paid_checkouts paid
    join public.sidestream_customer_identity_links link
      on link.license_namespace = $1
      and link.link_type = 'stripe_checkout_session'
      and link.link_value = paid.verified_checkout_session_ref

    union

    select link.profile_id, paid.checkout_id
    from verified_paid_checkouts paid
    join public.sidestream_paid_acquisition_claims claim
      on claim.checkout_id = paid.checkout_id
      and claim.environment = $1
      and claim.claim_state = 'claimed'
    join public.sidestream_customer_identity_links link
      on link.license_namespace = $1
      and (
        (
          claim.activation_ref is not null
          and link.link_type = 'activation_record'
          and link.link_value = claim.activation_ref::text
        )
        or (
          claim.account_ref is not null
          and link.link_type = 'account_identity'
          and link.link_value = claim.account_ref::text
        )
      )
  ),
  exact_paid_binding_candidates as (
    select
      install.profile_id,
      binding.checkout_id
    from ${paidTelemetryBindingsRelation} binding
    join public.sidestream_customer_installs install
      on install.id = binding.install_membership_id
      and install.license_namespace = binding.license_namespace
      and install.profile_id = binding.profile_id_at_binding
      and install.install_id_hash = binding.install_id_hash
    join cohort_profiles cohort on cohort.profile_id = install.profile_id
    join verified_paid_checkouts paid
      on paid.checkout_id = binding.checkout_id
      and paid.acquisition_id = binding.acquisition_id
      and paid.first_attributed_at <= cohort.cohort_at
    where binding.license_namespace = $1
  ),
  exact_paid_binding_counts as (
    select
      profile_id,
      count(*)::bigint as exact_binding_count
    from exact_paid_binding_candidates
    group by profile_id
  ),
  paid_candidates as (
    select
      edge.profile_id,
      paid.source,
      paid.medium,
      paid.campaign,
      paid.experiment_id as experiment,
      paid.cohort,
      'exact_paid_checkout'::text as attribution_confidence,
      paid.integrity_state,
      paid.first_attributed_at,
      null::timestamptz as first_installer_requested_at,
      null::text as first_installer_platform,
      1 as attribution_priority,
      row_number() over (
        partition by edge.profile_id
        order by
          case
            when binding_count.exact_binding_count = 1
              and exact_binding.checkout_id is not null
            then 0
            else 1
          end,
          paid.first_attributed_at,
          paid.entry_id,
          paid.checkout_id
      ) as candidate_order
    from paid_profile_edges edge
    join cohort_profiles cohort on cohort.profile_id = edge.profile_id
    join verified_paid_checkouts paid
      on paid.checkout_id = edge.checkout_id
      and paid.first_attributed_at <= cohort.cohort_at
    left join exact_paid_binding_counts binding_count
      on binding_count.profile_id = edge.profile_id
    left join exact_paid_binding_candidates exact_binding
      on exact_binding.profile_id = edge.profile_id
      and exact_binding.checkout_id = edge.checkout_id
    where coalesce(binding_count.exact_binding_count, 0) < 2
  ),
  anonymous_claim_candidates as (
    select
      acquisition.claimed_profile_id as profile_id,
      acquisition.first_touch_source as source,
      acquisition.first_touch_medium as medium,
      acquisition.first_touch_campaign as campaign,
      acquisition.experiment_id as experiment,
      acquisition.experiment_cohort as cohort,
      'exact_anonymous_claim'::text as attribution_confidence,
      'historical_unlinked'::text as integrity_state,
      acquisition.first_seen_at as first_attributed_at,
      acquisition.first_installer_requested_at,
      acquisition.first_installer_platform,
      2 as attribution_priority,
      row_number() over (
        partition by acquisition.claimed_profile_id
        order by acquisition.first_seen_at, acquisition.id
      ) as candidate_order
    from public.sidestream_anonymous_acquisition_sessions acquisition
    join cohort_profiles cohort
      on cohort.profile_id = acquisition.claimed_profile_id
    where acquisition.license_namespace = $1
      and acquisition.claim_state = 'claimed'
      and acquisition.claimed_profile_id is not null
      and acquisition.first_installer_requested_at is not null
      and acquisition.first_seen_at <= cohort.cohort_at
      and (
        acquisition.first_touch_medium is distinct from 'installation_claim'
        or acquisition.first_touch_campaign is distinct from 'server_claim_v1'
      )
  ),
  freemium_candidates as (
    select
      cohort.profile_id,
      coalesce(lead.utm_source, 'unknown') as source,
      lead.utm_medium as medium,
      lead.utm_campaign as campaign,
      case
        when lead.context->>'experimentId' = 'mc-mobile-paid-v1'
          and lead.context->>'cohort' in ('mc-control-v1', 'mc-paid-v1')
          and lead.context->>'assignmentIdHash' ~ '^[0-9a-f]{64}$'
        then lead.context->>'experimentId'
        else null
      end as experiment,
      case
        when lead.context->>'experimentId' = 'mc-mobile-paid-v1'
          and lead.context->>'cohort' in ('mc-control-v1', 'mc-paid-v1')
          and lead.context->>'assignmentIdHash' ~ '^[0-9a-f]{64}$'
        then lead.context->>'cohort'
        else null
      end as cohort,
      'exact_verified_email'::text as attribution_confidence,
      'historical_unlinked'::text as integrity_state,
      lead.first_captured_at as first_attributed_at,
      null::timestamptz as first_installer_requested_at,
      null::text as first_installer_platform,
      3 as attribution_priority,
      row_number() over (
        partition by cohort.profile_id
        order by lead.first_captured_at, lead.id
      ) as candidate_order
    from cohort_profiles cohort
    join public.sidestream_customer_profiles profile
      on profile.id = cohort.profile_id
      and profile.license_namespace = $1
      and profile.merged_into is null
    join public.sidestream_customer_identity_links account_link
      on account_link.profile_id = profile.id
      and account_link.license_namespace = profile.license_namespace
      and account_link.link_type = 'account_identity'
    join public.sidestream_accounts account
      on account.id::text = account_link.link_value
      and account.email = profile.contact_email
      and account.email = lower(btrim(account.email))
    join public.sidestream_download_leads lead
      on lead.cta_source = 'mobile-download-handoff'
      and lead.email = account.email
      and lead.email = lower(btrim(lead.email))
      and lead.first_captured_at <= cohort.cohort_at
      and lead.last_captured_at <= cohort.cohort_at
  ),
  canonical_profile_edges as (
    select distinct
      acquisition.id as acquisition_id,
      link.profile_id
    from public.sidestream_acquisitions acquisition
    join public.sidestream_checkout_intents intent
      on intent.acquisition_id = acquisition.id
    join public.sidestream_customer_identity_links link
      on link.license_namespace = acquisition.license_namespace
      and (
        (link.link_type = 'account_identity' and link.link_value = intent.account_id::text)
        or (
          link.link_type = 'activation_record'
          and link.link_value = intent.activation_session_id::text
        )
        or (
          link.link_type = 'stripe_checkout_session'
          and link.link_value = intent.stripe_checkout_session_id
        )
      )
    join cohort_profiles cohort on cohort.profile_id = link.profile_id
    where acquisition.license_namespace = $1

    union

    select distinct
      acquisition.id as acquisition_id,
      materialization.profile_id
    from public.sidestream_acquisitions acquisition
    join public.sidestream_checkout_intents intent
      on intent.acquisition_id = acquisition.id
      and intent.stripe_checkout_session_id is not null
    join public.sidestream_customer_commerce_aliases session_alias
      on session_alias.license_namespace = acquisition.license_namespace
      and session_alias.alias_type = 'checkout_session'
      and session_alias.alias_id = intent.stripe_checkout_session_id
    join public.sidestream_customer_commerce_materializations materialization
      on materialization.license_namespace = session_alias.license_namespace
      and materialization.payment_key = session_alias.payment_key
      and materialization.profile_id is not null
      and not materialization.identity_conflict
    join cohort_profiles cohort on cohort.profile_id = materialization.profile_id
    where acquisition.license_namespace = $1
  ),
  canonical_candidates as (
    select
      edge.profile_id,
      acquisition.first_observed_source as source,
      acquisition.first_observed_medium as medium,
      acquisition.first_observed_campaign as campaign,
      acquisition.experiment_id as experiment,
      acquisition.experiment_cohort as cohort,
      acquisition.attribution_confidence,
      acquisition.integrity_state,
      acquisition.first_observed_at as first_attributed_at,
      null::timestamptz as first_installer_requested_at,
      null::text as first_installer_platform,
      4 as attribution_priority,
      row_number() over (
        partition by edge.profile_id
        order by acquisition.first_observed_at, acquisition.id
      ) as candidate_order
    from canonical_profile_edges edge
    join public.sidestream_acquisitions acquisition
      on acquisition.id = edge.acquisition_id
      and acquisition.license_namespace = $1
    join cohort_profiles cohort on cohort.profile_id = edge.profile_id
    where acquisition.first_observed_at <= cohort.cohort_at
  ),
  attribution_candidates as (
    select
      profile_id, source, medium, campaign, experiment, cohort,
      attribution_confidence, integrity_state, first_attributed_at,
      first_installer_requested_at, first_installer_platform,
      attribution_priority
    from paid_candidates
    where candidate_order = 1

    union all

    select
      profile_id, source, medium, campaign, experiment, cohort,
      attribution_confidence, integrity_state, first_attributed_at,
      first_installer_requested_at, first_installer_platform,
      attribution_priority
    from anonymous_claim_candidates
    where candidate_order = 1

    union all

    select
      profile_id, source, medium, campaign, experiment, cohort,
      attribution_confidence, integrity_state, first_attributed_at,
      first_installer_requested_at, first_installer_platform,
      attribution_priority
    from freemium_candidates
    where candidate_order = 1

    union all

    select
      profile_id, source, medium, campaign, experiment, cohort,
      attribution_confidence, integrity_state, first_attributed_at,
      first_installer_requested_at, first_installer_platform,
      attribution_priority
    from canonical_candidates
    where candidate_order = 1
  ),
  selected_attribution as (
    select
      candidate.*,
      row_number() over (
        partition by candidate.profile_id
        order by
          candidate.attribution_priority,
          candidate.first_attributed_at,
          candidate.source,
          coalesce(candidate.medium, ''),
          coalesce(candidate.campaign, '')
      ) as selected_order
    from attribution_candidates candidate
  ),
  attributed_profiles as (
    select
      usage.profile_id,
      usage.cohort_at,
      usage.first_install_at,
      usage.first_purchase_at,
      usage.first_open_at,
      activation.activation_at,
      (paid_customer.profile_id is not null) as paid_customer,
      usage.day_zero_download_attempts,
      usage.day_zero_download_successes,
      usage.later_open_days,
      usage.return_eligible,
      coalesce(attribution.source, 'unknown') as source,
      attribution.medium,
      attribution.campaign,
      attribution.experiment,
      attribution.cohort,
      coalesce(
        attribution.attribution_confidence,
        'unattributed'
      ) as attribution_confidence,
      coalesce(attribution.integrity_state, 'missing_internal_linkage')
        as integrity_state,
      attribution.first_attributed_at,
      coalesce(
        attribution.first_installer_requested_at,
        anonymous_lifecycle.first_installer_requested_at
      ) as first_installer_requested_at,
      coalesce(
        attribution.first_installer_platform,
        anonymous_lifecycle.first_installer_platform
      ) as first_installer_platform
    from usage_detail usage
    left join activations activation on activation.profile_id = usage.profile_id
    left join paid_customers paid_customer
      on paid_customer.profile_id = usage.profile_id
    left join selected_attribution attribution
      on attribution.profile_id = usage.profile_id
      and attribution.selected_order = 1
      and not exists (
        select 1
        from exact_paid_binding_counts ambiguous_binding
        where ambiguous_binding.profile_id = usage.profile_id
          and ambiguous_binding.exact_binding_count > 1
      )
    left join anonymous_claim_candidates anonymous_lifecycle
      on anonymous_lifecycle.profile_id = usage.profile_id
      and anonymous_lifecycle.candidate_order = 1
  )
`;

export async function queryAcquisitionFunnel(
  request: unknown,
  cursorSecretOrOverrides: string | Partial<FunnelDependencies> = "",
  explicitOverrides: Partial<FunnelDependencies> = {},
) {
  const cursorSecret = typeof cursorSecretOrOverrides === "string"
    ? cursorSecretOrOverrides
    : "direct-funnel-query-compatibility-secret";
  const overrides = typeof cursorSecretOrOverrides === "string"
    ? explicitOverrides
    : cursorSecretOrOverrides;
  const input = parseFunnelInput(request, cursorSecret);
  const dependencies = { ...defaultDependencies, ...overrides };
  const parameters = [
    input.licenseNamespace,
    input.cohortStart,
    input.cohortEnd,
    input.observationEnd,
    input.cohortBasis,
  ] as const;

  return dependencies.transaction(async (client) => {
    const bindingAvailability = await client.query<{ available: boolean }>(`
      select to_regclass(
        'public.sidestream_paid_telemetry_profile_bindings'
      ) is not null as available
    `);
    const funnelCtes = FUNNEL_CTES(
      bindingAvailability.rows[0]?.available
        ? "public.sidestream_paid_telemetry_profile_bindings"
        : EMPTY_PAID_TELEMETRY_BINDINGS,
    );
    const groupsResult = await client.query<FunnelGroupRow>(`
      ${funnelCtes}
      select
        source,
        medium,
        campaign,
        experiment,
        cohort,
        attribution_confidence,
        integrity_state,
        count(*)::bigint as profile_count,
        count(*) filter (where first_open_at is not null)::bigint
          as first_opened_count,
        count(*) filter (
          where first_open_at is not null and activation_at is not null
        )::bigint as completed_activation_count,
        count(*) filter (where paid_customer)::bigint as paid_customer_count,
        count(*) filter (where return_eligible)::bigint
          as return_eligible_count,
        count(*) filter (
          where return_eligible and cardinality(later_open_days) > 0
        )::bigint as returned_count,
        count(*) filter (
          where return_eligible and cardinality(later_open_days) = 0
        )::bigint as one_and_done_count,
        coalesce(sum(day_zero_download_attempts), 0)::bigint
          as first_day_download_attempt_count,
        count(*) filter (
          where first_open_at is not null and day_zero_download_successes > 0
        )::bigint as first_day_activated_count,
        count(*) filter (
          where first_open_at is not null and day_zero_download_attempts = 0
        )::bigint as browse_only_count,
        count(*) filter (
          where first_open_at is not null and day_zero_download_attempts = 1
        )::bigint as single_download_count,
        count(*) filter (
          where first_open_at is not null and day_zero_download_attempts >= 2
        )::bigint as multi_download_count
      from attributed_profiles
      group by
        source, medium, campaign, experiment, cohort, attribution_confidence,
        integrity_state
      order by
        source,
        medium nulls first,
        campaign nulls first,
        experiment nulls first,
        cohort nulls first,
        attribution_confidence
    `, parameters);

    const journeysResult = await client.query<FunnelJourneyRow>(`
      ${funnelCtes}
      select
        profile_id as customer_id,
        source,
        medium,
        campaign,
        experiment,
        cohort,
        attribution_confidence,
        integrity_state,
        first_attributed_at,
        first_installer_requested_at,
        first_installer_platform,
        cohort_at,
        first_install_at,
        first_purchase_at,
        first_open_at,
        activation_at,
        day_zero_download_attempts,
        later_open_days,
        return_eligible,
        paid_customer
      from attributed_profiles
      where (
        $7::timestamptz is null
        or (cohort_at, profile_id) > ($7::timestamptz, $8::uuid)
      )
      order by cohort_at, profile_id
      limit $6
    `, [
      ...parameters,
      input.journeyLimit + 1,
      input.journeyCursor?.cohortAt || null,
      input.journeyCursor?.customerId || null,
    ]);

    const stageResult = await client.query<FunnelStageRow>(`
      select
        stage,
        counting_grain,
        count(distinct deduplication_key)::bigint as distinct_count
      from public.sidestream_acquisition_stages
      where license_namespace = $1
        and occurred_at >= $2::timestamptz
        and occurred_at < $3::timestamptz
      group by stage, counting_grain
      order by stage
    `, [input.licenseNamespace, input.cohortStart, input.observationEnd]);
    const integrityResult = await client.query<FunnelIntegrityRow>(`
      select integrity_state, count(distinct id)::bigint as acquisition_count
      from public.sidestream_acquisitions
      where license_namespace = $1
        and first_observed_at >= $2::timestamptz
        and first_observed_at < $3::timestamptz
        and integrity_state in (
          'missing_internal_linkage', 'historical_unlinked', 'quarantined'
        )
      group by integrity_state
      order by integrity_state
    `, [input.licenseNamespace, input.cohortStart, input.cohortEnd]);

    const groups = groupsResult.rows.map(formatGroup);
    const totals = sumGroupCounts(groupsResult.rows);
    const attributedProfiles = groupsResult.rows.reduce(
      (sum, row) => row.attribution_confidence === "unattributed"
        ? sum
        : sum + toBigInt(row.profile_count),
      0n,
    );
    const paidAttributedProfiles = groupsResult.rows.reduce(
      (sum, row) => row.attribution_confidence === "exact_paid_checkout"
        ? sum + toBigInt(row.profile_count)
        : sum,
      0n,
    );
    const freemiumAttributedProfiles = groupsResult.rows.reduce(
      (sum, row) => row.attribution_confidence === "exact_verified_email"
        ? sum + toBigInt(row.profile_count)
        : sum,
      0n,
    );
    const anonymousAttributedProfiles = groupsResult.rows.reduce(
      (sum, row) => row.attribution_confidence === "exact_anonymous_claim"
        ? sum + toBigInt(row.profile_count)
        : sum,
      0n,
    );
    const unattributedProfiles = totals.profiles - attributedProfiles;

    const hasMoreJourneys = journeysResult.rows.length > input.journeyLimit;
    const journeyRows = journeysResult.rows.slice(0, input.journeyLimit);
    const cursorRow = hasMoreJourneys ? journeyRows.at(-1) : null;
    const sourceTotals = buildSourceTotals(groupsResult.rows);
    const stageCounts = formatStageCounts(stageResult.rows);
    const integrityAlerts = formatIntegrityAlerts(integrityResult.rows);

    return {
      licenseNamespace: input.licenseNamespace,
      dateWindow: {
        cohortStart: input.cohortStart,
        cohortEnd: input.cohortEnd,
        observationEnd: input.observationEnd,
        endExclusive: true,
        observationEndExclusive: true,
        cohortDefinition: input.cohortBasis === "first_purchase"
          ? "first_purchase_at"
          : "first_install_at",
        observationDefinition: "completed_utc_days_before_observation_end",
      },
      firstOpenPercentage: percentageMetric(
        totals.firstOpenedProfiles,
        totals.profiles,
      ),
      activationPercentage: percentageMetric(
        totals.completedActivations,
        totals.firstOpenedProfiles,
      ),
      productActivationPercentage: percentageMetric(
        totals.firstDayActivatedProfiles,
        totals.profiles,
      ),
      paidCustomerPercentage: percentageMetric(
        totals.paidCustomers,
        totals.profiles,
      ),
      returnPercentage: percentageMetric(
        totals.returnedProfiles,
        totals.returnEligibleProfiles,
      ),
      oneAndDonePercentage: percentageMetric(
        totals.oneAndDoneProfiles,
        totals.returnEligibleProfiles,
      ),
      attributionCoverage: {
        ...percentageMetric(attributedProfiles, totals.profiles),
        paidAttributedProfiles: paidAttributedProfiles.toString(),
        anonymousAttributedProfiles: anonymousAttributedProfiles.toString(),
        freemiumAttributedProfiles: freemiumAttributedProfiles.toString(),
        unattributedProfiles: unattributedProfiles.toString(),
      },
      coverage: {
        attributed: percentageMetric(attributedProfiles, totals.profiles),
        unknown: percentageMetric(unattributedProfiles, totals.profiles),
        exactPaidCheckout: percentageMetric(paidAttributedProfiles, totals.profiles),
        exactAnonymousClaim: percentageMetric(
          anonymousAttributedProfiles,
          totals.profiles,
        ),
        exactVerifiedEmail: percentageMetric(
          freemiumAttributedProfiles,
          totals.profiles,
        ),
      },
      totals: {
        profiles: totals.profiles.toString(),
        firstOpenedProfiles: totals.firstOpenedProfiles.toString(),
        completedActivations: totals.completedActivations.toString(),
        paidCustomers: totals.paidCustomers.toString(),
        returnEligibleProfiles: totals.returnEligibleProfiles.toString(),
        returnedProfiles: totals.returnedProfiles.toString(),
        oneAndDoneProfiles: totals.oneAndDoneProfiles.toString(),
        firstDayDownloadAttempts: totals.firstDayDownloadAttempts.toString(),
        firstDayActivatedProfiles: totals.firstDayActivatedProfiles.toString(),
        browseOnlyProfiles: totals.browseOnlyProfiles.toString(),
        singleDownloadProfiles: totals.singleDownloadProfiles.toString(),
        multiDownloadProfiles: totals.multiDownloadProfiles.toString(),
      },
      groups,
      sourceTotals: sourceTotals.rows,
      sourceCap: MAX_SOURCE_GROUPS,
      sourcesReturned: sourceTotals.rows.length,
      sourcesTruncated: sourceTotals.truncated,
      stageCounts,
      integrityAlerts,
      reportDefinition: {
        cohortBasis: input.cohortBasis,
        cohortStartInclusive: true,
        cohortEndExclusive: true,
        observationEndExclusive: true,
        observationBoundary: "completed_utc_days_before_observation_end",
        journeyCountingGrain: "live_customer_profile",
        paidCustomerCountingGrain: "distinct_live_customer_profile",
        stageCountingGrain: "distinct_stage_deduplication_key",
        stageObservationStartInclusive: input.cohortStart,
        stageObservationEndExclusive: input.observationEnd,
        sourceCap: MAX_SOURCE_GROUPS,
        journeyPageCap: MAX_JOURNEY_LIMIT,
        usageModeObservation: "first_open_utc_day",
        usageModeCountingGrain: "distinct_live_customer_profile",
        productActivationDefinition: "first_day_successful_download",
        multiDownloadThreshold: 2,
        historicalInference: "rejected",
      },
      journeys: journeyRows.map(formatJourney),
      journeyLimit: input.journeyLimit,
      journeysReturned: journeyRows.length,
      journeysTruncated: hasMoreJourneys ||
        totals.profiles > BigInt(journeyRows.length),
      nextJourneyCursor: cursorRow ? encodeFunnelCursor({
        v: FUNNEL_CURSOR_VERSION,
        filterHash: input.filterHash,
        cohortAt: toIsoString(cursorRow.cohort_at),
        customerId: cursorRow.customer_id,
      }, cursorSecret) : null,
    };
  });
}

function parseFunnelInput(request: unknown, cursorSecret: string): FunnelInput {
  const body = requireRecord(request);
  rejectUnknownKeys(body, [
    "licenseNamespace",
    "cohortBasis",
    "cohortStart",
    "cohortEnd",
    "observationEnd",
    "journeyLimit",
    "journeyCursor",
  ]);

  if (body.licenseNamespace !== "production" && body.licenseNamespace !== "test") {
    throw new AcquisitionFunnelValidationError(
      "invalid_namespace",
      "licenseNamespace must be production or test",
    );
  }
  const cohortBasis = body.cohortBasis === undefined
    ? "first_install"
    : body.cohortBasis;
  if (cohortBasis !== "first_install" && cohortBasis !== "first_purchase") {
    throw new AcquisitionFunnelValidationError(
      "invalid_cohort_basis",
      "cohortBasis must be first_install or first_purchase",
    );
  }
  const cohortStart = normalizeUtcTimestamp(body.cohortStart, "cohortStart");
  const cohortEnd = normalizeUtcTimestamp(body.cohortEnd, "cohortEnd");
  const observationEnd = normalizeUtcDayBoundary(body.observationEnd);
  const startTime = Date.parse(cohortStart);
  const endTime = Date.parse(cohortEnd);
  const observationEndTime = Date.parse(observationEnd);
  if (endTime <= startTime) {
    throw new AcquisitionFunnelValidationError(
      "invalid_cohort_window",
      "cohortEnd must be after cohortStart",
    );
  }
  if (endTime - startTime > MAX_COHORT_WINDOW_MS) {
    throw new AcquisitionFunnelValidationError(
      "invalid_cohort_window",
      "Cohort window cannot exceed 366 days",
    );
  }
  if (observationEndTime < endTime) {
    throw new AcquisitionFunnelValidationError(
      "invalid_cohort_window",
      "observationEnd must be at or after cohortEnd",
    );
  }
  if (observationEndTime - startTime > MAX_OBSERVATION_SPAN_MS) {
    throw new AcquisitionFunnelValidationError(
      "invalid_cohort_window",
      "Cohort start to observation end cannot exceed 730 days",
    );
  }

  const journeyLimit = body.journeyLimit === undefined
    ? DEFAULT_JOURNEY_LIMIT
    : Number(body.journeyLimit);
  if (
    !Number.isInteger(body.journeyLimit === undefined ? journeyLimit : body.journeyLimit) ||
    journeyLimit < 1 ||
    journeyLimit > MAX_JOURNEY_LIMIT
  ) {
    throw new AcquisitionFunnelValidationError(
      "invalid_journey_limit",
      `journeyLimit must be an integer between 1 and ${MAX_JOURNEY_LIMIT}`,
    );
  }

  const filterHash = createHash("sha256").update(JSON.stringify({
    licenseNamespace: body.licenseNamespace,
    cohortBasis,
    cohortStart,
    cohortEnd,
    observationEnd,
    journeyLimit,
  })).digest("hex");
  const journeyCursor = body.journeyCursor === undefined || body.journeyCursor === null
    ? null
    : decodeFunnelCursor(body.journeyCursor, cursorSecret, filterHash);

  return {
    licenseNamespace: body.licenseNamespace,
    cohortBasis,
    cohortStart,
    cohortEnd,
    observationEnd,
    journeyLimit,
    journeyCursor,
    filterHash,
  };
}

function requireRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AcquisitionFunnelValidationError(
      "invalid_request",
      "Request body must be an object",
    );
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
) {
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (unknownKey) {
    throw new AcquisitionFunnelValidationError(
      "unknown_request_key",
      `Unknown request key: ${unknownKey}`,
    );
  }
}

function normalizeUtcTimestamp(value: unknown, name: string) {
  if (typeof value !== "string" || !UTC_TIMESTAMP_PATTERN.test(value)) {
    throw new AcquisitionFunnelValidationError(
      "invalid_cohort_window",
      `${name} must be an ISO UTC timestamp ending in Z`,
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AcquisitionFunnelValidationError(
      "invalid_cohort_window",
      `${name} must be a valid ISO UTC timestamp`,
    );
  }
  return parsed.toISOString();
}

function normalizeUtcDayBoundary(value: unknown) {
  const normalized = normalizeUtcTimestamp(value, "observationEnd");
  const parsed = new Date(normalized);
  if (
    parsed.getUTCHours() !== 0 ||
    parsed.getUTCMinutes() !== 0 ||
    parsed.getUTCSeconds() !== 0 ||
    parsed.getUTCMilliseconds() !== 0
  ) {
    throw new AcquisitionFunnelValidationError(
      "invalid_cohort_window",
      "observationEnd must be a completed UTC-day boundary at 00:00:00Z",
    );
  }
  return normalized;
}

function formatGroup(row: FunnelGroupRow) {
  const profiles = toBigInt(row.profile_count);
  const firstOpenedProfiles = toBigInt(row.first_opened_count);
  const completedActivations = toBigInt(row.completed_activation_count);
  const paidCustomers = toBigInt(row.paid_customer_count);
  const returnEligibleProfiles = toBigInt(row.return_eligible_count);
  const returnedProfiles = toBigInt(row.returned_count);
  const oneAndDoneProfiles = toBigInt(row.one_and_done_count);
  const firstDayDownloadAttempts = toBigInt(row.first_day_download_attempt_count);
  const firstDayActivatedProfiles = toBigInt(row.first_day_activated_count);
  const browseOnlyProfiles = toBigInt(row.browse_only_count);
  const singleDownloadProfiles = toBigInt(row.single_download_count);
  const multiDownloadProfiles = toBigInt(row.multi_download_count);
  return {
    source: row.source,
    medium: row.medium,
    campaign: row.campaign,
    experiment: row.experiment,
    cohort: row.cohort,
    attributionConfidence: row.attribution_confidence,
    confidence: row.attribution_confidence,
    integrityState: row.integrity_state,
    profileCount: profiles.toString(),
    firstOpenedProfiles: firstOpenedProfiles.toString(),
    completedActivations: completedActivations.toString(),
    paidCustomers: paidCustomers.toString(),
    returnEligibleProfiles: returnEligibleProfiles.toString(),
    returnedProfiles: returnedProfiles.toString(),
    oneAndDoneProfiles: oneAndDoneProfiles.toString(),
    firstDayDownloadAttempts: firstDayDownloadAttempts.toString(),
    firstDayActivatedProfiles: firstDayActivatedProfiles.toString(),
    browseOnlyProfiles: browseOnlyProfiles.toString(),
    singleDownloadProfiles: singleDownloadProfiles.toString(),
    multiDownloadProfiles: multiDownloadProfiles.toString(),
    firstOpenPercentage: percentageMetric(firstOpenedProfiles, profiles),
    activationPercentage: percentageMetric(
      completedActivations,
      firstOpenedProfiles,
    ),
    productActivationPercentage: percentageMetric(
      firstDayActivatedProfiles,
      profiles,
    ),
    browseOnlyPercentage: percentageMetric(
      browseOnlyProfiles,
      firstOpenedProfiles,
    ),
    singleDownloadPercentage: percentageMetric(
      singleDownloadProfiles,
      firstOpenedProfiles,
    ),
    multiDownloadPercentage: percentageMetric(
      multiDownloadProfiles,
      firstOpenedProfiles,
    ),
    paidCustomerPercentage: percentageMetric(paidCustomers, profiles),
    returnPercentage: percentageMetric(
      returnedProfiles,
      returnEligibleProfiles,
    ),
    oneAndDonePercentage: percentageMetric(
      oneAndDoneProfiles,
      returnEligibleProfiles,
    ),
  };
}

function formatJourney(row: FunnelJourneyRow) {
  const laterOpenDays = Array.isArray(row.later_open_days)
    ? [...row.later_open_days]
    : [];
  return {
    customerId: row.customer_id,
    source: row.source,
    medium: row.medium,
    campaign: row.campaign,
    experiment: row.experiment,
    cohort: row.cohort,
    attributionConfidence: row.attribution_confidence,
    confidence: row.attribution_confidence,
    integrityState: row.integrity_state,
    firstVisitAt: nullableIsoString(row.first_attributed_at),
    firstAttributedAt: nullableIsoString(row.first_attributed_at),
    installerRequestedAt: nullableIsoString(row.first_installer_requested_at),
    installerPlatform: row.first_installer_platform,
    cohortAt: toIsoString(row.cohort_at),
    firstInstallAt: nullableIsoString(row.first_install_at),
    firstPurchaseAt: nullableIsoString(row.first_purchase_at),
    firstOpenAt: nullableIsoString(row.first_open_at),
    activationAt: nullableIsoString(row.activation_at),
    completedActivation: row.activation_at !== null,
    paidCustomer: row.paid_customer,
    dayZeroDownloadAttempts: toBigInt(row.day_zero_download_attempts).toString(),
    laterOpenDays,
    returnEligible: row.return_eligible,
    returned: row.return_eligible && laterOpenDays.length > 0,
    oneAndDone: row.return_eligible && laterOpenDays.length === 0,
  };
}

function buildSourceTotals(rows: readonly FunnelGroupRow[]) {
  const totals = new Map<string, {
    profiles: bigint;
    firstOpenedProfiles: bigint;
    firstDayDownloadAttempts: bigint;
    firstDayActivatedProfiles: bigint;
    browseOnlyProfiles: bigint;
    singleDownloadProfiles: bigint;
    multiDownloadProfiles: bigint;
    paidCustomers: bigint;
  }>();
  for (const row of rows) {
    const current = totals.get(row.source) || {
      profiles: 0n,
      firstOpenedProfiles: 0n,
      firstDayDownloadAttempts: 0n,
      firstDayActivatedProfiles: 0n,
      browseOnlyProfiles: 0n,
      singleDownloadProfiles: 0n,
      multiDownloadProfiles: 0n,
      paidCustomers: 0n,
    };
    current.profiles += toBigInt(row.profile_count);
    current.firstOpenedProfiles += toBigInt(row.first_opened_count);
    current.firstDayDownloadAttempts += toBigInt(row.first_day_download_attempt_count);
    current.firstDayActivatedProfiles += toBigInt(row.first_day_activated_count);
    current.browseOnlyProfiles += toBigInt(row.browse_only_count);
    current.singleDownloadProfiles += toBigInt(row.single_download_count);
    current.multiDownloadProfiles += toBigInt(row.multi_download_count);
    current.paidCustomers += toBigInt(row.paid_customer_count);
    totals.set(row.source, current);
  }
  const ordered = [...totals.entries()].sort((left, right) =>
    left[0].localeCompare(right[0]));
  return {
    rows: ordered.slice(0, MAX_SOURCE_GROUPS).map(([source, total]) => ({
      source,
      profileCount: total.profiles.toString(),
      firstOpenedProfiles: total.firstOpenedProfiles.toString(),
      firstDayDownloadAttempts: total.firstDayDownloadAttempts.toString(),
      firstDayActivatedProfiles: total.firstDayActivatedProfiles.toString(),
      browseOnlyProfiles: total.browseOnlyProfiles.toString(),
      singleDownloadProfiles: total.singleDownloadProfiles.toString(),
      multiDownloadProfiles: total.multiDownloadProfiles.toString(),
      productActivationPercentage: percentageMetric(
        total.firstDayActivatedProfiles,
        total.profiles,
      ),
      browseOnlyPercentage: percentageMetric(
        total.browseOnlyProfiles,
        total.firstOpenedProfiles,
      ),
      singleDownloadPercentage: percentageMetric(
        total.singleDownloadProfiles,
        total.firstOpenedProfiles,
      ),
      multiDownloadPercentage: percentageMetric(
        total.multiDownloadProfiles,
        total.firstOpenedProfiles,
      ),
      paidCustomers: total.paidCustomers.toString(),
      paidCustomerPercentage: percentageMetric(total.paidCustomers, total.profiles),
      countingGrain: "distinct_live_customer_profile",
    })),
    truncated: ordered.length > MAX_SOURCE_GROUPS,
  };
}

function formatStageCounts(rows: readonly FunnelStageRow[]) {
  const byStage = new Map(rows
    .filter((row) => ACQUISITION_STAGES.includes(row.stage))
    .map((row) => [row.stage, row]));
  return ACQUISITION_STAGES.map((stage) => ({
    stage,
    count: toBigInt(byStage.get(stage)?.distinct_count || 0).toString(),
    countingGrain: ACQUISITION_STAGE_COUNTING_GRAINS[stage],
    distinctBy: "deduplication_key",
  }));
}

function formatIntegrityAlerts(rows: readonly FunnelIntegrityRow[]) {
  const byState = new Map(rows
    .filter((row) => typeof row.integrity_state === "string" &&
      row.acquisition_count !== undefined)
    .map((row) => [
      row.integrity_state,
      toBigInt(row.acquisition_count).toString(),
    ]));
  return {
    missingInternalLinkage: {
      acquisitionCount: byState.get("missing_internal_linkage") || "0",
      integrityState: "missing_internal_linkage",
    },
    historicalUnlinked: {
      acquisitionCount: byState.get("historical_unlinked") || "0",
      integrityState: "historical_unlinked",
    },
    quarantined: {
      acquisitionCount: byState.get("quarantined") || "0",
      integrityState: "quarantined",
    },
  };
}

function decodeFunnelCursor(
  value: unknown,
  secret: string,
  expectedFilterHash: string,
): FunnelCursor {
  try {
    if (typeof value !== "string" || value.length < 3 || value.length > MAX_CURSOR_LENGTH) {
      throw new Error("invalid cursor");
    }
    const segments = value.split(".");
    if (segments.length !== 2 || !segments.every((segment) =>
      /^[A-Za-z0-9_-]+$/.test(segment))) throw new Error("invalid cursor");
    const [payloadSegment, signatureSegment] = segments;
    const supplied = Buffer.from(signatureSegment, "base64url");
    const expected = createHmac("sha256", secret).update(payloadSegment).digest();
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new Error("invalid cursor");
    }
    const parsed = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
    if (
      !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      parsed.v !== FUNNEL_CURSOR_VERSION || parsed.filterHash !== expectedFilterHash ||
      typeof parsed.cohortAt !== "string" ||
      typeof parsed.customerId !== "string" || !UUID_PATTERN.test(parsed.customerId)
    ) throw new Error("invalid cursor");
    return {
      v: FUNNEL_CURSOR_VERSION,
      filterHash: expectedFilterHash,
      cohortAt: normalizeUtcTimestamp(parsed.cohortAt, "cursor cohortAt"),
      customerId: parsed.customerId.toLowerCase(),
    };
  } catch {
    throw new AcquisitionFunnelValidationError(
      "invalid_journey_cursor",
      "journeyCursor is invalid",
    );
  }
}

function encodeFunnelCursor(cursor: FunnelCursor, secret: string) {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function sumGroupCounts(rows: readonly FunnelGroupRow[]) {
  return rows.reduce((totals, row) => ({
    profiles: totals.profiles + toBigInt(row.profile_count),
    firstOpenedProfiles:
      totals.firstOpenedProfiles + toBigInt(row.first_opened_count),
    completedActivations:
      totals.completedActivations + toBigInt(row.completed_activation_count),
    paidCustomers:
      totals.paidCustomers + toBigInt(row.paid_customer_count),
    returnEligibleProfiles:
      totals.returnEligibleProfiles + toBigInt(row.return_eligible_count),
    returnedProfiles:
      totals.returnedProfiles + toBigInt(row.returned_count),
    oneAndDoneProfiles:
      totals.oneAndDoneProfiles + toBigInt(row.one_and_done_count),
    firstDayDownloadAttempts:
      totals.firstDayDownloadAttempts + toBigInt(row.first_day_download_attempt_count),
    firstDayActivatedProfiles:
      totals.firstDayActivatedProfiles + toBigInt(row.first_day_activated_count),
    browseOnlyProfiles:
      totals.browseOnlyProfiles + toBigInt(row.browse_only_count),
    singleDownloadProfiles:
      totals.singleDownloadProfiles + toBigInt(row.single_download_count),
    multiDownloadProfiles:
      totals.multiDownloadProfiles + toBigInt(row.multi_download_count),
  }), {
    profiles: 0n,
    firstOpenedProfiles: 0n,
    completedActivations: 0n,
    paidCustomers: 0n,
    returnEligibleProfiles: 0n,
    returnedProfiles: 0n,
    oneAndDoneProfiles: 0n,
    firstDayDownloadAttempts: 0n,
    firstDayActivatedProfiles: 0n,
    browseOnlyProfiles: 0n,
    singleDownloadProfiles: 0n,
    multiDownloadProfiles: 0n,
  });
}

function percentageMetric(numerator: bigint, denominator: bigint) {
  return {
    numerator: numerator.toString(),
    denominator: denominator.toString(),
    percentage: denominator === 0n
      ? null
      : formatPercentage(numerator, denominator),
  };
}

function formatPercentage(numerator: bigint, denominator: bigint) {
  const hundredths = (numerator * 10_000n + denominator / 2n) / denominator;
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

function toBigInt(value: string | number | bigint) {
  return BigInt(value);
}

function nullableIsoString(value: Date | string | null) {
  return value === null ? null : toIsoString(value);
}

function toIsoString(value: Date | string) {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("Database returned an invalid timestamp");
  }
  return timestamp.toISOString();
}

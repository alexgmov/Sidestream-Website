import type { QueryResult, QueryResultRow } from "pg";
import { withPostgresTransaction } from "./postgres.js";

const DEFAULT_JOURNEY_LIMIT = 50;
const MAX_JOURNEY_LIMIT = 100;
const MAX_COHORT_WINDOW_MS = 366 * 24 * 60 * 60 * 1_000;
const MAX_OBSERVATION_SPAN_MS = 730 * 24 * 60 * 60 * 1_000;
const UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

type LicenseNamespace = "production" | "test";

type FunnelInput = Readonly<{
  licenseNamespace: LicenseNamespace;
  cohortStart: string;
  cohortEnd: string;
  observationEnd: string;
  journeyLimit: number;
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
  profile_count: string | number | bigint;
  first_opened_count: string | number | bigint;
  completed_activation_count: string | number | bigint;
  return_eligible_count: string | number | bigint;
  returned_count: string | number | bigint;
  one_and_done_count: string | number | bigint;
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
  first_install_at: Date | string;
  first_open_at: Date | string | null;
  activation_at: Date | string | null;
  day_zero_download_attempts: string | number | bigint;
  later_open_days: string[] | null;
  return_eligible: boolean;
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

const FUNNEL_CTES = `
  with cohort_profiles as (
    select
      profile.id as profile_id,
      min(install.first_seen_at) as first_install_at
    from public.sidestream_customer_profiles profile
    join public.sidestream_customer_installs install
      on install.profile_id = profile.id
      and install.license_namespace = profile.license_namespace
    where profile.license_namespace = $1
      and profile.merged_into is null
    group by profile.id
    having min(install.first_seen_at) >= $2::timestamptz
      and min(install.first_seen_at) < $3::timestamptz
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
      cohort.first_install_at,
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
      cohort.first_install_at,
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
  verified_paid_checkouts as (
    select
      checkout.id as checkout_id,
      checkout.installer_receipt_hash,
      checkout.verified_checkout_session_ref,
      entry.id as entry_id,
      entry.created_at as first_attributed_at,
      entry.utm_medium,
      entry.utm_campaign,
      entry.experiment_id,
      entry.cohort
    from public.sidestream_paid_acquisition_checkouts checkout
    join public.sidestream_paid_acquisition_entries entry
      on entry.id = checkout.entry_id
      and entry.environment = checkout.environment
      and entry.experiment_id = checkout.experiment_id
      and entry.cohort = checkout.cohort
      and entry.assignment_id_hash = checkout.assignment_id_hash
      and entry.entry_token_hash = checkout.entry_token_hash
      and entry.attribution_hash = checkout.attribution_hash
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
  paid_candidates as (
    select
      edge.profile_id,
      'manychat'::text as source,
      paid.utm_medium as medium,
      paid.utm_campaign as campaign,
      paid.experiment_id as experiment,
      paid.cohort,
      'exact_paid_checkout'::text as attribution_confidence,
      paid.first_attributed_at,
      null::timestamptz as first_installer_requested_at,
      null::text as first_installer_platform,
      1 as attribution_priority,
      row_number() over (
        partition by edge.profile_id
        order by
          paid.first_attributed_at,
          paid.entry_id,
          paid.checkout_id
      ) as candidate_order
    from paid_profile_edges edge
    join cohort_profiles cohort on cohort.profile_id = edge.profile_id
    join verified_paid_checkouts paid
      on paid.checkout_id = edge.checkout_id
      and paid.first_attributed_at <= cohort.first_install_at
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
      and acquisition.first_seen_at <= cohort.first_install_at
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
      and lead.first_captured_at <= cohort.first_install_at
      and lead.last_captured_at <= cohort.first_install_at
  ),
  attribution_candidates as (
    select
      profile_id, source, medium, campaign, experiment, cohort,
      attribution_confidence, first_attributed_at,
      first_installer_requested_at, first_installer_platform,
      attribution_priority
    from paid_candidates
    where candidate_order = 1

    union all

    select
      profile_id, source, medium, campaign, experiment, cohort,
      attribution_confidence, first_attributed_at,
      first_installer_requested_at, first_installer_platform,
      attribution_priority
    from anonymous_claim_candidates
    where candidate_order = 1

    union all

    select
      profile_id, source, medium, campaign, experiment, cohort,
      attribution_confidence, first_attributed_at,
      first_installer_requested_at, first_installer_platform,
      attribution_priority
    from freemium_candidates
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
      usage.first_install_at,
      usage.first_open_at,
      activation.activation_at,
      usage.day_zero_download_attempts,
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
    left join selected_attribution attribution
      on attribution.profile_id = usage.profile_id
      and attribution.selected_order = 1
    left join anonymous_claim_candidates anonymous_lifecycle
      on anonymous_lifecycle.profile_id = usage.profile_id
      and anonymous_lifecycle.candidate_order = 1
  )
`;

export async function queryAcquisitionFunnel(
  request: unknown,
  overrides: Partial<FunnelDependencies> = {},
) {
  const input = parseFunnelInput(request);
  const dependencies = { ...defaultDependencies, ...overrides };
  const parameters = [
    input.licenseNamespace,
    input.cohortStart,
    input.cohortEnd,
    input.observationEnd,
  ] as const;

  return dependencies.transaction(async (client) => {
    const groupsResult = await client.query<FunnelGroupRow>(`
      ${FUNNEL_CTES}
      select
        source,
        medium,
        campaign,
        experiment,
        cohort,
        attribution_confidence,
        count(*)::bigint as profile_count,
        count(*) filter (where first_open_at is not null)::bigint
          as first_opened_count,
        count(*) filter (
          where first_open_at is not null and activation_at is not null
        )::bigint as completed_activation_count,
        count(*) filter (where return_eligible)::bigint
          as return_eligible_count,
        count(*) filter (
          where return_eligible and cardinality(later_open_days) > 0
        )::bigint as returned_count,
        count(*) filter (
          where return_eligible and cardinality(later_open_days) = 0
        )::bigint as one_and_done_count
      from attributed_profiles
      group by
        source, medium, campaign, experiment, cohort, attribution_confidence
      order by
        source,
        medium nulls first,
        campaign nulls first,
        experiment nulls first,
        cohort nulls first,
        attribution_confidence
    `, parameters);

    const journeysResult = await client.query<FunnelJourneyRow>(`
      ${FUNNEL_CTES}
      select
        profile_id as customer_id,
        source,
        medium,
        campaign,
        experiment,
        cohort,
        attribution_confidence,
        first_attributed_at,
        first_installer_requested_at,
        first_installer_platform,
        first_install_at,
        first_open_at,
        activation_at,
        day_zero_download_attempts,
        later_open_days,
        return_eligible
      from attributed_profiles
      order by first_install_at, profile_id
      limit $5
    `, [...parameters, input.journeyLimit]);

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

    return {
      licenseNamespace: input.licenseNamespace,
      dateWindow: {
        cohortStart: input.cohortStart,
        cohortEnd: input.cohortEnd,
        observationEnd: input.observationEnd,
        endExclusive: true,
        observationEndExclusive: true,
        cohortDefinition: "first_install_at",
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
        returnEligibleProfiles: totals.returnEligibleProfiles.toString(),
        returnedProfiles: totals.returnedProfiles.toString(),
        oneAndDoneProfiles: totals.oneAndDoneProfiles.toString(),
      },
      groups,
      journeys: journeysResult.rows.map(formatJourney),
      journeyLimit: input.journeyLimit,
      journeysReturned: journeysResult.rows.length,
      journeysTruncated: totals.profiles > BigInt(journeysResult.rows.length),
    };
  });
}

function parseFunnelInput(request: unknown): FunnelInput {
  const body = requireRecord(request);
  rejectUnknownKeys(body, [
    "licenseNamespace",
    "cohortStart",
    "cohortEnd",
    "observationEnd",
    "journeyLimit",
  ]);

  if (body.licenseNamespace !== "production" && body.licenseNamespace !== "test") {
    throw new AcquisitionFunnelValidationError(
      "invalid_namespace",
      "licenseNamespace must be production or test",
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

  return {
    licenseNamespace: body.licenseNamespace,
    cohortStart,
    cohortEnd,
    observationEnd,
    journeyLimit,
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
  const returnEligibleProfiles = toBigInt(row.return_eligible_count);
  const returnedProfiles = toBigInt(row.returned_count);
  const oneAndDoneProfiles = toBigInt(row.one_and_done_count);
  return {
    source: row.source,
    medium: row.medium,
    campaign: row.campaign,
    experiment: row.experiment,
    cohort: row.cohort,
    attributionConfidence: row.attribution_confidence,
    confidence: row.attribution_confidence,
    profileCount: profiles.toString(),
    firstOpenedProfiles: firstOpenedProfiles.toString(),
    completedActivations: completedActivations.toString(),
    returnEligibleProfiles: returnEligibleProfiles.toString(),
    returnedProfiles: returnedProfiles.toString(),
    oneAndDoneProfiles: oneAndDoneProfiles.toString(),
    firstOpenPercentage: percentageMetric(firstOpenedProfiles, profiles),
    activationPercentage: percentageMetric(
      completedActivations,
      firstOpenedProfiles,
    ),
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
    firstVisitAt: nullableIsoString(row.first_attributed_at),
    firstAttributedAt: nullableIsoString(row.first_attributed_at),
    installerRequestedAt: nullableIsoString(row.first_installer_requested_at),
    installerPlatform: row.first_installer_platform,
    firstInstallAt: toIsoString(row.first_install_at),
    firstOpenAt: nullableIsoString(row.first_open_at),
    activationAt: nullableIsoString(row.activation_at),
    completedActivation: row.activation_at !== null,
    dayZeroDownloadAttempts: toBigInt(row.day_zero_download_attempts).toString(),
    laterOpenDays,
    returnEligible: row.return_eligible,
    returned: row.return_eligible && laterOpenDays.length > 0,
    oneAndDone: row.return_eligible && laterOpenDays.length === 0,
  };
}

function sumGroupCounts(rows: readonly FunnelGroupRow[]) {
  return rows.reduce((totals, row) => ({
    profiles: totals.profiles + toBigInt(row.profile_count),
    firstOpenedProfiles:
      totals.firstOpenedProfiles + toBigInt(row.first_opened_count),
    completedActivations:
      totals.completedActivations + toBigInt(row.completed_activation_count),
    returnEligibleProfiles:
      totals.returnEligibleProfiles + toBigInt(row.return_eligible_count),
    returnedProfiles:
      totals.returnedProfiles + toBigInt(row.returned_count),
    oneAndDoneProfiles:
      totals.oneAndDoneProfiles + toBigInt(row.one_and_done_count),
  }), {
    profiles: 0n,
    firstOpenedProfiles: 0n,
    completedActivations: 0n,
    returnEligibleProfiles: 0n,
    returnedProfiles: 0n,
    oneAndDoneProfiles: 0n,
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

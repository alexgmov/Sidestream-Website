-- Compact, server-only Customer 360 read models.
--
-- These invoker-rights functions expose only live profile roots, coarse lifecycle
-- and usage aggregates, currency-separated money totals, and explicit quality
-- flags. Raw telemetry, identity evidence values, Stripe source identifiers,
-- secrets, and merged tombstones never enter either projection.

create function public.sidestream_customer_360_profile_read_model()
returns table (
  customer_id uuid,
  license_namespace text,
  display_name text,
  contact_email text,
  profile_created_at timestamptz,
  profile_updated_at timestamptz,
  first_seen_at timestamptz,
  last_activity_at timestamptz,
  install_count bigint,
  first_install_seen_at timestamptz,
  last_install_seen_at timestamptz,
  platform_summary text,
  app_version_summary text,
  entitlement_status text,
  billing_model text,
  first_paid_at timestamptz,
  last_paid_at timestamptz,
  first_upgraded_at timestamptz,
  last_upgraded_at timestamptz,
  commerce_synced_at timestamptz,
  first_download_attempt_at timestamptz,
  first_download_succeeded_at timestamptz,
  download_outcome_numerator bigint,
  download_outcome_denominator bigint,
  last_use_at timestamptz,
  active_days_7 bigint,
  active_days_30 bigint,
  download_frequency_30d numeric,
  usage_synced_at timestamptz,
  usage_source_freshness_at timestamptz,
  data_quality_flags text[],
  sort_activity_at timestamptz
)
language sql
stable
security invoker
parallel safe
as $$
select
  profile.id as customer_id,
  profile.license_namespace,
  profile.display_name,
  profile.contact_email,
  profile.created_at as profile_created_at,
  profile.updated_at as profile_updated_at,
  profile.first_seen_at,
  profile.last_activity_at,
  coalesce(installs.install_count, 0)::bigint as install_count,
  installs.first_install_seen_at,
  installs.last_install_seen_at,
  profile.platform_summary,
  profile.app_version_summary,
  profile.entitlement_status,
  profile.commerce_model as billing_model,
  profile.first_paid_at,
  profile.last_paid_at,
  profile.first_upgraded_at,
  profile.last_upgraded_at,
  profile.commerce_synced_at,
  profile.first_download_attempt_at,
  profile.first_download_success_at as first_download_succeeded_at,
  profile.download_success_count as download_outcome_numerator,
  profile.download_outcome_count as download_outcome_denominator,
  profile.last_app_use_at as last_use_at,
  profile.usage_active_days_7 as active_days_7,
  profile.usage_active_days_30 as active_days_30,
  profile.download_frequency_30d,
  profile.usage_synced_at,
  profile.usage_source_freshness_at,
  array_remove(array[
    case when profile.usage_synced_at is null
      then 'usage_not_synced'::text end,
    case when coalesce(installs.install_count, 0) = 0
      then 'missing_install_membership'::text end,
    case when profile.usage_synced_at is not null
        and profile.usage_install_count <> coalesce(installs.install_count, 0)
      then 'usage_install_count_mismatch'::text end,
    case when coalesce(profile.download_pending_count, 0) > 0
      then 'pending_download_outcomes'::text end,
    case when coalesce(profile.download_unknown_count, 0) > 0
      then 'unknown_download_outcomes'::text end,
    case when profile.download_outcome_count is not null and
        profile.download_outcome_count <>
          coalesce(profile.download_success_count, 0)
          + coalesce(profile.download_failure_count, 0)
          + coalesce(profile.download_cancelled_count, 0)
      then 'outcome_counts_inconsistent'::text end,
    case when profile.download_attempt_count is not null and
        profile.download_attempt_count <>
          coalesce(profile.download_outcome_count, 0)
          + coalesce(profile.download_pending_count, 0)
          + coalesce(profile.download_unknown_count, 0)
      then 'attempt_counts_inconsistent'::text end,
    case when exists (
      select 1
      from public.sidestream_customer_identity_reviews review
      where review.license_namespace = profile.license_namespace
        and review.review_state = 'pending_review'
        and (
          review.candidate_profile_id = profile.id
          or review.existing_profile_id = profile.id
        )
    ) then 'pending_identity_review'::text end,
    case when exists (
      select 1
      from public.sidestream_customer_commerce_materializations materialization
      where materialization.license_namespace = profile.license_namespace
        and materialization.profile_id = profile.id
        and materialization.identity_conflict
    ) then 'commerce_identity_conflict'::text end
  ], null)::text[] as data_quality_flags,
  coalesce(
    profile.last_activity_at,
    profile.last_app_use_at,
    installs.last_install_seen_at,
    profile.first_seen_at,
    profile.created_at
  ) as sort_activity_at
from public.sidestream_customer_profiles profile
left join lateral (
  select
    count(*)::bigint as install_count,
    min(install.first_seen_at) as first_install_seen_at,
    max(install.last_seen_at) as last_install_seen_at
  from public.sidestream_customer_installs install
  where install.license_namespace = profile.license_namespace
    and install.profile_id = profile.id
) installs on true
where profile.merged_into is null
$$;

create function public.sidestream_customer_360_money_read_model()
returns table (
  customer_id uuid,
  license_namespace text,
  currency text,
  gross_paid_minor bigint,
  off_stripe_paid_minor bigint,
  refunded_minor bigint,
  disputed_minor bigint,
  net_paid_minor bigint,
  paid_transaction_count bigint,
  first_paid_at timestamptz,
  last_paid_at timestamptz,
  materialized_at timestamptz
)
language sql
stable
security invoker
parallel safe
as $$
select
  total.profile_id as customer_id,
  total.license_namespace,
  total.currency,
  total.gross_paid_minor,
  total.off_stripe_paid_minor,
  total.refunded_minor,
  total.disputed_minor,
  total.net_paid_minor,
  total.paid_transaction_count,
  total.first_paid_at,
  total.last_paid_at,
  total.materialized_at
from public.sidestream_customer_money_totals total
join public.sidestream_customer_profiles profile
  on profile.id = total.profile_id
  and profile.license_namespace = total.license_namespace
  and profile.merged_into is null
$$;

comment on function public.sidestream_customer_360_profile_read_model() is
  'Server-only compact Customer 360 profile, install, lifecycle, usage, freshness, and data-quality projection; excludes merged tombstones and raw evidence.';
comment on function public.sidestream_customer_360_money_read_model() is
  'Server-only compact currency-separated Customer 360 money projection for live profile roots.';

revoke all on function public.sidestream_customer_360_profile_read_model() from public;
revoke all on function public.sidestream_customer_360_money_read_model() from public;

do $$
declare
  function_name text;
  api_role text;
begin
  foreach function_name in array array[
    'sidestream_customer_360_profile_read_model',
    'sidestream_customer_360_money_read_model'
  ] loop
    foreach api_role in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = api_role) then
        execute format('revoke all on function public.%I() from %I', function_name, api_role);
      end if;
    end loop;
  end loop;
end $$;

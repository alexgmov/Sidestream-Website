-- Privacy-limited Customer 360 usage aggregates.
--
-- Raw telemetry events and their payload/data_points objects remain in the
-- telemetry database. The website stores only replaceable UTC user-day
-- buckets plus a bounded-overlap checkpoint. Gmail campaign hashes are coarse
-- attribution values only: they are never identity evidence, never unique,
-- and never referenced by a profile or install foreign key.

alter table public.sidestream_customer_profiles
  add column if not exists first_app_use_at timestamptz,
  add column if not exists last_app_use_at timestamptz,
  add column if not exists first_download_attempt_at timestamptz,
  add column if not exists last_download_attempt_at timestamptz,
  add column if not exists first_download_success_at timestamptz,
  add column if not exists last_download_success_at timestamptz,
  add column if not exists download_attempt_count bigint,
  add column if not exists download_outcome_count bigint,
  add column if not exists download_cancelled_count bigint,
  add column if not exists download_pending_count bigint,
  add column if not exists download_unknown_count bigint,
  add column if not exists usage_active_days_count bigint,
  add column if not exists usage_active_days_7 bigint,
  add column if not exists usage_active_days_30 bigint,
  add column if not exists download_frequency_30d numeric(20, 6),
  add column if not exists usage_install_count bigint not null default 0,
  add column if not exists usage_synced_at timestamptz,
  add column if not exists usage_source_freshness_at timestamptz;

alter table public.sidestream_customer_profiles
  add constraint sidestream_customer_profiles_usage_counts_nonnegative check (
    download_attempt_count >= 0
    and download_outcome_count >= 0
    and download_cancelled_count >= 0
    and download_pending_count >= 0
    and download_unknown_count >= 0
    and usage_active_days_count >= 0
    and usage_active_days_7 >= 0
    and usage_active_days_30 >= 0
    and usage_install_count >= 0
  ),
  add constraint sidestream_customer_profiles_usage_outcomes_valid check (
    download_attempt_count is null
    or (
      download_outcome_count = coalesce(download_success_count, 0)
        + coalesce(download_failure_count, 0)
        + coalesce(download_cancelled_count, 0)
      and download_attempt_count = download_outcome_count
        + coalesce(download_pending_count, 0)
        + coalesce(download_unknown_count, 0)
    )
  ),
  add constraint sidestream_customer_profiles_app_use_times_valid check (
    first_app_use_at is null
    or last_app_use_at is null
    or last_app_use_at >= first_app_use_at
  ),
  add constraint sidestream_customer_profiles_attempt_times_valid check (
    first_download_attempt_at is null
    or last_download_attempt_at is null
    or last_download_attempt_at >= first_download_attempt_at
  ),
  add constraint sidestream_customer_profiles_success_times_valid check (
    first_download_success_at is null
    or last_download_success_at is null
    or last_download_success_at >= first_download_success_at
  ),
  add constraint sidestream_customer_profiles_download_frequency_valid check (
    download_frequency_30d is null or download_frequency_30d >= 0
  );

create table public.sidestream_customer_usage_daily (
  license_namespace text not null,
  install_id_hash text not null,
  activity_day date not null,
  first_app_use_at timestamptz,
  last_app_use_at timestamptz,
  first_download_attempt_at timestamptz,
  last_download_attempt_at timestamptz,
  first_download_success_at timestamptz,
  last_download_success_at timestamptz,
  active_event_count bigint not null,
  download_attempt_count bigint not null,
  download_outcome_count bigint not null,
  download_success_count bigint not null,
  download_failure_count bigint not null,
  download_cancelled_count bigint not null,
  download_pending_count bigint not null,
  download_unknown_count bigint not null,
  platform text,
  app_version text,
  gmail_campaign_hashes text[] not null default '{}',
  source_watermark_received_at timestamptz not null,
  source_watermark_telemetry_event_id text not null,
  refreshed_at timestamptz not null,
  primary key (license_namespace, install_id_hash, activity_day),
  constraint sidestream_customer_usage_daily_namespace_valid check (
    license_namespace in ('production', 'test')
  ),
  constraint sidestream_customer_usage_daily_hash_valid check (
    install_id_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint sidestream_customer_usage_daily_counts_nonnegative check (
    active_event_count >= 0
    and download_attempt_count >= 0
    and download_outcome_count >= 0
    and download_success_count >= 0
    and download_failure_count >= 0
    and download_cancelled_count >= 0
    and download_pending_count >= 0
    and download_unknown_count >= 0
  ),
  constraint sidestream_customer_usage_daily_outcomes_valid check (
    download_outcome_count = download_success_count
      + download_failure_count
      + download_cancelled_count
    and download_attempt_count = download_outcome_count
      + download_pending_count
      + download_unknown_count
  ),
  constraint sidestream_customer_usage_daily_app_times_valid check (
    first_app_use_at is null
    or last_app_use_at is null
    or last_app_use_at >= first_app_use_at
  ),
  constraint sidestream_customer_usage_daily_attempt_times_valid check (
    first_download_attempt_at is null
    or last_download_attempt_at is null
    or last_download_attempt_at >= first_download_attempt_at
  ),
  constraint sidestream_customer_usage_daily_success_times_valid check (
    first_download_success_at is null
    or last_download_success_at is null
    or last_download_success_at >= first_download_success_at
  ),
  constraint sidestream_customer_usage_daily_platform_valid check (
    platform is null or platform in ('macos', 'windows', 'unknown')
  ),
  constraint sidestream_customer_usage_daily_app_version_bounded check (
    app_version is null or char_length(app_version) <= 64
  ),
  constraint sidestream_customer_usage_daily_watermark_id_bounded check (
    char_length(source_watermark_telemetry_event_id) between 1 and 200
  ),
  constraint sidestream_customer_usage_daily_install_fk
    foreign key (license_namespace, install_id_hash)
    references public.sidestream_customer_installs (
      license_namespace,
      install_id_hash
    )
    on delete cascade
);

create index sidestream_customer_usage_daily_profile_window_idx
  on public.sidestream_customer_usage_daily (
    license_namespace,
    activity_day desc,
    install_id_hash
  );

create table public.sidestream_customer_usage_sync_state (
  license_namespace text primary key,
  checkpoint_received_at timestamptz,
  checkpoint_telemetry_event_id text,
  last_sync_started_at timestamptz,
  last_sync_completed_at timestamptz,
  last_batch_committed_at timestamptz,
  source_freshness_at timestamptz,
  committed_batch_count bigint not null default 0,
  constraint sidestream_customer_usage_sync_state_namespace_valid check (
    license_namespace in ('production', 'test')
  ),
  constraint sidestream_customer_usage_sync_state_checkpoint_pair_valid check (
    (checkpoint_received_at is null and checkpoint_telemetry_event_id is null)
    or (
      checkpoint_received_at is not null
      and checkpoint_telemetry_event_id is not null
      and char_length(checkpoint_telemetry_event_id) between 1 and 200
    )
  ),
  constraint sidestream_customer_usage_sync_state_times_valid check (
    last_sync_started_at is null
    or last_sync_completed_at is null
    or last_sync_completed_at >= last_sync_started_at
  ),
  constraint sidestream_customer_usage_sync_state_batches_nonnegative check (
    committed_batch_count >= 0
  )
);

comment on table public.sidestream_customer_usage_daily is
  'Replaceable UTC user-day aggregates copied from the read-only telemetry source; contains no raw event objects or behavioral text.';
comment on column public.sidestream_customer_usage_daily.gmail_campaign_hashes is
  'Aggregate Gmail campaign attribution only; never customer identity or merge evidence.';
comment on table public.sidestream_customer_usage_sync_state is
  'Bounded-overlap high-water checkpoint ordered by received_at and telemetry_event_id.';

alter table public.sidestream_customer_usage_daily enable row level security;
alter table public.sidestream_customer_usage_sync_state enable row level security;

revoke all on table public.sidestream_customer_usage_daily from public;
revoke all on table public.sidestream_customer_usage_sync_state from public;

do $$
declare
  table_name text;
  api_role text;
begin
  foreach table_name in array array[
    'sidestream_customer_usage_daily',
    'sidestream_customer_usage_sync_state'
  ] loop
    foreach api_role in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = api_role) then
        execute format('revoke all on table public.%I from %I', table_name, api_role);
      end if;
    end loop;
  end loop;
end $$;

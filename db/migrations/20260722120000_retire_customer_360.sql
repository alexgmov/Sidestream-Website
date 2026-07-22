-- Retire the Customer 360 read model while preserving the narrow identity
-- association needed to join namespace-scoped telemetry to verified accounts.
-- The bridge is server-owned and intentionally has no client-facing policy.

drop function if exists public.sidestream_customer_360_profile_read_model();
drop function if exists public.sidestream_customer_360_money_read_model();

-- Trigger drops are guarded by their owning relation so this migration remains
-- safe to replay after the retired tables have already been removed.
do $$
begin
  if to_regclass('public.sidestream_customer_identity_links') is not null then
    execute 'drop trigger if exists sidestream_customer_identity_links_live_profile_guard on public.sidestream_customer_identity_links';
    execute 'drop trigger if exists sidestream_customer_commerce_identity_attach_trigger on public.sidestream_customer_identity_links';
  end if;

  if to_regclass('public.sidestream_customer_installs') is not null then
    execute 'drop trigger if exists sidestream_customer_installs_live_profile_guard on public.sidestream_customer_installs';
  end if;

  if to_regclass('public.sidestream_customer_identity_reviews') is not null then
    execute 'drop trigger if exists sidestream_customer_identity_reviews_immutable_guard on public.sidestream_customer_identity_reviews';
  end if;

  if to_regclass('public.sidestream_customer_profile_merges') is not null then
    execute 'drop trigger if exists sidestream_customer_profile_merges_immutable_guard on public.sidestream_customer_profile_merges';
  end if;

  if to_regclass('public.sidestream_customer_profiles') is not null then
    execute 'drop trigger if exists sidestream_customer_profiles_merge_cycle_insert_guard on public.sidestream_customer_profiles';
    execute 'drop trigger if exists sidestream_customer_profiles_merge_cycle_update_guard on public.sidestream_customer_profiles';
    execute 'drop trigger if exists sidestream_customer_profiles_merge_audit_insert_guard on public.sidestream_customer_profiles';
    execute 'drop trigger if exists sidestream_customer_profiles_merge_audit_update_guard on public.sidestream_customer_profiles';
    execute 'drop trigger if exists sidestream_customer_commerce_profile_merge_trigger on public.sidestream_customer_profiles';
  end if;
end $$;

drop function if exists public.sidestream_customer_commerce_identity_attach();
drop function if exists public.sidestream_customer_commerce_profile_merge();
drop function if exists public.sidestream_customer_commerce_apply(jsonb);
drop function if exists public.sidestream_customer_commerce_reconcile_namespace(text, boolean);
drop function if exists public.sidestream_customer_commerce_refresh_namespace(text);
drop function if exists public.sidestream_customer_commerce_key_priority(text);
drop function if exists public.sidestream_customer_identity_reviews_reject_mutation();
drop function if exists public.sidestream_customer_profiles_require_merge_audit();
drop function if exists public.sidestream_customer_profile_merges_reject_mutation();
drop function if exists public.sidestream_customer_membership_require_live_profile();
drop function if exists public.sidestream_customer_profiles_guard_merge_cycle();

-- Remove dependents before their profile/install parents. Unexpected
-- dependencies fail closed instead of propagating into product tables.
drop table if exists public.sidestream_customer_usage_daily;
drop table if exists public.sidestream_customer_usage_sync_state;
drop table if exists public.sidestream_customer_money_totals;
drop table if exists public.sidestream_customer_commerce_invoice_payments;
drop table if exists public.sidestream_customer_commerce_aliases;
drop table if exists public.sidestream_customer_commerce_materializations;
drop table if exists public.sidestream_customer_identity_reviews;
drop table if exists public.sidestream_customer_profile_merges;
drop table if exists public.sidestream_customer_installs;
drop table if exists public.sidestream_customer_identity_links;
drop table if exists public.sidestream_customer_profiles;

create table if not exists public.sidestream_telemetry_identity_links (
  license_namespace text not null,
  install_id_hash text not null,
  device_id_hash text not null,
  account_id uuid,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  linked_at timestamptz,
  primary key (license_namespace, install_id_hash),
  constraint sidestream_telemetry_identity_links_namespace_valid check (
    license_namespace in ('production', 'test')
  ),
  constraint sidestream_telemetry_identity_links_install_hash_valid check (
    install_id_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint sidestream_telemetry_identity_links_device_hash_valid check (
    device_id_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint sidestream_telemetry_identity_links_timestamps_valid check (
    last_seen_at >= first_seen_at
    and (
      linked_at is null
      or (linked_at >= first_seen_at and linked_at <= last_seen_at)
    )
  ),
  constraint sidestream_telemetry_identity_links_account_fk
    foreign key (account_id)
    references public.sidestream_accounts (id)
    on delete set null
);

create index if not exists sidestream_telemetry_identity_links_device_idx
  on public.sidestream_telemetry_identity_links (
    license_namespace,
    device_id_hash
  );

create index if not exists sidestream_telemetry_identity_links_account_idx
  on public.sidestream_telemetry_identity_links (
    license_namespace,
    account_id
  )
  where account_id is not null;

comment on table public.sidestream_telemetry_identity_links is
  'Private server-owned telemetry install to device/account identity bridge.';
comment on column public.sidestream_telemetry_identity_links.device_id_hash is
  'Lowercase server-HMAC digest of the device identifier.';
comment on column public.sidestream_telemetry_identity_links.account_id is
  'Verified account attached by the trusted account runtime.';

alter table public.sidestream_telemetry_identity_links enable row level security;
revoke all on table public.sidestream_telemetry_identity_links from public;

do $$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = api_role) then
      execute format(
        'revoke all on table public.sidestream_telemetry_identity_links from %I',
        api_role
      );
    end if;
  end loop;
end $$;

create table if not exists public.sidestream_account_devices (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.sidestream_accounts(id) on delete cascade,
  license_namespace text not null,
  device_id_hash text not null,
  platform text not null,
  app_version text,
  build_channel text,
  activated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  revocation_reason text,
  constraint sidestream_account_devices_identity_unique
    unique (id, account_id, license_namespace),
  constraint sidestream_account_devices_namespace_valid check (
    license_namespace in ('production', 'test')
  ),
  constraint sidestream_account_devices_hash_valid check (
    device_id_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint sidestream_account_devices_platform_valid check (
    platform in ('macos', 'windows', 'unknown')
  ),
  constraint sidestream_account_devices_app_version_valid check (
    app_version is null
    or app_version ~ '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$'
  ),
  constraint sidestream_account_devices_build_channel_valid check (
    build_channel is null
    or build_channel ~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$'
  ),
  constraint sidestream_account_devices_times_valid check (
    last_seen_at >= activated_at
    and (revoked_at is null or revoked_at >= activated_at)
  ),
  constraint sidestream_account_devices_revocation_fields_together check (
    (revoked_at is null and revocation_reason is null)
    or (
      revoked_at is not null
      and revocation_reason is not null
      and revocation_reason in ('deactivated', 'replaced')
    )
  )
);

create unique index if not exists sidestream_account_devices_one_active_production
  on public.sidestream_account_devices (account_id)
  where license_namespace = 'production' and revoked_at is null;

create unique index if not exists sidestream_account_devices_one_active_test
  on public.sidestream_account_devices (account_id)
  where license_namespace = 'test' and revoked_at is null;

create index if not exists sidestream_account_devices_lookup_idx
  on public.sidestream_account_devices (
    account_id,
    license_namespace,
    device_id_hash,
    activated_at desc
  );

create table if not exists public.sidestream_device_transfers (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.sidestream_accounts(id) on delete cascade,
  license_namespace text not null,
  from_device_id uuid not null,
  to_device_id uuid not null,
  initiated_by text not null,
  transfer_reason text not null,
  transferred_at timestamptz not null default now(),
  constraint sidestream_device_transfers_namespace_valid check (
    license_namespace in ('production', 'test')
  ),
  constraint sidestream_device_transfers_distinct_devices check (
    from_device_id <> to_device_id
  ),
  constraint sidestream_device_transfers_initiator_valid check (
    initiated_by in ('account', 'support', 'system')
  ),
  constraint sidestream_device_transfers_reason_valid check (
    transfer_reason in ('device_change', 'lost_device', 'support_override')
  ),
  constraint sidestream_device_transfers_from_account_fk
    foreign key (from_device_id, account_id, license_namespace)
    references public.sidestream_account_devices (id, account_id, license_namespace),
  constraint sidestream_device_transfers_to_account_fk
    foreign key (to_device_id, account_id, license_namespace)
    references public.sidestream_account_devices (id, account_id, license_namespace)
);

create index if not exists sidestream_device_transfers_limit_window_idx
  on public.sidestream_device_transfers (
    account_id,
    license_namespace,
    transferred_at desc
  );

comment on column public.sidestream_account_devices.license_namespace is
  'Authorization boundary selected only from trusted server deployment state.';
comment on column public.sidestream_account_devices.device_id_hash is
  'Lowercase HMAC-SHA-256 output; the source device identifier is never persisted.';
comment on column public.sidestream_account_devices.build_channel is
  'Diagnostic client metadata only; never an authorization input.';
comment on table public.sidestream_device_transfers is
  'Account- and namespace-bound device replacement audit with coarse metadata only.';

alter table public.sidestream_account_devices enable row level security;
alter table public.sidestream_device_transfers enable row level security;

do $$
declare
  table_name text;
  api_role text;
  table_names text[] := array[
    'sidestream_account_devices',
    'sidestream_device_transfers'
  ];
  api_roles text[] := array[
    'anon',
    'authenticated'
  ];
begin
  foreach table_name in array table_names loop
    foreach api_role in array api_roles loop
      if exists (select 1 from pg_roles where rolname = api_role) then
        execute format('revoke all on table public.%I from %I', table_name, api_role);
      end if;
    end loop;
  end loop;
end $$;

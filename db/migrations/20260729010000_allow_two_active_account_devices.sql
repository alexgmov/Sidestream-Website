alter table public.sidestream_account_devices
  add column if not exists active_slot smallint;

update public.sidestream_account_devices
set active_slot = 1
where active_slot is null;

alter table public.sidestream_account_devices
  alter column active_slot set not null,
  alter column active_slot set default 1;

alter table public.sidestream_account_devices
  drop constraint if exists sidestream_account_devices_active_slot_valid;

alter table public.sidestream_account_devices
  add constraint sidestream_account_devices_active_slot_valid
  check (active_slot in (1, 2));

drop index if exists public.sidestream_account_devices_one_active_production;
drop index if exists public.sidestream_account_devices_one_active_test;

create unique index if not exists sidestream_account_devices_active_slot_unique
  on public.sidestream_account_devices (account_id, license_namespace, active_slot)
  where revoked_at is null;

comment on column public.sidestream_account_devices.active_slot is
  'Concurrency-safe active device seat. Each account may occupy slots 1 and 2 independently in each license namespace.';

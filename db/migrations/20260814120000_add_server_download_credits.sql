create table public.sidestream_credit_wallets (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.sidestream_accounts(id) on delete restrict,
  license_namespace text not null,
  device_id_hash text not null,
  available_credits integer not null,
  granted_credits integer not null,
  spent_credits integer not null default 0,
  account_bound_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sidestream_credit_wallets_namespace_valid check (
    license_namespace in ('production', 'test')
  ),
  constraint sidestream_credit_wallets_device_hash_valid check (
    device_id_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint sidestream_credit_wallets_balances_valid check (
    available_credits between 0 and 1000000000
    and granted_credits between 0 and 1000000000
    and spent_credits between 0 and granted_credits
    and available_credits <= granted_credits - spent_credits
  ),
  constraint sidestream_credit_wallets_account_binding_valid check (
    (account_id is null and account_bound_at is null)
    or (account_id is not null and account_bound_at is not null)
  ),
  constraint sidestream_credit_wallets_device_unique unique (
    license_namespace,
    device_id_hash
  )
);

create unique index sidestream_credit_wallets_account_unique
  on public.sidestream_credit_wallets (license_namespace, account_id)
  where account_id is not null;

create table public.sidestream_credit_reservations (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.sidestream_credit_wallets(id) on delete restrict,
  reservation_key text not null,
  format_type text not null,
  credit_cost integer not null,
  status text not null default 'reserved',
  reserved_at timestamptz not null default now(),
  expires_at timestamptz not null,
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sidestream_credit_reservations_key_valid check (
    reservation_key ~ '^credit-[0-9a-f]{32,64}$'
  ),
  constraint sidestream_credit_reservations_format_valid check (
    format_type in ('video', 'audio')
  ),
  constraint sidestream_credit_reservations_cost_valid check (
    credit_cost between 1 and 1000000
  ),
  constraint sidestream_credit_reservations_status_valid check (
    status in ('reserved', 'committed', 'released', 'expired')
  ),
  constraint sidestream_credit_reservations_times_valid check (
    expires_at > reserved_at
    and (
      (status = 'reserved' and finalized_at is null)
      or (status <> 'reserved' and finalized_at is not null and finalized_at >= reserved_at)
    )
  ),
  constraint sidestream_credit_reservations_wallet_key_unique unique (
    wallet_id,
    reservation_key
  ),
  constraint sidestream_credit_reservations_id_wallet_unique unique (
    id,
    wallet_id
  )
);

create index sidestream_credit_reservations_expiry_idx
  on public.sidestream_credit_reservations (wallet_id, expires_at)
  where status = 'reserved';

create table public.sidestream_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.sidestream_credit_wallets(id) on delete restrict,
  reservation_id uuid,
  entry_type text not null,
  credit_delta integer not null,
  available_balance_after integer not null,
  stripe_checkout_session_id text,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  constraint sidestream_credit_ledger_entry_type_valid check (
    entry_type in (
      'starter_grant',
      'legacy_usage_import',
      'purchase_grant',
      'download_reserved',
      'download_committed',
      'download_released',
      'download_expired'
    )
  ),
  constraint sidestream_credit_ledger_balance_valid check (
    available_balance_after between 0 and 1000000000
  ),
  constraint sidestream_credit_ledger_idempotency_valid check (
    idempotency_key ~ '^[A-Za-z0-9:_-]{1,180}$'
  ),
  constraint sidestream_credit_ledger_entry_shape_valid check (
    (
      entry_type = 'starter_grant'
      and credit_delta > 0
      and reservation_id is null
      and stripe_checkout_session_id is null
    )
    or (
      entry_type = 'legacy_usage_import'
      and credit_delta < 0
      and reservation_id is null
      and stripe_checkout_session_id is null
    )
    or (
      entry_type = 'purchase_grant'
      and credit_delta > 0
      and reservation_id is null
      and stripe_checkout_session_id is not null
    )
    or (
      entry_type = 'download_reserved'
      and credit_delta < 0
      and reservation_id is not null
      and stripe_checkout_session_id is null
    )
    or (
      entry_type = 'download_committed'
      and credit_delta = 0
      and reservation_id is not null
      and stripe_checkout_session_id is null
    )
    or (
      entry_type in ('download_released', 'download_expired')
      and credit_delta > 0
      and reservation_id is not null
      and stripe_checkout_session_id is null
    )
  ),
  constraint sidestream_credit_ledger_reservation_fk
    foreign key (reservation_id, wallet_id)
    references public.sidestream_credit_reservations (id, wallet_id)
    on delete restrict,
  constraint sidestream_credit_ledger_wallet_idempotency_unique unique (
    wallet_id,
    idempotency_key
  )
);

create unique index sidestream_credit_ledger_checkout_unique
  on public.sidestream_credit_ledger (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;

create index sidestream_credit_ledger_wallet_created_idx
  on public.sidestream_credit_ledger (wallet_id, created_at desc, id desc);

create or replace function public.sidestream_prevent_credit_ledger_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'sidestream_credit_ledger is append-only';
end;
$$;

create trigger sidestream_credit_ledger_immutable
before update or delete on public.sidestream_credit_ledger
for each row execute function public.sidestream_prevent_credit_ledger_mutation();

alter table public.sidestream_credit_wallets enable row level security;
alter table public.sidestream_credit_reservations enable row level security;
alter table public.sidestream_credit_ledger enable row level security;

revoke all on table public.sidestream_credit_wallets from public;
revoke all on table public.sidestream_credit_reservations from public;
revoke all on table public.sidestream_credit_ledger from public;

do $$
declare
  table_name text;
  api_role text;
  table_names text[] := array[
    'sidestream_credit_wallets',
    'sidestream_credit_reservations',
    'sidestream_credit_ledger'
  ];
  api_roles text[] := array['anon', 'authenticated'];
begin
  foreach table_name in array table_names loop
    foreach api_role in array api_roles loop
      if exists (select 1 from pg_roles where rolname = api_role) then
        execute format('revoke all on table public.%I from %I', table_name, api_role);
      end if;
    end loop;
  end loop;
end $$;

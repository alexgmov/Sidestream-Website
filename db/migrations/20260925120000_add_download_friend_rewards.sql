-- Friend rewards are independent of marketing attribution, Stripe and Free credits.
alter table public.sidestream_credit_wallets add constraint sidestream_credit_wallets_id_namespace_unique unique (id, license_namespace);
create table public.sidestream_download_referral_members (
  license_namespace text not null check (license_namespace in ('production', 'test')),
  account_id uuid not null references public.sidestream_accounts(id) on delete restrict,
  wallet_id uuid not null references public.sidestream_credit_wallets(id) on delete restrict,
  invite_code text not null unique check (invite_code ~ '^[A-Za-z0-9_-]{32}$'),
  reward_expires_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (wallet_id, license_namespace) references public.sidestream_credit_wallets(id, license_namespace),
  primary key (license_namespace, account_id),
  unique (license_namespace, wallet_id)
);

create table public.sidestream_download_referral_visits (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  license_namespace text not null,
  inviter_account_id uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  foreign key (license_namespace, inviter_account_id)
    references public.sidestream_download_referral_members(license_namespace, account_id)
);

create table public.sidestream_download_referral_claims (
  id uuid primary key default gen_random_uuid(),
  license_namespace text not null,
  recipient_account_id uuid not null references public.sidestream_accounts(id) on delete restrict,
  inviter_account_id uuid not null,
  visit_token_hash text not null unique references public.sidestream_download_referral_visits(token_hash),
  claimed_at timestamptz not null default now(),
  qualified_at timestamptz,
  qualification_reservation_key text,
  unique (license_namespace, recipient_account_id),
  unique (id, license_namespace),
  check (recipient_account_id <> inviter_account_id),
  check ((qualified_at is null) = (qualification_reservation_key is null)),
  foreign key (license_namespace, inviter_account_id)
    references public.sidestream_download_referral_members(license_namespace, account_id)
);

create table public.sidestream_download_referral_connections (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  browser_key_hash text not null unique check (browser_key_hash ~ '^[0-9a-f]{64}$'),
  license_namespace text not null check (license_namespace in ('production', 'test')),
  device_id_hash text not null check (device_id_hash ~ '^[0-9a-f]{64}$'),
  account_id uuid references public.sidestream_accounts(id) on delete restrict,
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  created_at timestamptz not null default now()
);

-- Device ownership survives credential rotation and reinstall. An authenticated
-- account reconnects to its original wallet; linking never creates a starter grant.
create table public.sidestream_download_referral_devices (
  license_namespace text not null,
  device_id_hash text not null check (device_id_hash ~ '^[0-9a-f]{64}$'),
  account_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null default (now() + interval '180 days'),
  primary key (license_namespace, device_id_hash),
  foreign key (license_namespace, account_id)
    references public.sidestream_download_referral_members(license_namespace, account_id)
);

create table public.sidestream_download_referral_grants (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null,
  license_namespace text not null,
  account_id uuid not null,
  role text not null check (role in ('inviter', 'recipient')),
  starts_at timestamptz not null,
  expires_at timestamptz not null,
  granted_at timestamptz not null default now(),
  unique (claim_id, role),
  unique (claim_id, account_id),
  check (expires_at = starts_at + interval '720 hours'),
  foreign key (claim_id, license_namespace)
    references public.sidestream_download_referral_claims(id, license_namespace),
  foreign key (license_namespace, account_id)
    references public.sidestream_download_referral_members(license_namespace, account_id)
);
create trigger sidestream_download_referral_grants_immutable
  before update or delete on public.sidestream_download_referral_grants
  for each row execute function public.sidestream_prevent_credit_ledger_mutation();

-- Zero-cost accepted jobs have their own records; they never enter the Free ledger.
create table public.sidestream_download_referral_downloads (
  license_namespace text not null,
  wallet_id uuid not null references public.sidestream_credit_wallets(id),
  reservation_key text not null check (reservation_key ~ '^credit-[0-9a-f]{32,64}$'),
  account_id uuid not null,
  access_source text not null check (access_source in ('referral', 'paid')),
  status text not null default 'reserved' check (status in ('reserved', 'committed', 'released', 'expired')),
  reserved_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  finalized_at timestamptz,
  primary key (wallet_id, reservation_key),
  foreign key (wallet_id, license_namespace) references public.sidestream_credit_wallets(id, license_namespace),
  foreign key (license_namespace, account_id)
    references public.sidestream_download_referral_members(license_namespace, account_id)
);
alter table public.sidestream_credit_reservations add column referral_account_id uuid
  references public.sidestream_accounts(id) on delete restrict;

do $$
declare table_name text; api_role text;
begin
  foreach table_name in array array[
    'sidestream_download_referral_members', 'sidestream_download_referral_visits',
    'sidestream_download_referral_claims', 'sidestream_download_referral_connections',
    'sidestream_download_referral_devices', 'sidestream_download_referral_grants',
    'sidestream_download_referral_downloads'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public', table_name);
    foreach api_role in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = api_role) then
        execute format('revoke all on table public.%I from %I', table_name, api_role);
      end if;
    end loop;
  end loop;
end $$;

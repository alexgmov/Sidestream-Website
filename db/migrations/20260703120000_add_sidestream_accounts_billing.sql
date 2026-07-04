create extension if not exists pgcrypto;

create table if not exists public.sidestream_accounts (
  id uuid primary key default gen_random_uuid(),
  google_sub text not null,
  email text not null,
  display_name text,
  avatar_url text,
  stripe_customer_id text,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sidestream_accounts_google_sub_unique unique (google_sub),
  constraint sidestream_accounts_email_normalized check (email = lower(trim(email))),
  constraint sidestream_accounts_email_valid check (position('@' in email) > 1),
  constraint sidestream_accounts_stripe_customer_unique unique (stripe_customer_id)
);

create index if not exists sidestream_accounts_email_idx
  on public.sidestream_accounts (email);

create table if not exists public.sidestream_account_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.sidestream_accounts(id) on delete cascade,
  session_token_hash text not null,
  user_agent text,
  ip_address inet,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sidestream_account_sessions_token_unique unique (session_token_hash)
);

create index if not exists sidestream_account_sessions_account_idx
  on public.sidestream_account_sessions (account_id);

create index if not exists sidestream_account_sessions_expiry_idx
  on public.sidestream_account_sessions (expires_at);

create table if not exists public.sidestream_licenses (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.sidestream_accounts(id) on delete cascade,
  stripe_customer_id text not null,
  stripe_subscription_id text not null,
  plan_key text not null,
  status text not null,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  grace_until timestamptz,
  features jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sidestream_licenses_subscription_unique unique (stripe_subscription_id)
);

create index if not exists sidestream_licenses_account_idx
  on public.sidestream_licenses (account_id);

create index if not exists sidestream_licenses_customer_idx
  on public.sidestream_licenses (stripe_customer_id);

create table if not exists public.sidestream_activation_sessions (
  id uuid primary key default gen_random_uuid(),
  activation_key text not null,
  account_id uuid references public.sidestream_accounts(id) on delete set null,
  license_id uuid references public.sidestream_licenses(id) on delete set null,
  device_id_hash text,
  app_version text,
  build_channel text,
  source text,
  status text not null default 'pending',
  ip_address inet,
  user_agent text,
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sidestream_activation_sessions_key_unique unique (activation_key)
);

create index if not exists sidestream_activation_sessions_account_idx
  on public.sidestream_activation_sessions (account_id);

create index if not exists sidestream_activation_sessions_expiry_idx
  on public.sidestream_activation_sessions (expires_at);

create table if not exists public.sidestream_license_tokens (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.sidestream_accounts(id) on delete cascade,
  license_id uuid not null references public.sidestream_licenses(id) on delete cascade,
  activation_session_id uuid references public.sidestream_activation_sessions(id) on delete set null,
  device_id_hash text,
  token_hash text not null,
  expires_at timestamptz not null,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sidestream_license_tokens_hash_unique unique (token_hash)
);

create index if not exists sidestream_license_tokens_account_idx
  on public.sidestream_license_tokens (account_id);

create index if not exists sidestream_license_tokens_license_idx
  on public.sidestream_license_tokens (license_id);

create index if not exists sidestream_license_tokens_expiry_idx
  on public.sidestream_license_tokens (expires_at);

create table if not exists public.sidestream_stripe_events (
  event_id text primary key,
  event_type text not null,
  stripe_created_at timestamptz,
  payload jsonb not null,
  raw_payload text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sidestream_stripe_events_type_idx
  on public.sidestream_stripe_events (event_type);

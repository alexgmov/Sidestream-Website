begin;

create table public.sidestream_paid_acquisition_entries (
  id uuid primary key default gen_random_uuid(),
  contract_version integer not null,
  environment text not null,
  experiment_id text not null,
  cohort text not null,
  assignment_id_hash text not null,
  assignment_cookie_signature_hash text not null,
  entry_path text not null,
  entry_token_hash text not null,
  attribution_hash text not null,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_id text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sidestream_paid_acquisition_entries_contract_check check (
    contract_version = 1
    and experiment_id = 'mc-mobile-paid-v1'
    and cohort = 'mc-paid-v1'
    and entry_path = '/mc'
    and environment in ('test', 'production')
  ),
  constraint sidestream_paid_acquisition_entries_hashes_check check (
    assignment_id_hash ~ '^[0-9a-f]{64}$'
    and assignment_cookie_signature_hash ~ '^[0-9a-f]{64}$'
    and entry_token_hash ~ '^[0-9a-f]{64}$'
    and attribution_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint sidestream_paid_acquisition_entries_attribution_check check (
    (utm_medium is null or utm_medium in ('dm', 'social'))
    and (utm_campaign is null or utm_campaign ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
    and (utm_content is null or utm_content ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
    and (utm_id is null or utm_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
    and expires_at > created_at
  ),
  constraint sidestream_paid_acquisition_entries_token_unique
    unique (environment, entry_token_hash)
);

create index sidestream_paid_acquisition_entries_assignment_idx
  on public.sidestream_paid_acquisition_entries
    (environment, assignment_id_hash, created_at desc);
create index sidestream_paid_acquisition_entries_expiry_idx
  on public.sidestream_paid_acquisition_entries (expires_at, id);

create table public.sidestream_paid_acquisition_checkouts (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null
    references public.sidestream_paid_acquisition_entries(id) on delete restrict,
  contract_version integer not null,
  environment text not null,
  experiment_id text not null,
  cohort text not null,
  assignment_id_hash text not null,
  entry_token_hash text not null,
  attribution_hash text not null,
  checkout_intent_ref uuid not null
    references public.sidestream_checkout_intents(id) on delete restrict,
  idempotency_key uuid not null,
  request_fingerprint text not null,
  verified_checkout_session_ref text,
  canonical_payment_ref text,
  checkout_email_normalized text,
  verified_product_ref text,
  verified_price_ref text,
  verified_quantity integer,
  verified_amount_minor bigint,
  verified_currency text,
  installer_receipt_hash text,
  payment_state text not null default 'pending',
  claim_state text not null default 'unclaimed',
  receipt_expires_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sidestream_paid_acquisition_checkouts_contract_check check (
    contract_version = 1
    and experiment_id = 'mc-mobile-paid-v1'
    and cohort = 'mc-paid-v1'
    and environment in ('test', 'production')
  ),
  constraint sidestream_paid_acquisition_checkouts_hashes_check check (
    assignment_id_hash ~ '^[0-9a-f]{64}$'
    and entry_token_hash ~ '^[0-9a-f]{64}$'
    and attribution_hash ~ '^[0-9a-f]{64}$'
    and request_fingerprint ~ '^[0-9a-f]{64}$'
    and (installer_receipt_hash is null or installer_receipt_hash ~ '^[0-9a-f]{64}$')
  ),
  constraint sidestream_paid_acquisition_checkouts_provider_bounds check (
    (verified_checkout_session_ref is null or
      (length(verified_checkout_session_ref) between 1 and 255 and
       verified_checkout_session_ref ~ '^[!-~]+$'))
    and (canonical_payment_ref is null or
      (length(canonical_payment_ref) between 1 and 255 and
       canonical_payment_ref ~ '^[!-~]+$'))
    and (checkout_email_normalized is null or
      octet_length(checkout_email_normalized) between 3 and 254)
    and (verified_product_ref is null or length(verified_product_ref) between 1 and 255)
    and (verified_price_ref is null or length(verified_price_ref) between 1 and 255)
    and (verified_quantity is null or verified_quantity = 1)
    and (verified_amount_minor is null or verified_amount_minor = 999)
    and (verified_currency is null or verified_currency = 'usd')
  ),
  constraint sidestream_paid_acquisition_checkouts_state_check check (
    payment_state in ('pending', 'active', 'refunded', 'disputed', 'expired')
    and claim_state in (
      'unclaimed', 'payment_pending', 'email_mismatch', 'claimed',
      'expired', 'refunded', 'disputed'
    )
    and expires_at > created_at
    and (receipt_expires_at is null or receipt_expires_at > created_at)
  ),
  constraint sidestream_paid_acquisition_checkouts_idempotency_unique
    unique (environment, idempotency_key),
  constraint sidestream_paid_acquisition_checkouts_entry_unique
    unique (environment, entry_token_hash)
);

create unique index sidestream_paid_acquisition_checkouts_session_unique
  on public.sidestream_paid_acquisition_checkouts
    (environment, verified_checkout_session_ref)
  where verified_checkout_session_ref is not null;
create unique index sidestream_paid_acquisition_checkouts_payment_unique
  on public.sidestream_paid_acquisition_checkouts
    (environment, canonical_payment_ref)
  where canonical_payment_ref is not null;
create index sidestream_paid_acquisition_checkouts_receipt_idx
  on public.sidestream_paid_acquisition_checkouts
    (environment, installer_receipt_hash)
  where installer_receipt_hash is not null;
create index sidestream_paid_acquisition_checkouts_expiry_idx
  on public.sidestream_paid_acquisition_checkouts (expires_at, id);

create table public.sidestream_paid_acquisition_email_outbox (
  id uuid primary key default gen_random_uuid(),
  checkout_id uuid not null
    references public.sidestream_paid_acquisition_checkouts(id) on delete restrict,
  environment text not null,
  verified_checkout_session_ref text not null,
  email_type text not null,
  email_job_state text not null default 'pending',
  provider_message_ref text,
  attempt_count integer not null default 0,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error_code text,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sidestream_paid_acquisition_email_outbox_contract_check check (
    environment in ('test', 'production')
    and email_type = 'paid-installer-v1'
    and email_job_state in (
      'pending', 'sending', 'accepted', 'retryable', 'dead_letter'
    )
    and attempt_count >= 0
    and (lease_expires_at is null or lease_expires_at <= updated_at + interval '5 minutes')
    and (provider_message_ref is null or length(provider_message_ref) between 1 and 200)
    and (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,64}$')
  ),
  constraint sidestream_paid_acquisition_email_outbox_key_unique
    unique (environment, verified_checkout_session_ref, email_type)
);

create index sidestream_paid_acquisition_email_outbox_pending_idx
  on public.sidestream_paid_acquisition_email_outbox
    (next_attempt_at, created_at)
  where email_job_state in ('pending', 'retryable');

create table public.sidestream_paid_acquisition_claims (
  id uuid primary key default gen_random_uuid(),
  checkout_id uuid not null
    references public.sidestream_paid_acquisition_checkouts(id) on delete restrict,
  environment text not null,
  canonical_payment_ref text not null,
  activation_ref uuid
    references public.sidestream_activation_sessions(id) on delete restrict,
  account_ref uuid references public.sidestream_accounts(id) on delete restrict,
  entitlement_ref uuid references public.sidestream_licenses(id) on delete restrict,
  google_email_normalized text,
  claim_state text not null default 'unclaimed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint sidestream_paid_acquisition_claims_state_check check (
    environment in ('test', 'production')
    and claim_state in (
      'unclaimed', 'payment_pending', 'email_mismatch', 'claimed',
      'expired', 'refunded', 'disputed'
    )
    and (google_email_normalized is null or
      octet_length(google_email_normalized) between 3 and 254)
    and expires_at > created_at
  ),
  constraint sidestream_paid_acquisition_claims_payment_unique
    unique (environment, canonical_payment_ref)
);

create unique index sidestream_paid_acquisition_claims_activation_unique
  on public.sidestream_paid_acquisition_claims (environment, activation_ref)
  where activation_ref is not null;

create table public.sidestream_paid_acquisition_events (
  event_id uuid primary key,
  schema_version integer not null,
  occurred_at timestamptz not null,
  environment text not null,
  experiment_id text not null,
  cohort text not null,
  event_name text not null,
  outcome text not null,
  anonymous_day_hash text not null,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_id text,
  platform text,
  created_at timestamptz not null default now(),
  constraint sidestream_paid_acquisition_events_contract_check check (
    schema_version = 1
    and environment in ('test', 'production')
    and experiment_id = 'mc-mobile-paid-v1'
    and cohort in ('mc-control-v1', 'mc-paid-v1')
    and event_name in (
      'mc_entry_eligible', 'mc_landing_viewed', 'mc_checkout_started',
      'mc_checkout_paid', 'mc_installer_email_accepted',
      'mc_installer_downloaded', 'mc_activation_started',
      'mc_activation_claimed', 'mc_entitlement_issued',
      'mc_refund_recorded', 'mc_dispute_recorded'
    )
    and outcome in ('success', 'pending', 'rejected', 'retryable', 'revoked')
    and anonymous_day_hash ~ '^[0-9a-f]{64}$'
    and (utm_medium is null or utm_medium in ('dm', 'social'))
    and (utm_campaign is null or utm_campaign ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
    and (utm_content is null or utm_content ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
    and (utm_id is null or utm_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
    and (platform is null or platform in ('macos', 'windows', 'unknown'))
    and (cohort = 'mc-paid-v1' or event_name = 'mc_entry_eligible')
  )
);

create index sidestream_paid_acquisition_events_stage_idx
  on public.sidestream_paid_acquisition_events
    (environment, event_name, occurred_at desc);

alter table public.sidestream_paid_acquisition_entries enable row level security;
alter table public.sidestream_paid_acquisition_checkouts enable row level security;
alter table public.sidestream_paid_acquisition_email_outbox enable row level security;
alter table public.sidestream_paid_acquisition_claims enable row level security;
alter table public.sidestream_paid_acquisition_events enable row level security;

revoke all on table public.sidestream_paid_acquisition_entries from public;
revoke all on table public.sidestream_paid_acquisition_checkouts from public;
revoke all on table public.sidestream_paid_acquisition_email_outbox from public;
revoke all on table public.sidestream_paid_acquisition_claims from public;
revoke all on table public.sidestream_paid_acquisition_events from public;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if to_regrole(role_name) is not null then
      execute format(
        'revoke all on table public.sidestream_paid_acquisition_entries, public.sidestream_paid_acquisition_checkouts, public.sidestream_paid_acquisition_email_outbox, public.sidestream_paid_acquisition_claims, public.sidestream_paid_acquisition_events from %I',
        role_name
      );
    end if;
  end loop;
end $$;

comment on column public.sidestream_paid_acquisition_entries.entry_token_hash is
  'SHA-256 only; the opaque paid entry token is never persisted.';
comment on column public.sidestream_paid_acquisition_checkouts.installer_receipt_hash is
  'SHA-256 only; the opaque paid onboarding receipt is never persisted.';
comment on table public.sidestream_paid_acquisition_events is
  'Append-only privacy-safe experiment stage events; provider and customer identifiers are forbidden.';

commit;

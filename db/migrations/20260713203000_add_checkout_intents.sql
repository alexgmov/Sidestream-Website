begin;

create table if not exists public.sidestream_checkout_intents (
  id uuid primary key default gen_random_uuid(),
  intent_kind text not null,
  browser_token_hash text not null,
  account_id uuid references public.sidestream_accounts(id) on delete cascade,
  activation_session_id uuid references public.sidestream_activation_sessions(id) on delete cascade,
  state text not null default 'pending',
  attempt integer not null default 0,
  stripe_customer_id text,
  stripe_checkout_session_id text,
  stripe_checkout_url text,
  stripe_price_id text,
  stripe_product_id text,
  stripe_session_expires_at timestamptz,
  confirmed_at timestamptz,
  last_error_code text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sidestream_checkout_intents_kind_valid check (
    intent_kind in ('anonymous', 'account', 'activation')
  ),
  constraint sidestream_checkout_intents_binding_valid check (
    (intent_kind = 'anonymous' and account_id is null and activation_session_id is null)
    or (intent_kind = 'account' and account_id is not null and activation_session_id is null)
    or (intent_kind = 'activation' and activation_session_id is not null)
  ),
  constraint sidestream_checkout_intents_browser_token_hash_valid check (
    browser_token_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint sidestream_checkout_intents_state_valid check (
    state in ('pending', 'open', 'completed', 'cancelled', 'expired', 'failed')
  ),
  constraint sidestream_checkout_intents_attempt_valid check (attempt >= 0),
  constraint sidestream_checkout_intents_expiry_valid check (
    expires_at > created_at
  ),
  constraint sidestream_checkout_intents_stripe_session_fields_together check (
    (
      stripe_checkout_session_id is null
      and stripe_checkout_url is null
      and stripe_price_id is null
      and stripe_product_id is null
      and stripe_session_expires_at is null
    )
    or (
      length(trim(stripe_checkout_session_id)) > 0
      and length(trim(stripe_checkout_url)) > 0
      and length(trim(stripe_price_id)) > 0
      and length(trim(stripe_product_id)) > 0
      and stripe_session_expires_at is not null
    )
  )
);

create unique index if not exists sidestream_checkout_intents_browser_token_unique
  on public.sidestream_checkout_intents (browser_token_hash);

create index if not exists sidestream_checkout_intents_account_idx
  on public.sidestream_checkout_intents (account_id, created_at desc)
  where account_id is not null;

create index if not exists sidestream_checkout_intents_activation_idx
  on public.sidestream_checkout_intents (activation_session_id, created_at desc)
  where activation_session_id is not null;

create index if not exists sidestream_checkout_intents_session_idx
  on public.sidestream_checkout_intents (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;

create index if not exists sidestream_checkout_intents_expiry_idx
  on public.sidestream_checkout_intents (expires_at);

comment on column public.sidestream_checkout_intents.browser_token_hash is
  'SHA-256 digest of the opaque browser capability; the raw token is never persisted.';

comment on table public.sidestream_checkout_intents is
  'Server-owned, expiring Checkout confirmations. Anonymous intent idempotency cannot detect ownership from an email Stripe has not collected and verified.';

alter table public.sidestream_checkout_intents enable row level security;

revoke all on table public.sidestream_checkout_intents from public;

do $$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = api_role) then
      execute format(
        'revoke all on table public.sidestream_checkout_intents from %I',
        api_role
      );
    end if;
  end loop;
end $$;

commit;

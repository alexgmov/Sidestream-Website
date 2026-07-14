alter table public.sidestream_activation_sessions
  add column if not exists stripe_checkout_session_id text,
  add column if not exists stripe_checkout_price_id text,
  add column if not exists stripe_checkout_product_id text,
  add column if not exists stripe_checkout_expires_at timestamptz,
  add column if not exists checkout_attached_at timestamptz,
  add column if not exists checkout_claim_grace_until timestamptz,
  add column if not exists reconciliation_last_attempt_at timestamptz;

create unique index if not exists sidestream_activation_checkout_session_unique
  on public.sidestream_activation_sessions (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;

alter table public.sidestream_activation_sessions
  drop constraint if exists sidestream_activation_checkout_fields_together;

alter table public.sidestream_activation_sessions
  add constraint sidestream_activation_checkout_fields_together check (
    (
      stripe_checkout_session_id is null
      and stripe_checkout_price_id is null
      and stripe_checkout_product_id is null
      and stripe_checkout_expires_at is null
      and checkout_attached_at is null
      and checkout_claim_grace_until is null
    )
    or
    (
      stripe_checkout_session_id is not null
      and stripe_checkout_price_id is not null
      and stripe_checkout_product_id is not null
      and stripe_checkout_expires_at is not null
      and checkout_attached_at is not null
      and checkout_claim_grace_until is not null
    )
  );

alter table public.sidestream_activation_sessions
  drop constraint if exists sidestream_activation_checkout_values_valid;

alter table public.sidestream_activation_sessions
  add constraint sidestream_activation_checkout_values_valid check (
    stripe_checkout_session_id is null
    or (
      length(trim(stripe_checkout_session_id)) > 0
      and length(trim(stripe_checkout_price_id)) > 0
      and length(trim(stripe_checkout_product_id)) > 0
      and checkout_attached_at <= stripe_checkout_expires_at
      and stripe_checkout_expires_at <= checkout_claim_grace_until
      and checkout_claim_grace_until <= stripe_checkout_expires_at + interval '10 minutes'
      and checkout_claim_grace_until <= expires_at
    )
  );

alter table public.sidestream_activation_sessions
  drop constraint if exists sidestream_activation_reconciliation_requires_checkout;

alter table public.sidestream_activation_sessions
  add constraint sidestream_activation_reconciliation_requires_checkout check (
    reconciliation_last_attempt_at is null
    or (
      stripe_checkout_session_id is not null
      and reconciliation_last_attempt_at >= checkout_attached_at
    )
  );

alter table public.sidestream_license_tokens
  add column if not exists refresh_token_hash text,
  add column if not exists refresh_expires_at timestamptz,
  add column if not exists previous_refresh_token_hash text,
  add column if not exists previous_refresh_valid_until timestamptz,
  add column if not exists refresh_rotated_at timestamptz;

create unique index if not exists sidestream_license_tokens_refresh_hash_unique
  on public.sidestream_license_tokens (refresh_token_hash)
  where refresh_token_hash is not null;

create unique index if not exists sidestream_license_tokens_previous_refresh_hash_unique
  on public.sidestream_license_tokens (previous_refresh_token_hash)
  where previous_refresh_token_hash is not null;

alter table public.sidestream_license_tokens
  drop constraint if exists sidestream_license_tokens_refresh_fields_together;

alter table public.sidestream_license_tokens
  add constraint sidestream_license_tokens_refresh_fields_together check (
    (refresh_token_hash is null and refresh_expires_at is null)
    or
    (
      refresh_token_hash is not null
      and refresh_expires_at is not null
      and device_id_hash is not null
    )
  );

alter table public.sidestream_license_tokens
  drop constraint if exists sidestream_license_tokens_previous_refresh_fields_together;

alter table public.sidestream_license_tokens
  add constraint sidestream_license_tokens_previous_refresh_fields_together check (
    (
      previous_refresh_token_hash is null
      and previous_refresh_valid_until is null
      and refresh_rotated_at is null
    )
    or
    (
      previous_refresh_token_hash is not null
      and previous_refresh_valid_until is not null
      and refresh_rotated_at is not null
      and refresh_token_hash is not null
      and refresh_expires_at is not null
    )
  );

alter table public.sidestream_license_tokens
  drop constraint if exists sidestream_license_tokens_refresh_values_valid;

alter table public.sidestream_license_tokens
  add constraint sidestream_license_tokens_refresh_values_valid check (
    refresh_token_hash is null
    or (
      refresh_token_hash ~ '^[0-9a-f]{64}$'
      and refresh_expires_at > created_at
      and device_id_hash ~ '^[0-9a-f]{64}$'
    )
  );

alter table public.sidestream_license_tokens
  drop constraint if exists sidestream_license_tokens_previous_refresh_values_valid;

alter table public.sidestream_license_tokens
  add constraint sidestream_license_tokens_previous_refresh_values_valid check (
    previous_refresh_token_hash is null
    or (
      previous_refresh_token_hash ~ '^[0-9a-f]{64}$'
      and previous_refresh_token_hash <> refresh_token_hash
      and refresh_rotated_at >= created_at
      and previous_refresh_valid_until > refresh_rotated_at
      and previous_refresh_valid_until <= refresh_rotated_at + interval '2 minutes'
      and previous_refresh_valid_until <= refresh_expires_at
    )
  );

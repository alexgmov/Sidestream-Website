alter table public.sidestream_licenses
  add column if not exists stripe_charge_id text,
  add column if not exists stripe_price_id text,
  add column if not exists stripe_product_id text,
  add column if not exists amount_paid bigint,
  add column if not exists amount_refunded bigint,
  add column if not exists currency text,
  add column if not exists entitlement_status text not null default 'unknown',
  add column if not exists status_reason text not null default 'unreconciled',
  add column if not exists revoked_at timestamptz,
  add column if not exists suspended_at timestamptz,
  add column if not exists reconciled_at timestamptz,
  add column if not exists legacy_subscription_eligible boolean not null default false,
  add column if not exists legacy_subscription_audited_at timestamptz,
  add column if not exists legacy_subscription_quarantined_at timestamptz;

do $$
begin
  alter table public.sidestream_licenses
    add constraint sidestream_licenses_charge_unique unique (stripe_charge_id);
exception
  when duplicate_object then null;
end $$;

alter table public.sidestream_licenses
  drop constraint if exists sidestream_licenses_entitlement_status_check;

alter table public.sidestream_licenses
  add constraint sidestream_licenses_entitlement_status_check
  check (entitlement_status in ('unknown', 'active', 'suspended', 'revoked'));

alter table public.sidestream_licenses
  drop constraint if exists sidestream_licenses_payment_amounts_check;

alter table public.sidestream_licenses
  add constraint sidestream_licenses_payment_amounts_check check (
    (
      amount_paid is null
      and amount_refunded is null
      and currency is null
    )
    or
    (
      amount_paid is not null
      and amount_paid >= 0
      and amount_refunded is not null
      and amount_refunded >= 0
      and currency ~ '^[a-z]{3}$'
    )
  );

alter table public.sidestream_licenses
  drop constraint if exists sidestream_licenses_legacy_eligibility_check;

alter table public.sidestream_licenses
  add constraint sidestream_licenses_legacy_eligibility_check check (
    not legacy_subscription_eligible
    or (
      stripe_subscription_id is not null
      and stripe_price_id is not null
      and stripe_product_id is not null
      and entitlement_status <> 'unknown'
    )
  );

update public.sidestream_licenses
set entitlement_status = case
      when status in ('active', 'trialing') then 'active'
      else 'revoked'
    end,
    status_reason = case
      when status in ('active', 'trialing') then 'legacy_one_time_active_backfill'
      else 'legacy_one_time_inactive_backfill'
    end,
    revoked_at = case
      when status in ('active', 'trialing') then revoked_at
      else coalesce(revoked_at, now())
    end,
    updated_at = now()
where stripe_checkout_session_id is not null
  and entitlement_status = 'unknown'
  and plan_key in ('sidestream_pro', 'sidestream_unlimited');

update public.sidestream_license_tokens as token
set revoked_at = coalesce(token.revoked_at, now()),
    refresh_token_hash = null,
    refresh_expires_at = null,
    previous_refresh_token_hash = null,
    previous_refresh_valid_until = null,
    refresh_rotated_at = null,
    updated_at = now()
from public.sidestream_licenses as license
where token.license_id = license.id
  and license.entitlement_status in ('suspended', 'revoked');

create index if not exists sidestream_licenses_account_entitlement_idx
  on public.sidestream_licenses (account_id, entitlement_status, updated_at desc);

create index if not exists sidestream_licenses_legacy_audit_idx
  on public.sidestream_licenses (legacy_subscription_eligible, legacy_subscription_audited_at)
  where stripe_subscription_id is not null;

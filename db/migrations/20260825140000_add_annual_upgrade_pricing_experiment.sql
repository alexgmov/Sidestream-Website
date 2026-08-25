begin;

alter table public.sidestream_upgrade_pricing_assignments
  drop constraint sidestream_upgrade_pricing_assignments_contract_valid,
  add constraint sidestream_upgrade_pricing_assignments_contract_valid check (
    assignment_bucket between 0 and 9999
    and rollout_basis_points between 0 and 10000
    and (
      (
        assignment_version = 1
        and experiment_id = 'upgrade-pricing-v1'
        and (
          (variant = 'control_one_time' and billing_model = 'one_time')
          or (variant = 'monthly_half' and billing_model = 'subscription')
        )
      )
      or (
        assignment_version = 2
        and experiment_id = 'upgrade-pricing-v2'
        and (
          (variant = 'control_one_time' and billing_model = 'one_time')
          or (variant = 'annual_same_price' and billing_model = 'subscription')
        )
      )
    )
  );

alter table public.sidestream_checkout_intents
  drop constraint sidestream_checkout_intents_upgrade_pricing_snapshot_valid,
  add constraint sidestream_checkout_intents_upgrade_pricing_snapshot_valid check (
    (
      upgrade_pricing_snapshot_version is null
      and upgrade_pricing_experiment_id is null
      and upgrade_pricing_decision_reason is null
      and upgrade_pricing_assignment_id is null
      and upgrade_pricing_assignment_bucket is null
      and upgrade_pricing_rollout_basis_points is null
      and upgrade_pricing_assigned_at is null
      and upgrade_pricing_variant is null
      and upgrade_pricing_billing_model is null
      and upgrade_pricing_country is null
      and upgrade_pricing_currency is null
      and upgrade_pricing_amount_minor is null
      and upgrade_pricing_stripe_product_id is null
      and upgrade_pricing_stripe_price_id is null
      and upgrade_pricing_account_id is null
      and upgrade_pricing_acquisition_id is null
      and upgrade_pricing_checkout_intent_id is null
      and upgrade_pricing_activation_session_id is null
    )
    or (
      (
        (
          upgrade_pricing_snapshot_version = 1
          and upgrade_pricing_experiment_id = 'upgrade-pricing-v1'
          and upgrade_pricing_decision_reason in (
            'existing_assignment',
            'rollout_control',
            'rollout_monthly',
            'rollout_zero',
            'kill_switch',
            'assignment_unavailable',
            'unsupported_currency'
          )
          and (
            (upgrade_pricing_variant = 'control_one_time' and upgrade_pricing_billing_model = 'one_time')
            or (upgrade_pricing_variant = 'monthly_half' and upgrade_pricing_billing_model = 'subscription')
          )
        )
        or (
          upgrade_pricing_snapshot_version = 2
          and upgrade_pricing_experiment_id = 'upgrade-pricing-v2'
          and upgrade_pricing_decision_reason in (
            'existing_assignment',
            'rollout_control',
            'rollout_annual',
            'rollout_zero',
            'kill_switch',
            'assignment_unavailable',
            'unsupported_currency'
          )
          and (
            (upgrade_pricing_variant = 'control_one_time' and upgrade_pricing_billing_model = 'one_time')
            or (upgrade_pricing_variant = 'annual_same_price' and upgrade_pricing_billing_model = 'subscription')
          )
        )
      )
      and upgrade_pricing_country ~ '^[A-Z]{2}$'
      and upgrade_pricing_currency ~ '^[a-z]{3}$'
      and upgrade_pricing_amount_minor > 0
      and length(trim(upgrade_pricing_stripe_product_id)) between 1 and 255
      and length(trim(upgrade_pricing_stripe_price_id)) between 1 and 255
      and upgrade_pricing_account_id is not null
      and upgrade_pricing_acquisition_id is not null
      and upgrade_pricing_checkout_intent_id = id
      and upgrade_pricing_account_id = account_id
      and upgrade_pricing_acquisition_id = acquisition_id
      and upgrade_pricing_activation_session_id is not distinct from activation_session_id
      and upgrade_pricing_rollout_basis_points between 0 and 10000
      and (
        (
          upgrade_pricing_decision_reason in (
            'existing_assignment',
            'rollout_control',
            'rollout_monthly',
            'rollout_annual',
            'rollout_zero'
          )
          and upgrade_pricing_assignment_id is not null
          and upgrade_pricing_assignment_bucket between 0 and 9999
          and upgrade_pricing_assigned_at is not null
        )
        or (
          upgrade_pricing_decision_reason in (
            'kill_switch',
            'assignment_unavailable',
            'unsupported_currency'
          )
          and upgrade_pricing_variant = 'control_one_time'
          and upgrade_pricing_billing_model = 'one_time'
          and upgrade_pricing_assignment_id is null
          and upgrade_pricing_assignment_bucket is null
          and upgrade_pricing_assigned_at is null
        )
      )
    )
  );

alter table public.sidestream_upgrade_pricing_exposures
  drop constraint sidestream_upgrade_pricing_exposures_contract_valid,
  add constraint sidestream_upgrade_pricing_exposures_contract_valid check (
    (
      (
        experiment_id = 'upgrade-pricing-v1'
        and (
          (variant = 'control_one_time' and billing_model = 'one_time')
          or (variant = 'monthly_half' and billing_model = 'subscription')
        )
        and (
          assignment_id is not null
          or (variant = 'control_one_time' and billing_model = 'one_time')
        )
      )
      or (
        experiment_id = 'upgrade-pricing-v2'
        and (
          (variant = 'control_one_time' and billing_model = 'one_time')
          or (variant = 'annual_same_price' and billing_model = 'subscription')
        )
        and assignment_id is not null
      )
    )
  );

create table public.sidestream_annual_renewal_reminders (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null
    references public.sidestream_accounts(id) on delete restrict,
  license_id uuid not null
    references public.sidestream_licenses(id) on delete restrict,
  checkout_intent_id uuid not null
    references public.sidestream_checkout_intents(id) on delete restrict,
  stripe_subscription_id text not null,
  renewal_at timestamptz not null,
  email_job_state text not null default 'pending',
  provider_message_ref text,
  attempt_count integer not null default 0,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error_code text,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sidestream_annual_renewal_reminders_contract_check check (
    length(trim(stripe_subscription_id)) between 1 and 255
    and email_job_state in (
      'pending', 'sending', 'accepted', 'retryable', 'dead_letter', 'canceled'
    )
    and attempt_count >= 0
    and (lease_expires_at is null or lease_expires_at <= updated_at + interval '5 minutes')
    and (provider_message_ref is null or length(provider_message_ref) between 1 and 200)
    and (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,64}$')
    and (accepted_at is null or email_job_state = 'accepted')
  ),
  constraint sidestream_annual_renewal_reminders_key_unique
    unique (stripe_subscription_id, renewal_at)
);

create index sidestream_annual_renewal_reminders_pending_idx
  on public.sidestream_annual_renewal_reminders
    (next_attempt_at, renewal_at, created_at)
  where email_job_state in ('pending', 'retryable');

comment on table public.sidestream_upgrade_pricing_assignments is
  'Permanent authenticated-account assignments for upgrade-pricing-v1 and upgrade-pricing-v2; later rollout changes do not rewrite them.';
comment on table public.sidestream_upgrade_pricing_exposures is
  'Append-only exposure evidence for upgrade-pricing-v1 and upgrade-pricing-v2, recorded only after an exact Checkout Session opens.';
comment on column public.sidestream_checkout_intents.upgrade_pricing_snapshot_version is
  'Nullable for historical or non-experiment intents; populated version-1 and version-2 snapshots are complete and immutable.';
comment on column public.sidestream_checkout_intents.upgrade_pricing_decision_reason is
  'Observable server decision, including one-time fallback reasons excluded from recurring exposure.';
comment on table public.sidestream_annual_renewal_reminders is
  'Durable, idempotent delivery ledger for the promised annual renewal email about 30 days before each active upgrade-pricing-v2 renewal.';

alter table public.sidestream_annual_renewal_reminders enable row level security;
revoke all on table public.sidestream_annual_renewal_reminders from public;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if to_regrole(role_name) is not null then
      execute format(
        'revoke all on table public.sidestream_annual_renewal_reminders from %I',
        role_name
      );
    end if;
  end loop;
end $$;

commit;

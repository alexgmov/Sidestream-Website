begin;

create table public.sidestream_upgrade_pricing_assignments (
  id uuid primary key default gen_random_uuid(),
  assignment_version smallint not null,
  experiment_id text not null,
  account_id uuid not null
    references public.sidestream_accounts(id) on delete restrict,
  variant text not null,
  billing_model text not null,
  assignment_bucket integer not null,
  rollout_basis_points integer not null,
  assigned_at timestamptz not null default now(),
  constraint sidestream_upgrade_pricing_assignments_contract_valid check (
    assignment_version = 1
    and experiment_id = 'upgrade-pricing-v1'
    and assignment_bucket between 0 and 9999
    and rollout_basis_points between 0 and 10000
    and (
      (variant = 'control_one_time' and billing_model = 'one_time')
      or (variant = 'monthly_half' and billing_model = 'subscription')
    )
  ),
  constraint sidestream_upgrade_pricing_assignments_account_unique
    unique (experiment_id, account_id),
  constraint sidestream_upgrade_pricing_assignments_snapshot_unique
    unique (id, experiment_id, account_id, variant, billing_model)
);

create index sidestream_upgrade_pricing_assignments_reporting_idx
  on public.sidestream_upgrade_pricing_assignments
    (experiment_id, variant, assigned_at, id);

alter table public.sidestream_checkout_intents
  add column upgrade_pricing_snapshot_version smallint,
  add column upgrade_pricing_experiment_id text,
  add column upgrade_pricing_decision_reason text,
  add column upgrade_pricing_assignment_id uuid,
  add column upgrade_pricing_assignment_bucket integer,
  add column upgrade_pricing_rollout_basis_points integer,
  add column upgrade_pricing_assigned_at timestamptz,
  add column upgrade_pricing_variant text,
  add column upgrade_pricing_billing_model text,
  add column upgrade_pricing_country text,
  add column upgrade_pricing_currency text,
  add column upgrade_pricing_amount_minor bigint,
  add column upgrade_pricing_stripe_product_id text,
  add column upgrade_pricing_stripe_price_id text,
  add column upgrade_pricing_account_id uuid,
  add column upgrade_pricing_acquisition_id uuid,
  add column upgrade_pricing_checkout_intent_id uuid,
  add column upgrade_pricing_activation_session_id uuid;

alter table public.sidestream_checkout_intents
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
        (
          upgrade_pricing_variant = 'control_one_time'
          and upgrade_pricing_billing_model = 'one_time'
        )
        or (
          upgrade_pricing_variant = 'monthly_half'
          and upgrade_pricing_billing_model = 'subscription'
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
            'rollout_zero'
          )
          and upgrade_pricing_assignment_id is not null
          and upgrade_pricing_assignment_bucket between 0 and 9999
          and upgrade_pricing_rollout_basis_points between 0 and 10000
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
  ),
  add constraint sidestream_checkout_intents_upgrade_assignment_fk
    foreign key (
      upgrade_pricing_assignment_id,
      upgrade_pricing_experiment_id,
      upgrade_pricing_account_id,
      upgrade_pricing_variant,
      upgrade_pricing_billing_model
    )
    references public.sidestream_upgrade_pricing_assignments (
      id,
      experiment_id,
      account_id,
      variant,
      billing_model
    )
    on delete restrict,
  add constraint sidestream_checkout_intents_upgrade_account_fk
    foreign key (upgrade_pricing_account_id)
    references public.sidestream_accounts(id) on delete restrict,
  add constraint sidestream_checkout_intents_upgrade_acquisition_fk
    foreign key (upgrade_pricing_acquisition_id)
    references public.sidestream_acquisitions(id) on delete restrict,
  add constraint sidestream_checkout_intents_upgrade_activation_fk
    foreign key (upgrade_pricing_activation_session_id)
    references public.sidestream_activation_sessions(id) on delete restrict;

create index sidestream_checkout_intents_upgrade_pricing_reporting_idx
  on public.sidestream_checkout_intents
    (
      upgrade_pricing_experiment_id,
      upgrade_pricing_variant,
      created_at,
      id
    )
  where upgrade_pricing_snapshot_version is not null;

create or replace function public.sidestream_upgrade_pricing_assignment_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Upgrade pricing assignments are permanent'
    using errcode = '55000';
  return null;
end;
$$;

create trigger sidestream_upgrade_pricing_assignments_immutable
before update or delete on public.sidestream_upgrade_pricing_assignments
for each row execute function public.sidestream_upgrade_pricing_assignment_immutable();

create or replace function public.sidestream_upgrade_pricing_intent_snapshot_immutable()
returns trigger
language plpgsql
as $$
begin
  if row(
    old.upgrade_pricing_snapshot_version,
    old.upgrade_pricing_experiment_id,
    old.upgrade_pricing_decision_reason,
    old.upgrade_pricing_assignment_id,
    old.upgrade_pricing_assignment_bucket,
    old.upgrade_pricing_rollout_basis_points,
    old.upgrade_pricing_assigned_at,
    old.upgrade_pricing_variant,
    old.upgrade_pricing_billing_model,
    old.upgrade_pricing_country,
    old.upgrade_pricing_currency,
    old.upgrade_pricing_amount_minor,
    old.upgrade_pricing_stripe_product_id,
    old.upgrade_pricing_stripe_price_id,
    old.upgrade_pricing_account_id,
    old.upgrade_pricing_acquisition_id,
    old.upgrade_pricing_checkout_intent_id,
    old.upgrade_pricing_activation_session_id
  ) is distinct from row(
    new.upgrade_pricing_snapshot_version,
    new.upgrade_pricing_experiment_id,
    new.upgrade_pricing_decision_reason,
    new.upgrade_pricing_assignment_id,
    new.upgrade_pricing_assignment_bucket,
    new.upgrade_pricing_rollout_basis_points,
    new.upgrade_pricing_assigned_at,
    new.upgrade_pricing_variant,
    new.upgrade_pricing_billing_model,
    new.upgrade_pricing_country,
    new.upgrade_pricing_currency,
    new.upgrade_pricing_amount_minor,
    new.upgrade_pricing_stripe_product_id,
    new.upgrade_pricing_stripe_price_id,
    new.upgrade_pricing_account_id,
    new.upgrade_pricing_acquisition_id,
    new.upgrade_pricing_checkout_intent_id,
    new.upgrade_pricing_activation_session_id
  ) then
    raise exception 'Upgrade pricing Checkout snapshots are immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger sidestream_checkout_intents_upgrade_pricing_immutable
before update on public.sidestream_checkout_intents
for each row execute function public.sidestream_upgrade_pricing_intent_snapshot_immutable();

create table public.sidestream_upgrade_pricing_exposures (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid,
  experiment_id text not null,
  account_id uuid not null,
  variant text not null,
  billing_model text not null,
  checkout_intent_id uuid not null
    references public.sidestream_checkout_intents(id) on delete restrict,
  exposed_at timestamptz not null default now(),
  constraint sidestream_upgrade_pricing_exposures_contract_valid check (
    experiment_id = 'upgrade-pricing-v1'
    and (
      (variant = 'control_one_time' and billing_model = 'one_time')
      or (variant = 'monthly_half' and billing_model = 'subscription')
    )
    and (
      assignment_id is not null
      or (variant = 'control_one_time' and billing_model = 'one_time')
    )
  ),
  constraint sidestream_upgrade_pricing_exposures_intent_unique
    unique (experiment_id, checkout_intent_id),
  constraint sidestream_upgrade_pricing_exposures_assignment_fk
    foreign key (assignment_id, experiment_id, account_id, variant, billing_model)
    references public.sidestream_upgrade_pricing_assignments (
      id, experiment_id, account_id, variant, billing_model
    )
    on delete restrict
);

create index sidestream_upgrade_pricing_exposures_reporting_idx
  on public.sidestream_upgrade_pricing_exposures
    (experiment_id, variant, exposed_at, id);

create or replace function public.sidestream_upgrade_pricing_exposure_validate()
returns trigger
language plpgsql
as $$
declare
  evidence_found boolean;
begin
  select true
  into evidence_found
  from public.sidestream_checkout_intents intent
  left join public.sidestream_upgrade_pricing_assignments assignment
    on assignment.id = new.assignment_id
  where intent.id = new.checkout_intent_id
    and intent.upgrade_pricing_experiment_id = new.experiment_id
    and intent.upgrade_pricing_account_id = new.account_id
    and intent.upgrade_pricing_variant = new.variant
    and intent.upgrade_pricing_billing_model = new.billing_model
    and intent.stripe_checkout_session_id is not null
    and intent.state in ('open', 'completed')
    and (
      (
        new.assignment_id is not null
        and assignment.experiment_id = new.experiment_id
        and assignment.account_id = new.account_id
        and assignment.variant = new.variant
        and assignment.billing_model = new.billing_model
        and intent.upgrade_pricing_assignment_id = assignment.id
      )
      or (
        new.assignment_id is null
        and intent.upgrade_pricing_assignment_id is null
        and intent.upgrade_pricing_decision_reason in (
          'kill_switch',
          'assignment_unavailable',
          'unsupported_currency'
        )
        and new.variant = 'control_one_time'
        and new.billing_model = 'one_time'
      )
    );

  if evidence_found is distinct from true then
    raise exception 'Upgrade pricing exposure requires an exact opened Checkout snapshot'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.sidestream_upgrade_pricing_exposure_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Upgrade pricing exposures are append-only'
    using errcode = '55000';
  return null;
end;
$$;

create trigger sidestream_upgrade_pricing_exposures_validate
before insert on public.sidestream_upgrade_pricing_exposures
for each row execute function public.sidestream_upgrade_pricing_exposure_validate();

create trigger sidestream_upgrade_pricing_exposures_immutable
before update or delete on public.sidestream_upgrade_pricing_exposures
for each row execute function public.sidestream_upgrade_pricing_exposure_immutable();

comment on table public.sidestream_upgrade_pricing_assignments is
  'Permanent authenticated-account assignment for upgrade-pricing-v1; later rollout changes do not rewrite it.';
comment on table public.sidestream_upgrade_pricing_exposures is
  'Append-only exposure evidence recorded once after an exact assigned or observable one-time-fallback Checkout intent has an opened Session.';
comment on column public.sidestream_checkout_intents.upgrade_pricing_snapshot_version is
  'Nullable for every historical or non-experiment intent; a populated version-1 snapshot is complete and immutable.';
comment on column public.sidestream_checkout_intents.upgrade_pricing_decision_reason is
  'Observable server decision, including one-time fallback reasons that are excluded from monthly exposure.';

alter table public.sidestream_upgrade_pricing_assignments enable row level security;
alter table public.sidestream_upgrade_pricing_exposures enable row level security;

revoke all on table public.sidestream_upgrade_pricing_assignments from public;
revoke all on table public.sidestream_upgrade_pricing_exposures from public;
revoke all on function public.sidestream_upgrade_pricing_assignment_immutable() from public;
revoke all on function public.sidestream_upgrade_pricing_intent_snapshot_immutable() from public;
revoke all on function public.sidestream_upgrade_pricing_exposure_validate() from public;
revoke all on function public.sidestream_upgrade_pricing_exposure_immutable() from public;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if to_regrole(role_name) is not null then
      execute format(
        'revoke all on table public.sidestream_upgrade_pricing_assignments, public.sidestream_upgrade_pricing_exposures from %I',
        role_name
      );
    end if;
  end loop;
end $$;

commit;

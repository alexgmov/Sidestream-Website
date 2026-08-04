begin;

-- Canonical first touch. The UUID is the only public-safe acquisition handle;
-- first-observed attribution never changes after insertion. Delivery evidence is
-- an allowlisted, bounded set of server-observed facts, not a payload container.
create table public.sidestream_acquisitions (
  id uuid primary key default gen_random_uuid(),
  license_namespace text not null,
  first_observed_source text not null,
  first_observed_medium text,
  first_observed_campaign text,
  first_observed_content_creative text,
  entry_channel text not null,
  first_observed_at timestamptz not null,
  external_referrer_category text,
  experiment_id text,
  experiment_cohort text,
  attribution_confidence text not null,
  integrity_state text not null default 'intact',
  trusted_delivery_evidence text[] not null default array['website_entry']::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sidestream_acquisitions_namespace_identity_unique
    unique (id, license_namespace),
  constraint sidestream_acquisitions_namespace_valid check (
    license_namespace in ('production', 'test')
  ),
  constraint sidestream_acquisitions_first_touch_valid check (
    first_observed_source ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
    and (first_observed_medium is null or first_observed_medium ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
    and (first_observed_campaign is null or first_observed_campaign ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
    and (first_observed_content_creative is null or first_observed_content_creative ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
  ),
  constraint sidestream_acquisitions_entry_channel_valid check (
    entry_channel in ('website', 'email_handoff', 'installer', 'account', 'checkout')
  ),
  constraint sidestream_acquisitions_referrer_category_valid check (
    external_referrer_category is null or external_referrer_category in (
      'search', 'social', 'messaging', 'video', 'community', 'publisher', 'other_external'
    )
  ),
  constraint sidestream_acquisitions_experiment_valid check (
    (experiment_id is null and experiment_cohort is null)
    or (
      experiment_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
      and experiment_cohort ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
    )
  ),
  constraint sidestream_acquisitions_confidence_valid check (
    attribution_confidence in (
      'exact_sidestream_entry',
      'exact_trusted_delivery',
      'missing_internal_linkage',
      'historical_unlinked'
    )
  ),
  constraint sidestream_acquisitions_integrity_state_valid check (
    integrity_state in ('intact', 'missing_internal_linkage', 'historical_unlinked', 'quarantined')
  ),
  constraint sidestream_acquisitions_truthful_direct_valid check (
    first_observed_source <> 'website_direct_or_unknown'
    or (
      entry_channel = 'website'
      and external_referrer_category is null
      and attribution_confidence = 'exact_sidestream_entry'
    )
  ),
  constraint sidestream_acquisitions_delivery_evidence_valid check (
    cardinality(trusted_delivery_evidence) between 1 and 8
    and trusted_delivery_evidence <@ array[
      'website_entry',
      'signed_email_handoff',
      'secure_share_handoff',
      'installer_redirect',
      'authenticated_account',
      'checkout_intent',
      'stripe_checkout_session',
      'verified_installation_claim'
    ]::text[]
  )
);

create index sidestream_acquisitions_first_observed_idx
  on public.sidestream_acquisitions (license_namespace, first_observed_at, id);

-- Exactly one canonical grain is valid for each stage. The digest is derived by
-- server code from the namespace, stage, and a stable server-owned reference.
create table public.sidestream_acquisition_stages (
  id uuid primary key default gen_random_uuid(),
  acquisition_id uuid not null,
  license_namespace text not null,
  stage text not null,
  counting_grain text not null,
  deduplication_key text not null,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint sidestream_acquisition_stages_namespace_valid check (
    license_namespace in ('production', 'test')
  ),
  constraint sidestream_acquisition_stages_stage_grain_valid check (
    (stage = 'landing_observed' and counting_grain = 'acquisition')
    or (stage = 'email_handoff_created' and counting_grain = 'delivery_handoff')
    or (stage = 'installer_requested' and counting_grain = 'installer_request')
    or (stage = 'installation_claimed' and counting_grain = 'installation')
    or (stage = 'authentication_completed' and counting_grain = 'authentication')
    or (stage = 'checkout_started' and counting_grain = 'checkout_intent')
    or (stage = 'checkout_completed' and counting_grain = 'checkout_session')
    or (stage = 'payment_settled' and counting_grain = 'payment')
    or (stage = 'refunded' and counting_grain = 'refund')
    or (stage = 'disputed' and counting_grain = 'dispute')
  ),
  constraint sidestream_acquisition_stages_deduplication_key_valid check (
    deduplication_key ~ '^[0-9a-f]{64}$'
  ),
  constraint sidestream_acquisition_stages_replay_unique
    unique (license_namespace, stage, deduplication_key),
  constraint sidestream_acquisition_stages_root_namespace_fk
    foreign key (acquisition_id, license_namespace)
    references public.sidestream_acquisitions (id, license_namespace)
    on delete restrict
);

create index sidestream_acquisition_stages_funnel_idx
  on public.sidestream_acquisition_stages
    (license_namespace, stage, occurred_at, acquisition_id);

-- Contradictory ownership is never guessed. Only a deterministic digest is
-- retained, and exact replays converge on the unique evidence tuple.
create table public.sidestream_acquisition_conflicts (
  id uuid primary key default gen_random_uuid(),
  acquisition_id uuid not null,
  license_namespace text not null,
  conflict_type text not null,
  evidence_hash text not null,
  quarantined_at timestamptz not null default now(),
  constraint sidestream_acquisition_conflicts_namespace_valid check (
    license_namespace in ('production', 'test')
  ),
  constraint sidestream_acquisition_conflicts_type_valid check (
    conflict_type in ('root_first_touch', 'stage_deduplication_owner')
  ),
  constraint sidestream_acquisition_conflicts_hash_valid check (
    evidence_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint sidestream_acquisition_conflicts_replay_unique
    unique (acquisition_id, conflict_type, evidence_hash),
  constraint sidestream_acquisition_conflicts_root_namespace_fk
    foreign key (acquisition_id, license_namespace)
    references public.sidestream_acquisitions (id, license_namespace)
    on delete restrict
);

create or replace function public.sidestream_acquisitions_guard_update()
returns trigger
language plpgsql
as $$
begin
  if new.license_namespace is distinct from old.license_namespace
    or new.first_observed_source is distinct from old.first_observed_source
    or new.first_observed_medium is distinct from old.first_observed_medium
    or new.first_observed_campaign is distinct from old.first_observed_campaign
    or new.first_observed_content_creative is distinct from old.first_observed_content_creative
    or new.entry_channel is distinct from old.entry_channel
    or new.first_observed_at is distinct from old.first_observed_at
    or new.external_referrer_category is distinct from old.external_referrer_category
    or new.experiment_id is distinct from old.experiment_id
    or new.experiment_cohort is distinct from old.experiment_cohort
    or new.attribution_confidence is distinct from old.attribution_confidence
    or new.created_at is distinct from old.created_at then
    raise exception 'Canonical acquisition first touch is immutable'
      using errcode = '23514';
  end if;

  if not new.trusted_delivery_evidence @> old.trusted_delivery_evidence then
    raise exception 'Canonical acquisition delivery evidence is append-only'
      using errcode = '23514';
  end if;

  if old.integrity_state = 'quarantined' and new.integrity_state <> 'quarantined' then
    raise exception 'Canonical acquisition quarantine is sticky'
      using errcode = '23514';
  end if;
  if new.integrity_state is distinct from old.integrity_state
    and not (old.integrity_state = 'intact' and new.integrity_state = 'quarantined') then
    raise exception 'Canonical acquisition integrity state is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger sidestream_acquisitions_update_guard
before update on public.sidestream_acquisitions
for each row execute function public.sidestream_acquisitions_guard_update();

create or replace function public.sidestream_acquisition_append_only_guard()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Acquisition reporting evidence is append-only'
    using errcode = '55000';
  return null;
end;
$$;

create trigger sidestream_acquisition_stages_immutable_guard
before update or delete on public.sidestream_acquisition_stages
for each row execute function public.sidestream_acquisition_append_only_guard();
create trigger sidestream_acquisition_conflicts_immutable_guard
before update or delete on public.sidestream_acquisition_conflicts
for each row execute function public.sidestream_acquisition_append_only_guard();

-- Historical intents deliberately stay null. The insert trigger enforces the
-- new contract without fabricating linkage or blocking maintenance updates to
-- a pre-migration intent.
alter table public.sidestream_checkout_intents
  add column acquisition_id uuid
    references public.sidestream_acquisitions(id) on delete restrict;
create index sidestream_checkout_intents_acquisition_idx
  on public.sidestream_checkout_intents (acquisition_id, created_at desc)
  where acquisition_id is not null;

create or replace function public.sidestream_checkout_intents_require_acquisition()
returns trigger
language plpgsql
as $$
begin
  if new.acquisition_id is null then
    raise exception 'New Checkout intents require a canonical acquisition'
      using errcode = '23502';
  end if;
  return new;
end;
$$;

create trigger sidestream_checkout_intents_require_acquisition_on_insert
before insert on public.sidestream_checkout_intents
for each row execute function public.sidestream_checkout_intents_require_acquisition();

comment on table public.sidestream_acquisitions is
  'Private canonical acquisition roots with immutable first touch and bounded server delivery evidence.';
comment on column public.sidestream_acquisitions.first_observed_source is
  'website_direct_or_unknown truthfully means Sidestream observed the website entry while external origin was unavailable.';
comment on table public.sidestream_acquisition_stages is
  'Append-only canonical-grain stage ledger; deduplication keys are one-way server-derived digests.';
comment on column public.sidestream_checkout_intents.acquisition_id is
  'Canonical acquisition binding. Historical rows remain null; every post-migration insert is required to provide it.';

alter table public.sidestream_acquisitions enable row level security;
alter table public.sidestream_acquisition_stages enable row level security;
alter table public.sidestream_acquisition_conflicts enable row level security;
revoke all on table public.sidestream_acquisitions from public;
revoke all on table public.sidestream_acquisition_stages from public;
revoke all on table public.sidestream_acquisition_conflicts from public;
revoke all on function public.sidestream_acquisitions_guard_update() from public;
revoke all on function public.sidestream_acquisition_append_only_guard() from public;
revoke all on function public.sidestream_checkout_intents_require_acquisition() from public;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if to_regrole(role_name) is not null then
      execute format(
        'revoke all on table public.sidestream_acquisitions, public.sidestream_acquisition_stages, public.sidestream_acquisition_conflicts from %I',
        role_name
      );
    end if;
  end loop;
end $$;

commit;

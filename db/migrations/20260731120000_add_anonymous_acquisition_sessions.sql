begin;

-- Private browser-to-install acquisition continuity. The opaque browser token
-- is never stored; only its SHA-256 digest crosses this database boundary.
-- A visit creates no Customer 360 profile. An existing same-namespace profile
-- may be attached later only by the verified one-time claim flow.
create table public.sidestream_anonymous_acquisition_sessions (
  id uuid primary key default gen_random_uuid(),
  license_namespace text not null,
  token_hash text not null,
  first_touch_source text not null,
  first_touch_medium text,
  first_touch_campaign text,
  first_touch_content text,
  experiment_id text,
  experiment_cohort text,
  experiment_signature_hash text,
  attribution_confidence text not null,
  first_seen_at timestamptz not null,
  first_installer_requested_at timestamptz,
  first_installer_platform text,
  claim_state text not null default 'unclaimed',
  claimed_profile_id uuid,
  claimed_at timestamptz,
  quarantined_at timestamptz,
  expires_at timestamptz not null,
  retained_until timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sidestream_anonymous_acquisition_namespace_valid check (
    license_namespace in ('production', 'test')
  ),
  constraint sidestream_anonymous_acquisition_token_hash_valid check (
    token_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint sidestream_anonymous_acquisition_first_touch_valid check (
    first_touch_source ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
    and (first_touch_medium is null or first_touch_medium ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
    and (first_touch_campaign is null or first_touch_campaign ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
    and (first_touch_content is null or first_touch_content ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
  ),
  constraint sidestream_anonymous_acquisition_experiment_valid check (
    (
      experiment_id is null
      and experiment_cohort is null
      and experiment_signature_hash is null
    ) or (
      experiment_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
      and experiment_cohort in ('paid', 'freemium')
      and experiment_signature_hash ~ '^[0-9a-f]{64}$'
    )
  ),
  constraint sidestream_anonymous_acquisition_confidence_valid check (
    attribution_confidence in ('direct', 'utm', 'signed_freemium', 'signed_paid')
  ),
  constraint sidestream_anonymous_acquisition_installer_valid check (
    (
      first_installer_requested_at is null
      and first_installer_platform is null
    ) or (
      first_installer_requested_at is not null
      and first_installer_platform in ('macos', 'windows')
      and first_installer_requested_at >= first_seen_at
    )
  ),
  constraint sidestream_anonymous_acquisition_claim_valid check (
    claim_state in ('unclaimed', 'claimed', 'quarantined', 'expired')
    and ((claimed_profile_id is null) = (claimed_at is null))
    and (claim_state <> 'claimed' or claimed_profile_id is not null)
    and (claim_state <> 'quarantined' or quarantined_at is not null)
    and (claimed_at is null or claimed_at >= first_seen_at)
    and (quarantined_at is null or quarantined_at >= first_seen_at)
  ),
  constraint sidestream_anonymous_acquisition_retention_valid check (
    expires_at > first_seen_at
    and retained_until >= expires_at
    and retained_until <= first_seen_at + interval '180 days'
  ),
  constraint sidestream_anonymous_acquisition_token_unique
    unique (license_namespace, token_hash),
  constraint sidestream_anonymous_acquisition_profile_same_namespace_fk
    foreign key (claimed_profile_id, license_namespace)
    references public.sidestream_customer_profiles (id, license_namespace)
    on delete restrict
);

create index sidestream_anonymous_acquisition_expiry_idx
  on public.sidestream_anonymous_acquisition_sessions
    (license_namespace, retained_until, id);
create index sidestream_anonymous_acquisition_claim_idx
  on public.sidestream_anonymous_acquisition_sessions
    (license_namespace, claimed_profile_id, claimed_at)
  where claimed_profile_id is not null;

alter table public.sidestream_anonymous_acquisition_sessions
  add constraint sidestream_anonymous_acquisition_session_namespace_unique
  unique (id, license_namespace);

-- Contradictory first-touch, signed-assignment, or claim evidence is retained
-- only as a deterministic digest. Replays converge on the unique key while the
-- session remains quarantined for explicit review.
create table public.sidestream_anonymous_acquisition_conflicts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null
    references public.sidestream_anonymous_acquisition_sessions(id) on delete restrict,
  license_namespace text not null,
  conflict_type text not null,
  evidence_hash text not null,
  quarantined_at timestamptz not null default now(),
  constraint sidestream_anonymous_acquisition_conflicts_namespace_valid check (
    license_namespace in ('production', 'test')
  ),
  constraint sidestream_anonymous_acquisition_conflicts_type_valid check (
    conflict_type in ('first_touch', 'experiment_assignment', 'profile_claim')
  ),
  constraint sidestream_anonymous_acquisition_conflicts_hash_valid check (
    evidence_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint sidestream_anonymous_acquisition_conflicts_replay_unique
    unique (session_id, conflict_type, evidence_hash),
  constraint sidestream_anonymous_acquisition_conflicts_session_namespace_fk
    foreign key (session_id, license_namespace)
    references public.sidestream_anonymous_acquisition_sessions (id, license_namespace)
    on delete restrict
);

create index sidestream_anonymous_acquisition_conflicts_session_idx
  on public.sidestream_anonymous_acquisition_conflicts
    (license_namespace, session_id, quarantined_at);

create or replace function public.sidestream_anonymous_acquisition_guard_update()
returns trigger
language plpgsql
as $$
begin
  if new.license_namespace is distinct from old.license_namespace
    or new.token_hash is distinct from old.token_hash
    or new.first_touch_source is distinct from old.first_touch_source
    or new.first_seen_at is distinct from old.first_seen_at
    or new.expires_at is distinct from old.expires_at
    or new.retained_until is distinct from old.retained_until
    or new.created_at is distinct from old.created_at then
    raise exception 'Anonymous acquisition identity and first touch are immutable'
      using errcode = '23514';
  end if;

  if (old.first_touch_medium is not null and new.first_touch_medium is distinct from old.first_touch_medium)
    or (old.first_touch_campaign is not null and new.first_touch_campaign is distinct from old.first_touch_campaign)
    or (old.first_touch_content is not null and new.first_touch_content is distinct from old.first_touch_content) then
    raise exception 'Anonymous acquisition first-touch fields cannot be replaced'
      using errcode = '23514';
  end if;

  if old.experiment_id is not null and (
    new.experiment_id is distinct from old.experiment_id
    or new.experiment_cohort is distinct from old.experiment_cohort
    or new.experiment_signature_hash is distinct from old.experiment_signature_hash
  ) then
    raise exception 'Anonymous acquisition signed experiment is immutable'
      using errcode = '23514';
  end if;

  if old.first_installer_requested_at is not null and (
    new.first_installer_requested_at is distinct from old.first_installer_requested_at
    or new.first_installer_platform is distinct from old.first_installer_platform
  ) then
    raise exception 'Anonymous acquisition first installer request is immutable'
      using errcode = '23514';
  end if;

  if old.claimed_profile_id is not null and (
    new.claimed_profile_id is distinct from old.claimed_profile_id
    or new.claimed_at is distinct from old.claimed_at
  ) then
    raise exception 'Anonymous acquisition claim evidence is immutable'
      using errcode = '23514';
  end if;

  if old.claim_state = 'claimed' and new.claim_state not in ('claimed', 'quarantined') then
    raise exception 'Anonymous acquisition claim cannot be reopened'
      using errcode = '23514';
  end if;

  if old.quarantined_at is not null and new.quarantined_at is distinct from old.quarantined_at then
    raise exception 'Anonymous acquisition quarantine time is immutable'
      using errcode = '23514';
  end if;

  if old.claim_state = 'quarantined' and new.claim_state <> 'quarantined' then
    raise exception 'Anonymous acquisition quarantine is sticky'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger sidestream_anonymous_acquisition_update_guard
before update on public.sidestream_anonymous_acquisition_sessions
for each row execute function public.sidestream_anonymous_acquisition_guard_update();

create or replace function public.sidestream_anonymous_acquisition_conflicts_reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Anonymous acquisition conflict evidence is append-only'
    using errcode = '55000';
  return null;
end;
$$;

create trigger sidestream_anonymous_acquisition_conflicts_immutable_guard
before update or delete on public.sidestream_anonymous_acquisition_conflicts
for each row execute function public.sidestream_anonymous_acquisition_conflicts_reject_mutation();

comment on table public.sidestream_anonymous_acquisition_sessions is
  'Private browser-to-install acquisition continuity; visits do not create Customer 360 profiles.';
comment on column public.sidestream_anonymous_acquisition_sessions.token_hash is
  'SHA-256 digest only; the opaque browser acquisition token is never persisted.';
comment on table public.sidestream_anonymous_acquisition_conflicts is
  'Append-only quarantine evidence containing conflict type and cryptographic digest only.';

alter table public.sidestream_anonymous_acquisition_sessions enable row level security;
alter table public.sidestream_anonymous_acquisition_conflicts enable row level security;
revoke all on table public.sidestream_anonymous_acquisition_sessions from public;
revoke all on table public.sidestream_anonymous_acquisition_conflicts from public;
revoke all on function public.sidestream_anonymous_acquisition_guard_update() from public;
revoke all on function public.sidestream_anonymous_acquisition_conflicts_reject_mutation() from public;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if to_regrole(role_name) is not null then
      execute format(
        'revoke all on table public.sidestream_anonymous_acquisition_sessions, public.sidestream_anonymous_acquisition_conflicts from %I',
        role_name
      );
    end if;
  end loop;
end $$;

commit;

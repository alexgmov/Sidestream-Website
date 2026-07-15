-- Customer 360 sparse identity core.
--
-- One canonical profile UUID per anonymous install. Later verified evidence
-- (normalized account identity, verified Stripe objects, activation records,
-- stable hashed install identity, support code, hashed installer receipt)
-- attaches to that same UUID; it never replaces the primary key. Sparse rows
-- are expected: contact, platform, lifecycle, download, and commerce fields are
-- nullable and materialized by later Customer 360 steps.
--
-- Every identity link is scoped to the trusted server-resolved license namespace
-- ('production' or 'test'). Composite (id, license_namespace) foreign keys make
-- cross-namespace attachment and cross-namespace merges impossible, so Production
-- and Test records can never merge from shared client values. The namespace is
-- never selected from request JSON, build channel, query strings, or headers.
--
-- Merges are deterministic: a profile becomes a tombstone by pointing
-- merged_into at its surviving sibling, and the immutable merge audit records at
-- most one merge per source profile. Only the deterministic evidence types in
-- the identity-link allowlist may drive a merge. The privacy-limited Gmail
-- campaign/day request HMAC is attribution only; it is not an installer receipt
-- hash, is not customer identity evidence, and is intentionally absent from the
-- allowlist so it can never attach or merge a profile.

create table if not exists public.sidestream_customer_profiles (
  id uuid primary key default gen_random_uuid(),
  license_namespace text not null,
  merged_into uuid,
  merged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Sparse profile/contact fields. These are never identity-merge inputs.
  contact_email text,
  display_name text,
  -- Sparse platform and app-version summaries.
  platform_summary text,
  app_version_summary text,
  -- Aggregate lifecycle timestamps.
  first_seen_at timestamptz,
  last_activity_at timestamptz,
  -- Aggregate download outcomes.
  -- Null means the lifetime aggregate has not been synchronized yet. Unknown
  -- must never be presented as a measured zero.
  download_success_count bigint,
  download_failure_count bigint,
  -- Canonical commerce (materialized by the commerce ledger step).
  entitlement_status text,
  commerce_synced_at timestamptz,
  constraint sidestream_customer_profiles_namespace_identity_unique
    unique (id, license_namespace),
  constraint sidestream_customer_profiles_namespace_valid check (
    license_namespace in ('production', 'test')
  ),
  constraint sidestream_customer_profiles_merge_pointer_valid check (
    (merged_into is null and merged_at is null)
    or (
      merged_into is not null
      and merged_at is not null
      and merged_into <> id
    )
  ),
  constraint sidestream_customer_profiles_counts_nonnegative check (
    download_success_count >= 0 and download_failure_count >= 0
  ),
  constraint sidestream_customer_profiles_lifecycle_valid check (
    first_seen_at is null
    or last_activity_at is null
    or last_activity_at >= first_seen_at
  ),
  constraint sidestream_customer_profiles_contact_email_bounded check (
    contact_email is null or char_length(contact_email) <= 320
  ),
  constraint sidestream_customer_profiles_display_name_bounded check (
    display_name is null or char_length(display_name) <= 200
  ),
  constraint sidestream_customer_profiles_platform_summary_bounded check (
    platform_summary is null or char_length(platform_summary) <= 200
  ),
  constraint sidestream_customer_profiles_app_version_summary_bounded check (
    app_version_summary is null or char_length(app_version_summary) <= 200
  ),
  constraint sidestream_customer_profiles_entitlement_status_bounded check (
    entitlement_status is null or char_length(entitlement_status) <= 64
  ),
  constraint sidestream_customer_profiles_merge_same_namespace_fk
    foreign key (merged_into, license_namespace)
    references public.sidestream_customer_profiles (id, license_namespace)
);

create index if not exists sidestream_customer_profiles_live_idx
  on public.sidestream_customer_profiles (license_namespace, created_at desc)
  where merged_into is null;

create index if not exists sidestream_customer_profiles_merged_into_idx
  on public.sidestream_customer_profiles (merged_into)
  where merged_into is not null;

-- Database-boundary protection for tombstone immutability and cycles. The
-- namespace advisory lock is shared by the runtime merge operation, so direct
-- concurrent A->B / B->A writes cannot each validate against stale state.
create or replace function public.sidestream_customer_profiles_guard_merge_cycle()
returns trigger
language plpgsql
as $$
declare
  merge_cycle_detected boolean;
  target_created_at timestamptz;
  target_profile_id uuid;
begin
  if tg_op = 'UPDATE' then
    if new.license_namespace is distinct from old.license_namespace then
      raise exception 'Customer profile license namespace is immutable'
        using errcode = '23514';
    end if;

    if new.created_at is distinct from old.created_at then
      raise exception 'Customer profile creation order is immutable'
        using errcode = '23514';
    end if;

    if old.merged_into is not null and (
      new.merged_into is distinct from old.merged_into
      or new.merged_at is distinct from old.merged_at
    ) then
      raise exception 'Customer profile tombstone is immutable'
        using errcode = '23514';
    end if;
  end if;

  if new.merged_into is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtext('sidestream_customer_profile_merge:' || new.license_namespace)
  );

  select profile.created_at, profile.id
  into target_created_at, target_profile_id
  from public.sidestream_customer_profiles profile
  where profile.id = new.merged_into
    and profile.license_namespace = new.license_namespace;

  -- Every edge must point strictly backward in one total, immutable order.
  -- This invariant makes cycles impossible even for reciprocal concurrent
  -- writes whose transaction snapshots cannot observe each other's edge.
  if found and not (
    target_created_at < new.created_at
    or (target_created_at = new.created_at and target_profile_id < new.id)
  ) then
    raise exception 'Customer profile merge would violate deterministic acyclic order'
      using errcode = '23514';
  end if;

  with recursive profile_chain (
    profile_id,
    next_profile_id,
    visited,
    cycle_detected
  ) as (
    select
      profile.id,
      profile.merged_into,
      array[profile.id],
      false
    from public.sidestream_customer_profiles profile
    where profile.id = new.merged_into
      and profile.license_namespace = new.license_namespace

    union all

    select
      profile.id,
      profile.merged_into,
      chain.visited || profile.id,
      profile.id = any(chain.visited)
    from profile_chain chain
    join public.sidestream_customer_profiles profile
      on profile.id = chain.next_profile_id
      and profile.license_namespace = new.license_namespace
    where not chain.cycle_detected
  )
  select coalesce(bool_or(profile_id = new.id or cycle_detected), false)
  into merge_cycle_detected
  from profile_chain;

  if merge_cycle_detected then
    raise exception 'Customer profile merge cycle detected'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger sidestream_customer_profiles_merge_cycle_insert_guard
before insert on public.sidestream_customer_profiles
for each row execute function public.sidestream_customer_profiles_guard_merge_cycle();

create trigger sidestream_customer_profiles_merge_cycle_update_guard
before update of merged_into, merged_at, license_namespace, created_at
on public.sidestream_customer_profiles
for each row execute function public.sidestream_customer_profiles_guard_merge_cycle();

-- Deterministic identity evidence ledger. A single verified value maps to one
-- profile within a namespace, which is what makes idempotent resolution and
-- merges possible.
create table if not exists public.sidestream_customer_identity_links (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  license_namespace text not null,
  link_type text not null,
  link_value text not null,
  created_at timestamptz not null default now(),
  constraint sidestream_customer_identity_links_namespace_valid check (
    license_namespace in ('production', 'test')
  ),
  constraint sidestream_customer_identity_links_type_valid check (
    link_type in (
      'account_identity',
      'stripe_customer',
      'stripe_checkout_session',
      'stripe_payment_intent',
      'stripe_subscription',
      'activation_record',
      'install_identity_hash',
      'support_code',
      'installer_receipt_hash'
    )
  ),
  constraint sidestream_customer_identity_links_value_valid check (
    char_length(link_value) between 1 and 200
    and (
      link_type not in ('install_identity_hash', 'installer_receipt_hash')
      or link_value ~ '^[0-9a-f]{64}$'
    )
  ),
  constraint sidestream_customer_identity_links_evidence_unique
    unique (license_namespace, link_type, link_value),
  constraint sidestream_customer_identity_links_profile_same_namespace_fk
    foreign key (profile_id, license_namespace)
    references public.sidestream_customer_profiles (id, license_namespace)
    on delete cascade
);

create index if not exists sidestream_customer_identity_links_profile_idx
  on public.sidestream_customer_identity_links (profile_id, link_type);

-- Install membership: every anonymous install resolves to exactly one profile
-- in its namespace via the stable hashed install identity. Only coarse platform
-- and app-version metadata plus aggregate lifecycle timestamps are retained.
create table if not exists public.sidestream_customer_installs (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  license_namespace text not null,
  install_id_hash text not null,
  platform text,
  app_version text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint sidestream_customer_installs_namespace_valid check (
    license_namespace in ('production', 'test')
  ),
  constraint sidestream_customer_installs_hash_valid check (
    install_id_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint sidestream_customer_installs_platform_valid check (
    platform is null or platform in ('macos', 'windows', 'unknown')
  ),
  constraint sidestream_customer_installs_app_version_bounded check (
    app_version is null or char_length(app_version) <= 64
  ),
  constraint sidestream_customer_installs_times_valid check (
    last_seen_at >= first_seen_at
  ),
  constraint sidestream_customer_installs_membership_unique
    unique (license_namespace, install_id_hash),
  constraint sidestream_customer_installs_profile_same_namespace_fk
    foreign key (profile_id, license_namespace)
    references public.sidestream_customer_profiles (id, license_namespace)
    on delete cascade
);

create index if not exists sidestream_customer_installs_profile_idx
  on public.sidestream_customer_installs (profile_id, last_seen_at desc);

-- Evidence and install membership may only point at a live root. Runtime merges
-- lock both membership tables before their set-based move, so an insert racing
-- a merge is either included in that move or observes and rejects the tombstone.
create or replace function public.sidestream_customer_membership_require_live_profile()
returns trigger
language plpgsql
as $$
declare
  target_merged_into uuid;
begin
  select profile.merged_into
  into target_merged_into
  from public.sidestream_customer_profiles profile
  where profile.id = new.profile_id
    and profile.license_namespace = new.license_namespace;

  if found and target_merged_into is not null then
    raise exception 'Customer identity and install membership must attach to a live profile root'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger sidestream_customer_identity_links_live_profile_guard
before insert or update on public.sidestream_customer_identity_links
for each row execute function public.sidestream_customer_membership_require_live_profile();

create trigger sidestream_customer_installs_live_profile_guard
before insert or update on public.sidestream_customer_installs
for each row execute function public.sidestream_customer_membership_require_live_profile();

-- Immutable, append-only merge audit. The unique (license_namespace,
-- source_profile_id) constraint guarantees each profile is tombstoned at most
-- once, which keeps merges idempotent and the merge graph acyclic. Evidence is
-- always stored as a hash, never a raw value.
create table if not exists public.sidestream_customer_profile_merges (
  id uuid primary key default gen_random_uuid(),
  license_namespace text not null,
  source_profile_id uuid not null,
  target_profile_id uuid not null,
  merge_evidence_type text not null,
  merge_evidence_value_hash text not null,
  initiated_by text not null,
  merged_at timestamptz not null default now(),
  constraint sidestream_customer_profile_merges_namespace_valid check (
    license_namespace in ('production', 'test')
  ),
  constraint sidestream_customer_profile_merges_distinct check (
    source_profile_id <> target_profile_id
  ),
  constraint sidestream_customer_profile_merges_evidence_type_valid check (
    merge_evidence_type in (
      'account_identity',
      'stripe_customer',
      'stripe_checkout_session',
      'stripe_payment_intent',
      'stripe_subscription',
      'activation_record',
      'install_identity_hash',
      'support_code',
      'installer_receipt_hash'
    )
  ),
  constraint sidestream_customer_profile_merges_evidence_hash_valid check (
    merge_evidence_value_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint sidestream_customer_profile_merges_initiator_valid check (
    initiated_by in ('system', 'support', 'backfill')
  ),
  constraint sidestream_customer_profile_merges_source_once_unique
    unique (license_namespace, source_profile_id),
  constraint sidestream_customer_profile_merges_source_same_namespace_fk
    foreign key (source_profile_id, license_namespace)
    references public.sidestream_customer_profiles (id, license_namespace),
  constraint sidestream_customer_profile_merges_target_same_namespace_fk
    foreign key (target_profile_id, license_namespace)
    references public.sidestream_customer_profiles (id, license_namespace)
);

create index if not exists sidestream_customer_profile_merges_target_idx
  on public.sidestream_customer_profile_merges (license_namespace, target_profile_id);

-- Audit rows are append-only even for the owning runtime role. Corrections are
-- represented by a later audit event/migration, never mutation of history.
create or replace function public.sidestream_customer_profile_merges_reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Customer profile merge audit is immutable'
    using errcode = '55000';
  return null;
end;
$$;

create trigger sidestream_customer_profile_merges_immutable_guard
before update or delete on public.sidestream_customer_profile_merges
for each row execute function public.sidestream_customer_profile_merges_reject_mutation();

-- Deferred validation lets the runtime tombstone first and append its audit
-- later in the same transaction, while making an unaudited direct tombstone
-- impossible to commit.
create or replace function public.sidestream_customer_profiles_require_merge_audit()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
    from public.sidestream_customer_profile_merges audit
    where audit.license_namespace = new.license_namespace
      and audit.source_profile_id = new.id
      and audit.target_profile_id = new.merged_into
  ) then
    raise exception 'Customer profile tombstone requires an immutable merge audit'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger sidestream_customer_profiles_merge_audit_insert_guard
after insert on public.sidestream_customer_profiles
deferrable initially deferred
for each row
when (new.merged_into is not null)
execute function public.sidestream_customer_profiles_require_merge_audit();

create constraint trigger sidestream_customer_profiles_merge_audit_update_guard
after update of merged_into on public.sidestream_customer_profiles
deferrable initially deferred
for each row
when (new.merged_into is not null and new.merged_into is distinct from old.merged_into)
execute function public.sidestream_customer_profiles_require_merge_audit();

comment on table public.sidestream_customer_profiles is
  'Canonical Customer 360 profile; one UUID per anonymous install, sparse by design.';
comment on column public.sidestream_customer_profiles.license_namespace is
  'Authorization boundary selected only from trusted server deployment state.';
comment on column public.sidestream_customer_profiles.merged_into is
  'Non-null tombstone pointer to the surviving same-namespace profile; primary key is never replaced.';
comment on column public.sidestream_customer_profiles.contact_email is
  'Sparse contact field; never an identity-merge input.';
comment on column public.sidestream_customer_profiles.display_name is
  'Sparse profile field; never an identity-merge input.';
comment on table public.sidestream_customer_identity_links is
  'Deterministic verified identity evidence; excludes IP, user agent, unverified email, and the Gmail campaign request HMAC.';
comment on column public.sidestream_customer_identity_links.link_value is
  'Normalized identifier or lowercase hash depending on link_type; never a raw hardware fingerprint.';
comment on table public.sidestream_customer_installs is
  'Install membership keyed by stable hashed install identity; coarse metadata only.';
comment on table public.sidestream_customer_profile_merges is
  'Immutable append-only merge audit; one row per tombstoned source profile.';
comment on column public.sidestream_customer_profile_merges.merge_evidence_value_hash is
  'Hashed deterministic evidence that drove the merge; raw evidence is never stored.';

alter table public.sidestream_customer_profiles enable row level security;
alter table public.sidestream_customer_identity_links enable row level security;
alter table public.sidestream_customer_installs enable row level security;
alter table public.sidestream_customer_profile_merges enable row level security;

revoke all on table public.sidestream_customer_profiles from public;
revoke all on table public.sidestream_customer_identity_links from public;
revoke all on table public.sidestream_customer_installs from public;
revoke all on table public.sidestream_customer_profile_merges from public;
revoke all on function public.sidestream_customer_profiles_guard_merge_cycle() from public;
revoke all on function public.sidestream_customer_membership_require_live_profile() from public;
revoke all on function public.sidestream_customer_profile_merges_reject_mutation() from public;
revoke all on function public.sidestream_customer_profiles_require_merge_audit() from public;

do $$
declare
  table_name text;
  api_role text;
  table_names text[] := array[
    'sidestream_customer_profiles',
    'sidestream_customer_identity_links',
    'sidestream_customer_installs',
    'sidestream_customer_profile_merges'
  ];
  api_roles text[] := array[
    'anon',
    'authenticated'
  ];
begin
  foreach table_name in array table_names loop
    foreach api_role in array api_roles loop
      if exists (select 1 from pg_roles where rolname = api_role) then
        execute format('revoke all on table public.%I from %I', table_name, api_role);
      end if;
    end loop;
  end loop;
end $$;

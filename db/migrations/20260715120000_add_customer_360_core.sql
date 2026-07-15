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
  download_success_count bigint not null default 0,
  download_failure_count bigint not null default 0,
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
  constraint sidestream_customer_identity_links_value_bounded check (
    char_length(link_value) between 1 and 200
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

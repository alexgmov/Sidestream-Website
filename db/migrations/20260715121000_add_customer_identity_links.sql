-- Customer 360 runtime identity attachment and conflict review ledger.
--
-- Client-provided install, support, and receipt values are association keys,
-- never authentication. Account and Stripe identifiers are attached only after
-- the runtime reads verified rows from the trusted namespace database. A unique
-- identity link has one winner; a conflicting candidate is retained as an
-- immutable, hashed review event and is never silently merged or overwritten.

alter table public.sidestream_customer_identity_links
  drop constraint sidestream_customer_identity_links_value_valid;

alter table public.sidestream_customer_identity_links
  add constraint sidestream_customer_identity_links_value_valid check (
    char_length(link_value) between 1 and 200
    and (
      link_type not in ('install_identity_hash', 'installer_receipt_hash')
      or link_value ~ '^[0-9a-f]{64}$'
    )
    and (
      link_type <> 'support_code'
      or link_value ~ '^SIDE-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$'
    )
  );

-- A profile may accumulate several purchases over time, but it may represent
-- only one verified account. Runtime review rows preserve rejected contenders.
create unique index if not exists sidestream_customer_identity_links_profile_account_unique
  on public.sidestream_customer_identity_links (license_namespace, profile_id)
  where link_type = 'account_identity';

create table if not exists public.sidestream_customer_identity_reviews (
  id uuid primary key default gen_random_uuid(),
  license_namespace text not null,
  candidate_profile_id uuid not null,
  existing_profile_id uuid not null,
  evidence_type text not null,
  evidence_value_hash text not null,
  evidence_trust text not null,
  attachment_source text not null,
  review_state text not null default 'pending_review',
  created_at timestamptz not null default now(),
  constraint sidestream_customer_identity_reviews_namespace_valid check (
    license_namespace in ('production', 'test')
  ),
  constraint sidestream_customer_identity_reviews_evidence_type_valid check (
    evidence_type in (
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
  constraint sidestream_customer_identity_reviews_evidence_hash_valid check (
    evidence_value_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint sidestream_customer_identity_reviews_trust_valid check (
    evidence_trust in ('client_association', 'verified_server')
  ),
  constraint sidestream_customer_identity_reviews_source_valid check (
    attachment_source in (
      'activation_start',
      'activation_status',
      'activation_claim',
      'license_verify',
      'license_refresh'
    )
  ),
  constraint sidestream_customer_identity_reviews_state_valid check (
    review_state = 'pending_review'
  ),
  constraint sidestream_customer_identity_reviews_conflict_unique unique (
    license_namespace,
    candidate_profile_id,
    existing_profile_id,
    evidence_type,
    evidence_value_hash
  ),
  constraint sidestream_customer_identity_reviews_candidate_namespace_fk
    foreign key (candidate_profile_id, license_namespace)
    references public.sidestream_customer_profiles (id, license_namespace),
  constraint sidestream_customer_identity_reviews_existing_namespace_fk
    foreign key (existing_profile_id, license_namespace)
    references public.sidestream_customer_profiles (id, license_namespace)
);

create index if not exists sidestream_customer_identity_reviews_pending_idx
  on public.sidestream_customer_identity_reviews (
    license_namespace,
    review_state,
    created_at,
    id
  );

create or replace function public.sidestream_customer_identity_reviews_reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Customer identity review audit is immutable'
    using errcode = '55000';
  return null;
end;
$$;

create trigger sidestream_customer_identity_reviews_immutable_guard
before update or delete on public.sidestream_customer_identity_reviews
for each row execute function public.sidestream_customer_identity_reviews_reject_mutation();

comment on table public.sidestream_customer_identity_reviews is
  'Immutable review queue for conflicting deterministic identity evidence; equal candidate/existing profiles represent a rejected second verified account and profiles are never auto-merged.';
comment on column public.sidestream_customer_identity_reviews.evidence_value_hash is
  'SHA-256 of evidence type and value; raw support/account/Stripe evidence is not duplicated into review events.';

alter table public.sidestream_customer_identity_reviews enable row level security;
revoke all on table public.sidestream_customer_identity_reviews from public;
revoke all on function public.sidestream_customer_identity_reviews_reject_mutation() from public;

do $$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = api_role) then
      execute format(
        'revoke all on table public.sidestream_customer_identity_reviews from %I',
        api_role
      );
    end if;
  end loop;
end $$;

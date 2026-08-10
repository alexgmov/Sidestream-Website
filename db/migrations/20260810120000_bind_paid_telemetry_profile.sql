begin;

-- One append-only edge freezes the exact paid claim, canonical acquisition,
-- authenticated account, activation, install membership, and native installer
-- receipt that were verified together. Profile-wide identity combinations are
-- never reconstructed from this table.
create table public.sidestream_paid_telemetry_profile_bindings (
  id uuid primary key default gen_random_uuid(),
  license_namespace text not null,
  claim_id uuid not null,
  checkout_id uuid not null,
  acquisition_id uuid not null,
  account_id uuid not null,
  entitlement_id uuid not null,
  activation_ref uuid not null,
  profile_id_at_binding uuid not null,
  install_membership_id uuid not null,
  install_id_hash text not null,
  install_identity_link_id uuid not null,
  activation_identity_link_id uuid not null,
  account_identity_link_id uuid not null,
  installer_receipt_identity_link_id uuid not null,
  installer_receipt_id_hash text not null,
  binding_key text not null,
  bound_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint sidestream_paid_telemetry_bindings_namespace_valid check (
    license_namespace in ('production', 'test')
  ),
  constraint sidestream_paid_telemetry_bindings_hashes_valid check (
    install_id_hash ~ '^[0-9a-f]{64}$'
    and installer_receipt_id_hash ~ '^[0-9a-f]{64}$'
    and binding_key ~ '^[0-9a-f]{64}$'
  ),
  constraint sidestream_paid_telemetry_bindings_claim_unique unique (claim_id),
  constraint sidestream_paid_telemetry_bindings_activation_unique
    unique (license_namespace, activation_ref),
  constraint sidestream_paid_telemetry_bindings_replay_unique
    unique (license_namespace, binding_key),
  constraint sidestream_paid_telemetry_bindings_claim_fk
    foreign key (claim_id)
    references public.sidestream_paid_acquisition_claims(id)
    on delete restrict,
  constraint sidestream_paid_telemetry_bindings_checkout_fk
    foreign key (checkout_id)
    references public.sidestream_paid_acquisition_checkouts(id)
    on delete restrict,
  constraint sidestream_paid_telemetry_bindings_acquisition_fk
    foreign key (acquisition_id)
    references public.sidestream_acquisitions(id)
    on delete restrict,
  constraint sidestream_paid_telemetry_bindings_account_fk
    foreign key (account_id)
    references public.sidestream_accounts(id)
    on delete restrict,
  constraint sidestream_paid_telemetry_bindings_entitlement_fk
    foreign key (entitlement_id)
    references public.sidestream_licenses(id)
    on delete restrict,
  constraint sidestream_paid_telemetry_bindings_activation_fk
    foreign key (activation_ref)
    references public.sidestream_activation_sessions(id)
    on delete restrict,
  constraint sidestream_paid_telemetry_bindings_profile_namespace_fk
    foreign key (profile_id_at_binding, license_namespace)
    references public.sidestream_customer_profiles(id, license_namespace)
    on delete restrict,
  constraint sidestream_paid_telemetry_bindings_install_fk
    foreign key (install_membership_id)
    references public.sidestream_customer_installs(id)
    on delete restrict,
  constraint sidestream_paid_telemetry_bindings_install_link_fk
    foreign key (install_identity_link_id)
    references public.sidestream_customer_identity_links(id)
    on delete restrict,
  constraint sidestream_paid_telemetry_bindings_activation_link_fk
    foreign key (activation_identity_link_id)
    references public.sidestream_customer_identity_links(id)
    on delete restrict,
  constraint sidestream_paid_telemetry_bindings_account_link_fk
    foreign key (account_identity_link_id)
    references public.sidestream_customer_identity_links(id)
    on delete restrict,
  constraint sidestream_paid_telemetry_bindings_receipt_link_fk
    foreign key (installer_receipt_identity_link_id)
    references public.sidestream_customer_identity_links(id)
    on delete restrict
);

create index sidestream_paid_telemetry_bindings_profile_idx
  on public.sidestream_paid_telemetry_profile_bindings
    (license_namespace, profile_id_at_binding, bound_at, id);

-- Foreign keys freeze row identities. This insert guard additionally proves
-- their exact values, namespace, ownership, paid Checkout, active entitlement,
-- account, and activation all agreed at the moment the edge was committed.
create or replace function public.sidestream_paid_telemetry_binding_validate()
returns trigger
language plpgsql
as $$
declare
  evidence_found boolean;
begin
  select true
  into evidence_found
  from public.sidestream_paid_acquisition_claims claim
  join public.sidestream_paid_acquisition_checkouts paid
    on paid.id = claim.checkout_id
    and paid.environment = claim.environment
  join public.sidestream_checkout_intents core
    on core.id = paid.checkout_intent_ref
  join public.sidestream_acquisitions acquisition
    on acquisition.id = core.acquisition_id
    and acquisition.license_namespace = claim.environment
  join public.sidestream_accounts account
    on account.id = claim.account_ref
  join public.sidestream_licenses entitlement
    on entitlement.id = claim.entitlement_ref
    and entitlement.account_id = claim.account_ref
  join public.sidestream_activation_sessions activation
    on activation.id = claim.activation_ref
    and activation.account_id = claim.account_ref
    and activation.license_id = claim.entitlement_ref
  join public.sidestream_customer_profiles profile
    on profile.id = new.profile_id_at_binding
    and profile.license_namespace = new.license_namespace
    and profile.merged_into is null
  join public.sidestream_customer_installs install
    on install.id = new.install_membership_id
    and install.profile_id = profile.id
    and install.license_namespace = profile.license_namespace
    and install.install_id_hash = new.install_id_hash
  join public.sidestream_customer_identity_links install_link
    on install_link.id = new.install_identity_link_id
    and install_link.profile_id = profile.id
    and install_link.license_namespace = profile.license_namespace
    and install_link.link_type = 'install_identity_hash'
    and install_link.link_value = new.install_id_hash
  join public.sidestream_customer_identity_links activation_link
    on activation_link.id = new.activation_identity_link_id
    and activation_link.profile_id = profile.id
    and activation_link.license_namespace = profile.license_namespace
    and activation_link.link_type = 'activation_record'
    and activation_link.link_value = new.activation_ref::text
  join public.sidestream_customer_identity_links account_link
    on account_link.id = new.account_identity_link_id
    and account_link.profile_id = profile.id
    and account_link.license_namespace = profile.license_namespace
    and account_link.link_type = 'account_identity'
    and account_link.link_value = new.account_id::text
  join public.sidestream_customer_identity_links receipt_link
    on receipt_link.id = new.installer_receipt_identity_link_id
    and receipt_link.profile_id = profile.id
    and receipt_link.license_namespace = profile.license_namespace
    and receipt_link.link_type = 'installer_receipt_hash'
    and receipt_link.link_value = new.installer_receipt_id_hash
  where claim.id = new.claim_id
    and claim.checkout_id = new.checkout_id
    and claim.environment = new.license_namespace
    and claim.account_ref = new.account_id
    and claim.entitlement_ref = new.entitlement_id
    and claim.activation_ref = new.activation_ref
    and claim.claim_state = 'claimed'
    and claim.expires_at > new.bound_at
    and paid.id = new.checkout_id
    and paid.payment_state = 'active'
    and paid.claim_state = 'claimed'
    and paid.completed_at is not null
    and paid.receipt_expires_at > new.bound_at
    and paid.verified_checkout_session_ref is not null
    and paid.canonical_payment_ref is not null
    and paid.canonical_payment_ref = claim.canonical_payment_ref
    and paid.verified_product_ref is not null
    and paid.verified_price_ref is not null
    and paid.verified_quantity = 1
    and paid.verified_amount_minor is not null
    and paid.verified_currency is not null
    and acquisition.id = new.acquisition_id
    and acquisition.integrity_state = 'intact'
    and account.id = new.account_id
    and entitlement.id = new.entitlement_id
    and entitlement.entitlement_status = 'active'
    and activation.id = new.activation_ref
    and activation.source = 'paid-acquisition-mc-v1'
    and activation.completed_at is not null
    and activation.expires_at > new.bound_at;

  if evidence_found is distinct from true then
    raise exception 'Exact paid telemetry binding evidence is missing or contradictory'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger sidestream_paid_telemetry_bindings_validate
before insert on public.sidestream_paid_telemetry_profile_bindings
for each row execute function public.sidestream_paid_telemetry_binding_validate();

create or replace function public.sidestream_paid_telemetry_binding_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Exact paid telemetry binding is immutable'
    using errcode = '55000';
  return null;
end;
$$;

create trigger sidestream_paid_telemetry_bindings_immutable
before update or delete on public.sidestream_paid_telemetry_profile_bindings
for each row execute function public.sidestream_paid_telemetry_binding_immutable();

comment on table public.sidestream_paid_telemetry_profile_bindings is
  'Immutable exact paid claim/acquisition/account/activation/install/receipt edge; profile-wide identity pairing is forbidden.';
comment on column public.sidestream_paid_telemetry_profile_bindings.binding_key is
  'Lowercase SHA-256 replay key derived from the exact namespace-bound server tuple.';

alter table public.sidestream_paid_telemetry_profile_bindings enable row level security;
revoke all on table public.sidestream_paid_telemetry_profile_bindings from public;
revoke all on function public.sidestream_paid_telemetry_binding_validate() from public;
revoke all on function public.sidestream_paid_telemetry_binding_immutable() from public;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if to_regrole(role_name) is not null then
      execute format(
        'revoke all on table public.sidestream_paid_telemetry_profile_bindings from %I',
        role_name
      );
    end if;
  end loop;
end $$;

commit;

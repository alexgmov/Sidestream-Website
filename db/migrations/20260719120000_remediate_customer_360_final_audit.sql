begin;

-- A database must be explicitly provisioned with exactly one immutable identity
-- before Test-only recovery may run. The migration intentionally does not guess
-- or seed an environment from a connection string.
create table public.sidestream_database_identity (
  singleton boolean primary key default true check (singleton),
  environment text not null check (environment in ('production', 'test')),
  instance_id uuid not null unique,
  provider_resource_id text not null unique,
  created_at timestamptz not null default clock_timestamp(),
  constraint sidestream_database_identity_resource_check
    check (provider_resource_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,239}$')
);

create function public.sidestream_reject_immutable_control_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception using errcode = '55000', message = 'immutable control evidence';
end;
$$;

create trigger sidestream_database_identity_immutable
before update or delete on public.sidestream_database_identity
for each row execute function public.sidestream_reject_immutable_control_mutation();

create trigger sidestream_database_identity_no_truncate
before truncate on public.sidestream_database_identity
for each statement execute function public.sidestream_reject_immutable_control_mutation();

create trigger sidestream_customer_profile_merges_no_truncate
before truncate on public.sidestream_customer_profile_merges
for each statement execute function public.sidestream_customer_profile_merges_reject_mutation();

create trigger sidestream_customer_identity_reviews_no_truncate
before truncate on public.sidestream_customer_identity_reviews
for each statement execute function public.sidestream_customer_identity_reviews_reject_mutation();

alter function public.sidestream_customer_profile_merges_reject_mutation()
  set search_path = pg_catalog;
alter function public.sidestream_customer_identity_reviews_reject_mutation()
  set search_path = pg_catalog;

alter table public.sidestream_stripe_events
  add column ingress_event_id text,
  add column ingress_event_type text,
  add column ingress_created bigint,
  add column ingress_livemode boolean,
  add column ingress_api_version text,
  add column ingress_payload_sha256 text,
  add column ingress_raw_sha256 text,
  add column recovery_runner_token uuid,
  add column recovery_runner_lease_expires_at timestamptz,
  add column recovery_runner_epoch integer not null default 0;

alter table public.sidestream_stripe_events
  add constraint sidestream_stripe_events_ingress_payload_digest_check
    check (ingress_payload_sha256 is null or ingress_payload_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint sidestream_stripe_events_ingress_raw_digest_check
    check (ingress_raw_sha256 is null or ingress_raw_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint sidestream_stripe_events_ingress_created_check
    check (ingress_created is null or ingress_created >= 0),
  add constraint sidestream_stripe_events_recovery_runner_check
    check (
      (recovery_runner_token is null and recovery_runner_lease_expires_at is null)
      or (
        pending_recovery_audit_id is not null
        and recovery_runner_token is not null
        and recovery_runner_lease_expires_at is not null
        and recovery_runner_epoch > 0
      )
    );

create function public.sidestream_stripe_event_ingress_reject_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  expected_redacted_payload jsonb;
begin
  if new.event_id is distinct from old.event_id
    or new.event_type is distinct from old.event_type
    or new.stripe_created_at is distinct from old.stripe_created_at
    or new.ingress_event_id is distinct from old.ingress_event_id
    or new.ingress_event_type is distinct from old.ingress_event_type
    or new.ingress_created is distinct from old.ingress_created
    or new.ingress_livemode is distinct from old.ingress_livemode
    or new.ingress_api_version is distinct from old.ingress_api_version
    or new.ingress_payload_sha256 is distinct from old.ingress_payload_sha256
    or new.ingress_raw_sha256 is distinct from old.ingress_raw_sha256
  then
    raise exception using errcode = '55000', message = 'Stripe ingress evidence is immutable';
  end if;

  if new.payload is not distinct from old.payload
    and new.raw_payload is not distinct from old.raw_payload
    and new.payload_redacted_at is not distinct from old.payload_redacted_at
  then
    return new;
  end if;

  expected_redacted_payload := jsonb_strip_nulls(jsonb_build_object(
    'redacted', true,
    'id', old.event_id,
    'object', 'event',
    'type', old.event_type,
    'created', extract(epoch from old.stripe_created_at)::bigint,
    'livemode', old.payload -> 'livemode',
    'data', jsonb_build_object(
      'object', jsonb_strip_nulls(jsonb_build_object(
        'id', old.payload #> '{data,object,id}',
        'object', old.payload #> '{data,object,object}',
        'customer', case
          when jsonb_typeof(old.payload #> '{data,object,customer}') = 'string'
            then old.payload #> '{data,object,customer}'
          else old.payload #> '{data,object,customer,id}'
        end,
        'payment_intent', case
          when jsonb_typeof(old.payload #> '{data,object,payment_intent}') = 'string'
            then old.payload #> '{data,object,payment_intent}'
          else old.payload #> '{data,object,payment_intent,id}'
        end,
        'charge', case
          when jsonb_typeof(old.payload #> '{data,object,charge}') = 'string'
            then old.payload #> '{data,object,charge}'
          else old.payload #> '{data,object,charge,id}'
        end,
        'subscription', case
          when jsonb_typeof(old.payload #> '{data,object,subscription}') = 'string'
            then old.payload #> '{data,object,subscription}'
          else old.payload #> '{data,object,subscription,id}'
        end,
        'invoice', case
          when jsonb_typeof(old.payload #> '{data,object,invoice}') = 'string'
            then old.payload #> '{data,object,invoice}'
          else old.payload #> '{data,object,invoice,id}'
        end,
        'amount', old.payload #> '{data,object,amount}',
        'amount_paid', old.payload #> '{data,object,amount_paid}',
        'amount_refunded', old.payload #> '{data,object,amount_refunded}',
        'currency', old.payload #> '{data,object,currency}',
        'payment_status', old.payload #> '{data,object,payment_status}',
        'status', old.payload #> '{data,object,status}',
        'disputed', old.payload #> '{data,object,disputed}'
      ))
    )
  ));

  if old.payload_redacted_at is null
    and new.payload_redacted_at is not null
    and new.raw_payload is null
    and new.payload = expected_redacted_payload
  then
    return new;
  end if;

  raise exception using errcode = '55000', message = 'Stripe ingress evidence is immutable';
end;
$$;

create trigger sidestream_stripe_event_ingress_immutable
before update of event_id, event_type, stripe_created_at, payload, raw_payload,
  ingress_event_id, ingress_event_type, ingress_created, ingress_livemode,
  ingress_api_version, ingress_payload_sha256, ingress_raw_sha256
on public.sidestream_stripe_events
for each row execute function public.sidestream_stripe_event_ingress_reject_mutation();

alter table public.sidestream_stripe_event_recovery_audit
  add column database_instance_id uuid;

create function public.sidestream_schema_migrations_reject_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception using errcode = '55000', message = 'Migration ledger is append-only';
end;
$$;

create trigger sidestream_schema_migrations_immutable
before update or delete on public.sidestream_schema_migrations
for each row execute function public.sidestream_schema_migrations_reject_mutation();

create trigger sidestream_schema_migrations_no_truncate
before truncate on public.sidestream_schema_migrations
for each statement execute function public.sidestream_schema_migrations_reject_mutation();

create table public.sidestream_migration_attestations (
  filename text primary key references public.sidestream_schema_migrations(filename),
  target_fingerprint text not null check (target_fingerprint ~ '^[0-9a-f]{64}$'),
  migration_set_fingerprint text not null
    check (migration_set_fingerprint ~ '^[0-9a-f]{64}$'),
  attested_at timestamptz not null default clock_timestamp()
);

create trigger sidestream_migration_attestations_immutable
before update or delete on public.sidestream_migration_attestations
for each row execute function public.sidestream_schema_migrations_reject_mutation();

create trigger sidestream_migration_attestations_no_truncate
before truncate on public.sidestream_migration_attestations
for each statement execute function public.sidestream_schema_migrations_reject_mutation();

alter table public.sidestream_database_identity enable row level security;
alter table public.sidestream_migration_attestations enable row level security;
revoke all privileges on table public.sidestream_database_identity from public;
revoke all privileges on table public.sidestream_migration_attestations from public;
revoke all on function public.sidestream_reject_immutable_control_mutation() from public;
revoke all on function public.sidestream_stripe_event_ingress_reject_mutation() from public;
revoke all on function public.sidestream_schema_migrations_reject_mutation() from public;

do $$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated'] loop
    if to_regrole(api_role) is not null then
      execute format(
        'revoke all privileges on table public.sidestream_database_identity from %I',
        api_role
      );
      execute format(
        'revoke all privileges on table public.sidestream_migration_attestations from %I',
        api_role
      );
    end if;
  end loop;
end $$;

commit;

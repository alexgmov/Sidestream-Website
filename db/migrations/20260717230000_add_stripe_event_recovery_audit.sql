begin;

create table public.sidestream_stripe_event_recovery_audit (
  id uuid primary key,
  request_digest text not null unique,
  event_reference_digest text not null,
  event_type text not null,
  payload_digest text not null,
  target_fingerprint text not null,
  license_namespace text not null,
  reviewed_reason_code text not null,
  prior_processing_status text not null,
  prior_attempt_count integer not null,
  prior_terminal_at timestamptz not null,
  prior_last_error_code text,
  prior_outcome_code text,
  created_at timestamptz not null default clock_timestamp(),
  constraint sidestream_stripe_event_recovery_request_digest_check
    check (request_digest ~ '^[0-9a-f]{64}$'),
  constraint sidestream_stripe_event_recovery_event_reference_check
    check (event_reference_digest ~ '^[0-9a-f]{64}$'),
  constraint sidestream_stripe_event_recovery_payload_digest_check
    check (payload_digest ~ '^[0-9a-f]{64}$'),
  constraint sidestream_stripe_event_recovery_target_fingerprint_check
    check (target_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint sidestream_stripe_event_recovery_namespace_check
    check (license_namespace = 'test'),
  constraint sidestream_stripe_event_recovery_reason_check
    check (reviewed_reason_code in (
      'handler_fix_verified',
      'canonical_state_repair',
      'test_rehearsal'
    )),
  constraint sidestream_stripe_event_recovery_prior_state_check
    check (prior_processing_status = 'dead_letter'),
  constraint sidestream_stripe_event_recovery_prior_attempt_check
    check (prior_attempt_count = 8),
  constraint sidestream_stripe_event_recovery_event_type_check
    check (char_length(event_type) between 1 and 160),
  constraint sidestream_stripe_event_recovery_error_code_check
    check (
      prior_last_error_code is null
      or prior_last_error_code ~ '^[a-z0-9_]{1,120}$'
    ),
  constraint sidestream_stripe_event_recovery_outcome_code_check
    check (
      prior_outcome_code is null
      or prior_outcome_code ~ '^[a-z0-9_]{1,160}$'
    )
);

comment on table public.sidestream_stripe_event_recovery_audit is
  'Immutable Test-only authorization evidence for one exact bounded dead-letter recovery. It stores digests and safe codes, never raw Stripe payloads or customer/provider identifiers.';

alter table public.sidestream_stripe_events
  add column pending_recovery_audit_id uuid;

alter table public.sidestream_stripe_events
  add constraint sidestream_stripe_events_pending_recovery_audit_fk
  foreign key (pending_recovery_audit_id)
  references public.sidestream_stripe_event_recovery_audit(id)
  on delete restrict;

alter table public.sidestream_stripe_events
  add constraint sidestream_stripe_events_pending_recovery_attempt_check
  check (
    pending_recovery_audit_id is null
    or (
      attempt_count = 9
      and processing_status in ('processing', 'processed', 'ignored', 'dead_letter')
    )
  );

create unique index sidestream_stripe_events_pending_recovery_audit_unique
  on public.sidestream_stripe_events (pending_recovery_audit_id)
  where pending_recovery_audit_id is not null;

create index sidestream_stripe_event_recovery_created_idx
  on public.sidestream_stripe_event_recovery_audit (created_at, id);

create function public.sidestream_prevent_stripe_event_recovery_audit_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'sidestream_stripe_event_recovery_audit is immutable';
end;
$$;

create trigger sidestream_stripe_event_recovery_audit_immutable
before update or delete on public.sidestream_stripe_event_recovery_audit
for each row execute function public.sidestream_prevent_stripe_event_recovery_audit_mutation();

create trigger sidestream_stripe_event_recovery_audit_no_truncate
before truncate on public.sidestream_stripe_event_recovery_audit
for each statement execute function public.sidestream_prevent_stripe_event_recovery_audit_mutation();

alter table public.sidestream_stripe_event_recovery_audit enable row level security;
revoke all privileges on table public.sidestream_stripe_event_recovery_audit from public;
revoke all on function public.sidestream_prevent_stripe_event_recovery_audit_mutation()
  from public;

do $$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated'] loop
    if to_regrole(api_role) is not null then
      execute format(
        'revoke all privileges on table public.sidestream_stripe_event_recovery_audit from %I',
        api_role
      );
      execute format(
        'revoke all on function public.sidestream_prevent_stripe_event_recovery_audit_mutation() from %I',
        api_role
      );
    end if;
  end loop;
end $$;

commit;

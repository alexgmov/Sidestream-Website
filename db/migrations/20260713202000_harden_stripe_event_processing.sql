alter table public.sidestream_stripe_events
  add column if not exists processing_status text,
  add column if not exists attempt_count integer,
  add column if not exists claim_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists last_error_code text,
  add column if not exists outcome text,
  add column if not exists processing_started_at timestamptz,
  add column if not exists processing_duration_ms integer,
  add column if not exists terminal_at timestamptz;

update public.sidestream_stripe_events
set processing_status = case
      when processed_at is null then 'received'
      else 'processed'
    end,
    attempt_count = case
      when processed_at is null then 0
      else 1
    end,
    next_attempt_at = coalesce(next_attempt_at, received_at, created_at, now()),
    outcome = case
      when processed_at is null then outcome
      else coalesce(outcome, 'legacy_processed')
    end,
    terminal_at = case
      when processed_at is null then null
      else coalesce(terminal_at, processed_at)
    end,
    stripe_created_at = coalesce(stripe_created_at, to_timestamp(0))
where processing_status is null
   or attempt_count is null
   or next_attempt_at is null
   or stripe_created_at is null;

alter table public.sidestream_stripe_events
  alter column stripe_created_at set not null,
  alter column processing_status set default 'received',
  alter column processing_status set not null,
  alter column attempt_count set default 0,
  alter column attempt_count set not null,
  alter column next_attempt_at set default now(),
  alter column next_attempt_at set not null;

do $$
begin
  alter table public.sidestream_stripe_events
    add constraint sidestream_stripe_events_processing_status_check
    check (processing_status in (
      'received',
      'processing',
      'retryable',
      'processed',
      'ignored',
      'dead_letter'
    ));
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.sidestream_stripe_events
    add constraint sidestream_stripe_events_attempt_count_check
    check (attempt_count >= 0);
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.sidestream_stripe_events
    add constraint sidestream_stripe_events_processing_duration_check
    check (processing_duration_ms is null or processing_duration_ms >= 0);
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.sidestream_stripe_events
    add constraint sidestream_stripe_events_error_code_check
    check (last_error_code is null or char_length(last_error_code) between 1 and 120);
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.sidestream_stripe_events
    add constraint sidestream_stripe_events_outcome_check
    check (outcome is null or char_length(outcome) between 1 and 160);
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.sidestream_stripe_events
    add constraint sidestream_stripe_events_lease_state_check
    check (
      (
        processing_status = 'processing'
        and claim_token is not null
        and lease_expires_at is not null
        and terminal_at is null
      )
      or (
        processing_status in ('received', 'retryable')
        and claim_token is null
        and lease_expires_at is null
        and terminal_at is null
      )
      or (
        processing_status in ('processed', 'ignored', 'dead_letter')
        and claim_token is null
        and lease_expires_at is null
        and terminal_at is not null
      )
    );
exception
  when duplicate_object then null;
end $$;

create index if not exists sidestream_stripe_events_pending_idx
  on public.sidestream_stripe_events (
    (
      case
        when processing_status = 'processing' then lease_expires_at
        else next_attempt_at
      end
    ),
    stripe_created_at,
    event_id
  )
  where terminal_at is null
    and processing_status in ('received', 'retryable', 'processing');

alter table public.sidestream_licenses
  add column if not exists stripe_state_event_created_at timestamptz,
  add column if not exists stripe_state_event_id text;

do $$
begin
  alter table public.sidestream_licenses
    add constraint sidestream_licenses_stripe_state_event_pair_check
    check (
      (stripe_state_event_created_at is null and stripe_state_event_id is null)
      or (stripe_state_event_created_at is not null and stripe_state_event_id is not null)
    );
exception
  when duplicate_object then null;
end $$;

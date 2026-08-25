create table public.sidestream_support_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.sidestream_support_threads(id) on delete restrict,
  message_id uuid not null references public.sidestream_support_messages(id) on delete restrict,
  job_type text not null default 'triage',
  state text not null default 'pending',
  attempt_count integer not null default 0,
  cycle_attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  available_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  lease_token uuid,
  last_error_code text,
  completed_at timestamptz,
  dead_letter_at timestamptz,
  recovery_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sidestream_support_processing_jobs_message_unique unique (message_id, job_type),
  constraint sidestream_support_processing_jobs_type_valid check (job_type = 'triage'),
  constraint sidestream_support_processing_jobs_state_valid check (
    state in ('pending', 'processing', 'retry', 'completed', 'dead_letter')
  ),
  constraint sidestream_support_processing_jobs_attempts_valid check (
    attempt_count >= 0
    and cycle_attempt_count >= 0
    and cycle_attempt_count <= attempt_count
    and max_attempts between 1 and 10
    and recovery_count between 0 and 3
  ),
  constraint sidestream_support_processing_jobs_error_valid check (
    last_error_code is null or last_error_code ~ '^[a-z0-9_:-]{1,100}$'
  ),
  constraint sidestream_support_processing_jobs_lease_valid check (
    (state = 'processing' and lease_expires_at is not null and lease_token is not null)
    or (state <> 'processing' and lease_expires_at is null and lease_token is null)
  ),
  constraint sidestream_support_processing_jobs_terminal_valid check (
    (state = 'completed' and completed_at is not null and dead_letter_at is null)
    or (state = 'dead_letter' and dead_letter_at is not null and completed_at is null)
    or (state not in ('completed', 'dead_letter') and completed_at is null and dead_letter_at is null)
  )
);

create index sidestream_support_processing_jobs_due_idx
  on public.sidestream_support_processing_jobs (state, available_at, created_at)
  where state in ('pending', 'retry', 'processing');

create index sidestream_support_processing_jobs_dead_letter_idx
  on public.sidestream_support_processing_jobs (dead_letter_at, created_at)
  where state = 'dead_letter';

create table public.sidestream_support_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.sidestream_support_threads(id) on delete restrict,
  action_request_id uuid references public.sidestream_support_action_requests(id) on delete restrict,
  idempotency_key text not null,
  gate text not null,
  reference_id uuid not null,
  outcome text not null,
  risk_codes text[] not null default '{}',
  state text not null default 'pending',
  attempt_count integer not null default 0,
  cycle_attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  available_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  lease_token uuid,
  last_error_code text,
  delivered_at timestamptz,
  dead_letter_at timestamptz,
  recovery_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sidestream_support_notification_outbox_idempotency_unique unique (idempotency_key),
  constraint sidestream_support_notification_outbox_idempotency_valid check (
    idempotency_key ~ '^[0-9a-f]{64}$'
  ),
  constraint sidestream_support_notification_outbox_gate_valid check (
    gate in ('triage', 'safety_audit')
  ),
  constraint sidestream_support_notification_outbox_outcome_valid check (
    outcome in ('flag', 'error')
  ),
  constraint sidestream_support_notification_outbox_state_valid check (
    state in ('pending', 'processing', 'retry', 'delivered', 'dead_letter')
  ),
  constraint sidestream_support_notification_outbox_attempts_valid check (
    attempt_count >= 0
    and cycle_attempt_count >= 0
    and cycle_attempt_count <= attempt_count
    and max_attempts between 1 and 10
    and recovery_count between 0 and 3
  ),
  constraint sidestream_support_notification_outbox_risk_codes_valid check (
    cardinality(risk_codes) between 1 and 20
  ),
  constraint sidestream_support_notification_outbox_error_valid check (
    last_error_code is null or last_error_code ~ '^[a-z0-9_:-]{1,100}$'
  ),
  constraint sidestream_support_notification_outbox_lease_valid check (
    (state = 'processing' and lease_expires_at is not null and lease_token is not null)
    or (state <> 'processing' and lease_expires_at is null and lease_token is null)
  ),
  constraint sidestream_support_notification_outbox_terminal_valid check (
    (state = 'delivered' and delivered_at is not null and dead_letter_at is null)
    or (state = 'dead_letter' and dead_letter_at is not null and delivered_at is null)
    or (state not in ('delivered', 'dead_letter') and delivered_at is null and dead_letter_at is null)
  )
);

create index sidestream_support_notification_outbox_due_idx
  on public.sidestream_support_notification_outbox (state, available_at, created_at)
  where state in ('pending', 'retry', 'processing');

create index sidestream_support_notification_outbox_dead_letter_idx
  on public.sidestream_support_notification_outbox (dead_letter_at, created_at)
  where state = 'dead_letter';

create table public.sidestream_support_notification_attempts (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references public.sidestream_support_notification_outbox(id) on delete restrict,
  attempt_number integer not null,
  outcome text not null,
  error_code text,
  created_at timestamptz not null default now(),
  constraint sidestream_support_notification_attempts_unique unique (outbox_id, attempt_number),
  constraint sidestream_support_notification_attempts_number_valid check (attempt_number >= 1),
  constraint sidestream_support_notification_attempts_outcome_valid check (
    outcome in ('delivered', 'retry', 'dead_letter')
  ),
  constraint sidestream_support_notification_attempts_error_valid check (
    error_code is null or error_code ~ '^[a-z0-9_:-]{1,100}$'
  )
);

create index sidestream_support_notification_attempts_outbox_created_idx
  on public.sidestream_support_notification_attempts (outbox_id, created_at);

create trigger sidestream_support_notification_attempts_immutable
before update or delete on public.sidestream_support_notification_attempts
for each row execute function public.sidestream_prevent_support_evidence_mutation();

alter table public.sidestream_support_processing_jobs enable row level security;
alter table public.sidestream_support_notification_outbox enable row level security;
alter table public.sidestream_support_notification_attempts enable row level security;

revoke all on table public.sidestream_support_processing_jobs from public;
revoke all on table public.sidestream_support_notification_outbox from public;
revoke all on table public.sidestream_support_notification_attempts from public;

do $$
declare
  table_name text;
  api_role text;
  table_names text[] := array[
    'sidestream_support_processing_jobs',
    'sidestream_support_notification_outbox',
    'sidestream_support_notification_attempts'
  ];
  api_roles text[] := array['anon', 'authenticated'];
begin
  foreach table_name in array table_names loop
    foreach api_role in array api_roles loop
      if exists (select 1 from pg_roles where rolname = api_role) then
        execute format('revoke all on table public.%I from %I', table_name, api_role);
      end if;
    end loop;
  end loop;
end $$;

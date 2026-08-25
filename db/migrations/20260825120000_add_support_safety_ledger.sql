create table public.sidestream_support_threads (
  id uuid primary key default gen_random_uuid(),
  requester_email_hash text not null,
  requester_email_ciphertext text not null,
  subject_ciphertext text not null,
  status text not null default 'received',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sidestream_support_threads_email_hash_valid check (
    requester_email_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint sidestream_support_threads_status_valid check (
    status in (
      'received',
      'triage_passed',
      'triage_flagged',
      'audit_pending',
      'audit_passed',
      'audit_flagged',
      'human_review',
      'closed'
    )
  )
);

create index sidestream_support_threads_status_created_idx
  on public.sidestream_support_threads (status, created_at);

create table public.sidestream_support_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.sidestream_support_threads(id) on delete restrict,
  provider_event_id text not null,
  provider_message_id text not null,
  direction text not null,
  body_ciphertext text not null,
  attachment_count integer not null default 0,
  created_at timestamptz not null default now(),
  constraint sidestream_support_messages_direction_valid check (
    direction in ('inbound', 'outbound')
  ),
  constraint sidestream_support_messages_attachment_count_valid check (
    attachment_count between 0 and 100
  ),
  constraint sidestream_support_messages_provider_event_unique unique (provider_event_id),
  constraint sidestream_support_messages_provider_message_unique unique (provider_message_id)
);

create index sidestream_support_messages_thread_created_idx
  on public.sidestream_support_messages (thread_id, created_at);

create table public.sidestream_support_action_requests (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.sidestream_support_threads(id) on delete restrict,
  source_message_id uuid not null references public.sidestream_support_messages(id) on delete restrict,
  action_type text not null,
  status text not null,
  candidate jsonb not null,
  requires_human boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sidestream_support_action_requests_type_valid check (
    action_type in ('none', 'code_change_request', 'database_transaction_request')
  ),
  constraint sidestream_support_action_requests_status_valid check (
    status in (
      'proposed',
      'triage_flagged',
      'audit_pending',
      'audit_passed',
      'audit_flagged',
      'human_approved',
      'rejected',
      'executed',
      'failed'
    )
  ),
  constraint sidestream_support_action_requests_message_unique unique (source_message_id)
);

create index sidestream_support_action_requests_status_created_idx
  on public.sidestream_support_action_requests (status, created_at);

create table public.sidestream_support_gate_runs (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.sidestream_support_threads(id) on delete restrict,
  source_message_id uuid references public.sidestream_support_messages(id) on delete restrict,
  action_request_id uuid references public.sidestream_support_action_requests(id) on delete restrict,
  stage text not null,
  verdict text not null,
  input_fingerprint text not null,
  risk_codes text[] not null default '{}',
  result jsonb not null,
  model text not null,
  created_at timestamptz not null default now(),
  constraint sidestream_support_gate_runs_stage_valid check (
    stage in ('triage', 'safety_audit')
  ),
  constraint sidestream_support_gate_runs_verdict_valid check (
    verdict in ('pass', 'flag', 'error')
  ),
  constraint sidestream_support_gate_runs_fingerprint_valid check (
    input_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint sidestream_support_gate_runs_subject_valid check (
    (
      stage = 'triage'
      and source_message_id is not null
      and action_request_id is null
    )
    or (
      stage = 'safety_audit'
      and source_message_id is null
      and action_request_id is not null
    )
  )
);

create unique index sidestream_support_gate_runs_triage_unique
  on public.sidestream_support_gate_runs (source_message_id, stage)
  where source_message_id is not null;

create unique index sidestream_support_gate_runs_audit_unique
  on public.sidestream_support_gate_runs (action_request_id, stage)
  where action_request_id is not null;

create table public.sidestream_support_audit_events (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.sidestream_support_threads(id) on delete restrict,
  action_request_id uuid references public.sidestream_support_action_requests(id) on delete restrict,
  event_type text not null,
  idempotency_key text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now(),
  constraint sidestream_support_audit_events_idempotency_valid check (
    idempotency_key ~ '^[A-Za-z0-9:_-]{1,180}$'
  ),
  constraint sidestream_support_audit_events_idempotency_unique unique (idempotency_key)
);

create index sidestream_support_audit_events_thread_created_idx
  on public.sidestream_support_audit_events (thread_id, created_at);

create or replace function public.sidestream_prevent_support_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'sidestream support safety evidence is append-only';
end;
$$;

create trigger sidestream_support_messages_immutable
before update or delete on public.sidestream_support_messages
for each row execute function public.sidestream_prevent_support_evidence_mutation();

create trigger sidestream_support_gate_runs_immutable
before update or delete on public.sidestream_support_gate_runs
for each row execute function public.sidestream_prevent_support_evidence_mutation();

create trigger sidestream_support_audit_events_immutable
before update or delete on public.sidestream_support_audit_events
for each row execute function public.sidestream_prevent_support_evidence_mutation();

alter table public.sidestream_support_threads enable row level security;
alter table public.sidestream_support_messages enable row level security;
alter table public.sidestream_support_action_requests enable row level security;
alter table public.sidestream_support_gate_runs enable row level security;
alter table public.sidestream_support_audit_events enable row level security;

revoke all on table public.sidestream_support_threads from public;
revoke all on table public.sidestream_support_messages from public;
revoke all on table public.sidestream_support_action_requests from public;
revoke all on table public.sidestream_support_gate_runs from public;
revoke all on table public.sidestream_support_audit_events from public;

do $$
declare
  table_name text;
  api_role text;
  table_names text[] := array[
    'sidestream_support_threads',
    'sidestream_support_messages',
    'sidestream_support_action_requests',
    'sidestream_support_gate_runs',
    'sidestream_support_audit_events'
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

-- Desired-state cutover: add an edge/WAF limit for POST /api/download-lead before
-- rollout. The database limiter is atomic but cannot protect Blob fallback while
-- Postgres is unavailable. This migration intentionally does not mutate Vercel Firewall.

lock table public.sidestream_download_leads in access exclusive mode;

alter table public.sidestream_download_leads
  add column if not exists first_captured_at timestamptz,
  add column if not exists last_captured_at timestamptz,
  add column if not exists submission_count bigint not null default 1,
  add column if not exists utm_source text,
  add column if not exists utm_medium text,
  add column if not exists utm_campaign text,
  add column if not exists utm_content text;

update public.sidestream_download_leads
set
  email = lower(btrim(email)),
  cta_source = case
    when lower(btrim(coalesce(cta_source, ''))) ~ '^[a-z0-9][a-z0-9._:/-]{0,99}$'
      then lower(btrim(cta_source))
    else 'download-email-gate'
  end,
  source_page = nullif(left(btrim(source_page), 240), ''),
  referrer = nullif(left(btrim(referrer), 500), ''),
  first_captured_at = coalesce(first_captured_at, captured_at),
  last_captured_at = coalesce(last_captured_at, captured_at),
  submission_count = greatest(submission_count, 1),
  utm_source = case
    when lower(btrim(coalesce(utm_source, ''))) ~ '^[a-z0-9][a-z0-9._~-]{0,99}$'
      then lower(btrim(utm_source))
    else null
  end,
  utm_medium = case
    when lower(btrim(coalesce(utm_medium, ''))) ~ '^[a-z0-9][a-z0-9._~-]{0,99}$'
      then lower(btrim(utm_medium))
    else null
  end,
  utm_campaign = case
    when lower(btrim(coalesce(utm_campaign, ''))) ~ '^[a-z0-9][a-z0-9._~-]{0,99}$'
      then lower(btrim(utm_campaign))
    else null
  end,
  utm_content = case
    when lower(btrim(coalesce(utm_content, ''))) ~ '^[a-z0-9][a-z0-9._~-]{0,99}$'
      then lower(btrim(utm_content))
    else null
  end;

create temporary table sidestream_download_lead_dedupe on commit drop as
select
  id,
  first_value(id) over canonical_lead as winner_id,
  min(first_captured_at) over canonical_lead as merged_first_captured_at,
  max(last_captured_at) over canonical_lead as merged_last_captured_at,
  sum(submission_count) over canonical_lead as merged_submission_count
from public.sidestream_download_leads
window canonical_lead as (
  partition by email, cta_source
  order by
    last_captured_at desc,
    captured_at desc,
    created_at desc,
    id desc
  rows between unbounded preceding and unbounded following
);

update public.sidestream_download_leads as lead
set
  captured_at = merged.merged_first_captured_at,
  first_captured_at = merged.merged_first_captured_at,
  last_captured_at = merged.merged_last_captured_at,
  submission_count = merged.merged_submission_count,
  updated_at = now()
from (
  select distinct on (winner_id)
    winner_id,
    merged_first_captured_at,
    merged_last_captured_at,
    merged_submission_count
  from sidestream_download_lead_dedupe
  order by winner_id
) as merged
where lead.id = merged.winner_id;

delete from public.sidestream_download_leads as duplicate
using sidestream_download_lead_dedupe as mapping
where duplicate.id = mapping.id
  and mapping.id <> mapping.winner_id;

alter table public.sidestream_download_leads
  alter column cta_source set default 'download-email-gate',
  alter column cta_source set not null,
  alter column first_captured_at set default now(),
  alter column first_captured_at set not null,
  alter column last_captured_at set default now(),
  alter column last_captured_at set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.sidestream_download_leads'::regclass
      and conname = 'sidestream_download_leads_email_cta_unique'
  ) then
    alter table public.sidestream_download_leads
      add constraint sidestream_download_leads_email_cta_unique
      unique (email, cta_source);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.sidestream_download_leads'::regclass
      and conname = 'sidestream_download_leads_submission_count_valid'
  ) then
    alter table public.sidestream_download_leads
      add constraint sidestream_download_leads_submission_count_valid
      check (submission_count > 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.sidestream_download_leads'::regclass
      and conname = 'sidestream_download_leads_capture_range_valid'
  ) then
    alter table public.sidestream_download_leads
      add constraint sidestream_download_leads_capture_range_valid
      check (first_captured_at <= last_captured_at);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.sidestream_download_leads'::regclass
      and conname = 'sidestream_download_leads_field_lengths_valid'
  ) then
    alter table public.sidestream_download_leads
      add constraint sidestream_download_leads_field_lengths_valid
      check (
        length(cta_source) between 1 and 100
        and length(coalesce(source_page, '')) <= 240
        and length(coalesce(referrer, '')) <= 500
        and length(coalesce(utm_source, '')) <= 100
        and length(coalesce(utm_medium, '')) <= 100
        and length(coalesce(utm_campaign, '')) <= 100
        and length(coalesce(utm_content, '')) <= 100
      );
  end if;
end $$;

create index if not exists sidestream_download_leads_last_capture_idx
  on public.sidestream_download_leads (last_captured_at desc);

create table if not exists public.sidestream_download_lead_idempotency (
  idempotency_key_hash text primary key,
  lead_identity_hash text not null,
  created_at timestamptz not null default now(),
  constraint sidestream_download_lead_idempotency_key_valid check (
    idempotency_key_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint sidestream_download_lead_idempotency_identity_valid check (
    lead_identity_hash ~ '^lead_v1_[0-9a-f]{64}$'
  )
);

create index if not exists sidestream_download_lead_idempotency_created_idx
  on public.sidestream_download_lead_idempotency (created_at);

create table if not exists public.sidestream_download_lead_replay_receipts (
  blob_pathname_hash text primary key,
  lead_identity_hash text not null,
  created_at timestamptz not null default now(),
  constraint sidestream_download_lead_replay_path_valid check (
    blob_pathname_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint sidestream_download_lead_replay_identity_valid check (
    lead_identity_hash ~ '^lead_v1_[0-9a-f]{64}$'
  )
);

create index if not exists sidestream_download_lead_replay_created_idx
  on public.sidestream_download_lead_replay_receipts (created_at);

comment on column public.sidestream_download_lead_idempotency.idempotency_key_hash is
  'HMAC-SHA-256 receipt only; raw Idempotency-Key values are prohibited.';
comment on column public.sidestream_download_lead_replay_receipts.blob_pathname_hash is
  'HMAC-SHA-256 receipt only; replay logs expose aggregate counts, not pathnames.';

alter table public.sidestream_download_leads enable row level security;
alter table public.sidestream_download_lead_idempotency enable row level security;
alter table public.sidestream_download_lead_replay_receipts enable row level security;

revoke all on table public.sidestream_download_leads from public;
revoke all on table public.sidestream_download_lead_idempotency from public;
revoke all on table public.sidestream_download_lead_replay_receipts from public;

do $$
declare
  table_name text;
  api_role text;
  table_names text[] := array[
    'sidestream_download_leads',
    'sidestream_download_lead_idempotency',
    'sidestream_download_lead_replay_receipts'
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

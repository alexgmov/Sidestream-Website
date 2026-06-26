create extension if not exists pgcrypto;

create table if not exists public.sidestream_download_leads (
  id uuid primary key default gen_random_uuid(),
  lead_key text not null,
  email text not null,
  email_hash text,
  captured_at timestamptz not null default now(),
  source_page text,
  cta_source text,
  referrer text,
  user_agent text,
  storage_targets text[] not null default array[]::text[],
  migrated_from_blob_pathname text,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sidestream_download_leads_email_normalized check (email = lower(trim(email))),
  constraint sidestream_download_leads_email_valid check (position('@' in email) > 1),
  constraint sidestream_download_leads_lead_key_unique unique (lead_key),
  constraint sidestream_download_leads_blob_pathname_unique unique (migrated_from_blob_pathname)
);

create index if not exists sidestream_download_leads_captured_idx
  on public.sidestream_download_leads (captured_at desc);

create index if not exists sidestream_download_leads_email_idx
  on public.sidestream_download_leads (email);

alter table public.sidestream_download_leads enable row level security;

revoke all on table public.sidestream_download_leads from anon, authenticated;
grant select, insert, update, delete on table public.sidestream_download_leads to service_role;

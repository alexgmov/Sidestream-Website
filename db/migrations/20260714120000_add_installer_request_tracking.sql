begin;

create extension if not exists pgcrypto;

create table if not exists public.sidestream_installer_requests (
  id uuid primary key default gen_random_uuid(),
  requested_at timestamptz not null default now(),
  platform text not null,
  utm_source text not null,
  utm_medium text not null,
  utm_campaign text not null,
  utm_content text,
  request_hash text not null,
  likely_scanner boolean not null default false,
  created_at timestamptz not null default now(),
  constraint sidestream_installer_requests_platform_valid
    check (platform in ('macos', 'win32-x64')),
  constraint sidestream_installer_requests_source_valid
    check (utm_source = lower(utm_source) and utm_source ~ '^[a-z0-9][a-z0-9._-]*$' and char_length(utm_source) <= 100),
  constraint sidestream_installer_requests_medium_valid
    check (utm_medium = lower(utm_medium) and utm_medium ~ '^[a-z0-9][a-z0-9._-]*$' and char_length(utm_medium) <= 100),
  constraint sidestream_installer_requests_campaign_valid
    check (utm_campaign = lower(utm_campaign) and utm_campaign ~ '^[a-z0-9][a-z0-9._-]*$' and char_length(utm_campaign) <= 100),
  constraint sidestream_installer_requests_content_valid
    check (utm_content is null or utm_content in ('pilot', 'main')),
  constraint sidestream_installer_requests_request_hash_hex
    check (request_hash ~ '^[0-9a-f]{64}$')
);

create index if not exists sidestream_installer_requests_requested_idx
  on public.sidestream_installer_requests (requested_at desc);

create index if not exists sidestream_installer_requests_campaign_idx
  on public.sidestream_installer_requests
    (utm_source, utm_campaign, utm_content, requested_at desc);

create index if not exists sidestream_installer_requests_hash_idx
  on public.sidestream_installer_requests (request_hash, requested_at desc);

alter table public.sidestream_installer_requests enable row level security;
revoke all privileges on table public.sidestream_installer_requests from public;

do $$
begin
  if to_regrole('anon') is not null then
    execute 'revoke all privileges on table public.sidestream_installer_requests from anon';
  end if;
  if to_regrole('authenticated') is not null then
    execute 'revoke all privileges on table public.sidestream_installer_requests from authenticated';
  end if;
end $$;

commit;

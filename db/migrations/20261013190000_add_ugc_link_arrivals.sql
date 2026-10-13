begin;
create table public.sidestream_ugc_link_arrivals (
  event_id uuid not null,
  license_namespace text not null check (license_namespace in ('production','test')),
  campaign text not null check (campaign ~ '^ugc-instagram-[0-9]{2}$'),
  placement text not null check (placement in ('bio','manychat')),
  occurred_at timestamptz not null default clock_timestamp(),
  primary key (license_namespace,event_id)
);
create index sidestream_ugc_link_arrivals_window_idx on public.sidestream_ugc_link_arrivals(license_namespace,occurred_at,campaign);
create table public.sidestream_ugc_tracking_start (
  license_namespace text primary key check (license_namespace in ('production','test')),
  started_at timestamptz not null default clock_timestamp()
);
insert into public.sidestream_ugc_tracking_start(license_namespace) values ('production'),('test');
alter table public.sidestream_ugc_link_arrivals enable row level security;
alter table public.sidestream_ugc_tracking_start enable row level security;
revoke all on public.sidestream_ugc_link_arrivals,public.sidestream_ugc_tracking_start from public;
do $$ begin
  if to_regrole('anon') is not null then
    execute 'revoke all on public.sidestream_ugc_link_arrivals,public.sidestream_ugc_tracking_start from anon';
  end if;
  if to_regrole('authenticated') is not null then
    execute 'revoke all on public.sidestream_ugc_link_arrivals,public.sidestream_ugc_tracking_start from authenticated';
  end if;
  if to_regrole('sidestream_web_runtime') is not null then
    execute 'revoke all on public.sidestream_ugc_link_arrivals,public.sidestream_ugc_tracking_start from sidestream_web_runtime';
    execute 'grant select, insert on public.sidestream_ugc_link_arrivals to sidestream_web_runtime';
    execute 'grant select on public.sidestream_ugc_tracking_start to sidestream_web_runtime';
  end if;
end $$;
comment on table public.sidestream_ugc_link_arrivals is 'Aggregate-only UGC tagged page arrivals. Random per-page event IDs; no browser, customer, IP, user agent, or acquisition identity stored.';
commit;

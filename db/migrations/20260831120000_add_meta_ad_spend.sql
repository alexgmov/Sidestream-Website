begin;

-- Daily Meta spend is operator-imported from an account export. The stable
-- creative_key must be the same safe value supplied to Sidestream as
-- utm_content (the recommended Meta URL parameter is {{ad.id}}). Money remains
-- currency-separated and is stored in integer minor units.
create table public.sidestream_meta_ad_spend_daily (
  license_namespace text not null,
  spend_day date not null,
  campaign text not null,
  creative_key text not null,
  ad_id text not null,
  currency text not null,
  spend_minor bigint not null,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  import_batch_hash text not null,
  imported_at timestamptz not null default now(),
  primary key (
    license_namespace,
    spend_day,
    campaign,
    creative_key,
    ad_id,
    currency
  ),
  constraint sidestream_meta_ad_spend_namespace_valid check (
    license_namespace in ('production', 'test')
  ),
  constraint sidestream_meta_ad_spend_campaign_valid check (
    campaign ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  constraint sidestream_meta_ad_spend_creative_valid check (
    creative_key ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  constraint sidestream_meta_ad_spend_ad_id_valid check (
    ad_id ~ '^[0-9]{1,32}$'
  ),
  constraint sidestream_meta_ad_spend_currency_valid check (
    currency ~ '^[a-z]{3}$'
  ),
  constraint sidestream_meta_ad_spend_amounts_valid check (
    spend_minor >= 0 and impressions >= 0 and clicks >= 0
  ),
  constraint sidestream_meta_ad_spend_batch_hash_valid check (
    import_batch_hash ~ '^[0-9a-f]{64}$'
  )
);

create index sidestream_meta_ad_spend_report_idx
  on public.sidestream_meta_ad_spend_daily (
    license_namespace,
    spend_day,
    campaign,
    creative_key,
    currency
  );

alter table public.sidestream_meta_ad_spend_daily enable row level security;
revoke all on table public.sidestream_meta_ad_spend_daily from public;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format(
        'revoke all on table public.sidestream_meta_ad_spend_daily from %I',
        role_name
      );
    end if;
  end loop;
end;
$$;

comment on table public.sidestream_meta_ad_spend_daily is
  'Currency-separated daily Meta ad spend keyed to the exact safe utm_content creative key.';

commit;

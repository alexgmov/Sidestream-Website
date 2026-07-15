create table if not exists public.sidestream_schema_migrations (
  filename text primary key,
  checksum_sha256 text not null,
  applied_at timestamptz not null default now(),
  duration_ms bigint not null,
  constraint sidestream_schema_migrations_filename_valid check (
    filename ~ '^[0-9]{14}_[a-z0-9_]+\.sql$'
  ),
  constraint sidestream_schema_migrations_checksum_valid check (
    checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint sidestream_schema_migrations_duration_valid check (
    duration_ms >= 0
  )
);

create index if not exists sidestream_schema_migrations_applied_idx
  on public.sidestream_schema_migrations (applied_at desc);

create table if not exists public.sidestream_api_rate_limits (
  scope text not null,
  dimension_hash text not null,
  window_started_at timestamptz not null,
  window_seconds integer not null,
  request_count integer not null default 1,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (scope, dimension_hash, window_started_at, window_seconds),
  constraint sidestream_api_rate_limits_scope_valid check (
    scope ~ '^[a-z0-9][a-z0-9:_-]{0,63}$'
  ),
  constraint sidestream_api_rate_limits_dimension_hash_valid check (
    dimension_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint sidestream_api_rate_limits_window_valid check (
    window_seconds between 1 and 86400
    and expires_at > window_started_at
  ),
  constraint sidestream_api_rate_limits_count_valid check (
    request_count > 0
  )
);

create index if not exists sidestream_api_rate_limits_expiry_idx
  on public.sidestream_api_rate_limits (expires_at);

create index if not exists sidestream_api_rate_limits_scope_window_idx
  on public.sidestream_api_rate_limits (scope, window_started_at desc);

comment on column public.sidestream_api_rate_limits.dimension_hash is
  'HMAC-SHA-256 digest of a scoped request dimension; raw IP and email values are prohibited.';

alter table public.sidestream_schema_migrations enable row level security;
alter table public.sidestream_api_rate_limits enable row level security;

revoke all on table public.sidestream_schema_migrations from public;
revoke all on table public.sidestream_api_rate_limits from public;

do $$
declare
  table_name text;
  api_role text;
  table_names text[] := array[
    'sidestream_schema_migrations',
    'sidestream_api_rate_limits'
  ];
  api_roles text[] := array[
    'anon',
    'authenticated'
  ];
begin
  foreach table_name in array table_names loop
    foreach api_role in array api_roles loop
      if exists (select 1 from pg_roles where rolname = api_role) then
        execute format('revoke all on table public.%I from %I', table_name, api_role);
      end if;
    end loop;
  end loop;
end $$;

-- MCP connections reuse canonical accounts, device policy and the download ledger.
-- Enable SIDESTREAM_MCP_ENABLED only after this additive migration is applied.
create table public.sidestream_mcp_connections (
  id uuid primary key default gen_random_uuid(),
  connection_key text not null unique check (connection_key ~ '^[A-Za-z0-9_-]{43}$'),
  poll_token_hash text not null unique check (poll_token_hash ~ '^[0-9a-f]{64}$'),
  license_namespace text not null check (license_namespace in ('production', 'test')),
  device_id_hash text not null check (device_id_hash ~ '^[0-9a-f]{64}$'),
  client_name text not null check (length(client_name) between 1 and 80),
  platform text not null check (platform in ('macos', 'windows', 'unknown')),
  app_version text,
  account_id uuid references public.sidestream_accounts(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'revoked')),
  pairing_expires_at timestamptz not null default (now() + interval '15 minutes'),
  token_hash text unique check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  token_expires_at timestamptz,
  approved_at timestamptz,
  revoked_at timestamptz,
  paid_device_id uuid references public.sidestream_account_devices(id) on delete restrict,
  paid_bound_at timestamptz,
  upgrade_activation_key text,
  created_at timestamptz not null default now(),
  check ((paid_device_id is null) = (paid_bound_at is null)),
  check (status <> 'approved' or (account_id is not null and token_hash is not null and token_expires_at is not null and approved_at is not null))
);
create index sidestream_mcp_connections_account on public.sidestream_mcp_connections (license_namespace, account_id, created_at desc);

-- Authenticated reconnects and the panel's existing device identity share one
-- account wallet. This alias never creates a second starter grant.
create table public.sidestream_mcp_wallet_devices (
  license_namespace text not null check (license_namespace in ('production', 'test')),
  device_id_hash text not null check (device_id_hash ~ '^[0-9a-f]{64}$'),
  account_id uuid not null references public.sidestream_accounts(id) on delete restrict,
  wallet_id uuid not null references public.sidestream_credit_wallets(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (license_namespace, device_id_hash)
);

-- Paid jobs are recorded here with zero cost; Free jobs also point by request ID
-- to their existing credit-ledger reservation. No new balance system is created.
create table public.sidestream_mcp_downloads (
  license_namespace text not null check (license_namespace in ('production', 'test')),
  account_id uuid not null references public.sidestream_accounts(id) on delete restrict,
  request_id uuid not null,
  connection_key text not null references public.sidestream_mcp_connections(connection_key) on delete restrict,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  format_type text not null check (format_type in ('video', 'audio')),
  source_platform text not null check (source_platform in ('youtube', 'instagram', 'tiktok', 'twitter', 'linkedin', 'other')),
  requested_height integer check (requested_height in (720,1080,2160)),
  credit_cost integer not null check (credit_cost in (0,100)),
  status text not null default 'reserved' check (status in ('reserved', 'committed', 'released', 'expired')),
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  primary key (license_namespace, account_id, request_id)
);

do $$
declare relation_name text; api_role text;
begin
  foreach relation_name in array array['sidestream_mcp_connections','sidestream_mcp_wallet_devices','sidestream_mcp_downloads'] loop
    execute format('alter table public.%I enable row level security', relation_name);
    execute format('revoke all on table public.%I from public', relation_name);
    foreach api_role in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = api_role) then
        execute format('revoke all on table public.%I from %I', relation_name, api_role);
      end if;
    end loop;
  end loop;
end $$;

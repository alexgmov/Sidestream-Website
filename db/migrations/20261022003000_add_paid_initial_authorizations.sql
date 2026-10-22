-- Per-installation continuity evidence, separate from current server entitlement.
create table public.sidestream_paid_initial_authorizations (
  id uuid primary key default gen_random_uuid(),
  activation_id uuid not null references public.sidestream_activation_sessions(id) on delete restrict,
  account_id uuid not null references public.sidestream_accounts(id) on delete restrict,
  license_id uuid not null references public.sidestream_licenses(id) on delete restrict,
  checkout_id uuid not null references public.sidestream_paid_acquisition_checkouts(id) on delete restrict,
  install_id_hash text not null check (install_id_hash ~ '^[0-9a-f]{64}$'),
  installer_receipt_id_hash text not null check (installer_receipt_id_hash ~ '^[0-9a-f]{64}$'),
  receipt_sha256 text not null check (receipt_sha256 ~ '^[0-9a-f]{64}$'),
  lineage text not null check (lineage ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  target_sha256 text not null check (target_sha256 ~ '^[0-9a-f]{64}$'),
  target_manifest_sha256 text not null check (target_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  key_sha256 text not null check (key_sha256 ~ '^[0-9a-f]{64}$'),
  envelope jsonb not null check (jsonb_typeof(envelope) = 'object' and octet_length(envelope::text) <= 65536),
  issued_at timestamptz not null default now(),
  unique (install_id_hash, installer_receipt_id_hash, lineage)
);
alter table public.sidestream_paid_initial_authorizations enable row level security;
revoke all on public.sidestream_paid_initial_authorizations from public;
create function public.sidestream_paid_initial_authorization_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'Paid initial authorization is immutable';
end;
$$;
create trigger sidestream_paid_initial_authorization_immutable
before update or delete on public.sidestream_paid_initial_authorizations
for each row execute function public.sidestream_paid_initial_authorization_immutable();

-- Exact body-only identity for new paid activations. Never infer or backfill
-- this pair from mutable Customer 360 profile membership or browser fields.
create table public.sidestream_paid_activation_installation_identity (
  activation_id uuid primary key
    references public.sidestream_activation_sessions(id) on delete cascade,
  license_namespace text not null check (license_namespace in ('production', 'test')),
  install_id_hash text not null check (install_id_hash ~ '^[0-9a-f]{64}$'),
  installer_receipt_id_hash text not null check (installer_receipt_id_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

alter table public.sidestream_paid_activation_installation_identity enable row level security;
revoke all on table public.sidestream_paid_activation_installation_identity from public;

create function public.sidestream_reject_paid_activation_identity_update()
returns trigger language plpgsql as $$
begin
  raise exception 'Paid activation installation identity is immutable';
end;
$$;

create trigger sidestream_paid_activation_identity_immutable
  before update on public.sidestream_paid_activation_installation_identity
  for each row execute function public.sidestream_reject_paid_activation_identity_update();

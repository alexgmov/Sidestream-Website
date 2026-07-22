-- Give the private telemetry bridge a stable server-generated reference without
-- changing its namespace-scoped anonymous identity key.
alter table public.sidestream_telemetry_identity_links
  add column id uuid not null default gen_random_uuid();

alter table public.sidestream_telemetry_identity_links
  add constraint sidestream_telemetry_identity_links_id_unique unique (id);

-- Activation rows may retain the exact bridge row involved in their verified
-- flow. Older writers remain valid because the reference is nullable.
alter table public.sidestream_activation_sessions
  add column telemetry_identity_link_id uuid;

alter table public.sidestream_activation_sessions
  add constraint sidestream_activation_sessions_telemetry_identity_link_fk
    foreign key (telemetry_identity_link_id)
    references public.sidestream_telemetry_identity_links (id)
    on delete set null;

create index sidestream_activation_sessions_telemetry_identity_link_idx
  on public.sidestream_activation_sessions (telemetry_identity_link_id);

comment on column public.sidestream_telemetry_identity_links.id is
  'Private server-generated reference for trusted activation association.';
comment on column public.sidestream_activation_sessions.telemetry_identity_link_id is
  'Optional private reference to the telemetry identity observed by this activation.';

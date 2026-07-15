create table sidestream_telemetry_events (
  telemetry_event_id text primary key,
  install_id_hash text not null,
  session_id text,
  sequence integer,
  event_name text not null,
  event_category text,
  event_scope text,
  occurred_at timestamptz not null,
  received_at timestamptz not null,
  app_version text,
  build_channel text,
  schema_version text not null,
  payload jsonb not null default '{}',
  data_points jsonb not null default '{}'
);

create index sidestream_telemetry_events_high_water_idx
  on sidestream_telemetry_events (received_at, telemetry_event_id);

create index sidestream_telemetry_events_install_day_idx
  on sidestream_telemetry_events (install_id_hash, occurred_at);

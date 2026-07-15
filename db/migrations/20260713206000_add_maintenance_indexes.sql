begin;

alter table public.sidestream_stripe_events
  add column if not exists payload_redacted_at timestamptz;

do $$
begin
  alter table public.sidestream_stripe_events
    add constraint sidestream_stripe_events_payload_redaction_check
    check (
      payload_redacted_at is null
      or (
        terminal_at is not null
        and raw_payload is null
        and payload @> '{"redacted": true}'::jsonb
      )
    );
exception
  when duplicate_object then null;
end $$;

comment on column public.sidestream_stripe_events.payload_redacted_at is
  'When set, raw payloads and customer data have been removed; event identity and bounded billing audit metadata remain.';

create index if not exists sidestream_account_sessions_retention_idx
  on public.sidestream_account_sessions (
    greatest(expires_at, coalesce(revoked_at, expires_at)),
    id
  );

create index if not exists sidestream_activation_sessions_retention_idx
  on public.sidestream_activation_sessions (expires_at, id)
  where status in ('expired', 'linked', 'restored', 'paid')
    or completed_at is not null;

create index if not exists sidestream_license_tokens_retention_idx
  on public.sidestream_license_tokens (
    coalesce(
      revoked_at,
      greatest(
        expires_at,
        coalesce(refresh_expires_at, expires_at),
        coalesce(previous_refresh_valid_until, expires_at)
      )
    ),
    id
  );

create index if not exists sidestream_api_rate_limits_retention_idx
  on public.sidestream_api_rate_limits (
    expires_at,
    scope,
    dimension_hash,
    window_started_at,
    window_seconds
  );

create index if not exists sidestream_checkout_intents_retention_idx
  on public.sidestream_checkout_intents (expires_at, id);

create index if not exists sidestream_stripe_events_redaction_idx
  on public.sidestream_stripe_events (terminal_at, event_id)
  where payload_redacted_at is null
    and processing_status in ('processed', 'ignored', 'dead_letter');

commit;

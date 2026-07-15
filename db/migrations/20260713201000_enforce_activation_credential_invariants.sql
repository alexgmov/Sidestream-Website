create unique index if not exists sidestream_license_tokens_one_live_activation_device
  on public.sidestream_license_tokens (activation_session_id, device_id_hash)
  where activation_session_id is not null
    and device_id_hash is not null
    and refresh_token_hash is not null
    and revoked_at is null;

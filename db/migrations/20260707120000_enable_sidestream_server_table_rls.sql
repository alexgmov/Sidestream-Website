do $$
declare
  table_name text;
  api_role text;
  table_names text[] := array[
    'sidestream_download_leads',
    'sidestream_accounts',
    'sidestream_account_sessions',
    'sidestream_licenses',
    'sidestream_activation_sessions',
    'sidestream_license_tokens',
    'sidestream_stripe_events',
    'sidestream_billing_resources'
  ];
  api_roles text[] := array[
    'anon',
    'authenticated'
  ];
begin
  foreach table_name in array table_names loop
    if to_regclass(format('public.%I', table_name)) is null then
      continue;
    end if;

    execute format('alter table public.%I enable row level security', table_name);

    foreach api_role in array api_roles loop
      if exists (select 1 from pg_roles where rolname = api_role) then
        execute format('revoke all on table public.%I from %I', table_name, api_role);
      end if;
    end loop;
  end loop;
end $$;

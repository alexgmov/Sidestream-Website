alter table public.sidestream_licenses
  add column if not exists stripe_checkout_session_id text,
  add column if not exists stripe_payment_intent_id text,
  alter column stripe_subscription_id drop not null;

do $$
begin
  alter table public.sidestream_licenses
    add constraint sidestream_licenses_checkout_session_unique unique (stripe_checkout_session_id);
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.sidestream_licenses
    add constraint sidestream_licenses_payment_intent_unique unique (stripe_payment_intent_id);
exception
  when duplicate_object then null;
end $$;

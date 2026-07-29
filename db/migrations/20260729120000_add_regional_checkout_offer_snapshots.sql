begin;

alter table public.sidestream_checkout_intents
  add column if not exists offer_id text,
  add column if not exists offer_country text,
  add column if not exists offer_currency text,
  add column if not exists offer_amount_minor integer,
  add column if not exists offer_stripe_product_id text,
  add column if not exists offer_stripe_price_id text;

alter table public.sidestream_checkout_intents
  drop constraint if exists sidestream_checkout_intents_offer_snapshot_valid;

alter table public.sidestream_checkout_intents
  add constraint sidestream_checkout_intents_offer_snapshot_valid check (
    (
      offer_id is null
      and offer_country is null
      and offer_currency is null
      and offer_amount_minor is null
      and offer_stripe_product_id is null
      and offer_stripe_price_id is null
    )
    or (
      offer_id is not null
      and offer_country is not null
      and offer_currency is not null
      and offer_amount_minor is not null
      and offer_stripe_product_id is not null
      and offer_stripe_price_id is not null
      and length(trim(offer_id)) between 1 and 120
      and offer_country ~ '^[A-Z]{2}$'
      and offer_currency ~ '^[a-z]{3}$'
      and offer_amount_minor > 0
      and length(trim(offer_stripe_product_id)) > 0
      and length(trim(offer_stripe_price_id)) > 0
    )
  );

comment on column public.sidestream_checkout_intents.offer_id is
  'Server-selected regional offer identifier captured before Stripe Checkout creation.';
comment on column public.sidestream_checkout_intents.offer_country is
  'Normalized trusted edge country signal captured with the selected offer; ZZ means unavailable.';
comment on column public.sidestream_checkout_intents.offer_currency is
  'Lowercase ISO currency captured from the approved immutable Stripe Price.';
comment on column public.sidestream_checkout_intents.offer_amount_minor is
  'Approved offer subtotal in the currency minor unit, captured before Stripe Checkout creation.';
comment on column public.sidestream_checkout_intents.offer_stripe_product_id is
  'Approved immutable Stripe Product snapshot used for Checkout and fulfillment.';
comment on column public.sidestream_checkout_intents.offer_stripe_price_id is
  'Approved immutable Stripe Price snapshot used for Checkout and fulfillment.';

alter table public.sidestream_paid_acquisition_checkouts
  drop constraint if exists sidestream_paid_acquisition_checkouts_provider_bounds;

alter table public.sidestream_paid_acquisition_checkouts
  add constraint sidestream_paid_acquisition_checkouts_provider_bounds check (
    (verified_checkout_session_ref is null or
      (length(verified_checkout_session_ref) between 1 and 255 and
       verified_checkout_session_ref ~ '^[!-~]+$'))
    and (canonical_payment_ref is null or
      (length(canonical_payment_ref) between 1 and 255 and
       canonical_payment_ref ~ '^[!-~]+$'))
    and (checkout_email_normalized is null or
      octet_length(checkout_email_normalized) between 3 and 254)
    and (verified_product_ref is null or length(verified_product_ref) between 1 and 255)
    and (verified_price_ref is null or length(verified_price_ref) between 1 and 255)
    and (verified_quantity is null or verified_quantity = 1)
    and (verified_amount_minor is null or verified_amount_minor >= 0)
    and (verified_currency is null or verified_currency ~ '^[a-z]{3}$')
  );

commit;

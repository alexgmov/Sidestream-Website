alter table public.sidestream_paid_acquisition_checkouts
  drop constraint sidestream_paid_acquisition_checkouts_provider_bounds;

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
    and (verified_amount_minor is null or verified_amount_minor = 2499)
    and (verified_currency is null or verified_currency = 'usd')
  );

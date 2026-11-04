begin;

-- Explicit plan selection extends Checkout pricing without rewriting any
-- experiment assignment, historical intent, provider object, or paid license.
alter table public.sidestream_checkout_intents
  drop constraint sidestream_checkout_intents_upgrade_pricing_snapshot_valid,
  add constraint sidestream_checkout_intents_upgrade_pricing_snapshot_valid check (
    (
      upgrade_pricing_snapshot_version is null
      and upgrade_pricing_experiment_id is null
      and upgrade_pricing_decision_reason is null
      and upgrade_pricing_assignment_id is null
      and upgrade_pricing_assignment_bucket is null
      and upgrade_pricing_rollout_basis_points is null
      and upgrade_pricing_assigned_at is null
      and upgrade_pricing_variant is null
      and upgrade_pricing_billing_model is null
      and upgrade_pricing_country is null
      and upgrade_pricing_currency is null
      and upgrade_pricing_amount_minor is null
      and upgrade_pricing_stripe_product_id is null
      and upgrade_pricing_stripe_price_id is null
      and upgrade_pricing_account_id is null
      and upgrade_pricing_acquisition_id is null
      and upgrade_pricing_checkout_intent_id is null
      and upgrade_pricing_activation_session_id is null
    )
    or (
      (
        (
          upgrade_pricing_snapshot_version = 1
          and upgrade_pricing_experiment_id = 'upgrade-pricing-v1'
          and upgrade_pricing_decision_reason in (
            'existing_assignment',
            'rollout_control',
            'rollout_monthly',
            'rollout_zero',
            'kill_switch',
            'assignment_unavailable',
            'unsupported_currency'
          )
          and (
            (upgrade_pricing_variant = 'control_one_time' and upgrade_pricing_billing_model = 'one_time')
            or (upgrade_pricing_variant = 'monthly_half' and upgrade_pricing_billing_model = 'subscription')
          )
        )
        or (
          upgrade_pricing_snapshot_version = 2
          and upgrade_pricing_experiment_id = 'upgrade-pricing-v2'
          and upgrade_pricing_decision_reason in (
            'existing_assignment',
            'rollout_control',
            'rollout_annual',
            'rollout_zero',
            'kill_switch',
            'assignment_unavailable',
            'unsupported_currency'
          )
          and (
            (upgrade_pricing_variant = 'control_one_time' and upgrade_pricing_billing_model = 'one_time')
            or (upgrade_pricing_variant = 'annual_same_price' and upgrade_pricing_billing_model = 'subscription')
          )
        )
      )
      and upgrade_pricing_country ~ '^[A-Z]{2}$'
      and upgrade_pricing_currency ~ '^[a-z]{3}$'
      and upgrade_pricing_amount_minor > 0
      and length(trim(upgrade_pricing_stripe_product_id)) between 1 and 255
      and length(trim(upgrade_pricing_stripe_price_id)) between 1 and 255
      and upgrade_pricing_account_id is not null
      and upgrade_pricing_acquisition_id is not null
      and upgrade_pricing_checkout_intent_id = id
      and upgrade_pricing_account_id = account_id
      and upgrade_pricing_acquisition_id = acquisition_id
      and upgrade_pricing_activation_session_id is not distinct from activation_session_id
      and upgrade_pricing_rollout_basis_points between 0 and 10000
      and (
        (
          upgrade_pricing_decision_reason in (
            'existing_assignment',
            'rollout_control',
            'rollout_monthly',
            'rollout_annual',
            'rollout_zero'
          )
          and upgrade_pricing_assignment_id is not null
          and upgrade_pricing_assignment_bucket between 0 and 9999
          and upgrade_pricing_assigned_at is not null
        )
        or (
          upgrade_pricing_decision_reason in (
            'kill_switch',
            'assignment_unavailable',
            'unsupported_currency'
          )
          and upgrade_pricing_variant = 'control_one_time'
          and upgrade_pricing_billing_model = 'one_time'
          and upgrade_pricing_assignment_id is null
          and upgrade_pricing_assignment_bucket is null
          and upgrade_pricing_assigned_at is null
        )
      )
    )

    or (
      upgrade_pricing_snapshot_version = 3
      and upgrade_pricing_experiment_id is not null
      and upgrade_pricing_decision_reason is not null
      and upgrade_pricing_variant is not null
      and upgrade_pricing_billing_model is not null
      and upgrade_pricing_rollout_basis_points is not null
      and upgrade_pricing_country is not null
      and upgrade_pricing_currency is not null
      and upgrade_pricing_amount_minor is not null
      and upgrade_pricing_stripe_product_id is not null
      and upgrade_pricing_stripe_price_id is not null
      and upgrade_pricing_checkout_intent_id is not null
      and offer_country is not null
      and offer_currency is not null
      and offer_amount_minor is not null
      and offer_stripe_product_id is not null
      and offer_stripe_price_id is not null
      and upgrade_pricing_experiment_id = 'upgrade-plans-v1'
      and upgrade_pricing_decision_reason = 'customer_choice'
      and upgrade_pricing_assignment_id is null
      and upgrade_pricing_assignment_bucket is null
      and upgrade_pricing_assigned_at is null
      and upgrade_pricing_rollout_basis_points = 0
      and (
        (upgrade_pricing_variant = 'pro_monthly'
          and upgrade_pricing_billing_model = 'subscription'
          and upgrade_pricing_currency = 'usd')
        or (upgrade_pricing_variant = 'unlimited_one_time'
          and upgrade_pricing_billing_model = 'one_time')
      )
      and upgrade_pricing_country ~ '^[A-Z]{2}$'
      and upgrade_pricing_currency ~ '^[a-z]{3}$'
      and upgrade_pricing_amount_minor > 0
      and length(trim(upgrade_pricing_stripe_product_id)) between 1 and 255
      and length(trim(upgrade_pricing_stripe_price_id)) between 1 and 255
      and upgrade_pricing_account_id is not null
      and upgrade_pricing_acquisition_id is not null
      and upgrade_pricing_checkout_intent_id = id
      and upgrade_pricing_account_id = account_id
      and upgrade_pricing_acquisition_id = acquisition_id
      and upgrade_pricing_activation_session_id is not distinct from activation_session_id
      and upgrade_pricing_country = offer_country
      and upgrade_pricing_currency = offer_currency
      and upgrade_pricing_amount_minor = offer_amount_minor
      and upgrade_pricing_stripe_product_id = offer_stripe_product_id
      and upgrade_pricing_stripe_price_id = offer_stripe_price_id
    )
  );

comment on column public.sidestream_checkout_intents.upgrade_pricing_snapshot_version is
  'Immutable complete Checkout pricing snapshot: legacy experiments v1/v2, or explicit customer-selected plans v3. Customer choice creates no experiment assignment or exposure.';

commit;

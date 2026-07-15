-- Canonical Customer 360 money ledger.
--
-- This projection is money truth only. It deliberately does not read, write,
-- derive, or bless sidestream_licenses entitlement state. Mutable source-object
-- materializations are watermark-protected by (event_created_at, event_id),
-- related Checkout/PaymentIntent/charge/invoice objects converge through aliases,
-- and every materialized total remains isolated by ISO currency. The durable
-- source boundary in sidestream_stripe_events is its insert-only event_id,
-- event_type, and stripe_created_at. Queue processing state is mutable, and
-- maintenance may redact payload and raw_payload fields.

alter table public.sidestream_customer_profiles
  add column if not exists commerce_model text,
  add column if not exists first_paid_at timestamptz,
  add column if not exists last_paid_at timestamptz,
  add column if not exists first_upgraded_at timestamptz,
  add column if not exists last_upgraded_at timestamptz;

alter table public.sidestream_customer_profiles
  add constraint sidestream_customer_profiles_commerce_model_valid check (
    commerce_model is null
    or commerce_model in ('one_time', 'subscription', 'comped', 'mixed')
  ),
  add constraint sidestream_customer_profiles_paid_dates_valid check (
    first_paid_at is null
    or last_paid_at is null
    or last_paid_at >= first_paid_at
  ),
  add constraint sidestream_customer_profiles_upgraded_dates_valid check (
    first_upgraded_at is null
    or last_upgraded_at is null
    or last_upgraded_at >= first_upgraded_at
  );

create table public.sidestream_customer_commerce_materializations (
  id uuid primary key default gen_random_uuid(),
  license_namespace text not null,
  profile_id uuid,
  event_id text not null,
  event_type text not null,
  event_created_at timestamptz not null,
  source_object_type text not null,
  source_object_id text not null,
  fact_kind text not null,
  commerce_model text not null,
  state text not null,
  currency text,
  gross_paid_minor bigint not null default 0,
  discount_minor bigint not null default 0,
  tax_minor bigint not null default 0,
  refunded_minor bigint not null default 0,
  disputed_minor bigint not null default 0,
  inquiry_minor bigint not null default 0,
  net_paid_minor bigint not null default 0,
  first_paid_at timestamptz,
  last_paid_at timestamptz,
  first_upgraded_at timestamptz,
  last_upgraded_at timestamptz,
  first_inferred_paid_at timestamptz,
  last_inferred_paid_at timestamptz,
  first_inferred_upgraded_at timestamptz,
  last_inferred_upgraded_at timestamptz,
  object_created_at timestamptz,
  effective_at timestamptz not null,
  billing_period_start timestamptz,
  billing_period_end timestamptz,
  timestamp_source text not null,
  source text not null,
  source_confidence text not null,
  payment_key text not null,
  identity_evidence jsonb not null default '[]'::jsonb,
  identity_conflict boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sidestream_customer_commerce_materializations_namespace_valid check (
    license_namespace in ('production', 'test')
  ),
  constraint sidestream_customer_commerce_materializations_profile_namespace_fk
    foreign key (profile_id, license_namespace)
    references public.sidestream_customer_profiles (id, license_namespace),
  constraint sidestream_customer_commerce_materializations_source_unique unique (
    license_namespace,
    source_object_type,
    source_object_id
  ),
  constraint sidestream_customer_commerce_materializations_kind_valid check (
    fact_kind in ('payment', 'refund', 'dispute', 'subscription', 'discount', 'manual')
  ),
  constraint sidestream_customer_commerce_materializations_model_valid check (
    commerce_model in ('one_time', 'subscription', 'comped', 'mixed')
  ),
  constraint sidestream_customer_commerce_materializations_currency_valid check (
    currency is null or currency ~ '^[a-z]{3}$'
  ),
  constraint sidestream_customer_commerce_materializations_money_valid check (
    gross_paid_minor >= 0
    and discount_minor >= 0
    and tax_minor >= 0
    and refunded_minor >= 0
    and disputed_minor >= 0
    and inquiry_minor >= 0
    and net_paid_minor >= 0
    and net_paid_minor = greatest(
      gross_paid_minor - refunded_minor - disputed_minor,
      0
    )
    and (
      currency is not null
      or (
        gross_paid_minor = 0
        and discount_minor = 0
        and tax_minor = 0
        and refunded_minor = 0
        and disputed_minor = 0
        and inquiry_minor = 0
        and net_paid_minor = 0
      )
    )
  ),
  constraint sidestream_customer_commerce_materializations_dates_valid check (
    (first_paid_at is null or last_paid_at is null or last_paid_at >= first_paid_at)
    and (
      first_upgraded_at is null
      or last_upgraded_at is null
      or last_upgraded_at >= first_upgraded_at
    )
    and (
      first_inferred_paid_at is null
      or last_inferred_paid_at is null
      or last_inferred_paid_at >= first_inferred_paid_at
    )
    and (
      first_inferred_upgraded_at is null
      or last_inferred_upgraded_at is null
      or last_inferred_upgraded_at >= first_inferred_upgraded_at
    )
    and (
      billing_period_start is null
      or billing_period_end is null
      or billing_period_end >= billing_period_start
    )
  ),
  constraint sidestream_customer_commerce_materializations_timestamp_source_valid check (
    timestamp_source in (
      'stripe_object',
      'stripe_status_transition',
      'stripe_event',
      'legacy_event_inference'
    )
  ),
  constraint sidestream_customer_commerce_materializations_source_valid check (
    source in ('stripe_object', 'stripe_embedded', 'manual_metadata')
  ),
  constraint sidestream_customer_commerce_materializations_confidence_valid check (
    source_confidence in ('verified', 'legacy_inferred')
  ),
  constraint sidestream_customer_commerce_materializations_bounded check (
    char_length(event_id) between 1 and 255
    and char_length(event_type) between 1 and 160
    and char_length(source_object_type) between 1 and 40
    and char_length(source_object_id) between 1 and 200
    and char_length(state) between 1 and 80
    and char_length(payment_key) between 1 and 241
    and jsonb_typeof(identity_evidence) = 'array'
  )
);

create index sidestream_customer_commerce_materializations_profile_currency_idx
  on public.sidestream_customer_commerce_materializations (
    license_namespace,
    profile_id,
    currency,
    effective_at
  );

create index sidestream_customer_commerce_materializations_payment_key_idx
  on public.sidestream_customer_commerce_materializations (
    license_namespace,
    payment_key,
    fact_kind
  );

create index sidestream_customer_commerce_materializations_unresolved_idx
  on public.sidestream_customer_commerce_materializations (license_namespace, updated_at)
  where profile_id is null;

create index sidestream_customer_commerce_materializations_identity_gin_idx
  on public.sidestream_customer_commerce_materializations using gin (identity_evidence);

create table public.sidestream_customer_commerce_aliases (
  license_namespace text not null,
  alias_type text not null,
  alias_id text not null,
  payment_key text not null,
  first_event_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (license_namespace, alias_type, alias_id),
  constraint sidestream_customer_commerce_aliases_namespace_valid check (
    license_namespace in ('production', 'test')
  ),
  constraint sidestream_customer_commerce_aliases_bounded check (
    char_length(alias_type) between 1 and 40
    and char_length(alias_id) between 1 and 200
    and char_length(payment_key) between 1 and 241
    and char_length(first_event_id) between 1 and 255
  )
);

create index sidestream_customer_commerce_aliases_payment_key_idx
  on public.sidestream_customer_commerce_aliases (license_namespace, payment_key);

create table public.sidestream_customer_money_totals (
  profile_id uuid not null,
  license_namespace text not null,
  currency text not null,
  commerce_model text not null,
  gross_paid_minor bigint not null,
  discount_minor bigint not null,
  tax_minor bigint not null,
  refunded_minor bigint not null,
  disputed_minor bigint not null,
  inquiry_minor bigint not null,
  net_paid_minor bigint not null,
  paid_transaction_count bigint not null,
  comped_transaction_count bigint not null,
  first_paid_at timestamptz,
  last_paid_at timestamptz,
  first_upgraded_at timestamptz,
  last_upgraded_at timestamptz,
  materialized_at timestamptz not null default now(),
  primary key (license_namespace, profile_id, currency),
  constraint sidestream_customer_money_totals_profile_namespace_fk
    foreign key (profile_id, license_namespace)
    references public.sidestream_customer_profiles (id, license_namespace),
  constraint sidestream_customer_money_totals_namespace_valid check (
    license_namespace in ('production', 'test')
  ),
  constraint sidestream_customer_money_totals_currency_valid check (
    currency ~ '^[a-z]{3}$'
  ),
  constraint sidestream_customer_money_totals_model_valid check (
    commerce_model in ('one_time', 'subscription', 'comped', 'mixed')
  ),
  constraint sidestream_customer_money_totals_nonnegative check (
    gross_paid_minor >= 0
    and discount_minor >= 0
    and tax_minor >= 0
    and refunded_minor >= 0
    and disputed_minor >= 0
    and inquiry_minor >= 0
    and net_paid_minor >= 0
    and paid_transaction_count >= 0
    and comped_transaction_count >= 0
  ),
  constraint sidestream_customer_money_totals_net_valid check (
    net_paid_minor = greatest(
      gross_paid_minor - refunded_minor - disputed_minor,
      0
    )
  ),
  constraint sidestream_customer_money_totals_dates_valid check (
    (first_paid_at is null or last_paid_at is null or last_paid_at >= first_paid_at)
    and (
      first_upgraded_at is null
      or last_upgraded_at is null
      or last_upgraded_at >= first_upgraded_at
    )
  )
);

create or replace function public.sidestream_customer_commerce_key_priority(
  candidate text
)
returns integer
language sql
immutable
strict
as $$
  select case split_part(candidate, ':', 1)
    when 'charge' then 0
    when 'payment_intent' then 1
    when 'invoice' then 2
    when 'checkout_session' then 3
    when 'refund' then 5
    when 'dispute' then 5
    when 'subscription_lifecycle' then 6
    else 10
  end
$$;

create or replace function public.sidestream_customer_commerce_refresh_namespace(
  target_namespace text
)
returns void
language plpgsql
as $$
begin
  if target_namespace not in ('production', 'test') then
    raise exception 'Invalid Customer commerce namespace' using errcode = '23514';
  end if;

  delete from public.sidestream_customer_money_totals
  where license_namespace = target_namespace;

  insert into public.sidestream_customer_money_totals (
    profile_id,
    license_namespace,
    currency,
    commerce_model,
    gross_paid_minor,
    discount_minor,
    tax_minor,
    refunded_minor,
    disputed_minor,
    inquiry_minor,
    net_paid_minor,
    paid_transaction_count,
    comped_transaction_count,
    first_paid_at,
    last_paid_at,
    first_upgraded_at,
    last_upgraded_at,
    materialized_at
  )
  with payment_groups as (
    select
      fact.profile_id,
      fact.currency,
      fact.payment_key,
      max(fact.gross_paid_minor) as gross_paid_minor,
      max(fact.discount_minor) as discount_minor,
      max(fact.tax_minor) as tax_minor,
      max(fact.refunded_minor) as reported_refunded_minor,
      min(fact.first_paid_at) as first_paid_at,
      max(fact.last_paid_at) as last_paid_at,
      min(fact.first_upgraded_at) as first_upgraded_at,
      max(fact.last_upgraded_at) as last_upgraded_at,
      case
        when bool_or(fact.commerce_model = 'subscription') then 'subscription'
        when count(distinct fact.commerce_model) = 1 then min(fact.commerce_model)
        else 'mixed'
      end as commerce_model
    from public.sidestream_customer_commerce_materializations fact
    where fact.license_namespace = target_namespace
      and fact.profile_id is not null
      and fact.currency is not null
      and fact.fact_kind = 'payment'
    group by fact.profile_id, fact.currency, fact.payment_key
  ),
  refund_groups as (
    select profile_id, currency, payment_key, sum(refunded_minor) as refunded_minor
    from public.sidestream_customer_commerce_materializations
    where license_namespace = target_namespace
      and profile_id is not null
      and currency is not null
      and fact_kind = 'refund'
    group by profile_id, currency, payment_key
  ),
  dispute_groups as (
    select
      profile_id,
      currency,
      payment_key,
      sum(disputed_minor) as disputed_minor,
      sum(inquiry_minor) as inquiry_minor
    from public.sidestream_customer_commerce_materializations
    where license_namespace = target_namespace
      and profile_id is not null
      and currency is not null
      and fact_kind = 'dispute'
    group by profile_id, currency, payment_key
  ),
  payment_totals as (
    select
      payment.profile_id,
      payment.currency,
      payment.payment_key,
      payment.commerce_model,
      payment.gross_paid_minor,
      payment.discount_minor,
      payment.tax_minor,
      greatest(
        payment.reported_refunded_minor,
        coalesce(refund.refunded_minor, 0)
      ) as refunded_minor,
      coalesce(dispute.disputed_minor, 0) as disputed_minor,
      coalesce(dispute.inquiry_minor, 0) as inquiry_minor,
      payment.first_paid_at,
      payment.last_paid_at,
      payment.first_upgraded_at,
      payment.last_upgraded_at
    from payment_groups payment
    left join refund_groups refund
      on refund.profile_id = payment.profile_id
      and refund.currency = payment.currency
      and refund.payment_key = payment.payment_key
    left join dispute_groups dispute
      on dispute.profile_id = payment.profile_id
      and dispute.currency = payment.currency
      and dispute.payment_key = payment.payment_key
  )
  select
    payment.profile_id,
    target_namespace,
    payment.currency,
    case
      when count(distinct payment.commerce_model) = 1 then min(payment.commerce_model)
      else 'mixed'
    end,
    sum(payment.gross_paid_minor),
    sum(payment.discount_minor),
    sum(payment.tax_minor),
    sum(payment.refunded_minor),
    sum(payment.disputed_minor),
    sum(payment.inquiry_minor),
    greatest(
      sum(payment.gross_paid_minor)
        - sum(payment.refunded_minor)
        - sum(payment.disputed_minor),
      0
    ),
    count(*) filter (where payment.gross_paid_minor > 0),
    count(*) filter (
      where payment.gross_paid_minor = 0
        and payment.commerce_model = 'comped'
    ),
    min(payment.first_paid_at),
    max(payment.last_paid_at),
    min(payment.first_upgraded_at),
    max(payment.last_upgraded_at),
    clock_timestamp()
  from payment_totals payment
  group by payment.profile_id, payment.currency;

  update public.sidestream_customer_profiles profile
  set commerce_model = null,
      first_paid_at = null,
      last_paid_at = null,
      first_upgraded_at = null,
      last_upgraded_at = null,
      commerce_synced_at = null,
      updated_at = now()
  where profile.license_namespace = target_namespace
    and profile.merged_into is null
    and (
      profile.commerce_model is not null
      or profile.first_paid_at is not null
      or profile.last_paid_at is not null
      or profile.first_upgraded_at is not null
      or profile.last_upgraded_at is not null
      or profile.commerce_synced_at is not null
    );

  with profile_payment_models as (
    select
      fact.profile_id,
      fact.payment_key,
      case
        when bool_or(fact.commerce_model = 'subscription') then 'subscription'
        when count(distinct fact.commerce_model) = 1 then min(fact.commerce_model)
        else 'mixed'
      end as commerce_model
    from public.sidestream_customer_commerce_materializations fact
    where fact.license_namespace = target_namespace
      and fact.profile_id is not null
      and fact.fact_kind = 'payment'
    group by fact.profile_id, fact.payment_key
  ),
  profile_relationship_models as (
    select profile_id, commerce_model from profile_payment_models
    union all
    select fact.profile_id, fact.commerce_model
    from public.sidestream_customer_commerce_materializations fact
    where fact.license_namespace = target_namespace
      and fact.profile_id is not null
      and fact.fact_kind in ('subscription', 'manual')
  ),
  profile_models as (
    select
      profile_id,
      case
        when count(distinct commerce_model) = 1 then min(commerce_model)
        else 'mixed'
      end as commerce_model
    from profile_relationship_models
    group by profile_id
  ),
  profile_dates as (
    select
      fact.profile_id,
      min(fact.first_paid_at) as first_paid_at,
      max(fact.last_paid_at) as last_paid_at,
      min(fact.first_upgraded_at) as first_upgraded_at,
      max(fact.last_upgraded_at) as last_upgraded_at
    from public.sidestream_customer_commerce_materializations fact
    where fact.license_namespace = target_namespace
      and fact.profile_id is not null
      and fact.fact_kind in ('payment', 'subscription', 'manual')
    group by fact.profile_id
  ),
  profile_facts as (
    select
      model.profile_id,
      model.commerce_model,
      dates.first_paid_at,
      dates.last_paid_at,
      dates.first_upgraded_at,
      dates.last_upgraded_at
    from profile_models model
    left join profile_dates dates on dates.profile_id = model.profile_id
  )
  update public.sidestream_customer_profiles profile
  set commerce_model = facts.commerce_model,
      first_paid_at = facts.first_paid_at,
      last_paid_at = facts.last_paid_at,
      first_upgraded_at = facts.first_upgraded_at,
      last_upgraded_at = facts.last_upgraded_at,
      commerce_synced_at = clock_timestamp(),
      updated_at = now()
  from profile_facts facts
  where profile.id = facts.profile_id
    and profile.license_namespace = target_namespace
    and profile.merged_into is null;
end;
$$;

create or replace function public.sidestream_customer_commerce_apply(
  observations jsonb
)
returns jsonb
language plpgsql
as $$
declare
  item jsonb;
  item_namespace text;
  target_namespace text;
  canonical_key text;
  prior_keys text[];
  resolved_profile uuid;
  group_profile uuid;
  identity_profile_count integer;
  strong_identity_profile_count integer;
  group_profile_count integer;
  strong_resolved_profile uuid;
  has_identity_conflict boolean;
  existing_event_created_at timestamptz;
  existing_event_id text;
  is_newer boolean;
  applied_count integer := 0;
  stale_count integer := 0;
begin
  if jsonb_typeof(observations) <> 'array' or jsonb_array_length(observations) = 0 then
    raise exception 'Customer commerce observations must be a non-empty array'
      using errcode = '22023';
  end if;

  target_namespace := observations->0->>'licenseNamespace';
  if target_namespace not in ('production', 'test') then
    raise exception 'Invalid Customer commerce namespace' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(
    hashtext('sidestream_customer_commerce:' || target_namespace)
  );

  for item in select value from jsonb_array_elements(observations) loop
    item_namespace := item->>'licenseNamespace';
    if item_namespace is distinct from target_namespace then
      raise exception 'A commerce projection cannot cross namespaces'
        using errcode = '23514';
    end if;

    select array_agg(distinct alias.payment_key)
    into prior_keys
    from public.sidestream_customer_commerce_aliases alias
    where alias.license_namespace = target_namespace
      and exists (
        select 1
        from jsonb_array_elements(coalesce(item->'aliases', '[]'::jsonb)) candidate
        where candidate->>'aliasType' = alias.alias_type
          and candidate->>'aliasId' = alias.alias_id
      );

    select candidate.payment_key
    into canonical_key
    from (
      select unnest(coalesce(prior_keys, array[]::text[])) as payment_key
      union
      select (alias->>'aliasType') || ':' || (alias->>'aliasId')
      from jsonb_array_elements(coalesce(item->'aliases', '[]'::jsonb)) alias
    ) candidate
    order by
      public.sidestream_customer_commerce_key_priority(candidate.payment_key),
      candidate.payment_key
    limit 1;

    if canonical_key is null or canonical_key = '' then
      raise exception 'Customer commerce observation has no payment alias'
        using errcode = '22023';
    end if;

    if prior_keys is not null then
      update public.sidestream_customer_commerce_aliases
      set payment_key = canonical_key,
          updated_at = now()
      where license_namespace = target_namespace
        and payment_key = any(prior_keys)
        and payment_key <> canonical_key;

      update public.sidestream_customer_commerce_materializations
      set payment_key = canonical_key,
          updated_at = now()
      where license_namespace = target_namespace
        and payment_key = any(prior_keys)
        and payment_key <> canonical_key;
    end if;

    insert into public.sidestream_customer_commerce_aliases (
      license_namespace,
      alias_type,
      alias_id,
      payment_key,
      first_event_id,
      created_at,
      updated_at
    )
    select
      target_namespace,
      alias->>'aliasType',
      alias->>'aliasId',
      canonical_key,
      item->>'eventId',
      now(),
      now()
    from jsonb_array_elements(coalesce(item->'aliases', '[]'::jsonb)) alias
    on conflict (license_namespace, alias_type, alias_id) do update
    set payment_key = excluded.payment_key,
        updated_at = now();

    select
      count(distinct profile.id)::integer,
      case when count(distinct profile.id) = 1
        then (array_agg(distinct profile.id))[1]
      end
    into identity_profile_count, resolved_profile
    from public.sidestream_customer_identity_links link
    join public.sidestream_customer_profiles profile
      on profile.id = link.profile_id
      and profile.license_namespace = link.license_namespace
      and profile.merged_into is null
    where link.license_namespace = target_namespace
      and exists (
        select 1
        from jsonb_array_elements(
          coalesce(item->'identityEvidence', '[]'::jsonb)
        ) evidence
        where evidence->>'linkType' = link.link_type
          and evidence->>'linkValue' = link.link_value
      );

    select
      count(distinct profile.id)::integer,
      case when count(distinct profile.id) = 1
        then (array_agg(distinct profile.id))[1]
      end
    into strong_identity_profile_count, strong_resolved_profile
    from public.sidestream_customer_identity_links link
    join public.sidestream_customer_profiles profile
      on profile.id = link.profile_id
      and profile.license_namespace = link.license_namespace
      and profile.merged_into is null
    where link.license_namespace = target_namespace
      and link.link_type in (
        'stripe_checkout_session',
        'stripe_payment_intent',
        'stripe_subscription'
      )
      and exists (
        select 1
        from jsonb_array_elements(
          coalesce(item->'identityEvidence', '[]'::jsonb)
        ) evidence
        where evidence->>'linkType' = link.link_type
          and evidence->>'linkValue' = link.link_value
      );

    select
      count(distinct profile_id)::integer,
      case when count(distinct profile_id) = 1
        then (array_agg(distinct profile_id))[1]
      end
    into group_profile_count, group_profile
    from public.sidestream_customer_commerce_materializations
    where license_namespace = target_namespace
      and payment_key = canonical_key
      and profile_id is not null;

    has_identity_conflict := identity_profile_count > 1
      or group_profile_count > 1
      or (
        identity_profile_count = 1
        and group_profile_count = 1
        and resolved_profile <> group_profile
      );

    if has_identity_conflict then
      resolved_profile := null;
    elsif strong_identity_profile_count = 1 then
      resolved_profile := strong_resolved_profile;
    elsif group_profile_count = 1 then
      resolved_profile := group_profile;
    else
      resolved_profile := null;
    end if;

    select fact.event_created_at, fact.event_id
    into existing_event_created_at, existing_event_id
    from public.sidestream_customer_commerce_materializations fact
    where fact.license_namespace = target_namespace
      and fact.source_object_type = item->>'sourceObjectType'
      and fact.source_object_id = item->>'sourceObjectId';

    is_newer := existing_event_created_at is null
      or existing_event_created_at < (item->>'eventCreatedAt')::timestamptz
      or (
        existing_event_created_at = (item->>'eventCreatedAt')::timestamptz
        and existing_event_id < item->>'eventId'
      );

    if is_newer then
      applied_count := applied_count + 1;
    else
      stale_count := stale_count + 1;
    end if;

    insert into public.sidestream_customer_commerce_materializations (
      license_namespace,
      profile_id,
      event_id,
      event_type,
      event_created_at,
      source_object_type,
      source_object_id,
      fact_kind,
      commerce_model,
      state,
      currency,
      gross_paid_minor,
      discount_minor,
      tax_minor,
      refunded_minor,
      disputed_minor,
      inquiry_minor,
      net_paid_minor,
      first_paid_at,
      last_paid_at,
      first_upgraded_at,
      last_upgraded_at,
      first_inferred_paid_at,
      last_inferred_paid_at,
      first_inferred_upgraded_at,
      last_inferred_upgraded_at,
      object_created_at,
      effective_at,
      billing_period_start,
      billing_period_end,
      timestamp_source,
      source,
      source_confidence,
      payment_key,
      identity_evidence,
      identity_conflict,
      created_at,
      updated_at
    ) values (
      target_namespace,
      resolved_profile,
      item->>'eventId',
      item->>'eventType',
      (item->>'eventCreatedAt')::timestamptz,
      item->>'sourceObjectType',
      item->>'sourceObjectId',
      item->>'factKind',
      item->>'commerceModel',
      item->>'state',
      nullif(item->>'currency', ''),
      (item->>'grossPaidMinor')::bigint,
      (item->>'discountMinor')::bigint,
      (item->>'taxMinor')::bigint,
      (item->>'refundedMinor')::bigint,
      (item->>'disputedMinor')::bigint,
      (item->>'inquiryMinor')::bigint,
      (item->>'netPaidMinor')::bigint,
      case when item->>'sourceConfidence' = 'verified'
        then (item->>'paidAt')::timestamptz end,
      case when item->>'sourceConfidence' = 'verified'
        then (item->>'paidAt')::timestamptz end,
      case when item->>'sourceConfidence' = 'verified'
        then (item->>'upgradedAt')::timestamptz end,
      case when item->>'sourceConfidence' = 'verified'
        then (item->>'upgradedAt')::timestamptz end,
      case when item->>'sourceConfidence' = 'legacy_inferred'
        then (item->>'paidAt')::timestamptz end,
      case when item->>'sourceConfidence' = 'legacy_inferred'
        then (item->>'paidAt')::timestamptz end,
      case when item->>'sourceConfidence' = 'legacy_inferred'
        then (item->>'upgradedAt')::timestamptz end,
      case when item->>'sourceConfidence' = 'legacy_inferred'
        then (item->>'upgradedAt')::timestamptz end,
      (item->>'objectCreatedAt')::timestamptz,
      (item->>'effectiveAt')::timestamptz,
      (item->>'billingPeriodStart')::timestamptz,
      (item->>'billingPeriodEnd')::timestamptz,
      item->>'timestampSource',
      item->>'source',
      item->>'sourceConfidence',
      canonical_key,
      coalesce(item->'identityEvidence', '[]'::jsonb),
      has_identity_conflict,
      now(),
      now()
    )
    on conflict (license_namespace, source_object_type, source_object_id) do update
    set profile_id = case
          when not is_newer
            and public.sidestream_customer_commerce_materializations.identity_conflict
            then public.sidestream_customer_commerce_materializations.profile_id
          when is_newer and excluded.identity_conflict then null
          when public.sidestream_customer_commerce_materializations.profile_id is null
            then excluded.profile_id
          else public.sidestream_customer_commerce_materializations.profile_id
        end,
        event_id = case when is_newer then excluded.event_id
          else public.sidestream_customer_commerce_materializations.event_id end,
        event_type = case when is_newer then excluded.event_type
          else public.sidestream_customer_commerce_materializations.event_type end,
        event_created_at = case when is_newer then excluded.event_created_at
          else public.sidestream_customer_commerce_materializations.event_created_at end,
        fact_kind = case when is_newer then excluded.fact_kind
          else public.sidestream_customer_commerce_materializations.fact_kind end,
        commerce_model = case when is_newer then excluded.commerce_model
          else public.sidestream_customer_commerce_materializations.commerce_model end,
        state = case when is_newer then excluded.state
          else public.sidestream_customer_commerce_materializations.state end,
        currency = case when is_newer then excluded.currency
          else public.sidestream_customer_commerce_materializations.currency end,
        gross_paid_minor = case when is_newer then excluded.gross_paid_minor
          else public.sidestream_customer_commerce_materializations.gross_paid_minor end,
        discount_minor = case when is_newer then excluded.discount_minor
          else public.sidestream_customer_commerce_materializations.discount_minor end,
        tax_minor = case when is_newer then excluded.tax_minor
          else public.sidestream_customer_commerce_materializations.tax_minor end,
        refunded_minor = case when is_newer then excluded.refunded_minor
          else public.sidestream_customer_commerce_materializations.refunded_minor end,
        disputed_minor = case when is_newer then excluded.disputed_minor
          else public.sidestream_customer_commerce_materializations.disputed_minor end,
        inquiry_minor = case when is_newer then excluded.inquiry_minor
          else public.sidestream_customer_commerce_materializations.inquiry_minor end,
        net_paid_minor = case when is_newer then excluded.net_paid_minor
          else public.sidestream_customer_commerce_materializations.net_paid_minor end,
        first_paid_at = case
          when not is_newer
            then public.sidestream_customer_commerce_materializations.first_paid_at
          when public.sidestream_customer_commerce_materializations.first_paid_at is null
            then excluded.first_paid_at
          when excluded.first_paid_at is null
            then public.sidestream_customer_commerce_materializations.first_paid_at
          else least(
            public.sidestream_customer_commerce_materializations.first_paid_at,
            excluded.first_paid_at
          )
        end,
        last_paid_at = case
          when not is_newer
            then public.sidestream_customer_commerce_materializations.last_paid_at
          when public.sidestream_customer_commerce_materializations.last_paid_at is null
            then excluded.last_paid_at
          when excluded.last_paid_at is null
            then public.sidestream_customer_commerce_materializations.last_paid_at
          else greatest(
            public.sidestream_customer_commerce_materializations.last_paid_at,
            excluded.last_paid_at
          )
        end,
        first_upgraded_at = case
          when not is_newer
            then public.sidestream_customer_commerce_materializations.first_upgraded_at
          when public.sidestream_customer_commerce_materializations.first_upgraded_at is null
            then excluded.first_upgraded_at
          when excluded.first_upgraded_at is null
            then public.sidestream_customer_commerce_materializations.first_upgraded_at
          else least(
            public.sidestream_customer_commerce_materializations.first_upgraded_at,
            excluded.first_upgraded_at
          )
        end,
        last_upgraded_at = case
          when not is_newer
            then public.sidestream_customer_commerce_materializations.last_upgraded_at
          when public.sidestream_customer_commerce_materializations.last_upgraded_at is null
            then excluded.last_upgraded_at
          when excluded.last_upgraded_at is null
            then public.sidestream_customer_commerce_materializations.last_upgraded_at
          else greatest(
            public.sidestream_customer_commerce_materializations.last_upgraded_at,
            excluded.last_upgraded_at
          )
        end,
        first_inferred_paid_at = case
          when not is_newer
            then public.sidestream_customer_commerce_materializations.first_inferred_paid_at
          when public.sidestream_customer_commerce_materializations.first_inferred_paid_at is null
            then excluded.first_inferred_paid_at
          when excluded.first_inferred_paid_at is null
            then public.sidestream_customer_commerce_materializations.first_inferred_paid_at
          else least(
            public.sidestream_customer_commerce_materializations.first_inferred_paid_at,
            excluded.first_inferred_paid_at
          )
        end,
        last_inferred_paid_at = case
          when not is_newer
            then public.sidestream_customer_commerce_materializations.last_inferred_paid_at
          when public.sidestream_customer_commerce_materializations.last_inferred_paid_at is null
            then excluded.last_inferred_paid_at
          when excluded.last_inferred_paid_at is null
            then public.sidestream_customer_commerce_materializations.last_inferred_paid_at
          else greatest(
            public.sidestream_customer_commerce_materializations.last_inferred_paid_at,
            excluded.last_inferred_paid_at
          )
        end,
        first_inferred_upgraded_at = case
          when not is_newer
            then public.sidestream_customer_commerce_materializations.first_inferred_upgraded_at
          when public.sidestream_customer_commerce_materializations.first_inferred_upgraded_at is null
            then excluded.first_inferred_upgraded_at
          when excluded.first_inferred_upgraded_at is null
            then public.sidestream_customer_commerce_materializations.first_inferred_upgraded_at
          else least(
            public.sidestream_customer_commerce_materializations.first_inferred_upgraded_at,
            excluded.first_inferred_upgraded_at
          )
        end,
        last_inferred_upgraded_at = case
          when not is_newer
            then public.sidestream_customer_commerce_materializations.last_inferred_upgraded_at
          when public.sidestream_customer_commerce_materializations.last_inferred_upgraded_at is null
            then excluded.last_inferred_upgraded_at
          when excluded.last_inferred_upgraded_at is null
            then public.sidestream_customer_commerce_materializations.last_inferred_upgraded_at
          else greatest(
            public.sidestream_customer_commerce_materializations.last_inferred_upgraded_at,
            excluded.last_inferred_upgraded_at
          )
        end,
        object_created_at = case when is_newer then excluded.object_created_at
          else public.sidestream_customer_commerce_materializations.object_created_at end,
        effective_at = case when is_newer then excluded.effective_at
          else public.sidestream_customer_commerce_materializations.effective_at end,
        billing_period_start = case when is_newer then excluded.billing_period_start
          else public.sidestream_customer_commerce_materializations.billing_period_start end,
        billing_period_end = case when is_newer then excluded.billing_period_end
          else public.sidestream_customer_commerce_materializations.billing_period_end end,
        timestamp_source = case when is_newer then excluded.timestamp_source
          else public.sidestream_customer_commerce_materializations.timestamp_source end,
        source = case when is_newer then excluded.source
          else public.sidestream_customer_commerce_materializations.source end,
        source_confidence = case when is_newer then excluded.source_confidence
          else public.sidestream_customer_commerce_materializations.source_confidence end,
        payment_key = canonical_key,
        identity_evidence = case when is_newer then excluded.identity_evidence
          else public.sidestream_customer_commerce_materializations.identity_evidence end,
        identity_conflict = case when is_newer then excluded.identity_conflict
          else public.sidestream_customer_commerce_materializations.identity_conflict end,
        updated_at = now();
  end loop;

  -- A later alias-bearing object can attach refund/dispute facts that arrived
  -- first and had only a charge reference.
  with one_owner as (
    select payment_key, (array_agg(distinct profile_id))[1] as profile_id
    from public.sidestream_customer_commerce_materializations
    where license_namespace = target_namespace
      and profile_id is not null
    group by payment_key
    having count(distinct profile_id) = 1
  )
  update public.sidestream_customer_commerce_materializations fact
  set profile_id = owner.profile_id,
      updated_at = now()
  from one_owner owner
  where fact.license_namespace = target_namespace
    and fact.payment_key = owner.payment_key
    and fact.profile_id is null
    and not fact.identity_conflict;

  perform public.sidestream_customer_commerce_refresh_namespace(target_namespace);
  return jsonb_build_object(
    'applied', applied_count,
    'stale', stale_count,
    'licenseNamespace', target_namespace
  );
end;
$$;

create or replace function public.sidestream_customer_commerce_identity_attach()
returns trigger
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(
    hashtext('sidestream_customer_commerce:' || new.license_namespace)
  );
  with unambiguous_owner as (
    select
      fact.id as fact_id,
      (array_agg(distinct profile.id))[1] as profile_id
    from public.sidestream_customer_commerce_materializations fact
    join lateral jsonb_array_elements(fact.identity_evidence) evidence on true
    join public.sidestream_customer_identity_links link
      on link.license_namespace = fact.license_namespace
      and link.link_type = evidence->>'linkType'
      and link.link_value = evidence->>'linkValue'
    join public.sidestream_customer_profiles profile
      on profile.id = link.profile_id
      and profile.license_namespace = link.license_namespace
      and profile.merged_into is null
    where fact.license_namespace = new.license_namespace
      and fact.profile_id is null
    group by fact.id
    having count(distinct profile.id) = 1
      and bool_or(link.link_type in (
        'stripe_checkout_session',
        'stripe_payment_intent',
        'stripe_subscription'
      ))
  )
  update public.sidestream_customer_commerce_materializations fact
  set profile_id = owner.profile_id,
      identity_conflict = false,
      updated_at = now()
  from unambiguous_owner owner
  where fact.id = owner.fact_id;
  if found then
    perform public.sidestream_customer_commerce_refresh_namespace(new.license_namespace);
  end if;
  return new;
end;
$$;

create trigger sidestream_customer_commerce_identity_attach_trigger
after insert or update of profile_id
on public.sidestream_customer_identity_links
for each row execute function public.sidestream_customer_commerce_identity_attach();

create or replace function public.sidestream_customer_commerce_profile_merge()
returns trigger
language plpgsql
as $$
begin
  if old.merged_into is null and new.merged_into is not null then
    perform pg_advisory_xact_lock(
      hashtext('sidestream_customer_commerce:' || new.license_namespace)
    );
    update public.sidestream_customer_commerce_materializations
    set profile_id = new.merged_into,
        updated_at = now()
    where license_namespace = new.license_namespace
      and profile_id = new.id;
    perform public.sidestream_customer_commerce_refresh_namespace(new.license_namespace);
  end if;
  return new;
end;
$$;

create trigger sidestream_customer_commerce_profile_merge_trigger
after update of merged_into
on public.sidestream_customer_profiles
for each row execute function public.sidestream_customer_commerce_profile_merge();

comment on table public.sidestream_customer_commerce_materializations is
  'Mutable latest-state money materializations keyed by Stripe source object. sidestream_stripe_events durably preserves insert-only event_id, event_type, and stripe_created_at; its processing state is mutable and payload fields may be redacted. This table is not entitlement truth.';
comment on table public.sidestream_customer_money_totals is
  'Materialized money totals separated by customer profile, namespace, and ISO currency.';
comment on column public.sidestream_customer_commerce_materializations.source_confidence is
  'Confidence for the latest source-object timing. Verified canonical dates and legacy-inferred support dates are stored separately.';
comment on column public.sidestream_customer_commerce_materializations.first_inferred_upgraded_at is
  'Earliest legacy-inferred upgrade timing retained for support only; never used for canonical profile dates.';

alter table public.sidestream_customer_commerce_materializations enable row level security;
alter table public.sidestream_customer_commerce_aliases enable row level security;
alter table public.sidestream_customer_money_totals enable row level security;

revoke all on table public.sidestream_customer_commerce_materializations from public;
revoke all on table public.sidestream_customer_commerce_aliases from public;
revoke all on table public.sidestream_customer_money_totals from public;
revoke all on function public.sidestream_customer_commerce_key_priority(text) from public;
revoke all on function public.sidestream_customer_commerce_refresh_namespace(text) from public;
revoke all on function public.sidestream_customer_commerce_apply(jsonb) from public;
revoke all on function public.sidestream_customer_commerce_identity_attach() from public;
revoke all on function public.sidestream_customer_commerce_profile_merge() from public;

do $$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = api_role) then
      execute format(
        'revoke all on table public.sidestream_customer_commerce_materializations from %I',
        api_role
      );
      execute format(
        'revoke all on table public.sidestream_customer_commerce_aliases from %I',
        api_role
      );
      execute format(
        'revoke all on table public.sidestream_customer_money_totals from %I',
        api_role
      );
    end if;
  end loop;
end $$;

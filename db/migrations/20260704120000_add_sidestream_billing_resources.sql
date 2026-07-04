create table if not exists public.sidestream_billing_resources (
  resource_key text primary key,
  stripe_product_id text not null,
  stripe_price_id text not null,
  product_name text not null,
  product_description text,
  tax_code text not null,
  unit_amount integer not null,
  currency text not null,
  recurring_interval text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sidestream_billing_resources_product_unique unique (stripe_product_id),
  constraint sidestream_billing_resources_price_unique unique (stripe_price_id),
  constraint sidestream_billing_resources_unit_amount_positive check (unit_amount > 0),
  constraint sidestream_billing_resources_currency_normalized check (currency = lower(trim(currency)))
);

create index if not exists sidestream_billing_resources_price_idx
  on public.sidestream_billing_resources (stripe_price_id);

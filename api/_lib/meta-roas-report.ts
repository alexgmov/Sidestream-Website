import type { QueryResult, QueryResultRow } from "pg";
import { withPostgresTransaction } from "./postgres.js";

const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1_000;
const UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SAFE_DIMENSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MISSING_CREATIVE = "__missing_creative__";

type Namespace = "production" | "test";
type ReportInput = Readonly<{
  licenseNamespace: Namespace;
  from: string;
  through: string;
  asOf: string;
  campaign: string | null;
}>;
type QueryClient = Readonly<{
  query<Row extends QueryResultRow = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}>;
type Dependencies = Readonly<{
  transaction: <T>(callback: (client: QueryClient) => Promise<T>) => Promise<T>;
}>;
type TrafficRow = QueryResultRow & Readonly<{
  campaign: string;
  creative_key: string | null;
  acquisition_count: string | number | bigint;
  landing_count: string | number | bigint;
  email_handoff_count: string | number | bigint;
  installer_request_count: string | number | bigint;
  installation_claim_count: string | number | bigint;
  authentication_count: string | number | bigint;
  checkout_start_count: string | number | bigint;
  checkout_complete_count: string | number | bigint;
  payment_stage_count: string | number | bigint;
}>;
type PurchaseRow = QueryResultRow & Readonly<{
  campaign: string;
  creative_key: string | null;
  currency: string;
  purchased_customer_count: string | number | bigint;
  net_revenue_minor: string | number | bigint;
}>;
type SpendRow = QueryResultRow & Readonly<{
  campaign: string;
  creative_key: string;
  currency: string;
  spend_minor: string | number | bigint;
  impressions: string | number | bigint;
  clicks: string | number | bigint;
  spend_days: string | number | bigint;
  latest_imported_at: Date | string;
}>;

export class MetaRoasReportValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MetaRoasReportValidationError";
    this.code = code;
  }
}

export const META_ROAS_TRAFFIC_SQL = `
  select
    acquisition.first_observed_campaign as campaign,
    acquisition.first_observed_content_creative as creative_key,
    count(distinct acquisition.id)::bigint as acquisition_count,
    count(distinct stage.deduplication_key) filter (
      where stage.stage = 'landing_observed'
    )::bigint as landing_count,
    count(distinct stage.deduplication_key) filter (
      where stage.stage = 'email_handoff_created'
    )::bigint as email_handoff_count,
    count(distinct stage.deduplication_key) filter (
      where stage.stage = 'installer_requested'
    )::bigint as installer_request_count,
    count(distinct stage.deduplication_key) filter (
      where stage.stage = 'installation_claimed'
    )::bigint as installation_claim_count,
    count(distinct stage.deduplication_key) filter (
      where stage.stage = 'authentication_completed'
    )::bigint as authentication_count,
    count(distinct stage.deduplication_key) filter (
      where stage.stage = 'checkout_started'
    )::bigint as checkout_start_count,
    count(distinct stage.deduplication_key) filter (
      where stage.stage = 'checkout_completed'
    )::bigint as checkout_complete_count,
    count(distinct stage.deduplication_key) filter (
      where stage.stage = 'payment_settled'
    )::bigint as payment_stage_count
  from public.sidestream_acquisitions acquisition
  left join public.sidestream_acquisition_stages stage
    on stage.acquisition_id = acquisition.id
    and stage.license_namespace = acquisition.license_namespace
    and stage.occurred_at < $4::timestamptz
  where acquisition.license_namespace = $1
    and acquisition.first_observed_source = 'meta'
    and acquisition.first_observed_medium in ('social', 'paid_social')
    and acquisition.first_observed_at >= $2::timestamptz
    and acquisition.first_observed_at < $3::timestamptz
    and acquisition.first_observed_at < $4::timestamptz
    and acquisition.integrity_state <> 'quarantined'
    and ($5::text is null or acquisition.first_observed_campaign = $5)
  group by
    acquisition.first_observed_campaign,
    acquisition.first_observed_content_creative
  order by acquisition.first_observed_campaign, acquisition.first_observed_content_creative
`;

export const META_ROAS_PURCHASE_SQL = `
  with cohort_acquisitions as (
    select acquisition.*
    from public.sidestream_acquisitions acquisition
    where acquisition.license_namespace = $1
      and acquisition.first_observed_source = 'meta'
      and acquisition.first_observed_medium in ('social', 'paid_social')
      and acquisition.first_observed_at >= $2::timestamptz
      and acquisition.first_observed_at < $3::timestamptz
      and acquisition.first_observed_at < $4::timestamptz
      and acquisition.integrity_state <> 'quarantined'
      and ($5::text is null or acquisition.first_observed_campaign = $5)
  ),
  profile_edges as (
    select distinct
      acquisition.id as acquisition_id,
      link.profile_id,
      1 as linkage_priority,
      intent.created_at as intent_created_at
    from cohort_acquisitions acquisition
    join public.sidestream_checkout_intents intent
      on intent.acquisition_id = acquisition.id
    join public.sidestream_customer_identity_links link
      on link.license_namespace = acquisition.license_namespace
      and (
        (link.link_type = 'account_identity' and link.link_value = intent.account_id::text)
        or (
          link.link_type = 'activation_record'
          and intent.activation_session_id is not null
          and link.link_value = intent.activation_session_id::text
        )
        or (
          link.link_type = 'stripe_checkout_session'
          and intent.stripe_checkout_session_id is not null
          and link.link_value = intent.stripe_checkout_session_id
        )
      )

    union all

    select distinct
      acquisition.id as acquisition_id,
      materialization.profile_id,
      0 as linkage_priority,
      intent.created_at as intent_created_at
    from cohort_acquisitions acquisition
    join public.sidestream_checkout_intents intent
      on intent.acquisition_id = acquisition.id
      and intent.stripe_checkout_session_id is not null
    join public.sidestream_customer_commerce_aliases alias
      on alias.license_namespace = acquisition.license_namespace
      and alias.alias_type = 'checkout_session'
      and alias.alias_id = intent.stripe_checkout_session_id
    join public.sidestream_customer_commerce_materializations materialization
      on materialization.license_namespace = alias.license_namespace
      and materialization.payment_key = alias.payment_key
      and materialization.profile_id is not null
      and not materialization.identity_conflict
  ),
  purchase_candidates as (
    select
      acquisition.first_observed_campaign as campaign,
      acquisition.first_observed_content_creative as creative_key,
      money.profile_id,
      money.currency,
      money.net_paid_minor,
      row_number() over (
        partition by money.profile_id, money.currency
        order by
          edge.linkage_priority,
          edge.intent_created_at desc,
          acquisition.first_observed_at desc,
          acquisition.id
      ) as selected_order
    from profile_edges edge
    join cohort_acquisitions acquisition on acquisition.id = edge.acquisition_id
    join public.sidestream_customer_profiles profile
      on profile.id = edge.profile_id
      and profile.license_namespace = acquisition.license_namespace
      and profile.merged_into is null
    join public.sidestream_customer_money_totals money
      on money.profile_id = profile.id
      and money.license_namespace = profile.license_namespace
      and money.net_paid_minor > 0
      and money.first_paid_at is not null
      and money.first_paid_at < $4::timestamptz
      and acquisition.first_observed_at <= money.first_paid_at
  )
  select
    campaign,
    creative_key,
    currency,
    count(distinct profile_id)::bigint as purchased_customer_count,
    sum(net_paid_minor)::bigint as net_revenue_minor
  from purchase_candidates
  where selected_order = 1
  group by campaign, creative_key, currency
  order by campaign, creative_key, currency
`;

export const META_ROAS_SPEND_SQL = `
  select
    campaign,
    creative_key,
    currency,
    sum(spend_minor)::bigint as spend_minor,
    sum(impressions)::bigint as impressions,
    sum(clicks)::bigint as clicks,
    count(distinct spend_day)::bigint as spend_days,
    max(imported_at) as latest_imported_at
  from public.sidestream_meta_ad_spend_daily
  where license_namespace = $1
    and spend_day >= ($2::timestamptz at time zone 'UTC')::date
    and spend_day < ($3::timestamptz at time zone 'UTC')::date
    and $4::timestamptz >= $3::timestamptz
    and ($5::text is null or campaign = $5)
  group by campaign, creative_key, currency
  order by campaign, creative_key, currency
`;

const defaultDependencies: Dependencies = {
  transaction: (callback) => withPostgresTransaction(callback, {
    isolationLevel: "repeatable read",
    readOnly: true,
  }),
};

export async function queryMetaRoasReport(
  request: unknown,
  overrides: Partial<Dependencies> = {},
) {
  const input = parseMetaRoasReportRequest(request);
  const dependencies = { ...defaultDependencies, ...overrides };
  const parameters = [
    input.licenseNamespace,
    input.from,
    input.through,
    input.asOf,
    input.campaign,
  ] as const;

  return dependencies.transaction(async (client) => {
    const traffic = await client.query<TrafficRow>(META_ROAS_TRAFFIC_SQL, parameters);
    const purchases = await client.query<PurchaseRow>(META_ROAS_PURCHASE_SQL, parameters);
    const spend = await client.query<SpendRow>(META_ROAS_SPEND_SQL, parameters);
    return buildMetaRoasReport(input, traffic.rows, purchases.rows, spend.rows);
  });
}

export function buildMetaRoasReport(
  input: ReportInput,
  trafficRows: readonly TrafficRow[],
  purchaseRows: readonly PurchaseRow[],
  spendRows: readonly SpendRow[],
) {
  const creativeMap = new Map<string, {
    campaign: string;
    creativeKey: string | null;
    traffic: ReturnType<typeof emptyTraffic>;
    currencies: Map<string, ReturnType<typeof emptyMoney>>;
  }>();
  const keyFor = (campaign: string, creative: string | null) =>
    `${campaign}\u0000${creative || MISSING_CREATIVE}`;
  const getCreative = (campaign: string, creative: string | null) => {
    const key = keyFor(campaign, creative);
    let row = creativeMap.get(key);
    if (!row) {
      row = {
        campaign,
        creativeKey: creative,
        traffic: emptyTraffic(),
        currencies: new Map(),
      };
      creativeMap.set(key, row);
    }
    return row;
  };
  const getMoney = (campaign: string, creative: string | null, currency: string) => {
    const row = getCreative(campaign, creative);
    let money = row.currencies.get(currency);
    if (!money) {
      money = emptyMoney(currency);
      row.currencies.set(currency, money);
    }
    return money;
  };

  for (const row of trafficRows) {
    getCreative(row.campaign, row.creative_key).traffic = {
      acquisitions: decimal(row.acquisition_count),
      landingObserved: decimal(row.landing_count),
      emailHandoffs: decimal(row.email_handoff_count),
      installerRequests: decimal(row.installer_request_count),
      installationClaims: decimal(row.installation_claim_count),
      authentications: decimal(row.authentication_count),
      checkoutStarts: decimal(row.checkout_start_count),
      checkoutCompletions: decimal(row.checkout_complete_count),
      paymentStages: decimal(row.payment_stage_count),
    };
  }
  for (const row of purchaseRows) {
    const money = getMoney(row.campaign, row.creative_key, row.currency);
    money.purchasedCustomers = decimal(row.purchased_customer_count);
    money.netRevenueMinor = decimal(row.net_revenue_minor);
  }
  for (const row of spendRows) {
    const money = getMoney(row.campaign, row.creative_key, row.currency);
    money.spendMinor = decimal(row.spend_minor);
    money.impressions = decimal(row.impressions);
    money.clicks = decimal(row.clicks);
    money.spendDays = decimal(row.spend_days);
    money.latestImportedAt = iso(row.latest_imported_at);
  }

  const creatives = [...creativeMap.values()].map((row) => ({
    campaign: row.campaign,
    creativeKey: row.creativeKey,
    traffic: row.traffic,
    moneyByCurrency: [...row.currencies.values()]
      .map((money) => finalizeMoney(money, row.traffic.acquisitions !== "0"))
      .sort((left, right) => left.currency.localeCompare(right.currency)),
  })).sort((left, right) =>
    left.campaign.localeCompare(right.campaign) ||
    String(left.creativeKey || "").localeCompare(String(right.creativeKey || ""))
  );

  const currencyTotals = new Map<string, ReturnType<typeof emptyMoney>>();
  for (const creative of creatives) {
    for (const money of creative.moneyByCurrency) {
      let total = currencyTotals.get(money.currency);
      if (!total) {
        total = emptyMoney(money.currency);
        currencyTotals.set(money.currency, total);
      }
      total.purchasedCustomers = addDecimal(total.purchasedCustomers, money.purchasedCustomers);
      total.netRevenueMinor = addDecimal(total.netRevenueMinor, money.netRevenueMinor);
      total.spendMinor = addDecimal(total.spendMinor, money.spendMinor);
      total.impressions = addDecimal(total.impressions, money.impressions);
      total.clicks = addDecimal(total.clicks, money.clicks);
      total.spendDays = addDecimal(total.spendDays, money.spendDays);
      if (money.latestImportedAt && (!total.latestImportedAt || money.latestImportedAt > total.latestImportedAt)) {
        total.latestImportedAt = money.latestImportedAt;
      }
    }
  }

  const trafficTotals = creatives.reduce((sum, row) => addTraffic(sum, row.traffic), emptyTraffic());
  const moneyRows = creatives.flatMap((row) => row.moneyByCurrency.map((money) => ({ row, money })));
  return {
    schemaVersion: 1,
    platform: "meta",
    namespace: input.licenseNamespace,
    generatedAt: new Date().toISOString(),
    dateWindow: {
      acquisitionStart: input.from,
      acquisitionEnd: input.through,
      spendStart: input.from,
      spendEnd: input.through,
      observationAsOf: input.asOf,
    },
    campaignFilter: input.campaign,
    totals: {
      traffic: trafficTotals,
      byCurrency: [...currencyTotals.values()].map((money) => finalizeMoney(money))
        .sort((left, right) => left.currency.localeCompare(right.currency)),
    },
    integrity: {
      missingCreativeAcquisitions: creatives
        .filter((row) => row.creativeKey === null)
        .reduce((sum, row) => addDecimal(sum, row.traffic.acquisitions), "0"),
      creativeCurrencyRowsReady: moneyRows.filter(({ money }) => money.status === "ready").length,
      creativeCurrencyRowsMissingSpend: creatives.filter((row) =>
        row.traffic.acquisitions !== "0" &&
        (row.moneyByCurrency.length === 0 || row.moneyByCurrency.every((money) => money.spendMinor === "0"))).length,
      creativeCurrencyRowsSpendWithoutAcquisition: moneyRows.filter(({ row, money }) =>
        row.traffic.acquisitions === "0" && money.spendMinor !== "0").length,
    },
    reportDefinition: {
      attributionModel: "exact_checkout_linked_meta_acquisition",
      creativeKey: "canonical_first_observed_utm_content",
      recommendedMetaUrlParameter: "utm_content={{ad.id}}",
      purchaseCountingGrain: "distinct_live_customer_profile_per_currency",
      revenue: "current_net_verified_customer_money_as_of_report",
      spend: "operator_imported_meta_daily_minor_units",
      currencyHandling: "isolated_no_cross_currency_total",
      roas: "net_revenue_minor_divided_by_spend_minor",
      observation: "acquisition_cohort_with_outcomes_observed_through_as_of",
    },
    creatives,
  };
}

export function parseMetaRoasReportRequest(value: unknown): ReportInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MetaRoasReportValidationError("invalid_request", "Request body must be an object");
  }
  const body = value as Record<string, unknown>;
  const allowed = ["licenseNamespace", "from", "through", "asOf", "campaign"];
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) throw new MetaRoasReportValidationError("invalid_request", `Unsupported field: ${unknown}`);
  if (body.licenseNamespace !== "production" && body.licenseNamespace !== "test") {
    throw new MetaRoasReportValidationError("invalid_namespace", "licenseNamespace must be production or test");
  }
  const from = timestamp(body.from, "from");
  const through = timestamp(body.through, "through");
  const asOf = timestamp(body.asOf, "asOf");
  const fromMs = Date.parse(from);
  const throughMs = Date.parse(through);
  const asOfMs = Date.parse(asOf);
  if (throughMs <= fromMs || throughMs - fromMs > MAX_WINDOW_MS || asOfMs < throughMs) {
    throw new MetaRoasReportValidationError(
      "invalid_window",
      "through must be after from, within 366 days, and no later than asOf",
    );
  }
  const campaign = body.campaign === undefined || body.campaign === null
    ? null
    : String(body.campaign);
  if (campaign !== null && !SAFE_DIMENSION_PATTERN.test(campaign)) {
    throw new MetaRoasReportValidationError("invalid_campaign", "campaign is invalid");
  }
  return { licenseNamespace: body.licenseNamespace, from, through, asOf, campaign };
}

function emptyTraffic() {
  return {
    acquisitions: "0",
    landingObserved: "0",
    emailHandoffs: "0",
    installerRequests: "0",
    installationClaims: "0",
    authentications: "0",
    checkoutStarts: "0",
    checkoutCompletions: "0",
    paymentStages: "0",
  };
}

function emptyMoney(currency: string) {
  return {
    currency,
    purchasedCustomers: "0",
    netRevenueMinor: "0",
    spendMinor: "0",
    impressions: "0",
    clicks: "0",
    spendDays: "0",
    latestImportedAt: null as string | null,
  };
}

function finalizeMoney(value: ReturnType<typeof emptyMoney>, hasAcquisition = true) {
  const spend = BigInt(value.spendMinor);
  const revenue = BigInt(value.netRevenueMinor);
  const customers = BigInt(value.purchasedCustomers);
  return {
    ...value,
    roas: spend > 0n ? ratio(revenue, spend) : null,
    cacMinor: customers > 0n && spend > 0n ? ratio(spend, customers) : null,
    status: spend === 0n
      ? "missing_spend"
      : hasAcquisition
        ? "ready"
        : "spend_without_acquisition",
  };
}

function addTraffic(left: ReturnType<typeof emptyTraffic>, right: ReturnType<typeof emptyTraffic>) {
  return Object.fromEntries(Object.keys(left).map((key) => [
    key,
    addDecimal(left[key as keyof typeof left], right[key as keyof typeof right]),
  ])) as ReturnType<typeof emptyTraffic>;
}

function decimal(value: unknown) {
  try {
    return BigInt(String(value ?? 0)).toString();
  } catch {
    throw new Error("Meta ROAS query returned an invalid count");
  }
}

function addDecimal(left: string, right: string) {
  return (BigInt(left) + BigInt(right)).toString();
}

function ratio(numerator: bigint, denominator: bigint) {
  return Number((numerator * 1_000_000n) / denominator) / 1_000_000;
}

function timestamp(value: unknown, field: string) {
  if (typeof value !== "string" || !UTC_TIMESTAMP_PATTERN.test(value)) {
    throw new MetaRoasReportValidationError("invalid_timestamp", `${field} must be a UTC timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new MetaRoasReportValidationError("invalid_timestamp", `${field} must be a UTC timestamp`);
  }
  return parsed.toISOString();
}

function iso(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Meta ROAS query returned an invalid timestamp");
  return date.toISOString();
}

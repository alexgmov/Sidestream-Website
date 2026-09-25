import type { QueryResult, QueryResultRow } from "pg";
import { withPostgresTransaction } from "./postgres.js";

const DAY = 86_400_000;
type Input = { licenseNamespace: "production" | "test"; from: string; through: string; asOf: string };
type Client = { query: <R extends QueryResultRow>(sql: string, values?: readonly unknown[]) => Promise<QueryResult<R>> };
type Row = QueryResultRow & { source: string; medium: string | null; campaign: string | null; content: string | null; referrer: string | null; visitors: string; downloads: string; checkouts: string; converted: string; cohort_buyers: string; buyers: string };
export class ChannelReportValidationError extends Error {}

export function parseChannelReportRequest(value: unknown): Input {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ChannelReportValidationError("invalid_request");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !["licenseNamespace", "from", "through", "asOf"].includes(key))) throw new ChannelReportValidationError("invalid_request");
  if (body.licenseNamespace !== "production" && body.licenseNamespace !== "test") throw new ChannelReportValidationError("invalid_namespace");
  const date = (key: string) => {
    const text = body[key];
    if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text) || !Number.isFinite(Date.parse(text))) throw new ChannelReportValidationError("invalid_date");
    const normalized = new Date(text).toISOString();
    if (normalized.slice(0, 19) !== text.slice(0, 19)) throw new ChannelReportValidationError("invalid_date");
    return normalized;
  };
  const from = date("from"), through = date("through"), asOf = date("asOf");
  if (from >= through || through > asOf || Date.parse(through) - Date.parse(from) > 366 * DAY || Date.parse(asOf) - Date.parse(from) > 730 * DAY || Date.parse(asOf) > Date.now() + 60_000) throw new ChannelReportValidationError("invalid_window");
  return { licenseNamespace: body.licenseNamespace, from, through, asOf };
}

// Only exact Checkout -> canonical payment aliases establish paid attribution.
// Resolve the first real payment before applying dates, so filters cannot move a buyer.
export const CHANNEL_REPORT_SQL = `
with payments as (
  select fact.profile_id, fact.payment_key, min(fact.first_paid_at) as paid_at
  from public.sidestream_customer_commerce_materializations fact
  join public.sidestream_customer_profiles profile on profile.id = fact.profile_id
    and profile.license_namespace = fact.license_namespace and profile.merged_into is null
  where fact.license_namespace = $1 and not fact.identity_conflict
    and fact.source_confidence = 'verified' and fact.gross_paid_minor > 0
    and fact.first_paid_at is not null and fact.first_paid_at < $4::timestamptz
  group by fact.profile_id, fact.payment_key
), first_payments as (
  select profile_id, min(paid_at) as paid_at from payments group by profile_id
), edges as (
  select distinct payment.profile_id, acquisition.id as acquisition_id, acquisition.integrity_state
  from payments payment
  join first_payments first on first.profile_id = payment.profile_id and first.paid_at = payment.paid_at
  join public.sidestream_customer_commerce_aliases alias
    on alias.license_namespace = $1 and alias.payment_key = payment.payment_key and alias.alias_type = 'checkout_session'
  join public.sidestream_checkout_intents intent on intent.stripe_checkout_session_id = alias.alias_id
  join public.sidestream_acquisitions acquisition on acquisition.id = intent.acquisition_id
    and acquisition.license_namespace = $1
    and acquisition.first_observed_at <= payment.paid_at
), resolved as (
  select profile_id, (array_agg(acquisition_id))[1] as acquisition_id
  from edges group by profile_id having count(*) = 1 and bool_and(integrity_state = 'intact')
), buyers as (
  select first.profile_id, first.paid_at, resolved.acquisition_id
  from first_payments first left join resolved on resolved.profile_id = first.profile_id
), visit_cohort as (
  select acquisition.id, acquisition.first_observed_source as source,
    acquisition.first_observed_medium as medium, acquisition.first_observed_campaign as campaign,
    acquisition.first_observed_content_creative as content, acquisition.external_referrer_category as referrer,
    bool_or(stage.stage = 'installer_requested') as downloaded,
    bool_or(stage.stage = 'checkout_started') as checked_out
  from public.sidestream_acquisitions acquisition
  join public.sidestream_acquisition_stages stage on stage.acquisition_id = acquisition.id
    and stage.license_namespace = $1 and stage.occurred_at < $4::timestamptz
  where acquisition.license_namespace = $1 and acquisition.integrity_state <> 'quarantined'
    and acquisition.first_observed_at >= $2::timestamptz and acquisition.first_observed_at < $3::timestamptz
  group by acquisition.id
  having bool_or(stage.stage = 'landing_observed')
), metrics as (
  select visit.source, visit.medium, visit.campaign, visit.content, visit.referrer,
    count(distinct visit.id)::bigint as visitors,
    count(distinct visit.id) filter (where visit.downloaded)::bigint as downloads,
    count(distinct visit.id) filter (where visit.checked_out)::bigint as checkouts,
    count(distinct visit.id) filter (where buyer.profile_id is not null)::bigint as converted,
    count(distinct buyer.profile_id)::bigint as cohort_buyers, 0::bigint as buyers
  from visit_cohort visit left join buyers buyer on buyer.acquisition_id = visit.id
  group by visit.source, visit.medium, visit.campaign, visit.content, visit.referrer
  union all
  select coalesce(acquisition.first_observed_source, 'unknown'), acquisition.first_observed_medium,
    acquisition.first_observed_campaign, acquisition.first_observed_content_creative,
    acquisition.external_referrer_category, 0, 0, 0, 0, 0, count(*)::bigint
  from buyers buyer left join public.sidestream_acquisitions acquisition on acquisition.id = buyer.acquisition_id
    and acquisition.license_namespace = $1
  where buyer.paid_at >= $2::timestamptz and buyer.paid_at < $3::timestamptz
  group by acquisition.first_observed_source, acquisition.first_observed_medium,
    acquisition.first_observed_campaign, acquisition.first_observed_content_creative, acquisition.external_referrer_category
)
select source, medium, campaign, content, referrer,
  sum(visitors)::text as visitors, sum(downloads)::text as downloads, sum(checkouts)::text as checkouts,
  sum(converted)::text as converted, sum(cohort_buyers)::text as cohort_buyers, sum(buyers)::text as buyers
from metrics group by source, medium, campaign, content, referrer
order by sum(visitors) desc, source, medium, campaign, content, referrer
`;

export function channelLabel(source: string, referrer: string | null) {
  const aliases: Record<string, string> = {
    google: "Google", reddit: "Reddit", instagram: "Instagram", ig: "Instagram", "instagram-bio": "Instagram",
    "manychat-instagram": "Instagram", meta: "Meta", facebook: "Facebook", youtube: "YouTube",
    "chatgpt.com": "ChatGPT", chatgpt: "ChatGPT", gmail: "Email", manychat_email: "Email",
    mobile_handoff: "Email", manychat: "ManyChat", bing: "Bing",
    direct: "Direct / unknown", website_direct_or_unknown: "Direct / unknown", unknown: "Unattributed",
  };
  if (source === "external_referrer") {
    const labels: Record<string, string> = { search: "Search (unspecified)", social: "Social (unspecified)", messaging: "Messaging", video: "Video (unspecified)", community: "Community (unspecified)", publisher: "Publisher", other_external: "Other referrals" };
    return labels[referrer || ""] || "Other referrals";
  }
  return aliases[source] || source;
}
const FIELDS = ["visitors", "downloads", "checkouts", "converted", "cohort_buyers", "buyers"] as const;
const empty = () => Object.fromEntries(FIELDS.map(key => [key, 0])) as Record<typeof FIELDS[number], number>;
export function buildChannelReport(input: Input, rows: readonly Row[]) {
  const channels = new Map<string, ReturnType<typeof empty>>();
  const totals = empty();
  const campaigns = rows.map(row => {
    const channel = channelLabel(row.source, row.referrer);
    const values = empty();
    for (const key of FIELDS) {
      const n = Number(row[key]);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error("invalid_report_count");
      values[key] = n;
      totals[key] += n;
    }
    if (values.converted > values.visitors) throw new Error("invalid_conversion_count");
    const aggregate = channels.get(channel) || empty();
    for (const key of FIELDS) aggregate[key] += values[key];
    channels.set(channel, aggregate);
    return { channel, source: row.source, medium: row.medium, campaign: row.campaign, content: row.content, referrer: row.referrer, ...values };
  });
  const withRate = <T extends ReturnType<typeof empty>>(row: T) => ({ ...row, conversionRate: row.visitors ? row.converted / row.visitors * 100 : null });
  return {
    schemaVersion: 1, namespace: input.licenseNamespace, source: "live Website", generatedAt: new Date().toISOString(),
    dateWindow: { from: input.from, through: input.through, observationAsOf: input.asOf },
    totals: withRate(totals),
    channels: [...channels].map(([channel, counts]) => withRate({ channel, ...counts })).sort((a, b) => b.visitors - a.visitors || a.channel.localeCompare(b.channel)),
    campaigns: campaigns.sort((a, b) => b.visitors - a.visitors || b.buyers - a.buyers).slice(0, 100).map(withRate),
    campaignCount: campaigns.length, campaignsTruncated: campaigns.length > 100,
    definitions: {
      visitors: "Distinct tracked first-touch journeys with an observed landing. Not pageviews or cross-device unique people.",
      buyers: "Distinct customers whose first verified positive payment occurred in the selected dates. Zero-cost upgrades are excluded; later refunds do not erase a historical purchase.",
      conversion: "Selected first-visit journeys with an exactly linked first positive payment by the observation time / all selected first-visit journeys.",
      attribution: "Immutable first touch linked through the exact Checkout payment. Missing or conflicting purchase links remain unattributed.",
      referrers: "Older untagged referrers retain their recorded category; unspecified search cannot be relabeled Google.",
    },
  };
}
export async function queryChannelReport(request: unknown, overrides: { transaction?: <T>(callback: (client: Client) => Promise<T>) => Promise<T> } = {}) {
  const input = parseChannelReportRequest(request);
  const transaction = overrides.transaction || (<T>(callback: (client: Client) => Promise<T>) => withPostgresTransaction(callback, { isolationLevel: "repeatable read", readOnly: true }));
  return transaction(async client => {
    await client.query("set local statement_timeout = '20s'");
    const result = await client.query<Row>(CHANNEL_REPORT_SQL, [input.licenseNamespace, input.from, input.through, input.asOf]);
    return buildChannelReport(input, result.rows);
  });
}

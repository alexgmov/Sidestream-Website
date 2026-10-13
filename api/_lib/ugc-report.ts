import type { QueryResult, QueryResultRow } from "pg";
import { withPostgresTransaction } from "./postgres.js";
import { parseChannelReportRequest } from "./channel-report.js";

export const UGC_CREATORS = [
  { campaign: "ugc-instagram-01", name: "Marcel", account: "@sidestream.tv.1" },
  { campaign: "ugc-instagram-02", name: "Matthew", account: "@sidestream.tv.2" },
] as const;
type Input = ReturnType<typeof parseChannelReportRequest>;
type Client = { query: <R extends QueryResultRow>(sql: string, values?: readonly unknown[]) => Promise<QueryResult<R>> };
type Row = QueryResultRow & { campaign: string; placement: string; day: string; visits?: string; currency?: string; purchases?: string; gross?: string; refunds?: string; disputes?: string; net?: string };
const CAMPAIGNS = UGC_CREATORS.map(creator => creator.campaign);
const placement = `case when a.first_observed_source = 'manychat-instagram' and a.first_observed_medium = 'dm' then 'manychat'
  when a.first_observed_source in ('instagram','ig','instagram-bio') and a.first_observed_medium = 'social' then 'bio' else 'unspecified' end`;
export const UGC_VISITS_SQL = `
select a.first_observed_campaign as campaign, ${placement} as placement,
  to_char(a.first_observed_at at time zone 'UTC', 'YYYY-MM-DD') as day, count(*)::text as visits
from public.sidestream_acquisitions a
where a.license_namespace=$1 and a.first_observed_campaign=any($5::text[])
  and a.integrity_state <> 'quarantined' and a.first_observed_at >= $2::timestamptz and a.first_observed_at < $3::timestamptz
  and exists (select 1 from public.sidestream_acquisition_stages s where s.acquisition_id=a.id and s.license_namespace=$1 and s.stage='landing_observed' and s.occurred_at < $4::timestamptz)
group by 1,2,3 order by 1,2,3`;

// Revenue uses settled instruments, never a customer's entire lifetime balance.
// Resolve every payment's owners and acquisition edges before filtering creators.
export const UGC_REVENUE_SQL = `
with facts as (
  select f.* from public.sidestream_customer_commerce_materializations f
  where f.license_namespace=$1
), owners as (
  select payment_key from facts
  group by payment_key having count(distinct profile_id)=1 and count(distinct currency)=1 and not bool_or(identity_conflict)
), ranked as (
  select f.*, row_number() over (partition by f.payment_key order by
    case f.source_object_type when 'payment_intent' then 0 else 1 end,
    f.event_created_at desc, f.event_id desc, f.source_object_id desc) as rank
  from facts f join owners using (payment_key)
  join public.sidestream_customer_profiles p on p.id=f.profile_id and p.license_namespace=$1 and p.merged_into is null
  where f.fact_kind='payment' and f.source_confidence='verified'
    and f.source_object_type in ('payment_intent','charge') and f.currency is not null
), payments as (
  select * from ranked where rank=1 and gross_paid_minor>0 and first_paid_at >= $2::timestamptz and first_paid_at < $3::timestamptz and first_paid_at < $4::timestamptz
), edges as (
  select distinct p.payment_key, a.id, a.integrity_state, a.first_observed_at, p.first_paid_at
  from payments p join public.sidestream_customer_commerce_aliases alias
    on alias.license_namespace=$1 and alias.payment_key=p.payment_key and alias.alias_type='checkout_session'
  join public.sidestream_checkout_intents i on i.stripe_checkout_session_id=alias.alias_id
  join public.sidestream_acquisitions a on a.id=i.acquisition_id and a.license_namespace=$1
), resolved as (
  select payment_key, (array_agg(id))[1] as acquisition_id from edges group by payment_key
  having count(*)=1 and bool_and(integrity_state='intact' and first_observed_at<=first_paid_at)
), adjustments as (
  select payment_key,
    greatest(coalesce(max(refunded_minor) filter(where source_object_type='charge'),0),
      coalesce(sum(refunded_minor) filter(where fact_kind='refund'),0)) as refunds,
    coalesce(sum(disputed_minor) filter(where fact_kind='dispute'),0) as disputes
  from facts where source_confidence='verified' group by payment_key
)
select a.first_observed_campaign as campaign, ${placement} as placement,
  to_char(p.first_paid_at at time zone 'UTC','YYYY-MM-DD') as day, p.currency,
  count(*)::text as purchases, sum(p.gross_paid_minor)::text as gross,
  sum(adj.refunds)::text as refunds, sum(adj.disputes)::text as disputes,
  sum(greatest(p.gross_paid_minor-adj.refunds-adj.disputes,0))::text as net
from payments p join resolved r using(payment_key)
join public.sidestream_acquisitions a on a.id=r.acquisition_id
join adjustments adj using(payment_key)
where a.first_observed_campaign=any($5::text[])
group by 1,2,3,4 order by 1,2,3,4`;
export const UGC_ARRIVALS_SQL = `select campaign, placement, to_char(occurred_at at time zone 'UTC','YYYY-MM-DD') as day, count(*)::text as visits
from public.sidestream_ugc_link_arrivals where license_namespace=$1 and occurred_at >= $2::timestamptz and occurred_at < $3::timestamptz and occurred_at < $4::timestamptz and campaign=any($5::text[])
group by 1,2,3 order by 1,2,3`;
const moneyKeys = ["purchases", "gross", "refunds", "disputes", "net"] as const;
const count = (value: unknown) => { const n=Number(value); if (!Number.isSafeInteger(n) || n<0) throw new Error("invalid_ugc_count"); return n; };
const emptyMoney = (currency: string) => ({ currency, purchases:0, gross:0, refunds:0, disputes:0, net:0 });
const emptyCounts = () => ({ bio:0, manychat:0, unspecified:0, total:0 });
type Counts = ReturnType<typeof emptyCounts>;
type Money = ReturnType<typeof emptyMoney>;
export function buildUgcReport(input: Input, visits: Row[], arrivals: Row[], payments: Row[], trackingSince: string | null) {
  const days: string[]=[];
  for (let t=Date.parse(input.from.slice(0,10)+"T00:00:00Z");t<Date.parse(input.through);t+=86400000) days.push(new Date(t).toISOString().slice(0,10));
  const creators=UGC_CREATORS.map(creator=>({ ...creator, firstVisits:emptyCounts(), arrivals:emptyCounts(), money:[] as Money[],
    daily:days.map(day=>({day,firstVisits:emptyCounts(),arrivals:emptyCounts(),money:[] as Money[]})) }));
  const addMoney = (target: Money[], row: Row) => {
    if (!/^[a-z]{3}$/.test(row.currency || "")) throw new Error("invalid_ugc_currency");
    let entry=target.find(x=>x.currency===row.currency);
    if (!entry) { entry=emptyMoney(row.currency!); target.push(entry); }
    for (const key of moneyKeys) entry[key]=count(entry[key]+count(row[key]));
    target.sort((a,b)=>a.currency.localeCompare(b.currency));
  };
  for (const [rows,key] of [[visits,"firstVisits"],[arrivals,"arrivals"]] as const) for (const row of rows) {
    const creator=creators.find(x=>x.campaign===row.campaign), day=creator?.daily.find(x=>x.day===row.day);
    if (!creator || !day || !["bio","manychat","unspecified"].includes(row.placement)) throw new Error("invalid_ugc_dimension");
    const p=row.placement as Exclude<keyof Counts,"total">, n=count(row.visits);
    for (const target of [creator[key],day[key]]) {target[p]=count(target[p]+n);target.total=count(target.total+n);}
  }
  for (const row of payments) {
    const creator=creators.find(x=>x.campaign===row.campaign), day=creator?.daily.find(x=>x.day===row.day);
    if (!creator || !day) throw new Error("invalid_ugc_dimension");
    addMoney(creator.money,row); addMoney(day.money,row);
  }
  return { schemaVersion:1, namespace:input.licenseNamespace, source:"live Website", generatedAt:new Date().toISOString(),
    dateWindow:{from:input.from,through:input.through,observationAsOf:input.asOf},trackingSince,creators,
    definitions:{arrivals:"Tagged website arrivals, including repeats, from the start of this counter. Reloads count; platform button clicks that never load the site are not observable. Known scanners are excluded.",
      firstVisits:"Historical tracked first visits by creator campaign. Not every click or cross-device unique people. Kept separate from the new arrival counter.",
      revenue:"Verified settled PaymentIntent/Charge amounts linked to exactly one intact creator campaign through that payment's Checkout. Counts payments on their paid date, including repeat purchases only with their own exact link. Checkout-only or invoice-only records awaiting an instrument are excluded.",
      net:"Current gross minus refunds and open/lost disputes, floored at zero per payment. Not profit; processing fees are not deducted. Currencies remain separate.",
      missing:"Untagged, mistagged, conflicting, and unlinked history is never assigned to a creator. Zero means no qualifying records, not proof the creator generated no sales."} };
}
export async function queryUgcReport(request: unknown, overrides: {transaction?: <T>(callback:(client:Client)=>Promise<T>)=>Promise<T>}={}) {
  const input=parseChannelReportRequest(request), params=[input.licenseNamespace,input.from,input.through,input.asOf,CAMPAIGNS];
  const transaction=overrides.transaction || (<T>(callback:(client:Client)=>Promise<T>)=>withPostgresTransaction(callback,{isolationLevel:"repeatable read",readOnly:true}));
  return transaction(async client=>{
    await client.query("set local statement_timeout='20s'");
    const visits=await client.query<Row>(UGC_VISITS_SQL,params);
    const arrivals=await client.query<Row>(UGC_ARRIVALS_SQL,params);
    const payments=await client.query<Row>(UGC_REVENUE_SQL,params);
    const start=await client.query<{started_at:Date}>("select started_at from public.sidestream_ugc_tracking_start where license_namespace=$1",[input.licenseNamespace]);
    return buildUgcReport(input,visits.rows,arrivals.rows,payments.rows,start.rows[0]?.started_at.toISOString() || null);
  });
}

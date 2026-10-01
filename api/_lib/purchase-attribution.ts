import type { QueryResult, QueryResultRow } from "pg";
import { withPostgresTransaction } from "./postgres.js";
import { channelLabel } from "./channel-report.js";

type Payment = { chargeId: string; paymentIntentId: string | null };
type Input = { licenseNamespace: "production" | "test"; payments: Payment[] };
type Client = { query: <R extends QueryResultRow>(sql: string, values?: readonly unknown[]) => Promise<QueryResult<R>> };
export class PurchaseAttributionValidationError extends Error {}
export function parsePurchaseAttributionRequest(value: unknown): Input {
  const invalid = (): never => { throw new PurchaseAttributionValidationError("invalid_purchase_attribution_request"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(k => !["licenseNamespace", "payments"].includes(k)) || (body.licenseNamespace !== "production" && body.licenseNamespace !== "test")) return invalid();
  if (!Array.isArray(body.payments) || !body.payments.length || body.payments.length > 100) return invalid();
  const payments = body.payments.map((p: Payment) => {
    if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).length !== 2 || typeof p.chargeId !== "string" || !/^ch_[A-Za-z0-9]{1,196}$/.test(p.chargeId) || !(p.paymentIntentId === null || typeof p.paymentIntentId === "string" && /^pi_[A-Za-z0-9]{1,196}$/.test(p.paymentIntentId))) return invalid();
    return { chargeId: p.chargeId, paymentIntentId: p.paymentIntentId };
  });
  if (new Set(payments.map(p => p.chargeId)).size !== payments.length) return invalid();
  return { licenseNamespace: body.licenseNamespace as Input["licenseNamespace"], payments };
}

// Resolve each purchase independently. Never borrow an older profile-level
// acquisition for a repeat payment, and never omit an unmatched Stripe purchase.
export const PURCHASE_ATTRIBUTION_SQL = `
with requested as (
  select (ordinality - 1)::int as position, value->>'chargeId' as charge_id,
    value->>'paymentIntentId' as intent_id
  from jsonb_array_elements($2::jsonb) with ordinality
), aliases as (
  select distinct r.position, a.payment_key
  from requested r join public.sidestream_customer_commerce_aliases a
    on a.license_namespace = $1 and (
      (a.alias_type = 'charge' and a.alias_id = r.charge_id) or
      (a.alias_type = 'payment_intent' and a.alias_id = r.intent_id))
), owners as (
  select a.position, count(distinct a.payment_key) as payment_count,
    count(distinct f.profile_id) as owner_count,
    min(f.profile_id::text)::uuid as profile_id,
    min(a.payment_key) as payment_key, min(f.first_paid_at) as paid_at,
    bool_or(f.identity_conflict) as conflicted,
    bool_or(f.source_confidence = 'verified' and f.gross_paid_minor > 0) as verified
  from aliases a left join public.sidestream_customer_commerce_materializations f
    on f.license_namespace = $1 and f.payment_key = a.payment_key
  group by a.position
), exact_owners as (
  select o.* from owners o join public.sidestream_customer_profiles p
    on p.id = o.profile_id and p.license_namespace = $1 and p.merged_into is null
  where o.payment_count = 1 and o.owner_count = 1 and not o.conflicted and o.verified
), edges as (
  select distinct o.position, a.id, a.integrity_state, a.first_observed_at, o.paid_at
  from exact_owners o
  join public.sidestream_customer_commerce_aliases alias
    on alias.license_namespace = $1 and alias.payment_key = o.payment_key and alias.alias_type = 'checkout_session'
  join public.sidestream_checkout_intents intent on intent.stripe_checkout_session_id = alias.alias_id
  join public.sidestream_acquisitions a on a.id = intent.acquisition_id and a.license_namespace = $1
), resolutions as (
  select position, min(id::text)::uuid as acquisition_id,
    count(*) = 1 and bool_and(integrity_state = 'intact' and first_observed_at <= paid_at) as valid
  from edges group by position
)
select r.position,
  case when o.payment_count > 1 or o.owner_count > 1 or o.conflicted or resolution.valid = false then 'conflict'
       when a.id is not null then 'matched' else 'unattributed' end as link_status,
  a.first_observed_source as source, a.first_observed_medium as medium,
  a.first_observed_campaign as campaign, a.first_observed_content_creative as content,
  a.external_referrer_category as referrer,
  (select min(s.occurred_at) from public.sidestream_acquisition_stages s
   where s.license_namespace = $1 and s.acquisition_id = a.id and s.stage = 'landing_observed') as first_visit_at,
  (select min(i.first_seen_at) from public.sidestream_customer_installs i
   where i.license_namespace = $1 and i.profile_id = owner.profile_id) as first_install_at
from requested r left join owners o on o.position = r.position
left join exact_owners owner on owner.position = r.position
left join resolutions resolution on resolution.position = r.position
left join public.sidestream_acquisitions a on a.id = resolution.acquisition_id and resolution.valid
order by r.position
`;

const tag = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) ? value : null;
const iso = (value: unknown) => value == null ? null : new Date(value as string).toISOString();
export async function queryPurchaseAttribution(request: unknown, overrides: { transaction?: <T>(callback: (client: Client) => Promise<T>) => Promise<T> } = {}) {
  const input = parsePurchaseAttributionRequest(request);
  const transaction = overrides.transaction || (<T>(callback: (client: Client) => Promise<T>) => withPostgresTransaction(callback, { isolationLevel: "repeatable read", readOnly: true }));
  return transaction(async client => {
    await client.query("set local statement_timeout = '20s'");
    const result = await client.query(PURCHASE_ATTRIBUTION_SQL, [input.licenseNamespace, JSON.stringify(input.payments)]);
    if (result.rows.length !== input.payments.length) throw new Error("purchase_attribution_incomplete");
    return { schemaVersion: 1, namespace: input.licenseNamespace, generatedAt: new Date().toISOString(), rows: result.rows.map((row, index) => {
      if (row.position !== index || !["matched", "unattributed", "conflict"].includes(row.link_status)) throw new Error("purchase_attribution_invalid");
      const matched = row.link_status === "matched", source = matched ? tag(row.source) : null;
      return { position: index, linkStatus: row.link_status,
        channel: source ? channelLabel(source, tag(row.referrer)) : "Unattributed",
        source, medium: matched ? tag(row.medium) : null, campaign: matched ? tag(row.campaign) : null,
        content: matched ? tag(row.content) : null,
        firstVisitAt: matched ? iso(row.first_visit_at) : null,
        firstInstallAt: row.link_status === "conflict" ? null : iso(row.first_install_at) };
    }) };
  });
}

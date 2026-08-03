// Production can still use the pre-lifecycle license schema. JSON extraction
// avoids a parse-time column lookup while preserving canonical migrated state
// whenever the lifecycle field exists.
export const LICENSE_ENTITLEMENT_STATUS_SQL = `
  case
    when l.id is null then null
    when to_jsonb(l) ? 'entitlement_status'
      then to_jsonb(l) ->> 'entitlement_status'
    when l.stripe_checkout_session_id is not null
      and l.status in ('active', 'trialing')
      and l.plan_key in ('sidestream_pro', 'sidestream_unlimited') then 'active'
    else 'unknown'
  end
`;

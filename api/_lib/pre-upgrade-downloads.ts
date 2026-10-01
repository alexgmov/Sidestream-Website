import { getCustomerUsageTelemetryPool, loadCustomerUsageSyncConfiguration } from "./customer-usage.js";

type Cohort = { position: number; installs: string[]; upgradedAt: string };
// Completion timestamps, never request-day aggregates. Scalar projection only;
// grouping and terminal precedence follow Customer 360's download success rules.
export const PRE_UPGRADE_DOWNLOADS_SQL = `
with cohort as (
  select (value->>'position')::int as position, (value->>'upgradedAt')::timestamptz as upgraded_at,
    jsonb_array_elements_text(value->'installs') as install_id_hash
  from jsonb_array_elements($1::jsonb)
), projected as (
  select c.position,c.upgraded_at,e.install_id_hash,e.session_id,e.event_name,e.occurred_at,
    coalesce(nullif(e.payload->>'download_id',''),nullif(e.data_points#>>'{details,downloadId}',''),nullif(e.data_points#>>'{details,download_id}','')) as download_id,
    coalesce(e.payload->>'file_delivered',e.data_points#>>'{details,fileDelivered}',e.data_points#>>'{details,file_delivered}') as delivered,
    lower(coalesce(e.payload->>'user_outcome',e.data_points#>>'{details,userOutcome}',e.data_points#>>'{details,user_outcome}','')) as outcome,
    lower(coalesce(e.payload->>'import_result',e.data_points#>>'{details,importResult}',e.data_points#>>'{details,import_result}','')) as import_result,
    lower(coalesce(e.payload->>'failure_stage',e.data_points#>>'{details,failureStage}',e.data_points#>>'{details,failure_stage}','')) as failure_stage
  from cohort c join public.sidestream_telemetry_events e on e.install_id_hash=c.install_id_hash
  where e.schema_version='0.2.0' and coalesce(nullif(e.build_channel,''),'production') = any($2::text[])
), observed as (
  select position,bool_or(event_name='session_started' and occurred_at < upgraded_at) as observed
  from projected group by position
), facts as (
  select position,upgraded_at,install_id_hash,session_id,download_id,
    bool_or(event_name='download_attempt_finalized') as finalized,
    bool_or(event_name='download_attempt_finalized' and outcome='cancelled') as cancelled,
    bool_or(event_name='download_attempt_finalized' and delivered='true' and
      (import_result='failed' or failure_stage in ('import','premiere_import') or outcome='got_file_import_failed')) as import_failed,
    bool_or(event_name='download_attempt_finalized' and delivered='true') as delivered,
    min(occurred_at) filter(where event_name='download_attempt_finalized' and delivered='true') as delivered_at,
    min(occurred_at) filter(where event_name='download_completed') as completed_at,
    max(occurred_at) filter(where event_name='premiere_import_failed') as import_failed_at,
    max(occurred_at) filter(where event_name='premiere_import_completed') as import_completed_at
  from projected where download_id is not null and download_id not like 'speculative-%'
  group by position,upgraded_at,install_id_hash,session_id,download_id
), counts as (
  select position,count(*) filter(where case when finalized then
      not cancelled and not import_failed and delivered and delivered_at < upgraded_at
    else completed_at < upgraded_at and (import_failed_at is null or import_completed_at > import_failed_at) end)::int as completed
  from facts group by position
)
select o.position,case when o.observed then coalesce(c.completed,0) else null end as completed
from observed o left join counts c using(position)
`;

export async function queryPreUpgradeDownloads(cohort: Cohort[], namespace: "production" | "test") {
  if (!cohort.length) return new Map<number, number | null>();
  const config = loadCustomerUsageSyncConfiguration(process.env);
  const pool = getCustomerUsageTelemetryPool(config.telemetryConnectionString);
  const result = await pool.query(PRE_UPGRADE_DOWNLOADS_SQL, [JSON.stringify(cohort), namespace === "production" ? ["production", "prod"] : ["test"]]);
  return new Map<number, number | null>(result.rows.map(row => [row.position, row.completed]));
}

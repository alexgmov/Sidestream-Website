import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { loadInjectedModule } from './helpers/handler-loader.mjs';
import { requireSafeTestDatabaseUrl,createTestPoolOptions } from '../scripts/run-postgres-integration.mjs';
const mod=await loadInjectedModule(new URL('../api/_lib/pre-upgrade-downloads.ts',import.meta.url),{'./customer-usage.js':{getCustomerUsageTelemetryPool:()=>{throw new Error('isolated query only')},loadCustomerUsageSyncConfiguration:()=>{throw new Error('isolated query only')}}});
test('completion cutoff, duplicate terminals, finalization precedence, namespace and customer isolation; observed zero versus missing',async()=>{
 const pool=new Pool(createTestPoolOptions(requireSafeTestDatabaseUrl(process.env))),schema='upgrade_'+randomUUID().replaceAll('-','');
 try {
  await pool.query(`create schema ${schema}; create table ${schema}.sidestream_telemetry_events(install_id_hash text,session_id text,event_name text,occurred_at timestamptz,schema_version text default '0.2.0',build_channel text default 'production',payload jsonb default '{}',data_points jsonb default '{}')`);
  async function event(install,name,at,id=null,extra={},channel='production'){
   await pool.query(`insert into ${schema}.sidestream_telemetry_events(install_id_hash,session_id,event_name,occurred_at,payload,build_channel) values($1,'session',$2,$3,$4,$5)`,[install,name,at,JSON.stringify({download_id:id,...extra}),channel]);
  }
  await event('one','session_started','2026-09-01');await event('zero','session_started','2026-09-01');
  await event('one','download_completed','2026-09-01T23:59:00Z','success');await event('one','download_completed','2026-09-01T23:59:00Z','success');
  await event('one','download_requested','2026-09-01','late');await event('one','download_completed','2026-09-02T00:01:00Z','late');
  await event('one','download_completed','2026-09-02T00:00:00Z','boundary');
  await event('one','download_completed','2026-09-01','cancelled');await event('one','download_attempt_finalized','2026-09-01','cancelled',{file_delivered:true,user_outcome:'cancelled'});
  await event('one','download_completed','2026-09-01','importfailed');await event('one','download_attempt_finalized','2026-09-01','importfailed',{file_delivered:true,import_result:'failed'});
  await event('one','download_attempt_finalized','2026-09-01','delivered',{file_delivered:true});
  await event('one','download_completed','2026-09-01','speculative-123');await event('other','download_completed','2026-09-01','other');await event('one','download_completed','2026-09-01','test',{},'test');
  const cohort=['one','zero','missing'].map((i,position)=>({position,installs:[i],upgradedAt:'2026-09-02T00:00:00Z'}));
  const r=await pool.query(mod.PRE_UPGRADE_DOWNLOADS_SQL.replaceAll('public.',schema+'.'),[JSON.stringify(cohort),['production','prod']]);
  assert.deepEqual(r.rows.sort((a,b)=>a.position-b.position),[{position:0,completed:2},{position:1,completed:0}]);
 } finally {await pool.query(`drop schema ${schema} cascade`);await pool.end();}
});

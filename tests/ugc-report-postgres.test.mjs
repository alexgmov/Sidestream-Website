import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { loadInjectedModule } from './helpers/handler-loader.mjs';
import { requireSafeTestDatabaseUrl,createTestPoolOptions } from '../scripts/run-postgres-integration.mjs';
const channels=await loadInjectedModule(new URL('../api/_lib/channel-report.ts',import.meta.url),{'./postgres.js':{withPostgresTransaction:async()=>{throw Error('unexpected database')}}});
const mod=await loadInjectedModule(new URL('../api/_lib/ugc-report.ts',import.meta.url),{'./postgres.js':{withPostgresTransaction:async()=>{throw Error('unexpected database')}},'./channel-report.js':channels});
test('exact payment revenue deduplicates instruments, excludes ambiguous/invalid links, separates currencies and counts repeat purchases by their own campaign',async()=>{
 const pool=new Pool(createTestPoolOptions(requireSafeTestDatabaseUrl(process.env)));
 const schema=`ugc_${randomUUID().replaceAll('-','')}`;
 const sql=text=>text.replaceAll('public.',`${schema}.`);
 const query=(text,params)=>pool.query(sql(text),params);
 try{
  await pool.query(`create schema ${schema}`);
  await query(`create table public.sidestream_customer_profiles(id uuid primary key,license_namespace text,merged_into uuid);
  create table public.sidestream_customer_commerce_materializations(profile_id uuid,license_namespace text,payment_key text,first_paid_at timestamptz,gross_paid_minor bigint default 0,refunded_minor bigint default 0,disputed_minor bigint default 0,source_confidence text default 'verified',identity_conflict boolean default false,fact_kind text default 'payment',source_object_type text default 'payment_intent',source_object_id text default 'pi_fixture',event_id text default 'evt_fixture',event_created_at timestamptz default '2026-08-15',currency text default 'usd');
  create table public.sidestream_customer_commerce_aliases(license_namespace text,payment_key text,alias_type text,alias_id text);
  create table public.sidestream_checkout_intents(acquisition_id uuid,stripe_checkout_session_id text);
  create table public.sidestream_acquisitions(id uuid primary key,license_namespace text,first_observed_source text,first_observed_medium text,first_observed_campaign text,first_observed_at timestamptz,integrity_state text default 'intact');
  create table public.sidestream_acquisition_stages(acquisition_id uuid,license_namespace text,stage text,occurred_at timestamptz);`);
  await query(await readFile(new URL('../db/migrations/20261013190000_add_ugc_link_arrivals.sql',import.meta.url),'utf8'));
  async function visit(campaign='ugc-instagram-01',source='instagram',when='2026-08-10',namespace='production',integrity='intact'){
   const id=randomUUID();await query('insert into public.sidestream_acquisitions values($1,$2,$3,$4,$5,$6,$7)',[id,namespace,source,source==='manychat-instagram'?'dm':'social',campaign,when,integrity]);
   for(let i=0;i<2;i++)await query("insert into public.sidestream_acquisition_stages values($1,$2,'landing_observed',$3)",[id,namespace,when]);return id;
  }
  async function pay(acquisitions,{amount=2000,when='2026-08-15',namespace='production',profile=randomUUID(),currency='usd',conflict=false,type='payment_intent'}={}){
   const key=randomUUID();await query('insert into public.sidestream_customer_profiles values($1,$2,null) on conflict do nothing',[profile,namespace]);
   for(const instrument of type==='payment_intent'?['payment_intent','charge']: [type])await query('insert into public.sidestream_customer_commerce_materializations(profile_id,license_namespace,payment_key,first_paid_at,gross_paid_minor,currency,identity_conflict,source_object_type) values($1,$2,$3,$4,$5,$6,$7,$8)',[profile,namespace,key,when,amount,currency,conflict,instrument]);
   for(const id of acquisitions){const session=randomUUID();await query("insert into public.sidestream_customer_commerce_aliases values($1,$2,'checkout_session',$3)",[namespace,key,session]);await query('insert into public.sidestream_checkout_intents values($1,$2)',[id,session]);}return {key,profile};
  }
  const marcel=await visit(),matthew=await visit('ugc-instagram-02','manychat-instagram'),unknown=await visit('unregistered'),older=await visit('ugc-instagram-01','instagram','2026-07-10');
  const paid=await pay([marcel,marcel]); // Two aliases to the same root still count once.
  await query("update public.sidestream_customer_commerce_materializations set refunded_minor=500 where payment_key=$1 and source_object_type='charge'",[paid.key]);
  await query("insert into public.sidestream_customer_commerce_materializations(profile_id,license_namespace,payment_key,fact_kind,source_object_type,refunded_minor,disputed_minor) values($1,'production',$2,'refund','refund',500,0),($1,'production',$2,'dispute','dispute',0,200)",[paid.profile,paid.key]);
  await pay([matthew],{profile:paid.profile,amount:1500}); // Repeat purchase belongs to Matthew, not the first creator.
  await pay([older],{amount:1000,currency:'eur'});
  await pay([marcel],{amount:0});await pay([]);await pay([marcel,matthew]);await pay([marcel,unknown]);await pay([marcel],{conflict:true});await pay([marcel],{type:'checkout_session'});
  await pay([await visit('ugc-instagram-01','instagram','2026-08-10','production','quarantined')]);
  await pay([await visit('ugc-instagram-01','instagram','2026-08-20')],{when:'2026-08-15'});
  await pay([matthew],{when:'2026-09-01'});
  await pay([await visit('ugc-instagram-01','instagram','2026-08-10','test')],{namespace:'test'});
  const conflictingOwner=await pay([marcel]);
  await query("insert into public.sidestream_customer_commerce_materializations(profile_id,license_namespace,payment_key,currency) values($1,'production',$2,'usd')",[randomUUID(),conflictingOwner.key]);
  const conflictingCurrency=await pay([marcel]);await query("update public.sidestream_customer_commerce_materializations set currency='eur' where payment_key=$1 and source_object_type='charge'",[conflictingCurrency.key]);
  const eventId=randomUUID();
  for(let i=0;i<2;i++)await query("insert into public.sidestream_ugc_link_arrivals(event_id,license_namespace,campaign,placement,occurred_at) values($1,'production','ugc-instagram-01','bio','2026-08-12') on conflict do nothing",[eventId]);
  await query("insert into public.sidestream_ugc_link_arrivals(event_id,license_namespace,campaign,placement,occurred_at) values($1,'test','ugc-instagram-01','bio','2026-08-12')",[eventId]);
  const input={licenseNamespace:'production',from:'2026-08-01T00:00:00Z',through:'2026-09-01T00:00:00Z',asOf:'2026-09-02T00:00:00Z'};
  const report=await mod.queryUgcReport(input,{transaction:async fn=>fn({query})});
  const [m,t]=report.creators;
  assert.equal(m.firstVisits.total,2);assert.equal(t.firstVisits.total,1);assert.equal(m.arrivals.total,1);
  assert.deepEqual(m.money,[{currency:'eur',purchases:1,gross:1000,refunds:0,disputes:0,net:1000},{currency:'usd',purchases:1,gross:2000,refunds:500,disputes:200,net:1300}]);
  assert.deepEqual(t.money,[{currency:'usd',purchases:1,gross:1500,refunds:0,disputes:0,net:1500}]);
  const narrow=await mod.queryUgcReport({...input,from:'2026-08-14T00:00:00Z'},{transaction:async fn=>fn({query})});assert.deepEqual(narrow.creators[0].money,m.money);assert.equal(narrow.creators[0].arrivals.total,0);
  const testReport=await mod.queryUgcReport({...input,licenseNamespace:'test'},{transaction:async fn=>fn({query})});assert.equal(testReport.creators[0].money[0].gross,2000);assert.equal(testReport.creators[0].arrivals.total,1);
 }finally{await pool.query(`drop schema if exists ${schema} cascade`);await pool.end();}
});

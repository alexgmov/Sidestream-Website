import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { loadInjectedModule } from './helpers/handler-loader.mjs';
import { requireSafeTestDatabaseUrl, createTestPoolOptions } from '../scripts/run-postgres-integration.mjs';
const mod = await loadInjectedModule(new URL('../api/_lib/purchase-attribution.ts', import.meta.url), {
  './postgres.js': { withPostgresTransaction: async () => { throw new Error('inject isolated transaction'); } }, './channel-report.js': { channelLabel: x => x },
});
test('each Stripe payment keeps its own exact journey; ambiguous and missing links never borrow profile attribution', async () => {
  const pool = new Pool({ ...createTestPoolOptions(requireSafeTestDatabaseUrl(process.env)), options: "-c timezone=UTC" });
  const schema = `purchases_${randomUUID().replaceAll('-', '')}`, sql = s => s.replaceAll('public.', `${schema}.`);
  try {
    await pool.query(`create schema ${schema}`);
    await pool.query(sql(`
      create table public.sidestream_customer_profiles(id uuid primary key, license_namespace text, merged_into uuid);
      create table public.sidestream_customer_commerce_materializations(profile_id uuid, license_namespace text, payment_key text, first_paid_at timestamptz, gross_paid_minor bigint, source_confidence text default 'verified', identity_conflict boolean default false);
      create table public.sidestream_customer_commerce_aliases(license_namespace text, payment_key text, alias_type text, alias_id text);
      create table public.sidestream_checkout_intents(acquisition_id uuid, stripe_checkout_session_id text);
      create table public.sidestream_acquisitions(id uuid primary key, license_namespace text, first_observed_source text, first_observed_medium text, first_observed_campaign text, first_observed_content_creative text, external_referrer_category text, first_observed_at timestamptz, integrity_state text default 'intact');
      create table public.sidestream_acquisition_stages(acquisition_id uuid, license_namespace text, stage text, occurred_at timestamptz);
      create table public.sidestream_customer_installs(profile_id uuid, license_namespace text, first_seen_at timestamptz);
    `));
    const profile = randomUUID();
    await pool.query(sql(`insert into public.sidestream_customer_profiles values($1,'production',null);`), [profile]);
    await pool.query(sql(`insert into public.sidestream_customer_installs values($1,'production','2026-09-12'),($1,'test','2020-01-01')`), [profile]);
    async function acquisition(source, namespace = 'production', integrity = 'intact') {
      const id = randomUUID();
      await pool.query(sql(`insert into public.sidestream_acquisitions(id,license_namespace,first_observed_source,first_observed_at,integrity_state) values($1,$2,$3,'2026-09-01',$4)`), [id,namespace,source,integrity]);
      // Earlier email delivery is not a first website visit.
      await pool.query(sql(`insert into public.sidestream_acquisition_stages values($1,$2,'email_handoff_created','2026-09-01'),($1,$2,'landing_observed','2026-09-02')`), [id,namespace]);
      return id;
    }
    async function payment(name, acquisitions, conflict = false) {
      const key = `payment-${name}`;
      for (let i=0;i<2;i++) await pool.query(sql(`insert into public.sidestream_customer_commerce_materializations(profile_id,license_namespace,payment_key,first_paid_at,gross_paid_minor,identity_conflict) values($1,'production',$2,'2026-09-10',1999,$3)`), [profile,key,conflict]);
      await pool.query(sql(`insert into public.sidestream_customer_commerce_aliases values('production',$1,'charge',$2),('production',$1,'payment_intent',$3)`), [key,`ch_${name}`,`pi_${name}`]);
      for (const id of acquisitions) {
        const cs=`cs_${randomUUID()}`;
        await pool.query(sql(`insert into public.sidestream_customer_commerce_aliases values('production',$1,'checkout_session',$2)`), [key,cs]);
        await pool.query(sql(`insert into public.sidestream_checkout_intents values($1,$2)`), [id,cs]);
      }
      return { chargeId:`ch_${name}`,paymentIntentId:`pi_${name}` };
    }
    const reddit=await acquisition('reddit'), google=await acquisition('google');
    const payments = [await payment('first',[reddit]), await payment('repeat',[google]), await payment('unlinked',[]), await payment('ambiguous',[reddit,google]), await payment('quarantined',[await acquisition('bad','production','quarantined')]), await payment('conflict',[reddit],true), await payment('namespace',[await acquisition('testonly','test')]), {chargeId:'ch_missing',paymentIntentId:null}];
    const result=await mod.queryPurchaseAttribution({licenseNamespace:'production',payments},{transaction:async cb=>cb({query:(q,v)=>pool.query(sql(q),v)})});
    assert.equal(result.rows.length,8);
    assert.deepEqual(result.rows.map(r=>r.source),['reddit','google',null,null,null,null,null,null]);
    assert.deepEqual(result.rows.map(r=>r.linkStatus),['matched','matched','unattributed','conflict','conflict','conflict','unattributed','unattributed']);
    assert.equal(result.rows[0].firstVisitAt,'2026-09-02T00:00:00.000Z');
    assert.equal(result.rows[0].firstInstallAt,'2026-09-12T00:00:00.000Z');
    assert.equal(result.rows[2].firstInstallAt,'2026-09-12T00:00:00.000Z');
    assert.equal(result.rows[3].firstInstallAt,null);
    assert.equal(result.rows[7].firstVisitAt,null);
    assert.doesNotMatch(JSON.stringify(result),/ch_|pi_|payment-|profile_id/);
  } finally { await pool.query(`drop schema if exists ${schema} cascade`); await pool.end(); }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { loadInjectedModule } from './helpers/handler-loader.mjs';
import { requireSafeTestDatabaseUrl, createTestPoolOptions } from '../scripts/run-postgres-integration.mjs';
const mod = await loadInjectedModule(new URL('../api/_lib/channel-report.ts', import.meta.url), { './postgres.js': { withPostgresTransaction: async () => { throw new Error('inject fixture transaction'); } } });
test('SQL deduplicates visits and first paying customers, excludes comps, isolates namespaces and keeps missing/conflicting sources unknown', async () => {
  const pool = new Pool(createTestPoolOptions(requireSafeTestDatabaseUrl(process.env)));
  const schema = `channels_${randomUUID().replaceAll('-', '')}`;
  const sql = text => text.replaceAll('public.', `${schema}.`);
  try {
    await pool.query(`create schema ${schema}`);
    // Minimal typed fixture tables mirror the projected production columns.
    await pool.query(sql(`
      create table public.sidestream_customer_profiles(id uuid primary key, license_namespace text, merged_into uuid);
      create table public.sidestream_customer_commerce_materializations(profile_id uuid, license_namespace text, payment_key text, first_paid_at timestamptz, gross_paid_minor bigint, source_confidence text default 'verified', identity_conflict boolean default false);
      create table public.sidestream_customer_commerce_aliases(license_namespace text, payment_key text, alias_type text, alias_id text);
      create table public.sidestream_checkout_intents(acquisition_id uuid, stripe_checkout_session_id text);
      create table public.sidestream_acquisitions(id uuid primary key, license_namespace text, first_observed_source text, first_observed_medium text, first_observed_campaign text, first_observed_content_creative text, external_referrer_category text, first_observed_at timestamptz, integrity_state text default 'intact');
      create table public.sidestream_acquisition_stages(acquisition_id uuid, license_namespace text, stage text, occurred_at timestamptz);
    `));
    async function visit(source, when = '2026-08-10', namespace = 'production') {
      const id = randomUUID();
      await pool.query(sql(`insert into public.sidestream_acquisitions(id, license_namespace, first_observed_source, first_observed_at) values ($1,$2,$3,$4)`), [id, namespace, source, when]);
      for (const stage of ['landing_observed', 'landing_observed', 'installer_requested', 'checkout_started']) await pool.query(sql(`insert into public.sidestream_acquisition_stages values ($1,$2,$3,$4)`), [id, namespace, stage, when]);
      return id;
    }
    async function pay(acquisitions, { amount = 1999, when = '2026-08-15', namespace = 'production', profile = randomUUID(), key = randomUUID(), conflict = false } = {}) {
      await pool.query(sql(`insert into public.sidestream_customer_profiles values ($1,$2,null) on conflict do nothing`), [profile, namespace]);
      // Two verified provider facts for one payment must not double-count it.
      for (let i = 0; i < 2; i++) await pool.query(sql(`insert into public.sidestream_customer_commerce_materializations(profile_id,license_namespace,payment_key,first_paid_at,gross_paid_minor,identity_conflict) values ($1,$2,$3,$4,$5,$6)`), [profile, namespace, key, when, amount, conflict]);
      for (const acquisition of acquisitions) {
        const session = randomUUID();
        await pool.query(sql(`insert into public.sidestream_customer_commerce_aliases values ($1,$2,'checkout_session',$3)`), [namespace, key, session]);
        await pool.query(sql(`insert into public.sidestream_checkout_intents values ($1,$2)`), [acquisition, session]);
      }
      return profile;
    }
    const reddit = await visit('reddit'), google = await visit('google'), instagram = await visit('instagram');
    const repeatBuyer = await pay([reddit]);
    await pay([google], { profile: repeatBuyer, when: '2026-08-20' }); // later payment never moves first source
    await pay([google], { amount: 0 }); // comp
    await pay([instagram], { when: '2026-09-05' }); // conversion matures after visit window
    await pay([]); // no exact source
    await pay([reddit, google]); // ambiguous source remains unknown
    const older = await visit('youtube', '2026-07-20');
    await pay([older]); // earlier visit still appears in purchase pie, not visit denominator
    const testVisit = await visit('test-only', '2026-08-10', 'test');
    await pay([testVisit], { namespace: 'test' });
    const input = { licenseNamespace: 'production', from: '2026-08-01T00:00:00Z', through: '2026-09-01T00:00:00Z', asOf: '2026-09-10T00:00:00Z' };
    const transaction = async callback => callback({ query: (query, params) => pool.query(sql(query), params) });
    const report = await mod.queryChannelReport(input, { transaction });
    assert.equal(report.totals.visitors, 3);
    assert.equal(report.totals.buyers, 4);
    assert.equal(report.totals.converted, 2);
    assert.equal(report.totals.cohort_buyers, 2);
    assert.equal(report.channels.find(x => x.channel === 'Unattributed').buyers, 2);
    assert.equal(report.channels.find(x => x.channel === 'Reddit').buyers, 1);
    assert.equal(report.channels.find(x => x.channel === 'Google').buyers, 0);
    assert.equal(report.channels.find(x => x.channel === 'Instagram').converted, 1);
    assert.equal(report.channels.find(x => x.channel === 'YouTube').visitors, 0);
    assert.equal(report.channels.some(x => x.channel === 'test-only'), false);
    const narrowed = await mod.queryChannelReport({ ...input, from: '2026-08-16T00:00:00Z' }, { transaction });
    assert.equal(narrowed.totals.buyers, 0); // repeat payment cannot become first after filtering
    const testReport = await mod.queryChannelReport({ ...input, licenseNamespace: 'test' }, { transaction });
    assert.equal(testReport.totals.visitors, 1); assert.equal(testReport.totals.buyers, 1);
  } finally { await pool.query(`drop schema if exists ${schema} cascade`); await pool.end(); }
});

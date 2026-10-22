import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {Pool} from 'pg';
import {requireSafeTestDatabaseUrl,createTestPoolOptions} from '../scripts/run-postgres-integration.mjs';
import {fixture,initialModule} from './paid-initial-authorization.test.mjs';
const {issueInitialAuthorization}=initialModule;

test('real SQL issuance: exact binding, retry, refund, replacement, namespace and immutable evidence',async()=>{
  const url=requireSafeTestDatabaseUrl(process.env);
  const pool=new Pool(createTestPoolOptions(url));
  const schema='initial_it_'+randomBytes(10).toString('hex');
  const scope=sql=>sql.replace(/\bpublic\./g,'"'+schema+'".');
  const f=fixture(),a=f.account,l='73000000-0000-4000-8000-000000000001',act='74000000-0000-4000-8000-000000000001',
    p='77000000-0000-4000-8000-000000000001',c='78000000-0000-4000-8000-000000000001';
  const token='e'.repeat(64),device='f'.repeat(64);
  const credential={tokenHash:token,deviceIdHash:device};
  try {
    await pool.query('create schema "'+schema+'"');
    // Minimal auth/commerce relations exercise the production query against PostgreSQL,
    // including its row locks; the full migration-chain harness separately checks all DDL.
    await pool.query(scope(`
      create table public.sidestream_accounts(id uuid primary key);
      create table public.sidestream_licenses(id uuid primary key,account_id uuid,entitlement_status text,status text,plan_key text,stripe_checkout_session_id text,stripe_payment_intent_id text);
      create table public.sidestream_activation_sessions(id uuid primary key,account_id uuid,license_id uuid,completed_at timestamptz,source text,build_channel text,device_id_hash text,app_version text);
      create table public.sidestream_license_tokens(token_hash text primary key,account_id uuid,license_id uuid,activation_session_id uuid,device_id_hash text,revoked_at timestamptz,expires_at timestamptz);
      create table public.sidestream_paid_activation_installation_identity(activation_id uuid,license_namespace text,install_id_hash text,installer_receipt_id_hash text);
      create table public.sidestream_paid_telemetry_profile_bindings(activation_ref uuid,account_id uuid,entitlement_id uuid,license_namespace text,install_id_hash text,installer_receipt_id_hash text,checkout_id uuid,claim_id uuid);
      create table public.sidestream_paid_acquisition_checkouts(id uuid primary key,environment text,payment_state text,claim_state text,verified_checkout_session_ref text,canonical_payment_ref text,verified_quantity int,verified_product_ref text,verified_price_ref text);
      create table public.sidestream_paid_acquisition_claims(id uuid primary key,checkout_id uuid,environment text,account_ref uuid,entitlement_ref uuid,activation_ref uuid,claim_state text,canonical_payment_ref text);
      create table public.sidestream_account_devices(account_id uuid,license_namespace text,device_id_hash text,revoked_at timestamptz,active_slot int);
    `));
    await pool.query(scope(await readFile(new URL('../db/migrations/20261022003000_add_paid_initial_authorizations.sql',import.meta.url),'utf8')));
    await pool.query(scope(`insert into public.sidestream_accounts values ($1)`),[a]);
    await pool.query(scope(`insert into public.sidestream_licenses values ($1,$2,'active','active','sidestream_unlimited','cs_fixture','pi_fixture')`),[l,a]);
    await pool.query(scope(`insert into public.sidestream_activation_sessions values ($1,$2,$3,now(),'paid-acquisition-mc-v1','production',$4,$5)`),[act,a,l,device,f.target.version]);
    await pool.query(scope(`insert into public.sidestream_license_tokens values ($1,$2,$3,$4,$5,null,now()+interval '1 hour')`),[token,a,l,act,device]);
    await pool.query(scope(`insert into public.sidestream_paid_activation_installation_identity values ($1,'production',$2,$3)`),[act,f.input.installIdHash,f.receipt.installerReceiptIdHash]);
    await pool.query(scope(`insert into public.sidestream_paid_telemetry_profile_bindings values ($1,$2,$3,'production',$4,$5,$6,$7)`),[act,a,l,f.input.installIdHash,f.receipt.installerReceiptIdHash,p,c]);
    await pool.query(scope(`insert into public.sidestream_paid_acquisition_checkouts values ($1,'production','active','claimed','cs_fixture','pi_fixture',1,'prod_fixture','price_fixture')`),[p]);
    await pool.query(scope(`insert into public.sidestream_paid_acquisition_claims values ($1,$2,'production',$3,$4,$5,'claimed','pi_fixture')`),[c,p,a,l,act]);
    await pool.query(scope(`insert into public.sidestream_account_devices values ($1,'production',$2,null,1)`),[a,device]);
    async function issue(input=f.input,auth=credential) {
      const client=await pool.connect();await client.query('begin');
      try {
        const result=await issueInitialAuthorization({query:(sql,values)=>client.query(scope(sql),values)},input,f.authority,auth);
        await client.query('commit');return result;
      } catch(error) {await client.query('rollback');throw error;} finally{client.release();}
    }
    const initial=await issue();assert.deepEqual(await issue(),initial);
    assert.deepEqual(await Promise.all([issue(),issue()]),[initial,initial]);
    assert.equal((await pool.query(scope('select count(*)::int n from public.sidestream_paid_initial_authorizations'))).rows[0].n,1);
    const altered={...f.input,receiptBytes:Buffer.from(JSON.stringify(f.receipt)+'\n').toString('base64')};
    await assert.rejects(issue(altered),/conflict/);
    await assert.rejects(issue({...f.input,installIdHash:'9'.repeat(64)}),/not_authorized/);
    await assert.rejects(issue(f.input,{...credential,deviceIdHash:'9'.repeat(64)}),/not_authorized/);
    for(const [table,set,restore] of [
      ['sidestream_licenses',"entitlement_status='revoked'","entitlement_status='active'"],
      ['sidestream_paid_acquisition_checkouts',"payment_state='refunded'","payment_state='active'"],
      ['sidestream_paid_acquisition_checkouts',"payment_state='disputed'","payment_state='active'"],
      ['sidestream_paid_acquisition_claims',"claim_state='unclaimed'","claim_state='claimed'"],
      ['sidestream_account_devices','revoked_at=now()','revoked_at=null'],
      ['sidestream_license_tokens','revoked_at=now()','revoked_at=null'],
      ['sidestream_license_tokens',"expires_at=now()-interval '1 hour'","expires_at=now()+interval '1 hour'"],
      ['sidestream_paid_activation_installation_identity',"license_namespace='test'","license_namespace='production'"],
      ['sidestream_paid_activation_installation_identity',"installer_receipt_id_hash=repeat('9',64)","installer_receipt_id_hash=repeat('c',64)"],
      ['sidestream_licenses',"stripe_checkout_session_id='cs_other'","stripe_checkout_session_id='cs_fixture'"],
      ['sidestream_activation_sessions',"device_id_hash=repeat('9',64)","device_id_hash=repeat('f',64)"],
      ['sidestream_activation_sessions',"app_version='1.0.98'","app_version='1.0.99'"]
    ]) {
      await pool.query(scope(`update public.${table} set ${set}`));
      await assert.rejects(issue(),/not_authorized/);
      await pool.query(scope(`update public.${table} set ${restore}`));
      assert.deepEqual(await issue(),initial);
    }
    await assert.rejects(pool.query(scope("update public.sidestream_paid_initial_authorizations set lineage='changed'")),/immutable/);
    await assert.rejects(pool.query(scope('delete from public.sidestream_paid_initial_authorizations')),/immutable/);
  } finally {
    await pool.query('drop schema if exists "'+schema+'" cascade');await pool.end();
  }
});

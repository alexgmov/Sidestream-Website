import assert from 'node:assert/strict';
import {generateKeyPairSync, sign, verify} from 'node:crypto';
import test from 'node:test';
import {loadInjectedModule} from './helpers/handler-loader.mjs';
const manifests=await loadInjectedModule(new URL('../api/_lib/paid-release-manifest.ts',import.meta.url),{});
export const initialModule=await loadInjectedModule(new URL('../api/_lib/paid-initial-authorization.ts',import.meta.url),{'./paid-release-manifest.js':manifests});
const {INITIAL_SCOPE,loadInitialAuthority,prepareInitialAuthorization,qualificationInitialArtifact}=initialModule;

export function fixture() {
  const keys=Array.from({length:4},()=>generateKeyPairSync('ed25519'));
  const raw=key=>key.export({type:'spki',format:'der'}).subarray(-32).toString('base64');
  const target={id:'generic-first-a',version:'1.0.99',sha256:'a'.repeat(64),manifestSha256:'b'.repeat(64)};
  const lineage='generic-first-qualification';
  const account='72000000-0000-4000-8000-000000000001';
  const catalog={schema:'sidestream.paid-initial-catalog.v1',scope:INITIAL_SCOPE,initialKey:raw(keys[3].publicKey),targets:[{lineage,target}]};
  const envelope=value=>{const bytes=Buffer.from(JSON.stringify(value));return JSON.stringify({payload:bytes.toString('base64'),signature:sign(null,bytes,keys[0].privateKey).toString('base64')});};
  const env={SIDESTREAM_PAID_INITIAL_ENABLED:'qualification',SIDESTREAM_PAID_INITIAL_RELEASE_KEY:raw(keys[0].publicKey),
    SIDESTREAM_PAID_INITIAL_POLICY_KEY:raw(keys[1].publicKey),SIDESTREAM_PAID_INITIAL_CONTINUATION_KEY:raw(keys[2].publicKey),
    SIDESTREAM_PAID_INITIAL_PRIVATE_KEY:keys[3].privateKey.export({type:'pkcs8',format:'pem'}),
    SIDESTREAM_PAID_INITIAL_CATALOG:envelope(catalog),SIDESTREAM_PAID_INITIAL_QUALIFICATION_ACCOUNTS:account};
  const receipt={schemaVersion:'sidestream_installer_receipt_v2',receiptCommitMode:'atomic_replace',installerReceiptIdHash:'c'.repeat(64),
    osPlatform:'darwin',buildChannel:'production',onboardingChannel:'paid-onboarding',receiptIssuer:'macos_installer_package',
    packageIdentifier:'com.sidestream.downloader.pkg',installMethod:'mac_native_pkg',packageVersion:target.version,
    verification:{status:'passed',expectedVersion:target.version,installedVersion:target.version}};
  const input={lineage,target,receiptBytes:Buffer.from(JSON.stringify(receipt)).toString('base64'),installIdHash:'d'.repeat(64)};
  return {keys,raw,target,lineage,account,catalog,envelope,env,receipt,input,authority:loadInitialAuthority(env)};
}
test('initial authority is separately pinned, offline authorized, and qualification-only',()=>{
  const f=fixture(); assert.equal(f.authority.pin,f.raw(f.keys[3].publicKey));
  for(const change of [e=>delete e.SIDESTREAM_PAID_INITIAL_ENABLED,e=>e.SIDESTREAM_PAID_INITIAL_ENABLED='production',
    e=>e.SIDESTREAM_PAID_INITIAL_QUALIFICATION_ACCOUNTS='',e=>e.SIDESTREAM_PAID_INITIAL_POLICY_KEY=f.raw(f.keys[3].publicKey),
    e=>e.SIDESTREAM_PAID_INITIAL_PRIVATE_KEY=f.keys[2].privateKey.export({type:'pkcs8',format:'pem'}),
    e=>e.SIDESTREAM_PAID_INITIAL_CATALOG=f.envelope({...f.catalog,scope:'sidestream-paid-update-production-1'}),
    e=>e.SIDESTREAM_PAID_INITIAL_CATALOG=f.envelope({...f.catalog,initialKey:f.raw(f.keys[2].publicKey)})]) {
    const env={...f.env};change(env);assert.throws(()=>loadInitialAuthority(env));
  }
});
test('initial proof binds exact receipt bytes, installation, target and scope without granting entitlement',()=>{
  const f=fixture(),p=prepareInitialAuthorization(f.input,f.authority);
  assert.equal(p.proof.scope,INITIAL_SCOPE); assert.equal(p.proof.schema,'sidestream.paid-initial.v1');
  assert.deepEqual(p.proof.target,f.target);assert.equal(p.receiptIdHash,f.receipt.installerReceiptIdHash);
  for(const mutate of [v=>v.installIdHash='bad',v=>v.extra=true,v=>v.lineage='other',v=>v.target.version='1.0.98',
    v=>v.target.manifestSha256='f'.repeat(64),v=>v.receiptBytes+='\n',v=>v.receiptBytes=Buffer.alloc(65537).toString('base64')]) {
    const input=structuredClone(f.input);mutate(input);assert.throws(()=>prepareInitialAuthorization(input,f.authority));
  }
  for(const mutate of [r=>r.verification.status='pending',r=>r.onboardingChannel='standard',r=>r.packageVersion='1.0.98',
    r=>r.receiptIssuer='shell',r=>r.verification.installedVersion='1.0.98',r=>r.installerReceiptIdHash=true]) {
    const receipt=structuredClone(f.receipt);mutate(receipt);
    assert.throws(()=>prepareInitialAuthorization({...f.input,receiptBytes:Buffer.from(JSON.stringify(receipt)).toString('base64')},f.authority));
  }
  const changed=prepareInitialAuthorization({...f.input,receiptBytes:Buffer.from(JSON.stringify(f.receipt)+'\n').toString('base64')},f.authority);
  assert.notEqual(changed.requestHash,p.requestHash);assert.notEqual(changed.proof.acquisition.receiptSha256,p.proof.acquisition.receiptSha256);
  const signature=sign(null,p.payload,f.authority.key);
  assert.equal(verify(null,p.payload,f.keys[3].publicKey,signature),true);
  for(const key of f.keys.slice(0,3))assert.equal(verify(null,p.payload,key.publicKey,signature),false);
});

test('qualification fulfillment requires an offline-signed exact artifact and selected paid account',()=>{
  const f=fixture(),manifest={schemaVersion:1,platform:'macos-universal',version:f.target.version,
    filename:'Sidestream-Unlimited-1.0.99-Mac-Installer.dmg',sizeBytes:123,sha256:'e'.repeat(64),
    artifactPathname:'sidestream/qualification/Sidestream-Unlimited-1.0.99-Mac-Installer.dmg'};
  const value={schema:'sidestream.paid-initial-artifact.v1',scope:INITIAL_SCOPE,lineage:f.lineage,manifest};
  const env={...f.env,SIDESTREAM_PAID_INITIAL_ARTIFACT:f.envelope(value)};
  assert.deepEqual(qualificationInitialArtifact(env,f.account),manifest);
  assert.throws(()=>qualificationInitialArtifact(env,'72000000-0000-4000-8000-000000000002'));
  for(const mutate of [v=>v.lineage='wrong',v=>v.manifest.version='1.0.98',
    v=>v.manifest.artifactPathname='sidestream/public/'+manifest.filename,v=>v.scope='other']) {
    const altered=structuredClone(value);mutate(altered);
    assert.throws(()=>qualificationInitialArtifact({...env,SIDESTREAM_PAID_INITIAL_ARTIFACT:f.envelope(altered)},f.account));
  }
});

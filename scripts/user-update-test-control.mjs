// Isolated Test protocol v2. No deployed routes or customer release pointers.
import crypto from 'node:crypto';
export const testScope='sidestream-user-release-test-2';
const hash=/^[a-f0-9]{64}$/;
const id=/^[a-z0-9][a-z0-9-]{0,63}$/;
export function target(value) {
 if(!value || !id.test(value.id) || !hash.test(value.sha256) || !hash.test(value.manifestSha256) ||
    !Number.isSafeInteger(value.bytes) || value.bytes<1 || value.bytes>2_000_000_000) throw Error('Invalid immutable Test target');
 return {id:value.id,sha256:value.sha256,manifestSha256:value.manifestSha256,bytes:value.bytes};
}
export function cohort(client,salt,percent) {
 if(!hash.test(client)||!id.test(salt)||!Number.isInteger(percent)||percent<0||percent>100) throw Error('Invalid cohort');
 const bucket=crypto.createHash('sha256').update(`${testScope}:${salt}:${client}`).digest().readUInt32BE(0)%10000;
 return bucket<percent*100;
}
export function validateControl(catalog,control) {
 if(catalog.scope!==testScope || control.schema!=='sidestream.user-control.v2')throw Error('Wrong Test protocol');
 const select=(choice,kind='cep')=>{
  if(choice===null)return null;
  if(!choice || !Object.hasOwn(catalog.releases,choice.id))throw Error('Unknown release');
  const exact=target(catalog.releases[choice.id].target);
  if((catalog.releases[choice.id].kind||'cep')!==kind)throw Error('Release kind mismatch');
  if(choice.sha256!==exact.sha256)throw Error('Exact release hash required');
  cohort('0'.repeat(64),choice.salt,choice.percent);
  return {...choice,target:exact};
 };
 const download=select(control.download), activate=select(control.activate);
 if(!Array.isArray(control.revoked)||control.revoked.length>100||control.revoked.some(h=>!hash.test(h)))throw Error('Invalid revocation set');
 if([download,activate].some(c=>c&&control.revoked.includes(c.target.sha256)))throw Error('Revoked target');
 let rollback=null;
 if(control.rollback!==null) {
  const r=control.rollback;
  if(!activate || !hash.test(r?.fromSha256) || r.toSha256!==activate.target.sha256 || r.fromSha256===r.toSha256)throw Error('Exact rollback source and destination required');
  rollback={fromSha256:r.fromSha256,toSha256:r.toSha256};
 }
 const companion=control.companion ? {download:select(control.companion.download,'companion'),activate:select(control.companion.activate,'companion')} : null;
 if(companion && [companion.download,companion.activate].some(c=>c&&control.revoked.includes(c.target.sha256)))throw Error('Revoked companion');
 return {download,activate,rollback,companion,revoked:[...new Set(control.revoked)]};
}
export function makePolicy(catalog,control,client,revision,now=Date.now()/1000) {
 if(!hash.test(client)||!Number.isSafeInteger(revision)||revision<1||!Number.isFinite(now))throw Error('Invalid client/revision/time');
 const checked=validateControl(catalog,control);
 const select=choice=>choice&&cohort(client,choice.salt,choice.percent)?choice.target:null;
 const activate=select(checked.activate);
 return {schema:'sidestream.user-policy.v2',scope:testScope,client,revision,issuedAt:now,expiresAt:now+60,
  download:select(checked.download),activate,rollback:activate?checked.rollback:null,revoked:checked.revoked,
  companion:checked.companion?{download:select(checked.companion.download),activate:select(checked.companion.activate)}:null};
}
export function rangeFor(header,ifRange,etag,size) {
 if(!Number.isSafeInteger(size)||size<1)throw Error('Invalid artifact length');
 if(!header)return {status:200,start:0,end:size-1};
 if(ifRange!==etag)return {status:412};
 const match=/^bytes=(\d+)-(\d+)$/.exec(header);
 if(!match)return {status:416};
 const start=Number(match[1]),end=Number(match[2]);
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||end>=size||end-start+1>4*1024*1024)return {status:416};
 return {status:206,start,end};
}

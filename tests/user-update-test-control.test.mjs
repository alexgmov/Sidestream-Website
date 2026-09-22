import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {testScope,cohort,validateControl,makePolicy,rangeFor} from '../scripts/user-update-test-control.mjs';
import {createServer,verifyCatalog} from '../scripts/user-update-test-server.mjs';
const t=(id,h)=>({id,sha256:h.repeat(64),manifestSha256:'f'.repeat(64),bytes:10});
const a=t('test-a','a'),b=t('test-b','b');
const catalog={scope:testScope,releases:{'test-a':{target:a},'test-b':{target:b}}};
const choice=(t,percent=100)=>({id:t.id,sha256:t.sha256,salt:'qualification',percent});
const control={schema:'sidestream.user-control.v2',download:choice(b),activate:choice(a),rollback:null,revoked:[]};
const client='c'.repeat(64);
test('download and activation targets and cohorts are independent',()=>{
 const p=makePolicy(catalog,control,client,1,1000);
 assert.deepEqual(p.download,b);assert.deepEqual(p.activate,a);assert.equal(p.expiresAt,1060);
 const q=makePolicy(catalog,{...control,download:choice(b,0)},client,2,1000);
 assert.equal(q.download,null);assert.deepEqual(q.activate,a);
 assert.equal(makePolicy(catalog,{...control,activate:choice(a,0)},client,3).activate,null);
 assert.equal(makePolicy(catalog,{...control,activate:null},client,3).activate,null);
 for(const bad of ['',null,'email@example.com'])assert.throws(()=>makePolicy(catalog,control,bad,1));
});
test('stable cohorts do not expand outside operator percentage',()=>{
 let count=0;
 for(let n=0;n<1000;n++) {
  const c=crypto.createHash('sha256').update(String(n)).digest('hex');
  assert.equal(cohort(c,'test',0),false);assert.equal(cohort(c,'test',100),true);
  const included=cohort(c,'test',25);assert.equal(included,cohort(c,'test',25));
  if(included){count++;assert.equal(cohort(c,'test',50),true);}
 }
 assert.ok(count>190&&count<310);
});
test('exact rollback authority, revocation and immutable hashes fail closed',()=>{
 assert.throws(()=>validateControl(catalog,{...control,activate:{...choice(a),sha256:b.sha256}}));
 assert.throws(()=>validateControl(catalog,{...control,revoked:[b.sha256]}));
 assert.throws(()=>validateControl(catalog,{...control,rollback:{fromSha256:b.sha256,toSha256:b.sha256}}));
 assert.deepEqual(validateControl(catalog,{...control,rollback:{fromSha256:b.sha256,toSha256:a.sha256}}).rollback,{fromSha256:b.sha256,toSha256:a.sha256});
 assert.throws(()=>validateControl({...catalog,scope:'production'},control));
});
test('resume requires exact strong ETag and bounded valid ranges',()=>{
 assert.deepEqual(rangeFor('bytes=2-7','"abc"','"abc"',10),{status:206,start:2,end:7});
 assert.equal(rangeFor('bytes=2-7','"old"','"abc"',10).status,412);
 for(const h of ['bytes=9-10','bytes=3-2','bytes=1-2,4-5','bytes=-3','bytes=0-99999999'])assert.equal(rangeFor(h,'"abc"','"abc"',10).status,416);
});
test('companion policy has separate exact choices and rejects CEP identities',()=>{
 const cat={...catalog,releases:{...catalog.releases,'app-next':{kind:'companion',target:t('app-next','d')}}};
 const item=cat.releases['app-next'].target;
 const p=makePolicy(cat,{...control,companion:{download:choice(item),activate:null}},client,1);
 assert.deepEqual(p.download,b);assert.deepEqual(p.companion.download,item);assert.equal(p.companion.activate,null);
 assert.throws(()=>makePolicy(cat,{...control,companion:{download:choice(b),activate:null}},client,1));
 assert.throws(()=>makePolicy(cat,{...control,download:choice(item)},client,1));
});
test('real delivery expiry, URL refresh, exact ranges, signed policies and persistent revisions',async()=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'sidestream-test-server-'));fs.chmodSync(state,0o700);
 const bytes=Buffer.from('SSTRM001abcdefgh'),manifest=Buffer.from('signed manifest fixture');
 const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
 const exact={id:'http-test',sha256:sha(bytes),manifestSha256:sha(manifest),bytes:bytes.length};
 const payload=path.join(state,'payload.bin'),metadata=path.join(state,'manifest.json');
 fs.writeFileSync(payload,bytes,{mode:0o600});fs.writeFileSync(metadata,manifest,{mode:0o600});
 const cat={scope:testScope,releases:{[exact.id]:{target:exact,payload,manifest:metadata}}};
 verifyCatalog(cat);
 const c={schema:control.schema,download:choice(exact),activate:null,rollback:null,revoked:[]};
 fs.writeFileSync(path.join(state,'control-v2.json'),JSON.stringify({control:c}),{mode:0o600});
 const keys=crypto.generateKeyPairSync('ed25519');let now=1000;
 const start=async()=>{
  const server=createServer({catalog:cat,state,key:keys.privateKey,ticketKey:Buffer.alloc(32,7),clock:()=>now});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));return server;
 };
 let server=await start();
 const get=route=>fetch(`http://127.0.0.1:${server.address().port}${route}`);
 const decode=async response=>{const e=await response.json(),raw=Buffer.from(e.payload,'base64');assert.ok(crypto.verify(null,raw,keys.publicKey,Buffer.from(e.signature,'base64')));return JSON.parse(raw);};
 try {
  const p=await decode(await get('/policy?client='+client));assert.equal(p.activate,null);
  const delivery=await decode(await get(`/delivery?client=${client}&id=${exact.id}&sha256=${exact.sha256}`));
  const chunk=await fetch(`http://127.0.0.1:${server.address().port}${delivery.route}`,{headers:{Range:'bytes=3-9','If-Range':'"'+exact.sha256+'"'}});
  assert.equal(chunk.status,206);assert.equal(chunk.headers.get('content-range'),`bytes 3-9/${bytes.length}`);assert.deepEqual(Buffer.from(await chunk.arrayBuffer()),bytes.subarray(3,10));
  now=1061;assert.equal((await get(delivery.route)).status,401);
  const refreshed=await decode(await get(`/delivery?client=${client}&id=${exact.id}&sha256=${exact.sha256}`));assert.notEqual(refreshed.route,delivery.route);
  await new Promise(r=>server.close(r));server=await start();
  assert.ok((await decode(await get('/policy?client='+client))).revision>p.revision);
  fs.writeFileSync(path.join(state,'control-v2.json'),JSON.stringify({control:{...c,download:null,revoked:[exact.sha256]}}));
  assert.equal((await get(refreshed.route)).status,403);
  fs.appendFileSync(payload,'tamper');assert.throws(()=>verifyCatalog(cat));
 }finally {server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(state,{recursive:true,force:true});}
});

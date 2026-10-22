import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {scope,paidScope,sha,signed,verified,paidProof,continuePaid} from '../scripts/production-update-protocol.mjs';
import {hold,atomic,verifyCatalog,createServer,applyControl,loadTrust,loadKeys,json,policyForLineage} from '../scripts/production-update-service.mjs';
import {signRequest,controlSnapshot,keyId} from '../scripts/user-update-test-operator.mjs';
import {makePolicy} from '../scripts/user-update-test-control.mjs';

const pair=()=>crypto.generateKeyPairSync('ed25519');
const raw=key=>key.export({type:'spki',format:'der'}).subarray(-32).toString('base64');
const copy=value=>JSON.parse(JSON.stringify(value));
const client='c'.repeat(64);
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sidestream-production-service-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const state=path.join(root,'state'),artifacts=path.join(root,'artifacts');
  fs.mkdirSync(state,{mode:0o700});fs.mkdirSync(artifacts,{mode:0o700});
  const release=pair(),policy=pair(),continuation=pair(),operator=pair();
  const trust=loadTrust({scope,releaseKey:raw(release.publicKey),policyKey:raw(policy.publicKey),continuationKey:raw(continuation.publicKey)});
  const keys={...trust,policy:policy.privateKey,continuation:continuation.privateKey,ticket:crypto.randomBytes(32)};
  const operators={schema:'sidestream.user-operators.v1',keys:[{id:keyId(operator.privateKey),publicKey:operator.publicKey.export({type:'spki',format:'pem'})}]};
  const catalog={scope,releases:{}};
  for (let n=0;n<3;n++) {
    const id='production-'+String.fromCharCode(97+n),bytes=Buffer.from('payload '+id),payloadBytes=Buffer.concat([Buffer.from('SSTRM001'),bytes]);
    const manifest=signed({schema:'sidestream.user-release.v2',scope,id,version:`1.0.${40+n}`,sequence:n+1,
      platform:'darwin-universal',payloadBytes:payloadBytes.length,kind:'cep',customerOnboarding:'paid-onboarding',
      files:[{path:'index.html',sha256:sha(bytes),bytes:bytes.length,executable:false}]},release.privateKey);
    const manifestBytes=Buffer.from(JSON.stringify(manifest)),payload=path.join(artifacts,id+'.bin'),metadata=path.join(artifacts,id+'.json');
    fs.writeFileSync(payload,payloadBytes,{mode:0o600});fs.writeFileSync(metadata,manifestBytes,{mode:0o600});
    catalog.releases[id]={target:{id,sha256:sha(payloadBytes),manifestSha256:sha(manifestBytes),bytes:payloadBytes.length},payload,manifest:metadata};
  }
  const checked=verifyCatalog(catalog,keys.release,artifacts);
  const targets=Object.values(checked.releases).map(item=>({id:item.target.id,sha256:item.target.sha256,manifestSha256:item.target.manifestSha256,version:item.version}));
  atomic(path.join(state,'control.json'),{revision:1,control:hold,history:[{revision:1,control:hold}]});
  atomic(path.join(state,'counter.json'),{revision:0});
  const acquisition={receiptSha256:'a'.repeat(64),installIdHash:'b'.repeat(64),version:'1.0.21',platform:'darwin',buildChannel:'production',onboardingChannel:'paid-onboarding',
    bundleId:'com.sidestream.downloader',extensionId:'com.sidestream.downloader.panel',packageIdentifier:'com.sidestream.downloader.pkg',
    receiptIssuer:'macos_installer_package',installMethod:'mac_native_pkg',receiptSource:'mac_system_application_support'};
  const seed={schema:'sidestream.paid-continuation.v1',scope:paidScope,acquisition,links:[{from:{receiptSha256:acquisition.receiptSha256,version:acquisition.version},to:targets[0]}]};
  const snapshot=()=>controlSnapshot(json(path.join(state,'control.json')));
  const apply=control=>applyControl({state,catalog:checked,operators,keys,request:signRequest({scope,control,snapshot:snapshot(),privateKey:operator.privateKey,now:1000}),now:1000});
  const choice=(target,percent=100)=>({id:target.id,sha256:target.sha256,salt:'production-rollout',percent});
  return {root,state,artifacts,catalog:checked,unchecked:catalog,keys,trust,release,policy,continuation,operator,operators,targets,seed,apply,snapshot,choice};
}

test('offline seed authorizes a third and subsequent release without changing acquisition or granting entitlement',t=>{
  const f=fixture(t),[a,b,c]=f.targets;
  const control={...hold,download:f.choice(c)};
  let request={client,prior:signed(f.seed,f.release.privateKey),target:c};
  const invoke=(request,control)=>continuePaid({request,catalog:f.catalog,policy:makePolicy(f.catalog,control,client,1,1000,scope),releaseKey:f.keys.release,continuationKey:f.keys.continuation});
  const issued=invoke(request,control),proof=paidProof(issued,[f.continuation.publicKey]);
  assert.deepEqual(proof.acquisition,f.seed.acquisition);assert.equal(proof.links.length,1);assert.deepEqual(proof.links[0].to,c);
  // Reanchoring survives many updates and exact rollback without finite chain exhaustion.
  for(let n=0;n<40;n++) {
    const target=n%2?a:b;request={client,prior:n?request.prior:issued,target};
    request.prior=invoke(request,{...hold,activate:f.choice(target),rollback:{fromSha256:c.sha256,toSha256:target.sha256}});
    assert.equal(paidProof(request.prior,[f.continuation.publicKey]).links.length,1);
  }
  assert.deepEqual(Object.keys(proof).sort(),['acquisition','links','schema','scope']);
  assert.throws(()=>verified(issued,[f.release.publicKey]));
});

test('separate initial authority extends only its exact catalog anchor and never gains release or continuation authority',t=>{
  const f=fixture(t),initial=pair(),[a,,c]=f.targets;
  const lineage='generic-first-qualification';
  f.catalog.releases[a.id].paidInitialLineage=lineage;
  const acquisition={...f.seed.acquisition,version:a.version};
  const initialProof={schema:'sidestream.paid-initial.v1',scope:'sidestream-paid-initial-production-1',lineage,acquisition,target:a};
  const invoke=(proof=initialProof,key=initial.privateKey,initialKey=initial.publicKey)=>continuePaid({
    request:{client,prior:signed(proof,key),target:c},catalog:f.catalog,
    policy:makePolicy(f.catalog,{...hold,download:f.choice(c)},client,1,1000,scope),
    releaseKey:f.keys.release,continuationKey:f.keys.continuation,initialKey});
  const continued=paidProof(invoke(),[f.continuation.publicKey]);
  assert.deepEqual(continued.acquisition,acquisition);assert.deepEqual(continued.links[0].to,c);
  for(const key of [f.release.privateKey,f.policy.privateKey,f.continuation.privateKey])assert.throws(()=>invoke(initialProof,key));
  assert.throws(()=>invoke(initialProof,initial.privateKey,null));
  for(const mutate of [p=>p.scope=paidScope,p=>p.lineage='wrong',p=>p.target={...a,version:'1.0.1'},
    p=>p.acquisition.version='1.0.1',p=>p.target={...a,manifestSha256:'f'.repeat(64)},p=>p.extra=true]) {
    const proof=structuredClone(initialProof);mutate(proof);assert.throws(()=>invoke(proof));
  }
  assert.throws(()=>paidProof(signed(initialProof,initial.privateKey),[f.release.publicKey,f.continuation.publicKey]));
  const pins={scope,releaseKey:raw(f.release.publicKey),policyKey:raw(f.policy.publicKey),continuationKey:raw(f.continuation.publicKey)};
  assert.ok(loadTrust({...pins,initialKey:raw(initial.publicKey)}).initial);
  assert.throws(()=>loadTrust({...pins,initialKey:raw(f.release.publicKey)}));
});

test('signed companion selection isolates generic and legacy lineages without fallback',()=>{
  const generic={id:'generic-companion'},legacy={id:'legacy-companion'};
  const catalog={releases:{[generic.id]:{paidInitialLineage:'generic-one'},[legacy.id]:{}}};
  const policy={companion:{download:generic,activate:generic}};
  assert.deepEqual(policyForLineage(policy,catalog,'generic-one').companion,{download:generic,activate:generic,lineage:'generic-one'});
  assert.deepEqual(policyForLineage(policy,catalog,'unknown').companion,{download:null,activate:null,lineage:'unknown'});
  assert.deepEqual(policyForLineage(policy,catalog).companion,{download:null,activate:null});
  assert.deepEqual(policyForLineage({companion:{download:legacy,activate:null}},catalog).companion,{download:legacy,activate:null});
  assert.equal(policyForLineage({companion:{download:legacy,activate:null}},catalog,'generic-one').companion.download,null);
});

test('forged, private-scope, malformed, wrong key and client-invented acquisitions/targets cannot be signed',t=>{
  const f=fixture(t),target=f.targets[2],prior=signed(f.seed,f.release.privateKey);
  const invoke=request=>continuePaid({request,catalog:f.catalog,policy:makePolicy(f.catalog,{...hold,download:f.choice(target)},client,1,1000,scope),releaseKey:f.keys.release,continuationKey:f.keys.continuation});
  const req={client,prior,target};
  const mutations=[r=>r.client='d'.repeat(64),r=>r.extra=true,r=>r.target.version='1.0.999',r=>r.target.sha256='f'.repeat(64),r=>r.target.extra=1,
    r=>r.prior.signature=crypto.randomBytes(64).toString('base64'),r=>r.prior=signed(f.seed,pair().privateKey),
    r=>r.prior=signed({...f.seed,scope:'sidestream-customer-migration-private-1'},f.release.privateKey),
    r=>r.prior=signed({...f.seed,links:[]},f.release.privateKey),r=>r.prior=signed({...f.seed,acquisition:{...f.seed.acquisition,buildChannel:'test'}},f.release.privateKey),
    r=>r.prior.payload+=' ',r=>r.prior={...r.prior,publicKey:raw(f.release.publicKey)}];
  for(const mutate of mutations){const r=copy(req);mutate(r);assert.throws(()=>invoke(r));}
  for(const control of [hold,{...hold,download:f.choice(target,0)},{...hold,revoked:[target.sha256]}])
    assert.throws(()=>continuePaid({request:req,catalog:f.catalog,policy:makePolicy(f.catalog,control,client,1,1000,scope),releaseKey:f.keys.release,continuationKey:f.keys.continuation}));
  const wrongKind=copy(f.catalog);wrongKind.releases[target.id].customerOnboarding='standard';
  assert.throws(()=>continuePaid({request:req,catalog:wrongKind,policy:makePolicy(f.catalog,{...hold,download:f.choice(target)},client,1,1000,scope),releaseKey:f.keys.release,continuationKey:f.keys.continuation}));
});

test('production signed operator controls enforce CAS, scope, separate keys, replay, expiry and durable hold',t=>{
  const f=fixture(t),control={...hold,download:f.choice(f.targets[1])};
  const request=signRequest({scope,control,snapshot:f.snapshot(),privateKey:f.operator.privateKey,now:1000});
  const apply=(r,extra={})=>applyControl({state:f.state,catalog:f.catalog,operators:f.operators,keys:f.keys,request:r,now:1000,...extra});
  assert.throws(()=>apply({...request,signature:'a'.repeat(88)}));
  assert.throws(()=>apply(signRequest({control,snapshot:f.snapshot(),privateKey:f.operator.privateKey,now:1000})));
  assert.throws(()=>apply(request,{now:1301}));
  const operatorAsPolicy={schema:f.operators.schema,keys:[{id:keyId(f.policy.privateKey),publicKey:f.policy.publicKey.export({type:'spki',format:'pem'})}]};
  assert.throws(()=>apply(signRequest({scope,control,snapshot:f.snapshot(),privateKey:f.policy.privateKey,now:1000}),{operators:operatorAsPolicy}));
  assert.equal(apply(request).revision,2);assert.throws(()=>apply(request));
  f.apply(hold);assert.deepEqual(json(path.join(f.state,'control.json')).control,hold);assert.throws(()=>apply(request));
  const current=json(path.join(f.state,'control.json'));assert.equal(current.history.length,3);assert.equal(current.history[1].authorization.operator,keyId(f.operator.privateKey));
});

test('actual HTTP service signs policy, serves immutable ranges, refreshes expiring tickets, persists revisions and issues bounded continuations',async t=>{
  const f=fixture(t),target=f.targets[2];let now=1000,server;
  const start=async()=>{server=createServer({catalog:f.catalog,state:f.state,keys:f.keys,sourceSha:'a'.repeat(40),clock:()=>now});await new Promise(r=>server.listen(0,'127.0.0.1',r));};
  await start();t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  const get=(route,options)=>fetch(`http://127.0.0.1:${server.address().port}${route}`,options);
  const post=value=>get('/continuation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
  const decode=async response=>{assert.equal(response.status,200);return verified(await response.json(),[f.policy.publicKey]);};
  assert.equal((await (await get('/health')).json()).held,true);
  const first=await decode(await get('/policy?client='+client));assert.equal(first.download,null);assert.equal(first.scope,scope);
  const request={client,prior:signed(f.seed,f.release.privateKey),target};
  assert.equal((await post(request)).status,403);
  f.apply({...hold,download:f.choice(target)});
  const issued=await post(request);assert.equal(issued.status,200);assert.deepEqual(paidProof(await issued.json(),[f.continuation.publicKey]).links[0].to,target);
  const ticket=await decode(await get(`/delivery?client=${client}&id=${target.id}&sha256=${target.sha256}`));
  assert.equal((await get(ticket.route)).status,416);
  const chunk=await get(ticket.route,{headers:{Range:'bytes=0-7','If-Range':'"'+target.sha256+'"'}});
  assert.equal(chunk.status,206);assert.equal(await chunk.text(),'SSTRM001');assert.equal(chunk.headers.get('etag'),'"'+target.sha256+'"');
  assert.equal((await get(ticket.route,{headers:{Range:'bytes=0-7','If-Range':'"bad"'}})).status,412);
  assert.equal((await get(ticket.route,{headers:{Range:'bytes=0-99999999','If-Range':'"'+target.sha256+'"'}})).status,416);
  now=1061;assert.equal((await get(ticket.route)).status,401);
  const refreshed=await decode(await get(`/delivery?client=${client}&id=${target.id}&sha256=${target.sha256}`));assert.notEqual(refreshed.route,ticket.route);
  assert.equal((await get('/policy?client=email@example.com')).status,400);
  assert.equal((await get('/policy?client='+client,{method:'POST'})).status,405);
  assert.equal((await get('/operator',{method:'POST'})).status,405);
  assert.equal((await get('/continuation',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'})).status,400);
  assert.equal((await post({...request,junk:'x'.repeat(65536)})).status,413);
  server.closeAllConnections();await new Promise(r=>server.close(r));await start();
  assert.ok((await decode(await get('/policy?client='+client))).revision>first.revision);
  f.apply({...hold,revoked:[target.sha256]});
  assert.equal((await get(refreshed.route,{headers:{Range:'bytes=0-7','If-Range':'"'+target.sha256+'"'}})).status,403);
  assert.equal((await post(request)).status,403);
  assert.equal((await get(`/releases/${target.id}/manifest.json`)).status,403);
  f.apply({...hold,download:f.choice(target)});
  const file=f.catalog.releases[target.id].payload;fs.appendFileSync(file,'tamper');
  assert.equal((await get(refreshed.route,{headers:{Range:'bytes=0-7','If-Range':'"'+target.sha256+'"'}})).status,503);
});

test('startup rejects altered, unsigned, private-scope, symlinked artifacts and non-separated keys',t=>{
  const f=fixture(t),item=f.unchecked.releases[f.targets[0].id];
  assert.throws(()=>verifyCatalog({...f.unchecked,scope:'sidestream-user-release-test-2'},f.keys.release,f.artifacts));
  assert.throws(()=>verifyCatalog(f.unchecked,pair().publicKey,f.artifacts));
  const trust={scope,releaseKey:raw(f.release.publicKey),policyKey:raw(f.policy.publicKey),continuationKey:raw(f.policy.publicKey)};
  assert.throws(()=>loadTrust(trust));
  const keysDir=path.join(f.root,'keys');fs.mkdirSync(keysDir,{mode:0o700});
  for(const [name,key]of [['policy',f.policy.privateKey],['continuation',f.continuation.privateKey]])fs.writeFileSync(path.join(keysDir,name+'.pem'),key.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  fs.writeFileSync(path.join(keysDir,'ticket.key'),f.keys.ticket,{mode:0o600});
  assert.equal(loadKeys(keysDir,f.trust).ticket.length,32);
  fs.chmodSync(path.join(keysDir,'policy.pem'),0o440);assert.throws(()=>loadKeys(keysDir,f.trust));
  fs.chmodSync(path.join(keysDir,'policy.pem'),0o600);
  fs.writeFileSync(path.join(keysDir,'release.pem'),'forbidden',{mode:0o600});assert.throws(()=>loadKeys(keysDir,f.trust));
  fs.renameSync(item.payload,item.payload+'.real');fs.symlinkSync(item.payload+'.real',item.payload);assert.throws(()=>verifyCatalog(f.unchecked,f.keys.release,f.artifacts));
  fs.unlinkSync(item.payload);fs.renameSync(item.payload+'.real',item.payload);fs.appendFileSync(item.payload,'changed');assert.throws(()=>verifyCatalog(f.unchecked,f.keys.release,f.artifacts));
});

test('real production signing CLI uses production scope and keeps output private',t=>{
  const f=fixture(t);
  const file=(name,value)=>{const p=path.join(f.root,name);fs.writeFileSync(p,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});return p;};
  const out=path.join(f.root,'signed.json');
  const result=spawnSync(process.execPath,['scripts/production-update-operator.mjs','--key',file('operator.pem',f.operator.privateKey.export({type:'pkcs8',format:'pem'})),
    '--control',file('hold.json',hold),'--snapshot',file('snapshot.json',f.snapshot()),'--out',out],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(fs.statSync(out).mode&0o077,0);
  const request=verified(json(out),[f.operator.publicKey]);assert.equal(request.scope,scope);
  const link=path.join(f.root,'operator-cli.mjs'),linkedOutput=path.join(f.root,'signed-via-link.json');
  fs.symlinkSync(path.resolve('scripts/production-update-operator.mjs'),link);
  const linked=spawnSync(process.execPath,[link,'--key',path.join(f.root,'operator.pem'),'--control',path.join(f.root,'hold.json'),
    '--snapshot',path.join(f.root,'snapshot.json'),'--out',linkedOutput],{encoding:'utf8'});
  assert.equal(linked.status,0,linked.stderr);assert.equal(verified(json(linkedOutput),[f.operator.publicKey]).scope,scope);
  const serviceLink=path.join(f.root,'service-cli.mjs');fs.symlinkSync(path.resolve('scripts/production-update-service.mjs'),serviceLink);
  const service=spawnSync(process.execPath,[serviceLink],{encoding:'utf8'});
  assert.notEqual(service.status,0);assert.match(service.stderr,/Missing --state|unprivileged service user required/);
  const imported=spawnSync(process.execPath,['--input-type=module','-'],{encoding:'utf8',
    input:'await import('+JSON.stringify('file://'+path.resolve('scripts/production-update-service.mjs'))+');'});
  assert.equal(imported.status,0,imported.stderr);
});

test('Linux administrative flock excludes concurrent writers and recovers automatically after SIGKILL', {skip:process.platform!=='linux'}, async t=>{
  const f=fixture(t),lock=path.join(f.state,'operator.lock');
  const child=spawn('/usr/bin/flock',['--nonblock','--no-fork',lock,process.execPath,'-e',"process.stdout.write('locked');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>{if(code)reject(Error('flock child exited'));});});
  assert.equal(spawnSync('/usr/bin/flock',['--nonblock',lock,'/usr/bin/true']).status,1);
  const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
  assert.equal(fs.existsSync(lock),true);
  assert.equal(spawnSync('/usr/bin/flock',['--nonblock',lock,'/usr/bin/true']).status,0);
});

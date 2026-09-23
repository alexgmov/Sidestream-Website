import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {testScope} from '../scripts/user-update-test-control.mjs';
import {signRequest,authorizeRequest,controlSnapshot,keyId} from '../scripts/user-update-test-operator.mjs';
import {applyControl} from '../scripts/user-update-test-server.mjs';

const pair=crypto.generateKeyPairSync('ed25519');
const operators={schema:'sidestream.user-operators.v1',keys:[{id:keyId(pair.privateKey),publicKey:pair.publicKey.export({type:'spki',format:'pem'})}]};
const target={id:'approved-b',sha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),bytes:10};
const catalog={scope:testScope,releases:{[target.id]:{target}}};
const control={schema:'sidestream.user-control.v2',download:null,activate:{id:target.id,sha256:target.sha256,salt:'test',percent:100},rollback:null,revoked:[],companion:null};
const request=(previous=null,now=1000)=>signRequest({control,snapshot:controlSnapshot(previous),privateKey:pair.privateKey,now});
const check=(envelope,extra={})=>authorizeRequest({envelope,operators,previous:null,catalog,now:1001,...extra});
const resign=(envelope,mutate)=>{
  const value=JSON.parse(Buffer.from(envelope.payload,'base64'));mutate(value);
  const bytes=Buffer.from(JSON.stringify(value));
  return {payload:bytes.toString('base64'),signature:crypto.sign(null,bytes,pair.privateKey).toString('base64')};
};

test('exact operator signature, Test scope, field bounds and five-minute expiry',()=>{
  const signed=request();assert.deepEqual(check(signed).control,control);
  assert.throws(()=>check({...signed,signature:Buffer.alloc(64).toString('base64')}));
  assert.throws(()=>check(signed,{operators:{...operators,keys:[]}}));
  assert.throws(()=>check(signed,{now:1300}));
  assert.throws(()=>check(signed,{now:990}));
  for(const mutate of [r=>r.scope='production',r=>r.expiresAt=1400,r=>r.control.activate.sha256='c'.repeat(64),
    r=>r.control.download={...r.control.activate,percent:101},r=>r.control.revoked=[target.sha256],
    r=>r.control.activate.email='private@example.invalid',r=>r.expected.extra=true,r=>r.extra=true])
    assert.throws(()=>check(resign(signed,mutate)));
});

test('atomic audit rejects replay, stale approval after hold, reused nonce and concurrent writer',()=>{
  const state=fs.mkdtempSync(path.join(os.tmpdir(),'operator-audit-'));fs.chmodSync(state,0o700);
  try {
    const signed=request();
    applyControl({catalog,state,request:signed,operators,now:1001});
    const file=path.join(state,'control-v2.json'),before=fs.readFileSync(file);
    const saved=JSON.parse(before);assert.equal(saved.revision,1);assert.equal(saved.history[0].authorization.operator,operators.keys[0].id);
    assert.throws(()=>applyControl({catalog,state,request:signed,operators,now:1002}));assert.deepEqual(fs.readFileSync(file),before);
    const pending=request(saved);
    applyControl({catalog,state,control:{...control,activate:null},now:1003});
    assert.throws(()=>applyControl({catalog,state,request:pending,operators,now:1004}));
    const held=JSON.parse(fs.readFileSync(file));assert.equal(held.control.activate,null);
    const reused=resign(request(held),r=>r.nonce=saved.history[0].authorization.nonce);
    assert.throws(()=>applyControl({catalog,state,request:reused,operators,now:1005}));
    fs.writeFileSync(path.join(state,'operator-v2.lock'),'live owner');
    assert.throws(()=>applyControl({catalog,state,request:request(held),operators,now:1005}));
    assert.equal(fs.readFileSync(path.join(state,'operator-v2.lock'),'utf8'),'live owner');
    assert.deepEqual(JSON.parse(fs.readFileSync(file)),held);
  } finally {fs.rmSync(state,{recursive:true,force:true});}
});

test('legacy local controls receive a revision and cannot create an ABA replay',()=>{
  const previous={control,history:[{control}]};
  assert.equal(controlSnapshot(previous).revision,1);
  const next={...previous,revision:3,history:[{control},{control},{control}]};
  assert.throws(()=>check(request(previous),{previous:next}));
});

test('real signing and application CLIs preserve state on repeat and do not expose a write server',()=>{
  const state=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'operator-cli-')));fs.chmodSync(state,0o700);
  const write=(name,value)=>{const file=path.join(state,name);fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});return file;};
  const run=(script,args)=>spawnSync(process.execPath,[script,...args],{encoding:'utf8'});
  try {
    const payload=write('payload','SSTRM001fixture'),manifest=write('manifest','manifest');
    const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const exact={...target,sha256:sha(payload),manifestSha256:sha(manifest),bytes:fs.statSync(payload).size};
    const cat=write('catalog.json',{scope:testScope,releases:{[exact.id]:{target:exact,payload,manifest}}});
    const controlFile=write('requested.json',{...control,activate:{...control.activate,sha256:exact.sha256}});
    const snapshotFile=write('snapshot.json',controlSnapshot(null));
    const key=write('operator.pem',pair.privateKey.export({type:'pkcs8',format:'pem'}));
    write('operators-v2.json',operators);
    const out=path.join(state,'request.json');
    const sign=run('scripts/user-update-test-operator.mjs',['--key',key,'--control',controlFile,'--snapshot',snapshotFile,'--out',out]);
    assert.equal(sign.status,0,sign.stderr);assert.equal(fs.statSync(out).mode&0o777,0o600);
    const args=['--set-request','--state',state,'--catalog',cat,'--request',out];
    const applied=run('scripts/user-update-test-server.mjs',args);assert.equal(applied.status,0,applied.stderr);
    const saved=fs.readFileSync(path.join(state,'control-v2.json'));assert.equal(JSON.parse(saved).control.activate.sha256,exact.sha256);
    assert.notEqual(run('scripts/user-update-test-server.mjs',args).status,0);
    assert.deepEqual(fs.readFileSync(path.join(state,'control-v2.json')),saved);
    write('policy.pem',pair.privateKey.export({type:'pkcs8',format:'pem'}));
    const collision=run('scripts/user-update-test-server.mjs',args);
    assert.notEqual(collision.status,0);assert.match(collision.stderr,/Separate operator/);
    assert.deepEqual(fs.readFileSync(path.join(state,'control-v2.json')),saved);
  } finally {fs.rmSync(state,{recursive:true,force:true});}
});

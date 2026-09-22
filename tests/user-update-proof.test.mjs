import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {envelope,policy,scope} from '../scripts/user-update-proof-authority.mjs';
const target={id:'test-b',sha256:'b'.repeat(64),manifestSha256:'c'.repeat(64),bytes:99};
const catalog={scope,releases:{'test-b':{target}}};
test('held downloads carry no activation authority',()=>{
 const p=policy(catalog,{download:'test-b',activate:null},1,1000);
 assert.deepEqual(p.download,target);assert.equal(p.activate,null);assert.equal(p.expiresAt,1060);
});
test('activation requires exact immutable identity and full hash',()=>{
 for(const control of [{download:'test-b',activate:'test-a',activateHash:target.sha256},{download:'test-b',activate:'test-b',activateHash:'a'.repeat(64)}])assert.throws(()=>policy(catalog,control,2));
 assert.deepEqual(policy(catalog,{download:'test-b',activate:'test-b',activateHash:target.sha256},2).activate,target);
});
test('different scope and invalid revisions cannot sign a policy',()=>{
 assert.throws(()=>policy({...catalog,scope:'production'},{download:'test-b',activate:null},1));
 for(const revision of [0,-1,1.5,NaN])assert.throws(()=>policy(catalog,{download:'test-b',activate:null},revision));
});
test('signed bytes reject tampering and another policy key',()=>{
 const a=crypto.generateKeyPairSync('ed25519'),b=crypto.generateKeyPairSync('ed25519');
 const e=envelope(policy(catalog,{download:'test-b',activate:null},1),a.privateKey);
 const payload=Buffer.from(e.payload,'base64'),sig=Buffer.from(e.signature,'base64');
 assert.equal(crypto.verify(null,payload,a.publicKey,sig),true);
 assert.equal(crypto.verify(null,payload,b.publicKey,sig),false);
 payload[0]^=1;assert.equal(crypto.verify(null,payload,a.publicKey,sig),false);
});

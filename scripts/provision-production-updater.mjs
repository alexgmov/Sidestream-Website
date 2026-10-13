#!/usr/bin/env node
// Explicit one-time provisioning only. The service never generates or replaces trust.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {scope} from './production-update-protocol.mjs';
import {keyId} from './user-update-test-operator.mjs';

const args=process.argv.slice(2),index=args.indexOf('--out');
if (index<0 || !args[index+1]) throw Error('Usage: provision-production-updater.mjs --out NEW_PRIVATE_DIRECTORY');
const directory=path.resolve(args[index+1]),repo=path.resolve(import.meta.dirname,'..');
if (directory === repo || directory.startsWith(repo+path.sep) || fs.existsSync(directory) ||
    fs.realpathSync(path.dirname(directory)) !== path.dirname(directory)) throw Error('New real directory outside repository required');
fs.mkdirSync(directory,{mode:0o700});
const write=(name,value)=>fs.writeFileSync(path.join(directory,name),value,{mode:0o600,flag:'wx'});
const trust={scope},ids={},keys={};
for (const name of ['release','policy','continuation','operator']) {
  const pair=crypto.generateKeyPairSync('ed25519');keys[name]=pair;
  write(name+'.pem',pair.privateKey.export({type:'pkcs8',format:'pem'}));
  write(name+'-public.pem',pair.publicKey.export({type:'spki',format:'pem'}));
  ids[name]=keyId(pair.privateKey);
  if(name!=='operator')trust[name+'Key']=pair.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64');
}
write('ticket.key',crypto.randomBytes(32));
write('trust.json',JSON.stringify(trust,null,2));
write('operators.json',JSON.stringify({schema:'sidestream.user-operators.v1',keys:[{id:ids.operator,publicKey:keys.operator.publicKey.export({type:'spki',format:'pem'})}]},null,2));
write('catalog.json',JSON.stringify({scope,releases:{}},null,2));
console.log(JSON.stringify({created:directory,fingerprints:ids,reminder:'Only policy.pem, continuation.pem and ticket.key go to the host. Keep release.pem and operator.pem offline.'},null,2));

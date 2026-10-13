#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {signRequest} from './user-update-test-operator.mjs';
import {read,json} from './production-update-service.mjs';
import {scope} from './production-update-protocol.mjs';

export function main(args) {
  const get=flag=>{const i=args.indexOf(flag);if(i<0 || !args[i+1])throw Error('Missing '+flag);return path.resolve(args[i+1]);};
  const request=signRequest({scope, control:json(get('--control'),{privateFile:true,max:32768}),
    snapshot:json(get('--snapshot'),{privateFile:true,max:4096}),
    privateKey:crypto.createPrivateKey(read(get('--key'),{privateFile:true,max:8192}))});
  fs.writeFileSync(get('--out'),JSON.stringify(request),{flag:'wx',mode:0o600});
  console.log('Signed production control request, valid for five minutes. Apply through authenticated SSH.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));

#!/usr/bin/env node
// Local Test mechanism authority. No deployed route, provider or customer state.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
export const scope='sidestream-user-release-proof-1';
export function envelope(value,key) {
 const bytes=Buffer.from(JSON.stringify(value));
 return {payload:bytes.toString('base64'),signature:crypto.sign(null,bytes,key).toString('base64')};
}
export function policy(catalog,control,revision,now=Date.now()/1000) {
 if(catalog.scope!==scope || !Number.isSafeInteger(revision) || revision<1) throw Error('Invalid proof scope/revision');
 const item=catalog.releases[control.download];
 if(!item || !/^[a-z0-9-]{1,64}$/.test(item.target.id) || !/^[a-f0-9]{64}$/.test(item.target.sha256)) throw Error('Unknown immutable release');
 let activate=null;
 if(control.activate!==null) {
  if(control.activate!==item.target.id || control.activateHash!==item.target.sha256) throw Error('Approval must name the exact download ID and hash');
  activate=item.target;
 }
 return {schema:'sidestream.user-policy.v1',scope,revision,issuedAt:now,expiresAt:now+60,download:item.target,activate};
}
function atomic(file,value) {
 const temp=file+'.'+crypto.randomUUID(); const fd=fs.openSync(temp,'wx',0o600);
 try {fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
 fs.renameSync(temp,file);
}
export function main(args) {
 const get=name=>{const i=args.indexOf(name);if(i<0||!args[i+1])throw Error('Missing '+name);return args[i+1];};
 const dir=path.resolve(get('--state'));
 const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 if(dir.startsWith(repo+path.sep))throw Error('Private proof state must be outside Website');
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 if(args.includes('--keygen')) {
  for(const role of ['release','policy']) {
   const {privateKey}=crypto.generateKeyPairSync('ed25519');
   fs.writeFileSync(path.join(dir,role+'.pem'),privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});
  }
  console.log('Created separate private Test release/policy keys.');return;
 }
 const catalog=JSON.parse(fs.readFileSync(get('--catalog'),'utf8'));
 const controlFile=path.join(dir,'control.json');
 if(args.includes('--set')) {
  const download=get('--download'),activate=get('--activate');
  const control={download,activate:activate==='hold'?null:activate,activateHash:activate==='hold'?null:get('--activate-hash')};
  policy(catalog,control,1);atomic(controlFile,control);console.log('Saved exact local Test control.');return;
 }
 if(!args.includes('--serve')) throw Error('Choose --keygen, --set or --serve');
 const key=crypto.createPrivateKey(fs.readFileSync(path.join(dir,'policy.pem')));
 const counterFile=path.join(dir,'counter.json');
 let revision=fs.existsSync(counterFile)?JSON.parse(fs.readFileSync(counterFile)).revision:0;
 for(const [id,item]of Object.entries(catalog.releases)) {
  if(id!==item.target.id)throw Error('Catalog identity mismatch');
  for(const field of ['manifest','payload'])if(!path.isAbsolute(item[field]))throw Error('Absolute local artifact path required');
  const stat=fs.statSync(item.payload);if(stat.size!==item.target.bytes)throw Error('Catalog byte mismatch');
 }
 http.createServer((req,res)=>{
  try {
   if(req.method!=='GET'){res.writeHead(405).end();return;}
   if(req.url==='/policy') {
    const control=JSON.parse(fs.readFileSync(controlFile,'utf8'));
    const value=policy(catalog,control,++revision);atomic(counterFile,{revision});
    const bytes=Buffer.from(JSON.stringify(envelope(value,key)));
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','Content-Length':bytes.length}).end(bytes);return;
   }
   const match=/^\/releases\/([a-z0-9-]{1,64})\/(manifest\.json|payload\.bin)$/.exec(req.url||'');
   const item=match&&catalog.releases[match[1]];if(!item){res.writeHead(404).end();return;}
   const file=item[match[2]==='manifest.json'?'manifest':'payload'];const bytes=fs.statSync(file).size;
   res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes,'Cache-Control':'no-store'});
   const stream=fs.createReadStream(file);res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);
  }catch{if(!res.headersSent)res.writeHead(503);res.end();}
 }).listen(8895,'127.0.0.1',()=>console.log('Local Test proof authority: http://127.0.0.1:8895'));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2));

#!/usr/bin/env node
// Local Test operator/delivery service. Deliberately has no deploy integration.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {envelope} from './user-update-proof-authority.mjs';
import {testScope,validateControl,makePolicy,rangeFor,target} from './user-update-test-control.mjs';
import {authorizeRequest,controlSnapshot,keyId} from './user-update-test-operator.mjs';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function atomic(file,value) {
 const temp=file+'.'+crypto.randomUUID(),fd=fs.openSync(temp,'wx',0o600);
 try{fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.renameSync(temp,file);
 const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
function regular(file) {
 const s=fs.lstatSync(file);
 if(!s.isFile()||s.uid!==process.getuid()||s.nlink!==1||(s.mode&0o022))throw Error('Unsafe Test state/artifact');
}
function read(file){regular(file);return JSON.parse(fs.readFileSync(file,'utf8'));}
function digestFile(file) {
 regular(file);const fd=fs.openSync(file,'r'),hash=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024);
 try{for(let n;(n=fs.readSync(fd,buffer))>0;)hash.update(buffer.subarray(0,n));}finally{fs.closeSync(fd);}
 return hash.digest('hex');
}
export function verifyCatalog(catalog) {
 if(catalog.scope!==testScope||!catalog.releases||Object.keys(catalog.releases).length>100)throw Error('Invalid Test catalog');
 for(const [id,item]of Object.entries(catalog.releases)) {
  const t=target(item.target);if(id!==t.id||!path.isAbsolute(item.manifest)||!path.isAbsolute(item.payload))throw Error('Invalid local artifact');
  if(fs.statSync(item.payload).size!==t.bytes||digestFile(item.payload)!==t.sha256||digestFile(item.manifest)!==t.manifestSha256)throw Error('Artifact differs from immutable catalog');
 }
}
export function applyControl({catalog,state,control,request,operators,now=Date.now()/1000}) {
 const lock=path.join(state,'operator-v2.lock'),fd=fs.openSync(lock,'wx',0o600);
 try {
  const file=path.join(state,'control-v2.json'),previous=fs.existsSync(file)?read(file):null;
  const snapshot=controlSnapshot(previous);
  if((previous?.history.length||0)>=1024)throw Error('Archive Test control history before further changes');
  let authorization=null;
  if(request)({control,authorization}=authorizeRequest({envelope:request,operators,previous,catalog,now}));
  validateControl(catalog,control);
  const revision=snapshot.revision+1;
  const history=[...(previous?.history||[]),{at:new Date(now*1000).toISOString(),revision,control,
   digest:sha(Buffer.from(JSON.stringify(control))),...(authorization?{authorization}:{})}];
  atomic(file,{revision,control,history});
  return controlSnapshot({revision,control,history});
 }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
export function createServer({catalog,state,key,ticketKey,clock=()=>Date.now()/1000}) {
 let revision=fs.existsSync(path.join(state,'counter-v2.json'))?read(path.join(state,'counter-v2.json')).revision:0;
 const control=()=>read(path.join(state,'control-v2.json')).control;
 const signature=(id,hash,expires)=>crypto.createHmac('sha256',ticketKey).update(`${testScope}:${id}:${hash}:${expires}`).digest('hex');
 const signedReply=(res,value)=>{
  const bytes=Buffer.from(JSON.stringify(envelope(value,key)));
  res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','Content-Length':bytes.length}).end(bytes);
 };
 return http.createServer((req,res)=>{
  try{
   if(req.method!=='GET'){res.writeHead(405).end();return;}
   const url=new URL(req.url,'http://127.0.0.1:8896');
   if(url.pathname==='/policy'||url.pathname==='/delivery') {
    const client=url.searchParams.get('client'),next=revision+1;
    const policy=makePolicy(catalog,control(),client,next,clock());
    atomic(path.join(state,'counter-v2.json'),{revision:next});revision=next;
    if(url.pathname==='/policy'){signedReply(res,policy);return;}
    const t=[policy.download,policy.companion?.download].find(t=>t?.id===url.searchParams.get('id'));
    if(!t||url.searchParams.get('id')!==t.id||url.searchParams.get('sha256')!==t.sha256){res.writeHead(403).end();return;}
    const expires=Math.floor(clock()+60);
    signedReply(res,{schema:'sidestream.user-delivery.v2',scope:testScope,client,target:t,expiresAt:expires,
     route:`/releases/${t.id}/payload.bin?expires=${expires}&mac=${signature(t.id,t.sha256,expires)}`});return;
   }
   const match=/^\/releases\/([a-z0-9-]{1,64})\/(manifest\.json|payload\.bin)$/.exec(url.pathname);
   const item=match&&catalog.releases[match[1]];
   if(!item){res.writeHead(404).end();return;}
   const checked=validateControl(catalog,control());
   if(checked.revoked.includes(item.target.sha256)){res.writeHead(403).end();return;}
   if(match[2]==='payload.bin') {
    const expires=Number(url.searchParams.get('expires')),mac=url.searchParams.get('mac')||'';
    if(!Number.isInteger(expires)||expires<=clock()||expires>clock()+65||!/^[a-f0-9]{64}$/.test(mac)||
       !crypto.timingSafeEqual(Buffer.from(mac),Buffer.from(signature(item.target.id,item.target.sha256,expires)))){res.writeHead(401).end();return;}
   }
   const file=item[match[2]==='manifest.json'?'manifest':'payload'];regular(file);
   const size=fs.statSync(file).size,etag='"'+(match[2]==='manifest.json'?item.target.manifestSha256:item.target.sha256)+'"';
   const range=rangeFor(req.headers.range,req.headers['if-range'],etag,size);
   if(range.status>=400){res.writeHead(range.status,{'Content-Range':`bytes */${size}`}).end();return;}
   const headers={'Content-Type':'application/octet-stream','Content-Length':range.end-range.start+1,'ETag':etag,'Accept-Ranges':'bytes','Cache-Control':'no-store'};
   if(range.status===206)headers['Content-Range']=`bytes ${range.start}-${range.end}/${size}`;
   res.writeHead(range.status,headers);
   const stream=fs.createReadStream(file,{start:range.start,end:range.end});res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);
  }catch{if(!res.headersSent)res.writeHead(503);res.end();}
 });
}
export function main(args) {
 const get=name=>{const i=args.indexOf(name);if(i<0||!args[i+1])throw Error('Missing '+name);return args[i+1];};
 if(!process.getuid()||process.getuid()!==process.geteuid())throw Error('Run as the ordinary Test user');
 const state=path.resolve(get('--state')),repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 if(state===repo||state.startsWith(repo+path.sep))throw Error('Private state must be outside the repository');
 fs.mkdirSync(state,{recursive:true,mode:0o700});
 const stat=fs.lstatSync(state);if(!stat.isDirectory()||stat.uid!==process.getuid()||(stat.mode&0o077)||fs.realpathSync(state)!==state)throw Error('Private mode-0700 state required');
 const catalog=read(get('--catalog'));verifyCatalog(catalog);
 const modes=['--set','--set-request','--snapshot','--serve'].filter(mode=>args.includes(mode));
 if(modes.length!==1)throw Error('Choose exactly one control mode');
 if(args.includes('--snapshot')) {
  const file=path.join(state,'control-v2.json');
  console.log(JSON.stringify(controlSnapshot(fs.existsSync(file)?read(file):null)));return;
 }
 if(args.includes('--set-request')) {
  // Only locally provisioned public keys authorize remote requests. Requests cannot
  // provide their own allowlist, trust keys or Production identity.
  const allowlist=path.join(state,'operators-v2.json');regular(allowlist);
  if(fs.statSync(allowlist).mode&0o077)throw Error('Private operator allowlist required');
  const operators=read(allowlist);
  const signingIds=['policy.pem','release.pem'].filter(name=>fs.existsSync(path.join(state,name))).map(name=>{
   regular(path.join(state,name));return keyId(crypto.createPrivateKey(fs.readFileSync(path.join(state,name))));
  });
  if(!Array.isArray(operators.keys)||operators.keys.some(entry=>signingIds.includes(entry.id)))throw Error('Separate operator and service signing keys required');
  applyControl({catalog,state,request:read(get('--request')),operators});
  console.log('Applied authenticated Test control with durable audit.');return;
 }
 if(args.includes('--set')) {
  applyControl({catalog,state,control:read(get('--control'))});
  console.log('Saved reviewed Test control with durable audit.');return;
 }
 if(!args.includes('--serve'))throw Error('Choose --set or --serve');
 const serverLock=path.join(state,'server-v2.lock'),fd=fs.openSync(serverLock,'wx',0o600);
 fs.writeFileSync(fd,String(process.pid));fs.fsyncSync(fd);
 const cleanup=()=>{try{fs.closeSync(fd);fs.unlinkSync(serverLock);}catch{}};
 process.once('exit',cleanup);
 const ticketFile=path.join(state,'ticket-v2.key');
 if(!fs.existsSync(ticketFile))fs.writeFileSync(ticketFile,crypto.randomBytes(32),{flag:'wx',mode:0o600});
 regular(ticketFile);regular(path.join(state,'policy.pem'));
 const server=createServer({catalog,state,key:crypto.createPrivateKey(fs.readFileSync(path.join(state,'policy.pem'))),ticketKey:fs.readFileSync(ticketFile)});
 server.listen(8896,'127.0.0.1',()=>console.log('Isolated Test service: http://127.0.0.1:8896'));
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2));

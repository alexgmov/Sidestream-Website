#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {target, validateControl, makePolicy, rangeFor} from './user-update-test-control.mjs';
import {authorizeRequest, controlSnapshot, keyId} from './user-update-test-operator.mjs';
import {scope, hash, sha, exact, signed, publicKey, releaseMetadata, continuePaid} from './production-update-protocol.mjs';

const MAX_BODY = 65536;
export const hold = {schema:'sidestream.user-control.v2', download:null, activate:null, rollback:null, revoked:[], companion:null};
const fault = status => Object.assign(Error('Request rejected'), {status});
export function regular(file, {privateFile=false, rootOwned=false, max=2_000_000_000} = {}) {
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file) throw Error('Unsafe path');
  if (rootOwned) {
    for (let parent=path.dirname(file);;parent=path.dirname(parent)) {
      const stat=fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) throw Error('Unsafe immutable parent');
      if (parent === path.dirname(parent)) break;
    }
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > max ||
        (rootOwned ? stat.uid !== 0 : ![0,process.getuid()].includes(stat.uid)) ||
        (stat.mode & (privateFile ? 0o077 : 0o022))) throw Error('Unsafe file');
    return {fd, stat};
  } catch (error) { fs.closeSync(fd); throw error; }
}
export function read(file, options={}) {
  const {fd} = regular(file, {max:16*1024*1024, ...options});
  try { return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}
export const json = (file, options) => JSON.parse(read(file, options));
export function atomic(file, value) {
  const temp = file + '.' + crypto.randomUUID(), fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const parent = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
function digest(file, options) {
  const {fd, stat} = regular(file, options), hasher = crypto.createHash('sha256'), buffer = Buffer.alloc(1024*1024);
  try { for (let n; (n=fs.readSync(fd, buffer)) > 0;) hasher.update(buffer.subarray(0,n)); }
  finally { fs.closeSync(fd); }
  return {sha256:hasher.digest('hex'), stat};
}
export function verifyCatalog(catalog, releaseKey, artifactRoot, rootOwned=false) {
  exact(catalog, ['scope','releases']);
  if (catalog.scope !== scope || !catalog.releases || Array.isArray(catalog.releases) ||
      typeof catalog.releases !== 'object' || Object.keys(catalog.releases).length > 100 ||
      !path.isAbsolute(artifactRoot) || fs.realpathSync(artifactRoot) !== artifactRoot) throw Error('Invalid catalog');
  const releases = Object.create(null);
  for (const [id,item] of Object.entries(catalog.releases)) {
    const t = target(item.target);
    if (id !== t.id || [item.payload,item.manifest].some(file => typeof file !== 'string' || !file.startsWith(artifactRoot+path.sep)))
      throw Error('Artifact outside immutable store');
    const payload = digest(item.payload, {rootOwned}), manifestBytes = read(item.manifest, {rootOwned});
    if (payload.stat.size !== t.bytes || payload.sha256 !== t.sha256 || sha(manifestBytes) !== t.manifestSha256)
      throw Error('Artifact hash mismatch');
    const metadata = releaseMetadata(JSON.parse(manifestBytes), releaseKey, t);
    const {fd,stat:manifestStat} = regular(item.manifest, {rootOwned}); fs.closeSync(fd);
    releases[id] = {...item, target:t, ...metadata, payloadStat:payload.stat, manifestStat};
  }
  return {scope, releases};
}
export function loadTrust(value) {
  exact(value, ['scope','releaseKey','policyKey','continuationKey']);
  if (value.scope !== scope) throw Error('Wrong trust scope');
  const decode = text => {
    if (typeof text !== 'string') throw Error('Invalid public key');
    const raw=Buffer.from(text,'base64');
    if (raw.length !== 32 || raw.toString('base64') !== text) throw Error('Invalid public key');
    return publicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),raw]),type:'spki',format:'der'});
  };
  const keys={release:decode(value.releaseKey),policy:decode(value.policyKey),continuation:decode(value.continuationKey)};
  const ids=Object.values(keys).map(key=>sha(key.export({type:'spki',format:'der'})));
  if (new Set(ids).size !== 3) throw Error('Separate signing roles required');
  return {...keys,ids};
}
export function loadKeys(directory, trust) {
  if (fs.existsSync(path.join(directory,'release.pem'))) throw Error('Offline release private key must not be on the service');
  const secret = name => read(path.join(directory,name), {privateFile:true,max:8192});
  const policy = crypto.createPrivateKey(secret('policy.pem'));
  const continuation = crypto.createPrivateKey(secret('continuation.pem'));
  const release = trust.release;
  const ticket = secret('ticket.key');
  if (ticket.length !== 32 || [policy,continuation].some(k => k.asymmetricKeyType !== 'ed25519')) throw Error('Invalid production keys');
  const ids = [policy,continuation].map(keyId).concat(sha(release.export({type:'spki',format:'der'})));
  if (new Set(ids).size !== ids.length) throw Error('Separate signing roles required');
  if (ids.some(id=>!trust.ids.includes(id)) || keyId(policy) !== sha(trust.policy.export({type:'spki',format:'der'})) ||
      keyId(continuation) !== sha(trust.continuation.export({type:'spki',format:'der'}))) throw Error('Secret does not match pinned trust');
  return {policy,continuation,release,ticket,ids};
}
export function checkState(state) {
  const stat = fs.lstatSync(state);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) || fs.realpathSync(state) !== state)
    throw Error('Same-user private state directory required');
}
// Called only inside the administrative CLI's kernel-held flock. Exported for
// deterministic single-process protocol tests, never exposed as an HTTP route.
export function applyControl({state,catalog,request,operators,keys,now=Date.now()/1000}) {
  checkState(state);
  if (operators.keys?.some(entry => keys.ids.includes(entry.id))) throw Error('Operator key must be separate');
  const previous = json(path.join(state,'control.json'), {privateFile:true});
  if (previous.history.length >= 1024) throw Error('Archive operator history before further changes');
  const {control, authorization} = authorizeRequest({envelope:request, operators, previous, catalog, now, scope});
  const revision = controlSnapshot(previous).revision+1;
  const history = [...previous.history,{at:new Date(now*1000).toISOString(),revision,control,authorization}];
  atomic(path.join(state,'control.json'),{revision,control,history});
  return controlSnapshot({revision,control,history});
}
function body(req) {
  return new Promise((resolve,reject) => {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json' || req.headers['content-encoding']) { reject(fault(400)); return; }
    const chunks=[]; let length=0;
    req.on('data',chunk => {
      length += chunk.length;
      if (length > MAX_BODY) { reject(fault(413)); req.pause(); return; }
      chunks.push(chunk);
    });
    req.once('error', () => reject(fault(400)));
    req.once('aborted', () => reject(fault(400)));
    req.once('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks))); } catch { reject(fault(400)); } });
  });
}
export function createServer({catalog,state,keys,sourceSha,clock=()=>Date.now()/1000,rootOwned=false}) {
  checkState(state);
  let revision = json(path.join(state,'counter.json'), {privateFile:true}).revision;
  if (!Number.isSafeInteger(revision) || revision < 0) throw Error('Invalid persisted policy revision');
  const control = () => json(path.join(state,'control.json'), {privateFile:true});
  validateControl(catalog, control().control, scope);
  const policy = client => {
    if (revision >= Number.MAX_SAFE_INTEGER-1) throw Error('Policy revision exhausted');
    const result = makePolicy(catalog,control().control,client,revision+1,clock(),scope);
    atomic(path.join(state,'counter.json'),{revision:result.revision}); revision=result.revision;
    return result;
  };
  const signature = (id,digest,expires) => crypto.createHmac('sha256',keys.ticket).update(`${scope}:${id}:${digest}:${expires}`).digest('hex');
  const reply = (res,value,status=200) => {
    const bytes=Buffer.from(JSON.stringify(value));
    res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store','Content-Length':bytes.length,'X-Content-Type-Options':'nosniff'}).end(bytes);
  };
  const server = http.createServer({maxHeaderSize:8192}, async (req,res) => {
    try {
      if (!req.url || req.url.length > 2048) throw fault(400);
      const url = new URL(req.url,'http://127.0.0.1:3103');
      if (url.pathname === '/continuation') {
        if (req.method !== 'POST') throw fault(405);
        const request = await body(req);
        if (!hash.test(request?.client)) throw fault(400);
        const lease = policy(request.client);
        let certificate;
        try { certificate=continuePaid({request,catalog,policy:lease,releaseKey:keys.release,continuationKey:keys.continuation}); }
        catch { throw fault(403); }
        reply(res,certificate); return;
      }
      if (req.method !== 'GET') throw fault(405);
      if (url.pathname === '/health') {
        const current=control(), checked=validateControl(catalog,current.control,scope);
        reply(res,{ok:true,scope,sourceSha,releases:Object.keys(catalog.releases).length,controlRevision:current.revision,
          held:!checked.download&&!checked.activate&&!checked.companion?.download&&!checked.companion?.activate}); return;
      }
      if (url.pathname === '/policy' || url.pathname === '/delivery') {
        const client=url.searchParams.get('client');
        if (!hash.test(client)) throw fault(400);
        const lease=policy(client);
        if (url.pathname === '/policy') { reply(res,signed(lease,keys.policy)); return; }
        const t=[lease.download,lease.companion?.download].find(t => t?.id === url.searchParams.get('id'));
        if (!t || t.sha256 !== url.searchParams.get('sha256')) throw fault(403);
        const expires=Math.floor(clock()+60);
        reply(res,signed({schema:'sidestream.user-delivery.v2',scope,client,target:t,expiresAt:expires,
          route:`/releases/${t.id}/payload.bin?expires=${expires}&mac=${signature(t.id,t.sha256,expires)}`},keys.policy)); return;
      }
      const match=/^\/releases\/([a-z0-9-]{1,64})\/(manifest\.json|payload\.bin)$/.exec(url.pathname);
      const item=match && Object.hasOwn(catalog.releases,match[1]) && catalog.releases[match[1]];
      if (!item) throw fault(404);
      if (validateControl(catalog,control().control,scope).revoked.includes(item.target.sha256)) throw fault(403);
      const isPayload=match[2] === 'payload.bin';
      if (isPayload) {
        const expires=Number(url.searchParams.get('expires')),mac=url.searchParams.get('mac') || '';
        if (!Number.isSafeInteger(expires) || expires <= clock() || expires > clock()+65 || !hash.test(mac) ||
            !crypto.timingSafeEqual(Buffer.from(mac),Buffer.from(signature(item.target.id,item.target.sha256,expires)))) throw fault(401);
        if (!req.headers.range) throw fault(416); // Production payloads always use bounded chunks.
      }
      const {fd,stat}=regular(item[isPayload?'payload':'manifest'], {rootOwned});
      const expected=item[isPayload?'payloadStat':'manifestStat'];
      if (['dev','ino','size','mtimeMs','ctimeMs'].some(field => stat[field] !== expected[field])) { fs.closeSync(fd); throw Error('Immutable artifact changed'); }
      const etag='"'+item.target[isPayload?'sha256':'manifestSha256']+'"';
      const range=rangeFor(req.headers.range,req.headers['if-range'],etag,stat.size);
      if (range.status >= 400) { fs.closeSync(fd); res.writeHead(range.status,{'Content-Range':`bytes */${stat.size}`}).end(); return; }
      const headers={'Content-Type':'application/octet-stream','Content-Length':range.end-range.start+1,'ETag':etag,'Accept-Ranges':'bytes','Cache-Control':'no-store'};
      if (range.status === 206) headers['Content-Range']=`bytes ${range.start}-${range.end}/${stat.size}`;
      res.writeHead(range.status,headers);
      const stream=fs.createReadStream(null,{fd,autoClose:true,start:range.start,end:range.end});
      res.on('close',()=>stream.destroy()); stream.on('error',()=>res.destroy()); stream.pipe(res);
    } catch (error) {
      if (!res.headersSent) { res.setHeader('Connection','close'); reply(res,{error:'request_rejected'},error.status || 503); }
      else res.destroy();
    }
  });
  server.requestTimeout=15000; server.headersTimeout=10000; server.keepAliveTimeout=5000; server.maxConnections=128;
  server.maxRequestsPerSocket=100;
  return server;
}
export function main(args) {
  const get=name=>{const i=args.indexOf(name);if(i<0 || !args[i+1])throw Error('Missing '+name);return args[i+1];};
  if (!process.getuid() || process.getuid() !== process.geteuid()) throw Error('Dedicated unprivileged service user required');
  const state=path.resolve(get('--state')), trust=loadTrust(json(path.resolve(get('--trust')),{rootOwned:true}));
  checkState(state);
  const catalog=verifyCatalog(json(path.resolve(get('--catalog')), {rootOwned:true}),trust.release,path.resolve(get('--artifacts')),true);
  const modes=['--initialize','--snapshot','--apply','--apply-locked','--serve','--verify'].filter(mode=>args.includes(mode));
  if (modes.length !== 1) throw Error('Choose one service mode');
  if (args.includes('--verify')) { console.log('Production catalog and distinct keys verified.'); return; }
  if (args.includes('--initialize')) {
    if (fs.readdirSync(state).length) throw Error('Initialize only an empty state directory');
    if (Object.keys(catalog.releases).length) throw Error('Initialize on hold with an empty catalog');
    atomic(path.join(state,'control.json'),{revision:1,control:hold,history:[{revision:1,control:hold,at:new Date().toISOString()}]});
    atomic(path.join(state,'counter.json'),{revision:0}); console.log('Production state initialized on hold.'); return;
  }
  if (args.includes('--snapshot')) { console.log(JSON.stringify(controlSnapshot(json(path.join(state,'control.json'),{privateFile:true})))); return; }
  if (args.includes('--apply')) {
    // flock releases on SIGKILL/power loss. Never delete/recreate its inode: two
    // processes must always contend for the same lock, even after a restart.
    const lock=path.join(state,'operator.lock');
    const fd=fs.openSync(lock,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW,0o600);fs.closeSync(fd);
    const checked=regular(lock,{privateFile:true});fs.closeSync(checked.fd);
    const command=[fileURLToPath(import.meta.url),...args.map(arg=>arg==='--apply'?'--apply-locked':arg)];
    const result=spawnSync('/usr/bin/flock',['--nonblock','--no-fork',lock,process.execPath,...command],{stdio:'inherit'});
    if (result.error || result.status !== 0) throw Error('Control application failed or another operator holds the lock');
    return;
  }
  if (args.includes('--apply-locked')) {
    const operators=json(path.resolve(get('--operators')),{rootOwned:true});
    console.log(JSON.stringify(applyControl({state,catalog,request:json(path.resolve(get('--request')),{privateFile:true,max:65536}),operators,keys:trust}))); return;
  }
  const sourceSha=get('--source-sha'); if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw Error('Canonical source SHA required');
  const keys=loadKeys(path.resolve(get('--keys')),trust);
  const server=createServer({catalog,state,keys,sourceSha,rootOwned:true});
  server.listen(3103,'127.0.0.1',()=>console.log('Production updater listening on loopback:3103'));
  server.on('error',()=>{console.error('Production updater could not start');process.exitCode=1;});
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));

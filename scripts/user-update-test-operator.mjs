#!/usr/bin/env node
// Signed Test control requests can travel over authenticated SSH or as private files.
// This module does not create an HTTP mutation endpoint or deploy a service.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {testScope, validateControl} from './user-update-test-control.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hash = /^[a-f0-9]{64}$/;
const fields = (value, allowed) => {
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).some(key => !allowed.includes(key))) throw Error('Unexpected Test request fields');
};
export const keyId = key => sha(crypto.createPublicKey(key).export({type:'spki', format:'der'}));
export function controlSnapshot(previous) {
  if (!previous) return {revision:0, sha256:sha('null')};
  if (!Array.isArray(previous.history) || previous.history.length < 1 || previous.history.length > 1024)
    throw Error('Invalid operator history');
  const revision = previous.revision ?? previous.history.length;
  if (!Number.isSafeInteger(revision) || revision < previous.history.length) throw Error('Invalid operator revision');
  return {revision, sha256:sha(JSON.stringify(previous.control))};
}
function exactControl(control) {
  fields(control, ['schema','download','activate','rollback','revoked','companion']);
  const choice = value => { if (value !== null) fields(value, ['id','sha256','salt','percent']); };
  choice(control.download); choice(control.activate);
  if (control.rollback !== null) fields(control.rollback, ['fromSha256','toSha256']);
  if (control.companion !== null && control.companion !== undefined) {
    fields(control.companion, ['download','activate']);
    choice(control.companion.download); choice(control.companion.activate);
  }
}
export function signRequest({control, snapshot, privateKey, now = Math.floor(Date.now()/1000)}) {
  if (privateKey.asymmetricKeyType !== 'ed25519') throw Error('Ed25519 operator key required');
  exactControl(control);
  const request = {schema:'sidestream.user-operator-request.v1', scope:testScope,
    operator:keyId(privateKey), issuedAt:now, expiresAt:now+300,
    nonce:crypto.randomBytes(16).toString('hex'), expected:snapshot, control};
  const bytes = Buffer.from(JSON.stringify(request));
  if (bytes.length > 32768) throw Error('Oversized operator request');
  return {payload:bytes.toString('base64'), signature:crypto.sign(null, bytes, privateKey).toString('base64')};
}
export function authorizeRequest({envelope, operators, previous, catalog, now = Date.now()/1000}) {
  fields(envelope, ['payload','signature']);
  const decode = (text, max) => {
    if (typeof text !== 'string' || text.length > max || !/^[A-Za-z0-9+/]+={0,2}$/.test(text))
      throw Error('Invalid signed request');
    const bytes = Buffer.from(text, 'base64');
    if (bytes.toString('base64') !== text) throw Error('Noncanonical signed request');
    return bytes;
  };
  const bytes = decode(envelope.payload, 44000), signature = decode(envelope.signature, 88);
  if (signature.length !== 64) throw Error('Invalid operator signature');
  const request = JSON.parse(bytes);
  fields(request, ['schema','scope','operator','issuedAt','expiresAt','nonce','expected','control']);
  fields(operators, ['schema','keys']);
  if (operators.schema !== 'sidestream.user-operators.v1' || !Array.isArray(operators.keys) ||
      operators.keys.length < 1 || operators.keys.length > 16) throw Error('Invalid operator allowlist');
  const keys = new Map();
  for (const entry of operators.keys) {
    fields(entry, ['id','publicKey']);
    if (!hash.test(entry.id) || typeof entry.publicKey !== 'string' ||
        !entry.publicKey.startsWith('-----BEGIN PUBLIC KEY-----') || keys.has(entry.id)) throw Error('Invalid operator key');
    const key = crypto.createPublicKey(entry.publicKey);
    if (key.asymmetricKeyType !== 'ed25519' || sha(key.export({type:'spki',format:'der'})) !== entry.id)
      throw Error('Operator fingerprint mismatch');
    keys.set(entry.id, key);
  }
  const key = keys.get(request.operator);
  if (!key || !crypto.verify(null, bytes, key, signature)) throw Error('Unauthorized Test operator');
  if (request.schema !== 'sidestream.user-operator-request.v1' || request.scope !== testScope ||
      !Number.isFinite(now) || !Number.isSafeInteger(request.issuedAt) || !Number.isSafeInteger(request.expiresAt) ||
      request.issuedAt > now+5 || request.expiresAt <= now || request.expiresAt <= request.issuedAt ||
      request.expiresAt-request.issuedAt > 300 || !/^[a-f0-9]{32}$/.test(request.nonce)) throw Error('Invalid or expired Test authorization');
  fields(request.expected, ['revision','sha256']);
  const snapshot = controlSnapshot(previous);
  if (!Number.isSafeInteger(request.expected.revision) || !hash.test(request.expected.sha256) ||
      request.expected.revision !== snapshot.revision || request.expected.sha256 !== snapshot.sha256 ||
      previous?.history.some(entry => entry.authorization?.nonce === request.nonce)) throw Error('Stale or replayed Test authorization');
  exactControl(request.control);
  validateControl(catalog, request.control);
  return {control:request.control, authorization:{operator:request.operator, nonce:request.nonce,
    requestSha256:sha(bytes), issuedAt:request.issuedAt, expiresAt:request.expiresAt}};
}

function privateFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077))
    throw Error('Same-user private regular file required');
  return fs.readFileSync(file);
}
export function main(args) {
  const get = flag => { const i=args.indexOf(flag); if(i<0 || !args[i+1]) throw Error('Missing '+flag); return args[i+1]; };
  const envelope = signRequest({control:JSON.parse(privateFile(get('--control'))),
    snapshot:JSON.parse(privateFile(get('--snapshot'))), privateKey:crypto.createPrivateKey(privateFile(get('--key')))});
  const output=path.resolve(get('--out'));
  const fd=fs.openSync(output, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(envelope)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  console.log('Signed private Test control request; expires in five minutes. No control was applied.');
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main(process.argv.slice(2));

import crypto from 'node:crypto';
import {target} from './user-update-test-control.mjs';

export const scope = 'sidestream-user-release-production-1';
export const paidScope = 'sidestream-paid-update-production-1';
export const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const hash = /^[a-f0-9]{64}$/;
const version = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
export function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field)))
    throw Error('Invalid fields');
}
export function publicKey(value) {
  const key = crypto.createPublicKey(value);
  if (key.asymmetricKeyType !== 'ed25519') throw Error('Ed25519 key required');
  return key;
}
export function signed(value, key) {
  const bytes = Buffer.from(JSON.stringify(value));
  return {payload:bytes.toString('base64'), signature:crypto.sign(null, bytes, key).toString('base64')};
}
export function verified(envelope, keys, max = 65536) {
  exact(envelope, ['payload','signature']);
  const decode = (text, limit) => {
    if (typeof text !== 'string' || text.length > limit) throw Error('Invalid encoding');
    const bytes = Buffer.from(text, 'base64');
    if (!bytes.length || bytes.toString('base64') !== text) throw Error('Invalid encoding');
    return bytes;
  };
  const bytes = decode(envelope.payload, max * 2), signature = decode(envelope.signature, 88);
  if (bytes.length > max || signature.length !== 64 || !keys.some(key => crypto.verify(null, bytes, key, signature)))
    throw Error('Invalid signature');
  return JSON.parse(bytes);
}
export function paidTarget(value) {
  exact(value, ['id','sha256','manifestSha256','version']);
  target({...value, bytes:1});
  if (typeof value.version !== 'string' || !version.test(value.version)) throw Error('Invalid version');
  return value;
}
export function sameTarget(a, b) {
  return ['id','sha256','manifestSha256','version'].every(field => a[field] === b[field]);
}
export function paidProof(envelope, keys) {
  if (Buffer.byteLength(JSON.stringify(envelope)) > 65536) throw Error('Oversized certificate');
  const proof = verified(envelope, keys);
  exact(proof, ['schema','scope','acquisition','links']);
  if (proof.schema !== 'sidestream.paid-continuation.v1' || proof.scope !== paidScope) throw Error('Wrong paid scope');
  const a = proof.acquisition;
  exact(a, ['receiptSha256','installIdHash','version','platform','buildChannel','onboardingChannel',
    'bundleId','extensionId','packageIdentifier','receiptIssuer','installMethod','receiptSource']);
  const expected = {platform:'darwin', buildChannel:'production', onboardingChannel:'paid-onboarding',
    bundleId:'com.sidestream.downloader', extensionId:'com.sidestream.downloader.panel',
    packageIdentifier:'com.sidestream.downloader.pkg', receiptIssuer:'macos_installer_package',
    installMethod:'mac_native_pkg', receiptSource:'mac_system_application_support'};
  if (!hash.test(a.receiptSha256) || !hash.test(a.installIdHash) || !version.test(a.version) ||
      Object.entries(expected).some(([field,value]) => a[field] !== value)) throw Error('Invalid acquisition');
  if (!Array.isArray(proof.links) || proof.links.length < 1 || proof.links.length > 32) throw Error('Invalid chain');
  let previous;
  const ids = new Set(), archives = new Set(), manifests = new Set();
  for (const [index, link] of proof.links.entries()) {
    exact(link, ['from','to']); paidTarget(link.to);
    if (index === 0) {
      exact(link.from, ['receiptSha256','version']);
      if (link.from.receiptSha256 !== a.receiptSha256 || link.from.version !== a.version) throw Error('Invalid anchor');
    } else if (!sameTarget(paidTarget(link.from), previous)) throw Error('Broken chain');
    if (ids.has(link.to.id) || archives.has(link.to.sha256) || manifests.has(link.to.manifestSha256)) throw Error('Cyclic chain');
    ids.add(link.to.id); archives.add(link.to.sha256); manifests.add(link.to.manifestSha256); previous = link.to;
  }
  return proof;
}

// Only a previously authorized acquisition can obtain continuity. No supplied
// receipt, account token or self-asserted identity is accepted as a signing root.
export function continuePaid({request, catalog, policy, releaseKey, continuationKey}) {
  exact(request, ['client','prior','target']);
  if (!hash.test(request.client) || request.client !== policy.client) throw Error('Invalid client');
  const requested = paidTarget(request.target);
  const item = Object.hasOwn(catalog.releases, requested.id) && catalog.releases[requested.id];
  if (!item || item.kind !== 'cep' || item.customerOnboarding !== 'paid-onboarding' ||
      !sameTarget(requested, {...item.target, version:item.version}) || policy.revoked.includes(requested.sha256) ||
      ![policy.download, policy.activate].some(t => t && t.id === requested.id && t.sha256 === requested.sha256 && t.manifestSha256 === requested.manifestSha256))
    throw Error('Target not authorized');
  const proof = paidProof(request.prior, [releaseKey, publicKey(continuationKey)]);
  // Re-anchor the signed acquisition, instead of exhausting a finite chain or
  // duplicating a previous target during a separately authorized rollback.
  const response = signed({schema:proof.schema, scope:paidScope, acquisition:proof.acquisition,
    links:[{from:{receiptSha256:proof.acquisition.receiptSha256, version:proof.acquisition.version}, to:requested}]}, continuationKey);
  paidProof(response, [publicKey(continuationKey)]);
  return response;
}

export function releaseMetadata(envelope, releaseKey, expected) {
  const release = verified(envelope, [releaseKey], 16 * 1024 * 1024);
  if (release.schema !== 'sidestream.user-release.v2' || release.scope !== scope || release.id !== expected.id ||
      typeof release.version !== 'string' || !version.test(release.version) ||
      !Number.isSafeInteger(release.sequence) || release.sequence < 1 || release.platform !== 'darwin-universal' ||
      !['cep','companion'].includes(release.kind) || release.payloadBytes !== expected.bytes ||
      !Array.isArray(release.files) || !release.files.length || release.files.length > 15000)
    throw Error('Invalid production release');
  const paths = new Set(); let bytes = 8;
  for (const file of release.files) {
    exact(file, ['path','bytes','sha256','executable']);
    if (typeof file.path !== 'string' || file.path.length > 1024 || file.path.startsWith('/') ||
        /[\\\x00-\x1f]/.test(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..') ||
        paths.has(file.path) || !hash.test(file.sha256) || typeof file.executable !== 'boolean' ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw Error('Invalid release inventory');
    paths.add(file.path); bytes += file.bytes;
  }
  if (bytes !== expected.bytes || (release.kind === 'cep' && !['standard','paid-onboarding'].includes(release.customerOnboarding)))
    throw Error('Invalid release size or onboarding');
  return {kind:release.kind, version:release.version, customerOnboarding:release.customerOnboarding};
}

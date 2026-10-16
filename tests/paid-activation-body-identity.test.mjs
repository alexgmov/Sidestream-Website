import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiContractHarness } from './helpers/api-contract-harness.mjs';
import { loadInjectedModule } from './helpers/handler-loader.mjs';
import { invokeHandler } from './helpers/http.mjs';

const SOURCE = 'paid-acquisition-mc-v1';
const pair = { install_id_hash: 'a'.repeat(64), installer_receipt_id_hash: 'b'.repeat(64) };
const forged = { installIdHash: 'c'.repeat(64), installerReceiptIdHash: 'd'.repeat(64) };

async function setup({ rows = [pair], failRead = false, receipt = 'test-receipt' } = {}) {
  const harness = createApiContractHarness();
  const session = harness.activeSession('account-paid');
  const activation = harness.store.seedActivation({ activationKey: 'opaque-paid-activation', deviceId: 'paid-device' });
  const associations = [], reads = [];
  const query = harness.dependencies.query;
  const module = await loadInjectedModule(new URL('../api/activation/claim.ts', import.meta.url), {
    '../_lib/account.js': { ...harness.dependencies, async query(sql, params) {
      if (sql.includes('from public.sidestream_paid_activation_installation_identity')) {
        reads.push(params);
        if (failRead) throw new Error('identity store unavailable');
        return { rows };
      }
      return query(sql, params);
    } },
    '../_lib/paid-acquisition.js': { PAID_ACQUISITION_SOURCE: SOURCE,
      async associatePaidAcquisitionActivationWithOutcome(value) {
        associations.push(value);
        return { outcome: value.installIdHash ? 'installation_claimed_recorded' : 'installation_identity_missing' };
      },
    },
  });
  const handler = (req, res) => module.handleActivationClaim(req, res, {
    requiredActivationSource: SOURCE, claimPath: '/api/activation/paid-claim',
    inactiveEntitlementMode: 'support_only', googlePrompt: 'select_account',
    paidAcquisitionReceipt: receipt,
  });
  const path = '/api/activation/paid-claim?activation=opaque-paid-activation';
  const get = await invokeHandler(handler, { method: 'GET', url: path + '&' + new URLSearchParams(forged), session });
  assert.equal(get.response.statusCode, 200);
  assert.doesNotMatch(get.response.body, /installIdHash|installerReceiptIdHash|supportCode/);
  assert.equal(reads.length, 0, 'GET never reads or mutates installation association');
  const csrf = get.response.body.match(/name="csrf" value="([^"]+)"/)[1];
  const post = () => invokeHandler(handler, { method: 'POST', url: path, session,
    headers: { origin: 'https://sidestream.test', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ activation: activation.activationKey, csrf, intent: 'restore', ...forged }).toString(),
  });
  return { handler, harness, activation, associations, reads, post, path };
}

test('paid browser carries opaque activation only and cannot replace the exact start-body pair', async () => {
  const x = await setup();
  const signedOut = await invokeHandler(x.handler, { method: 'GET', url: x.path + '&' + new URLSearchParams(forged) });
  const next = new URL(signedOut.response.getHeader('location')).searchParams.get('next');
  assert.equal(next, x.path);
  for (let i = 0; i < 2; i++) {
    assert.equal((await x.post()).response.statusCode, 303);
    assert.deepEqual(x.reads[i], [x.activation.activationKey, 'production', 'account-paid', SOURCE]);
    assert.equal(x.associations[i].installIdHash, pair.install_id_hash);
    assert.equal(x.associations[i].installerReceiptIdHash, pair.installer_receipt_id_hash);
    assert.equal(x.associations[i].expectedAccountId, 'account-paid');
  }
});

test('legacy missing snapshot, missing browser receipt and store outage preserve valid entitlement recovery', async () => {
  for (const options of [{ rows: [] }, { rows: [pair, pair] }, { receipt: '' }, { failRead: true }]) {
    const x = await setup(options);
    assert.equal((await x.post()).response.statusCode, 303);
    if (options.rows) assert.equal(x.associations[0].installIdHash, undefined);
    else assert.equal(x.associations.length, 0);
  }
});

test('wrong account and expired activation never reach paid linkage', async () => {
  for (const mutate of [
    x => { x.activation.accountId = 'another-account'; },
    x => { x.harness.clock.advance(25 * 60 * 60 * 1000); },
  ]) {
    const x = await setup(); mutate(x);
    assert.ok([403, 409].includes((await x.post()).response.statusCode));
    assert.equal(x.associations.length, 0);
    assert.equal(x.reads.length, 0);
  }
});

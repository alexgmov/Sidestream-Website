import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { loadInjectedModule } from './helpers/handler-loader.mjs';
const mod = await loadInjectedModule(new URL('../api/_lib/purchase-attribution.ts', import.meta.url), {
  './postgres.js': { withPostgresTransaction: async () => { throw new Error('unexpected database'); } },
  './channel-report.js': { channelLabel: source => source === 'reddit' ? 'Reddit' : source },
});
const admin = await loadInjectedModule(new URL('../api/_lib/customer-admin.ts', import.meta.url), {});
const route = await loadInjectedModule(new URL('../api/internal/purchase-attribution.ts', import.meta.url), { '../_lib/customer-admin.js': admin, '../_lib/purchase-attribution.js': mod });
const input = { licenseNamespace: 'production', payments: [{ chargeId: 'ch_one', paymentIntentId: 'pi_one' }] };
test('batch rejects unbounded, duplicate, malformed and extra input without opening the database', () => {
  assert.deepEqual(mod.parsePurchaseAttributionRequest(input), input);
  for (const body of [null, {}, { ...input, email: 'secret' }, { ...input, licenseNamespace: 'all' }, { ...input, licenseNamespace: ['production'] }, { ...input, payments: [] }, { ...input, payments: Array(101).fill(input.payments[0]) }, { ...input, payments: [input.payments[0], input.payments[0]] }, { ...input, payments: [{ chargeId: 'cus_wrong', paymentIntentId: null }] }, { ...input, payments: [{ ...input.payments[0], email: 'secret' }] }]) assert.throws(() => mod.parsePurchaseAttributionRequest(body));
});
test('projection preserves unknown dates and omits identifiers and raw data', async () => {
  const calls = [];
  const report = await mod.queryPurchaseAttribution(input, { transaction: async cb => cb({ query: async (sql, params) => {
    calls.push([sql, params]); return { rows: sql.startsWith('set') ? [] : [{ position: 0, link_status: 'matched', source: 'reddit', medium: 'social', campaign: 'launch', content: 'bad@example.com', first_visit_at: '2026-09-01T00:00:00Z', first_install_at: null, profile_id: 'secret-profile', email: 'secret@example.com' }] };
  } }) });
  assert.equal(report.rows[0].channel, 'Reddit'); assert.equal(report.rows[0].content, null); assert.equal(report.rows[0].firstInstallAt, null);
  assert.doesNotMatch(JSON.stringify(report), /secret|ch_one|pi_one|profile_id/);
  assert.match(calls[0][0], /statement_timeout/);
  assert.deepEqual(calls[1][1], ['production', JSON.stringify(input.payments)]);
});
test('protected route rejects browser calls and sanitizes internal failures', async () => {
  const secret = 'test-purchase-admin-secret';
  const handler = route.createPurchaseAttributionHandler({ getAdminSecret: () => secret, queryReport: async body => ({ schemaVersion: 1, ...mod.parsePurchaseAttributionRequest(body) }) });
  async function call(headers = {}, method = 'POST', body = input, target = handler) {
    const req = Object.assign(new EventEmitter(), { method, headers, rawHeaders: Object.entries(headers).flat(), body });
    const res = { headers: {}, setHeader(k,v) { this.headers[k.toLowerCase()] = v; }, end(text) { this.body = text; } };
    await target(req, res); return res;
  }
  assert.equal((await call()).statusCode, 401); assert.equal((await call({}, 'GET')).statusCode, 405);
  assert.equal((await call({ authorization: `Bearer ${secret}`, origin: 'https://sidestream.tv' })).statusCode, 403);
  const good = await call({ authorization: `Bearer ${secret}` }); assert.equal(good.statusCode, 200); assert.match(good.headers['cache-control'], /no-store/);
  assert.equal((await call({ authorization: `Bearer ${secret}` }, 'POST', {})).statusCode, 400);
  const bad = route.createPurchaseAttributionHandler({ getAdminSecret: () => secret, queryReport: async () => { throw new Error('secret database detail'); } });
  const failure = await call({ authorization: `Bearer ${secret}` }, 'POST', input, bad);
  assert.equal(failure.statusCode, 500); assert.doesNotMatch(failure.body, /secret/);
});

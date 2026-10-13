import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { loadInjectedModule } from './helpers/handler-loader.mjs';
const mod = await loadInjectedModule(new URL('../api/_lib/channel-report.ts', import.meta.url), { './postgres.js': { withPostgresTransaction: async () => { throw new Error('unexpected database'); } } });
const admin = await loadInjectedModule(new URL('../api/_lib/customer-admin.ts', import.meta.url), {});
const route = await loadInjectedModule(new URL('../api/internal/channel-report.ts', import.meta.url), { '../_lib/customer-admin.js': admin, '../_lib/channel-report.js': mod });
const input = { licenseNamespace: 'production', from: '2026-08-01T00:00:00.000Z', through: '2026-09-01T00:00:00.000Z', asOf: '2026-09-20T00:00:00.000Z' };
const row = (source, values = {}) => ({ source, medium: null, campaign: null, content: null, referrer: null, visitors: '10', downloads: '3', checkouts: '2', converted: '1', cohort_buyers: '1', buyers: '2', ...values });
test('channels preserve complete totals and keep unspecified Instagram and search honest', () => {
  const report = mod.buildChannelReport(input, [row('instagram'), row('ig'), row('external_referrer', { referrer: 'search' }), row('google')]);
  assert.equal(report.channels.find(x => x.channel === 'Instagram (unspecified)').visitors, 20);
  assert.equal(report.channels.find(x => x.channel === 'Google').visitors, 10);
  assert.equal(report.channels.find(x => x.channel === 'Search (unspecified)').visitors, 10);
  assert.equal(report.totals.conversionRate, 10);
  assert.equal(report.totals.visitors, 40);
  assert.equal(report.totals.buyers, 8);
  assert.equal(report.campaigns.length, 4);
});
test('bio and Manychat visits and paid outcomes stay separate without changing raw tags or totals', () => {
  const rows = [
    row('instagram', { medium: 'social', campaign: 'ugc-instagram-02', visitors: '20', converted: '2', cohort_buyers: '2', buyers: '3' }),
    row('manychat-instagram', { medium: 'dm', campaign: 'ugc-instagram-02', visitors: '10', converted: '3', cohort_buyers: '3', buyers: '4' }),
    row('ig', { medium: 'social', content: 'link_in_bio', visitors: '5', converted: '0', cohort_buyers: '0', buyers: '0' }),
  ];
  const report = mod.buildChannelReport(input, rows);
  const bio = report.channels.find(x => x.channel === 'Instagram / Bio');
  const dm = report.channels.find(x => x.channel === 'Instagram / Manychat');
  assert.equal(bio.visitors, 25); assert.equal(bio.buyers, 3); assert.equal(bio.conversionRate, 8);
  assert.equal(dm.visitors, 10); assert.equal(dm.buyers, 4); assert.equal(dm.conversionRate, 30);
  for (const key of ['visitors', 'downloads', 'checkouts', 'converted', 'cohort_buyers', 'buyers']) {
    assert.equal(report.totals[key], rows.reduce((sum, row) => sum + Number(row[key]), 0));
  }
  assert.equal(report.totals.conversionRate, 5 / 35 * 100);
  assert.deepEqual(report.campaigns.map(({ source, medium, campaign, content, referrer }) => ({ source, medium, campaign, content, referrer })), rows.map(({ source, medium, campaign, content, referrer }) => ({ source, medium, campaign, content, referrer })));
});
test('placement labels require explicit evidence and do not change other reports channel labels', () => {
  const cases = [
    [row('instagram', { medium: 'social', campaign: 'bio' }), 'Instagram / Bio'],
    [row('instagram', { medium: 'social', campaign: 'alex-bio' }), 'Instagram / Bio'],
    [row('instagram', { medium: 'social', campaign: 'ugc-instagram-01' }), 'Instagram / Bio'],
    [row('instagram-bio'), 'Instagram / Bio'],
    [row('instagram', { medium: 'social', campaign: 'unregistered' }), 'Instagram (unspecified)'],
    [row('instagram', { campaign: 'ugc-instagram-02' }), 'Instagram (unspecified)'],
    [row('instagram', { medium: 'dm', campaign: 'ugc-instagram-02' }), 'Instagram / DM (unspecified)'],
    [row('instagram', { medium: 'paid_social', content: 'link_in_bio' }), 'Instagram (unspecified)'],
    [row('manychat'), 'Manychat (unspecified platform)'],
    [row('facebook', { medium: 'dm', campaign: 'sidestream.tv', content: 'manychat_comments' }), 'Facebook / Manychat'],
    [row('facebook', { medium: 'dm', campaign: 'sidestream.tv' }), 'Facebook'],
    [row('meta', { medium: 'social', campaign: 'sidestream_direct_offer_test' }), 'Meta'],
  ];
  for (const [inputRow, label] of cases) {
    const report = mod.buildChannelReport(input, [inputRow]);
    assert.equal(report.channels[0].channel, label);
    assert.equal(report.campaigns[0].channel, label);
    assert.match(label, /^[A-Za-z0-9][A-Za-z0-9 ._()/\-]{0,79}$/);
  }
  assert.equal(mod.channelLabel('manychat-instagram', null), 'Instagram');
});
test('zero denominators are unavailable; campaign cap never truncates channel totals', () => {
  const report = mod.buildChannelReport(input, Array.from({ length: 105 }, (_, i) => row('reddit', { campaign: `post-${i}` })));
  assert.equal(report.campaigns.length, 100);
  assert.equal(report.campaignCount, 105);
  assert.equal(report.channels[0].visitors, 1050);
  assert.equal(report.campaignsTruncated, true);
  assert.equal(mod.buildChannelReport(input, []).totals.conversionRate, null);
  assert.throws(() => mod.buildChannelReport(input, [row('reddit', { converted: '11' })]));
});
test('request validation rejects unknown fields, impossible dates, bad namespace and unbounded windows', () => {
  assert.deepEqual(mod.parseChannelReportRequest(input), input);
  for (const override of [{ licenseNamespace: 'prod' }, { from: '2026-02-30T00:00:00Z' }, { through: input.from }, { from: '2020-01-01T00:00:00Z' }, { email: 'secret@example.com' }]) assert.throws(() => mod.parseChannelReportRequest({ ...input, ...override }));
});
test('read uses bounded read-only transaction and sanitized grouped projection', async () => {
  const calls = [];
  const result = await mod.queryChannelReport(input, { transaction: async callback => callback({ query: async (sql, params) => { calls.push([sql, params]); return { rows: [] }; } }) });
  assert.equal(calls.length, 2);
  assert.match(calls[0][0], /statement_timeout/);
  assert.deepEqual(calls[1][1], Object.values(input));
  assert.equal(result.totals.buyers, 0);
});
test('POST-only route rejects unauthenticated and browser-origin calls; errors do not leak internals', async () => {
  const secret = 'channel-test-secret-long-enough';
  const handler = route.createChannelReportHandler({ getAdminSecret: () => secret, queryReport: async body => mod.buildChannelReport(mod.parseChannelReportRequest(body), []) });
  async function call(headers = {}, method = 'POST', body = input, target = handler) {
    const req = Object.assign(new EventEmitter(), { method, headers, rawHeaders: Object.entries(headers).flat(), body });
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(text) { this.body = text; } };
    await target(req, res); return res;
  }
  assert.equal((await call()).statusCode, 401);
  assert.equal((await call({}, 'GET')).statusCode, 405);
  assert.equal((await call({ authorization: `Bearer ${secret}`, origin: 'https://sidestream.tv' })).statusCode, 403);
  const success = await call({ authorization: `Bearer ${secret}` });
  assert.equal(success.statusCode, 200);
  assert.match(success.headers['cache-control'], /no-store/);
  assert.equal((await call({ authorization: `Bearer ${secret}` }, 'POST', {})).statusCode, 400);
  const failure = await call({ authorization: `Bearer ${secret}` }, 'POST', input, route.createChannelReportHandler({ getAdminSecret: () => secret, queryReport: async () => { throw new Error('database-password'); } }));
  assert.equal(failure.statusCode, 500); assert.doesNotMatch(failure.body, /database-password/);
});

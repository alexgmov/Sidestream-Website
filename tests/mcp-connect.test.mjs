import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = process.env.SIDESTREAM_MCP_WEB_SOURCE || fileURLToPath(new URL('../src/mcp-connect.js', import.meta.url));
const { createMcpPage } = await import(pathToFileURL(source));
const connectionId = 'c'.repeat(43);
const base = 'https://sidestream.tv';
const connectionUrl = `${base}/mcp.html?connection=${connectionId}`;

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.hidden = true; this.disabled = false; this.textContent = '';
    this.dataset = {}; this.attributes = new Map(); this.listeners = new Map(); this.children = []; this.href = '';
  }
  set innerHTML(_) { throw new Error('Untrusted page data must use textContent.'); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...items) { for (const child of items) { child.parent = this; this.children.push(child); } }
  replaceChildren(...items) { for (const child of this.children) child.parent = null; this.children = []; this.append(...items); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  addEventListener(name, handler) { const list = this.listeners.get(name) || []; list.push(handler); this.listeners.set(name, list); }
  async click() { if (!this.disabled) await Promise.all((this.listeners.get('click') || []).map(handler => handler({ preventDefault() {} }))); }
}

function account(plan = 'free') {
  return { plan, remainingDownloads: plan === 'free' ? 7 : null, upgrade: { url: '/upgrade.html?from=mcp' } };
}
function release(extra = {}) {
  return { schemaVersion: 1, available: true, platform: 'darwin-universal', version: '1.0.0', sha256: 'a'.repeat(64),
    sizeBytes: 123456, downloadUrl: '/api/download-mcp', ...extra };
}
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, async json() { return body; } }; }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function eventually(check) {
  for (let attempt = 0; attempt < 30; attempt++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('The page did not reach the expected state.');
}

function fixture({ url = connectionUrl, handle } = {}) {
  const elements = new Map();
  const document = { getElementById(id) {
    if (!elements.has(id)) {
      const element = new Element(); element.id = id;
      if (id === 'install-extension') element.setAttribute('aria-disabled', 'true');
      if (id === 'new-connection') element.href = '/mcp.html';
      if (id === 'plan-upgrade') element.href = '/upgrade.html?from=account';
      elements.set(id, element);
    }
    return elements.get(id);
  }, createElement(tag) { return new Element(tag); } };
  const requests = [], timers = new Set();
  const controller = createMcpPage({ document, location: { href: url },
    setTimeout(callback) { const timer = { callback }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    async fetch(target, options) {
      const request = { url: String(target), options, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined };
      requests.push(request);
      const result = handle ? await handle(request) : undefined;
      if (result !== undefined) return result;
      if (request.url === '/api/auth/session') return response({ authenticated: false });
      if (request.url === '/api/mcp/connections') return response({ csrfToken: 'list-csrf', connections: [] });
      if (request.url.startsWith('/api/mcp/authorize?')) return response({ status: 'pending', csrfToken: 'approve-csrf', clientName: 'Claude Desktop', account: account() });
      if (request.url === '/mcp-release.json') return response(release());
      if (request.url === '/api/checkout/offer?view=plans') return response({ plans: {
        pro_monthly: { formattedPrice: '$9.99', currency: 'USD', billingCadence: 'month' },
        unlimited_one_time: { formattedPrice: '$34.99', currency: 'USD', billingCadence: 'one_time' },
      } });
      throw new Error('Unhandled fake request: ' + request.url);
    }
  });
  return { controller, requests, timers, element: id => document.getElementById(id), ready: controller.ready };
}

test('signed-out setup builds a safe sign-in next target and shows no install or approval action', async () => {
  const f = fixture({ url: `${base}/mcp.html?next=https://evil.example&tracking=secret` }); await f.ready;
  const link = new URL(f.element('sign-in').href);
  assert.equal(link.origin, base);
  assert.equal(link.pathname, '/api/auth/google/start');
  assert.equal(link.searchParams.get('next'), '/mcp.html');
  assert.equal(f.element('sign-in').hidden, false);
  assert.equal(f.element('install-extension').hidden, true);
  assert.equal(f.element('approve-connection').hidden, true);
  assert.equal(f.element('connect-card').getAttribute('aria-busy'), 'false');
});

test('sign-in rejects external URLs and same-origin links with an unrelated next destination', async () => {
  for (const signInUrl of ['https://evil.example/steal', '/api/auth/google/start?next=https://evil.example', '/api/auth/google/start?next=/account.html']) {
    const f = fixture({ handle(req) { if (req.url.startsWith('/api/mcp/authorize?')) return response({ code: 'authentication_required', signInUrl }, 401); } });
    await f.ready;
    const link = new URL(f.element('sign-in').href);
    assert.equal(link.origin, base);
    assert.equal(link.pathname, '/api/auth/google/start');
    assert.equal(link.searchParams.get('next'), `/mcp.html?connection=${connectionId}`);
  }
});

test('invalid or duplicate connection IDs never request approval', async () => {
  for (const query of ['connection=bad', `connection=${connectionId}&connection=${connectionId}`]) {
    const f = fixture({ url: `${base}/mcp.html?${query}` }); await f.ready;
    assert.match(f.element('connection-title').textContent, /invalid/i);
    assert.equal(f.requests.some(req => req.url.startsWith('/api/mcp/authorize')), false);
    assert.equal(f.element('approve-connection').hidden, true);
    assert.equal(f.element('new-connection').hidden, false);
  }
});

test('signed-in setup exposes only a verified same-origin extension release', async () => {
  for (const manifest of [release(), release({ available: false }), release({ downloadUrl: 'https://evil.example/extension.mcpb' }), release({ sha256: 'invalid' })]) {
    const f = fixture({ url: `${base}/mcp.html`, handle(req) {
      if (req.url === '/api/auth/session') return response({ authenticated: true, license: { active: true, purchasePlan: 'pro_monthly' } });
      if (req.url === '/mcp-release.json') return response(manifest);
    } });
    await f.ready;
    assert.equal(f.element('setup-steps').hidden, false);
    assert.equal(f.element('plan-name').textContent, 'Sidestream Pro');
    const valid = manifest.available && manifest.downloadUrl === '/api/download-mcp' && manifest.sha256.length === 64;
    assert.equal(f.element('install-extension').hidden, !valid);
    if (valid) { assert.equal(f.element('install-extension').href, `${base}/api/download-mcp`); assert.equal(f.element('install-extension').getAttribute('aria-disabled'), null); }
    else assert.match(f.element('connection-status').textContent, /prepared|available|release/i);
  }
});

test('pending consent requires one explicit CSRF-bound decision and prevents a repeated approval', async () => {
  const completion = deferred();
  const f = fixture({ handle(req) {
    if (req.url.startsWith('/api/mcp/authorize?')) return response({ status: 'pending', csrfToken: 'exact-csrf', clientName: '<script>attack</script>', account: { ...account(), email: 'editor@example.test' } });
    if (req.url === '/api/mcp/authorize') return completion.promise;
  } });
  await f.ready;
  assert.equal(f.requests.filter(req => req.method === 'POST').length, 0);
  assert.equal(f.element('approve-connection').hidden, false);
  assert.match(f.element('connection-consent').textContent, /<script>attack<\/script>/);
  assert.match(f.element('connection-consent').textContent, /Signed in as editor@example.test/);
  const switchLink = new URL(f.element('switch-account').href, base);
  assert.equal(switchLink.searchParams.get('prompt'), 'select_account');
  assert.equal(switchLink.searchParams.get('next'), `/mcp.html?connection=${connectionId}`);
  assert.equal(f.element('switch-account').hidden, false);
  const first = f.controller.decide('approve'), duplicate = f.controller.decide('approve');
  const posts = f.requests.filter(req => req.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { connectionId, csrfToken: 'exact-csrf', decision: 'approve' });
  assert.equal(f.element('approve-connection').disabled, true);
  completion.resolve(response({ status: 'connected', account: account('unlimited_one_time') }));
  await Promise.all([first, duplicate]);
  assert.equal(f.element('connection-badge').hidden, false);
  assert.equal(f.element('approve-connection').hidden, true);
  assert.equal(f.element('deny-connection').hidden, true);
  assert.equal(f.element('switch-account').hidden, true);
  await f.controller.decide('approve');
  assert.equal(f.requests.filter(req => req.method === 'POST').length, 1, 'completed consent token cannot be replayed from the page');
});

test('connected status does not request new consent and denied response is verified', async () => {
  const connected = fixture({ handle(req) { if (req.url.startsWith('/api/mcp/authorize?')) return response({ status: 'connected', account: account() }); } });
  await connected.ready;
  assert.equal(connected.element('connection-badge').hidden, false);
  assert.equal(connected.element('approve-connection').hidden, true);
  for (const status of ['denied', 'pending']) {
    const f = fixture({ handle(req) { if (req.url === '/api/mcp/authorize') return response({ status }); } });
    await f.ready; await f.controller.decide('deny');
    if (status === 'denied') {
      assert.match(f.element('connection-title').textContent, /cancelled/i);
      assert.equal(f.element('approve-connection').hidden, true);
      assert.equal(f.element('connection-badge').hidden, true);
    } else {
      assert.doesNotMatch(f.element('connection-title').textContent, /cancelled/i);
      assert.equal(f.element('retry-connection').hidden, false);
    }
  }
});

test('approval auth and expiry failures remove stale consent and cannot reuse its token', async () => {
  for (const [code, status] of [['authentication_required', 401], ['connection_expired', 410], ['connection_denied', 409]]) {
    const f = fixture({ handle(req) { if (req.url === '/api/mcp/authorize') return response({ code }, status); } });
    await f.ready; await f.controller.decide('approve');
    assert.equal(f.element('approve-connection').hidden, true);
    assert.equal(f.element('deny-connection').hidden, true);
    assert.equal(f.element('connection-consent').hidden, true);
    assert.equal(f.element('connection-badge').hidden, true);
    if (status === 401) assert.equal(f.element('sign-in').hidden, false);
    else assert.equal(f.element('new-connection').hidden, false);
    await f.controller.decide('approve');
    assert.equal(f.requests.filter(req => req.method === 'POST').length, 1);
  }
});

test('network retries reload authoritative connection state without repeating an uncertain approval', async () => {
  let connected = false, firstLoad = true;
  const f = fixture({ handle(req) {
    if (req.url.startsWith('/api/mcp/authorize?')) {
      if (firstLoad) { firstLoad = false; throw new Error('network'); }
      return response(connected ? { status: 'connected', account: account() } : { status: 'pending', csrfToken: 'fresh-csrf', account: account() });
    }
    if (req.url === '/api/mcp/authorize') { connected = true; throw new Error('lost response after server approval'); }
  } });
  await f.ready;
  assert.equal(f.element('retry-connection').hidden, false);
  await f.element('retry-connection').click();
  assert.equal(f.element('approve-connection').hidden, false);
  await f.controller.decide('approve');
  assert.equal(f.element('connection-badge').hidden, true);
  assert.equal(f.element('retry-connection').hidden, false);
  await f.element('retry-connection').click();
  assert.equal(f.element('connection-badge').hidden, false);
  assert.equal(f.requests.filter(req => req.method === 'POST').length, 1);
  for (const req of f.requests) {
    assert.equal(req.options.credentials, 'same-origin');
    assert.equal(req.options.cache, 'no-store');
    assert.equal(req.options.redirect, 'error');
    assert.ok(req.options.signal instanceof AbortSignal);
  }
  await eventually(() => f.timers.size === 0);
});

test('account mismatch provides specific recovery rather than an approval retry loop', async () => {
  const f = fixture({ handle(req) { if (req.url.startsWith('/api/mcp/authorize?')) return response({ code: 'account_mismatch' }, 403); } });
  await f.ready;
  const text = f.element('connection-title').textContent + ' ' + f.element('connection-description').textContent + ' ' + f.element('connection-status').textContent;
  assert.match(text, /different (?:Sidestream )?account|same account|correct account|another account/i);
  assert.equal(f.element('approve-connection').hidden, true);
  assert.ok(!f.element('new-connection').hidden || !f.element('sign-in').hidden, 'an actionable account recovery link is visible');
});

test('disconnect uses list CSRF, handles network retry, and clears current connected messaging', async () => {
  let unavailable = true, disconnects = 0;
  const f = fixture({ handle(req) {
    if (req.url.startsWith('/api/mcp/authorize?')) return response({ status: 'connected', account: account() });
    if (req.url === '/api/mcp/connections' && req.method === 'GET') return response({ csrfToken: 'disconnect-csrf', connections: [{ id: connectionId, clientName: '<b>assistant</b>', createdAt: '2026-11-01T00:00:00Z' }] });
    if (req.url === '/api/mcp/connections' && req.method === 'POST') {
      disconnects++; assert.deepEqual(req.body, { connectionId, csrfToken: 'disconnect-csrf' });
      if (unavailable) throw new Error('network');
      return response({ revoked: true });
    }
  } });
  await f.ready;
  await eventually(() => f.element('connections-list').children.length === 1);
  const row = f.element('connections-list').children[0], button = row.children[1];
  assert.equal(row.children[0].children[0].textContent, '<b>assistant</b>');
  await button.click();
  assert.equal(button.disabled, false);
  assert.equal(f.element('connections-list').children.length, 1);
  assert.match(f.element('connections-status').textContent, /try again/i);
  unavailable = false;
  await Promise.all([button.click(), button.click()]);
  assert.equal(disconnects, 2);
  assert.equal(f.element('connections-list').children.length, 0);
  assert.equal(f.element('connection-badge').hidden, true);
  assert.match(f.element('connection-title').textContent, /disconnected/i);
  assert.doesNotMatch(f.element('connection-description').textContent, /send a video link to start downloading/i);
});

test('empty CSRF never exposes a usable disconnect action', async () => {
  const f = fixture({ handle(req) {
    if (req.url === '/api/mcp/connections') return response({ csrfToken: '', connections: [{ id: connectionId }] });
  } });
  await f.ready;
  assert.equal(f.element('connections-list').children.length, 0);
});

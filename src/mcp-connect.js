export function createMcpPage({ document, location, fetch: requestFetch, setTimeout: delay = setTimeout, clearTimeout: cancelDelay = clearTimeout }) {
  const elements = Object.fromEntries(['connect-card','step-label','connection-badge','connection-title','connection-description',
    'connection-consent','switch-account','sign-in','install-extension','approve-connection','deny-connection','retry-connection','new-connection',
    'setup-steps','plan-summary','plan-name','plan-detail','plan-upgrade','connection-status','connections-section',
    'connections-list','connections-status','pricing-note'].map((id) => [id, document.getElementById(id)]));
  const current = new URL(location.href);
  const keys = current.searchParams.getAll('connection');
  const connectionId = keys.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(keys[0]) ? keys[0] : null;
  const invalidConnection = keys.length > 0 && !connectionId;
  let csrfToken = '', listCsrf = '', busy = false, generation = 0;
  function show(id, visible = true) { elements[id].hidden = !visible; }
  function status(message = '', tone = '') { elements['connection-status'].textContent = message; elements['connection-status'].dataset.tone = tone; }
  function link(value, paths) {
    try { const target = new URL(value, current.origin); return target.origin === current.origin && !target.username && !target.password && !target.hash && paths.includes(target.pathname) ? target.href : null; }
    catch { return null; }
  }
  async function api(url, body) {
    const controller = new AbortController();
    const timer = delay(() => controller.abort(), 12000);
    try {
      const response = await requestFetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      const payload = await response.json();
      if (!response.ok) { const error = new Error('request_failed'); error.payload = payload; error.status = response.status; throw error; }
      return payload;
    } finally { cancelDelay(timer); }
  }
  function signIn(provided) {
    const fallback = '/api/auth/google/start?next=' + encodeURIComponent('/mcp.html' + (connectionId ? '?connection=' + connectionId : ''));
    elements['sign-in'].href = new URL(fallback, current.origin).href;
    show('sign-in');
    elements['connection-title'].textContent = 'Your account comes with you.';
    elements['connection-description'].textContent = 'Sign in to connect your assistant. Your existing plan and remaining free downloads carry over.';
  }
  function renderAccount(account) {
    if (!account || !['free','pro_monthly','unlimited_one_time','legacy_paid'].includes(account.plan)) return;
    const paid = account.plan !== 'free';
    elements['plan-name'].textContent = account.plan === 'free' ? 'Sidestream Free' : account.plan === 'pro_monthly' ? 'Sidestream Pro' : 'Sidestream Unlimited';
    elements['plan-detail'].textContent = paid ? 'Unlimited downloads · Up to 4K' : Number.isInteger(account.remainingDownloads)
      ? `${account.remainingDownloads} free download${account.remainingDownloads === 1 ? '' : 's'} available · Up to 1080p` : '10 free downloads total · Up to 1080p';
    const upgrade = link(account.upgrade?.url || '/upgrade.html?from=account', ['/api/mcp/upgrade','/upgrade.html','/account.html']);
    if (upgrade) elements['plan-upgrade'].href = upgrade;
    show('plan-upgrade', !paid); show('plan-summary');
  }
  function completed(account) {
    csrfToken = '';
    show('approve-connection', false); show('deny-connection', false); show('connection-consent', false); show('switch-account', false); show('connection-badge');
    elements['step-label'].textContent = 'Ready to download';
    elements['connection-title'].textContent = 'You’re connected.';
    elements['connection-description'].textContent = 'Return to your assistant and ask it to check your Sidestream account. Then send a video link to start downloading.';
    renderAccount(account);
    status('You can close this page. Manage connected assistants from your Sidestream account.', 'success');
  }
  function failure(error) {
    csrfToken = '';
    for (const id of ['approve-connection','deny-connection','connection-consent','switch-account']) show(id, false);
    const code = error?.payload?.code;
    if (error?.status === 401) { generation += 1; show('plan-summary', false); show('connections-section', false); elements['connections-list'].replaceChildren(); signIn(error.payload?.signInUrl); return; }
    if (['connection_expired','connection_not_found','connection_denied','connection_revoked'].includes(code) || error?.status === 404 || error?.status === 410) {
      elements['connection-title'].textContent = code === 'connection_denied' ? 'Connection cancelled.' : 'This connection link has expired.';
      elements['connection-description'].textContent = 'Ask your assistant to connect Sidestream again to get a fresh link.';
      show('new-connection'); status('Your account and downloads are unchanged.'); return;
    }
    if (code === 'account_mismatch') {
      signIn();
      elements['sign-in'].href += '&prompt=select_account';
      elements['sign-in'].textContent = 'Use a different Google account';
      elements['connection-title'].textContent = 'Use the connected account.';
      elements['connection-description'].textContent = 'This connection belongs to a different Sidestream account. Sign in with the account you used to connect your assistant.';
      status('Your accounts and purchases have not been changed.'); return;
    }
    if (code === 'transfer_required') {
      elements['connection-title'].textContent = 'Manage your active devices.';
      elements['connection-description'].textContent = 'Your plan has reached its active device limit. Free a device in your account, then try connecting again.';
      elements['new-connection'].href = '/account.html'; elements['new-connection'].textContent = 'Manage devices'; show('new-connection');
    }
    status(code === 'mcp_disabled' || code === 'mcp_unavailable' ? 'Sidestream for AI is not available right now. Please try again shortly.'
      : 'We couldn’t complete that step. Check your connection and try again.', 'error');
    show('retry-connection');
  }
  async function loadConnections() {
    const listGeneration = generation;
    try {
      const payload = await api('/api/mcp/connections');
      if (listGeneration !== generation) return;
      if (!Array.isArray(payload.connections) || typeof payload.csrfToken !== 'string' || !payload.csrfToken) return;
      listCsrf = payload.csrfToken;
      elements['connections-list'].replaceChildren();
      show('connections-section', payload.connections.length > 0);
      for (const item of payload.connections.slice(0, 20)) {
        if (typeof item.id !== 'string') continue;
        const row = document.createElement('div'); row.className = 'connection';
        const label = document.createElement('div');
        const name = document.createElement('div'); name.className = 'connection-name'; name.textContent = String(item.clientName || 'Sidestream MCP').slice(0, 80);
        const date = document.createElement('div'); date.className = 'connection-date';
        date.textContent = Number.isFinite(Date.parse(item.createdAt)) ? 'Connected ' + new Date(item.createdAt).toLocaleDateString() : 'Connected assistant';
        label.append(name, date);
        const button = document.createElement('button'); button.type = 'button'; button.className = 'button secondary'; button.textContent = 'Disconnect';
        button.addEventListener('click', async () => {
          button.disabled = true; elements['connections-status'].textContent = '';
          try {
            await api('/api/mcp/connections', { connectionId: item.id, csrfToken: listCsrf });
            row.remove(); elements['connections-status'].textContent = 'Assistant disconnected. Your saved downloads and purchases are unchanged.';
            if (item.id === connectionId) { show('connection-badge', false); elements['connection-title'].textContent = 'Assistant disconnected.'; elements['connection-description'].textContent = 'This assistant no longer has access to your Sidestream account.'; status('Ask your assistant to connect again whenever you need it.'); }
          } catch (error) {
            button.disabled = false;
            if (error?.payload?.code === 'invalid_confirmation') {
              await loadConnections();
              elements['connections-status'].textContent = 'Your connection list was refreshed. Choose Disconnect again.';
            } else { elements['connections-status'].textContent = 'Couldn’t disconnect this assistant. Reload this page and try again.'; }
          }
        });
        row.append(label, button); elements['connections-list'].append(row);
      }
    } catch { /* Connection management must not block the sign-in or approval action. */ }
  }
  async function loadSetup() {
    const session = await api('/api/auth/session');
    if (!session.authenticated) { signIn(); return; }
    elements['connection-title'].textContent = 'Bring Sidestream to Claude.';
    elements['connection-description'].textContent = 'Install the extension once, then connect this account from your assistant.';
    show('setup-steps');
    renderAccount({ plan: session.license?.active ? (session.license.purchasePlan || 'legacy_paid') : 'free' });
    await Promise.allSettled([loadConnections(), (async () => {
      try {
        const release = await api('/mcp-release.json');
        let url;
        if (release.schemaVersion === 1 && release.available === true && release.platform === 'darwin-universal' &&
            /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(release.version) && /^[a-f0-9]{64}$/.test(release.sha256) && Number.isSafeInteger(release.sizeBytes) && release.sizeBytes > 0) {
          url = link(release.downloadUrl, ['/api/download-mcp']);
        }
        if (!url) { status('The desktop extension is being prepared for release. Your account is ready; check back here for the download.'); return; }
        elements['install-extension'].href = url; elements['install-extension'].removeAttribute('aria-disabled');
        show('install-extension');
        status('After installing, ask Claude to connect Sidestream.');
      } catch { status('We couldn’t load the extension download. Try again in a moment.', 'error'); show('retry-connection'); }
    })()]);
  }
  async function load() {
    if (busy) return;
    busy = true; csrfToken = ''; const thisGeneration = ++generation;
    elements['connect-card'].setAttribute('aria-busy', 'true');
    for (const id of ['sign-in','install-extension','approve-connection','deny-connection','retry-connection','new-connection','connection-consent','switch-account','connection-badge','setup-steps','plan-summary','connections-section']) show(id, false);
    status();
    try {
      if (invalidConnection) {
        elements['connection-title'].textContent = 'This connection link is invalid.';
        elements['connection-description'].textContent = 'Ask your assistant for a new Sidestream connection link.';
        show('new-connection'); return;
      }
      if (!connectionId) { await loadSetup(); return; }
      const payload = await api('/api/mcp/authorize?connection=' + encodeURIComponent(connectionId));
      if (thisGeneration !== generation) return;
      renderAccount(payload.account);
      if (payload.status === 'connected') { completed(payload.account); void loadConnections(); return; }
      if (payload.status === 'denied') { failure({ payload: { code: 'connection_denied' } }); return; }
      if (payload.status !== 'pending' || typeof payload.csrfToken !== 'string' || !payload.csrfToken) throw new Error('Invalid connection response');
      csrfToken = payload.csrfToken;
      elements['connection-title'].textContent = 'Connect your assistant?';
      elements['connection-description'].textContent = 'Approve only if you just asked your assistant to connect Sidestream.';
      const signedInAs = typeof payload.account?.email === 'string' ? `Signed in as ${payload.account.email.slice(0,254)}. ` : '';
      elements['switch-account'].href = '/api/auth/google/start?prompt=select_account&next=' + encodeURIComponent('/mcp.html?connection=' + connectionId);
      elements['connection-consent'].textContent = `${signedInAs}${String(payload.clientName || 'Sidestream MCP').slice(0,80)} will use your Sidestream plan and download allowance. Files save to the folder you chose during setup. You can disconnect it here at any time.`;
      show('connection-consent'); show('switch-account'); show('approve-connection'); show('deny-connection');
      void loadConnections();
    } catch (error) { failure(error); }
    finally { busy = false; elements['connect-card'].setAttribute('aria-busy', 'false'); }
  }
  async function decide(decision) {
    if (busy || !csrfToken || !connectionId) return;
    busy = true;
    elements['approve-connection'].disabled = true; elements['deny-connection'].disabled = true;
    status(decision === 'approve' ? 'Connecting your account…' : 'Cancelling connection…');
    try {
      const result = await api('/api/mcp/authorize', { connectionId, csrfToken, decision });
      if (decision === 'approve' && result.status === 'connected') completed(result.account);
      else if (decision === 'deny' && result.status === 'denied') {
        csrfToken = '';
        show('approve-connection', false); show('deny-connection', false); show('connection-consent', false); show('switch-account', false); show('new-connection');
        elements['connection-title'].textContent = 'Connection cancelled.';
        elements['connection-description'].textContent = 'This assistant has not been given access to your Sidestream account.';
        status('You can close this page.');
      } else throw new Error('Unexpected approval response');
      void loadConnections();
    } catch (error) { failure(error); }
    finally { busy = false; elements['approve-connection'].disabled = false; elements['deny-connection'].disabled = false; }
  }
  async function loadPricing() {
    try {
      const { plans } = await api('/api/checkout/offer?view=plans');
      const pro = plans?.pro_monthly, unlimited = plans?.unlimited_one_time;
      if (pro?.billingCadence !== 'month' || unlimited?.billingCadence !== 'one_time' ||
          typeof pro.formattedPrice !== 'string' || typeof unlimited.formattedPrice !== 'string' ||
          pro.formattedPrice.length > 40 || unlimited.formattedPrice.length > 40 || !/^[A-Z]{3}$/.test(pro.currency) || !/^[A-Z]{3}$/.test(unlimited.currency)) return;
      elements['pricing-note'].textContent = `10 free downloads, up to 1080p. Pro: ${pro.formattedPrice} ${pro.currency}/month for unlimited 4K. Unlimited: ${unlimited.formattedPrice} ${unlimited.currency} once, including social downloads.`;
    } catch { /* The Free statement remains accurate if pricing is temporarily unavailable. */ }
  }
  elements['approve-connection'].addEventListener('click', () => decide('approve'));
  elements['deny-connection'].addEventListener('click', () => decide('deny'));
  elements['retry-connection'].addEventListener('click', load);
  return { load, decide, ready: Promise.allSettled([load(), loadPricing()]) };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  createMcpPage({ document, location: window.location, fetch: window.fetch.bind(window) });
}

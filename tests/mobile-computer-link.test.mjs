import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const start = html.indexOf("      if (mobileDownloadCopyLink &&");
const end = html.indexOf("    }\n    if (windowsWaitlistForm", start);
assert.ok(start > 0 && end > start, "Run the actual inline computer-link controller");
const controller = html.slice(start, end);
const handoffUrl = "https://sidestream.tv/api/send-download-links?handoff=opaque-test-envelope";

function element() {
  const listeners = {};
  const classes = new Set();
  return {
    hidden: false, disabled: false, textContent: "", value: "", attributes: {},
    listeners, classes,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
    },
    addEventListener: (event, listener) => { listeners[event] = listener; },
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { this.focused = true; },
    select() { this.selected = true; },
    setSelectionRange(start, end) { this.selection = [start, end]; },
  };
}

function fixture({ share, copy, fetchImpl, mobile = true } = {}) {
  const main = element();
  const fields = element();
  fields.hidden = true;
  const input = element();
  const copyButton = element();
  const status = element();
  const media = element();
  media.matches = mobile;
  const requests = [];
  const shares = [];
  const copies = [];
  const timers = new Map();
  let timerId = 0;
  let userGesture = false;
  const navigator = {};
  if (share !== false) navigator.share = (data) => {
    assert.equal(userGesture, true, "Sharing must run during the fresh tap");
    shares.push(data);
    return share ? share(data) : Promise.resolve();
  };
  if (copy !== false) navigator.clipboard = { writeText(value) {
    assert.equal(userGesture, true, "Copying must run during the fresh tap");
    copies.push(value);
    return copy ? copy(value) : Promise.resolve();
  } };
  vm.runInNewContext(controller, {
    mobileDownloadCopyLink: main,
    mobileDownloadLinkFields: fields,
    mobileDownloadLink: input,
    mobileDownloadCopyReadyLink: copyButton,
    mobileDownloadStatus: status,
    mobileDownloadMedia: media,
    navigator, URL, AbortController,
    window: {
      setTimeout(callback, delay) { assert.equal(delay, 10_000); timers.set(++timerId, callback); return timerId; },
      clearTimeout(id) { timers.delete(id); },
    },
    async fetch(url, options) {
      requests.push({ url, options });
      assert.equal(url, "/api/send-download-links");
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), { handoffOnly: true });
      return fetchImpl ? fetchImpl(url, options) : { ok: true, json: async () => ({ handoffUrl }) };
    },
  });
  return {
    main, fields, input, copyButton, status, requests, shares, copies, timers,
    ready: () => new Promise(setImmediate),
    resize(matches) {
      media.matches = matches;
      media.listeners.change();
    },
    click(button = main) {
      userGesture = true;
      try { return button.listeners.click(); }
      finally { userGesture = false; }
    },
  };
}

test("prepares in the background, then the first tap opens native sharing without a link box", async () => {
  const f = fixture();
  assert.equal(f.requests.length, 1, "Prepare without a preliminary tap");
  assert.equal(f.main.disabled, true);
  await f.ready();
  assert.equal(f.fields.hidden, true);
  assert.equal(f.input.value, handoffUrl);
  assert.notEqual(f.main.attributes["aria-expanded"], "true");
  assert.equal(f.main.attributes["aria-busy"], "false");
  assert.equal(f.main.textContent, "Share link");
  assert.equal(f.status.textContent, "");
  assert.equal(f.shares.length, 0);
  assert.equal(f.copies.length, 0);
  assert.equal(f.timers.size, 0);
  await f.click();
  assert.equal(f.fields.hidden, true);
  assert.equal(f.shares[0].url, handoffUrl);
  assert.equal(f.requests.length, 1);
  assert.equal(f.main.textContent, "Link shared");
  assert.equal(f.status.textContent, "");
  assert.equal(f.main.disabled, false);
});

test("a blocked Instagram-style share keeps the link available for a separate copy tap", async () => {
  const f = fixture({ share: () => Promise.reject({ name: "NotAllowedError" }) });
  await f.ready();
  await f.click();
  assert.match(f.status.textContent, /Sharing isn't available/);
  assert.equal(f.status.classes.has("is-error"), false);
  assert.equal(f.fields.hidden, false);
  assert.equal(f.copies.length, 0, "Do not try copying after share consumes activation");
  await f.click(f.copyButton);
  assert.deepEqual(f.copies, [handoffUrl]);
  assert.equal(f.copyButton.textContent, "Secure link copied");
  assert.equal(f.status.textContent, "");
  assert.equal(f.requests.length, 1);
});

test("cancelling sharing stays retryable without claiming a creation failure", async () => {
  let cancelled = true;
  const f = fixture({ share: () => cancelled ? Promise.reject({ name: "AbortError" }) : Promise.resolve() });
  await f.ready();
  await f.click();
  assert.equal(f.status.textContent, "");
  assert.equal(f.fields.hidden, true);
  assert.equal(f.copies.length, 0);
  assert.equal(f.main.textContent, "Share link");
  assert.equal(f.status.classes.has("is-error"), false);
  cancelled = false;
  await f.click();
  assert.equal(f.main.textContent, "Link shared");
  assert.equal(f.requests.length, 1);
});

test("without native sharing, the first tap copies without revealing a link box", async () => {
  const f = fixture({ share: false });
  await f.ready();
  assert.equal(f.main.textContent, "Copy link");
  assert.equal(f.fields.hidden, true);
  assert.equal(f.copies.length, 0);
  await f.click();
  assert.deepEqual(f.copies, [handoffUrl]);
  assert.equal(f.main.textContent, "Secure link copied");
  assert.equal(f.fields.hidden, true);
});

for (const copy of [false, () => Promise.reject({ name: "NotAllowedError" })]) {
  test(`clipboard ${copy === false ? "missing" : "blocked"} selects the real link for manual copying`, async () => {
    const f = fixture({ share: false, copy });
    await f.ready();
    await f.click();
    assert.equal(f.fields.hidden, false);
    assert.equal(f.copyButton.hidden, true);
    assert.equal(f.input.value, handoffUrl);
    assert.equal(f.input.focused, true);
    assert.equal(f.input.selected, true);
    assert.deepEqual(f.input.selection, [0, handoffUrl.length]);
    assert.match(f.status.textContent, /Touch and hold the link/);
    assert.equal(f.main.textContent, "Copy link");
    assert.equal(f.main.disabled, false);
    assert.equal(f.status.classes.has("is-error"), false);
  });
}

test("a failed creation can retry without exposing a bogus link", async () => {
  let fails = true;
  const f = fixture({ fetchImpl: async () => fails
    ? { ok: false, status: 503 }
    : { ok: true, json: async () => ({ handoffUrl }) } });
  await f.ready();
  assert.equal(f.fields.hidden, true);
  assert.equal(f.status.classes.has("is-error"), true);
  assert.match(f.status.textContent, /Could not create/);
  assert.equal(f.main.disabled, false);
  fails = false;
  await f.click();
  assert.equal(f.status.classes.has("is-error"), false);
  assert.equal(f.input.value, handoffUrl);
  assert.equal(f.fields.hidden, true);
  assert.equal(f.shares.length, 0, "A retry request must not share after awaiting the network");
  await f.click();
  assert.equal(f.shares[0].url, handoffUrl);
});

test("a stalled creation times out, releases the button, and does not act like share cancellation", async () => {
  const f = fixture({ fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject({ name: "AbortError" }));
  }) });
  assert.equal(f.main.disabled, true);
  await f.click();
  assert.equal(f.requests.length, 1, "Ignore duplicate taps while preparing");
  [...f.timers.values()][0]();
  await f.ready();
  assert.equal(f.main.disabled, false);
  assert.equal(f.fields.hidden, true);
  assert.match(f.status.textContent, /Could not create/);
  assert.equal(f.timers.size, 0);
});

test("malformed or non-handoff responses never reach sharing or the clipboard", async () => {
  for (const value of [undefined, "", "javascript:alert(1)", "https://example.com/?handoff=x",
    "https://sidestream.tv/api/download", `${handoffUrl}&email=person@example.com`, `${handoffUrl}&handoff=duplicate`]) {
    const f = fixture({ fetchImpl: async () => ({ ok: true, json: async () => ({ handoffUrl: value }) }) });
    await f.ready();
    assert.equal(f.fields.hidden, true);
    assert.equal(f.input.value, "");
    assert.equal(f.status.classes.has("is-error"), true);
    assert.equal(f.main.disabled, false);
    assert.equal(f.shares.length + f.copies.length, 0);
  }
});

test("a slow background request never shares automatically or opens a link box", async () => {
  let resolveResponse;
  const f = fixture({ fetchImpl: () => new Promise((resolve) => { resolveResponse = resolve; }) });
  assert.equal(f.main.disabled, true);
  await f.click();
  f.resize(true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.shares.length, 0);
  resolveResponse({ ok: true, json: async () => ({ handoffUrl }) });
  await f.ready();
  assert.equal(f.main.disabled, false);
  assert.equal(f.fields.hidden, true);
  assert.equal(f.shares.length, 0);
  await f.click();
  assert.equal(f.shares[0].url, handoffUrl);
});

test("desktop loads do not prepare a handoff, entering mobile width prepares only once", async () => {
  const f = fixture({ mobile: false });
  assert.equal(f.requests.length, 0);
  f.resize(true);
  await f.ready();
  assert.equal(f.requests.length, 1);
  f.resize(false);
  f.resize(true);
  assert.equal(f.requests.length, 1);
  await f.click();
  assert.equal(f.shares[0].url, handoffUrl);
  assert.equal(f.fields.hidden, true);
});

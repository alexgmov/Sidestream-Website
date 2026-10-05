import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createControlServer, validateChange } from "../ops/release-control/server.mjs";

const key = "test-owner-key-".padEnd(48, "x");
const digest = "a".repeat(64);
const change = { version: "1.0.21", artifactSha256: digest, expectedPercent: 50, rolloutPercent: 75 };
async function fixture(t, options = {}) {
  const server = createControlServer({ secret: key, fetchManifest: async () => ({ version: "1.0.21", artifact: { sha256: digest }, rolloutPercent: 50 }), applyChange: async () => {}, ...options });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, cookie = "", header = "1") => fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", "X-Sidestream-Rollout": header, Cookie: cookie }, body: JSON.stringify(body) });
  const login = async () => {
    const result = await post("/login", { key }); assert.equal(result.status, 200);
    const cookie = result.headers.get("set-cookie");
    assert.match(cookie, /Secure; HttpOnly; SameSite=Strict/);
    return cookie.split(";")[0];
  };
  const status = async (cookie) => (await fetch(base + "/status", { headers: { Cookie: cookie } })).json();
  const done = async (cookie) => {
    for (let i = 0; i < 50; i += 1) {
      const result = await status(cookie);
      if (result.job?.status !== "saving") return result.job;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Job did not complete");
  };
  return { post, login, status, done };
}

test("public dashboard cannot mutate or mint owner access without key and custom header", async (t) => {
  let applies = 0;
  const f = await fixture(t, { applyChange: async () => { applies += 1; } });
  assert.equal((await f.post("/save", change)).status, 401);
  assert.equal((await f.post("/login", { key }, "", "")).status, 403);
  assert.equal((await f.post("/login", { key: "wrong" })).status, 401);
  assert.equal((await f.status("")).authenticated, false);
  const cookie = await f.login();
  assert.equal((await f.post("/save", change, cookie.replace(/.$/, "z"))).status, 401);
  assert.equal(applies, 0);
});

test("authenticated Save reports success only after matching live version/digest/percentage", async (t) => {
  let percent = 50;
  const f = await fixture(t, { fetchManifest: async () => ({ version: "1.0.21", artifact: { sha256: digest }, rolloutPercent: percent }), applyChange: async (input) => { assert.deepEqual(input, change); percent = input.rolloutPercent; } });
  const cookie = await f.login();
  assert.equal((await f.post("/save", change, cookie)).status, 202);
  assert.equal((await f.done(cookie)).status, "saved");
  assert.equal(percent, 75);
});

test("a stale browser cannot overwrite a newer release or rollout", async (t) => {
  let applies = 0;
  const f = await fixture(t, { fetchManifest: async () => ({ version: "1.0.22", artifact: { sha256: digest }, rolloutPercent: 50 }), applyChange: async () => { applies += 1; } });
  const cookie = await f.login();
  await f.post("/save", change, cookie);
  assert.equal((await f.done(cookie)).status, "failed");
  assert.equal(applies, 0);
});

test("saving the current percentage verifies without publication or mutation", async (t) => {
  let applies = 0;
  const f = await fixture(t, { applyChange: async () => { applies += 1; } });
  const cookie = await f.login();
  await f.post("/save", { ...change, rolloutPercent: 50 }, cookie);
  assert.equal((await f.done(cookie)).status, "saved");
  assert.equal(applies, 0);
});

test("busy saves are rejected and apply failures never show success", async (t) => {
  let fail;
  const f = await fixture(t, { applyChange: () => new Promise((resolve, reject) => { fail = reject; }) });
  const cookie = await f.login();
  await f.post("/save", change, cookie);
  assert.equal((await f.post("/save", change, cookie)).status, 409);
  fail(new Error("private credential detail"));
  const result = await f.done(cookie);
  assert.equal(result.status, "failed");
  assert.doesNotMatch(result.error, /credential/);
});

test("invalid percentages, release identities, and injected fields are rejected", () => {
  for (const invalid of [NaN, 101, -1, 50.5, "75"]) assert.throws(() => validateChange({ ...change, rolloutPercent: invalid }));
  assert.throws(() => validateChange({ ...change, command: "anything" }));
  assert.throws(() => validateChange({ ...change, version: "main" }));
  assert.throws(() => validateChange({ ...change, artifactSha256: "bad" }));
  assert.equal(validateChange({ ...change, rolloutPercent: 0 }).rolloutPercent, 0);
  assert.equal(validateChange({ ...change, rolloutPercent: 100 }).rolloutPercent, 100);
});

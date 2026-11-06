import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { Pool } from "pg";
import { createRequest, createResponse, invokeHandler } from "./helpers/http.mjs";

// Starts a fresh loopback-only cluster, never loads .env or touches a runtime DB.
test("MCP browser connection, shared allowance, upgrade and revocation", { timeout: 120000 }, async t => {
  const pg = await startPostgres();
  const db = new Pool({ connectionString: pg.url, ssl: false });
  let runtime;
  const previous = { ...process.env };
  try {
    for (const name of (await readdir(new URL("../db/migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort()) {
      await db.query(await readFile(new URL(`../db/migrations/${name}`, import.meta.url), "utf8"));
    }
    for (const key of Object.keys(process.env)) {
      if (/^(SIDESTREAM_.*POSTGRES|POSTGRES_|SIDESTREAM_.*HOSTS|VERCEL_|STRIPE_|SIDESTREAM_.*STRIPE)/.test(key)) delete process.env[key];
    }
    Object.assign(process.env, {
      SIDESTREAM_TEST_POSTGRES_URL: pg.url, POSTGRES_URL: pg.url,
      SIDESTREAM_LICENSE_NAMESPACE: "test", SIDESTREAM_TEST_API_HOSTS: "mcp.test.invalid",
      SIDESTREAM_BASE_URL: "https://mcp.test.invalid", VERCEL_ENV: "test", NODE_ENV: "test",
      SIDESTREAM_MCP_ENABLED: "1", SIDESTREAM_DOWNLOAD_CREDITS_ENABLED: "1", SIDESTREAM_DOWNLOAD_REFERRALS_MODE: "off",
      SIDESTREAM_LICENSE_HASH_SECRET: "mcp-disposable-test-secret-with-at-least-32-characters",
      SIDESTREAM_RATE_LIMIT_HASH_SECRET: "mcp-disposable-ratelimit-secret-with-at-least-32-characters",
      SIDESTREAM_DEVICE_POLICY_MODE: "enforce",
    });
    const account = await import("../.server-dist/api/_lib/account.js");
    const postgres = await import("../.server-dist/api/_lib/postgres.js");
    runtime = postgres.getPostgresPool();
    const { handleMcpRequest } = await import("../.server-dist/api/_lib/mcp.js");
    const security = await import("../.server-dist/api/_lib/mcp-security.js");
    const credits = await import("../.server-dist/api/_lib/download-credits.js");
    const { resolveLicenseEnvironment } = await import("../.server-dist/api/_lib/license-environment.js");
    const env = resolveLicenseEnvironment({ serverEnv: process.env, trustedRequestHost: "mcp.test.invalid" });
    assert.ok(env);
    const headers = { host: "mcp.test.invalid", origin: "https://mcp.test.invalid", "content-type": "application/json" };
    async function call(action, body, options = {}) {
      return (await invokeHandler((req, res) => handleMcpRequest(action, req, res), {
        method: options.method || "POST", url: options.url || `/api/mcp/${action}`, body,
        headers: { ...headers, ...(options.cookie ? { cookie: options.cookie } : {}),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...options.headers },
      })).response;
    }
    async function user(name) {
      const id = await account.upsertGoogleAccount({ googleSub: `mcp-${name}-${randomUUID()}`, email: `${name}@example.invalid`, name, avatarUrl: "" });
      const response = createResponse();
      await account.createWebSession(createRequest({ headers }), response, id);
      return { id, cookie: response.getHeader("set-cookie")[0].split(";")[0], deviceId: `mcp-device-${randomUUID()}` };
    }
    async function start(person, deviceId = person.deviceId) {
      const response = await call("start", { deviceId, clientName: "Claude", platform: "macos", appVersion: "1.0.0" });
      assert.equal(response.statusCode, 200, response.body);
      return response.json;
    }
    async function approve(person, pairing) {
      const page = await call("authorize", undefined, { method: "GET", cookie: person.cookie, url: `/api/mcp/authorize?connection=${pairing.connectionId}` });
      assert.equal(page.statusCode, 200, page.body);
      const response = await call("authorize", { connectionId: pairing.connectionId, csrfToken: page.json.csrfToken, decision: "approve" }, { cookie: person.cookie });
      return response;
    }
    async function connect(person, deviceId = person.deviceId) {
      const pairing = await start(person, deviceId);
      const approved = await approve(person, pairing); assert.equal(approved.statusCode, 200, approved.body);
      const token = await call("token", { connectionId: pairing.connectionId, pollToken: pairing.pollToken });
      assert.equal(token.statusCode, 200, token.body);
      return { ...pairing, accessToken: token.json.accessToken, account: token.json.account, deviceId };
    }
    const job = (overrides = {}) => ({ requestId: randomUUID(), requestFingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
      formatType: "video", sourcePlatform: "youtube", ...overrides });
    async function reserve(connection, input) { return call("reserve", input, { token: connection.accessToken }); }
    async function finalize(connection, input, outcome = "committed") { return call("finalize", { requestId: input.requestId, outcome }, { token: connection.accessToken }); }
    async function state(connection) { return (await call("account", {}, { token: connection.accessToken })).json; }
    async function paid(person, plan = "pro_monthly") {
      const inserted = await db.query(`insert into public.sidestream_licenses
        (account_id,stripe_customer_id,stripe_subscription_id,plan_key,status,entitlement_status,features)
        values ($1,$2,$3,'sidestream_pro','active','active',$4) returning id`,
      [person.id, `cus_mcp_${randomBytes(6).toString("hex")}`, `sub_mcp_${randomBytes(6).toString("hex")}`, JSON.stringify({ purchase_plan: plan })]);
      return inserted.rows[0].id;
    }

    const alice = await user("mcp-alice");
    let connection;
    await t.test("browser consent, OAuth continuation, private polling and safe replay", async () => {
      const pairing = await start(alice);
      assert.match(pairing.connectUrl, /\/mcp.html\?connection=/);
      assert.ok(!pairing.connectUrl.includes(pairing.pollToken));
      const pending = await call("token", pairing); assert.equal(pending.json.status, "pending");
      const bad = await call("token", { ...pairing, pollToken: randomBytes(32).toString("base64url") }); assert.equal(bad.statusCode, 401);
      const signedOut = await call("authorize", undefined, { method: "GET", url: `/api/mcp/authorize?connection=${pairing.connectionId}` });
      assert.equal(signedOut.statusCode, 401); assert.match(signedOut.json.signInUrl, /api\/auth\/google\/start\?next=/);
      const entitlement = await import("../.server-dist/api/_lib/entitlement.js");
      assert.equal(entitlement.sanitizeAccountNextPath(`/mcp.html?connection=${pairing.connectionId}`), `/mcp.html?connection=${pairing.connectionId}`);
      assert.equal(entitlement.sanitizeAccountNextPath(`/mcp.html?connection=${pairing.connectionId}&next=https://bad.invalid`), "/account.html");
      const page = await call("authorize", undefined, { method: "GET", cookie: alice.cookie, url: `/api/mcp/authorize?connection=${pairing.connectionId}` });
      const confirmation = { connectionId: pairing.connectionId, csrfToken: page.json.csrfToken, decision: "approve" };
      assert.equal((await call("authorize", confirmation, { cookie: alice.cookie, headers: { origin: "https://bad.invalid" } })).statusCode, 403);
      assert.equal((await call("authorize", { ...confirmation, csrfToken: "bad" }, { cookie: alice.cookie })).statusCode, 403);
      const approved = await call("authorize", confirmation, { cookie: alice.cookie });
      assert.equal(approved.json.status, "connected", approved.body); assert.doesNotMatch(approved.body, /accessToken|pollToken|walletId/);
      const result = await call("token", pairing); const replay = await call("token", pairing);
      assert.equal(result.json.accessToken, replay.json.accessToken);
      connection = { ...pairing, accessToken: result.json.accessToken, deviceId: alice.deviceId };
      assert.equal(result.json.account.remainingDownloads, 10);
      assert.equal(result.json.account.upgrade.plans.pro_monthly.formattedPrice, "$9.99");
      assert.equal(result.json.account.upgrade.plans.unlimited_one_time.formattedPrice, "$39.99");
      assert.equal((await approve(alice, pairing)).json.account.remainingDownloads, 10);
      const stranger = await user("mcp-stranger");
      assert.equal((await call("authorize", undefined, {method:"GET",cookie:stranger.cookie,url:`/api/mcp/authorize?connection=${pairing.connectionId}`})).statusCode, 409);
      const theft = await start(stranger, alice.deviceId); assert.equal((await approve(stranger, theft)).json.code, "installation_already_linked");
    });

    await t.test("concurrent jobs, failed download refunds, exact idempotency and shared panel wallet", async () => {
      const first = job();
      assert.equal((await reserve(connection, first)).json.allowed, true);
      assert.equal((await reserve(connection, first)).json.account.remainingDownloads, 9);
      assert.equal((await reserve(connection, { ...first, requestFingerprint: "a".repeat(64) })).json.code, "request_conflict");
      assert.equal((await finalize(connection, first, "released")).json.account.remainingDownloads, 10);
      assert.equal((await finalize(connection, first, "released")).json.status, "released");
      assert.equal((await reserve(connection, first)).json.code, "reservation_finalized");
      const jobs = Array.from({ length: 11 }, () => job());
      const reservations = await Promise.all(jobs.map(j => reserve(connection, j)));
      assert.equal(reservations.filter(r => r.json.allowed).length, 10);
      assert.equal(reservations.find(r => !r.json.allowed).json.code, "downloads_in_progress");
      for (let i = 0; i < jobs.length; i++) if (reservations[i].json.allowed) {
        assert.equal((await finalize(connection, jobs[i])).json.status, "committed");
      }
      const denied = await reserve(connection, job());
      assert.equal(denied.json.code, "upgrade_required"); assert.equal(denied.json.account.remainingDownloads, 0);
      assert.equal((await credits.synchronizeDownloadCredits({ deviceId: alice.deviceId, environment: env })).balance, 0);
      assert.equal((await connect(alice)).account.remainingDownloads, 0);
      const secondDevice = await connect(alice, `mcp-second-${randomUUID()}`);
      assert.equal(secondDevice.account.remainingDownloads, 0);
      assert.equal((await credits.synchronizeDownloadCredits({ deviceId: secondDevice.deviceId, environment: env })).balance, 0);
      assert.equal((await db.query("select count(*)::int as count from public.sidestream_credit_wallets where account_id=$1", [alice.id])).rows[0].count, 1);
    });

    await t.test("upgrade route remains bound to the connected account and capabilities refresh without reconnect", async () => {
      const url = new URL((await state(connection)).upgrade.url);
      const unsigned = await call("upgrade", undefined, { method: "GET", url: url.pathname + url.search });
      assert.equal(unsigned.statusCode, 303); assert.match(unsigned.getHeader("location"), /auth\/google\/start/);
      const outsider = await user("mcp-outsider");
      const wrongAccount=await call("upgrade", undefined, { method: "GET", url: url.pathname + url.search, cookie: outsider.cookie });
      assert.equal(wrongAccount.statusCode,409); assert.match(wrongAccount.getHeader("content-type"),/text\/html/);
      assert.match(wrongAccount.body,/Use another account/); assert.match(wrongAccount.body,/prompt=select_account/);
      const upgrade = await call("upgrade", undefined, { method: "GET", url: url.pathname + url.search, cookie: alice.cookie });
      assert.equal(upgrade.statusCode, 303);
      const activation = new URL(upgrade.getHeader("location")).searchParams.get("activation");
      const activationRow = (await db.query("select account_id,device_id_hash from public.sidestream_activation_sessions where activation_key=$1", [activation])).rows[0];
      assert.equal(activationRow.account_id, alice.id); assert.equal(activationRow.device_id_hash, account.hashPrivateIdentifier(alice.deviceId));
      assert.equal((await call("upgrade", undefined, { method: "GET", url: url.pathname + url.search, cookie: alice.cookie })).getHeader("location"), upgrade.getHeader("location"));
      const licenseId = await paid(alice);
      const upgraded = await state(connection); assert.equal(upgraded.plan, "pro_monthly"); assert.equal(upgraded.remainingDownloads, null);
      assert.equal(upgraded.maxVideoHeight, 2160); assert.equal(upgraded.socialDownloads, false);
      const video = job({ requestedHeight: 2160 }); assert.equal((await reserve(connection, video)).json.allowed, true);
      assert.equal((await finalize(connection, video)).json.status, "committed");
      assert.equal((await reserve(connection, job({ sourcePlatform: "instagram" }))).json.code, "social_upgrade_required");
      await db.query("update public.sidestream_licenses set features=$2 where id=$1", [licenseId, JSON.stringify({ purchase_plan: "unlimited_one_time" })]);
      const socialJob = job({ sourcePlatform: "instagram" }); assert.equal((await reserve(connection, socialJob)).json.allowed, true);
      await finalize(connection, socialJob);
      await db.query("update public.sidestream_licenses set features='{}' where id=$1", [licenseId]);
      assert.equal((await state(connection)).plan, "legacy_paid");
      await db.query("update public.sidestream_licenses set entitlement_status='revoked' where id=$1", [licenseId]);
      assert.equal((await reserve(connection, job())).json.code, "upgrade_required");
    });

    await t.test("Free quality ceiling, generic public sources, expiration and cancellation", async () => {
      const free = await connect(await user("mcp-free"));
      assert.equal((await reserve(free, job({ requestedHeight: 2160 }))).json.code, "quality_upgrade_required");
      const other = job({ sourcePlatform: "other", requestedHeight: 720 });
      assert.equal((await reserve(free, other)).json.policy.maxVideoHeight, 1080);
      await finalize(free, other, "released");
      const expiring = job(); await reserve(free, expiring);
      await db.query("update public.sidestream_mcp_downloads set expires_at=now()-interval '1 second' where request_id=$1", [expiring.requestId]);
      await db.query("update public.sidestream_credit_reservations set reserved_at=now()-interval '8 days',expires_at=now()-interval '1 second' where reservation_key=$1", [`credit-${expiring.requestId.replace(/-/g, "")}`]);
      assert.equal((await finalize(free, expiring)).json.status, "expired");
      assert.equal((await state(free)).remainingDownloads, 10);
      const pending = await start(await user("mcp-expired"));
      await db.query("update public.sidestream_mcp_connections set pairing_expires_at=now()-interval '1 second' where connection_key=$1", [pending.connectionId]);
      assert.equal((await call("token", pending)).statusCode, 410);
    });

    await t.test("anonymous installation history is preserved once without another starter grant", async () => {
      const person = await user("mcp-existing-wallet");
      async function anonymousUses(deviceId, count) {
        await credits.synchronizeDownloadCredits({ deviceId, environment: env });
        for (let i=0;i<count;i++) {
          const reservationKey=`credit-${randomUUID().replace(/-/g,"")}`;
          await credits.reserveDownloadCredits({deviceId,environment:env,reservationKey,formatType:"video"});
          await credits.finalizeDownloadCredits({deviceId,environment:env,reservationKey,outcome:"committed"});
        }
      }
      await anonymousUses(person.deviceId,3);
      const first=await connect(person); assert.equal(first.account.remainingDownloads,7);
      const anotherDevice=`mcp-used-${randomUUID()}`; await anonymousUses(anotherDevice,4);
      const second=await connect(person,anotherDevice); assert.equal(second.account.remainingDownloads,3);
      assert.equal((await connect(person,anotherDevice)).account.remainingDownloads,3);
      assert.equal((await credits.synchronizeDownloadCredits({deviceId:anotherDevice,environment:env})).balance,300);
      const holding=job(); await reserve(first,holding);
      const busyDevice=`mcp-busy-${randomUUID()}`; await anonymousUses(busyDevice,1);
      const pairing=await start(person,busyDevice);
      assert.equal((await approve(person,pairing)).json.code,"downloads_in_progress");
      await finalize(first,holding,"released");
      assert.equal((await approve(person,pairing)).json.account.remainingDownloads,2);
    });

    await t.test("existing Free connection registers paid device only after upgrade and respects capacity", async () => {
      const person=await user("mcp-free-upgrade");
      const one=await connect(person), two=await connect(person,`mcp-free2-${randomUUID()}`), three=await connect(person,`mcp-free3-${randomUUID()}`);
      assert.equal((await db.query("select count(*)::int as count from public.sidestream_account_devices where account_id=$1",[person.id])).rows[0].count,0);
      await paid(person);
      const j1=job(),j2=job(); assert.equal((await reserve(one,j1)).json.allowed,true); assert.equal((await reserve(two,j2)).json.allowed,true);
      assert.equal((await reserve(three,job())).json.code,"transfer_required");
      await db.query("update public.sidestream_account_devices set revoked_at=now(),revocation_reason='deactivated' where account_id=$1 and device_id_hash=$2",[person.id,account.hashPrivateIdentifier(person.deviceId)]);
      assert.equal((await reserve(three,job())).json.allowed,true);
      assert.equal((await finalize(one,j1)).json.status,"committed");
    });

    await t.test("MCP and referral connections preserve reciprocal account ownership on secondary devices", async () => {
      process.env.SIDESTREAM_DOWNLOAD_REFERRALS_MODE="active";
      try {
        const referrals=await import("../.server-dist/api/_lib/download-referrals.js");
        async function referralConnect(person,deviceId) {
          await credits.synchronizeDownloadCredits({deviceId,environment:env});
          const pending=await referrals.startReferralConnection(env,deviceId);
          await referrals.completeReferralConnection(env,pending.browserKey,person.id);
          return pending.connectionToken;
        }
        const owner=await user("mcp-referral-owner"), stranger=await user("mcp-referral-stranger");
        await referralConnect(owner,owner.deviceId);
        const referralSecond=`referral-second-${randomUUID()}`;
        await referralConnect(owner,referralSecond);
        const attempted=await start(stranger,referralSecond);
        assert.equal((await approve(stranger,attempted)).json.code,"installation_already_linked");
        const accepted=await connect(owner,referralSecond);
        assert.equal(accepted.account.remainingDownloads,10);
        const mcpOwner=await user("mcp-first-owner"), mcpStranger=await user("mcp-first-stranger");
        await connect(mcpOwner);
        const mcpSecond=`mcp-second-linked-${randomUUID()}`;
        const mcpConnected=await connect(mcpOwner,mcpSecond);
        await assert.rejects(referralConnect(mcpStranger,mcpSecond),error=>error.code==="installation_already_linked");
        const referralToken=await referralConnect(mcpOwner,mcpSecond);
        const download=job(); await reserve(mcpConnected,download); await finalize(mcpConnected,download);
        assert.equal((await credits.synchronizeDownloadCredits({deviceId:mcpSecond,environment:env,referralToken})).balance,900);
        process.env.SIDESTREAM_MCP_ENABLED="0";
        assert.equal((await credits.synchronizeDownloadCredits({deviceId:mcpSecond,environment:env})).balance,900);
        await assert.rejects(referralConnect(mcpStranger,mcpSecond),error=>error.code==="installation_already_linked");
        process.env.SIDESTREAM_MCP_ENABLED="1";
      } finally { process.env.SIDESTREAM_DOWNLOAD_REFERRALS_MODE="off"; process.env.SIDESTREAM_MCP_ENABLED="1"; }
    });

    await t.test("paid device capacity, same device reuse and later revocation", async () => {
      const person = await user("mcp-paid"); await paid(person);
      const one = await connect(person); const two = await connect(person, `mcp-second-paid-${randomUUID()}`);
      const same = await connect(person); assert.equal(same.account.plan, "pro_monthly");
      const third = await start(person, `mcp-third-paid-${randomUUID()}`);
      assert.equal((await approve(person, third)).json.code, "transfer_required");
      await db.query("update public.sidestream_account_devices set revoked_at=now(),revocation_reason='deactivated' where account_id=$1 and device_id_hash=$2 and revoked_at is null", [person.id, account.hashPrivateIdentifier(person.deviceId)]);
      assert.equal((await reserve(one, job())).json.code, "device_deactivated");
      assert.equal((await reserve(two, job())).json.allowed, true);
    });

    await t.test("website and MCP disconnect block new work but permit exact admitted-job settlement", async () => {
      const person = await user("mcp-revoke"); const original = await connect(person); const sibling = await connect(person);
      const first = job(), second = job(); await reserve(original, first); await reserve(sibling, second);
      const list = await call("connections", undefined, { method: "GET", cookie: person.cookie });
      assert.equal(list.json.connections.length, 2); assert.doesNotMatch(list.body, /token_hash|accessToken|pollToken|device_id_hash/);
      assert.equal((await call("connections", { connectionId: original.connectionId, csrfToken: list.json.csrfToken }, { cookie: person.cookie })).json.revoked, true);
      assert.equal((await reserve(original, job())).json.code, "reconnect_required");
      assert.equal((await call("account", {}, { token: original.accessToken })).statusCode, 401);
      assert.equal((await finalize(original, second)).json.code, "reservation_not_found");
      const settled = await finalize(original, first); assert.equal(settled.json.status, "committed");
      assert.equal(settled.json.reconnectRequired, true); assert.equal(settled.json.account, undefined);
      assert.equal((await call("revoke", {}, { token: sibling.accessToken })).json.revoked, true);
      assert.equal((await reserve(sibling, job())).statusCode, 401);
    });

    await t.test("expired credentials can settle only their own admitted jobs without renewing access",async()=>{
      const person=await user("mcp-expiry-settle"), expired=await connect(person), sibling=await connect(person);
      const own=job(),other=job(); await reserve(expired,own); await reserve(sibling,other);
      await db.query("update public.sidestream_mcp_connections set token_expires_at=now()-interval '1 second' where connection_key=$1",[expired.connectionId]);
      assert.equal((await reserve(expired,job())).statusCode,401);
      assert.equal((await call("account",{},{token:expired.accessToken})).statusCode,401);
      assert.equal((await finalize(expired,other)).json.code,"reservation_not_found");
      const result=await finalize(expired,own,"released"); assert.equal(result.json.status,"released");
      assert.equal(result.json.reconnectRequired,true); assert.equal(result.json.account,undefined);
      assert.equal((await state(sibling)).remainingDownloads,9);
    });

    await t.test("bounds, feature gates, CSRF expiry and namespace isolation", async () => {
      assert.equal((await call("start", { deviceId: "x".repeat(241) })).statusCode, 400);
      assert.equal((await call("start", " ".repeat(16385))).statusCode, 413);
      assert.equal((await call("start", { deviceId: "x" }, { headers: { host: "wrong.invalid" } })).statusCode, 503);
      const csrf = security.mcpCsrf(alice.id, "connections", 1700000000000);
      assert.equal(security.validMcpCsrf(csrf, alice.id, "connections", 1700000601000), false);
      process.env.SIDESTREAM_MCP_ENABLED = "0"; assert.equal((await call("account", {}, { token: connection.accessToken })).json.code, "mcp_unavailable");
      process.env.SIDESTREAM_MCP_ENABLED = "1";
    });
  } finally {
    if (runtime) await runtime.end();
    await db.end(); await pg.stop();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

async function startPostgres() {
  const root = await mkdtemp(join(tmpdir(), "sidestream-mcp-test-"));
  const data = join(root, "data"), log = join(root, "postgres.log");
  const binary = async name => {
    for (const base of [...(process.env.PATH || "").split(":"), "/opt/homebrew/bin"]) {
      const path = join(base, name); try { await access(path); return path; } catch {}
    }
    throw new Error(`${name} is required for disposable MCP database tests`);
  };
  const initdb = await binary("initdb"), pgCtl = await binary("pg_ctl");
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  try {
    execFileSync(initdb, ["-D", data, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--no-locale", "--no-sync"], { stdio: "pipe" });
    execFileSync(pgCtl, ["-D", data, "-l", log, "-o", `-F -p ${port} -h 127.0.0.1 -k ${root}`, "-w", "-t", "20", "start"], { stdio: "pipe" });
  } catch (error) {
    await rm(root, { recursive: true, force: true }); throw error;
  }
  return { url: `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`, async stop() {
    try { execFileSync(pgCtl, ["-D", data, "-w", "-t", "20", "-m", "immediate", "stop"], { stdio: "pipe" }); }
    finally { await rm(root, { recursive: true, force: true }); }
  } };
}

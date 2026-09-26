import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { createRequire } from "node:module";
import { Pool } from "pg";
import { loadMigrationFiles, migrationSqlForTransaction, validateMigrationFiles } from "../scripts/apply-postgres-migrations.mjs";
import { createTestPoolOptions, requireSafeTestDatabaseUrl } from "../scripts/run-postgres-integration.mjs";
import { createRequest, createResponse, invokeHandler } from "./helpers/http.mjs";

// The runner never loads env files or a runtime DB. It creates and drops its own
// database on the explicitly selected disposable localhost Postgres endpoint.
test("v30 download friend rewards: HTTP + durable PostgreSQL acceptance", { timeout: 90000 }, async (t) => {
  const adminUrl = requireSafeTestDatabaseUrl();
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(new URL(adminUrl).hostname), "use a disposable local endpoint");
  const databaseName = `codex_referrals_${randomBytes(8).toString("hex")}`;
  const admin = new Pool(createTestPoolOptions(adminUrl));
  const target = new URL(adminUrl); target.pathname = `/${databaseName}`;
  await admin.query(`create database ${databaseName}`);
  const db = new Pool(createTestPoolOptions(target.href));
  let runtimePool;
  try {
    for (const migration of validateMigrationFiles(await loadMigrationFiles())) {
      const client = await db.connect();
      try { await client.query("begin"); await client.query(migrationSqlForTransaction(migration.sql)); await client.query("commit"); }
      catch (error) { await client.query("rollback"); throw new Error(`${migration.filename}: ${error.message}`); }
      finally { client.release(); }
    }
    Object.assign(process.env, {
      SIDESTREAM_TEST_POSTGRES_URL: target.href, POSTGRES_URL: target.href,
      SIDESTREAM_LICENSE_NAMESPACE: "test", SIDESTREAM_TEST_API_HOSTS: "referrals.test.invalid",
      SIDESTREAM_BASE_URL: "https://referrals.test.invalid", VERCEL_ENV: "test", NODE_ENV: "test",
      SIDESTREAM_DOWNLOAD_REFERRALS_MODE: "active", SIDESTREAM_DOWNLOAD_CREDITS_ENABLED: "1",
      SIDESTREAM_LICENSE_HASH_SECRET: "disposable-referral-test-secret-32-characters",
      SIDESTREAM_RATE_LIMIT_HASH_SECRET: "disposable-rate-limit-test-secret-32-characters",
    });
    const account = await import("../.server-dist/api/_lib/account.js");
    const referrals = await import("../.server-dist/api/_lib/download-referrals.js");
    const credit = await import("../.server-dist/api/_lib/download-credits.js");
    const environmentLib = await import("../.server-dist/api/_lib/license-environment.js");
    const entitlement = await import("../.server-dist/api/_lib/entitlement.js");
    const env = environmentLib.resolveLicenseEnvironment({ serverEnv: process.env, trustedRequestHost: "referrals.test.invalid" });
    assert.ok(env);
    runtimePool = referrals.referralPool(env);
    const statusHandler = (await import("../.server-dist/api/download-referrals.js")).default;
    const inviteHandler = (await import("../.server-dist/api/download-referrals/invite.js")).default;
    const claimHandler = (await import("../.server-dist/api/download-referrals/claim.js")).default;
    const connectHandler = (await import("../.server-dist/api/download-referrals/connect.js")).default;
    const syncHandler = (await import("../.server-dist/api/credits/sync.js")).default;
    const reserveHandler = (await import("../.server-dist/api/credits/reserve.js")).default;
    const finalizeHandler = (await import("../.server-dist/api/credits/finalize.js")).default;
    const headers = { host: "referrals.test.invalid", origin: "https://referrals.test.invalid", "content-type": "application/json" };
    async function call(handler, body, { method = "POST", url = "/", cookie, host } = {}) {
      return (await invokeHandler(handler, { method, url, body, headers: { ...headers, ...(cookie ? { cookie } : {}), ...(host ? { host } : {}) } })).response;
    }
    async function user(label) {
      const id = await account.upsertGoogleAccount({ googleSub: `fixture-${label}-${randomBytes(5).toString("hex")}`, email: `${label}@example.invalid`, name: label, avatarUrl: "" });
      const res = createResponse();
      await account.createWebSession(createRequest({ headers }), res, id);
      const cookie = res.getHeader("set-cookie")[0].split(";")[0];
      return { id, deviceId: `fixture-device-${label}`, cookie };
    }
    async function connect(person) {
      const wallet = await call(syncHandler, { deviceId: person.deviceId }); assert.equal(wallet.statusCode, 200, wallet.body);
      const started = await call(statusHandler, { action: "connect", deviceId: person.deviceId }); assert.equal(started.statusCode, 200);
      person.referralToken = started.json.connectionToken;
      const browser = new URL(started.json.connectUrl);
      const res = await call(connectHandler, {}, { url: browser.pathname + browser.search, cookie: person.cookie });
      assert.equal(res.statusCode, 200, res.body);
      const status = await call(statusHandler, { action: "status", deviceId: person.deviceId, referralToken: person.referralToken });
      assert.equal(status.json.state, "connected"); person.invitationUrl = status.json.invitationUrl;
      return person;
    }
    async function visit(inviter) {
      const code = new URL(inviter.invitationUrl).pathname.split("/").pop();
      const res = await call(inviteHandler, undefined, { method: "GET", url: `/api/download-referrals/invite?code=${code}` });
      assert.equal(res.statusCode, 303, res.body);
      return res.getHeader("location");
    }
    function payload(person, extra = {}) { return { deviceId: person.deviceId, referralToken: person.referralToken, ...extra }; }
    const key = () => `credit-${randomBytes(24).toString("hex")}`;
    const grants = async () => (await db.query("select * from public.sidestream_download_referral_grants order by granted_at, role")).rows;
    const inviter = await connect(await user("inviter"));
    const claimUrl = await visit(inviter);
    const friend = await user("friend");

    await t.test("invitation survives OAuth return path, claim needs explicit authenticated same-origin POST, no purchase", async () => {
      assert.equal(entitlement.sanitizeAccountNextPath(claimUrl), claimUrl);
      assert.equal(entitlement.sanitizeAccountNextPath(`${claimUrl}&next=https://evil.invalid`), "/account.html");
      const unsigned = await call(claimHandler, undefined, { method: "GET", url: claimUrl });
      assert.equal(unsigned.statusCode, 303); assert.match(unsigned.getHeader("location"), /^\/api\/auth\/google\/start\?next=/);
      assert.doesNotMatch(unsigned.getHeader("location"), /checkout/);
      const revisit = await call(inviteHandler, undefined, { method: "GET", url: `/api/download-referrals/invite?code=${new URL(inviter.invitationUrl).pathname.split("/").pop()}`,
        cookie: `__Host-sidestream-download-invitation=${new URL(claimUrl, "https://referrals.test.invalid").searchParams.get("visit")}` });
      assert.equal(revisit.getHeader("location"), claimUrl, "OAuth/account creation retries retain the original first visit");
      const page = await call(claimHandler, undefined, { method: "GET", url: claimUrl, cookie: friend.cookie });
      assert.equal(page.statusCode, 200); assert.match(page.body, /No purchase needed/);
      assert.equal((await grants()).length, 0);
      const csrf = await invokeHandler(claimHandler, { method: "POST", url: claimUrl, body: {}, headers: { ...headers, origin: "https://evil.invalid", cookie: friend.cookie } });
      assert.equal(csrf.response.statusCode, 403);
      const concurrentClaims = await Promise.all(Array.from({ length: 3 }, () => call(claimHandler, {}, { url: claimUrl, cookie: friend.cookie })));
      assert.deepEqual(concurrentClaims.map(r => r.statusCode).sort(), [200, 409, 409]);
      assert.equal(concurrentClaims.find(r => r.statusCode === 200).json.state, "awaiting_first_download");
      const replay = await call(claimHandler, {}, { url: claimUrl, cookie: friend.cookie });
      assert.equal(replay.statusCode, 409);
      assert.equal(replay.json.code, "claim_already_used");
      const other = await user("replay-attacker");
      assert.equal((await call(claimHandler, {}, { url: claimUrl, cookie: other.cookie })).json.code, "claim_already_used");
      await connect(friend);
      assert.equal((await grants()).length, 0);
    });
    await t.test("self-referral and old accounts/installations are rejected", async () => {
      const selfUrl = await visit(inviter);
      assert.equal((await call(claimHandler, {}, { url: selfUrl, cookie: inviter.cookie })).json.code, "self_referral");
      const old = await user("old");
      const oldUrl = await visit(inviter);
      assert.equal((await call(claimHandler, {}, { url: oldUrl, cookie: old.cookie })).json.code, "recipient_not_new");
      const deviceId = "old-install-new-account";
      await call(syncHandler, { deviceId });
      const newUrl = await visit(inviter);
      const newPerson = await user("old-install"); newPerson.deviceId = deviceId;
      assert.equal((await call(claimHandler, {}, { url: newUrl, cookie: newPerson.cookie })).statusCode, 200);
      const start = await call(statusHandler, { action: "connect", deviceId });
      const u = new URL(start.json.connectUrl);
      assert.equal((await call(connectHandler, {}, { url: u.pathname + u.search, cookie: newPerson.cookie })).json.code, "recipient_not_new");
    });
    await t.test("started, cancelled and failed downloads never grant rewards", async () => {
      for (const outcome of ["released", "released"]) {
        const reservationKey = key();
        assert.equal((await call(reserveHandler, payload(friend, { reservationKey, formatType: "video" }))).json.allowed, true);
        assert.equal((await grants()).length, 0);
        assert.equal((await call(finalizeHandler, payload(friend, { reservationKey, outcome }))).json.reservationStatus, "released");
        await call(finalizeHandler, payload(friend, { reservationKey, outcome: "committed" }));
      }
      const unknown = await call(finalizeHandler, payload(friend, { reservationKey: key(), outcome: "committed" }));
      assert.equal(unknown.json.found, false);
      assert.equal((await grants()).length, 0);
      assert.equal((await call(syncHandler, payload(friend))).json.availableCredits, 1000);
    });
    let firstExpiry;
    await t.test("two isolated users receive exactly one grant each under concurrent reserve/finalize retries", async () => {
      const reservationKey = key();
      const reserves = await Promise.all(Array.from({ length: 8 }, () => call(reserveHandler, payload(friend, { reservationKey, formatType: "audio" }))));
      assert.ok(reserves.every(r => r.statusCode === 200 && r.json.allowed));
      assert.equal((await grants()).length, 0);
      const missingToken = await call(finalizeHandler, { deviceId: friend.deviceId, reservationKey, outcome: "committed" });
      assert.equal(missingToken.statusCode, 401);
      const completed = await Promise.all(Array.from({ length: 10 }, () => call(finalizeHandler, payload(friend, { reservationKey, outcome: "committed" }))));
      assert.ok(completed.every(r => r.statusCode === 200 && r.json.reservationStatus === "committed"));
      assert.equal((await grants()).length, 2);
      for (const person of [inviter, friend]) {
        const fresh = await call(statusHandler, payload(person, { action: "status" }));
        assert.equal(fresh.json.reward.active, true);
        const days = (Date.parse(fresh.json.reward.expiresAt) - Date.now()) / 86400000;
        assert.ok(days > 29.99 && days <= 30);
        if (person === inviter) firstExpiry = fresh.json.reward.expiresAt;
        assert.equal(fresh.json.invitationUrl, person.invitationUrl);
      }
      assert.equal((await call(syncHandler, payload(friend))).json.availableCredits, 900);
      assert.equal((await call(claimHandler, {}, { url: claimUrl, cookie: friend.cookie })).json.code, "already_qualified");
    });
    await t.test("active rewards consume zero Free credits; refresh and reinstall preserve the original wallet", async () => {
      const reservationKey = key();
      const reserve = await call(reserveHandler, payload(friend, { reservationKey, formatType: "video" }));
      assert.equal(reserve.json.creditCost, 0);
      await call(finalizeHandler, payload(friend, { reservationKey, outcome: "committed" }));
      assert.equal((await call(syncHandler, payload(friend))).json.availableCredits, 900);
      const expiredKey = key();
      await call(reserveHandler, payload(friend, { reservationKey: expiredKey, formatType: "video" }));
      await db.query("update public.sidestream_download_referral_downloads set expires_at = now() - interval '1 second' where reservation_key = $1", [expiredKey]);
      assert.equal((await call(finalizeHandler, payload(friend, { reservationKey: expiredKey, outcome: "committed" }))).json.reservationStatus, "expired");
      const reinstalled = { ...friend, deviceId: "friend-reinstalled-device" };
      await connect(reinstalled);
      assert.equal((await call(syncHandler, payload(reinstalled))).json.availableCredits, 900);
      assert.equal(reinstalled.invitationUrl, friend.invitationUrl);
      assert.equal((await grants()).length, 2);
      const cannotTakeDevice = await user("cannot-take-device"); cannotTakeDevice.deviceId = friend.deviceId;
      const attempt = await call(statusHandler, { action: "connect", deviceId: friend.deviceId });
      const u = new URL(attempt.json.connectUrl);
      assert.equal((await call(connectHandler, {}, { url: u.pathname + u.search, cookie: cannotTakeDevice.cookie })).json.code, "installation_already_linked");
    });
    await t.test("a second qualifying friend stacks 30 days and a partial grant failure rolls the whole finalization back", async () => {
      const secondUrl = await visit(inviter); const second = await user("second");
      assert.equal((await call(claimHandler, {}, { url: secondUrl, cookie: second.cookie })).statusCode, 200);
      await connect(second); const reservationKey = key();
      await call(reserveHandler, payload(second, { reservationKey, formatType: "video" }));
      await db.query(`create function public.fixture_grant_failure() returns trigger language plpgsql as $$ begin if NEW.role = 'recipient' then raise exception 'fixture failure'; end if; return NEW; end $$;
        create trigger fixture_fail before insert on public.sidestream_download_referral_grants for each row execute function public.fixture_grant_failure()`);
      const failed = await call(finalizeHandler, payload(second, { reservationKey, outcome: "committed" }));
      assert.equal(failed.statusCode, 503);
      assert.equal((await grants()).length, 2);
      assert.equal((await call(statusHandler, payload(inviter, { action: "status" }))).json.reward.expiresAt, firstExpiry);
      await db.query("drop trigger fixture_fail on public.sidestream_download_referral_grants; drop function public.fixture_grant_failure()");
      const secondKey = key();
      await call(reserveHandler, payload(second, { reservationKey: secondKey, formatType: "audio" }));
      const twoSuccesses = await Promise.all([reservationKey, secondKey].map(k => call(finalizeHandler, payload(second, { reservationKey: k, outcome: "committed" }))));
      assert.ok(twoSuccesses.every(r => r.statusCode === 200));
      const next = (await call(statusHandler, payload(inviter, { action: "status" }))).json.reward.expiresAt;
      assert.equal(Date.parse(next) - Date.parse(firstExpiry), 30 * 86400000);
      assert.equal((await grants()).length, 4);
    });
    await t.test("expiration resumes the existing Free balance; paid access is independent", async () => {
      await db.query("update public.sidestream_download_referral_members set reward_expires_at = now() - interval '1 second' where account_id = $1", [friend.id]);
      const fresh = await call(statusHandler, payload(friend, { action: "status" })); assert.equal(fresh.json.reward.active, false);
      const reserve = await call(reserveHandler, payload(friend, { reservationKey: key(), formatType: "video" }));
      assert.equal(reserve.json.creditCost, 100); assert.equal(reserve.json.availableCredits, 800);
      const license = (await db.query(`insert into public.sidestream_licenses
        (account_id, stripe_customer_id, stripe_subscription_id, plan_key, status, entitlement_status)
        values ($1, 'cus_referral_fixture', 'sub_referral_fixture', 'sidestream_unlimited', 'active', 'active') returning id`, [friend.id])).rows[0];
      await db.query(`insert into public.sidestream_account_devices (account_id, license_namespace, device_id_hash, platform)
        values ($1, 'test', $2, 'macos')`, [friend.id, account.hashPrivateIdentifier(friend.deviceId)]);
      const paidToken = randomBytes(32).toString("base64url");
      await db.query(`insert into public.sidestream_license_tokens
        (account_id, license_id, device_id_hash, token_hash, expires_at, refresh_token_hash, refresh_expires_at)
        values ($1, $2, $3, $4, now() + interval '1 hour', $5, now() + interval '30 days')`,
      [friend.id, license.id, account.hashPrivateIdentifier(friend.deviceId), createHash("sha256").update(paidToken).digest("hex"), randomBytes(32).toString("hex")]);
      const paidBefore = (await db.query("select * from public.sidestream_licenses where id = $1", [license.id])).rows[0];
      assert.equal((await account.authorizeLicenseDownload({ environment: env, deviceId: friend.deviceId, licenseToken: paidToken })).active, true);
      const paidKey = key();
      const paid = await call(reserveHandler, payload(friend, { reservationKey: paidKey, formatType: "video", licenseToken: paidToken }));
      assert.equal(paid.json.creditCost, 0); assert.equal(paid.json.availableCredits, 800);
      await call(finalizeHandler, payload(friend, { reservationKey: paidKey, outcome: "committed" }));
      assert.equal((await grants()).length, 4);
      assert.deepEqual((await db.query("select * from public.sidestream_licenses where id = $1", [license.id])).rows[0], paidBefore);
      assert.equal((await account.getSession(createRequest({ headers: { ...headers, cookie: friend.cookie } }))).license.active, true);
      const spoof = await call(reserveHandler, payload(friend, { reservationKey: key(), formatType: "audio", paidAuthorized: true }));
      assert.equal(spoof.json.creditCost, 100);
    });
    if (process.env.SIDESTREAM_REFERRAL_CLIENT_PATH) await t.test("the actual extension client reloads both isolated users from server credentials and observes access/expiry", async () => {
      const clientModule = createRequire(import.meta.url)(process.env.SIDESTREAM_REFERRAL_CLIENT_PATH);
      for (const person of [inviter, friend]) {
        const store = new Map();
        store.set("sidestream.downloadReferrals.v1:test:https://referrals.test.invalid", JSON.stringify({ deviceId: person.deviceId, token: person.referralToken, connected: true }));
        const options = { origin: "https://referrals.test.invalid", namespace: "test", deviceId: person.deviceId,
          storage: { getItem: k => store.get(k), setItem: (k, v) => store.set(k, v) },
          setTimeout: () => 1, clearTimeout: () => {}, openBrowser: () => {},
          request: async body => { const result = await call(statusHandler, body); assert.equal(result.statusCode, 200); return result.json; } };
        for (let launch = 0; launch < 2; launch++) {
          const client = clientModule.create(options);
          assert.equal(client.active(), false, "cached credential alone never establishes access");
          const status = await client.refresh();
          assert.equal(client.active(), person === inviter);
          assert.ok(status.reward.expiresAt); assert.equal(status.invitationUrl, person.invitationUrl);
          client.stop();
        }
      }
    });
    await t.test("namespace, credentials, paused rollout and grant immutability fail closed", async () => {
      const wrongHost = await call(statusHandler, payload(friend, { action: "status", buildChannel: "production" }), { host: "sidestream.tv" });
      assert.equal(wrongHost.statusCode, 503);
      await assert.rejects(referrals.getReferralStatus({ ...env, namespace: "production" }, friend.deviceId, friend.referralToken), /referral_reconnect_required/);
      const swapped = await call(statusHandler, { action: "status", deviceId: inviter.deviceId, referralToken: friend.referralToken });
      assert.equal(swapped.statusCode, 401);
      const sameDB = environmentLib.resolveLicenseEnvironment({ serverEnv: { ...process.env, SIDESTREAM_POSTGRES_URL: target.href }, trustedRequestHost: "referrals.test.invalid" });
      assert.equal(sameDB, null);
      process.env.SIDESTREAM_DOWNLOAD_REFERRALS_MODE = "paused";
      assert.equal((await call(statusHandler, payload(inviter, { action: "status" }))).json.reward.active, true);
      assert.equal((await call(statusHandler, { action: "connect", deviceId: inviter.deviceId })).statusCode, 200);
      assert.equal((await call(reserveHandler, payload(inviter, { reservationKey: key(), formatType: "video" }))).json.creditCost, 0);
      await assert.rejects(db.query("delete from public.sidestream_download_referral_grants"), /append-only/);
      process.env.SIDESTREAM_DOWNLOAD_REFERRALS_MODE = "active";
      const rls = await db.query("select relrowsecurity from pg_class where relname like 'sidestream_download_referral_%' and relkind = 'r'");
      assert.ok(rls.rows.length === 7 && rls.rows.every(r => r.relrowsecurity));
      for (let n = 0; n < 30; n++) assert.equal((await call(statusHandler, { action: "connect", deviceId: "rate-limit-fixture" })).statusCode, 200);
      const limited = await call(statusHandler, { action: "connect", deviceId: "rate-limit-fixture" });
      assert.equal(limited.statusCode, 429); assert.ok(Number(limited.getHeader("retry-after")) > 0);
    });
  } finally {
    if (runtimePool) await runtimePool.end();
    await db.end();
    await admin.query(`drop database ${databaseName} with (force)`);
    await admin.end();
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadInjectedModule } from "./helpers/handler-loader.mjs";
import { invokeHandler } from "./helpers/http.mjs";

const repositoryRoot = new URL("..", import.meta.url);

test("annual renewal email states exact price, billing date, cancellation, and paid-through access", async () => {
  const reminder = await loadReminderModule();
  const renewalAt = "2027-08-25T14:00:00.000Z";
  const message = reminder.createAnnualRenewalReminderMessage({
    email: "Annual.Customer@example.com",
    renewalAt,
    environment: {},
  });
  for (const phrase of [
    "$19.99",
    "advance reminder",
    "cancel anytime",
    "will not be charged again",
    "access will continue through your already-paid year",
    "/account.html",
  ]) {
    assert.match(message.text, new RegExp(escapeRegExp(phrase), "i"), phrase);
  }
  assert.deepEqual(message.to, ["annual.customer@example.com"]);
  assert.equal(
    message.subject,
    "Reminder: Sidestream will renew for $19.99 on August 25, 2027",
  );
  assert.match(message.html, /Manage or cancel your plan/);

  const stableKey = reminder.createAnnualRenewalReminderIdempotencyKey({
    stripeSubscriptionId: "sub_annual",
    renewalAt,
  });
  assert.equal(
    stableKey,
    reminder.createAnnualRenewalReminderIdempotencyKey({
      stripeSubscriptionId: "sub_annual",
      renewalAt,
    }),
  );
  assert.notEqual(
    stableKey,
    reminder.createAnnualRenewalReminderIdempotencyKey({
      stripeSubscriptionId: "sub_annual",
      renewalAt: "2028-08-25T14:00:00.000Z",
    }),
  );
});

test("annual renewal provider request preserves one idempotency key across retries", async () => {
  const reminder = await loadReminderModule();
  const requests = [];
  const row = {
    id: "00000000-0000-4000-8000-000000000001",
    email: "customer@example.com",
    stripe_subscription_id: "sub_annual",
    renewal_at: "2027-08-25T14:00:00.000Z",
    attempt_count: 1,
  };
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: "email_provider_ref" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await reminder.sendAnnualRenewalReminder({
    row,
    environment: { RESEND_API_KEY: "test_resend_key" },
    fetchImpl,
  });
  await reminder.sendAnnualRenewalReminder({
    row: { ...row, attempt_count: 2 },
    environment: { RESEND_API_KEY: "test_resend_key" },
    fetchImpl,
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://api.resend.com/emails");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Authorization, "Bearer test_resend_key");
  assert.equal(
    requests[0].init.headers["Idempotency-Key"],
    requests[1].init.headers["Idempotency-Key"],
  );
  const payload = JSON.parse(requests[0].init.body);
  assert.equal(payload.subject, "Reminder: Sidestream will renew for $19.99 on August 25, 2027");
  assert.doesNotMatch(requests[0].init.body, /sub_annual/);
});

test("reminder staging is exact to active v2 annual subscriptions and cancels stale jobs", async () => {
  const source = await readFile(
    new URL("api/_lib/annual-renewal-reminder.ts", repositoryRoot),
    "utf8",
  );
  for (const marker of [
    "intent.upgrade_pricing_snapshot_version = 2",
    "intent.upgrade_pricing_experiment_id = 'upgrade-pricing-v2'",
    "intent.upgrade_pricing_variant = 'annual_same_price'",
    "license.cancel_at_period_end is false",
    "license.current_period_end <= now() + interval '30 days'",
    "license.current_period_end > now() + interval '7 days'",
    "unique (stripe_subscription_id, renewal_at)",
  ]) {
    if (marker.startsWith("unique")) continue;
    assert.match(source, new RegExp(escapeRegExp(marker)), marker);
  }
  assert.match(source, /email_job_state = 'canceled'/);
  assert.match(source, /for update of reminder skip locked/);
  const migration = await readFile(
    new URL("db/migrations/20260825140000_add_annual_upgrade_pricing_experiment.sql", repositoryRoot),
    "utf8",
  );
  assert.match(migration, /unique \(stripe_subscription_id, renewal_at\)/);
});

test("annual renewal cron is GET-only, bearer-protected, no-store, and scheduled", async () => {
  const [route, vercel] = await Promise.all([
    readFile(new URL("api/internal/annual-renewal-reminders.ts", repositoryRoot), "utf8"),
    readFile(new URL("vercel.json", repositoryRoot), "utf8"),
  ]);
  assert.match(route, /toUpperCase\(\) !== "GET"/);
  assert.match(route, /Bearer \$\{secret\}/);
  assert.match(route, /timingSafeEqual/);
  assert.match(route, /SIDESTREAM_ANNUAL_RENEWAL_REMINDERS_ENABLED/);
  assert.match(route, /outcome: "disabled"/);
  assert.match(route, /Cache-Control", "no-store"/);
  assert.match(vercel, /\/api\/internal\/annual-renewal-reminders/);
  assert.match(vercel, /"schedule": "17 \*\/6 \* \* \*"/);
});

test("annual renewal cron is authenticated but does no database or email work while disabled", async () => {
  let runs = 0;
  const route = await loadInjectedModule(
    new URL("api/internal/annual-renewal-reminders.ts", repositoryRoot),
    {
      "../_lib/annual-renewal-reminder.js": {
        runAnnualRenewalReminders: async () => {
          runs += 1;
          throw new Error("disabled job must not run");
        },
      },
    },
  );
  const handler = route.createAnnualRenewalReminderHandler({
    getCronSecret: () => "annual-reminder-test-secret",
    isEnabled: () => false,
    log: () => {},
  });
  const result = await invokeHandler(handler, {
    method: "GET",
    url: "/api/internal/annual-renewal-reminders",
    headers: { authorization: "Bearer annual-reminder-test-secret" },
  });
  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(result.response.json, { ok: true, outcome: "disabled" });
  assert.equal(runs, 0);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadReminderModule() {
  return loadInjectedModule(
    new URL("api/_lib/annual-renewal-reminder.ts", repositoryRoot),
    {
      "./postgres.js": {
        queryPostgres: async () => ({ rowCount: 0, rows: [] }),
        withPostgresTransaction: async (callback) => callback({
          query: async () => ({ rowCount: 0, rows: [] }),
        }),
      },
    },
  );
}

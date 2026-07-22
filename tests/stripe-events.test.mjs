import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const baseMigrationPath = join(
  repositoryRoot,
  "db/migrations/20260703120000_add_sidestream_accounts_billing.sql",
);
const queueMigrationPath = join(
  repositoryRoot,
  "db/migrations/20260713202000_harden_stripe_event_processing.sql",
);
const retirementMigrationPath = join(
  repositoryRoot,
  "db/migrations/20260722120000_retire_customer_360.sql",
);

test("Stripe events use a durable claimed queue with bounded retry and protected drains", {
  timeout: 120_000,
}, async (t) => {
  const environmentSnapshot = snapshotEnvironment([
    "SIDESTREAM_POSTGRES_URL",
    "SIDESTREAM_POSTGRES_PRISMA_URL",
    "SIDESTREAM_POSTGRES_URL_NON_POOLING",
    "SIDESTREAM_TEST_POSTGRES_URL",
    "POSTGRES_URL",
    "POSTGRES_PRISMA_URL",
    "POSTGRES_URL_NON_POOLING",
    "SIDESTREAM_LICENSE_NAMESPACE",
    "SIDESTREAM_TEST_API_HOSTS",
    "VERCEL_ENV",
    "POSTGRES_SSL",
    "POSTGRES_POOL_MAX",
  ]);
  const runtime = await loadRuntimeModules();
  const postgres = await startEphemeralPostgres();
  configureAccountRuntime(postgres.connectionString);
  const accountRuntime = await loadAccountRuntime(runtime.directory);
  runtime.account = accountRuntime.account;
  runtime.accountPostgres = accountRuntime.accountPostgres;
  const pool = new Pool({
    connectionString: postgres.connectionString,
    max: 12,
    ssl: false,
  });
  const query = (text, params = []) => pool.query(text, [...params]);

  try {
    await pool.query(await readFile(baseMigrationPath, "utf8"));
    await pool.query(await readFile(queueMigrationPath, "utf8"));
    await pool.query(await readFile(retirementMigrationPath, "utf8"));

    await t.test("migration models every state and exposes a partial pending index", async () => {
      const columns = await pool.query(
        `
          select column_name
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'sidestream_stripe_events'
        `,
      );
      const names = new Set(columns.rows.map((row) => row.column_name));
      for (const name of [
        "stripe_created_at",
        "processing_status",
        "attempt_count",
        "claim_token",
        "lease_expires_at",
        "next_attempt_at",
        "last_error_code",
        "outcome",
        "processing_duration_ms",
        "terminal_at",
      ]) {
        assert.ok(names.has(name), `missing queue column ${name}`);
      }

      const index = await pool.query(
        `
          select indexdef
          from pg_indexes
          where schemaname = 'public'
            and indexname = 'sidestream_stripe_events_pending_idx'
        `,
      );
      assert.equal(index.rows.length, 1);
      assert.match(index.rows[0].indexdef, /WHERE \(\(terminal_at IS NULL\)/);
      assert.match(index.rows[0].indexdef, /processing_status = ANY/);

      const licenseColumns = await pool.query(
        `
          select column_name
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'sidestream_licenses'
            and column_name like 'stripe_state_event_%'
        `,
      );
      assert.deepEqual(
        licenseColumns.rows.map((row) => row.column_name).sort(),
        ["stripe_state_event_created_at", "stripe_state_event_id"],
      );
    });

    await t.test("signed-event persistence is insert-only and preserves Stripe creation time", async () => {
      await resetEvents(pool);
      const original = stripeEvent("evt_durable", "test.original", 1_700_000_123);
      assert.equal(
        await runtime.stripeEvents.recordStripeEvent(original, "raw-original", query),
        true,
      );
      assert.equal(
        await runtime.stripeEvents.recordStripeEvent(
          { ...original, type: "test.overwrite" },
          "raw-overwrite",
          query,
        ),
        false,
      );

      const stored = await pool.query(
        `
          select event_type, extract(epoch from stripe_created_at)::bigint as stripe_created,
            raw_payload, processing_status, attempt_count
          from public.sidestream_stripe_events
          where event_id = $1
        `,
        [original.id],
      );
      assert.deepEqual(stored.rows[0], {
        event_type: "test.original",
        stripe_created: "1700000123",
        raw_payload: "raw-original",
        processing_status: "received",
        attempt_count: 0,
      });
    });

    await t.test("parallel claimers receive disjoint bounded batches", async () => {
      await resetEvents(pool);
      for (let index = 0; index < 6; index += 1) {
        const event = stripeEvent(`evt_claim_${index}`, "test.claim", 1_700_001_000 + index);
        await runtime.stripeEvents.recordStripeEvent(event, JSON.stringify(event), query);
      }

      const [first, second] = await Promise.all([
        runtime.stripeEvents.claimStripeEvents({
          batchSize: 3,
          claimToken: "00000000-0000-4000-8000-000000000001",
          query,
        }),
        runtime.stripeEvents.claimStripeEvents({
          batchSize: 3,
          claimToken: "00000000-0000-4000-8000-000000000002",
          query,
        }),
      ]);
      assert.equal(first.length, 3);
      assert.equal(second.length, 3);
      const firstIds = new Set(first.map((row) => row.eventId));
      const secondIds = new Set(second.map((row) => row.eventId));
      assert.equal([...firstIds].some((id) => secondIds.has(id)), false);
      assert.equal(new Set([...firstIds, ...secondIds]).size, 6);

      const states = await pool.query(
        `
          select processing_status, attempt_count, count(*)::int as count
          from public.sidestream_stripe_events
          group by processing_status, attempt_count
        `,
      );
      assert.deepEqual(states.rows, [{
        processing_status: "processing",
        attempt_count: 1,
        count: 6,
      }]);
    });

    await t.test("expired leases are reclaimed with a new token and attempt", async () => {
      await resetEvents(pool);
      const event = stripeEvent("evt_expired_lease", "test.lease", 1_700_002_000);
      await runtime.stripeEvents.recordStripeEvent(event, JSON.stringify(event), query);
      await pool.query(
        `
          update public.sidestream_stripe_events
          set processing_status = 'processing',
              attempt_count = 2,
              claim_token = '00000000-0000-4000-8000-000000000003',
              lease_expires_at = now() - interval '1 minute'
          where event_id = $1
        `,
        [event.id],
      );

      const claimed = await runtime.stripeEvents.claimStripeEvents({
        batchSize: 1,
        claimToken: "00000000-0000-4000-8000-000000000004",
        query,
      });
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0].attemptCount, 3);
      assert.equal(claimed[0].claimToken, "00000000-0000-4000-8000-000000000004");
    });

    await t.test("a poison event retries without blocking ignored or processed rows", async () => {
      await resetEvents(pool);
      const events = [
        stripeEvent("evt_poison", "test.poison", 1_700_003_000),
        stripeEvent("evt_unsupported", "test.unsupported", 1_700_003_001),
        stripeEvent("evt_later", "test.later", 1_700_003_002),
      ];
      for (const event of events) {
        await runtime.stripeEvents.recordStripeEvent(event, JSON.stringify(event), query);
      }
      const logs = [];
      let clock = 10_000;
      const summary = await runtime.stripeEvents.drainStripeEventQueue({
        batchSize: 3,
        claimToken: undefined,
        createClaimToken: () => "00000000-0000-4000-8000-000000000005",
        query,
        now: () => {
          clock += 7;
          return clock;
        },
        random: () => 0,
        log: (entry) => logs.push(entry),
        processEvent: async (event) => {
          if (event.id === "evt_poison") {
            const error = new Error("must never be persisted or logged");
            error.code = "temporary_gateway";
            throw error;
          }
          if (event.id === "evt_unsupported") {
            return { status: "ignored", outcome: "unsupported_event_type" };
          }
          return { status: "processed", outcome: "fulfilled" };
        },
      });
      assert.deepEqual(summary, {
        claimed: 3,
        processed: 1,
        ignored: 1,
        retryable: 1,
        deadLetter: 0,
      });

      const rows = await pool.query(
        `
          select event_id, processing_status, last_error_code, outcome,
            processing_duration_ms, terminal_at is not null as terminal
          from public.sidestream_stripe_events
          order by event_id
        `,
      );
      assert.deepEqual(rows.rows, [
        {
          event_id: "evt_later",
          processing_status: "processed",
          last_error_code: null,
          outcome: "fulfilled",
          processing_duration_ms: 7,
          terminal: true,
        },
        {
          event_id: "evt_poison",
          processing_status: "retryable",
          last_error_code: "temporary_gateway",
          outcome: "retry_scheduled",
          processing_duration_ms: 7,
          terminal: false,
        },
        {
          event_id: "evt_unsupported",
          processing_status: "ignored",
          last_error_code: null,
          outcome: "unsupported_event_type",
          processing_duration_ms: 7,
          terminal: true,
        },
      ]);
      assert.equal(logs.length, 3);
      for (const entry of logs) {
        assert.deepEqual(Object.keys(entry), [
          "eventId",
          "eventType",
          "attempt",
          "outcome",
          "durationMs",
        ]);
        assert.doesNotMatch(JSON.stringify(entry), /payload|email|token|secret|must never/);
      }
    });

    await t.test("attempt exhaustion dead-letters one row and retry jitter stays capped", async () => {
      await resetEvents(pool);
      const event = stripeEvent("evt_dead_letter", "test.poison", 1_700_004_000);
      await runtime.stripeEvents.recordStripeEvent(event, JSON.stringify(event), query);
      await pool.query(
        `update public.sidestream_stripe_events set attempt_count = 7 where event_id = $1`,
        [event.id],
      );
      const summary = await runtime.stripeEvents.drainStripeEventQueue({
        batchSize: 1,
        maxAttempts: 8,
        createClaimToken: () => "00000000-0000-4000-8000-000000000006",
        query,
        log: () => {},
        processEvent: async () => {
          const error = new Error("poison");
          error.code = "invalid_object";
          throw error;
        },
      });
      assert.equal(summary.deadLetter, 1);
      const stored = await pool.query(
        `
          select processing_status, attempt_count, last_error_code, outcome,
            terminal_at is not null as terminal, processed_at
          from public.sidestream_stripe_events
          where event_id = $1
        `,
        [event.id],
      );
      assert.deepEqual(stored.rows[0], {
        processing_status: "dead_letter",
        attempt_count: 8,
        last_error_code: "invalid_object",
        outcome: "dead_letter",
        terminal: true,
        processed_at: null,
      });

      assert.equal(runtime.stripeEvents.computeStripeEventRetryDelayMs(1, () => 0), 2_500);
      assert.equal(
        runtime.stripeEvents.computeStripeEventRetryDelayMs(20, () => 1),
        runtime.stripeEvents.STRIPE_EVENT_RETRY_CAP_MS,
      );
    });

    await t.test("projection-only money events terminate as unsupported", async () => {
      await resetEvents(pool);
      const retiredRelations = await pool.query(
        `select to_regclass('public.sidestream_customer_profiles') as profiles,
           to_regclass('public.sidestream_customer_commerce_materializations') as commerce,
           to_regclass('public.sidestream_customer_money_totals') as totals`,
      );
      assert.deepEqual(retiredRelations.rows[0], {
        profiles: null,
        commerce: null,
        totals: null,
      });

      const events = [
        stripeEvent("evt_charge_only", "charge.succeeded", 1_700_004_500),
        stripeEvent("evt_invoice_only", "invoice.created", 1_700_004_501),
        stripeEvent("evt_refund_only", "charge.refund.updated", 1_700_004_502),
      ];
      for (const event of events) {
        await runtime.stripeEvents.recordStripeEvent(event, JSON.stringify(event), query);
      }
      assert.deepEqual(await runtime.stripeEvents.drainStripeEventQueue({
        batchSize: 3,
        createClaimToken: () => "00000000-0000-4000-8000-000000000007",
        query,
        log: () => {},
      }), {
        claimed: 3,
        processed: 0,
        ignored: 3,
        retryable: 0,
        deadLetter: 0,
      });
      assert.deepEqual((await pool.query(
        `select event_id, processing_status, outcome
         from public.sidestream_stripe_events
         order by event_id`,
      )).rows, [
        {
          event_id: "evt_charge_only",
          processing_status: "ignored",
          outcome: "unsupported_event_type",
        },
        {
          event_id: "evt_invoice_only",
          processing_status: "ignored",
          outcome: "unsupported_event_type",
        },
        {
          event_id: "evt_refund_only",
          processing_status: "ignored",
          outcome: "unsupported_event_type",
        },
      ]);
    });

    await t.test("refund and dispute events return inherited lifecycle outcomes", async () => {
      const cases = [
        {
          event: stripeEvent("evt_full_refund", "charge.refunded", 1_700_004_550),
          result: { fulfilled: true, applied: true, entitlementStatus: "revoked" },
          expected: { status: "processed", outcome: "lifecycle_revoked" },
        },
        {
          event: stripeEvent("evt_dispute_open", "charge.dispute.created", 1_700_004_551),
          result: { fulfilled: true, applied: true, entitlementStatus: "suspended" },
          expected: { status: "processed", outcome: "lifecycle_suspended" },
        },
        {
          event: stripeEvent("evt_dispute_stale", "charge.dispute.updated", 1_700_004_552),
          result: { fulfilled: true, applied: false, entitlementStatus: "suspended" },
          expected: { status: "processed", outcome: "lifecycle_stale_noop" },
        },
        {
          event: stripeEvent("evt_refund_missing", "refund.updated", 1_700_004_553),
          result: { fulfilled: false, reason: "missing_license" },
          expected: { status: "ignored", outcome: "lifecycle_missing_license" },
        },
      ];
      for (const scenario of cases) {
        runtime.stub.reset();
        runtime.stub.setLifecycleResult(scenario.result);
        assert.deepEqual(
          await runtime.stripeEvents.reconcileStripeEvent(scenario.event),
          scenario.expected,
        );
        assert.deepEqual(runtime.stub.calls, [[
          "lifecycle",
          scenario.event.type,
          scenario.event.data.object,
          { eventId: scenario.event.id, created: scenario.event.created },
        ]]);
      }
    });

    await t.test("Checkout fulfillment terminates without the retired schema", async () => {
      await resetEvents(pool);
      runtime.stub.reset();
      runtime.stub.setCheckoutResult({ fulfilled: true, activationBound: true });
      const event = stripeEvent(
        "evt_checkout_without_c360",
        "checkout.session.completed",
        1_700_004_600,
        {
          id: "cs_checkout_without_c360",
          customer: "cus_checkout_without_c360",
          mode: "payment",
          payment_status: "paid",
          amount_total: 500,
          currency: "usd",
        },
      );
      await runtime.stripeEvents.recordStripeEvent(event, JSON.stringify(event), query);
      const noRetiredTableQuery = async (text, params = []) => {
        assert.doesNotMatch(text, /sidestream_customer_(?:profiles|identity_links|commerce|money)/);
        return query(text, params);
      };
      assert.deepEqual(await runtime.stripeEvents.drainStripeEventQueue({
        batchSize: 1,
        maxAttempts: 1,
        createClaimToken: () => "00000000-0000-4000-8000-000000000008",
        query: noRetiredTableQuery,
        log: () => {},
      }), {
        claimed: 1,
        processed: 1,
        ignored: 0,
        retryable: 0,
        deadLetter: 0,
      });
      assert.deepEqual(runtime.stub.calls, [[
        "checkout",
        event.data.object,
        { eventId: event.id, created: event.created },
      ]]);
      assert.deepEqual((await pool.query(
        `select processing_status, attempt_count, last_error_code, outcome,
           terminal_at is not null as terminal
         from public.sidestream_stripe_events where event_id = $1`,
        [event.id],
      )).rows[0], {
        processing_status: "processed",
        attempt_count: 1,
        last_error_code: null,
        outcome: "checkout_fulfilled_activation_bound",
        terminal: true,
      });
    });

    await t.test("trusted deployment namespace rejects signed livemode mismatch", async () => {
      runtime.stub.reset();
      await assert.rejects(
        runtime.stripeEvents.reconcileStripeEvent(
          {
            ...stripeEvent(
              "evt_live_mismatch",
              "checkout.session.completed",
              1_700_004_700,
              {
                id: "cs_live_mismatch",
                payment_status: "paid",
                amount_total: 100,
                currency: "usd",
              },
            ),
            livemode: true,
          },
        ),
        (error) => {
          assert.equal(error.code, "stripe_event_namespace_mismatch");
          return true;
        },
      );
      assert.deepEqual(runtime.stub.calls, []);
    });

    await t.test("unresolved trusted deployment state blocks entitlement", async () => {
      const states = [
        {
          name: "incomplete",
          serverEnv: { SIDESTREAM_LICENSE_NAMESPACE: "test" },
        },
        {
          name: "contradictory",
          serverEnv: {
            SIDESTREAM_LICENSE_NAMESPACE: "test",
            VERCEL_ENV: "production",
            SIDESTREAM_TEST_API_HOSTS: "test.sidestream.invalid",
            SIDESTREAM_TEST_POSTGRES_URL:
              "postgresql://postgres@127.0.0.1:55439/sidestream_test",
            SIDESTREAM_POSTGRES_URL:
              "postgresql://postgres@127.0.0.1:55439/sidestream_production_sentinel",
          },
        },
      ];
      for (const state of states) {
        runtime.stub.reset();
        await assert.rejects(
          runtime.stripeEvents.reconcileStripeEvent(
            stripeEvent(
              `evt_environment_${state.name}`,
              "checkout.session.completed",
              1_700_004_800,
              {
                id: `cs_environment_${state.name}`,
                mode: "payment",
                payment_status: "paid",
                amount_total: 100,
                currency: "usd",
                metadata: { sidestream_plan: "sidestream_pro" },
              },
            ),
            state.serverEnv,
          ),
          (error) => {
            assert.equal(error.code, "license_environment_unresolved");
            return true;
          },
          state.name,
        );
        assert.deepEqual(runtime.stub.calls, [], state.name);
      }
    });

    await t.test("subscription reconciliation uses canonical Stripe truth and event ordering", async () => {
      runtime.stub.reset();
      const canonical = {
        id: "sub_canonical",
        customer: "cus_canonical",
        status: "canceled",
        items: { data: [] },
      };
      runtime.stub.setStripeClient({
        subscriptions: {
          async retrieve(subscriptionId) {
            runtime.stub.calls.push(["retrieve", subscriptionId]);
            return canonical;
          },
        },
      });
      const event = stripeEvent(
        "evt_subscription_order",
        "customer.subscription.updated",
        1_700_005_000,
        { id: "sub_canonical", status: "active" },
      );
      const result = await runtime.stripeEvents.reconcileStripeEvent(event);
      assert.deepEqual(result, {
        status: "processed",
        outcome: "subscription_reconciled",
      });
      assert.deepEqual(runtime.stub.calls, [
        ["retrieve", "sub_canonical"],
        ["subscription", canonical, undefined, {
          eventId: event.id,
          created: event.created,
        }],
      ]);

      assert.deepEqual(
        await runtime.stripeEvents.reconcileStripeEvent(
          stripeEvent("evt_unknown", "invoice.created", 1_700_005_001),
        ),
        { status: "ignored", outcome: "unsupported_event_type" },
      );
    });

    await t.test("subscription writes reject older Stripe timestamps", async () => {
      const account = await pool.query(
        `
          insert into public.sidestream_accounts (google_sub, email)
          values ('stripe-ordering-test', 'stripe-ordering@example.com')
          returning id
        `,
      );
      const accountId = account.rows[0].id;
      const subscription = (status) => ({
        id: "sub_ordering_guard",
        customer: "cus_ordering_guard",
        status,
        items: { data: [{ price: { lookup_key: "sidestream_pro" } }] },
      });

      assert.deepEqual(
        await runtime.account.upsertLicenseFromSubscription(
          subscription("canceled"),
          accountId,
          { eventId: "evt_order_new", created: 1_700_010_200 },
        ),
        { fulfilled: true, applied: true },
      );
      assert.deepEqual(
        await runtime.account.upsertLicenseFromSubscription(
          subscription("active"),
          accountId,
          { eventId: "evt_order_old", created: 1_700_010_100 },
        ),
        { fulfilled: true, applied: false, reason: "stale_event" },
      );
      let stored = await pool.query(
        `
          select status, extract(epoch from stripe_state_event_created_at)::bigint as event_created,
            stripe_state_event_id
          from public.sidestream_licenses
          where stripe_subscription_id = 'sub_ordering_guard'
        `,
      );
      assert.deepEqual(stored.rows[0], {
        status: "canceled",
        event_created: "1700010200",
        stripe_state_event_id: "evt_order_new",
      });

      assert.deepEqual(
        await runtime.account.upsertLicenseFromSubscription(
          subscription("active"),
          accountId,
          { eventId: "evt_order_newest", created: 1_700_010_300 },
        ),
        { fulfilled: true, applied: true },
      );
      assert.deepEqual(
        await runtime.account.upsertLicenseFromSubscription(
          subscription("trialing"),
          accountId,
        ),
        { fulfilled: true, applied: true },
      );
      stored = await pool.query(
        `
          select status, extract(epoch from stripe_state_event_created_at)::bigint as event_created,
            stripe_state_event_id
          from public.sidestream_licenses
          where stripe_subscription_id = 'sub_ordering_guard'
        `,
      );
      assert.deepEqual(stored.rows[0], {
        status: "trialing",
        event_created: "1700010300",
        stripe_state_event_id: "evt_order_newest",
      });
    });

    await t.test("webhook acknowledges after durable insert and never waits for its drain", async () => {
      const event = stripeEvent("evt_webhook", "invoice.created", 1_700_006_000);
      let releaseInsert;
      const insertGate = new Promise((resolve) => {
        releaseInsert = resolve;
      });
      let releaseDrain;
      const drainGate = new Promise((resolve) => {
        releaseDrain = resolve;
      });
      const scheduled = [];
      const calls = [];
      const handler = runtime.webhook.createStripeWebhookHandler({
        constructEvent: () => event,
        recordEvent: async () => {
          calls.push("insert-started");
          const inserted = await insertGate;
          calls.push("insert-finished");
          return inserted;
        },
        drainQueue: () => drainGate,
        scheduleBackground: (operation) => {
          calls.push("scheduled");
          scheduled.push(operation);
        },
        log: () => {},
      });
      const responsePromise = invokeHandler(handler, {
        method: "POST",
        headers: { "stripe-signature": "valid" },
        body: JSON.stringify(event),
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(calls, ["insert-started"]);
      releaseInsert(true);
      const response = await responsePromise;
      assert.equal(response.statusCode, 200);
      assert.deepEqual(JSON.parse(response.body), { received: true });
      assert.deepEqual(calls, ["insert-started", "insert-finished", "scheduled"]);
      assert.equal(scheduled.length, 1);
      releaseDrain({ claimed: 0, processed: 0, ignored: 0, retryable: 0, deadLetter: 0 });
      await scheduled[0];

      const duplicate = await invokeHandler(
        runtime.webhook.createStripeWebhookHandler({
          constructEvent: () => event,
          recordEvent: async () => false,
          drainQueue: async () => ({
            claimed: 0,
            processed: 0,
            ignored: 0,
            retryable: 0,
            deadLetter: 0,
          }),
          scheduleBackground: () => {},
          log: () => {},
        }),
        {
          method: "POST",
          headers: { "stripe-signature": "valid" },
          body: JSON.stringify(event),
        },
      );
      assert.equal(duplicate.statusCode, 200);
      assert.deepEqual(JSON.parse(duplicate.body), { received: true, duplicate: true });

      const invalid = await invokeHandler(
        runtime.webhook.createStripeWebhookHandler({
          constructEvent: () => {
            throw new Error("invalid signature");
          },
          recordEvent: async () => {
            throw new Error("must not insert");
          },
        }),
        {
          method: "POST",
          headers: { "stripe-signature": "invalid" },
          body: "{}",
        },
      );
      assert.equal(invalid.statusCode, 400);
      assert.deepEqual(JSON.parse(invalid.body), { error: "Invalid Stripe signature" });
    });

    await t.test("cron backstop requires the exact bearer secret", async () => {
      let drains = 0;
      const handler = runtime.processRoute.createStripeEventProcessHandler({
        getCronSecret: () => "cron-test-secret",
        drainQueue: async () => {
          drains += 1;
          return { claimed: 2, processed: 1, ignored: 1, retryable: 0, deadLetter: 0 };
        },
      });
      const unauthorized = await invokeHandler(handler, {
        method: "GET",
        headers: { authorization: "Bearer wrong" },
      });
      assert.equal(unauthorized.statusCode, 401);
      assert.equal(drains, 0);

      const authorized = await invokeHandler(handler, {
        method: "GET",
        headers: { authorization: "Bearer cron-test-secret" },
      });
      assert.equal(authorized.statusCode, 200);
      assert.deepEqual(JSON.parse(authorized.body), {
        ok: true,
        claimed: 2,
        processed: 1,
        ignored: 1,
        retryable: 0,
        deadLetter: 0,
      });
      assert.equal(drains, 1);

      const unavailable = await invokeHandler(
        runtime.processRoute.createStripeEventProcessHandler({
          getCronSecret: () => {
            throw new Error("missing");
          },
        }),
        { method: "GET", headers: {} },
      );
      assert.equal(unavailable.statusCode, 503);
    });

    await t.test("customer-facing reads contain no queue drain", async () => {
      const accountSource = await readFile(
        join(repositoryRoot, "api/_lib/account.ts"),
        "utf8",
      );
      const webhookSource = await readFile(
        join(repositoryRoot, "api/stripe/webhook.ts"),
        "utf8",
      );
      const queueSource = await readFile(
        join(repositoryRoot, "api/_lib/stripe-events.ts"),
        "utf8",
      );
      assert.doesNotMatch(accountSource, /processUnprocessedStripeEvents/);
      assert.doesNotMatch(webhookSource, /upsertLicenseFrom/);
      assert.match(webhookSource, /scheduleBackground\(backgroundDrain\)/);
      assert.match(queueSource, /for update skip locked/i);
      assert.match(queueSource, /stripe_created_at asc/);
      assert.match(queueSource, /subscriptions\.retrieve/);
    });
  } finally {
    if (runtime.accountPostgres) {
      await runtime.accountPostgres.getPostgresPool({
        connectionString: postgres.connectionString,
        environmentVariable: "SIDESTREAM_TEST_POSTGRES_URL",
        pooled: true,
      }).end().catch(() => {});
    }
    await pool.end().catch(() => {});
    await postgres.stop();
    await rm(runtime.directory, { recursive: true, force: true });
    restoreEnvironment(environmentSnapshot);
  }
});

function stripeEvent(id, type, created, object = { id: `object_${id}` }) {
  return {
    id,
    object: "event",
    api_version: "2026-06-30.basil",
    created,
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
  };
}

async function resetEvents(pool) {
  await pool.query("truncate table public.sidestream_stripe_events");
}

async function invokeHandler(handler, options) {
  const request = Readable.from(options.body ? [options.body] : []);
  request.method = options.method;
  request.url = options.url || "/";
  request.headers = options.headers || {};
  const headers = {};
  const response = {
    statusCode: 200,
    body: "",
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return headers[name.toLowerCase()];
    },
    end(value = "") {
      this.body = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
    },
  };
  await handler(request, response);
  return { statusCode: response.statusCode, headers, body: response.body };
}

async function loadRuntimeModules() {
  const directory = await mkdtemp(join(tmpdir(), "sidestream-stripe-events-modules-"));
  try {
    const stubPath = join(directory, "account-stub.mjs");
    await writeFile(stubPath, `
let stripeClient = null;
let subscriptionResult = { fulfilled: true, applied: true };
let checkoutResult = { fulfilled: true, activationBound: false };
let lifecycleResult = { fulfilled: true, applied: true, entitlementStatus: "active" };
export const calls = [];
export function reset() {
  calls.length = 0;
  stripeClient = null;
  subscriptionResult = { fulfilled: true, applied: true };
  checkoutResult = { fulfilled: true, activationBound: false };
  lifecycleResult = { fulfilled: true, applied: true, entitlementStatus: "active" };
}
export function setStripeClient(value) { stripeClient = value; }
export function setCheckoutResult(value) { checkoutResult = value; }
export function setLifecycleResult(value) { lifecycleResult = value; }
export function getStripe() {
  if (!stripeClient) throw new Error("Stripe test client is not configured");
  return stripeClient;
}
export function getStripeRequestOptions() { return { apiVersion: "test" }; }
export async function query() {
  throw new Error("Tests must inject the Postgres query function");
}
export async function upsertLicenseFromCheckoutSession(...args) {
  calls.push(["checkout", ...args]);
  return checkoutResult;
}
export async function upsertLicenseFromSubscription(...args) {
  calls.push(["subscription", ...args]);
  return subscriptionResult;
}
export async function reconcileOneTimePaymentLifecycle(...args) {
  calls.push(["lifecycle", ...args]);
  return lifecycleResult;
}
export function getStripeWebhookSecret() { return "webhook-secret"; }
export function methodNotAllowed(response, allowed) {
  response.setHeader("Allow", allowed);
  return sendJson(response, 405, { error: "Method not allowed" });
}
export async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
export function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}
`, { mode: 0o600 });
    const vercelFunctionsStubPath = join(directory, "vercel-functions-stub.mjs");
    await writeFile(vercelFunctionsStubPath, `
export function waitUntil() {}
`, { mode: 0o600 });
    const stubUrl = pathToFileURL(stubPath).href;
    const licenseEnvironmentUrl = pathToFileURL(
      join(repositoryRoot, "api/_lib/license-environment.ts"),
    ).href;
    const vercelFunctionsStubUrl = pathToFileURL(vercelFunctionsStubPath).href;
    const stripeEventsUrl = await writeAdaptedModule(
      directory,
      "stripe-events",
      join(repositoryRoot, "api/_lib/stripe-events.ts"),
      {
        "./account.js": stubUrl,
        "./license-environment.js": licenseEnvironmentUrl,
      },
    );
    const webhookUrl = await writeAdaptedModule(
      directory,
      "webhook",
      join(repositoryRoot, "api/stripe/webhook.ts"),
      {
        "@vercel/functions": vercelFunctionsStubUrl,
        "../_lib/account.js": stubUrl,
        "../_lib/stripe-events.js": stripeEventsUrl,
      },
    );
    const processRouteUrl = await writeAdaptedModule(
      directory,
      "process-route",
      join(repositoryRoot, "api/internal/stripe-events/process.ts"),
      { "../../_lib/stripe-events.js": stripeEventsUrl },
    );
    const nonce = randomUUID();
    const [stripeEvents, webhook, processRoute, stub] = await Promise.all([
      import(`${stripeEventsUrl}?test=${nonce}`),
      import(`${webhookUrl}?test=${nonce}`),
      import(`${processRouteUrl}?test=${nonce}`),
      import(stubUrl),
    ]);
    return { directory, stripeEvents, webhook, processRoute, stub };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function loadAccountRuntime(directory) {
  const postgresUrl = pathToFileURL(join(repositoryRoot, "api/_lib/postgres.ts")).href;
  const maintenanceUrl = await writeAdaptedModule(
    directory,
    "account-maintenance",
    join(repositoryRoot, "api/_lib/maintenance.ts"),
    { "./postgres.js": postgresUrl },
  );
  const accountUrl = await writeAdaptedModule(
    directory,
    "account",
    join(repositoryRoot, "api/_lib/account.ts"),
    {
      stripe: import.meta.resolve("stripe"),
      "./entitlement.js": pathToFileURL(
        join(repositoryRoot, "api/_lib/entitlement.ts"),
      ).href,
      "./device-policy.js": pathToFileURL(
        join(repositoryRoot, "api/_lib/device-policy.ts"),
      ).href,
      "./license-environment.js": pathToFileURL(
        join(repositoryRoot, "api/_lib/license-environment.ts"),
      ).href,
      "./customer-identity.js": pathToFileURL(
        join(repositoryRoot, "api/_lib/customer-identity.ts"),
      ).href,
      "./maintenance.js": maintenanceUrl,
      "./postgres.js": postgresUrl,
    },
  );
  const [account, accountPostgres] = await Promise.all([
    import(`${accountUrl}?test=${randomUUID()}`),
    import(postgresUrl),
  ]);
  return { account, accountPostgres };
}

async function writeAdaptedModule(directory, name, sourcePath, replacements) {
  let source = await readFile(sourcePath, "utf8");
  for (const [original, replacement] of Object.entries(replacements)) {
    assert.match(source, new RegExp(escapeRegExp(JSON.stringify(original))));
    source = source.replaceAll(JSON.stringify(original), JSON.stringify(replacement));
  }
  const destination = join(directory, `${name}-under-test.ts`);
  await writeFile(destination, source, { mode: 0o600 });
  return pathToFileURL(destination).href;
}

async function startEphemeralPostgres() {
  const initdb = await findExecutable("initdb");
  const pgCtl = await findExecutable("pg_ctl");
  const root = await mkdtemp(join(tmpdir(), "sidestream-stripe-events-pg-"));
  const dataDirectory = join(root, "data");
  const logPath = join(root, "postgres.log");
  const port = await reservePort();
  try {
    execFileSync(initdb, [
      "--pgdata", dataDirectory,
      "--username", "postgres",
      "--auth", "trust",
      "--encoding", "UTF8",
      "--no-locale",
      "--no-sync",
    ], { stdio: "pipe" });
    execFileSync(pgCtl, [
      "--pgdata", dataDirectory,
      "--log", logPath,
      "--options", `-F -p ${port} -h 127.0.0.1 -k /tmp`,
      "--wait",
      "--timeout", "20",
      "start",
    ], { stdio: "pipe" });
  } catch (error) {
    const log = await readFile(logPath, "utf8").catch(() => "");
    await rm(root, { recursive: true, force: true });
    throw new Error(`Unable to start disposable Postgres: ${error.message}\n${log}`);
  }

  let stopped = false;
  return {
    connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`,
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        execFileSync(pgCtl, [
          "--pgdata", dataDirectory,
          "--wait",
          "--timeout", "20",
          "--mode", "immediate",
          "stop",
        ], { stdio: "pipe" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

async function findExecutable(name) {
  for (const directory of (process.env.PATH || "").split(":")) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error(`${name} is required for the self-contained Stripe event test`);
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => {
    if (error) reject(error);
    else resolve();
  }));
  if (!port) throw new Error("Unable to reserve a local Postgres port");
  return port;
}

function configureAccountRuntime(connectionString) {
  for (const name of [
    "SIDESTREAM_POSTGRES_URL",
    "SIDESTREAM_POSTGRES_PRISMA_URL",
    "SIDESTREAM_POSTGRES_URL_NON_POOLING",
    "POSTGRES_URL",
    "POSTGRES_PRISMA_URL",
    "POSTGRES_URL_NON_POOLING",
  ]) {
    delete process.env[name];
  }
  process.env.SIDESTREAM_TEST_POSTGRES_URL = connectionString;
  process.env.SIDESTREAM_TEST_API_HOSTS = "test.sidestream.local";
  process.env.SIDESTREAM_LICENSE_NAMESPACE = "test";
  process.env.VERCEL_ENV = "preview";
  process.env.POSTGRES_SSL = "0";
  process.env.POSTGRES_POOL_MAX = "12";
}

function snapshotEnvironment(names) {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(snapshot) {
  for (const [name, value] of snapshot) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

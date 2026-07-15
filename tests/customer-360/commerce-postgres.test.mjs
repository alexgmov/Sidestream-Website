import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  materializeCustomerCommerceEvent as materializeCustomerCommerceEventWithNamespace,
} from "../../api/_lib/customer-commerce.ts";
import {
  createTestPoolOptions,
  requireSafeTestDatabaseUrl,
} from "../../scripts/run-postgres-integration.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migrations = [
  "20260715120000_add_customer_360_core.sql",
  "20260715121000_add_customer_identity_links.sql",
  "20260715122000_add_customer_commerce_ledger.sql",
];
const materializeCustomerCommerceEvent = (event, query) =>
  materializeCustomerCommerceEventWithNamespace(event, query, "test");

test("Customer commerce materializes idempotent per-currency Stripe money truth", {
  timeout: 120_000,
}, async (t) => {
  const databaseUrl = requireSafeTestDatabaseUrl(process.env);
  const schema = `sidestream_c360_money_${randomBytes(8).toString("hex")}`;
  const quotedSchema = quoteIdentifier(schema);
  const pool = new Pool(createTestPoolOptions(databaseUrl));
  let schemaCreated = false;
  const query = (text, params = []) => pool.query(
    text.replace(/\bpublic\./g, `${schema}.`),
    [...params],
  );

  try {
    await pool.query(`create schema ${quotedSchema}`);
    schemaCreated = true;
    for (const filename of migrations) {
      const sql = await readFile(join(repositoryRoot, "db/migrations", filename), "utf8");
      await pool.query(sql.replace(/\bpublic\./g, `${schema}.`));
    }

    await t.test("schema is private and keeps explicit money dimensions", async () => {
      const tables = await pool.query(
        `select relname, relrowsecurity
         from pg_class join pg_namespace on pg_namespace.oid = pg_class.relnamespace
         where nspname = $1 and relkind = 'r'
           and relname like 'sidestream_customer_commerce%'
         order by relname`,
        [schema],
      );
      assert.deepEqual(tables.rows, [
        { relname: "sidestream_customer_commerce_aliases", relrowsecurity: true },
        { relname: "sidestream_customer_commerce_materializations", relrowsecurity: true },
      ]);
      const columns = await pool.query(
        `select column_name, data_type
         from information_schema.columns
         where table_schema = $1 and table_name = 'sidestream_customer_commerce_materializations'
           and column_name in (
             'gross_paid_minor', 'discount_minor', 'tax_minor', 'refunded_minor',
             'disputed_minor', 'inquiry_minor', 'net_paid_minor', 'currency',
             'source_confidence', 'identity_conflict',
             'first_inferred_paid_at', 'last_inferred_paid_at',
             'first_inferred_upgraded_at', 'last_inferred_upgraded_at'
           ) order by column_name`,
        [schema],
      );
      assert.deepEqual(columns.rows, [
        { column_name: "currency", data_type: "text" },
        { column_name: "discount_minor", data_type: "bigint" },
        { column_name: "disputed_minor", data_type: "bigint" },
        { column_name: "first_inferred_paid_at", data_type: "timestamp with time zone" },
        { column_name: "first_inferred_upgraded_at", data_type: "timestamp with time zone" },
        { column_name: "gross_paid_minor", data_type: "bigint" },
        { column_name: "identity_conflict", data_type: "boolean" },
        { column_name: "inquiry_minor", data_type: "bigint" },
        { column_name: "last_inferred_paid_at", data_type: "timestamp with time zone" },
        { column_name: "last_inferred_upgraded_at", data_type: "timestamp with time zone" },
        { column_name: "net_paid_minor", data_type: "bigint" },
        { column_name: "refunded_minor", data_type: "bigint" },
        { column_name: "source_confidence", data_type: "text" },
        { column_name: "tax_minor", data_type: "bigint" },
      ]);
      const description = await pool.query(
        `select obj_description($1::regclass) as description`,
        [`${schema}.sidestream_customer_commerce_materializations`],
      );
      assert.match(description.rows[0].description, /Mutable latest-state money materializations/);
      assert.match(description.rows[0].description, /sidestream_stripe_events/);
    });

    const profile = await seedProfile(pool, quotedSchema, "test", "2026-01-01T00:00:00Z");
    await seedLinks(pool, quotedSchema, profile.id, "test", [
      ["stripe_customer", "cus_primary"],
      ["stripe_checkout_session", "cs_primary"],
      ["stripe_payment_intent", "pi_primary"],
      ["stripe_subscription", "sub_primary"],
    ]);

    await t.test("refund-first, Checkout, PaymentIntent, and charge converge once", async () => {
      const refund = stripeEvent("evt_refund_partial", "refund.updated", 1_800_000_050, {
        id: "re_primary",
        created: 1_800_000_040,
        charge: "ch_primary",
        payment_intent: "pi_primary",
        status: "succeeded",
        amount: 300,
        currency: "usd",
      });
      assert.equal((await materializeCustomerCommerceEvent(refund, query)).applied, 1);

      const checkout = stripeEvent("evt_checkout_primary", "checkout.session.completed", 1_800_000_100, {
        id: "cs_primary",
        created: 1_800_000_000,
        customer: "cus_primary",
        payment_intent: "pi_primary",
        mode: "payment",
        payment_status: "paid",
        amount_total: 1000,
        currency: "usd",
        total_details: { amount_discount: 200, amount_tax: 80 },
      });
      const paymentIntent = stripeEvent("evt_pi_primary", "payment_intent.succeeded", 1_800_000_110, {
        id: "pi_primary",
        created: 1_800_000_090,
        customer: "cus_primary",
        latest_charge: "ch_primary",
        status: "succeeded",
        amount: 1000,
        amount_received: 1000,
        currency: "usd",
      });
      const charge = stripeEvent("evt_charge_primary", "charge.succeeded", 1_800_000_120, {
        id: "ch_primary",
        created: 1_800_000_095,
        customer: "cus_primary",
        payment_intent: "pi_primary",
        paid: true,
        status: "succeeded",
        amount: 1000,
        amount_refunded: 0,
        currency: "usd",
      });
      for (const event of [checkout, paymentIntent, charge]) {
        assert.equal((await materializeCustomerCommerceEvent(event, query)).applied, 1);
      }
      const duplicate = await materializeCustomerCommerceEvent(charge, query);
      assert.equal(duplicate.applied, 0);
      assert.equal(duplicate.stale, 1);

      const staleFailure = stripeEvent(
        "evt_charge_old_failure",
        "charge.failed",
        1_800_000_080,
        {
          ...charge.data.object,
          paid: false,
          status: "failed",
        },
      );
      assert.equal((await materializeCustomerCommerceEvent(staleFailure, query)).stale, 1);

      const aliases = await pool.query(
        `select distinct payment_key from ${quotedSchema}.sidestream_customer_commerce_aliases
         where alias_id = any($1::text[])`,
        [["cs_primary", "pi_primary", "ch_primary"]],
      );
      assert.deepEqual(aliases.rows, [{ payment_key: "charge:ch_primary" }]);
      assert.deepEqual(await moneyTotal(pool, quotedSchema, profile.id, "usd"), {
        commerce_model: "one_time",
        gross_paid_minor: "1000",
        discount_minor: "200",
        tax_minor: "80",
        refunded_minor: "300",
        disputed_minor: "0",
        inquiry_minor: "0",
        net_paid_minor: "700",
        paid_transaction_count: "1",
        comped_transaction_count: "0",
      });
      const paymentFacts = await pool.query(
        `select count(*)::int as count from ${quotedSchema}.sidestream_customer_commerce_materializations
         where profile_id = $1 and fact_kind = 'payment' and payment_key = 'charge:ch_primary'`,
        [profile.id],
      );
      assert.equal(paymentFacts.rows[0].count, 3);
    });

    await t.test("customer identity alone cannot scope unrelated money to Sidestream", async () => {
      const scopedProfile = await seedProfile(
        pool,
        quotedSchema,
        "test",
        "2026-01-01T01:00:00Z",
        null,
      );
      await seedLinks(pool, quotedSchema, scopedProfile.id, "test", [
        ["stripe_customer", "cus_product_scope"],
        ["stripe_checkout_session", "cs_sidestream_scope"],
        ["stripe_payment_intent", "pi_sidestream_scope"],
      ]);

      await materializeCustomerCommerceEvent(stripeEvent(
        "evt_unrelated_product_charge",
        "charge.succeeded",
        1_800_000_300,
        {
          id: "ch_unrelated_product",
          customer: "cus_product_scope",
          payment_intent: "pi_unrelated_product",
          paid: true,
          captured: true,
          status: "succeeded",
          amount_captured: 400,
          currency: "nzd",
        },
      ), query);
      assert.deepEqual((await pool.query(
        `select profile_id, identity_conflict
         from ${quotedSchema}.sidestream_customer_commerce_materializations
         where source_object_id = 'ch_unrelated_product'`,
      )).rows[0], { profile_id: null, identity_conflict: false });
      assert.equal((await pool.query(
        `select count(*)::int as count
         from ${quotedSchema}.sidestream_customer_money_totals
         where profile_id = $1 and currency = 'nzd'`,
        [scopedProfile.id],
      )).rows[0].count, 0);

      const scopedEvents = [
        stripeEvent("evt_scope_checkout", "checkout.session.completed", 1_800_000_310, {
          id: "cs_sidestream_scope",
          customer: "cus_product_scope",
          payment_intent: "pi_sidestream_scope",
          mode: "payment",
          payment_status: "paid",
          amount_total: 1200,
          currency: "nzd",
          total_details: { amount_discount: 100, amount_tax: 150 },
        }),
        stripeEvent("evt_scope_pi", "payment_intent.succeeded", 1_800_000_320, {
          id: "pi_sidestream_scope",
          customer: "cus_product_scope",
          latest_charge: "ch_sidestream_scope",
          status: "succeeded",
          amount_received: 1200,
          currency: "nzd",
        }),
        stripeEvent("evt_scope_charge", "charge.succeeded", 1_800_000_330, {
          id: "ch_sidestream_scope",
          customer: "cus_product_scope",
          payment_intent: "pi_sidestream_scope",
          paid: true,
          captured: true,
          status: "succeeded",
          amount_captured: 1200,
          currency: "nzd",
        }),
        stripeEvent("evt_scope_invoice", "invoice.paid", 1_800_000_340, {
          id: "in_sidestream_scope",
          customer: "cus_product_scope",
          payments: {
            data: [{
              type: "payment",
              payment: {
                type: "payment_intent",
                payment_intent: "pi_sidestream_scope",
                charge: "ch_sidestream_scope",
              },
            }],
          },
          paid: true,
          status: "paid",
          amount_paid: 1200,
          currency: "nzd",
          total_discount_amounts: [{ amount: 100 }],
          total_tax_amounts: [{ amount: 150 }],
          status_transitions: { paid_at: 1_800_000_335 },
        }),
      ];
      for (const event of scopedEvents) {
        await materializeCustomerCommerceEvent(event, query);
      }

      assert.deepEqual(await moneyTotal(pool, quotedSchema, scopedProfile.id, "nzd"), {
        commerce_model: "one_time",
        gross_paid_minor: "1200",
        discount_minor: "100",
        tax_minor: "150",
        refunded_minor: "0",
        disputed_minor: "0",
        inquiry_minor: "0",
        net_paid_minor: "1200",
        paid_transaction_count: "1",
        comped_transaction_count: "0",
      });
      const scopedRows = await pool.query(
        `select count(*)::int as count, count(distinct payment_key)::int as payment_keys
         from ${quotedSchema}.sidestream_customer_commerce_materializations
         where profile_id = $1 and source_object_id = any($2::text[])`,
        [
          scopedProfile.id,
          [
            "cs_sidestream_scope",
            "pi_sidestream_scope",
            "ch_sidestream_scope",
            "in_sidestream_scope",
          ],
        ],
      );
      assert.deepEqual(scopedRows.rows[0], { count: 4, payment_keys: 1 });
    });

    await t.test("successful update snapshots cannot advance paid or upgraded dates", async () => {
      const cases = [
        {
          suffix: "pi_transition",
          successType: "payment_intent.succeeded",
          updateType: "payment_intent.updated",
          successAt: 1_800_000_500,
          object: {
            id: "pi_transition",
            created: 1_800_000_000,
            customer: "cus_pi_transition",
            latest_charge: "ch_pi_transition",
            status: "succeeded",
            amount_received: 650,
            currency: "usd",
          },
        },
        {
          suffix: "charge_transition",
          successType: "charge.succeeded",
          updateType: "charge.updated",
          successAt: 1_800_000_600,
          object: {
            id: "ch_charge_transition",
            created: 1_800_000_010,
            customer: "cus_charge_transition",
            payment_intent: "pi_charge_transition",
            paid: true,
            captured: true,
            status: "succeeded",
            amount_captured: 700,
            amount_refunded: 0,
            currency: "usd",
          },
        },
      ];

      for (const item of cases) {
        const transitionProfile = await seedProfile(
          pool,
          quotedSchema,
          "test",
          new Date((item.successAt - 10) * 1000).toISOString(),
          null,
        );
        const paymentIntentId = item.suffix === "pi_transition"
          ? item.object.id
          : item.object.payment_intent;
        await seedLinks(pool, quotedSchema, transitionProfile.id, "test", [
          ["stripe_customer", item.object.customer],
          ["stripe_payment_intent", paymentIntentId],
        ]);
        await materializeCustomerCommerceEvent(stripeEvent(
          `evt_${item.suffix}_succeeded`,
          item.successType,
          item.successAt,
          item.object,
        ), query);
        await materializeCustomerCommerceEvent(stripeEvent(
          `evt_${item.suffix}_later_update`,
          item.updateType,
          item.successAt + 1_000,
          {
            ...item.object,
            metadata: { support_note: "post-payment update" },
            amount_refunded: item.object.amount_refunded === undefined
              ? undefined
              : 100,
          },
        ), query);

        const expected = new Date(item.successAt * 1000).toISOString();
        const storedDates = await pool.query(
          `select first_paid_at, last_paid_at, first_upgraded_at, last_upgraded_at
           from ${quotedSchema}.sidestream_customer_profiles where id = $1`,
          [transitionProfile.id],
        );
        assert.deepEqual(
          Object.fromEntries(Object.entries(storedDates.rows[0]).map(([key, value]) => [
            key,
            value?.toISOString() || null,
          ])),
          {
            first_paid_at: expected,
            last_paid_at: expected,
            first_upgraded_at: expected,
            last_upgraded_at: expected,
          },
          item.suffix,
        );
      }
    });

    await t.test("failed, partial, and full refunds are watermark-correct", async () => {
      await materializeCustomerCommerceEvent(stripeEvent(
        "evt_refund_failed",
        "refund.failed",
        1_800_000_130,
        {
          id: "re_failed",
          created: 1_800_000_125,
          charge: "ch_primary",
          payment_intent: "pi_primary",
          status: "failed",
          amount: 200,
          currency: "usd",
        },
      ), query);
      assert.equal((await moneyTotal(pool, quotedSchema, profile.id, "usd")).refunded_minor, "300");

      const before = await pool.query(
        `select id, event_id, refunded_minor
         from ${quotedSchema}.sidestream_customer_commerce_materializations
         where source_object_type = 'refund' and source_object_id = 're_primary'`,
      );
      const full = stripeEvent("evt_refund_full", "refund.updated", 1_800_000_140, {
        id: "re_primary",
        created: 1_800_000_040,
        charge: "ch_primary",
        payment_intent: "pi_primary",
        status: "succeeded",
        amount: 1000,
        currency: "usd",
      });
      await materializeCustomerCommerceEvent(full, query);
      assert.equal((await moneyTotal(pool, quotedSchema, profile.id, "usd")).net_paid_minor, "0");
      const oldPartial = stripeEvent(
        "evt_refund_partial_old",
        "refund.updated",
        1_800_000_060,
        { ...full.data.object, amount: 300 },
      );
      assert.equal((await materializeCustomerCommerceEvent(oldPartial, query)).stale, 1);
      assert.equal((await moneyTotal(pool, quotedSchema, profile.id, "usd")).refunded_minor, "1000");
      const after = await pool.query(
        `select id, event_id, refunded_minor
         from ${quotedSchema}.sidestream_customer_commerce_materializations
         where source_object_type = 'refund' and source_object_id = 're_primary'`,
      );
      assert.equal(after.rows.length, 1);
      assert.equal(after.rows[0].id, before.rows[0].id);
      assert.equal(after.rows[0].event_id, "evt_refund_full");
      assert.equal(after.rows[0].refunded_minor, "1000");
    });

    await t.test("open/lost disputes reduce net while won, warning_closed, and prevented do not", async () => {
      // Return the refund to a failed terminal state so dispute behavior is visible.
      await materializeCustomerCommerceEvent(stripeEvent(
        "evt_refund_later_failed",
        "refund.failed",
        1_800_000_150,
        {
          id: "re_primary",
          created: 1_800_000_040,
          charge: "ch_primary",
          payment_intent: "pi_primary",
          status: "failed",
          amount: 1000,
          currency: "usd",
        },
      ), query);
      const dispute = async (id, status, created) => materializeCustomerCommerceEvent(
        stripeEvent(`evt_${id}_${status}`, "charge.dispute.updated", created, {
          id,
          created: 1_800_000_150,
          charge: "ch_primary",
          status,
          amount: 400,
          currency: "usd",
        }),
        query,
      );

      await dispute("dp_open", "needs_response", 1_800_000_160);
      let total = await moneyTotal(pool, quotedSchema, profile.id, "usd");
      assert.equal(total.disputed_minor, "400");
      assert.equal(total.net_paid_minor, "600");
      await dispute("dp_open", "won", 1_800_000_170);
      total = await moneyTotal(pool, quotedSchema, profile.id, "usd");
      assert.equal(total.disputed_minor, "0");
      assert.equal(total.inquiry_minor, "0");
      assert.equal(total.net_paid_minor, "1000");

      await dispute("dp_inquiry", "warning_needs_response", 1_800_000_175);
      total = await moneyTotal(pool, quotedSchema, profile.id, "usd");
      assert.equal(total.disputed_minor, "0");
      assert.equal(total.inquiry_minor, "400");
      assert.equal(total.net_paid_minor, "1000");
      await dispute("dp_inquiry", "warning_under_review", 1_800_000_176);
      assert.equal((await moneyTotal(pool, quotedSchema, profile.id, "usd")).inquiry_minor, "400");
      await dispute("dp_inquiry", "warning_closed", 1_800_000_177);
      assert.equal((await moneyTotal(pool, quotedSchema, profile.id, "usd")).inquiry_minor, "0");

      await dispute("dp_lost", "lost", 1_800_000_180);
      assert.equal((await moneyTotal(pool, quotedSchema, profile.id, "usd")).disputed_minor, "400");
      await dispute("dp_lost", "warning_closed", 1_800_000_190);
      assert.equal((await moneyTotal(pool, quotedSchema, profile.id, "usd")).disputed_minor, "0");
      await dispute("dp_prevented", "prevented", 1_800_000_200);
      assert.equal((await moneyTotal(pool, quotedSchema, profile.id, "usd")).disputed_minor, "0");
    });

    await t.test("zero-cost, recurring renewal/cancel, and currencies remain distinct", async () => {
      await seedLinks(pool, quotedSchema, profile.id, "test", [
        ["stripe_checkout_session", "cs_comped"],
        ["stripe_payment_intent", "pi_eur"],
      ]);
      await materializeCustomerCommerceEvent(stripeEvent(
        "evt_comped",
        "checkout.session.completed",
        1_800_001_000,
        {
          id: "cs_comped",
          customer: "cus_primary",
          payment_status: "no_payment_required",
          mode: "payment",
          amount_total: 0,
          currency: "usd",
          total_details: { amount_discount: 1000, amount_tax: 0 },
        },
      ), query);
      await materializeCustomerCommerceEvent(stripeEvent(
        "evt_subscription_created",
        "customer.subscription.created",
        1_800_001_100,
        {
          id: "sub_primary",
          created: 1_800_001_090,
          customer: "cus_primary",
          status: "active",
          items: {
            data: [{
              id: "si_primary",
              current_period_start: 1_800_001_000,
              current_period_end: 1_802_593_000,
            }],
          },
        },
      ), query);
      for (const [suffix, created] of [["one", 1_800_001_200], ["two", 1_802_593_200]]) {
        await materializeCustomerCommerceEvent(stripeEvent(
          `evt_pi_${suffix}`,
          "payment_intent.succeeded",
          created - 10,
          {
            id: `pi_${suffix}`,
            created: created - 200,
            customer: "cus_primary",
            latest_charge: `ch_${suffix}`,
            status: "succeeded",
            amount: 900,
            amount_received: 900,
            currency: "usd",
          },
        ), query);
        await materializeCustomerCommerceEvent(stripeEvent(
          `evt_invoice_${suffix}`,
          "invoice.paid",
          created,
          {
            id: `in_${suffix}`,
            created: created - 20,
            customer: "cus_primary",
            parent: {
              type: "subscription_details",
              subscription_details: { subscription: "sub_primary" },
            },
            payments: {
              data: [{
                type: "payment",
                payment: {
                  type: "payment_intent",
                  payment_intent: `pi_${suffix}`,
                  charge: `ch_${suffix}`,
                },
              }],
            },
            status: "paid",
            paid: true,
            amount_paid: 900,
            currency: "usd",
            period_start: created - 100,
            period_end: created + 2_592_000,
            status_transitions: { paid_at: created - 5 },
          },
        ), query);
      }
      await materializeCustomerCommerceEvent(stripeEvent(
        "evt_subscription_deleted",
        "customer.subscription.deleted",
        1_805_000_000,
        {
          id: "sub_primary",
          created: 1_800_001_090,
          customer: "cus_primary",
          status: "canceled",
          items: {
            data: [{
              id: "si_primary",
              current_period_start: 1_802_593_200,
              current_period_end: 1_805_185_200,
            }],
          },
        },
      ), query);
      await materializeCustomerCommerceEvent(stripeEvent(
        "evt_eur",
        "charge.succeeded",
        1_805_000_100,
        {
          id: "ch_eur",
          created: 1_805_000_090,
          customer: "cus_primary",
          payment_intent: "pi_eur",
          paid: true,
          status: "succeeded",
          amount: 500,
          currency: "eur",
        },
      ), query);

      const totals = await pool.query(
        `select currency, gross_paid_minor, net_paid_minor, commerce_model,
           paid_transaction_count, comped_transaction_count
         from ${quotedSchema}.sidestream_customer_money_totals
         where profile_id = $1 order by currency`,
        [profile.id],
      );
      assert.deepEqual(totals.rows, [
        {
          currency: "eur",
          gross_paid_minor: "500",
          net_paid_minor: "500",
          commerce_model: "one_time",
          paid_transaction_count: "1",
          comped_transaction_count: "0",
        },
        {
          currency: "usd",
          gross_paid_minor: "2800",
          net_paid_minor: "2800",
          commerce_model: "mixed",
          paid_transaction_count: "3",
          comped_transaction_count: "1",
        },
      ]);
      const renewalRows = await pool.query(
        `select source_object_id, payment_key, commerce_model,
           extract(epoch from first_paid_at)::bigint as first_paid_at
         from ${quotedSchema}.sidestream_customer_commerce_materializations
         where source_object_type in ('invoice', 'payment_intent')
           and source_object_id = any($1::text[])
         order by source_object_type, source_object_id`,
        [["in_one", "in_two", "pi_one", "pi_two"]],
      );
      assert.equal(new Set(renewalRows.rows.map((row) => row.payment_key)).size, 2);
      assert.equal(
        renewalRows.rows.find((row) => row.source_object_id === "pi_one").first_paid_at,
        "1800001190",
      );
      assert.equal(
        renewalRows.rows.find((row) => row.source_object_id === "in_one").commerce_model,
        "subscription",
      );
      assert.equal(
        (await pool.query(
          `select count(*)::int as count
           from ${quotedSchema}.sidestream_customer_commerce_aliases
           where alias_type = 'subscription'`,
        )).rows[0].count,
        0,
      );
      const subscription = await pool.query(
        `select state, first_upgraded_at, last_upgraded_at, billing_period_start,
           billing_period_end
         from ${quotedSchema}.sidestream_customer_commerce_materializations
         where source_object_type = 'subscription' and source_object_id = 'sub_primary'`,
      );
      assert.equal(subscription.rows[0].state, "canceled");
      assert.ok(subscription.rows[0].first_upgraded_at);
      assert.equal(
        subscription.rows[0].first_upgraded_at.toISOString(),
        subscription.rows[0].last_upgraded_at.toISOString(),
      );
      assert.ok(subscription.rows[0].billing_period_start);
      assert.ok(subscription.rows[0].billing_period_end);
    });

    await t.test("partial capture uses captured money instead of authorization", async () => {
      const capturedProfile = await seedProfile(
        pool,
        quotedSchema,
        "test",
        "2026-01-02T00:00:00Z",
        null,
      );
      await seedLinks(pool, quotedSchema, capturedProfile.id, "test", [
        ["stripe_customer", "cus_partial_capture"],
        ["stripe_payment_intent", "pi_partial_capture"],
      ]);
      await materializeCustomerCommerceEvent(stripeEvent(
        "evt_partial_capture",
        "charge.succeeded",
        1_806_000_100,
        {
          id: "ch_partial_capture",
          created: 1_806_000_000,
          customer: "cus_partial_capture",
          payment_intent: "pi_partial_capture",
          paid: true,
          captured: true,
          status: "succeeded",
          amount: 1000,
          amount_captured: 400,
          amount_refunded: 0,
          currency: "aud",
        },
      ), query);
      assert.deepEqual(await moneyTotal(pool, quotedSchema, capturedProfile.id, "aud"), {
        commerce_model: "one_time",
        gross_paid_minor: "400",
        discount_minor: "0",
        tax_minor: "0",
        refunded_minor: "0",
        disputed_minor: "0",
        inquiry_minor: "0",
        net_paid_minor: "400",
        paid_transaction_count: "1",
        comped_transaction_count: "0",
      });
    });

    await t.test("refund and dispute adjustments cannot change subscription classification", async () => {
      const subscriptionProfile = await seedProfile(
        pool,
        quotedSchema,
        "test",
        "2026-01-03T00:00:00Z",
        null,
      );
      await seedLinks(pool, quotedSchema, subscriptionProfile.id, "test", [
        ["stripe_customer", "cus_subscription_only"],
        ["stripe_subscription", "sub_subscription_only"],
      ]);
      await materializeCustomerCommerceEvent(stripeEvent(
        "evt_subscription_only_invoice",
        "invoice.paid",
        1_807_000_100,
        {
          id: "in_subscription_only",
          customer: "cus_subscription_only",
          parent: {
            type: "subscription_details",
            subscription_details: { subscription: "sub_subscription_only" },
          },
          payments: {
            data: [{
              type: "payment",
              payment: {
                type: "payment_intent",
                payment_intent: "pi_subscription_only",
                charge: "ch_subscription_only",
              },
            }],
          },
          paid: true,
          status: "paid",
          amount_paid: 600,
          currency: "usd",
          status_transitions: { paid_at: 1_807_000_090 },
        },
      ), query);
      await materializeCustomerCommerceEvent(stripeEvent(
        "evt_subscription_only_refund",
        "refund.updated",
        1_807_000_200,
        {
          id: "re_subscription_only",
          charge: "ch_subscription_only",
          status: "succeeded",
          amount: 100,
          currency: "usd",
        },
      ), query);
      await materializeCustomerCommerceEvent(stripeEvent(
        "evt_subscription_only_dispute",
        "charge.dispute.updated",
        1_807_000_300,
        {
          id: "dp_subscription_only",
          charge: "ch_subscription_only",
          status: "won",
          amount: 600,
          currency: "usd",
        },
      ), query);
      const stored = await pool.query(
        `select commerce_model from ${quotedSchema}.sidestream_customer_profiles where id = $1`,
        [subscriptionProfile.id],
      );
      assert.equal(stored.rows[0].commerce_model, "subscription");
      assert.equal(
        (await moneyTotal(pool, quotedSchema, subscriptionProfile.id, "usd")).refunded_minor,
        "100",
      );
    });

    await t.test("later verified timing cannot launder legacy-inferred dates", async () => {
      const legacyProfile = await seedProfile(
        pool,
        quotedSchema,
        "test",
        "2026-01-04T00:00:00Z",
        null,
      );
      await seedLinks(pool, quotedSchema, legacyProfile.id, "test", [
        ["stripe_customer", "cus_legacy_date"],
        ["stripe_subscription", "sub_legacy_date"],
      ]);
      await materializeCustomerCommerceEvent(stripeEvent(
        "evt_legacy_date",
        "customer.subscription.updated",
        1_808_000_000,
        {
          id: "sub_legacy_date",
          customer: "cus_legacy_date",
          status: "active",
          items: {
            data: [{
              id: "si_legacy_date",
              current_period_start: 1_808_000_000,
              current_period_end: 1_810_592_000,
            }],
          },
        },
      ), query);
      const materialization = await pool.query(
        `select source_confidence, first_upgraded_at, first_inferred_upgraded_at,
           effective_at
         from ${quotedSchema}.sidestream_customer_commerce_materializations
         where source_object_id = 'sub_legacy_date'`,
      );
      assert.equal(materialization.rows[0].source_confidence, "legacy_inferred");
      assert.equal(materialization.rows[0].first_upgraded_at, null);
      assert.equal(
        materialization.rows[0].first_inferred_upgraded_at.toISOString(),
        materialization.rows[0].effective_at.toISOString(),
      );
      const canonical = await pool.query(
        `select commerce_model, first_paid_at, last_paid_at,
           first_upgraded_at, last_upgraded_at
         from ${quotedSchema}.sidestream_customer_profiles where id = $1`,
        [legacyProfile.id],
      );
      assert.deepEqual(canonical.rows[0], {
        commerce_model: "subscription",
        first_paid_at: null,
        last_paid_at: null,
        first_upgraded_at: null,
        last_upgraded_at: null,
      });

      await materializeCustomerCommerceEvent(stripeEvent(
        "evt_verified_date",
        "customer.subscription.created",
        1_808_000_100,
        {
          id: "sub_legacy_date",
          created: 1_808_000_100,
          customer: "cus_legacy_date",
          status: "active",
          items: {
            data: [{
              id: "si_legacy_date",
              current_period_start: 1_808_000_100,
              current_period_end: 1_810_592_100,
            }],
          },
        },
      ), query);
      const verified = await pool.query(
        `select source_confidence, first_upgraded_at, last_upgraded_at,
           first_inferred_upgraded_at, last_inferred_upgraded_at
         from ${quotedSchema}.sidestream_customer_commerce_materializations
         where source_object_id = 'sub_legacy_date'`,
      );
      assert.deepEqual({
        source_confidence: verified.rows[0].source_confidence,
        first_upgraded_at: verified.rows[0].first_upgraded_at.toISOString(),
        last_upgraded_at: verified.rows[0].last_upgraded_at.toISOString(),
        first_inferred_upgraded_at:
          verified.rows[0].first_inferred_upgraded_at.toISOString(),
        last_inferred_upgraded_at:
          verified.rows[0].last_inferred_upgraded_at.toISOString(),
      }, {
        source_confidence: "verified",
        first_upgraded_at: new Date(1_808_000_100 * 1000).toISOString(),
        last_upgraded_at: new Date(1_808_000_100 * 1000).toISOString(),
        first_inferred_upgraded_at: new Date(1_808_000_000 * 1000).toISOString(),
        last_inferred_upgraded_at: new Date(1_808_000_000 * 1000).toISOString(),
      });
      const verifiedCanonical = await pool.query(
        `select first_upgraded_at, last_upgraded_at
         from ${quotedSchema}.sidestream_customer_profiles where id = $1`,
        [legacyProfile.id],
      );
      assert.deepEqual({
        first_upgraded_at: verifiedCanonical.rows[0].first_upgraded_at.toISOString(),
        last_upgraded_at: verifiedCanonical.rows[0].last_upgraded_at.toISOString(),
      }, {
        first_upgraded_at: new Date(1_808_000_100 * 1000).toISOString(),
        last_upgraded_at: new Date(1_808_000_100 * 1000).toISOString(),
      });
    });

    await t.test("conflicting verified identity stays unresolved despite a group owner", async () => {
      const profileA = await seedProfile(
        pool,
        quotedSchema,
        "test",
        "2026-01-05T00:00:00Z",
        null,
      );
      const profileB = await seedProfile(
        pool,
        quotedSchema,
        "test",
        "2026-01-06T00:00:00Z",
        null,
      );
      await seedLinks(pool, quotedSchema, profileA.id, "test", [
        ["stripe_customer", "cus_conflict_a"],
        ["stripe_payment_intent", "pi_conflict_a"],
      ]);
      await materializeCustomerCommerceEvent(stripeEvent(
        "evt_conflict_charge",
        "charge.succeeded",
        1_809_000_000,
        {
          id: "ch_conflict",
          customer: "cus_conflict_a",
          payment_intent: "pi_conflict_a",
          paid: true,
          status: "succeeded",
          amount_captured: 100,
          currency: "usd",
        },
      ), query);
      await seedLinks(pool, quotedSchema, profileB.id, "test", [
        ["stripe_payment_intent", "pi_conflict_b"],
      ]);
      await materializeCustomerCommerceEvent(stripeEvent(
        "evt_conflict_pi",
        "payment_intent.succeeded",
        1_809_000_100,
        {
          id: "pi_conflict_b",
          customer: "cus_conflict_a",
          latest_charge: "ch_conflict",
          status: "succeeded",
          amount_received: 100,
          currency: "usd",
        },
      ), query);
      const conflict = await pool.query(
        `select profile_id, identity_conflict
         from ${quotedSchema}.sidestream_customer_commerce_materializations
         where source_object_type = 'payment_intent'
           and source_object_id = 'pi_conflict_b'`,
      );
      assert.deepEqual(conflict.rows[0], {
        profile_id: null,
        identity_conflict: true,
      });
      assert.equal(
        (await moneyTotal(pool, quotedSchema, profileA.id, "usd")).gross_paid_minor,
        "100",
      );
      assert.equal(
        (await pool.query(
          `select count(*)::int as count
           from ${quotedSchema}.sidestream_customer_money_totals where profile_id = $1`,
          [profileB.id],
        )).rows[0].count,
        0,
      );
    });

    await t.test("profile dates come only from commerce facts and entitlement stays untouched", async () => {
      const before = await pool.query(
        `select entitlement_status, first_seen_at, first_paid_at, last_paid_at,
           first_upgraded_at, last_upgraded_at, commerce_model, commerce_synced_at
         from ${quotedSchema}.sidestream_customer_profiles where id = $1`,
        [profile.id],
      );
      assert.equal(before.rows[0].entitlement_status, "blocked_sentinel");
      assert.equal(before.rows[0].first_seen_at.toISOString(), "2030-01-01T00:00:00.000Z");
      assert.ok(before.rows[0].first_paid_at < before.rows[0].first_seen_at);
      assert.ok(before.rows[0].last_paid_at >= before.rows[0].first_paid_at);
      assert.ok(before.rows[0].last_upgraded_at >= before.rows[0].first_upgraded_at);
      assert.equal(before.rows[0].commerce_model, "mixed");
      assert.ok(before.rows[0].commerce_synced_at);
    });

    await t.test("an unresolved fact attaches when verified identity arrives, then follows merge", async () => {
      const unresolvedEvent = stripeEvent(
        "evt_unresolved",
        "charge.succeeded",
        1_810_000_000,
        {
          id: "ch_unresolved",
          created: 1_809_999_990,
          customer: "cus_later",
          payment_intent: "pi_later",
          paid: true,
          status: "succeeded",
          amount: 700,
          currency: "gbp",
        },
      );
      await materializeCustomerCommerceEvent(unresolvedEvent, query);
      let fact = await pool.query(
        `select profile_id from ${quotedSchema}.sidestream_customer_commerce_materializations
         where source_object_id = 'ch_unresolved'`,
      );
      assert.equal(fact.rows[0].profile_id, null);

      const later = await seedProfile(pool, quotedSchema, "test", "2026-02-01T00:00:00Z", null);
      await seedLinks(pool, quotedSchema, later.id, "test", [["stripe_customer", "cus_later"]]);
      fact = await pool.query(
        `select profile_id from ${quotedSchema}.sidestream_customer_commerce_materializations
         where source_object_id = 'ch_unresolved'`,
      );
      assert.equal(fact.rows[0].profile_id, null);

      await seedLinks(pool, quotedSchema, later.id, "test", [[
        "stripe_payment_intent",
        "pi_later",
      ]]);
      fact = await pool.query(
        `select profile_id from ${quotedSchema}.sidestream_customer_commerce_materializations
         where source_object_id = 'ch_unresolved'`,
      );
      assert.equal(fact.rows[0].profile_id, later.id);
      assert.equal((await moneyTotal(pool, quotedSchema, later.id, "gbp")).net_paid_minor, "700");

      await pool.query("begin");
      try {
        await pool.query(
          `update ${quotedSchema}.sidestream_customer_profiles
           set merged_into = $2, merged_at = now() where id = $1`,
          [later.id, profile.id],
        );
        await pool.query(
          `insert into ${quotedSchema}.sidestream_customer_profile_merges (
             license_namespace, source_profile_id, target_profile_id,
             merge_evidence_type, merge_evidence_value_hash, initiated_by
           ) values ('test', $1, $2, 'stripe_customer', $3, 'system')`,
          [later.id, profile.id, "f".repeat(64)],
        );
        await pool.query("commit");
      } catch (error) {
        await pool.query("rollback");
        throw error;
      }
      fact = await pool.query(
        `select profile_id from ${quotedSchema}.sidestream_customer_commerce_materializations
         where source_object_id = 'ch_unresolved'`,
      );
      assert.equal(fact.rows[0].profile_id, profile.id);
      assert.equal((await moneyTotal(pool, quotedSchema, profile.id, "gbp")).net_paid_minor, "700");
    });
  } finally {
    if (schemaCreated) await pool.query(`drop schema if exists ${quotedSchema} cascade`);
    await pool.end();
  }
});

async function seedProfile(
  pool,
  quotedSchema,
  namespace,
  createdAt,
  entitlementStatus = "blocked_sentinel",
) {
  const result = await pool.query(
    `insert into ${quotedSchema}.sidestream_customer_profiles (
       license_namespace, created_at, updated_at, first_seen_at, entitlement_status
     ) values ($1, $2, $2, '2030-01-01T00:00:00Z', $3) returning *`,
    [namespace, createdAt, entitlementStatus],
  );
  return result.rows[0];
}

async function seedLinks(pool, quotedSchema, profileId, namespace, links) {
  for (const [type, value] of links) {
    await pool.query(
      `insert into ${quotedSchema}.sidestream_customer_identity_links (
         profile_id, license_namespace, link_type, link_value
       ) values ($1, $2, $3, $4)`,
      [profileId, namespace, type, value],
    );
  }
}

async function moneyTotal(pool, quotedSchema, profileId, currency) {
  const result = await pool.query(
    `select commerce_model, gross_paid_minor, discount_minor, tax_minor,
       refunded_minor, disputed_minor, inquiry_minor, net_paid_minor, paid_transaction_count,
       comped_transaction_count
     from ${quotedSchema}.sidestream_customer_money_totals
     where profile_id = $1 and currency = $2`,
    [profileId, currency],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

function stripeEvent(id, type, created, object, livemode = false) {
  return {
    id,
    object: "event",
    api_version: "2026-06-30.basil",
    created,
    data: { object },
    livemode,
    pending_webhooks: 1,
    request: null,
    type,
  };
}

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new TypeError("Unsafe schema");
  return `"${identifier}"`;
}

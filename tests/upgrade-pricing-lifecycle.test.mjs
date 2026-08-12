import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  planUpgradePricingSubscriptionTransition,
  shouldApplyStripeEventWatermark,
  verifyUpgradePricingSubscriptionTruth,
} from "../api/_lib/entitlement.ts";

const metadata = Object.freeze({
  sidestream_acquisition_id: "11111111-1111-4111-8111-111111111111",
  sidestream_plan: "sidestream_pro",
  sidestream_price_id: "price_monthly_half",
  sidestream_product_id: "prod_sidestream",
  sidestream_checkout_intent_id: "22222222-2222-4222-8222-222222222222",
  sidestream_offer_id: "global-monthly",
  sidestream_offer_country: "ZZ",
  sidestream_offer_currency: "usd",
  sidestream_offer_amount_minor: "1000",
  sidestream_account_id: "33333333-3333-4333-8333-333333333333",
  sidestream_activation_key: "activation-key",
  sidestream_upgrade_snapshot_version: "1",
  sidestream_upgrade_experiment_id: "upgrade-pricing-v1",
  sidestream_upgrade_decision_reason: "rollout_monthly",
  sidestream_upgrade_assignment_id: "44444444-4444-4444-8444-444444444444",
  sidestream_upgrade_assignment_bucket: "124",
  sidestream_upgrade_rollout_bps: "5000",
  sidestream_upgrade_assigned_at: "2026-08-12T12:00:00.000Z",
  sidestream_upgrade_variant: "monthly_half",
  sidestream_upgrade_billing_model: "subscription",
  sidestream_upgrade_country: "ZZ",
  sidestream_upgrade_currency: "usd",
  sidestream_upgrade_amount_minor: "1000",
  sidestream_upgrade_product_id: "prod_sidestream",
  sidestream_upgrade_price_id: "price_monthly_half",
  sidestream_upgrade_account_id: "33333333-3333-4333-8333-333333333333",
  sidestream_upgrade_acquisition_id: "11111111-1111-4111-8111-111111111111",
  sidestream_upgrade_intent_id: "22222222-2222-4222-8222-222222222222",
  sidestream_upgrade_activation_id: "55555555-5555-4555-8555-555555555555",
});

function subscriptionTruth(overrides = {}) {
  const invoiceId = overrides.invoiceId || "in_initial";
  const invoicePaid = overrides.invoicePaid ?? true;
  const status = overrides.status || "active";
  const invoice = {
    livemode: false,
    id: invoiceId,
    customer: "cus_owner",
    subscription: "sub_monthly",
    collection_method: "charge_automatically",
    currency: "usd",
    status: invoicePaid ? "paid" : "open",
    amount_due: 1000,
    amount_paid: invoicePaid ? 1000 : 0,
    amount_remaining: invoicePaid ? 0 : 1000,
    total: 1000,
    billing_reason: invoiceId === "in_initial" ? "subscription_create" : "subscription_cycle",
    lines: {
      data: [{
        quantity: 1,
        amount: 1000,
        currency: "usd",
        parent: {
          type: "subscription_item_details",
          subscription_item_details: {
            subscription: "sub_monthly",
            subscription_item: "si_monthly",
          },
        },
        pricing: {
          type: "price_details",
          price_details: {
            price: "price_monthly_half",
            product: "prod_sidestream",
          },
        },
      }],
      has_more: false,
    },
    parent: {
      type: "subscription_details",
      subscription_details: {
        subscription: "sub_monthly",
        metadata: { ...metadata },
      },
    },
    payments: {
      data: [{
        id: "inpay_monthly",
        invoice: invoiceId,
        livemode: false,
        currency: "usd",
        amount_requested: 1000,
        amount_paid: invoicePaid ? 1000 : null,
        status: invoicePaid ? "paid" : "open",
        payment: {
          type: "payment_intent",
          payment_intent: {
            id: "pi_monthly",
            customer: "cus_owner",
            livemode: false,
            currency: "usd",
            amount: 1000,
            amount_received: invoicePaid ? 1000 : 0,
            status: invoicePaid ? "succeeded" : "requires_payment_method",
          },
        },
      }],
      has_more: false,
    },
  };
  const session = {
    livemode: false,
    id: "cs_monthly",
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    customer: "cus_owner",
    subscription: "sub_monthly",
    invoice: "in_initial",
    client_reference_id: "activation-key",
    currency: "usd",
    amount_subtotal: 1000,
    amount_total: 1000,
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    line_items: {
      data: [{
        quantity: 1,
        price: { id: "price_monthly_half", product: "prod_sidestream" },
      }],
      has_more: false,
    },
    metadata: { ...metadata },
  };
  const subscription = {
    livemode: false,
    id: "sub_monthly",
    customer: "cus_owner",
    status,
    collection_method: "charge_automatically",
    cancel_at_period_end: overrides.cancelAtPeriodEnd ?? false,
    latest_invoice: invoiceId,
    items: {
      data: [{
        quantity: 1,
        price: "price_monthly_half",
        current_period_end: 1_800_000_000,
      }],
      has_more: false,
    },
    metadata: { ...metadata },
  };
  const expected = {
    sessionId: "cs_monthly",
    subscriptionId: "sub_monthly",
    customerId: "cus_owner",
    invoiceId,
    initialInvoiceId: "in_initial",
    priceId: "price_monthly_half",
    productId: "prod_sidestream",
    currency: "usd",
    amountMinor: 1000,
    livemode: false,
    clientReferenceId: "activation-key",
    metadata,
    invoiceEventType: overrides.invoiceEventType || "checkout.session.completed",
  };
  return {
    session,
    subscription,
    customer: { id: "cus_owner", deleted: false },
    invoice,
    price: {
      livemode: false,
      id: "price_monthly_half",
      product: "prod_sidestream",
      active: true,
      type: "recurring",
      currency: "usd",
      unit_amount: 1000,
      recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
    },
    product: { id: "prod_sidestream", active: true, deleted: false, livemode: false },
    expected,
  };
}

test("completed monthly Checkout requires exact provider and immutable snapshot truth", () => {
  const fixture = subscriptionTruth();
  assert.deepEqual(verifyUpgradePricingSubscriptionTruth(fixture), {
    ok: true,
    subscriptionId: "sub_monthly",
    customerId: "cus_owner",
    invoiceId: "in_initial",
    priceId: "price_monthly_half",
    productId: "prod_sidestream",
    status: "active",
    currentPeriodEndMs: 1_800_000_000_000,
    cancelAtPeriodEnd: false,
    invoicePaid: true,
  });

  const mismatches = [
    ["customer", (value) => { value.customer.id = "cus_attacker"; }, "customer_mismatch"],
    ["subscription owner", (value) => { value.subscription.customer = "cus_attacker"; }, "subscription_identity_mismatch"],
    ["activation metadata", (value) => { value.subscription.metadata.sidestream_activation_key = "forged"; }, "subscription_identity_mismatch"],
    ["Checkout quantity", (value) => { value.session.line_items.data[0].quantity = 2; }, "checkout_line_item_mismatch"],
    ["subscription quantity", (value) => { value.subscription.items.data[0].quantity = 2; }, "subscription_item_mismatch"],
    ["Product", (value) => { value.product.id = "prod_attacker"; }, "subscription_product_mismatch"],
    ["Price", (value) => { value.price.id = "price_attacker"; }, "subscription_price_mismatch"],
    ["currency", (value) => { value.invoice.currency = "eur"; }, "invoice_identity_mismatch"],
    ["amount", (value) => { value.invoice.total = 999; }, "invoice_line_item_mismatch"],
    ["interval", (value) => { value.price.recurring.interval = "year"; }, "subscription_price_mismatch"],
    ["namespace", (value) => { value.invoice.livemode = true; }, "provider_namespace_mismatch"],
  ];
  for (const [name, mutate, reason] of mismatches) {
    const value = structuredClone(fixture);
    mutate(value);
    assert.deepEqual(
      verifyUpgradePricingSubscriptionTruth(value),
      { ok: false, reason },
      name,
    );
  }
});

test("first and renewal invoices are exact and failed settlement cannot look paid", () => {
  const renewal = subscriptionTruth({
    invoiceId: "in_renewal",
    invoiceEventType: "invoice.paid",
  });
  assert.equal(verifyUpgradePricingSubscriptionTruth(renewal).ok, true);

  const failed = subscriptionTruth({
    invoiceId: "in_failed",
    invoicePaid: false,
    status: "past_due",
    invoiceEventType: "invoice.payment_failed",
  });
  const failedResult = verifyUpgradePricingSubscriptionTruth(failed);
  assert.equal(failedResult.ok, true);
  assert.equal(failedResult.invoicePaid, false);

  failed.expected.invoiceEventType = "invoice.paid";
  assert.deepEqual(verifyUpgradePricingSubscriptionTruth(failed), {
    ok: false,
    reason: "invoice_not_paid",
  });
});

test("current and legacy Stripe invoice line ancestry remain exact", () => {
  const current = subscriptionTruth();
  assert.equal(verifyUpgradePricingSubscriptionTruth(current).ok, true);

  const wrongParent = structuredClone(current);
  wrongParent.invoice.lines.data[0].parent.type = "invoice_item_details";
  assert.deepEqual(verifyUpgradePricingSubscriptionTruth(wrongParent), {
    ok: false,
    reason: "invoice_line_item_mismatch",
  });

  const legacy = structuredClone(current);
  const line = legacy.invoice.lines.data[0];
  line.subscription = line.parent.subscription_item_details.subscription;
  line.price = line.pricing.price_details.price;
  delete line.parent;
  delete line.pricing;
  legacy.invoice.subscription = legacy.invoice.parent.subscription_details.subscription;
  legacy.invoice.subscription_details = legacy.invoice.parent.subscription_details;
  legacy.invoice.paid = true;
  delete legacy.invoice.payments;
  delete legacy.invoice.parent;
  assert.equal(verifyUpgradePricingSubscriptionTruth(legacy).ok, true);
});

test("dunning, recovery, paid-through cancellation, and deletion are conservative", () => {
  const base = {
    status: "active",
    currentPeriodEndMs: 20_000,
    cancelAtPeriodEnd: false,
    invoicePaid: true,
    eventType: "customer.subscription.updated",
    eventCreatedAtMs: 10_000,
  };
  assert.deepEqual(planUpgradePricingSubscriptionTransition(base), {
    entitlementStatus: "active",
    statusReason: "subscription_active",
    revokeCredentials: false,
    graceUntilMs: null,
  });
  assert.equal(planUpgradePricingSubscriptionTransition({
    ...base,
    status: "trialing",
  }).entitlementStatus, "active");
  assert.deepEqual(planUpgradePricingSubscriptionTransition({
    ...base,
    cancelAtPeriodEnd: true,
  }), {
    entitlementStatus: "active",
    statusReason: "subscription_cancel_at_period_end",
    revokeCredentials: false,
    graceUntilMs: 20_000,
  });
  assert.equal(planUpgradePricingSubscriptionTransition({
    ...base,
    cancelAtPeriodEnd: true,
    eventCreatedAtMs: 20_000,
  }).statusReason, "subscription_paid_period_ended");

  for (const status of ["incomplete", "past_due"]) {
    const transition = planUpgradePricingSubscriptionTransition({ ...base, status });
    assert.equal(transition.entitlementStatus, "suspended", status);
    assert.equal(transition.revokeCredentials, true, status);
  }
  for (const status of ["unpaid", "canceled", "incomplete_expired", "paused"]) {
    const transition = planUpgradePricingSubscriptionTransition({ ...base, status });
    assert.equal(transition.entitlementStatus, "revoked", status);
    assert.equal(transition.revokeCredentials, true, status);
  }
  assert.equal(planUpgradePricingSubscriptionTransition({
    ...base,
    eventType: "invoice.payment_failed",
    invoicePaid: false,
  }).statusReason, "invoice_payment_failed");
  assert.equal(planUpgradePricingSubscriptionTransition({
    ...base,
    eventType: "invoice.paid",
    storedEntitlementStatus: "suspended",
    storedStatusReason: "invoice_payment_failed",
  }).statusReason, "invoice_payment_recovered");
  assert.equal(planUpgradePricingSubscriptionTransition({
    ...base,
    eventType: "customer.subscription.deleted",
  }).statusReason, "subscription_deleted");
  assert.equal(planUpgradePricingSubscriptionTransition({
    ...base,
    eventType: "invoice.paid",
    storedEntitlementStatus: "revoked",
    storedStatusReason: "subscription_deleted",
  }).entitlementStatus, "revoked");
});

test("duplicate and stale subscription events cannot overwrite newer truth", () => {
  const current = { createdAtMs: 5_000, eventId: "evt_current" };
  assert.equal(shouldApplyStripeEventWatermark(current, current), false);
  assert.equal(shouldApplyStripeEventWatermark(current, {
    createdAtMs: 4_999,
    eventId: "evt_old",
  }), false);
  assert.equal(shouldApplyStripeEventWatermark(current, {
    createdAtMs: 5_000,
    eventId: "evt_z",
  }), true);
});

test("runtime keeps experiment subscriptions separate and preserves activation binding", async () => {
  const [accountSource, eventsSource] = await Promise.all([
    readFile(new URL("../api/_lib/account.ts", import.meta.url), "utf8"),
    readFile(new URL("../api/_lib/stripe-events.ts", import.meta.url), "utf8"),
  ]);
  assert.match(accountSource, /export async function reconcileUpgradePricingSubscription/);
  assert.doesNotMatch(accountSource, /upgrade_subscription_fulfillment_pending/);
  assert.match(
    accountSource,
    /snapshot\.variant !== "monthly_half"[\s\S]*snapshot\.billingModel !== "subscription"/,
  );
  assert.match(accountSource, /legacy_subscription_eligible, legacy_subscription_audited_at/);
  assert.match(accountSource, /legacy_subscription_eligible[\s\S]*false, null, null/);
  assert.match(accountSource, /update public\.sidestream_activation_sessions[\s\S]*license_id = \$4/);
  assert.doesNotMatch(
    accountSource.slice(
      accountSource.indexOf("export async function reconcileUpgradePricingSubscription"),
      accountSource.indexOf("function upgradePricingSubscriptionMetadata"),
    ),
    /set account_id = null|set license_id = null/,
  );
  assert.match(accountSource, /hasCanonicalActivePaidLicense\(options\.session\.accountId, client\)/);
  assert.match(accountSource, /hasCanonicalActivePaidLicense\(row\.account_id, client\)/);

  for (const eventType of [
    "checkout.session.completed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.paid",
    "invoice.payment_failed",
  ]) {
    assert.match(eventsSource, new RegExp(eventType.replaceAll(".", "\\.")));
  }
  assert.match(eventsSource, /upgrade_subscription_[\s\S]*StripeEventProcessingError/);
  assert.match(eventsSource, /attempt_count >= \$4/);
  assert.match(eventsSource, /attempt_limit_exhausted/);
});

test("unrelated refund and terminal dispute blockers remain explicit", async () => {
  const eventsSource = await readFile(
    new URL("../api/_lib/stripe-events.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(eventsSource, /case "refund\.failed"/);
  assert.match(eventsSource, /refund\.failed[\s\S]*warning_closed\/prevented[\s\S]*blocker/);
});

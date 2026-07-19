import assert from "node:assert/strict";
import test from "node:test";
import {
  CustomerCommerceNormalizationError,
  materializeCustomerCommerceEvent as materializeCustomerCommerceEventWithNamespace,
  normalizeCustomerCommerceEvent as normalizeCustomerCommerceEventWithNamespace,
} from "../../api/_lib/customer-commerce.ts";

const normalizeCustomerCommerceEvent = (event) =>
  normalizeCustomerCommerceEventWithNamespace(event, "test");
const materializeCustomerCommerceEvent = (event, query) =>
  materializeCustomerCommerceEventWithNamespace(event, query, "test");

test("Checkout, PaymentIntent, charge, and invoice normalize without floating money", () => {
  const checkout = only(normalizeCustomerCommerceEvent(stripeEvent(
    "evt_checkout",
    "checkout.session.completed",
    1_720_000_100,
    {
      id: "cs_paid",
      object: "checkout.session",
      created: 1_720_000_000,
      customer: "cus_customer",
      payment_intent: "pi_payment",
      mode: "payment",
      payment_status: "paid",
      amount_total: 999,
      currency: "USD",
      total_details: { amount_discount: 200, amount_tax: 75 },
    },
  )));
  assert.deepEqual(pickMoney(checkout), {
    factKind: "payment",
    commerceModel: "one_time",
    currency: "usd",
    grossPaidMinor: 999,
    discountMinor: 200,
    taxMinor: 75,
    refundedMinor: 0,
    disputedMinor: 0,
    inquiryMinor: 0,
    netPaidMinor: 999,
  });
  assert.equal(checkout.paymentKey, "payment_intent:pi_payment");
  assert.equal(checkout.paidAt, "2024-07-03T09:48:20.000Z");
  assert.equal(checkout.objectCreatedAt, "2024-07-03T09:46:40.000Z");
  assert.equal(checkout.timestampSource, "stripe_event");
  assert.equal(checkout.sourceConfidence, "verified");
  assert.deepEqual(checkout.identityEvidence, [
    { linkType: "stripe_customer", linkValue: "cus_customer" },
    { linkType: "stripe_payment_intent", linkValue: "pi_payment" },
    { linkType: "stripe_checkout_session", linkValue: "cs_paid" },
  ]);

  const paymentIntent = only(normalizeCustomerCommerceEvent(stripeEvent(
    "evt_pi",
    "payment_intent.succeeded",
    1_720_000_110,
    {
      id: "pi_payment",
      created: 1_720_000_010,
      customer: "cus_customer",
      latest_charge: "ch_payment",
      status: "succeeded",
      amount: 999,
      amount_received: 999,
      currency: "usd",
    },
  )));
  const charge = only(normalizeCustomerCommerceEvent(stripeEvent(
    "evt_charge",
    "charge.succeeded",
    1_720_000_120,
    {
      id: "ch_payment",
      created: 1_720_000_020,
      customer: "cus_customer",
      payment_intent: "pi_payment",
      paid: true,
      status: "succeeded",
      amount: 999,
      amount_captured: 400,
      amount_refunded: 0,
      currency: "usd",
    },
  )));
  assert.equal(paymentIntent.paymentKey, "payment_intent:pi_payment");
  assert.equal(charge.paymentKey, "payment_intent:pi_payment");
  assert.equal(paymentIntent.paidAt, "2024-07-03T09:48:30.000Z");
  assert.equal(paymentIntent.objectCreatedAt, "2024-07-03T09:46:50.000Z");
  assert.equal(paymentIntent.timestampSource, "stripe_event");
  assert.equal(charge.grossPaidMinor, 400);
  assert.ok(paymentIntent.aliases.some((alias) => alias.aliasId === "pi_payment"));
  assert.ok(paymentIntent.aliases.some((alias) => alias.aliasId === "ch_payment"));

  const invoice = only(normalizeCustomerCommerceEvent(stripeEvent(
    "evt_invoice",
    "invoice.paid",
    1_720_000_200,
    {
      id: "in_renewal",
      created: 1_719_999_000,
      customer: "cus_customer",
      parent: {
        type: "subscription_details",
        subscription_details: { subscription: "sub_customer" },
      },
      payments: {
        data: [{
          id: "inpay_renewal",
          object: "invoice_payment",
          status: "paid",
          amount_paid: 999,
          currency: "eur",
          invoice: "in_renewal",
          payment: {
            type: "payment_intent",
            payment_intent: "pi_renewal",
          },
        }],
      },
      status: "paid",
      paid: true,
      amount_paid: 999,
      currency: "eur",
      total_discount_amounts: [{ amount: 100 }],
      total_tax_amounts: [{ amount: 50 }],
      period_start: 1_719_000_000,
      period_end: 1_721_592_000,
      status_transitions: { paid_at: 1_720_000_190 },
    },
  )));
  assert.equal(invoice.commerceModel, "subscription");
  assert.equal(invoice.paymentKey, "invoice:in_renewal");
  assert.equal(invoice.discountMinor, 100);
  assert.equal(invoice.taxMinor, 50);
  assert.equal(invoice.timestampSource, "stripe_status_transition");
  assert.equal(invoice.billingPeriodStart, "2024-06-21T20:00:00.000Z");
  assert.equal(invoice.billingPeriodEnd, "2024-07-21T20:00:00.000Z");
  assert.deepEqual(invoice.invoicePayments, [{
    invoicePaymentId: "inpay_renewal",
    invoiceId: "in_renewal",
    status: "paid",
    amountPaidMinor: 999,
    currency: "eur",
    instrumentType: "payment_intent",
    instrumentId: "pi_renewal",
  }]);
  assert.equal(invoice.aliases.some((alias) => alias.aliasId === "pi_renewal"), false);
  assert.ok(invoice.identityEvidence.some((evidence) =>
    evidence.linkType === "stripe_subscription" && evidence.linkValue === "sub_customer"
  ));
});

test("successful object snapshots only emit paid dates on success or capture transitions", () => {
  const paymentIntentUpdate = only(normalizeCustomerCommerceEvent(stripeEvent(
    "evt_pi_metadata_update",
    "payment_intent.updated",
    1_720_001_000,
    {
      id: "pi_already_paid",
      created: 1_720_000_000,
      latest_charge: "ch_already_paid",
      status: "succeeded",
      amount_received: 999,
      currency: "usd",
    },
  )));
  const chargeUpdate = only(normalizeCustomerCommerceEvent(stripeEvent(
    "evt_charge_refund_update",
    "charge.updated",
    1_720_001_100,
    {
      id: "ch_already_paid",
      created: 1_720_000_010,
      payment_intent: "pi_already_paid",
      paid: true,
      captured: true,
      status: "succeeded",
      amount_captured: 999,
      amount_refunded: 100,
      currency: "usd",
    },
  )));

  for (const observation of [paymentIntentUpdate, chargeUpdate]) {
    assert.equal(observation.grossPaidMinor, 999);
    assert.equal(observation.paidAt, null);
    assert.equal(observation.upgradedAt, null);
    assert.equal(observation.timestampSource, "stripe_object");
  }
});

test("zero-cost and explicit manual commerce remain upgrades without invented paid money", () => {
  const comped = only(normalizeCustomerCommerceEvent(stripeEvent(
    "evt_comped",
    "checkout.session.completed",
    1_730_000_000,
    {
      id: "cs_comped",
      customer: "cus_comped",
      mode: "payment",
      payment_status: "no_payment_required",
      amount_total: 0,
      currency: "usd",
      total_details: { amount_discount: 999, amount_tax: 0 },
    },
  )));
  assert.equal(comped.commerceModel, "comped");
  assert.equal(comped.grossPaidMinor, 0);
  assert.equal(comped.netPaidMinor, 0);
  assert.equal(comped.paidAt, null);
  assert.equal(comped.upgradedAt, "2024-10-27T03:33:20.000Z");
  assert.equal(comped.sourceConfidence, "verified");

  const manual = only(normalizeCustomerCommerceEvent(stripeEvent(
    "evt_manual",
    "customer_cash_balance_transaction.created",
    1_730_000_100,
    {
      id: "cbtxn_manual",
      customer: "cus_comped",
      type: "adjustment",
      metadata: {
        sidestream_commerce_model: "comped",
        sidestream_upgraded_at: "2024-10-27T04:00:00.000Z",
      },
    },
  )));
  assert.equal(manual.factKind, "manual");
  assert.equal(manual.source, "manual_metadata");
  assert.equal(manual.upgradedAt, "2024-10-27T04:00:00.000Z");
  assert.equal(manual.grossPaidMinor, 0);

  const legacy = only(normalizeCustomerCommerceEvent(stripeEvent(
    "evt_legacy",
    "customer.subscription.updated",
    1_730_000_200,
    {
      id: "sub_legacy",
      customer: "cus_comped",
      status: "active",
      items: {
        data: [{
          id: "si_legacy",
          current_period_start: 1_730_000_000,
          current_period_end: 1_732_592_000,
        }],
      },
    },
  )));
  assert.equal(legacy.objectCreatedAt, null);
  assert.equal(legacy.effectiveAt, "2024-10-27T03:36:40.000Z");
  assert.equal(legacy.timestampSource, "legacy_event_inference");
  assert.equal(legacy.sourceConfidence, "legacy_inferred");
  assert.equal(legacy.upgradedAt, legacy.effectiveAt);
  assert.equal(legacy.billingPeriodStart, "2024-10-27T03:33:20.000Z");
  assert.equal(legacy.billingPeriodEnd, "2024-11-26T03:33:20.000Z");
});

test("refund failures and every dispute terminal class preserve the correct money", () => {
  const refund = (id, eventType, status, created) => only(
    normalizeCustomerCommerceEvent(stripeEvent(id, eventType, created, {
      id: "re_shared",
      charge: "ch_shared",
      payment_intent: "pi_shared",
      status,
      amount: 400,
      currency: "usd",
      created: 1_740_000_000,
    })),
  );
  assert.equal(refund("evt_refund_ok", "refund.updated", "succeeded", 1_740_000_100)
    .refundedMinor, 400);
  assert.equal(refund("evt_refund_failed", "refund.failed", "failed", 1_740_000_200)
    .refundedMinor, 0);
  const chargeRefundUpdated = refund(
    "evt_charge_refund_updated",
    "charge.refund.updated",
    "succeeded",
    1_740_000_300,
  );
  assert.equal(chargeRefundUpdated.sourceObjectType, "refund");
  assert.equal(chargeRefundUpdated.factKind, "refund");
  assert.equal(chargeRefundUpdated.grossPaidMinor, 0);
  assert.equal(chargeRefundUpdated.refundedMinor, 400);

  for (const [status, disputed, inquiry] of [
    ["needs_response", 999, 0],
    ["under_review", 999, 0],
    ["warning_needs_response", 0, 999],
    ["warning_under_review", 0, 999],
    ["lost", 999, 0],
    ["won", 0, 0],
    ["warning_closed", 0, 0],
    ["prevented", 0, 0],
  ]) {
    const dispute = only(normalizeCustomerCommerceEvent(stripeEvent(
      `evt_${status}`,
      "charge.dispute.updated",
      1_740_001_000,
      {
        id: `dp_${status}`,
        charge: "ch_shared",
        status,
        amount: 999,
        currency: "usd",
        created: 1_740_000_900,
      },
    )));
    assert.equal(dispute.disputedMinor, disputed, status);
    assert.equal(dispute.inquiryMinor, inquiry, status);
    assert.equal(dispute.netPaidMinor, 0);
  }
});

test("current InvoicePayment edges retain allocation state without aliasing invoice graphs", () => {
  const invoice = only(normalizeCustomerCommerceEvent(stripeEvent(
    "evt_current_invoice_payments",
    "invoice.paid",
    1_744_000_000,
    {
      id: "in_current_payments",
      object: "invoice",
      paid: true,
      status: "paid",
      amount_paid: 1000,
      amount_paid_off_stripe: 200,
      currency: "usd",
      payments: {
        data: [
          {
            id: "inpay_current_paid",
            object: "invoice_payment",
            status: "paid",
            amount_paid: 800,
            currency: "usd",
            invoice: "in_current_payments",
            payment: {
              type: "payment_intent",
              payment_intent: "pi_current_paid",
            },
          },
          {
            id: "inpay_current_open",
            object: "invoice_payment",
            status: "open",
            amount_paid: null,
            currency: "usd",
            invoice: "in_current_payments",
            payment: { type: "charge", charge: "ch_current_open" },
          },
        ],
      },
      status_transitions: { paid_at: 1_743_999_990 },
    },
  )));

  assert.equal(invoice.grossPaidMinor, 1000);
  assert.equal(invoice.offStripePaidMinor, 200);
  assert.equal(invoice.netPaidMinor, 1000);
  assert.equal(invoice.source, "manual_metadata");
  assert.equal(invoice.paymentKey, "invoice:in_current_payments");
  assert.deepEqual(invoice.invoicePayments, [
    {
      invoicePaymentId: "inpay_current_paid",
      invoiceId: "in_current_payments",
      status: "paid",
      amountPaidMinor: 800,
      currency: "usd",
      instrumentType: "payment_intent",
      instrumentId: "pi_current_paid",
    },
    {
      invoicePaymentId: "inpay_current_open",
      invoiceId: "in_current_payments",
      status: "open",
      amountPaidMinor: 0,
      currency: "usd",
      instrumentType: "charge",
      instrumentId: "ch_current_open",
    },
  ]);
  assert.deepEqual(invoice.aliases, [{ aliasType: "invoice", aliasId: "in_current_payments" }]);
  assert.ok(invoice.identityEvidence.some((evidence) =>
    evidence.linkType === "stripe_payment_intent" &&
    evidence.linkValue === "pi_current_paid"
  ));
  assert.equal(invoice.identityEvidence.some((evidence) =>
    evidence.linkValue === "ch_current_open"
  ), false);

  const fullyOffStripe = only(normalizeCustomerCommerceEvent(stripeEvent(
    "evt_fully_off_stripe",
    "invoice.paid",
    1_744_000_100,
    {
      id: "in_fully_off_stripe",
      object: "invoice",
      paid: true,
      status: "paid",
      amount_paid: 700,
      amount_paid_off_stripe: 700,
      paid_out_of_band: true,
      currency: "gbp",
      payments: { data: [] },
      status_transitions: { paid_at: 1_744_000_090 },
    },
  )));
  assert.equal(fullyOffStripe.grossPaidMinor, 700);
  assert.equal(fullyOffStripe.offStripePaidMinor, 700);
  assert.equal(fullyOffStripe.netPaidMinor, 700);
});

test("legacy invoice fields remain compatible without joining subscription renewals", () => {
  const first = only(normalizeCustomerCommerceEvent(stripeEvent(
    "evt_legacy_invoice_one",
    "invoice.paid",
    1_745_000_000,
    {
      id: "in_legacy_one",
      subscription: "sub_legacy",
      payment_intent: "pi_legacy_one",
      charge: "ch_legacy_one",
      status: "paid",
      paid: true,
      amount_paid: 500,
      currency: "usd",
    },
  )));
  const second = only(normalizeCustomerCommerceEvent(stripeEvent(
    "evt_legacy_invoice_two",
    "invoice.paid",
    1_745_000_100,
    {
      id: "in_legacy_two",
      subscription: "sub_legacy",
      payment_intent: "pi_legacy_two",
      charge: "ch_legacy_two",
      status: "paid",
      paid: true,
      amount_paid: 500,
      currency: "usd",
    },
  )));
  assert.equal(first.commerceModel, "subscription");
  assert.equal(second.commerceModel, "subscription");
  assert.notEqual(first.paymentKey, second.paymentKey);
  assert.equal(first.aliases.some((alias) => alias.aliasType === "subscription"), false);
});

test("trusted namespace rejects a signed livemode mismatch", () => {
  const event = stripeEvent(
    "evt_namespace_mismatch",
    "charge.succeeded",
    1_750_000_000,
    {
      id: "ch_namespace_mismatch",
      paid: true,
      status: "succeeded",
      amount_captured: 100,
      currency: "usd",
    },
    true,
  );
  assert.throws(
    () => normalizeCustomerCommerceEventWithNamespace(event, "test"),
    (error) => {
      assert.equal(error.code, "stripe_event_namespace_mismatch");
      return true;
    },
  );
});

test("minor units require a real ISO currency and never accept fractional values", () => {
  assert.throws(() => normalizeCustomerCommerceEvent(stripeEvent(
    "evt_no_currency",
    "charge.succeeded",
    1_750_000_000,
    { id: "ch_bad", paid: true, amount_captured: 999, status: "succeeded" },
  )), (error) => {
    assert.ok(error instanceof CustomerCommerceNormalizationError);
    assert.equal(error.code, "currency_required_for_money");
    return true;
  });
  assert.throws(() => normalizeCustomerCommerceEvent(stripeEvent(
    "evt_fraction",
    "charge.succeeded",
    1_750_000_000,
    { id: "ch_bad", paid: true, amount_captured: 9.99, currency: "usd", status: "succeeded" },
  )), /invalid_minor_unit_amount/);
  assert.throws(() => normalizeCustomerCommerceEvent(stripeEvent(
    "evt_aggregate_overflow",
    "invoice.paid",
    1_750_000_000,
    {
      id: "in_aggregate_overflow",
      status: "paid",
      paid: true,
      amount_paid: 1,
      currency: "usd",
      total_discount_amounts: [
        { amount: Number.MAX_SAFE_INTEGER },
        { amount: 1 },
      ],
    },
  )), (error) => {
    assert.ok(error instanceof CustomerCommerceNormalizationError);
    assert.equal(error.code, "minor_unit_amount_overflow");
    return true;
  });
});

test("the projector sends one bounded batch and leaves unsupported events untouched", async () => {
  const calls = [];
  const projected = await materializeCustomerCommerceEvent(stripeEvent(
    "evt_project",
    "invoice.paid",
    1_760_000_000,
    {
      id: "in_project",
      status: "paid",
      paid: true,
      amount_paid: 1200,
      currency: "cad",
      customer: "cus_project",
    },
  ), async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{ result: { applied: 1, stale: 0 } }] };
  });
  assert.deepEqual(projected, {
    recognized: true,
    observationCount: 1,
    applied: 1,
    stale: 0,
    licenseNamespace: "test",
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /sidestream_customer_commerce_apply/);
  const payload = JSON.parse(calls[0].params[0]);
  assert.equal(payload[0].currency, "cad");
  assert.equal(payload[0].licenseNamespace, "test");

  let queried = false;
  const unsupported = await materializeCustomerCommerceEvent(stripeEvent(
    "evt_unsupported",
    "product.updated",
    1_760_000_001,
    { id: "prod_unsupported" },
  ), async () => {
    queried = true;
    return { rows: [] };
  });
  assert.equal(queried, false);
  assert.equal(unsupported.recognized, false);
});

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

function only(observations) {
  assert.equal(observations.length, 1);
  return observations[0];
}

function pickMoney(observation) {
  return {
    factKind: observation.factKind,
    commerceModel: observation.commerceModel,
    currency: observation.currency,
    grossPaidMinor: observation.grossPaidMinor,
    discountMinor: observation.discountMinor,
    taxMinor: observation.taxMinor,
    refundedMinor: observation.refundedMinor,
    disputedMinor: observation.disputedMinor,
    inquiryMinor: observation.inquiryMinor,
    netPaidMinor: observation.netPaidMinor,
  };
}

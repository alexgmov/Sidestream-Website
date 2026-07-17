import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canonicalLicenseEntitlementRank,
  isCanonicalLicenseEntitlementUsable,
  parseStripeIdAllowlist,
  planOneTimeEntitlementTransition,
  shouldApplyStripeEventWatermark,
  verifyLegacySubscriptionEntitlement,
} from "../api/_lib/entitlement.ts";
import {
  parseAllowlist,
  parseArgs,
  verifyLegacySubscription,
} from "../scripts/audit-legacy-subscriptions.mjs";

const paidFacts = Object.freeze({
  paymentIntentId: "pi_purchase",
  chargeId: "ch_purchase",
  customerId: "cus_purchase",
  amountPaid: 999,
  amountRefunded: 0,
  currency: "usd",
  paymentProven: true,
  disputeStatus: "none",
});

const activeStored = Object.freeze({
  paymentIntentId: "pi_purchase",
  chargeId: "ch_purchase",
  customerId: "cus_purchase",
  entitlementStatus: "active",
  statusReason: "payment_paid",
  stripeEventCreatedAtMs: 1_000,
  stripeEventId: "evt_checkout",
});

const event = (createdAtMs, eventId) => ({ createdAtMs, eventId });

test("partial refunds stay active while full and cumulative refunds revoke", () => {
  const partial = planOneTimeEntitlementTransition({
    stored: activeStored,
    facts: { ...paidFacts, amountRefunded: 400 },
    event: event(2_000, "evt_partial"),
  });
  assert.deepEqual(partial, {
    apply: true,
    entitlementStatus: "active",
    statusReason: "partial_refund",
    revokeCredentials: false,
  });

  const full = planOneTimeEntitlementTransition({
    stored: activeStored,
    facts: { ...paidFacts, amountRefunded: 999 },
    event: event(2_000, "evt_full"),
  });
  assert.deepEqual(full, {
    apply: true,
    entitlementStatus: "revoked",
    statusReason: "full_refund",
    revokeCredentials: true,
  });

  const cumulative = planOneTimeEntitlementTransition({
    stored: {
      ...activeStored,
      statusReason: "partial_refund",
      stripeEventCreatedAtMs: 2_000,
      stripeEventId: "evt_partial",
    },
    facts: { ...paidFacts, amountRefunded: 1_100 },
    event: event(3_000, "evt_cumulative"),
  });
  assert.equal(cumulative.entitlementStatus, "revoked");
  assert.equal(cumulative.statusReason, "full_refund");
  assert.equal(cumulative.revokeCredentials, true);
});

test("disputes suspend immediately, lost stays revoked, and won restores only paid truth", () => {
  const opened = planOneTimeEntitlementTransition({
    stored: activeStored,
    facts: { ...paidFacts, disputeStatus: "needs_response" },
    event: event(2_000, "evt_dispute_open"),
  });
  assert.deepEqual(opened, {
    apply: true,
    entitlementStatus: "suspended",
    statusReason: "dispute_open",
    revokeCredentials: true,
  });

  const lost = planOneTimeEntitlementTransition({
    stored: {
      ...activeStored,
      entitlementStatus: "suspended",
      statusReason: "dispute_open",
      stripeEventCreatedAtMs: 2_000,
      stripeEventId: "evt_dispute_open",
    },
    facts: { ...paidFacts, disputeStatus: "lost" },
    event: event(3_000, "evt_dispute_lost"),
  });
  assert.equal(lost.entitlementStatus, "revoked");
  assert.equal(lost.statusReason, "dispute_lost");

  const won = planOneTimeEntitlementTransition({
    stored: {
      ...activeStored,
      entitlementStatus: "suspended",
      statusReason: "dispute_open",
      stripeEventCreatedAtMs: 2_000,
      stripeEventId: "evt_dispute_open",
    },
    facts: { ...paidFacts, amountRefunded: 200, disputeStatus: "won" },
    event: event(3_000, "evt_dispute_won"),
  });
  assert.equal(won.entitlementStatus, "active");
  assert.equal(won.statusReason, "dispute_won");
  assert.equal(won.revokeCredentials, false);

  const unrelatedPaidUpdateCannotRestore = planOneTimeEntitlementTransition({
    stored: {
      ...activeStored,
      entitlementStatus: "suspended",
      statusReason: "dispute_open",
    },
    facts: paidFacts,
    event: event(3_000, "evt_charge_update"),
  });
  assert.equal(unrelatedPaidUpdateCannotRestore.entitlementStatus, "suspended");
  assert.equal(unrelatedPaidUpdateCannotRestore.statusReason, "dispute_open");

  const wonButUnpaid = planOneTimeEntitlementTransition({
    stored: {
      ...activeStored,
      entitlementStatus: "suspended",
      statusReason: "dispute_open",
    },
    facts: { ...paidFacts, paymentProven: false, disputeStatus: "won" },
    event: event(3_000, "evt_unpaid_won"),
  });
  assert.equal(wonButUnpaid.entitlementStatus, "revoked");
  assert.equal(wonButUnpaid.statusReason, "payment_not_paid");

  const lostCannotResurrect = planOneTimeEntitlementTransition({
    stored: {
      ...activeStored,
      entitlementStatus: "revoked",
      statusReason: "dispute_lost",
    },
    facts: { ...paidFacts, disputeStatus: "won" },
    event: event(4_000, "evt_late_won"),
  });
  assert.equal(lostCannotResurrect.entitlementStatus, "revoked");
  assert.equal(lostCannotResurrect.statusReason, "dispute_lost");
});

test("duplicate and out-of-order events no-op and delayed Checkout cannot resurrect", () => {
  const current = event(5_000, "evt_refund");
  assert.equal(shouldApplyStripeEventWatermark(current, current), false);
  assert.equal(shouldApplyStripeEventWatermark(current, event(4_000, "evt_old")), false);
  assert.equal(shouldApplyStripeEventWatermark(current, event(5_000, "evt_z")), true);

  assert.deepEqual(planOneTimeEntitlementTransition({
    stored: {
      ...activeStored,
      entitlementStatus: "revoked",
      statusReason: "full_refund",
      stripeEventCreatedAtMs: 5_000,
      stripeEventId: "evt_refund",
    },
    facts: paidFacts,
    event: event(4_000, "evt_delayed_checkout"),
  }), { apply: false, reason: "stale_event" });

  const newerCheckoutStillCannotResurrect = planOneTimeEntitlementTransition({
    stored: {
      ...activeStored,
      entitlementStatus: "revoked",
      statusReason: "full_refund",
      stripeEventCreatedAtMs: 5_000,
      stripeEventId: "evt_refund",
    },
    facts: paidFacts,
    event: event(6_000, "evt_checkout_replay"),
  });
  assert.equal(newerCheckoutStillCannotResurrect.entitlementStatus, "revoked");
  assert.equal(newerCheckoutStillCannotResurrect.statusReason, "full_refund");
});

test("wrong PaymentIntent or Charge identity is rejected", () => {
  assert.deepEqual(planOneTimeEntitlementTransition({
    stored: activeStored,
    facts: { ...paidFacts, paymentIntentId: "pi_attacker" },
    event: event(2_000, "evt_wrong_pi"),
  }), { apply: false, reason: "payment_intent_mismatch" });
  assert.deepEqual(planOneTimeEntitlementTransition({
    stored: activeStored,
    facts: { ...paidFacts, chargeId: "ch_attacker" },
    event: event(2_000, "evt_wrong_charge"),
  }), { apply: false, reason: "charge_mismatch" });
  assert.deepEqual(planOneTimeEntitlementTransition({
    stored: activeStored,
    facts: { ...paidFacts, customerId: "cus_attacker" },
    event: event(2_000, "evt_wrong_customer"),
  }), { apply: false, reason: "payment_customer_mismatch" });
});

test("legacy subscriptions require exact Product, Price, one item, and quantity one", () => {
  const subscription = {
    metadata: {
      sidestream_plan: "sidestream_pro",
      lookup_key: "sidestream_pro",
      nickname: "Sidestream Pro",
    },
    items: { data: [{ quantity: 1, price: "price_allowed" }], has_more: false },
  };
  const price = {
    id: "price_allowed",
    product: "prod_allowed",
    active: true,
    type: "recurring",
    currency: "usd",
    unit_amount: 499,
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
  };
  const product = { id: "prod_allowed", active: true };
  const allowlist = { priceIds: ["price_allowed"], productIds: ["prod_allowed"] };
  assert.deepEqual(
    verifyLegacySubscriptionEntitlement(subscription, price, product, allowlist),
    { ok: true, priceId: "price_allowed", productId: "prod_allowed" },
  );
  assert.equal(
    verifyLegacySubscriptionEntitlement(subscription, price, product, {
      priceIds: [],
      productIds: [],
    }).reason,
    "price_not_allowed",
  );
  assert.equal(
    verifyLegacySubscriptionEntitlement({
      ...subscription,
      items: { data: [{ quantity: 1, price: "price_attacker" }], has_more: false },
    }, {
      ...price,
      id: "price_attacker",
      product: "prod_attacker",
    }, {
      id: "prod_attacker",
      active: true,
    }, allowlist).reason,
    "price_not_allowed",
  );
  assert.equal(
    verifyLegacySubscriptionEntitlement(
      subscription,
      { ...price, id: "price_attacker" },
      product,
      allowlist,
    ).reason,
    "subscription_price_mismatch",
  );
  assert.equal(
    verifyLegacySubscriptionEntitlement({
      ...subscription,
      items: {
        data: [
          { quantity: 1, price: "price_allowed" },
          { quantity: 1, price: "price_allowed" },
        ],
        has_more: false,
      },
    }, price, product, allowlist).reason,
    "invalid_subscription_items",
  );
  assert.equal(
    verifyLegacySubscriptionEntitlement({
      ...subscription,
      items: { data: [{ quantity: 2, price: "price_allowed" }], has_more: false },
    }, price, product, allowlist).reason,
    "invalid_subscription_quantity",
  );
  assert.equal(
    verifyLegacySubscriptionEntitlement(
      subscription,
      { ...price, recurring: { ...price.recurring, interval: "year" } },
      product,
      allowlist,
    ).reason,
    "invalid_recurring_shape",
  );

  assert.deepEqual(
    verifyLegacySubscription(subscription, price, product, allowlist),
    verifyLegacySubscriptionEntitlement(subscription, price, product, allowlist),
  );
  assert.deepEqual(parseStripeIdAllowlist("price_a, bad,price_a", "price"), ["price_a"]);
  assert.deepEqual(parseStripeIdAllowlist(undefined, "price"), []);
  assert.deepEqual(parseAllowlist("prod_a, spoof,prod_a", "prod"), ["prod_a"]);
  assert.deepEqual(parseAllowlist(undefined, "prod"), []);
});

test("unknown active rows are denied and cannot shadow an older valid Pro row", () => {
  assert.equal(isCanonicalLicenseEntitlementUsable({
    planKey: "attacker_plan",
    entitlementStatus: "active",
  }), false);
  assert.equal(isCanonicalLicenseEntitlementUsable({
    planKey: "sidestream_pro",
    entitlementStatus: "unknown",
  }), false);
  assert.equal(isCanonicalLicenseEntitlementUsable({
    planKey: "sidestream_pro",
    entitlementStatus: "active",
  }), true);

  const candidates = [
    { planKey: "attacker_plan", entitlementStatus: "active", updatedAt: 3_000 },
    { planKey: "sidestream_pro", entitlementStatus: "active", updatedAt: 1_000 },
    { planKey: "sidestream_pro", entitlementStatus: "revoked", updatedAt: 4_000 },
  ].sort((left, right) =>
    canonicalLicenseEntitlementRank(left) - canonicalLicenseEntitlementRank(right) ||
    right.updatedAt - left.updatedAt
  );
  assert.equal(candidates[0].planKey, "sidestream_pro");
  assert.equal(candidates[0].entitlementStatus, "active");
});

test("runtime wiring persists lifecycle facts and atomically clears both credential types", async () => {
  const [
    accountSource,
    eventsSource,
    migrationSource,
    commerceSource,
    commerceMigrationSource,
  ] = await Promise.all([
    readFile(new URL("../api/_lib/account.ts", import.meta.url), "utf8"),
    readFile(new URL("../api/_lib/stripe-events.ts", import.meta.url), "utf8"),
    readFile(new URL(
      "../db/migrations/20260713204000_add_entitlement_lifecycle.sql",
      import.meta.url,
    ), "utf8"),
    readFile(new URL("../api/_lib/customer-commerce.ts", import.meta.url), "utf8"),
    readFile(new URL(
      "../db/migrations/20260715122000_add_customer_commerce_ledger.sql",
      import.meta.url,
    ), "utf8"),
  ]);
  for (const field of [
    "stripe_charge_id",
    "amount_paid",
    "amount_refunded",
    "currency",
    "entitlement_status",
    "status_reason",
    "revoked_at",
    "suspended_at",
    "reconciled_at",
  ]) {
    assert.match(migrationSource, new RegExp(`\\b${field}\\b`));
  }
  assert.match(accountSource, /async function revokeLicenseCredentials[\s\S]*refresh_token_hash = null/);
  assert.match(accountSource, /previous_refresh_token_hash = null/);
  assert.match(accountSource, /update public\.sidestream_license_tokens[\s\S]*where license_id = \$1/);
  assert.match(accountSource, /prices\.retrieve/);
  assert.match(accountSource, /products\.retrieve/);
  assert.match(eventsSource, /subscriptions\.retrieve/);
  assert.match(eventsSource, /materializeCustomerCommerceEvent/);
  for (const eventType of [
    "charge.refunded",
    "charge.dispute.created",
    "charge.dispute.closed",
  ]) {
    assert.match(eventsSource, new RegExp(eventType.replaceAll(".", "\\.")));
  }
  assert.match(accountSource, /to_jsonb\(l\) \? 'entitlement_status'/);
  assert.match(
    accountSource,
    /l\.stripe_checkout_session_id is not null[\s\S]*l\.status in \('active', 'trialing'\)[\s\S]*l\.plan_key in/,
  );
  assert.match(
    accountSource,
    /license_state\.entitlement_status = 'active'[\s\S]*l\.plan_key in/,
  );
  assert.doesNotMatch(commerceSource, /sidestream_licenses|entitlement_status/);
  assert.doesNotMatch(commerceMigrationSource, /(?:update|alter table) public\.sidestream_licenses/i);
  for (const status of ["warning_closed", "prevented", "lost", "won"]) {
    assert.match(commerceSource, new RegExp(`\\b${status}\\b`));
  }
});

test("legacy audit is read-only by default and apply is an explicit gated mode", () => {
  assert.deepEqual(parseArgs([]), {
    fixture: false,
    readOnly: true,
    apply: false,
    help: false,
    databaseUrlEnv: "",
    confirmation: "",
  });
  assert.throws(() => parseArgs(["--apply"]), /database-url-env/);
  assert.throws(
    () => parseArgs(["--apply", "--database-url-env", "SIDESTREAM_POSTGRES_URL_NON_POOLING"]),
    /--confirm/,
  );
  assert.throws(() => parseArgs(["--fixture", "--apply"]), /cannot apply/);
});

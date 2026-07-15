/** Money-only Customer 360 projection from verified Stripe events. */

import type Stripe from "stripe";

export const CUSTOMER_COMMERCE_MODELS = [
  "one_time",
  "subscription",
  "comped",
  "mixed",
] as const;

export type CustomerCommerceModel = (typeof CUSTOMER_COMMERCE_MODELS)[number];
export type CustomerCommerceNamespace = "production" | "test";
export type CustomerCommerceFactKind =
  | "payment"
  | "refund"
  | "dispute"
  | "subscription"
  | "discount"
  | "manual";

export type CustomerCommerceAlias = Readonly<{
  aliasType: string;
  aliasId: string;
}>;

export type CustomerCommerceIdentityEvidence = Readonly<{
  linkType:
    | "stripe_customer"
    | "stripe_checkout_session"
    | "stripe_payment_intent"
    | "stripe_subscription";
  linkValue: string;
}>;

export type CustomerCommerceObservation = Readonly<{
  licenseNamespace: CustomerCommerceNamespace;
  eventId: string;
  eventType: string;
  eventCreatedAt: string;
  sourceObjectType: string;
  sourceObjectId: string;
  factKind: CustomerCommerceFactKind;
  commerceModel: CustomerCommerceModel;
  state: string;
  currency: string | null;
  grossPaidMinor: number;
  discountMinor: number;
  taxMinor: number;
  refundedMinor: number;
  disputedMinor: number;
  inquiryMinor: number;
  netPaidMinor: number;
  paidAt: string | null;
  upgradedAt: string | null;
  objectCreatedAt: string | null;
  effectiveAt: string;
  billingPeriodStart: string | null;
  billingPeriodEnd: string | null;
  timestampSource:
    | "stripe_object"
    | "stripe_status_transition"
    | "stripe_event"
    | "legacy_event_inference";
  source: "stripe_object" | "stripe_embedded" | "manual_metadata";
  sourceConfidence: "verified" | "legacy_inferred";
  paymentKey: string;
  aliases: readonly CustomerCommerceAlias[];
  identityEvidence: readonly CustomerCommerceIdentityEvidence[];
}>;

type CustomerCommerceQueryResult = Readonly<{
  rows: readonly Record<string, unknown>[];
}>;

export type CustomerCommerceQuery = (
  text: string,
  params?: readonly unknown[],
) => Promise<CustomerCommerceQueryResult>;

export type CustomerCommerceProjectionResult = Readonly<{
  recognized: boolean;
  observationCount: number;
  applied: number;
  stale: number;
  licenseNamespace: CustomerCommerceNamespace;
}>;

const PAYMENT_MODE_METADATA_KEYS = [
  "sidestream_commerce_model",
  "commerce_model",
] as const;
const FORMAL_DISPUTE_STATUSES = new Set([
  "needs_response",
  "under_review",
  "lost",
]);
const INQUIRY_DISPUTE_STATUSES = new Set([
  "warning_needs_response",
  "warning_under_review",
]);
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);

export class CustomerCommerceNormalizationError extends TypeError {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CustomerCommerceNormalizationError";
    this.code = code;
  }
}

/**
 * Produces privacy-limited, integer-minor-unit observations only. The caller is
 * responsible for supplying events already verified by the Stripe webhook.
 */
export function normalizeCustomerCommerceEvent(
  event: Stripe.Event,
  trustedNamespace: CustomerCommerceNamespace,
): readonly CustomerCommerceObservation[] {
  assertEvent(event);
  assertTrustedNamespace(event, trustedNamespace);
  const object = recordValue(event.data?.object);
  const sourceObjectId = boundedId(object.id);
  if (!sourceObjectId) return [];

  const eventCreatedAt = unixTimestamp(event.created, "event_created");
  const type = event.type;

  if (type.startsWith("checkout.session.")) {
    return normalizeCheckout(event, object, trustedNamespace, eventCreatedAt, sourceObjectId);
  }
  if (type.startsWith("payment_intent.")) {
    return normalizePaymentIntent(event, object, trustedNamespace, eventCreatedAt, sourceObjectId);
  }
  if (type.startsWith("charge.dispute.")) {
    return normalizeDispute(event, object, trustedNamespace, eventCreatedAt, sourceObjectId);
  }
  if (type.startsWith("charge.")) {
    return normalizeCharge(event, object, trustedNamespace, eventCreatedAt, sourceObjectId);
  }
  if (type.startsWith("refund.")) {
    return normalizeRefund(event, object, trustedNamespace, eventCreatedAt, sourceObjectId);
  }
  if (type.startsWith("invoice.")) {
    return normalizeInvoice(event, object, trustedNamespace, eventCreatedAt, sourceObjectId);
  }
  if (type.startsWith("customer.subscription.")) {
    return normalizeSubscription(event, object, trustedNamespace, eventCreatedAt, sourceObjectId);
  }
  if (type.startsWith("customer.discount.") || type.startsWith("discount.")) {
    return normalizeDiscount(event, object, trustedNamespace, eventCreatedAt, sourceObjectId);
  }
  if (type.startsWith("customer.balance_transaction.")) {
    return normalizeManualAdjustment(
      event,
      object,
      trustedNamespace,
      eventCreatedAt,
      sourceObjectId,
    );
  }
  return [];
}

/** Applies one normalized event through the migration-owned atomic projector. */
export async function materializeCustomerCommerceEvent(
  event: Stripe.Event,
  query: CustomerCommerceQuery,
  trustedNamespace: CustomerCommerceNamespace,
): Promise<CustomerCommerceProjectionResult> {
  const observations = normalizeCustomerCommerceEvent(event, trustedNamespace);
  if (observations.length === 0) {
    return Object.freeze({
      recognized: false,
      observationCount: 0,
      applied: 0,
      stale: 0,
      licenseNamespace: trustedNamespace,
    });
  }
  const result = await query(
    `select public.sidestream_customer_commerce_apply($1::jsonb) as result`,
    [JSON.stringify(observations)],
  );
  const appliedResult = recordValue(result.rows[0]?.result);
  return Object.freeze({
    recognized: true,
    observationCount: observations.length,
    applied: nonnegativeInteger(appliedResult.applied),
    stale: nonnegativeInteger(appliedResult.stale),
    licenseNamespace: trustedNamespace,
  });
}

function normalizeCheckout(
  event: Stripe.Event,
  object: Record<string, unknown>,
  namespace: CustomerCommerceNamespace,
  eventCreatedAt: string,
  sourceObjectId: string,
) {
  const state = stringValue(object.payment_status) || checkoutEventState(event.type);
  const successful = state === "paid" || state === "no_payment_required" ||
    event.type === "checkout.session.async_payment_succeeded";
  const successTransition = event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded";
  const gross = successful ? money(object.amount_total) : 0;
  const details = recordValue(object.total_details);
  const discount = successful ? money(details.amount_discount) : 0;
  const tax = successful ? money(details.amount_tax) : 0;
  const currency = monetaryCurrency(object.currency, gross, discount, tax);
  const explicitModel = metadataModel(object);
  const zeroCost = successful && gross === 0;
  const model = explicitModel || (zeroCost
    ? "comped"
    : stringValue(object.mode) === "subscription" ? "subscription" : "one_time");
  const timing = eventTiming(object, eventCreatedAt, true);
  return [observation({
    event,
    object,
    namespace,
    eventCreatedAt,
    sourceObjectType: "checkout_session",
    sourceObjectId,
    factKind: "payment",
    commerceModel: model,
    state,
    currency,
    grossPaidMinor: gross,
    discountMinor: discount,
    taxMinor: tax,
    refundedMinor: 0,
    disputedMinor: 0,
    inquiryMinor: 0,
    paidAt: successful && successTransition && gross > 0 ? timing.effectiveAt : null,
    upgradedAt: successful && successTransition ? timing.effectiveAt : null,
    timing,
    source: explicitModel ? "manual_metadata" : "stripe_object",
  })];
}

function normalizePaymentIntent(
  event: Stripe.Event,
  object: Record<string, unknown>,
  namespace: CustomerCommerceNamespace,
  eventCreatedAt: string,
  sourceObjectId: string,
) {
  const state = stringValue(object.status) || paymentIntentEventState(event.type);
  const successful = state === "succeeded";
  const successTransition = event.type === "payment_intent.succeeded";
  const gross = successful ? moneyOrFallback(object.amount_received, object.amount) : 0;
  const currency = monetaryCurrency(object.currency, gross);
  const explicitModel = metadataModel(object);
  const timing = eventTiming(object, eventCreatedAt, successTransition);
  return [observation({
    event,
    object,
    namespace,
    eventCreatedAt,
    sourceObjectType: "payment_intent",
    sourceObjectId,
    factKind: "payment",
    commerceModel: explicitModel || (gross === 0 && successful ? "comped" :
      hasId(object.invoice) ? "subscription" : "one_time"),
    state,
    currency,
    grossPaidMinor: gross,
    discountMinor: 0,
    taxMinor: 0,
    refundedMinor: 0,
    disputedMinor: 0,
    inquiryMinor: 0,
    paidAt: successful && successTransition && gross > 0 ? timing.effectiveAt : null,
    upgradedAt: successful && successTransition ? timing.effectiveAt : null,
    timing,
    source: explicitModel ? "manual_metadata" : "stripe_object",
  })];
}

function normalizeCharge(
  event: Stripe.Event,
  object: Record<string, unknown>,
  namespace: CustomerCommerceNamespace,
  eventCreatedAt: string,
  sourceObjectId: string,
) {
  const state = stringValue(object.status) || chargeEventState(event.type);
  const successful = (object.paid === true || state === "succeeded") &&
    object.captured !== false;
  const successTransition = event.type === "charge.succeeded" ||
    event.type === "charge.captured";
  const gross = successful ? moneyOrFallback(object.amount_captured, object.amount) : 0;
  const refunded = successful ? Math.min(gross, money(object.amount_refunded)) : 0;
  const currency = monetaryCurrency(object.currency, gross, refunded);
  const explicitModel = metadataModel(object);
  const timing = eventTiming(object, eventCreatedAt, successTransition);
  return [observation({
    event,
    object,
    namespace,
    eventCreatedAt,
    sourceObjectType: "charge",
    sourceObjectId,
    factKind: "payment",
    commerceModel: explicitModel || (gross === 0 && successful ? "comped" :
      hasId(object.invoice) ? "subscription" : "one_time"),
    state,
    currency,
    grossPaidMinor: gross,
    discountMinor: 0,
    taxMinor: 0,
    refundedMinor: refunded,
    disputedMinor: 0,
    inquiryMinor: 0,
    paidAt: successful && successTransition && gross > 0 ? timing.effectiveAt : null,
    upgradedAt: successful && successTransition ? timing.effectiveAt : null,
    timing,
    source: explicitModel ? "manual_metadata" : "stripe_object",
  })];
}

function normalizeRefund(
  event: Stripe.Event,
  object: Record<string, unknown>,
  namespace: CustomerCommerceNamespace,
  eventCreatedAt: string,
  sourceObjectId: string,
) {
  const state = stringValue(object.status) || refundEventState(event.type);
  const successful = state === "succeeded";
  const refunded = successful ? money(object.amount) : 0;
  const currency = monetaryCurrency(object.currency, refunded);
  const timing = eventTiming(object, eventCreatedAt, true);
  return [observation({
    event,
    object,
    namespace,
    eventCreatedAt,
    sourceObjectType: "refund",
    sourceObjectId,
    factKind: "refund",
    commerceModel: metadataModel(object) || "one_time",
    state,
    currency,
    grossPaidMinor: 0,
    discountMinor: 0,
    taxMinor: 0,
    refundedMinor: refunded,
    disputedMinor: 0,
    inquiryMinor: 0,
    paidAt: null,
    upgradedAt: null,
    timing,
    source: "stripe_object",
  })];
}

function normalizeDispute(
  event: Stripe.Event,
  object: Record<string, unknown>,
  namespace: CustomerCommerceNamespace,
  eventCreatedAt: string,
  sourceObjectId: string,
) {
  const state = stringValue(object.status) || disputeEventState(event.type);
  // Stripe inquiry warnings expose money to risk without removing it. Formal
  // disputes reduce net only while open or lost; won/warning_closed/prevented
  // and unknown terminal values retain money.
  const disputed = FORMAL_DISPUTE_STATUSES.has(state) ? money(object.amount) : 0;
  const inquiry = INQUIRY_DISPUTE_STATUSES.has(state) ? money(object.amount) : 0;
  const currency = monetaryCurrency(object.currency, disputed, inquiry);
  const timing = eventTiming(object, eventCreatedAt, true);
  return [observation({
    event,
    object,
    namespace,
    eventCreatedAt,
    sourceObjectType: "dispute",
    sourceObjectId,
    factKind: "dispute",
    commerceModel: metadataModel(object) || "one_time",
    state,
    currency,
    grossPaidMinor: 0,
    discountMinor: 0,
    taxMinor: 0,
    refundedMinor: 0,
    disputedMinor: disputed,
    inquiryMinor: inquiry,
    paidAt: null,
    upgradedAt: null,
    timing,
    source: "stripe_object",
  })];
}

function normalizeInvoice(
  event: Stripe.Event,
  object: Record<string, unknown>,
  namespace: CustomerCommerceNamespace,
  eventCreatedAt: string,
  sourceObjectId: string,
) {
  const state = stringValue(object.status) || invoiceEventState(event.type);
  const successful = object.paid === true || state === "paid" ||
    event.type === "invoice.payment_succeeded";
  const successTransition = event.type === "invoice.paid" ||
    event.type === "invoice.payment_succeeded";
  const gross = successful ? money(object.amount_paid) : 0;
  const discount = successful
    ? Math.max(money(object.amount_discount), sumAmounts(object.total_discount_amounts))
    : 0;
  const tax = successful
    ? Math.max(money(object.amount_tax), sumAmounts(object.total_tax_amounts),
      sumAmounts(object.total_taxes))
    : 0;
  const currency = monetaryCurrency(object.currency, gross, discount, tax);
  const explicitModel = metadataModel(object);
  const zeroCost = successful && gross === 0;
  const subscriptionId = invoiceSubscriptionId(object);
  const timing = invoiceTiming(object, eventCreatedAt);
  return [observation({
    event,
    object,
    namespace,
    eventCreatedAt,
    sourceObjectType: "invoice",
    sourceObjectId,
    factKind: "payment",
    commerceModel: explicitModel || (zeroCost ? "comped" :
      subscriptionId ? "subscription" : "one_time"),
    state,
    currency,
    grossPaidMinor: gross,
    discountMinor: discount,
    taxMinor: tax,
    refundedMinor: 0,
    disputedMinor: 0,
    inquiryMinor: 0,
    paidAt: successful && successTransition && gross > 0 ? timing.effectiveAt : null,
    upgradedAt: successful && successTransition ? timing.effectiveAt : null,
    timing,
    source: explicitModel || object.paid_out_of_band === true
      ? "manual_metadata"
      : "stripe_object",
    billingPeriodStart: optionalUnixTimestamp(object.period_start),
    billingPeriodEnd: optionalUnixTimestamp(object.period_end),
  })];
}

function normalizeSubscription(
  event: Stripe.Event,
  object: Record<string, unknown>,
  namespace: CustomerCommerceNamespace,
  eventCreatedAt: string,
  sourceObjectId: string,
) {
  const state = stringValue(object.status) || subscriptionEventState(event.type);
  const timing = eventTiming(object, eventCreatedAt);
  const active = ACTIVE_SUBSCRIPTION_STATUSES.has(state);
  const billingPeriod = subscriptionBillingPeriod(object);
  return [observation({
    event,
    object,
    namespace,
    eventCreatedAt,
    sourceObjectType: "subscription",
    sourceObjectId,
    factKind: "subscription",
    commerceModel: metadataModel(object) || "subscription",
    state,
    currency: null,
    grossPaidMinor: 0,
    discountMinor: 0,
    taxMinor: 0,
    refundedMinor: 0,
    disputedMinor: 0,
    inquiryMinor: 0,
    paidAt: null,
    upgradedAt: active ? timing.effectiveAt : null,
    timing,
    source: metadataModel(object) ? "manual_metadata" : "stripe_object",
    billingPeriodStart: billingPeriod.start,
    billingPeriodEnd: billingPeriod.end,
  })];
}

function normalizeDiscount(
  event: Stripe.Event,
  object: Record<string, unknown>,
  namespace: CustomerCommerceNamespace,
  eventCreatedAt: string,
  sourceObjectId: string,
) {
  const timing = eventTiming(object, eventCreatedAt);
  return [observation({
    event,
    object,
    namespace,
    eventCreatedAt,
    sourceObjectType: "discount",
    sourceObjectId,
    factKind: "discount",
    commerceModel: metadataModel(object) || "comped",
    state: object.deleted === true ? "deleted" : stringValue(object.status) || "active",
    currency: null,
    grossPaidMinor: 0,
    discountMinor: 0,
    taxMinor: 0,
    refundedMinor: 0,
    disputedMinor: 0,
    inquiryMinor: 0,
    paidAt: null,
    upgradedAt: null,
    timing,
    source: "stripe_object",
  })];
}

function normalizeManualAdjustment(
  event: Stripe.Event,
  object: Record<string, unknown>,
  namespace: CustomerCommerceNamespace,
  eventCreatedAt: string,
  sourceObjectId: string,
) {
  const timing = eventTiming(object, eventCreatedAt);
  const explicitUpgrade = metadataTimestamp(object, "sidestream_upgraded_at");
  return [observation({
    event,
    object,
    namespace,
    eventCreatedAt,
    sourceObjectType: "manual_adjustment",
    sourceObjectId,
    factKind: "manual",
    commerceModel: metadataModel(object) || "comped",
    state: stringValue(object.type) || "manual",
    currency: null,
    grossPaidMinor: 0,
    discountMinor: 0,
    taxMinor: 0,
    refundedMinor: 0,
    disputedMinor: 0,
    inquiryMinor: 0,
    paidAt: null,
    upgradedAt: explicitUpgrade,
    timing,
    source: "manual_metadata",
  })];
}

type ObservationInput = Omit<CustomerCommerceObservation,
  "licenseNamespace" | "eventId" | "eventType" | "netPaidMinor" |
  "paymentKey" | "aliases" | "identityEvidence" |
  "objectCreatedAt" | "effectiveAt" | "timestampSource" | "sourceConfidence" |
  "billingPeriodStart" | "billingPeriodEnd"
> & Readonly<{
  event: Stripe.Event;
  object: Record<string, unknown>;
  namespace: CustomerCommerceNamespace;
  timing: CommerceTiming;
  billingPeriodStart?: string | null;
  billingPeriodEnd?: string | null;
}>;

function observation(input: ObservationInput): CustomerCommerceObservation {
  const aliases = commerceAliases(input.sourceObjectType, input.sourceObjectId, input.object);
  const paymentKey = preferredPaymentKey(aliases);
  return Object.freeze({
    licenseNamespace: input.namespace,
    eventId: input.event.id,
    eventType: input.event.type,
    eventCreatedAt: input.eventCreatedAt,
    sourceObjectType: input.sourceObjectType,
    sourceObjectId: input.sourceObjectId,
    factKind: input.factKind,
    commerceModel: input.commerceModel,
    state: boundedState(input.state),
    currency: input.currency,
    grossPaidMinor: input.grossPaidMinor,
    discountMinor: input.discountMinor,
    taxMinor: input.taxMinor,
    refundedMinor: input.refundedMinor,
    disputedMinor: input.disputedMinor,
    inquiryMinor: input.inquiryMinor,
    netPaidMinor: Math.max(
      0,
      input.grossPaidMinor - input.refundedMinor - input.disputedMinor,
    ),
    paidAt: input.paidAt,
    upgradedAt: input.upgradedAt,
    objectCreatedAt: input.timing.objectCreatedAt,
    effectiveAt: input.timing.effectiveAt,
    billingPeriodStart: input.billingPeriodStart || null,
    billingPeriodEnd: input.billingPeriodEnd || null,
    timestampSource: input.timing.timestampSource,
    source: input.source,
    sourceConfidence: input.timing.sourceConfidence,
    paymentKey,
    aliases,
    identityEvidence: identityEvidence(input.sourceObjectType, input.sourceObjectId, input.object),
  });
}

type CommerceTiming = Readonly<{
  objectCreatedAt: string | null;
  effectiveAt: string;
  timestampSource: CustomerCommerceObservation["timestampSource"];
  sourceConfidence: CustomerCommerceObservation["sourceConfidence"];
}>;

function eventTiming(
  object: Record<string, unknown>,
  eventCreatedAt: string,
  preferEvent = false,
): CommerceTiming {
  const objectCreatedAt = optionalUnixTimestamp(object.created);
  if (preferEvent) {
    return {
      objectCreatedAt,
      effectiveAt: eventCreatedAt,
      timestampSource: "stripe_event",
      sourceConfidence: "verified",
    };
  }
  if (objectCreatedAt) {
    return {
      objectCreatedAt,
      effectiveAt: objectCreatedAt,
      timestampSource: "stripe_object",
      sourceConfidence: "verified",
    };
  }
  return {
    objectCreatedAt: null,
    effectiveAt: eventCreatedAt,
    timestampSource: "legacy_event_inference",
    sourceConfidence: "legacy_inferred",
  };
}

function invoiceTiming(
  object: Record<string, unknown>,
  eventCreatedAt: string,
): CommerceTiming {
  const paidAt = optionalUnixTimestamp(recordValue(object.status_transitions).paid_at);
  const objectCreatedAt = optionalUnixTimestamp(object.created);
  if (paidAt) {
    return {
      objectCreatedAt,
      effectiveAt: paidAt,
      timestampSource: "stripe_status_transition",
      sourceConfidence: "verified",
    };
  }
  return eventTiming(object, eventCreatedAt);
}

function commerceAliases(
  sourceObjectType: string,
  sourceObjectId: string,
  object: Record<string, unknown>,
) {
  const aliases: CustomerCommerceAlias[] = [];
  addAlias(
    aliases,
    sourceObjectType === "subscription" ? "subscription_lifecycle" : sourceObjectType,
    sourceObjectId,
  );
  addAlias(aliases, "payment_intent", object.payment_intent);
  addAlias(aliases, "charge", object.charge);
  addAlias(aliases, "charge", object.latest_charge);
  addAlias(aliases, "invoice", object.invoice);
  addAlias(aliases, "checkout_session", object.checkout_session);
  for (const payment of invoicePayments(object)) {
    addAlias(aliases, "payment_intent", payment.payment_intent);
    addAlias(aliases, "charge", payment.charge);
  }
  return Object.freeze(aliases);
}

function identityEvidence(
  sourceObjectType: string,
  sourceObjectId: string,
  object: Record<string, unknown>,
) {
  const evidence: CustomerCommerceIdentityEvidence[] = [];
  addEvidence(evidence, "stripe_customer", object.customer);
  addEvidence(evidence, "stripe_payment_intent", object.payment_intent);
  addEvidence(evidence, "stripe_subscription", invoiceSubscriptionId(object));
  for (const payment of invoicePayments(object)) {
    addEvidence(evidence, "stripe_payment_intent", payment.payment_intent);
  }
  if (sourceObjectType === "checkout_session") {
    addEvidence(evidence, "stripe_checkout_session", sourceObjectId);
  }
  if (sourceObjectType === "payment_intent") {
    addEvidence(evidence, "stripe_payment_intent", sourceObjectId);
  }
  if (sourceObjectType === "subscription") {
    addEvidence(evidence, "stripe_subscription", sourceObjectId);
  }
  return Object.freeze(evidence);
}

function addAlias(
  aliases: CustomerCommerceAlias[],
  aliasType: string,
  value: unknown,
) {
  const aliasId = boundedId(value);
  if (!aliasId) return;
  if (aliases.some((alias) => alias.aliasType === aliasType && alias.aliasId === aliasId)) {
    return;
  }
  aliases.push(Object.freeze({ aliasType, aliasId }));
}

function addEvidence(
  evidence: CustomerCommerceIdentityEvidence[],
  linkType: CustomerCommerceIdentityEvidence["linkType"],
  value: unknown,
) {
  const linkValue = boundedId(value);
  if (!linkValue) return;
  if (evidence.some((item) => item.linkType === linkType && item.linkValue === linkValue)) {
    return;
  }
  evidence.push(Object.freeze({ linkType, linkValue }));
}

function preferredPaymentKey(aliases: readonly CustomerCommerceAlias[]) {
  const preferred = [...aliases].sort((left, right) =>
    aliasPriority(left.aliasType) - aliasPriority(right.aliasType) ||
    left.aliasId.localeCompare(right.aliasId)
  )[0];
  if (!preferred) throw new CustomerCommerceNormalizationError("missing_payment_key");
  return `${preferred.aliasType}:${preferred.aliasId}`;
}

function aliasPriority(type: string) {
  return ({
    charge: 0,
    payment_intent: 1,
    invoice: 2,
    checkout_session: 3,
    refund: 5,
    dispute: 5,
    discount: 6,
    manual_adjustment: 6,
    subscription_lifecycle: 6,
  } as Record<string, number>)[type] ?? 10;
}

function metadataModel(object: Record<string, unknown>): CustomerCommerceModel | null {
  const metadata = recordValue(object.metadata);
  for (const key of PAYMENT_MODE_METADATA_KEYS) {
    const value = stringValue(metadata[key]);
    if ((CUSTOMER_COMMERCE_MODELS as readonly string[]).includes(value)) {
      return value as CustomerCommerceModel;
    }
  }
  if (metadata.sidestream_comped === "true" || metadata.sidestream_manual === "true") {
    return "comped";
  }
  return null;
}

function metadataTimestamp(object: Record<string, unknown>, key: string) {
  const value = recordValue(object.metadata)[key];
  if (typeof value !== "string" || !value.trim()) return null;
  if (/^\d+$/.test(value.trim())) return optionalUnixTimestamp(Number(value));
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function monetaryCurrency(value: unknown, ...amounts: number[]) {
  const currency = stringValue(value).toLowerCase();
  if (/^[a-z]{3}$/.test(currency)) return currency;
  if (amounts.some((amount) => amount > 0)) {
    throw new CustomerCommerceNormalizationError("currency_required_for_money");
  }
  return null;
}

function money(value: unknown) {
  if (value === null || value === undefined || value === "") return 0;
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new CustomerCommerceNormalizationError("invalid_minor_unit_amount");
  }
  return amount;
}

function moneyOrFallback(primary: unknown, fallback: unknown) {
  return primary === null || primary === undefined ? money(fallback) : money(primary);
}

function sumAmounts(value: unknown) {
  if (!Array.isArray(value)) return 0;
  return value.reduce((total, item) => total + money(recordValue(item).amount), 0);
}

function invoicePayments(object: Record<string, unknown>) {
  const data = recordValue(object.payments).data;
  if (!Array.isArray(data)) return [];
  return data.map((entry) => recordValue(recordValue(entry).payment));
}

function invoiceSubscriptionId(object: Record<string, unknown>) {
  const current = recordValue(recordValue(object.parent).subscription_details).subscription;
  return boundedId(current) || boundedId(object.subscription);
}

function subscriptionBillingPeriod(object: Record<string, unknown>) {
  const data = recordValue(object.items).data;
  const items = Array.isArray(data) ? data.map(recordValue) : [];
  const starts = items.map((item) => unixSeconds(item.current_period_start))
    .filter((value): value is number => value !== null);
  const ends = items.map((item) => unixSeconds(item.current_period_end))
    .filter((value): value is number => value !== null);
  const legacyStart = unixSeconds(object.current_period_start);
  const legacyEnd = unixSeconds(object.current_period_end);
  const start = starts.length > 0 ? Math.min(...starts) : legacyStart;
  const end = ends.length > 0 ? Math.max(...ends) : legacyEnd;
  return {
    start: start === null ? null : unixTimestamp(start, "billing_period_start"),
    end: end === null ? null : unixTimestamp(end, "billing_period_end"),
  } as const;
}

function unixSeconds(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const seconds = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}

function optionalUnixTimestamp(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  return unixTimestamp(seconds, "object_created");
}

function unixTimestamp(seconds: number, field: string) {
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(seconds) || seconds < 0 || !Number.isFinite(milliseconds)) {
    throw new CustomerCommerceNormalizationError(`invalid_${field}`);
  }
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) {
    throw new CustomerCommerceNormalizationError(`invalid_${field}`);
  }
  return date.toISOString();
}

function hasId(value: unknown) {
  return Boolean(boundedId(value));
}

function boundedId(value: unknown) {
  const id = typeof value === "string"
    ? value.trim()
    : recordValue(value).id && typeof recordValue(value).id === "string"
      ? String(recordValue(value).id).trim()
      : "";
  return id && id.length <= 200 ? id : "";
}

function boundedState(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 80);
  return normalized || "unknown";
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function recordValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function nonnegativeInteger(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function assertEvent(event: Stripe.Event) {
  if (
    !event || typeof event !== "object" || !boundedId(event.id) ||
    typeof event.type !== "string" || !event.type ||
    typeof event.livemode !== "boolean" ||
    !Number.isSafeInteger(event.created) || event.created < 0 ||
    !event.data || typeof event.data !== "object"
  ) {
    throw new CustomerCommerceNormalizationError("invalid_stripe_event");
  }
}

function assertTrustedNamespace(
  event: Stripe.Event,
  trustedNamespace: CustomerCommerceNamespace,
) {
  if (trustedNamespace !== "production" && trustedNamespace !== "test") {
    throw new CustomerCommerceNormalizationError("invalid_trusted_namespace");
  }
  const signedEventNamespace = event.livemode ? "production" : "test";
  if (signedEventNamespace !== trustedNamespace) {
    throw new CustomerCommerceNormalizationError("stripe_event_namespace_mismatch");
  }
}

function checkoutEventState(type: string) {
  if (type.endsWith("async_payment_succeeded")) return "paid";
  if (type.endsWith("async_payment_failed")) return "failed";
  if (type.endsWith("expired")) return "expired";
  return "unknown";
}

function paymentIntentEventState(type: string) {
  return type.slice("payment_intent.".length) || "unknown";
}

function chargeEventState(type: string) {
  if (type.endsWith("succeeded")) return "succeeded";
  if (type.endsWith("failed")) return "failed";
  return type.slice("charge.".length) || "unknown";
}

function refundEventState(type: string) {
  if (type.endsWith("failed")) return "failed";
  if (type.endsWith("canceled")) return "canceled";
  return "unknown";
}

function disputeEventState(type: string) {
  if (type.endsWith("created")) return "needs_response";
  if (type.endsWith("closed")) return "unknown_closed";
  return "unknown";
}

function invoiceEventState(type: string) {
  if (type.endsWith("paid") || type.endsWith("payment_succeeded")) return "paid";
  if (type.endsWith("payment_failed")) return "payment_failed";
  return type.slice("invoice.".length) || "unknown";
}

function subscriptionEventState(type: string) {
  if (type.endsWith("deleted")) return "canceled";
  return "unknown";
}

#!/usr/bin/env node

import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ACQUISITION_STAGE_COUNTING_GRAINS,
} from "../api/_lib/acquisition-integrity.ts";

export const ACQUISITION_JOURNEY_MATRIX_VERSION = 1;

export const REQUIRED_JOURNEY_COVERAGE = Object.freeze([
  "direct_hidden_origin",
  "valid_ordinary_utm",
  "forged_trusted_channel_utm",
  "signed_manychat_email",
  "signed_facebook_lead_form_envelope",
  "forwarded_handoff_conflict",
  "desktop_mac_download",
  "desktop_windows_download",
  "mobile_email_handoff",
  "mobile_no_email_computer_handoff",
  "root_entry",
  "account_entry",
  "activation_entry",
  "signed_out_google_redirect",
  "authenticated_google_callback",
  "ordinary_account_purchase_without_installation",
  "anonymous_download_claim_purchase",
  "paid_mc_purchase",
  "reused_checkout_session",
  "rotated_checkout_session",
  "concurrent_checkout_session",
  "global_offer",
  "india_offer",
  "brazil_offer",
  "south_korea_offer",
  "positive_payment",
  "zero_total_paid",
  "zero_total_no_payment_required",
  "stripe_retry",
  "stripe_replay",
  "refund",
  "dispute",
  "claim_opened",
  "claim_completed",
  "claim_conflict",
  "claim_expiry",
  "account_first_cohort",
  "install_first_cohort",
  "exact_cus_lookup",
  "exact_cs_lookup",
  "exact_pi_lookup",
  "exact_ch_lookup",
  "pagination",
  "unknown_external_origin",
  "missing_internal_linkage_alert",
  "deterministic_historical_linkage",
  "historical_unlinked_uninferred",
]);

export const ACQUISITION_PROHIBITED_OUTPUT_FIELDS = Object.freeze([
  "email",
  "ip",
  "ipAddress",
  "userAgent",
  "cookie",
  "stripePayload",
  "telemetryPayload",
  "installHash",
  "installIdHash",
  "receiptHash",
  "installerReceiptIdHash",
  "browserToken",
  "identityLinkValue",
  "stripeCustomerId",
  "checkoutSessionId",
  "paymentIntentId",
  "chargeId",
]);

const PURCHASE_STAGES = Object.freeze([
  "landing_observed",
  "authentication_completed",
  "checkout_started",
  "checkout_completed",
  "payment_settled",
]);
const CLAIM_PURCHASE_STAGES = Object.freeze([
  "landing_observed",
  "installer_requested",
  "installation_claimed",
  "authentication_completed",
  "checkout_started",
  "checkout_completed",
  "payment_settled",
]);
const PAID_PURCHASE_STAGES = Object.freeze([
  ...PURCHASE_STAGES,
  "installer_requested",
]);
const COMPLETE_LIFECYCLE_STAGES = Object.freeze([
  ...PURCHASE_STAGES,
  "refunded",
  "disputed",
]);

const browserEvidence = Object.freeze([
  "tests/anonymous-acquisition-browser.test.mjs",
  "tests/checkout-abuse.test.mjs",
]);
const checkoutEvidence = Object.freeze([
  "tests/checkout-contract.test.mjs",
  "tests/checkout-abuse.test.mjs",
  "tests/checkout-offers.test.mjs",
]);
const claimEvidence = Object.freeze([
  "tests/customer-360/anonymous-claim.test.mjs",
  "tests/customer-360/anonymous-claim-postgres.test.mjs",
]);
const reportEvidence = Object.freeze([
  "tests/customer-360/acquisition-funnel.test.mjs",
  "tests/customer-360/acquisition-funnel-postgres.test.mjs",
]);
const lookupEvidence = Object.freeze([
  "tests/customer-360/query-api.test.mjs",
  "tests/customer-360/query-api-postgres.test.mjs",
]);

function journey(id, coverage, overrides = {}) {
  const requiredStages = Object.freeze([...(overrides.requiredStages || ["landing_observed"])]);
  return Object.freeze({
    id,
    coverage: Object.freeze([...coverage]),
    source: overrides.source || "website_direct_or_unknown",
    channel: overrides.channel || "website",
    confidence: overrides.confidence || "exact_sidestream_entry",
    integrityState: overrides.integrityState || "intact",
    namespace: overrides.namespace || "test",
    intentAcquisitionId: overrides.intentAcquisitionId || "required_for_every_new_intent",
    stripeReferenceAgreement:
      overrides.stripeReferenceAgreement || "exact_acquisition_id_on_session_invoice_and_payment_intent",
    requiredStages,
    deduplicationGrains: Object.freeze(Object.fromEntries(requiredStages.map((stage) => [
      stage,
      ACQUISITION_STAGE_COUNTING_GRAINS[stage],
    ]))),
    paymentState: Object.freeze({
      paid: overrides.paymentState?.paid ?? false,
      refunded: overrides.paymentState?.refunded ?? false,
      disputed: overrides.paymentState?.disputed ?? false,
    }),
    reportCohortInclusion: Object.freeze({
      first_install: overrides.reportCohortInclusion?.first_install ?? false,
      first_purchase: overrides.reportCohortInclusion?.first_purchase ?? false,
    }),
    prohibitedFields: ACQUISITION_PROHIBITED_OUTPUT_FIELDS,
    evidence: Object.freeze([...(overrides.evidence || browserEvidence)]),
  });
}

export const ACQUISITION_JOURNEY_MATRIX = Object.freeze([
  journey("direct-hidden-origin", ["direct_hidden_origin", "root_entry"], {
    evidence: browserEvidence,
  }),
  journey("ordinary-utm", ["valid_ordinary_utm"], {
    source: "creator_news",
    evidence: browserEvidence,
  }),
  journey("forged-trusted-channel-utm", ["forged_trusted_channel_utm"], {
    source: "manychat",
    evidence: browserEvidence,
  }),
  journey("signed-manychat-email", ["signed_manychat_email"], {
    source: "manychat",
    channel: "email_handoff",
    confidence: "exact_trusted_delivery",
    requiredStages: ["email_handoff_created", "landing_observed"],
    evidence: [
      "tests/anonymous-acquisition-browser.test.mjs",
      "tests/send-download-links.test.mjs",
    ],
  }),
  journey("signed-facebook-lead-form", ["signed_facebook_lead_form_envelope"], {
    source: "facebook",
    channel: "email_handoff",
    confidence: "exact_trusted_delivery",
    requiredStages: ["email_handoff_created", "landing_observed"],
    evidence: browserEvidence,
  }),
  journey("forwarded-handoff", ["forwarded_handoff_conflict"], {
    source: "manychat",
    channel: "email_handoff",
    confidence: "exact_trusted_delivery",
    requiredStages: ["email_handoff_created", "landing_observed", "authentication_completed"],
    evidence: ["tests/checkout-abuse.test.mjs"],
  }),
  journey("desktop-mac-download", ["desktop_mac_download"], {
    requiredStages: ["landing_observed", "installer_requested"],
    evidence: ["tests/download-referral.test.mjs", "tests/customer-360/privacy-contract.test.mjs"],
  }),
  journey("desktop-windows-download", ["desktop_windows_download"], {
    requiredStages: ["landing_observed", "installer_requested"],
    evidence: ["tests/download-referral.test.mjs", "tests/customer-360/privacy-contract.test.mjs"],
  }),
  journey("mobile-email-handoff", ["mobile_email_handoff"], {
    requiredStages: ["landing_observed", "email_handoff_created", "installer_requested"],
    evidence: ["tests/send-download-links.test.mjs"],
  }),
  journey("mobile-no-email-handoff", ["mobile_no_email_computer_handoff"], {
    requiredStages: ["landing_observed", "email_handoff_created", "installer_requested"],
    evidence: ["tests/send-download-links.test.mjs"],
  }),
  journey("account-entry", ["account_entry", "signed_out_google_redirect"], {
    requiredStages: ["landing_observed"],
    evidence: ["tests/checkout-contract.test.mjs", "tests/checkout-abuse.test.mjs"],
  }),
  journey("activation-entry", ["activation_entry"], {
    requiredStages: ["landing_observed", "authentication_completed", "checkout_started"],
    evidence: ["tests/checkout-abuse.test.mjs"],
  }),
  journey("authenticated-google-callback", ["authenticated_google_callback"], {
    requiredStages: ["landing_observed", "authentication_completed"],
    evidence: ["tests/checkout-contract.test.mjs", "tests/checkout-abuse.test.mjs"],
  }),
  journey("ordinary-account-purchase-no-install", [
    "ordinary_account_purchase_without_installation",
    "account_first_cohort",
  ], {
    requiredStages: PURCHASE_STAGES,
    paymentState: { paid: true },
    reportCohortInclusion: { first_purchase: true },
    evidence: [...checkoutEvidence, ...reportEvidence],
  }),
  journey("anonymous-download-claim-purchase", [
    "anonymous_download_claim_purchase",
    "install_first_cohort",
  ], {
    source: "reddit",
    requiredStages: CLAIM_PURCHASE_STAGES,
    paymentState: { paid: true },
    reportCohortInclusion: { first_install: true, first_purchase: true },
    evidence: [...claimEvidence, ...checkoutEvidence, ...reportEvidence],
  }),
  journey("paid-mc-purchase", ["paid_mc_purchase"], {
    source: "manychat",
    channel: "checkout",
    confidence: "exact_trusted_delivery",
    requiredStages: PAID_PURCHASE_STAGES,
    paymentState: { paid: true },
    reportCohortInclusion: { first_purchase: true },
    evidence: [
      "tests/paid-acquisition-checkout.test.mjs",
      "tests/paid-acquisition-e2e-fixtures.test.mjs",
      "tests/acquisition-route-coverage.test.mjs",
      ...checkoutEvidence,
      ...reportEvidence,
    ],
  }),
  journey("checkout-session-reuse-rotation-concurrency", [
    "reused_checkout_session",
    "rotated_checkout_session",
    "concurrent_checkout_session",
  ], {
    requiredStages: PURCHASE_STAGES,
    paymentState: { paid: true },
    evidence: ["tests/checkout-abuse.test.mjs"],
  }),
  ...[
    ["global-offer", "global_offer"],
    ["india-offer", "india_offer"],
    ["brazil-offer", "brazil_offer"],
    ["south-korea-offer", "south_korea_offer"],
  ].map(([id, coverage]) => journey(id, [coverage], {
    requiredStages: PURCHASE_STAGES,
    paymentState: { paid: true },
    evidence: checkoutEvidence,
  })),
  journey("positive-payment", ["positive_payment"], {
    requiredStages: PURCHASE_STAGES,
    paymentState: { paid: true },
    evidence: checkoutEvidence,
  }),
  journey("zero-total-paid", ["zero_total_paid"], {
    requiredStages: PURCHASE_STAGES,
    paymentState: { paid: true },
    evidence: checkoutEvidence,
  }),
  journey("zero-total-no-payment-required", ["zero_total_no_payment_required"], {
    requiredStages: PURCHASE_STAGES,
    paymentState: { paid: true },
    stripeReferenceAgreement: "exact_acquisition_id_with_verified_zero_total_session_fallback",
    evidence: checkoutEvidence,
  }),
  journey("stripe-retry-replay", ["stripe_retry", "stripe_replay"], {
    requiredStages: PURCHASE_STAGES,
    paymentState: { paid: true },
    evidence: ["tests/checkout-abuse.test.mjs", "tests/stripe-events.test.mjs"],
  }),
  journey("refund", ["refund"], {
    requiredStages: [...PURCHASE_STAGES, "refunded"],
    paymentState: { paid: false, refunded: true },
    evidence: ["tests/entitlement.test.mjs", ...lookupEvidence],
  }),
  journey("dispute", ["dispute"], {
    requiredStages: [...PURCHASE_STAGES, "disputed"],
    paymentState: { paid: false, disputed: true },
    evidence: ["tests/entitlement.test.mjs", ...lookupEvidence],
  }),
  journey("claim-opened", ["claim_opened"], {
    requiredStages: ["landing_observed", "installer_requested"],
    evidence: claimEvidence,
  }),
  journey("claim-completed", ["claim_completed"], {
    requiredStages: ["landing_observed", "installer_requested", "installation_claimed"],
    reportCohortInclusion: { first_install: true },
    evidence: claimEvidence,
  }),
  journey("claim-conflict", ["claim_conflict"], {
    integrityState: "quarantined",
    requiredStages: ["landing_observed", "installer_requested", "installation_claimed"],
    evidence: claimEvidence,
  }),
  journey("claim-expiry", ["claim_expiry"], {
    requiredStages: ["landing_observed", "installer_requested"],
    evidence: claimEvidence,
  }),
  ...[
    ["lookup-customer", "exact_cus_lookup"],
    ["lookup-session", "exact_cs_lookup"],
    ["lookup-payment-intent", "exact_pi_lookup"],
    ["lookup-charge", "exact_ch_lookup"],
  ].map(([id, coverage]) => journey(id, [coverage], {
    requiredStages: COMPLETE_LIFECYCLE_STAGES,
    paymentState: { refunded: true, disputed: true },
    reportCohortInclusion: { first_install: true, first_purchase: true },
    evidence: lookupEvidence,
  })),
  journey("report-pagination", ["pagination"], {
    requiredStages: PURCHASE_STAGES,
    paymentState: { paid: true },
    reportCohortInclusion: { first_install: true, first_purchase: true },
    evidence: reportEvidence,
  }),
  journey("unknown-external-origin", ["unknown_external_origin"], {
    source: "external_referrer",
    evidence: browserEvidence,
  }),
  journey("missing-internal-linkage", ["missing_internal_linkage_alert"], {
    source: "unknown_source",
    channel: "account",
    confidence: "missing_internal_linkage",
    integrityState: "missing_internal_linkage",
    requiredStages: [],
    stripeReferenceAgreement: "missing_linkage_reported_without_inference",
    evidence: reportEvidence,
  }),
  journey("deterministic-historical-linkage", ["deterministic_historical_linkage"], {
    source: "historical_exact",
    channel: "account",
    confidence: "exact_trusted_delivery",
    requiredStages: PURCHASE_STAGES,
    paymentState: { paid: true },
    reportCohortInclusion: { first_purchase: true },
    evidence: [...reportEvidence, ...lookupEvidence],
  }),
  journey("historical-unlinked", ["historical_unlinked_uninferred"], {
    source: "legacy_unknown",
    channel: "account",
    confidence: "historical_unlinked",
    integrityState: "historical_unlinked",
    intentAcquisitionId: "historical_null_preserved",
    stripeReferenceAgreement: "historical_references_remain_uninferred",
    requiredStages: [],
    evidence: [
      "tests/customer-360/acquisition-integrity-postgres.test.mjs",
      ...reportEvidence,
    ],
  }),
]);

export function validateAcquisitionJourneyMatrix(matrix = ACQUISITION_JOURNEY_MATRIX) {
  const errors = [];
  const ids = new Set();
  const coverage = new Map(REQUIRED_JOURNEY_COVERAGE.map((name) => [name, 0]));
  for (const row of matrix) {
    if (!row || typeof row !== "object") {
      errors.push("Every journey must be an object.");
      continue;
    }
    if (!row.id || ids.has(row.id)) errors.push(`Journey id is missing or repeated: ${row.id}`);
    ids.add(row.id);
    for (const field of [
      "source", "channel", "confidence", "integrityState", "namespace",
      "intentAcquisitionId", "stripeReferenceAgreement",
    ]) {
      if (typeof row[field] !== "string" || !row[field]) {
        errors.push(`${row.id}.${field} must be explicit.`);
      }
    }
    if (row.namespace !== "test") errors.push(`${row.id} must use the disposable Test namespace.`);
    if (!["required_for_every_new_intent", "historical_null_preserved"].includes(
      row.intentAcquisitionId,
    )) {
      errors.push(`${row.id} has an invalid intent acquisition rule.`);
    }
    for (const stage of row.requiredStages || []) {
      if (!ACQUISITION_STAGE_COUNTING_GRAINS[stage]) {
        errors.push(`${row.id} has an unknown stage ${stage}.`);
      } else if (row.deduplicationGrains?.[stage] !== ACQUISITION_STAGE_COUNTING_GRAINS[stage]) {
        errors.push(`${row.id}.${stage} has the wrong counting grain.`);
      }
    }
    if (Object.keys(row.deduplicationGrains || {}).length !== (row.requiredStages || []).length) {
      errors.push(`${row.id} must declare one deduplication grain per required stage.`);
    }
    for (const field of ["paid", "refunded", "disputed"]) {
      if (typeof row.paymentState?.[field] !== "boolean") {
        errors.push(`${row.id}.paymentState.${field} must be boolean.`);
      }
    }
    for (const basis of ["first_install", "first_purchase"]) {
      if (typeof row.reportCohortInclusion?.[basis] !== "boolean") {
        errors.push(`${row.id}.reportCohortInclusion.${basis} must be boolean.`);
      }
    }
    if (!Array.isArray(row.evidence) || row.evidence.length === 0) {
      errors.push(`${row.id} must name deterministic evidence suites.`);
    }
    if (row.prohibitedFields !== ACQUISITION_PROHIBITED_OUTPUT_FIELDS) {
      errors.push(`${row.id} must use the canonical prohibited-field set.`);
    }
    for (const name of row.coverage || []) {
      if (!coverage.has(name)) errors.push(`${row.id} declares unknown coverage ${name}.`);
      else coverage.set(name, coverage.get(name) + 1);
    }
  }
  for (const [name, count] of coverage) {
    if (count !== 1) errors.push(`Coverage ${name} must appear exactly once; found ${count}.`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return Object.freeze({
    version: ACQUISITION_JOURNEY_MATRIX_VERSION,
    journeys: matrix.length,
    coverage: coverage.size,
  });
}

export function assertNoProhibitedAcquisitionFields(value) {
  const prohibited = new Set(ACQUISITION_PROHIBITED_OUTPUT_FIELDS.map(normalizeKey));
  const visit = (candidate, location) => {
    if (!candidate || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${location}[${index}]`));
      return;
    }
    for (const [key, nested] of Object.entries(candidate)) {
      if (prohibited.has(normalizeKey(key))) {
        throw new Error(`Prohibited acquisition field at ${location}.${key}`);
      }
      visit(nested, `${location}.${key}`);
    }
  };
  visit(value, "output");
  return true;
}

function normalizeKey(value) {
  return String(value).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function installNoNetworkGuard() {
  if (globalThis.__SIDESTREAM_ACQUISITION_MATRIX_NETWORK_GUARD__) return;
  const blocked = (kind, target) => {
    throw new Error(`${kind} is forbidden in the acquisition journey matrix: ${String(target)}`);
  };
  net.Socket.prototype.connect = function blockedSocketConnect(...arguments_) {
    return blocked("TCP network access", arguments_[0]);
  };
  for (const [module, protocol] of [[http, "HTTP"], [https, "HTTPS"]]) {
    module.request = (...arguments_) => blocked(`${protocol} request`, arguments_[0]);
    module.get = (...arguments_) => blocked(`${protocol} GET`, arguments_[0]);
  }
  globalThis.fetch = async (input) => blocked("fetch", input);
  globalThis.WebSocket = class BlockedWebSocket {
    constructor(url) {
      blocked("WebSocket", url);
    }
  };
  globalThis.__SIDESTREAM_ACQUISITION_MATRIX_NETWORK_GUARD__ = Object.freeze({
    externalNetwork: "blocked",
    doubles: "deterministic_only",
  });
}

async function runTest(filename, postgres = false) {
  const arguments_ = ["--experimental-strip-types"];
  if (postgres) {
    arguments_.push("--import", path.resolve("tests/helpers/customer-360-network-guard.mjs"));
  }
  arguments_.push("--test", "--test-concurrency=1", path.resolve(filename));
  const child = spawn(process.execPath, arguments_, {
    cwd: process.cwd(),
    env: { ...process.env, TZ: "America/Los_Angeles" },
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Journey matrix test terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function main() {
  const options = new Set(process.argv.slice(2));
  for (const option of options) {
    if (!["--json", "--postgres"].includes(option)) {
      throw new Error(`Unknown journey matrix option: ${option}`);
    }
  }
  const summary = validateAcquisitionJourneyMatrix();
  if (options.has("--json")) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: ACQUISITION_JOURNEY_MATRIX_VERSION,
      summary,
      journeys: ACQUISITION_JOURNEY_MATRIX,
    }, null, 2)}\n`);
    return;
  }
  const unitCode = await runTest("tests/acquisition-journey-matrix.test.mjs");
  if (unitCode !== 0) process.exitCode = unitCode;
  if (unitCode === 0 && options.has("--postgres")) {
    process.exitCode = await runTest(
      "tests/customer-360/acquisition-integrity-pipeline-postgres.test.mjs",
      true,
    );
  }
}

installNoNetworkGuard();

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

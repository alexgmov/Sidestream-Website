import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  PAID_ACQUISITION_CONTROL_COHORT,
  PAID_ACQUISITION_EXPERIMENT_ID,
  PAID_ACQUISITION_PAID_COHORT,
  PAID_ACQUISITION_SOURCE,
  PaidAcquisitionError,
  associatePaidAcquisitionActivation,
  bindPaidAcquisitionCheckoutIntent,
  createPaidAcquisitionAssignmentCookie,
  createPaidAcquisitionEntryContext,
  createPaidAcquisitionLifecycleEvent,
  normalizePaidAcquisitionVerifiedEmail,
  recordPaidAcquisitionInstallerRequest,
  resolvePaidAcquisitionCheckoutCompletion,
  resolvePaidAcquisitionCheckoutStart,
  validatePaidAcquisitionAssignmentCookie,
  validatePaidAcquisitionCheckoutEntry,
} from "../api/_lib/paid-acquisition.ts";

const SECRET = "test-only-secret-with-at-least-thirty-two-bytes";
const OTHER_SECRET = "other-test-secret-with-at-least-thirty-two-bytes";
const NOW = 1_785_139_200;
const NONCE = Buffer.alloc(16, 7).toString("base64url");
const ENTRY_TOKEN_BYTES = Buffer.alloc(32, 9);
const INTENT_REF = "10000000-0000-4000-8000-000000000001";
const IDEMPOTENCY_KEY = "20000000-0000-4000-8000-000000000002";
const SESSION_REF = "cs_test_paid_acquisition_1";
const PAYMENT_REF = "pi_test_paid_acquisition_1";
const DAY_HASH = createHash("sha256").update("anonymous-day").digest("hex");
const ACQUISITION_ID = "30000000-0000-4000-8000-000000000003";

function expectCode(code) {
  return (error) =>
    error instanceof PaidAcquisitionError && error.code === code;
}

function paidCookie(overrides = {}) {
  return createPaidAcquisitionAssignmentCookie({
    nonce: NONCE,
    cohort: PAID_ACQUISITION_PAID_COHORT,
    issuedAt: NOW,
    secret: SECRET,
    ...overrides,
  });
}

function paidEntry(overrides = {}) {
  return createPaidAcquisitionEntryContext({
    assignmentCookieValue: paidCookie(),
    assignmentSecret: SECRET,
    environment: "test",
    attribution: {
      utmMedium: "dm",
      utmCampaign: "launch.1",
      utmContent: "phone-a",
      utmId: "mc_01",
    },
    now: NOW,
    randomBytes: () => ENTRY_TOKEN_BYTES,
    ...overrides,
  });
}

function validatedEntry() {
  const issued = paidEntry();
  return validatePaidAcquisitionCheckoutEntry({
    entryToken: issued.entryToken,
    persistedContext: issued.context,
    assignmentCookieValue: paidCookie(),
    assignmentSecret: SECRET,
    trustedEnvironment: "test",
    now: NOW + 30,
  });
}

function boundIntent(overrides = {}) {
  return bindPaidAcquisitionCheckoutIntent({
    validatedEntry: validatedEntry(),
    checkoutIntentRef: INTENT_REF,
    idempotencyKey: IDEMPOTENCY_KEY,
    createdAt: NOW + 31,
    ...overrides,
  });
}

test("assignment cookie is signed, bounded, sticky, and fails closed", () => {
  const cookie = paidCookie();
  assert.ok(cookie.length <= 192);

  const assignment = validatePaidAcquisitionAssignmentCookie(cookie, {
    secret: SECRET,
    now: NOW + 60,
  });
  assert.equal(assignment.contractVersion, 1);
  assert.equal(assignment.experimentId, PAID_ACQUISITION_EXPERIMENT_ID);
  assert.equal(assignment.cohort, PAID_ACQUISITION_PAID_COHORT);
  assert.match(assignment.assignmentIdHash, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(assignment), true);

  assert.throws(
    () =>
      validatePaidAcquisitionAssignmentCookie(cookie, {
        secret: OTHER_SECRET,
        now: NOW + 60,
      }),
    expectCode("ineligible_entry"),
  );
  assert.throws(
    () =>
      validatePaidAcquisitionAssignmentCookie(`${cookie.slice(0, -1)}A`, {
        secret: SECRET,
        now: NOW + 60,
      }),
    expectCode("ineligible_entry"),
  );
  assert.throws(
    () =>
      validatePaidAcquisitionAssignmentCookie(cookie, {
        secret: SECRET,
        now: NOW + 2_592_001,
      }),
    expectCode("ineligible_entry"),
  );
  assert.throws(
    () =>
      createPaidAcquisitionAssignmentCookie({
        nonce: NONCE,
        cohort: PAID_ACQUISITION_PAID_COHORT,
        issuedAt: NOW,
        secret: "short",
      }),
    expectCode("environment_unavailable"),
  );
});

test("only a current signed paid assignment can create and validate entry context", () => {
  const controlCookie = paidCookie({
    cohort: PAID_ACQUISITION_CONTROL_COHORT,
  });
  assert.throws(
    () =>
      createPaidAcquisitionEntryContext({
        assignmentCookieValue: controlCookie,
        assignmentSecret: SECRET,
        environment: "test",
        now: NOW,
      }),
    expectCode("ineligible_entry"),
  );

  const issued = paidEntry();
  assert.equal(issued.entryToken.length, 43);
  assert.equal("nonce" in issued.context, false);
  assert.equal(issued.context.environment, "test");
  assert.equal(issued.context.cohort, PAID_ACQUISITION_PAID_COHORT);
  assert.equal(issued.context.entryPath, "/mc");
  assert.deepEqual(issued.context.attribution, {
    utmMedium: "dm",
    utmCampaign: "launch.1",
    utmContent: "phone-a",
    utmId: "mc_01",
  });

  const validated = validatePaidAcquisitionCheckoutEntry({
    entryToken: issued.entryToken,
    persistedContext: issued.context,
    assignmentCookieValue: paidCookie(),
    assignmentSecret: SECRET,
    trustedEnvironment: "test",
    now: NOW + 599,
  });
  assert.equal(validated.assignmentIdHash, issued.context.assignmentIdHash);
  assert.equal(Object.isFrozen(validated), true);

  assert.throws(
    () =>
      validatePaidAcquisitionCheckoutEntry({
        entryToken: Buffer.alloc(32, 8).toString("base64url"),
        persistedContext: issued.context,
        assignmentCookieValue: paidCookie(),
        assignmentSecret: SECRET,
        trustedEnvironment: "test",
        now: NOW + 30,
      }),
    expectCode("ineligible_entry"),
  );
  assert.throws(
    () =>
      validatePaidAcquisitionCheckoutEntry({
        entryToken: issued.entryToken,
        persistedContext: issued.context,
        assignmentCookieValue: paidCookie(),
        assignmentSecret: SECRET,
        trustedEnvironment: "production",
        now: NOW + 30,
      }),
    expectCode("ineligible_entry"),
  );
  assert.throws(
    () =>
      validatePaidAcquisitionCheckoutEntry({
        entryToken: issued.entryToken,
        persistedContext: issued.context,
        assignmentCookieValue: paidCookie(),
        assignmentSecret: SECRET,
        trustedEnvironment: "test",
        now: NOW + 601,
      }),
    expectCode("ineligible_entry"),
  );
});

test("Checkout start binds exact immutable cohort and converges exact replay", () => {
  const intent = boundIntent();
  assert.deepEqual(
    {
      contractVersion: intent.contractVersion,
      environment: intent.environment,
      experimentId: intent.experimentId,
      cohort: intent.cohort,
      checkoutIntentRef: intent.checkoutIntentRef,
      idempotencyKey: intent.idempotencyKey,
    },
    {
      contractVersion: 1,
      environment: "test",
      experimentId: "mc-mobile-paid-v1",
      cohort: "mc-paid-v1",
      checkoutIntentRef: INTENT_REF,
      idempotencyKey: IDEMPOTENCY_KEY,
    },
  );
  assert.match(intent.requestFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(intent), true);

  const first = resolvePaidAcquisitionCheckoutStart({
    existingIntent: null,
    proposedIntent: intent,
  });
  assert.deepEqual(
    { action: first.action, reused: first.reused },
    { action: "create", reused: false },
  );

  const replayProposal = boundIntent({
    checkoutIntentRef: "30000000-0000-4000-8000-000000000003",
    createdAt: NOW + 100,
  });
  const replay = resolvePaidAcquisitionCheckoutStart({
    existingIntent: intent,
    proposedIntent: replayProposal,
  });
  assert.equal(replay.action, "reuse");
  assert.equal(replay.reused, true);
  assert.strictEqual(replay.intent, intent);

  const otherKey = boundIntent({
    checkoutIntentRef: "30000000-0000-4000-8000-000000000003",
    idempotencyKey: "40000000-0000-4000-8000-000000000004",
  });
  assert.throws(
    () =>
      resolvePaidAcquisitionCheckoutStart({
        existingIntent: intent,
        proposedIntent: otherKey,
      }),
    expectCode("checkout_conflict"),
  );

  const otherEntryIssued = paidEntry({
    randomBytes: () => Buffer.alloc(32, 10),
  });
  const otherEntry = validatePaidAcquisitionCheckoutEntry({
    entryToken: otherEntryIssued.entryToken,
    persistedContext: otherEntryIssued.context,
    assignmentCookieValue: paidCookie(),
    assignmentSecret: SECRET,
    trustedEnvironment: "test",
    now: NOW + 30,
  });
  const keyReuseWithDifferentPayload = bindPaidAcquisitionCheckoutIntent({
    validatedEntry: otherEntry,
    checkoutIntentRef: "50000000-0000-4000-8000-000000000005",
    idempotencyKey: IDEMPOTENCY_KEY,
    createdAt: NOW + 100,
  });
  assert.throws(
    () =>
      resolvePaidAcquisitionCheckoutStart({
        existingIntent: intent,
        proposedIntent: keyReuseWithDifferentPayload,
      }),
    expectCode("checkout_conflict"),
  );
});

test("verified email normalization is conservative and provider-agnostic", () => {
  assert.equal(
    normalizePaidAcquisitionVerifiedEmail(
      " \tFirst.Last+Launch@BÜCHER.Example\r\n",
    ),
    "first.last+launch@xn--bcher-kva.example",
  );
  assert.notEqual(
    normalizePaidAcquisitionVerifiedEmail("first.last@gmail.com"),
    normalizePaidAcquisitionVerifiedEmail("firstlast@gmail.com"),
  );
  assert.notEqual(
    normalizePaidAcquisitionVerifiedEmail("first+tag@gmail.com"),
    normalizePaidAcquisitionVerifiedEmail("first@gmail.com"),
  );

  for (const invalid of [
    "",
    "missing-at.example",
    "two@@example.com",
    ".leading@example.com",
    "trailing.@example.com",
    "double..dot@example.com",
    "space inside@example.com",
    "user@-example.com",
    "user@example..com",
  ]) {
    assert.throws(
      () => normalizePaidAcquisitionVerifiedEmail(invalid),
      expectCode("invalid_customer_identity"),
    );
  }
});

test("Checkout completion stores normalized verified email and replays exactly", () => {
  const intent = boundIntent();
  const first = resolvePaidAcquisitionCheckoutCompletion({
    intent,
    verifiedCheckoutSessionRef: SESSION_REF,
    canonicalPaymentRef: PAYMENT_REF,
    verifiedCheckoutEmail: " Buyer+MC@Example.COM ",
    completedAt: NOW + 120,
  });
  assert.equal(first.action, "complete");
  assert.equal(first.reused, false);
  assert.equal(
    first.completion.checkoutEmailNormalized,
    "buyer+mc@example.com",
  );
  assert.equal("providerPayload" in first.completion, false);

  const replay = resolvePaidAcquisitionCheckoutCompletion({
    intent,
    verifiedCheckoutSessionRef: SESSION_REF,
    canonicalPaymentRef: PAYMENT_REF,
    verifiedCheckoutEmail: "buyer+mc@example.com",
    existingCompletion: first.completion,
    completedAt: NOW + 300,
  });
  assert.equal(replay.action, "reuse");
  assert.equal(replay.reused, true);
  assert.strictEqual(replay.completion, first.completion);

  assert.throws(
    () =>
      resolvePaidAcquisitionCheckoutCompletion({
        intent,
        verifiedCheckoutSessionRef: SESSION_REF,
        canonicalPaymentRef: "pi_test_conflicting_payment",
        verifiedCheckoutEmail: "buyer+mc@example.com",
        existingCompletion: first.completion,
        completedAt: NOW + 300,
      }),
    expectCode("checkout_conflict"),
  );
});

test("lifecycle events expose only the contract allowlist", () => {
  const event = createPaidAcquisitionLifecycleEvent({
    eventId: "60000000-0000-4000-8000-000000000006",
    occurredAt: "2026-07-27T12:00:00.000Z",
    environment: "test",
    cohort: PAID_ACQUISITION_PAID_COHORT,
    eventName: "mc_checkout_paid",
    outcome: "success",
    anonymousDayHash: DAY_HASH,
    attribution: {
      utmMedium: "social",
      utmCampaign: "launch",
      utmContent: "cta-a",
      utmId: "mc-1",
    },
    platform: "macos",
  });
  assert.deepEqual(Object.keys(event), [
    "schema_version",
    "event_id",
    "occurred_at",
    "environment",
    "experiment_id",
    "cohort",
    "event_name",
    "outcome",
    "anonymous_day_hash",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_id",
    "platform",
  ]);
  assert.equal(event.experiment_id, PAID_ACQUISITION_EXPERIMENT_ID);
  assert.equal(Object.isFrozen(event), true);

  assert.throws(
    () =>
      createPaidAcquisitionLifecycleEvent({
        environment: "test",
        cohort: PAID_ACQUISITION_CONTROL_COHORT,
        eventName: "mc_checkout_started",
        outcome: "success",
        anonymousDayHash: DAY_HASH,
      }),
    expectCode("invalid_request"),
  );
  assert.throws(
    () =>
      createPaidAcquisitionLifecycleEvent({
        environment: "test",
        cohort: PAID_ACQUISITION_PAID_COHORT,
        eventName: "mc_checkout_paid",
        outcome: "success",
        anonymousDayHash: DAY_HASH,
        email: "must-not-enter-telemetry@example.com",
      }),
    expectCode("invalid_request"),
  );
  assert.throws(
    () =>
      createPaidAcquisitionLifecycleEvent({
        environment: "production",
        cohort: PAID_ACQUISITION_PAID_COHORT,
        eventName: "mc_checkout_paid",
        outcome: "success",
        anonymousDayHash: DAY_HASH,
        attribution: { utmCampaign: "free form is rejected" },
      }),
    expectCode("invalid_request"),
  );
});

test("receipt-gated paid artifact delivery records one canonical installer request", async () => {
  const calls = [];
  const occurredAt = new Date("2026-07-27T12:00:00.000Z");
  const stage = await recordPaidAcquisitionInstallerRequest({
    acquisitionId: ACQUISITION_ID,
    checkoutId: INTENT_REF,
    platform: "macos-universal",
    occurredAt,
  }, {
    recordStage: async (input) => {
      calls.push(["stage", input]);
      return { ownerConflict: false, acquisitionId: input.acquisitionId };
    },
    addEvidence: async (input) => {
      calls.push(["evidence", input]);
      return { id: input.acquisitionId };
    },
  });

  assert.equal(stage.acquisitionId, ACQUISITION_ID);
  assert.deepEqual(calls, [
    ["stage", {
      acquisitionId: ACQUISITION_ID,
      stage: "installer_requested",
      stableServerReference:
        `paid-installer-request:${INTENT_REF}:macos-universal`,
      occurredAt,
    }],
    ["evidence", {
      acquisitionId: ACQUISITION_ID,
      evidence: "installer_redirect",
    }],
  ]);
});

test("authenticated paid activation binds the browser receipt and records the verified install", async () => {
  const receipt = Buffer.alloc(32, 11).toString("base64url");
  const accountId = "40000000-0000-4000-8000-000000000001";
  const entitlementRef = "40000000-0000-4000-8000-000000000002";
  const activationRef = "40000000-0000-4000-8000-000000000004";
  const claimId = "40000000-0000-4000-8000-000000000005";
  const checkoutId = "40000000-0000-4000-8000-000000000006";
  const paidProfileId = "40000000-0000-4000-8000-000000000007";
  const installProfileId = "40000000-0000-4000-8000-000000000008";
  const installIdHash = "a".repeat(64);
  const installerReceiptIdHash = "b".repeat(64);
  const queries = [];
  const integrityCalls = [];
  const mergeCalls = [];
  let binding = null;
  const identity = {
    paid_profile_id: paidProfileId,
    install_profile_id: installProfileId,
    install_membership_id: "40000000-0000-4000-8000-000000000009",
    install_id_hash: installIdHash,
    install_identity_link_id: "40000000-0000-4000-8000-000000000010",
    activation_identity_link_id: "40000000-0000-4000-8000-000000000011",
    account_identity_link_id: "40000000-0000-4000-8000-000000000012",
    installer_receipt_identity_link_id:
      "40000000-0000-4000-8000-000000000013",
    installer_receipt_id_hash: installerReceiptIdHash,
    install_owner_account_id: null,
  };
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("paid-telemetry-binding:select-activation")) {
        return {
          rows: [{
            activation_ref: activationRef,
            activation_source_matches: true,
            activation_expired: false,
            activation_account_ref: accountId,
            activation_entitlement_ref: entitlementRef,
          }],
        };
      }
      if (sql.includes("paid-telemetry-binding:select-claim")) {
        return {
          rows: [{
            claim_id: claimId,
            checkout_id: checkoutId,
            claim_activation_ref: null,
            claim_account_ref: accountId,
            claim_entitlement_ref: entitlementRef,
            claim_state: "claimed",
            claim_expired: false,
            payment_state: "active",
            payment_verified: true,
            authorization_expired: false,
            checkout_account_ref: accountId,
            entitlement_account_ref: accountId,
            entitlement_status: "active",
            acquisition_id: ACQUISITION_ID,
            acquisition_integrity_state: "intact",
          }],
        };
      }
      if (sql.includes("paid-telemetry-binding:select-exact-identities")) {
        return { rows: [structuredClone(identity)] };
      }
      if (sql.includes("paid-telemetry-binding:select-binding")) {
        return { rows: binding ? [structuredClone(binding)] : [] };
      }
      if (sql.includes("paid-telemetry-binding:bind-claim")) {
        return { rows: [{ id: claimId }] };
      }
      if (sql.includes("paid-telemetry-binding:insert-binding")) {
        binding = {
          license_namespace: params[0],
          claim_id: params[1],
          checkout_id: params[2],
          acquisition_id: params[3],
          account_id: params[4],
          entitlement_id: params[5],
          activation_ref: params[6],
          profile_id_at_binding: params[7],
          install_membership_id: params[8],
          install_id_hash: params[9],
          install_identity_link_id: params[10],
          activation_identity_link_id: params[11],
          account_identity_link_id: params[12],
          installer_receipt_identity_link_id: params[13],
          installer_receipt_id_hash: params[14],
          binding_key: params[15],
        };
        return { rows: [] };
      }
      throw new Error("Unexpected paid activation query");
    },
  };
  const occurredAt = new Date("2026-08-08T12:00:00.000Z");
  const result = await associatePaidAcquisitionActivation({
    environment: "production",
    activationKey: "activation-test-key",
    expectedAccountId: accountId,
    receipt,
    installIdHash,
    installerReceiptIdHash,
    occurredAt,
  }, {
    transaction: async (callback) => callback(client),
    recordStage: async (input, options) => {
      integrityCalls.push(["stage", input, options]);
      return { ownerConflict: false };
    },
    addEvidence: async (input, options) => {
      integrityCalls.push(["evidence", input, options]);
    },
    mergeProfiles: async (runner, environment, input) => {
      mergeCalls.push({ runner, environment, input });
      identity.paid_profile_id = installProfileId;
      identity.install_profile_id = installProfileId;
      identity.install_owner_account_id = accountId;
      return {
        merged: true,
        survivorId: installProfileId,
        tombstoneId: paidProfileId,
      };
    },
  });

  assert.deepEqual(result, { associated: true, installationClaimed: true });
  assert.equal(queries.length, 8);
  assert.deepEqual(queries[0].params, [
    "activation-test-key",
    PAID_ACQUISITION_SOURCE,
  ]);
  assert.deepEqual(queries[1].params, [
    "production",
    createHash("sha256").update(receipt).digest("hex"),
  ]);
  const identityQueries = queries.filter(({ sql }) =>
    sql.includes("paid-telemetry-binding:select-exact-identities")
  );
  assert.equal(identityQueries.length, 2);
  for (const query of identityQueries) {
    assert.deepEqual(query.params, [
      "production",
      activationRef,
      installIdHash,
      installerReceiptIdHash,
      accountId,
    ]);
  }
  assert.equal(mergeCalls.length, 1);
  assert.equal(mergeCalls[0].runner, client);
  assert.equal(mergeCalls[0].environment, "production");
  assert.deepEqual(mergeCalls[0].input, {
    leftProfileId: paidProfileId,
    rightProfileId: installProfileId,
    evidenceType: "installer_receipt_hash",
    evidenceValueHash: binding.binding_key,
    initiatedBy: "system",
  });
  assert.equal(binding.account_id, accountId);
  assert.equal(binding.install_id_hash, installIdHash);
  assert.equal(binding.installer_receipt_id_hash, installerReceiptIdHash);
  assert.equal(integrityCalls[0][0], "stage");
  assert.deepEqual(integrityCalls[0][1], {
    acquisitionId: ACQUISITION_ID,
    stage: "installation_claimed",
    stableServerReference: `installation:${installIdHash}`,
    occurredAt,
  });
  assert.deepEqual(integrityCalls[1][1], {
    acquisitionId: ACQUISITION_ID,
    evidence: "verified_installation_claim",
  });
});

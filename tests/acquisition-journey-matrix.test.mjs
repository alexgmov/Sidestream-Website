import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import {
  ACQUISITION_JOURNEY_MATRIX,
  REQUIRED_JOURNEY_COVERAGE,
  assertNoProhibitedAcquisitionFields,
  validateAcquisitionJourneyMatrix,
} from "../scripts/test-acquisition-journey-matrix.mjs";
import {
  ACQUISITION_STAGE_COUNTING_GRAINS,
} from "../api/_lib/acquisition-integrity.ts";
import {
  CUSTOMER_360_NON_POSTGRES_TESTS,
  CUSTOMER_360_POSTGRES_TESTS,
} from "../scripts/run-customer-360-tests.mjs";

test("machine-readable matrix covers every supported acquisition journey exactly once", () => {
  assert.deepEqual(validateAcquisitionJourneyMatrix(), {
    version: 1,
    journeys: ACQUISITION_JOURNEY_MATRIX.length,
    coverage: REQUIRED_JOURNEY_COVERAGE.length,
  });
  assert.equal(new Set(ACQUISITION_JOURNEY_MATRIX.map((row) => row.id)).size,
    ACQUISITION_JOURNEY_MATRIX.length);
  assert.equal(globalThis.__SIDESTREAM_ACQUISITION_MATRIX_NETWORK_GUARD__.externalNetwork,
    "blocked");
});

test("every journey states attribution, namespace, intent, Stripe, stage, state, report, and privacy truth", () => {
  for (const row of ACQUISITION_JOURNEY_MATRIX) {
    assert.equal(row.namespace, "test", row.id);
    assert.ok(row.source && row.channel && row.confidence, row.id);
    assert.ok(row.intentAcquisitionId, row.id);
    assert.ok(row.stripeReferenceAgreement, row.id);
    assert.deepEqual(
      row.deduplicationGrains,
      Object.fromEntries(row.requiredStages.map((stage) => [
        stage,
        ACQUISITION_STAGE_COUNTING_GRAINS[stage],
      ])),
      row.id,
    );
    assert.deepEqual(Object.keys(row.paymentState), ["paid", "refunded", "disputed"], row.id);
    assert.deepEqual(Object.keys(row.reportCohortInclusion), ["first_install", "first_purchase"],
      row.id);
    assertNoProhibitedAcquisitionFields({
      acquisition: {
        source: row.source,
        channel: row.channel,
        confidence: row.confidence,
        namespace: row.namespace,
        stages: row.requiredStages,
      },
    });
  }
});

test("all new Checkout intent writers require acquisition_id and Stripe references agree", async () => {
  const [account, checkoutStart, paidCheckout, migration] = await Promise.all([
    readFile(new URL("../api/_lib/account.ts", import.meta.url), "utf8"),
    readFile(new URL("../api/checkout/start.ts", import.meta.url), "utf8"),
    readFile(new URL("../api/paid-acquisition/checkout.ts", import.meta.url), "utf8"),
    readFile(new URL(
      "../db/migrations/20260803120000_add_acquisition_integrity.sql",
      import.meta.url,
    ), "utf8"),
  ]);
  const intentInserts = [...account.matchAll(
    /insert into public\.sidestream_checkout_intents\s*\(([^)]+)\)/gi,
  )];
  assert.equal(intentInserts.length, 3);
  for (const match of intentInserts) assert.match(match[1], /\bacquisition_id\b/i);
  assert.match(account, /requiredAcquisitionId\(options\.acquisitionId\)/);
  assert.match(account, /requireCanonicalAcquisition\(acquisitionId\)/);
  assert.match(account, /sidestream_acquisition_id:\s*row\.acquisition_id/);
  assert.match(checkoutStart, /createCheckoutIntent\(\{[\s\S]*acquisitionId:\s*acquisition\.acquisitionId/);
  assert.match(paidCheckout, /createCheckoutIntentConfirmation\(\{[\s\S]*request,[\s\S]*response/);
  assert.match(migration, /before insert on public\.sidestream_checkout_intents/i);
  assert.match(migration, /Historical intents deliberately stay null/i);
  for (const stage of [
    "authentication_completed", "checkout_started", "checkout_completed",
    "payment_settled", "refunded", "disputed",
  ]) {
    assert.match(account, new RegExp(`stage:\\s*[\"']${stage}[\"']`), stage);
  }
});

test("matrix evidence exists and every Customer 360 suite is registered canonically", async () => {
  const evidence = new Set(ACQUISITION_JOURNEY_MATRIX.flatMap((row) => row.evidence));
  await Promise.all([...evidence].map((filename) => access(new URL(`../${filename}`, import.meta.url))));
  for (const filename of [
    "customer-360/acquisition-integrity.test.mjs",
    "customer-360/privacy-contract.test.mjs",
  ]) {
    assert.ok(CUSTOMER_360_NON_POSTGRES_TESTS.includes(filename), filename);
  }
  for (const filename of [
    "customer-360/acquisition-integrity-postgres.test.mjs",
    "customer-360/acquisition-integrity-pipeline-postgres.test.mjs",
  ]) {
    assert.ok(CUSTOMER_360_POSTGRES_TESTS.includes(filename), filename);
  }
});

test("privacy validator rejects prohibited fields at any nesting depth", () => {
  for (const field of ["email", "install_id_hash", "stripeCustomerId", "charge_id"]) {
    assert.throws(
      () => assertNoProhibitedAcquisitionFields({ safe: { [field]: "secret" } }),
      /Prohibited acquisition field/,
      field,
    );
  }
});

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

test("claim SQL atomically terminalizes exhausted work and claims only below the cap", async (t) => {
  const runtime = await loadStripeEventsModule();
  t.after(() => rm(runtime.directory, { recursive: true, force: true }));

  const claimToken = "00000000-0000-4000-8000-000000000101";
  let statement = "";
  let parameters = [];
  const event = stripeEvent("evt_claimed", "test.claimed");
  const rawPayload = JSON.stringify(event);
  const claimed = await runtime.stripeEvents.claimStripeEvents({
    batchSize: 3,
    leaseMs: 1_234,
    maxAttempts: 8,
    claimToken,
    query: async (text, params) => {
      statement = text;
      parameters = params;
      return {
        rows: [{
          claim_result: "claimed",
          event_id: "evt_claimed",
          event_type: "test.claimed",
          stripe_created_at: "2026-07-17T00:00:00.000Z",
          payload: event,
          raw_payload: rawPayload,
          ingress_evidence_supported: true,
          ingress_event_id: event.id,
          ingress_event_type: event.type,
          ingress_payload_sha256: canonicalJsonDigest(event),
          ingress_raw_sha256: sha256(rawPayload),
          ingress_api_version: event.api_version,
          ingress_livemode: event.livemode,
          ingress_created: event.created,
          attempt_count: 8,
          claim_token: claimToken,
        }],
      };
    },
  });

  assert.deepEqual(parameters, [3, claimToken, 1_234, 8]);
  assert.equal((statement.match(/for update skip locked/g) || []).length, 2);
  assert.match(statement, /with exhausted_candidates as materialized/);
  assert.match(statement, /attempt_count >= \$4/);
  assert.match(statement, /processing_status = 'dead_letter'/);
  assert.match(statement, /terminal_at = clock_timestamp\(\)/);
  assert.match(statement, /claim_attempt_limit_exhausted/);
  assert.match(statement, /claimable_candidates as materialized/);
  assert.match(statement, /attempt_count < \$4/);
  assert.match(statement, /limit greatest\(\$1 - \(select count\(\*\) from dead_lettered\), 0\)/);
  assert.match(statement, /attempt_count = event\.attempt_count \+ 1/);
  assert.doesNotMatch(statement, /event\.ingress_event_id/);
  assert.match(statement, /to_jsonb\(event\) \? 'ingress_event_id'/);
  assert.deepEqual(claimed, [{
    eventId: "evt_claimed",
    eventType: "test.claimed",
    stripeCreatedAt: "2026-07-17T00:00:00.000Z",
    payload: event,
    rawPayload,
    ingressEventId: event.id,
    ingressEventType: event.type,
    ingressPayloadSha256: canonicalJsonDigest(event),
    ingressRawSha256: sha256(rawPayload),
    ingressApiVersion: event.api_version,
    ingressLivemode: false,
    ingressCreated: event.created,
    attemptCount: 8,
    claimToken,
  }]);
});

test("signed-event persistence falls back only when optional ingress columns are absent", async (t) => {
  const runtime = await loadStripeEventsModule();
  t.after(() => rm(runtime.directory, { recursive: true, force: true }));
  const event = stripeEvent("evt_baseline_insert", "checkout.session.completed");
  const rawPayload = JSON.stringify(event);
  const statements = [];
  const parameters = [];

  assert.equal(await runtime.stripeEvents.recordStripeEvent(
    event,
    rawPayload,
    async (statement, params) => {
      statements.push(statement);
      parameters.push(params);
      if (statements.length === 1) {
        throw Object.assign(new Error(
          'column "ingress_event_id" of relation "sidestream_stripe_events" does not exist',
        ), { code: "42703" });
      }
      return { rows: [{ event_id: event.id }] };
    },
  ), true);

  assert.equal(statements.length, 2);
  assert.match(statements[0], /ingress_event_id/);
  assert.doesNotMatch(statements[1], /ingress_event_id/);
  assert.deepEqual(parameters[1], [
    event.id,
    event.type,
    event.created,
    JSON.stringify(event),
    rawPayload,
  ]);

  let attempts = 0;
  await assert.rejects(
    runtime.stripeEvents.recordStripeEvent(event, rawPayload, async () => {
      attempts += 1;
      throw Object.assign(new Error('column "required_column" does not exist'), {
        code: "42703",
      });
    }),
    /required_column/,
  );
  assert.equal(attempts, 1);
});

test("baseline-schema claims validate against the signed raw payload", async (t) => {
  const runtime = await loadStripeEventsModule();
  t.after(() => rm(runtime.directory, { recursive: true, force: true }));
  const event = stripeEvent("evt_baseline_claim", "checkout.session.completed");
  const rawPayload = JSON.stringify(event);
  const claimToken = "00000000-0000-4000-8000-000000000105";
  const claimed = await runtime.stripeEvents.claimStripeEvents({
    claimToken,
    query: async () => ({
      rows: [{
        claim_result: "claimed",
        event_id: event.id,
        event_type: event.type,
        stripe_created_at: new Date(event.created * 1_000).toISOString(),
        payload: event,
        raw_payload: rawPayload,
        ingress_evidence_supported: false,
        attempt_count: 1,
        claim_token: claimToken,
      }],
    }),
  });

  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].ingressEvidence, "derived");
  let processingCalls = 0;
  const processed = await runtime.stripeEvents.processClaimedStripeEvent(claimed[0], {
    query: async () => ({ rows: [{ event_id: event.id }] }),
    processEvent: async () => {
      processingCalls += 1;
      return { status: "processed", outcome: "checkout_fulfilled" };
    },
    now: () => 10_000,
    log: () => {},
  });
  assert.equal(processed.status, "processed");
  assert.equal(processingCalls, 1);

  const tampered = await runtime.stripeEvents.processClaimedStripeEvent({
    ...claimed[0],
    rawPayload: JSON.stringify({ ...event, type: "checkout.session.expired" }),
    claimToken: "00000000-0000-4000-8000-000000000106",
  }, {
    query: async () => ({ rows: [{ event_id: event.id }] }),
    processEvent: async () => {
      processingCalls += 1;
      return { status: "processed", outcome: "must_not_run" };
    },
    now: () => 10_000,
    random: () => 0,
    log: () => {},
  });
  assert.equal(tampered.status, "retryable");
  assert.equal(processingCalls, 1);
});

test("claim-side exhaustion is reported without a ninth processing call", async (t) => {
  const runtime = await loadStripeEventsModule();
  t.after(() => rm(runtime.directory, { recursive: true, force: true }));

  const claimToken = "00000000-0000-4000-8000-000000000102";
  let processed = 0;
  const logs = [];
  const query = async (_text, params) => {
    assert.equal(params[3], 8);
    return {
      rows: [{
        claim_result: "dead_lettered",
        event_id: "evt_exhausted",
        event_type: "test.crashed",
        stripe_created_at: "2026-07-17T00:00:00.000Z",
        payload: stripeEvent("evt_exhausted", "test.crashed"),
        attempt_count: 8,
        claim_token: null,
      }],
    };
  };

  assert.deepEqual(await runtime.stripeEvents.claimStripeEvents({
    claimToken,
    query,
  }), []);

  const summary = await runtime.stripeEvents.drainStripeEventQueue({
    maxAttempts: 8,
    createClaimToken: () => claimToken,
    query,
    processEvent: async () => {
      processed += 1;
      return { status: "processed", outcome: "must_not_run" };
    },
    log: (entry) => logs.push(entry),
  });
  assert.deepEqual(summary, {
    claimed: 0,
    processed: 0,
    ignored: 0,
    retryable: 0,
    deadLetter: 1,
  });
  assert.equal(processed, 0);
  assert.deepEqual(logs, [{
    eventId: "evt_exhausted",
    eventType: "test.crashed",
    attempt: 8,
    outcome: "dead_letter",
    durationMs: 0,
  }]);
});

test("queue processing retries ingress identity tampering without invoking handlers", async (t) => {
  const runtime = await loadStripeEventsModule();
  t.after(() => rm(runtime.directory, { recursive: true, force: true }));
  const event = stripeEvent("evt_tampered", "refund.failed");
  const rawPayload = JSON.stringify(event);
  let processingCalls = 0;
  let failureParameters = [];
  const result = await runtime.stripeEvents.processClaimedStripeEvent({
    eventId: event.id,
    eventType: event.type,
    stripeCreatedAt: "2025-07-17T00:00:00.000Z",
    payload: event,
    rawPayload,
    ingressEventId: "evt_different",
    ingressEventType: event.type,
    ingressPayloadSha256: canonicalJsonDigest(event),
    ingressRawSha256: sha256(rawPayload),
    ingressApiVersion: event.api_version,
    ingressLivemode: event.livemode,
    ingressCreated: event.created,
    attemptCount: 1,
    claimToken: "00000000-0000-4000-8000-000000000104",
  }, {
    query: async (_text, params) => {
      failureParameters = params;
      return { rows: [{ event_id: event.id }] };
    },
    processEvent: async () => {
      processingCalls += 1;
      return { status: "processed", outcome: "must_not_run" };
    },
    now: () => 10_000,
    random: () => 0,
    log: () => {},
  });

  assert.deepEqual(result, {
    status: "retryable",
    outcome: "retryable",
    durationMs: 0,
  });
  assert.equal(processingCalls, 0);
  assert.ok(failureParameters.includes("payload_identity_mismatch"));
});

async function loadStripeEventsModule() {
  const directory = await mkdtemp(join(tmpdir(), "sidestream-claim-cap-"));
  try {
    const accountStub = join(directory, "account-stub.mjs");
    const commerceStub = join(directory, "commerce-stub.mjs");
    const environmentStub = join(directory, "environment-stub.mjs");
    await writeFile(accountStub, `
export async function query() { throw new Error("query must be injected"); }
export async function upsertLicenseFromCheckoutSession() { return { fulfilled: false }; }
export async function upsertLicenseFromSubscription() { return { fulfilled: false }; }
export function getStripe() { throw new Error("Stripe must not be contacted"); }
export function getStripeRequestOptions() { return {}; }
`, { mode: 0o600 });
    await writeFile(commerceStub, `
export async function materializeCustomerCommerceEvent() {
  throw new Error("commerce must not run in claim-cap tests");
}
`, { mode: 0o600 });
    await writeFile(environmentStub, `
export function resolveLicenseEnvironment() { return null; }
`, { mode: 0o600 });

    let source = await readFile(
      join(repositoryRoot, "api/_lib/stripe-events.ts"),
      "utf8",
    );
    const replacements = {
      "./account.js": pathToFileURL(accountStub).href,
      "./customer-commerce.js": pathToFileURL(commerceStub).href,
      "./license-environment.js": pathToFileURL(environmentStub).href,
    };
    for (const [original, replacement] of Object.entries(replacements)) {
      source = source.replaceAll(JSON.stringify(original), JSON.stringify(replacement));
    }
    const modulePath = join(directory, "stripe-events-under-test.ts");
    await writeFile(modulePath, source, { mode: 0o600 });
    const stripeEvents = await import(
      `${pathToFileURL(modulePath).href}?test=${randomUUID()}`
    );
    return { directory, stripeEvents };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function stripeEvent(id, type) {
  return {
    id,
    object: "event",
    api_version: "2026-06-24.dahlia",
    created: 1_752_710_400,
    data: { object: { id: `object_${id}` } },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJsonDigest(value) {
  return sha256(JSON.stringify(sortJsonValue(JSON.parse(JSON.stringify(value)))));
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, sortJsonValue(entry)]));
}

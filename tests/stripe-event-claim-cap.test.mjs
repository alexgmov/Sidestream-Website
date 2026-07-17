import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
          payload: stripeEvent("evt_claimed", "test.claimed"),
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
  assert.match(statement, /attempt_count = event\.attempt_count \+ 1/);
  assert.deepEqual(claimed, [{
    eventId: "evt_claimed",
    eventType: "test.claimed",
    stripeCreatedAt: "2026-07-17T00:00:00.000Z",
    payload: stripeEvent("evt_claimed", "test.claimed"),
    attemptCount: 8,
    claimToken,
  }]);
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
    api_version: "2026-06-30.basil",
    created: 1_752_710_400,
    data: { object: { id: `object_${id}` } },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
  };
}

import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import {
  classifyMigrationState,
  loadMigrationFiles,
  migrationSqlForTransaction,
  validateMigrationFiles,
} from "../scripts/apply-postgres-migrations.mjs";
import {
  RUNTIME_DATABASE_ENV_NAMES,
  TEST_DATABASE_ENV,
  createTestPoolOptions,
  requireSafeTestDatabaseUrl,
} from "../scripts/run-postgres-integration.mjs";
import { invokeHandler } from "./helpers/http.mjs";

const repositoryRoot = new URL("..", import.meta.url);
const CONTROLLED_ENVIRONMENT = [
  "SIDESTREAM_LICENSE_HASH_SECRET",
  "SIDESTREAM_PRO_PRODUCT_ID",
  "SIDESTREAM_PRO_PRICE_ID",
  "STRIPE_SECRET_KEY",
  "VERCEL_ENV",
  "SIDESTREAM_LICENSE_NAMESPACE",
];

test("cross-lane contracts hold in one isolated disposable Postgres schema", {
  timeout: 180_000,
}, async (t) => {
  const testDatabaseUrl = requireSafeTestDatabaseUrl(process.env);
  const schema = `sidestream_api_it_${randomBytes(10).toString("hex")}`;
  const quotedSchema = quoteIdentifier(schema);
  const pool = new Pool(createTestPoolOptions(testDatabaseUrl));
  const environmentSnapshot = snapshotEnvironment(CONTROLLED_ENVIRONMENT);
  const temporaryDirectory = await mkdtemp(
    join(new URL(".", import.meta.url).pathname, ".postgres-integration-"),
  );
  const runtimeSymbol = Symbol.for(`sidestream.postgres.integration.${schema}`);
  let schemaCreated = false;

  try {
    await pool.query(`create schema ${quotedSchema}`);
    schemaCreated = true;
    const migrations = validateMigrationFiles(await loadMigrationFiles());

    await t.test("concurrent runners serialize the full checksummed migration chain", async () => {
      const applied = await Promise.all([
        applyMigrationsWithLock(pool, schema, migrations),
        applyMigrationsWithLock(pool, schema, migrations),
      ]);
      assert.deepEqual(applied.sort((left, right) => left - right), [0, migrations.length]);

      const ledger = await pool.query(
        `select filename, checksum_sha256, applied_at, duration_ms
         from ${quotedSchema}.sidestream_schema_migrations order by filename`,
      );
      assert.equal(ledger.rows.length, migrations.length);
      assert.ok(classifyMigrationState(migrations, ledger.rows).every(
        (migration) => migration.status === "applied",
      ));
      const drifted = migrations.map((migration, index) =>
        index === 0 ? { ...migration, checksum: "0".repeat(64) } : migration
      );
      assert.throws(
        () => classifyMigrationState(drifted, ledger.rows),
        /checksum drift detected/i,
      );
    });

    assertSafetyGuard(testDatabaseUrl);
    globalThis[runtimeSymbol] = { pool, connectionString: testDatabaseUrl };
    const runtime = await loadSchemaRuntime({
      schema,
      temporaryDirectory,
      runtimeSymbol,
    });
    const query = (text, params = []) => pool.query(text, [...params]);

    await t.test("atomic limiter upserts and lead dedupe converge under contention", async () => {
      const now = new Date("2026-07-14T20:05:00.000Z");
      const limitResults = await Promise.all(Array.from({ length: 25 }, () =>
        runtime.rateLimit.consumeRateLimit({
          scope: "integration-rate-limit",
          dimensions: [{ name: "ip", value: "203.0.113.9", limit: 10 }],
          windowSeconds: 600,
          now,
          secret: "rate-limit-integration-secret-long-enough",
          runner: pool,
        })
      ));
      assert.equal(limitResults.filter((result) => result.allowed).length, 10);
      const limiter = await pool.query(
        `select request_count from ${quotedSchema}.sidestream_api_rate_limits
         where scope = 'integration-rate-limit'`,
      );
      assert.deepEqual(limiter.rows.map((row) => row.request_count), [25]);

      const leadSecret = "lead-integration-secret-that-is-long-enough";
      const leads = Array.from({ length: 12 }, (_, index) =>
        runtime.downloadLeads.buildCanonicalDownloadLead({
          email: "Dedupe@Example.com",
          source: "download-email-gate",
          utmCampaign: `campaign-${index}`,
        }, {
          capturedAt: new Date(Date.UTC(2026, 6, 14, 20, 0, index)),
          secret: leadSecret,
        })
      );
      await Promise.all(leads.map((lead) =>
        runtime.downloadLeads.upsertCanonicalDownloadLead(pool, lead)
      ));
      const canonical = await pool.query(
        `select email, cta_source, submission_count, utm_campaign
         from ${quotedSchema}.sidestream_download_leads
         where email = 'dedupe@example.com'`,
      );
      assert.equal(canonical.rows.length, 1);
      assert.equal(canonical.rows[0].cta_source, "download-email-gate");
      assert.equal(Number(canonical.rows[0].submission_count), leads.length);
      assert.equal(canonical.rows[0].utm_campaign, "campaign-11");
    });

    const accountFixture = await seedAccountLicenseAndSession(pool, quotedSchema);

    await t.test("checkout intent reuse creates one Stripe Session under concurrent retries", async () => {
      configureCheckoutEnvironment();
      let stripeCreates = 0;
      runtime.account.__setPostgresIntegrationStripeClient({
        prices: {
          async retrieve(id) {
            return {
              id,
              active: true,
              product: "prod_integration",
              unit_amount: 999,
              currency: "usd",
              recurring: null,
            };
          },
        },
        checkout: {
          sessions: {
            async create() {
              stripeCreates += 1;
              return {
                id: "cs_integration_reused",
                url: "https://checkout.stripe.test/cs_integration_reused",
                expires_at: Math.floor(Date.now() / 1000) + 3_600,
              };
            },
          },
        },
      });
      const confirmation = await runtime.account.createCheckoutIntentConfirmation({
        session: null,
      });
      assert.ok(confirmation);
      const attempts = await Promise.all([
        runtime.account.createOrReuseCheckoutSession({
          intentId: confirmation.intentId,
          browserToken: confirmation.browserToken,
          session: null,
          baseUrl: "https://sidestream.tv",
        }),
        runtime.account.createOrReuseCheckoutSession({
          intentId: confirmation.intentId,
          browserToken: confirmation.browserToken,
          session: null,
          baseUrl: "https://sidestream.tv",
        }),
      ]);
      assert.equal(stripeCreates, 1);
      assert.deepEqual(attempts.map((attempt) => attempt.reused).sort(), [false, true]);
      assert.equal(new Set(attempts.map((attempt) => attempt.url)).size, 1);
    });

    await t.test("the partial credential invariant permits only one live family", async () => {
      const activation = await pool.query(
        `insert into ${quotedSchema}.sidestream_activation_sessions (
           activation_key, account_id, license_id, device_id_hash, status, expires_at
         ) values ($1, $2, $3, $4, 'paid', now() + interval '1 day') returning id`,
        [
          "activation-credential-invariant",
          accountFixture.accountId,
          accountFixture.licenseId,
          "d".repeat(64),
        ],
      );
      const insertCredential = (suffix) => pool.query(
        `insert into ${quotedSchema}.sidestream_license_tokens (
           account_id, license_id, activation_session_id, device_id_hash,
           token_hash, refresh_token_hash, expires_at, refresh_expires_at
         ) values ($1, $2, $3, $4, $5, $6, now() + interval '1 hour',
           now() + interval '1 day') returning id`,
        [
          accountFixture.accountId,
          accountFixture.licenseId,
          activation.rows[0].id,
          "d".repeat(64),
          digest(`access-${suffix}`),
          digest(`refresh-${suffix}`),
        ],
      );
      const contenders = await Promise.allSettled([
        insertCredential("first"),
        insertCredential("second"),
      ]);
      assert.equal(contenders.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = contenders.find((result) => result.status === "rejected");
      assert.equal(rejected.reason.code, "23505");
      const live = await pool.query(
        `select id from ${quotedSchema}.sidestream_license_tokens
         where activation_session_id = $1 and revoked_at is null`,
        [activation.rows[0].id],
      );
      assert.equal(live.rows.length, 1);
      await pool.query(
        `update ${quotedSchema}.sidestream_license_tokens set revoked_at = now()
         where id = $1`,
        [live.rows[0].id],
      );
      await insertCredential("successor");
    });

    await t.test("SKIP LOCKED claims are disjoint and leases recover through dead-letter", async () => {
      for (let index = 0; index < 6; index += 1) {
        const event = stripeEvent(`evt_batch_${index}`, 1_720_000_000 + index);
        assert.equal(
          await runtime.stripeEvents.recordStripeEvent(event, JSON.stringify(event), query),
          true,
        );
      }
      const [first, second] = await Promise.all([
        runtime.stripeEvents.claimStripeEvents({
          batchSize: 3,
          claimToken: "00000000-0000-4000-8000-000000000101",
          query,
        }),
        runtime.stripeEvents.claimStripeEvents({
          batchSize: 3,
          claimToken: "00000000-0000-4000-8000-000000000102",
          query,
        }),
      ]);
      assert.equal(first.length, 3);
      assert.equal(second.length, 3);
      assert.equal(
        first.some((row) => second.some((candidate) => candidate.eventId === row.eventId)),
        false,
      );
      await finishEvents(pool, quotedSchema, [...first, ...second].map((row) => row.eventId));

      const leaseEvent = stripeEvent("evt_expired_lease", 1_720_000_100);
      await runtime.stripeEvents.recordStripeEvent(
        leaseEvent,
        JSON.stringify(leaseEvent),
        query,
      );
      await pool.query(
        `update ${quotedSchema}.sidestream_stripe_events
         set processing_status = 'processing', attempt_count = 2,
           claim_token = '00000000-0000-4000-8000-000000000103',
           lease_expires_at = now() - interval '1 minute'
         where event_id = $1`,
        [leaseEvent.id],
      );
      const recovered = await runtime.stripeEvents.claimStripeEvents({
        batchSize: 1,
        claimToken: "00000000-0000-4000-8000-000000000104",
        query,
      });
      assert.equal(recovered[0].eventId, leaseEvent.id);
      assert.equal(recovered[0].attemptCount, 3);
      await finishEvents(pool, quotedSchema, [leaseEvent.id]);

      const poison = stripeEvent("evt_dead_letter", 1_720_000_200);
      await runtime.stripeEvents.recordStripeEvent(poison, JSON.stringify(poison), query);
      const drainOptions = {
        batchSize: 1,
        leaseMs: 1_000,
        maxAttempts: 2,
        processEvent: async () => {
          throw new Error("poison event");
        },
        createClaimToken: randomUUID,
        random: () => 0,
        now: () => 1_000,
        log: () => {},
        query,
      };
      const retry = await runtime.stripeEvents.drainStripeEventQueue(drainOptions);
      assert.equal(retry.retryable, 1);
      await pool.query(
        `update ${quotedSchema}.sidestream_stripe_events
         set next_attempt_at = now() - interval '1 second' where event_id = $1`,
        [poison.id],
      );
      const deadLetter = await runtime.stripeEvents.drainStripeEventQueue(drainOptions);
      assert.equal(deadLetter.deadLetter, 1);
      const terminal = await pool.query(
        `select processing_status, attempt_count from ${quotedSchema}.sidestream_stripe_events
         where event_id = $1`,
        [poison.id],
      );
      assert.deepEqual(terminal.rows[0], {
        processing_status: "dead_letter",
        attempt_count: 2,
      });
    });

    await t.test("a poisoned Stripe row cannot break /api/auth/session", async () => {
      const event = stripeEvent("evt_poisoned_session_read", 1_720_000_300);
      await runtime.stripeEvents.recordStripeEvent(event, JSON.stringify(event), query);
      await pool.query(
        `update ${quotedSchema}.sidestream_stripe_events
         set payload = '{"poisoned":true}'::jsonb where event_id = $1`,
        [event.id],
      );
      const result = await invokeHandler(runtime.authSession.default, {
        method: "GET",
        url: "/api/auth/session",
        headers: { cookie: `sidestream_session=${accountFixture.sessionToken}` },
      });
      assert.equal(result.response.statusCode, 200);
      assert.equal(result.response.json.authenticated, true);
      assert.equal(result.response.json.license.active, true);
      const untouched = await pool.query(
        `select processing_status, attempt_count from ${quotedSchema}.sidestream_stripe_events
         where event_id = $1`,
        [event.id],
      );
      assert.deepEqual(untouched.rows[0], {
        processing_status: "received",
        attempt_count: 0,
      });
      await pool.query(
        `delete from ${quotedSchema}.sidestream_stripe_events where event_id = $1`,
        [event.id],
      );
    });

    await t.test("maintenance advisory locking excludes overlap and then drains bounded work", async () => {
      const config = runtime.maintenance.loadMaintenanceConfiguration({
        SIDESTREAM_MAINTENANCE_BATCH_SIZE: "50",
      });
      const lockClient = await pool.connect();
      try {
        await lockClient.query("begin");
        await lockClient.query("select pg_advisory_xact_lock(hashtext($1))", [
          runtime.maintenance.MAINTENANCE_LOCK_KEY,
        ]);
        const locked = await runtime.maintenance.runMaintenanceJob({
          config,
          pool,
          referenceTime: new Date("2030-01-01T00:00:00.000Z"),
        });
        assert.equal(locked.outcome, "locked");
        await lockClient.query("rollback");
      } finally {
        lockClient.release();
      }
      const completed = await runtime.maintenance.runMaintenanceJob({
        config,
        pool,
        referenceTime: new Date("2030-01-01T00:00:00.000Z"),
      });
      assert.equal(completed.outcome, "completed");
      assert.ok(completed.counts.rateLimitBucketsDeleted >= 1);
      assert.ok(completed.batchSize <= 50);
    });
  } finally {
    restoreEnvironment(environmentSnapshot);
    delete globalThis[runtimeSymbol];
    if (schemaCreated) {
      await pool.query(`drop schema if exists ${quotedSchema} cascade`).catch(() => {});
    }
    await pool.end().catch(() => {});
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

async function applyMigrationsWithLock(pool, schema, migrations) {
  const quotedSchema = quoteIdentifier(schema);
  const client = await pool.connect();
  let applied = 0;
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [
      `sidestream:test-migrations:${schema}`,
    ]);
    await client.query(`
      create table if not exists ${quotedSchema}.sidestream_schema_migrations (
        filename text primary key,
        checksum_sha256 text not null,
        applied_at timestamptz not null default now(),
        duration_ms bigint not null check (duration_ms >= 0)
      )
    `);
    const ledger = await client.query(
      `select filename, checksum_sha256, applied_at, duration_ms
       from ${quotedSchema}.sidestream_schema_migrations order by filename`,
    );
    const statuses = classifyMigrationState(migrations, ledger.rows);
    for (const migration of statuses.filter((candidate) => candidate.status === "pending")) {
      await client.query("begin");
      try {
        await client.query(rewritePublicSchema(
          migrationSqlForTransaction(migration.sql),
          schema,
        ));
        await client.query(
          `insert into ${quotedSchema}.sidestream_schema_migrations (
             filename, checksum_sha256, applied_at, duration_ms
           ) values ($1, $2, now(), 0)`,
          [migration.filename, migration.checksum],
        );
        await client.query("commit");
        applied += 1;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
    }
    return applied;
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [
      `sidestream:test-migrations:${schema}`,
    ]).catch(() => {});
    client.release();
  }
}

async function loadSchemaRuntime({ schema, temporaryDirectory, runtimeSymbol }) {
  const postgresStubPath = join(temporaryDirectory, "postgres-stub.mjs");
  await writeFile(postgresStubPath, `
const runtime = globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(runtimeSymbol))})];
if (!runtime) throw new Error("Postgres integration runtime is unavailable");
export function getPostgresPool() { return runtime.pool; }
export function getOptionalRuntimePostgresConnectionString() { return runtime.connectionString; }
export function normalizePostgresConnectionString(value) { return String(value); }
export function requireRuntimePostgresTarget() {
  return { connectionString: runtime.connectionString, environmentVariable: "${TEST_DATABASE_ENV}", pooled: true };
}
export async function withPostgresTransaction(callback) {
  const client = await runtime.pool.connect();
  try {
    await client.query("begin");
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
`, { mode: 0o600 });
  const accountStubPath = join(temporaryDirectory, "stripe-account-stub.mjs");
  await writeFile(accountStubPath, `
export async function query() { throw new Error("Inject a Postgres query into queue tests"); }
`, { mode: 0o600 });
  const postgresStubUrl = pathToFileURL(postgresStubPath).href;
  const accountStubUrl = pathToFileURL(accountStubPath).href;

  const rateLimitUrl = await writeSchemaModule({
    schema,
    temporaryDirectory,
    name: "rate-limit",
    source: "api/_lib/rate-limit.ts",
    replacements: { "./postgres.js": postgresStubUrl },
  });
  const downloadLeadsUrl = await writeSchemaModule({
    schema,
    temporaryDirectory,
    name: "download-leads",
    source: "api/_lib/download-leads.ts",
    replacements: {
      "./rate-limit.js": rateLimitUrl,
      "./postgres.js": postgresStubUrl,
    },
  });
  const maintenanceUrl = await writeSchemaModule({
    schema,
    temporaryDirectory,
    name: "maintenance",
    source: "api/_lib/maintenance.ts",
    replacements: { "./postgres.js": postgresStubUrl },
  });
  const telemetryIdentityUrl = await writeSchemaModule({
    schema,
    temporaryDirectory,
    name: "telemetry-identity",
    source: "api/_lib/telemetry-identity.ts",
  });
  const accountUrl = await writeSchemaModule({
    schema,
    temporaryDirectory,
    name: "account",
    source: "api/_lib/account.ts",
    replacements: {
      "./entitlement.js": new URL("../api/_lib/entitlement.ts", import.meta.url).href,
      "./device-policy.js": new URL("../api/_lib/device-policy.ts", import.meta.url).href,
      "./license-environment.js": new URL(
        "../api/_lib/license-environment.ts",
        import.meta.url,
      ).href,
      "./telemetry-identity.js": telemetryIdentityUrl,
      "./maintenance.js": maintenanceUrl,
      "./postgres.js": postgresStubUrl,
    },
    append: `
export function __setPostgresIntegrationStripeClient(value: Stripe | null) {
  stripeClient = value;
}
`,
  });
  const authSessionUrl = await writeSchemaModule({
    schema,
    temporaryDirectory,
    name: "auth-session",
    source: "api/auth/session.ts",
    replacements: { "../_lib/account.js": accountUrl },
  });
  const stripeEventsUrl = await writeSchemaModule({
    schema,
    temporaryDirectory,
    name: "stripe-events",
    source: "api/_lib/stripe-events.ts",
    replacements: {
      "./account.js": accountStubUrl,
      "./license-environment.js": new URL(
        "../api/_lib/license-environment.ts",
        import.meta.url,
      ).href,
    },
  });

  const nonce = randomUUID();
  const [rateLimit, downloadLeads, maintenance, account, authSession, stripeEvents] =
    await Promise.all([
      import(`${rateLimitUrl}?test=${nonce}`),
      import(`${downloadLeadsUrl}?test=${nonce}`),
      import(`${maintenanceUrl}?test=${nonce}`),
      import(`${accountUrl}?test=${nonce}`),
      import(`${authSessionUrl}?test=${nonce}`),
      import(`${stripeEventsUrl}?test=${nonce}`),
    ]);
  return { rateLimit, downloadLeads, maintenance, account, authSession, stripeEvents };
}

async function writeSchemaModule(options) {
  let source = rewritePublicSchema(
    await readFile(new URL(`../${options.source}`, import.meta.url), "utf8"),
    options.schema,
  );
  for (const [original, replacement] of Object.entries(options.replacements || {})) {
    assert.ok(source.includes(JSON.stringify(original)), `missing import ${original}`);
    source = source.replaceAll(JSON.stringify(original), JSON.stringify(replacement));
  }
  source += options.append || "";
  const destination = join(options.temporaryDirectory, `${options.name}-under-test.ts`);
  await writeFile(destination, source, { mode: 0o600 });
  return pathToFileURL(destination).href;
}

async function seedAccountLicenseAndSession(pool, quotedSchema) {
  const account = await pool.query(
    `insert into ${quotedSchema}.sidestream_accounts (
       google_sub, email, display_name, stripe_customer_id
     ) values ('google-integration', 'owner@example.com', 'Owner', 'cus_integration')
     returning id`,
  );
  const license = await pool.query(
    `insert into ${quotedSchema}.sidestream_licenses (
       account_id, stripe_customer_id, stripe_checkout_session_id,
       plan_key, status, entitlement_status, status_reason, features
     ) values ($1, 'cus_integration', 'cs_integration_license',
       'sidestream_pro', 'active', 'active', 'payment_paid', '{}'::jsonb)
     returning id`,
    [account.rows[0].id],
  );
  const sessionToken = "postgres-integration-session";
  await pool.query(
    `insert into ${quotedSchema}.sidestream_account_sessions (
       account_id, session_token_hash, expires_at
     ) values ($1, $2, now() + interval '1 day')`,
    [account.rows[0].id, digest(sessionToken)],
  );
  return {
    accountId: account.rows[0].id,
    licenseId: license.rows[0].id,
    sessionToken,
  };
}

async function finishEvents(pool, quotedSchema, eventIds) {
  await pool.query(
    `update ${quotedSchema}.sidestream_stripe_events
     set processing_status = 'processed', processed_at = now(), terminal_at = now(),
       outcome = 'integration_complete', claim_token = null, lease_expires_at = null
     where event_id = any($1::text[])`,
    [eventIds],
  );
}

function stripeEvent(id, created) {
  return {
    id,
    type: "test.integration",
    created,
    data: { object: { id: `object_${id}` } },
  };
}

function assertSafetyGuard(testDatabaseUrl) {
  assert.throws(() => requireSafeTestDatabaseUrl({}), /never skip silently/);
  for (const name of RUNTIME_DATABASE_ENV_NAMES) {
    assert.throws(
      () => requireSafeTestDatabaseUrl({
        [TEST_DATABASE_ENV]: testDatabaseUrl,
        [name]: addConnectionOption(testDatabaseUrl),
      }),
      new RegExp(name),
    );
  }
}

function addConnectionOption(connectionString) {
  const url = new URL(connectionString);
  url.searchParams.set("application_name", "sidestream-safety-proof");
  return url.toString();
}

function configureCheckoutEnvironment() {
  delete process.env.VERCEL_ENV;
  delete process.env.SIDESTREAM_LICENSE_NAMESPACE;
  process.env.SIDESTREAM_LICENSE_HASH_SECRET =
    "checkout-integration-secret-that-is-long-enough";
  process.env.SIDESTREAM_PRO_PRODUCT_ID = "prod_integration";
  process.env.SIDESTREAM_PRO_PRICE_ID = "price_integration";
  process.env.STRIPE_SECRET_KEY = "sk_test_integration";
}

function rewritePublicSchema(source, schema) {
  // The runtime uses both SQL template literals and quoted table-name
  // constants. The generated schema is identifier-safe, so an unquoted
  // replacement remains valid in both JavaScript strings and SQL.
  return source.replace(/\bpublic\./g, `${schema}.`);
}

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
    throw new TypeError("Unsafe Postgres schema identifier");
  }
  return `"${identifier}"`;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function snapshotEnvironment(names) {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(snapshot) {
  for (const [name, value] of snapshot) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

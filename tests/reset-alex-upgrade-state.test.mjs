import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLY_CONFIRMATION,
  RESET_TARGETS,
  allCountsZero,
  applyDatabaseReset,
  buildNeonCliEnvironment,
  buildResetReport,
  extractNeonConnectionString,
  loadResetSecretCredentials,
  listMatchingStripeCustomers,
  matchesTargetIdentity,
  mergeInventoryHints,
  parseArgs,
  parseResetEnvironmentFile,
  validateStripeKey,
  verifyNeonConnectionString,
} from "../scripts/reset-alex-upgrade-state.mjs";

test("reset CLI is dry-run by default and strongly confirms apply", () => {
  assert.deepEqual(parseArgs([]), {
    apply: false,
    confirmation: "",
    help: false,
  });
  assert.deepEqual(
    parseArgs(["--apply", `--confirm=${APPLY_CONFIRMATION}`]),
    {
      apply: true,
      confirmation: APPLY_CONFIRMATION,
      help: false,
    },
  );
  assert.throws(
    () => parseArgs(["--apply"]),
    /Apply mode requires --confirm/,
  );
  assert.throws(
    () => parseArgs(["--apply", "--confirm", "DELETE-EVERYONE"]),
    /Apply mode requires --confirm/,
  );
  assert.throws(() => parseArgs(["--production-only"]), /Unknown argument/);
});

test("macOS Keychain fills only missing reset credentials", async () => {
  const reads = [];
  const environment = {
    SIDESTREAM_RESET_PRODUCTION_STRIPE_SECRET_KEY: "sk_live_from_env",
  };
  await loadResetSecretCredentials(environment, {
    platform: "darwin",
    readKeychainSecret: async (service) => {
      reads.push(service);
      return "sk_test_from_keychain";
    },
  });
  assert.deepEqual(reads, ["SIDESTREAM_RESET_TEST_STRIPE_SECRET_KEY"]);
  assert.deepEqual(environment, {
    SIDESTREAM_RESET_PRODUCTION_STRIPE_SECRET_KEY: "sk_live_from_env",
    SIDESTREAM_RESET_TEST_STRIPE_SECRET_KEY: "sk_test_from_keychain",
  });

  const linuxEnvironment = {};
  await loadResetSecretCredentials(linuxEnvironment, {
    platform: "linux",
    readKeychainSecret: async () => {
      throw new Error("must not read Keychain");
    },
  });
  assert.deepEqual(linuxEnvironment, {});
});

test("identity matching is exact after case and whitespace normalization", () => {
  assert.equal(
    matchesTargetIdentity({ email: "  ALEX@ALEXG.MOV " }),
    true,
  );
  assert.equal(
    matchesTargetIdentity({ email: "alexg@wispr.ai" }),
    true,
  );
  assert.equal(
    matchesTargetIdentity({ name: " alex GARRETT " }),
    true,
  );
  assert.equal(
    matchesTargetIdentity({ email: "alex+test@alexg.mov" }),
    false,
  );
  assert.equal(
    matchesTargetIdentity({ name: "Alex Garrettson" }),
    false,
  );
});

test("Neon connection parsing accepts CLI shapes without printing credentials", () => {
  const raw =
    "postgresql://neondb_owner:secret@ep-safe.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require";
  assert.equal(extractNeonConnectionString(raw), raw);
  assert.equal(
    extractNeonConnectionString(JSON.stringify({ connection_string: raw })),
    raw,
  );
  assert.throws(
    () => extractNeonConnectionString("not a connection"),
    /did not return a connection string/,
  );
});

test("Neon target verification requires direct fixed-role verify-full endpoints", () => {
  const target = RESET_TARGETS[0];
  const verified = verifyNeonConnectionString(
    "postgresql://neondb_owner:secret@ep-safe.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require",
    target,
  );
  assert.equal(verified.endpointId, "ep-safe");
  assert.equal(
    new URL(verified.connectionString).searchParams.get("sslmode"),
    "verify-full",
  );
  assert.equal(verified.connectionString.includes("secret"), true);

  assert.throws(
    () => verifyNeonConnectionString(
      "postgresql://neondb_owner:secret@ep-safe-pooler.c-2.us-east-1.aws.neon.tech/neondb",
      target,
    ),
    /refuses pooled/,
  );
  assert.throws(
    () => verifyNeonConnectionString(
      "postgresql://other_role:secret@ep-safe.c-2.us-east-1.aws.neon.tech/neondb",
      target,
    ),
    /role or database/,
  );
  assert.throws(
    () => verifyNeonConnectionString(
      "postgresql://neondb_owner:secret@database.example.com/neondb",
      target,
    ),
    /not a direct Neon endpoint/,
  );
});

test("Stripe key modes are fail-closed", () => {
  assert.equal(
    validateStripeKey("sk_live_example", "production"),
    "sk_live_example",
  );
  assert.equal(
    validateStripeKey("sk_test_example", "test"),
    "sk_test_example",
  );
  assert.throws(
    () => validateStripeKey("sk_test_wrong", "production"),
    /requires a sk_live_/,
  );
  assert.throws(
    () => validateStripeKey("rk_live_restricted", "production"),
    /requires a sk_live_/,
  );
});

test("reset env files accept only the two Stripe keys and Neon never inherits them", () => {
  const parsed = parseResetEnvironmentFile(`
# Fixed reset credentials
SIDESTREAM_RESET_PRODUCTION_STRIPE_SECRET_KEY="sk_live_example"
SIDESTREAM_RESET_TEST_STRIPE_SECRET_KEY=sk_test_example
`);
  assert.deepEqual(parsed, {
    SIDESTREAM_RESET_PRODUCTION_STRIPE_SECRET_KEY: "sk_live_example",
    SIDESTREAM_RESET_TEST_STRIPE_SECRET_KEY: "sk_test_example",
  });
  assert.throws(
    () => parseResetEnvironmentFile("STRIPE_SECRET_KEY=sk_live_wrong"),
    /unsupported key/,
  );
  assert.throws(
    () => parseResetEnvironmentFile(
      "SIDESTREAM_RESET_TEST_STRIPE_SECRET_KEY=one\n" +
      "SIDESTREAM_RESET_TEST_STRIPE_SECRET_KEY=two",
    ),
    /repeats key/,
  );

  const sanitized = buildNeonCliEnvironment({
    PATH: "/bin",
    HOME: "/Users/example",
    SIDESTREAM_RESET_ENV_FILE: "/tmp/reset.env",
    SIDESTREAM_RESET_PRODUCTION_STRIPE_SECRET_KEY: "sk_live_example",
    SIDESTREAM_RESET_TEST_STRIPE_SECRET_KEY: "sk_test_example",
  });
  assert.deepEqual(sanitized, {
    PATH: "/bin",
    HOME: "/Users/example",
  });
});

test("Stripe inventory paginates and returns only exact target identities", async () => {
  const pages = [
    {
      data: [
        { id: "cus_one", email: "alex@alexg.mov", name: null },
        { id: "cus_other", email: "other@example.com", name: "Other" },
      ],
      has_more: true,
    },
    {
      data: [
        { id: "cus_two", email: null, name: "Alex Garrett" },
        { id: "cus_deleted", deleted: true, name: "Alex Garrett" },
      ],
      has_more: false,
    },
  ];
  const calls = [];
  const stripe = {
    customers: {
      list: async (params) => {
        calls.push(params);
        return pages[calls.length - 1];
      },
    },
  };

  const matches = await listMatchingStripeCustomers(stripe);
  assert.deepEqual(matches.map((customer) => customer.id), [
    "cus_one",
    "cus_two",
  ]);
  assert.deepEqual(calls, [
    { limit: 100 },
    { limit: 100, starting_after: "cus_other" },
  ]);
});

test("inventory hints merge deterministically and zero checks cover every table", () => {
  const merged = mergeInventoryHints(
    {
      ids: {
        accountIds: ["a", "b"],
        eventIds: ["evt_1"],
        seeds: ["alex@alexg.mov"],
      },
    },
    {
      ids: {
        accountIds: ["b", "c"],
        eventIds: ["evt_2"],
        seeds: ["alex@alexg.mov", "cus_1"],
      },
    },
  );
  assert.deepEqual(merged.accountIds, ["a", "b", "c"]);
  assert.deepEqual(merged.eventIds, ["evt_1", "evt_2"]);
  assert.deepEqual(merged.seeds, ["alex@alexg.mov", "cus_1"]);
  assert.equal(allCountsZero({ accounts: 0, stripeEvents: 0 }), true);
  assert.equal(allCountsZero({ accounts: 0, stripeEvents: 1 }), false);
});

test("database reset deletes paid-acquisition dependents before the core checkout intent", async () => {
  const checkoutIntentId = "11111111-1111-4111-8111-111111111111";
  const paidCheckoutId = "22222222-2222-4222-8222-222222222222";
  const paidClaimId = "33333333-3333-4333-8333-333333333333";
  const paidOutboxId = "44444444-4444-4444-8444-444444444444";
  const deletedTables = [];
  let released = false;

  const client = {
    async query(sql, params = []) {
      const normalizedSql = sql.replace(/\s+/g, " ").trim();
      if (normalizedSql.includes("from information_schema.tables")) {
        return {
          rows: params[0].map((table_name) => ({ table_name })),
        };
      }
      const deleteMatch = normalizedSql.match(
        /^delete from public\.([a-z0-9_]+)/,
      );
      if (deleteMatch) {
        deletedTables.push(deleteMatch[1]);
        return { rowCount: 1, rows: [] };
      }
      if (
        normalizedSql.includes(
          "from public.sidestream_paid_acquisition_email_outbox",
        )
      ) {
        return {
          rows: [{ id: paidOutboxId, checkout_id: paidCheckoutId }],
        };
      }
      if (
        normalizedSql.includes(
          "from public.sidestream_paid_acquisition_claims",
        )
      ) {
        return {
          rows: [{ id: paidClaimId, checkout_id: paidCheckoutId }],
        };
      }
      if (
        normalizedSql.includes(
          "from public.sidestream_paid_acquisition_checkouts",
        )
      ) {
        return {
          rows: [{
            id: paidCheckoutId,
            checkout_intent_ref: checkoutIntentId,
          }],
        };
      }
      if (
        normalizedSql.includes("from public.sidestream_checkout_intents")
      ) {
        return {
          rows: [{
            id: checkoutIntentId,
            account_id: null,
            activation_session_id: null,
            stripe_customer_id: null,
            stripe_checkout_session_id: null,
          }],
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {
      released = true;
    },
  };
  const pool = {
    async connect() {
      return client;
    },
  };

  const result = await applyDatabaseReset(
    pool,
    RESET_TARGETS[0],
    [],
    { checkoutIntentIds: [checkoutIntentId] },
  );

  assert.deepEqual(deletedTables, [
    "sidestream_paid_acquisition_email_outbox",
    "sidestream_paid_acquisition_claims",
    "sidestream_paid_acquisition_checkouts",
    "sidestream_checkout_intents",
  ]);
  assert.deepEqual(result.deleted, {
    deviceTransfers: 0,
    licenseTokens: 0,
    paidAcquisitionEmailOutbox: 1,
    paidAcquisitionClaims: 1,
    paidAcquisitionCheckouts: 1,
    checkoutIntents: 1,
    accountDevices: 0,
    activationSessions: 0,
    telemetryIdentityLinks: 0,
    licenses: 0,
    accountSessions: 0,
    accounts: 0,
    customerIdentityLinks: 0,
    stripeEvents: 0,
  });
  assert.equal(released, true);
});

test("report names exact providers and documents intentionally preserved history", () => {
  const runtime = {
    target: RESET_TARGETS[0],
    database: { endpointId: "ep-safe" },
    stripeIdentityCustomerIds: ["cus_one"],
    databaseLinkedCustomerIds: ["cus_one"],
    stripeCustomerIds: ["cus_one"],
    deletedStripeCustomerIds: [],
    inventory: {
      counts: {
        accounts: 1,
        stripeEvents: 2,
      },
    },
    deletedCounts: null,
  };
  const report = buildResetReport({
    mode: "dry-run",
    runtimes: [runtime],
  });
  assert.equal(report.environments[0].neonProjectId, "dark-butterfly-59697025");
  assert.equal(report.environments[0].stripeAccountId, "acct_1Tp340DFKjeGlioX");
  assert.match(report.preserved.join(" "), /immutable identity reviews/);
  assert.match(report.preserved.join(" "), /Local CEP\/plugin installations/);
  assert.equal(JSON.stringify(report).includes("sk_live_"), false);
  assert.equal(JSON.stringify(report).includes("postgresql://"), false);
});

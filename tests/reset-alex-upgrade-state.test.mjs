import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLY_CONFIRMATION,
  RESET_TARGETS,
  allCountsZero,
  buildNeonCliEnvironment,
  buildResetReport,
  extractNeonConnectionString,
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

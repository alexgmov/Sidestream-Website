import assert from "node:assert/strict";
import test from "node:test";
import {
  Customer360RetentionError,
  RETENTION_DOMAINS,
  buildDomainInventoryQuery,
  fingerprintDatabaseTarget,
  normalizeRetentionPolicy,
  parseRetentionArgs,
  retentionPolicyDigest,
  runRetentionInventory,
  runRetentionSelfTest,
} from "../../scripts/plan-customer-360-retention.mjs";

test("CLI requires an explicit namespace and policy and has no apply mode", () => {
  assert.throws(() => parseRetentionArgs([]), /explicit --namespace/);
  assert.throws(
    () => parseRetentionArgs(["--namespace", "test"]),
    /explicit reviewed --policy/,
  );
  assert.throws(
    () => parseRetentionArgs(["--apply", "--namespace", "test", "--policy", "policy.json"]),
    /mutation\/apply is unavailable/,
  );
  assert.throws(
    () => parseRetentionArgs(["--apply", "--namespace", "production", "--policy", "policy.json"]),
    /mutation\/apply is unavailable/,
  );
  assert.deepEqual(
    parseRetentionArgs([
      "--dry-run",
      "--namespace",
      "test",
      "--policy",
      "/restricted/reviewed-policy.json",
    ]),
    {
      dryRun: true,
      help: false,
      selfTest: false,
      namespace: "test",
      policyPath: "/restricted/reviewed-policy.json",
    },
  );
  assert.equal(parseRetentionArgs(["--self-test"]).selfTest, true);
});

test("policy is complete, per-domain, bounded, and preserves immutable records", () => {
  const policy = buildPolicy();
  const normalized = normalizeRetentionPolicy(policy);
  assert.deepEqual(Object.keys(normalized.domains), RETENTION_DOMAINS.map(({ key }) => key));
  assert.equal(normalized.domains.immutableMergeAudits.action, "preserve");
  assert.equal(normalized.domains.pendingIdentityReviews.action, "preserve");
  assert.equal(retentionPolicyDigest(policy), retentionPolicyDigest(normalized));

  const missingDomain = structuredClone(policy);
  delete missingDomain.domains.usageProfiles;
  assert.throws(() => normalizeRetentionPolicy(missingDomain), /must contain exactly/);

  const unknownField = structuredClone(policy);
  unknownField.domains.identityLinks.identityValue = "customer.private@example.com";
  assert.throws(() => normalizeRetentionPolicy(unknownField), /must contain exactly/);

  const sharedTtlShortcut = structuredClone(policy);
  sharedTtlShortcut.ttlDays = 90;
  assert.throws(() => normalizeRetentionPolicy(sharedTtlShortcut), /must contain exactly/);

  const mutableAudit = structuredClone(policy);
  mutableAudit.domains.immutableMergeAudits = {
    action: "delete",
    ageBucketsDays: [30, 90],
    minimumAgeDays: 365,
  };
  assert.throws(() => normalizeRetentionPolicy(mutableAudit), /immutable.*preserve/);

  const mutableReview = structuredClone(policy);
  mutableReview.domains.pendingIdentityReviews = {
    action: "review",
    ageBucketsDays: [30, 90],
    minimumAgeDays: 365,
  };
  assert.throws(() => normalizeRetentionPolicy(mutableReview), /immutable.*preserve/);

  const unsortedBuckets = structuredClone(policy);
  unsortedBuckets.domains.profileRoots.ageBucketsDays = [90, 30];
  assert.throws(() => normalizeRetentionPolicy(unsortedBuckets), /strictly increasing/);
});

test("every domain query returns aggregates only and contains no write statement", () => {
  const policy = normalizeRetentionPolicy(buildPolicy());
  for (const domain of RETENTION_DOMAINS) {
    const query = buildDomainInventoryQuery(domain.key, policy.domains[domain.key]);
    assert.match(query.text, /count\(\*\)/i);
    assert.match(query.text, /license_namespace = \$1/i);
    assert.doesNotMatch(
      query.text,
      /\b(?:delete|insert|update|truncate|alter|drop|create)\b/i,
    );
    assert.doesNotMatch(
      query.text,
      /select\s+(?:[^\n]*\.)?(?:id|profile_id|install_id_hash|link_value|contact_email)\b/i,
    );
    assert.equal(query.bucketLabels.length, policy.domains[domain.key].ageBucketsDays.length + 1);
  }
});

test("inventory runs atomically read-only and emits only privacy-safe aggregates", async () => {
  const policy = normalizeRetentionPolicy(buildPolicy());
  const privateValues = [
    "customer.private@example.com",
    "cus_private_customer",
    "a".repeat(64),
    "db.customer360.example",
    "super-secret-password",
  ];
  const calls = [];
  let domainIndex = 0;
  let releases = 0;
  const pool = {
    async connect() {
      return {
        async query(query) {
          calls.push(query);
          if (typeof query === "string") return { rows: [] };
          const config = policy.domains[RETENTION_DOMAINS[domainIndex].key];
          domainIndex += 1;
          const row = {
            total_count: "13",
            unknown_age_count: "1",
            actionable_count: config.action === "preserve" ? "0" : "3",
          };
          for (let index = 0; index <= config.ageBucketsDays.length; index += 1) {
            row[`bucket_${index}`] = "4";
          }
          return { rows: [row] };
        },
        release() {
          releases += 1;
        },
      };
    },
  };
  const databaseUrl =
    "postgresql://retention_operator:super-secret-password@db.customer360.example:5432/sidestream?sslmode=verify-full";
  const report = await runRetentionInventory({
    policy,
    namespace: "test",
    databaseUrl,
    pool,
  });

  assert.equal(report.mode, "dry_run_inventory");
  assert.equal(report.namespace, "test");
  assert.match(report.targetFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.match(report.policyDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(report.domains.length, RETENTION_DOMAINS.length);
  assert.deepEqual(
    report.domains.map(({ domain }) => domain),
    RETENTION_DOMAINS.map(({ key }) => key),
  );
  assert.equal(report.domains[0].totalCount, 13);
  assert.equal(report.domains[0].ageBuckets.at(-1).bucket, "unknown");
  assert.equal(report.domains[1].proposedAction.candidateCount, 3);
  assert.equal(report.domains[6].proposedAction.action, "preserve");
  assert.equal(report.domains[7].proposedAction.action, "preserve");
  assert.equal(calls[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(releases, 1);
  const serialized = JSON.stringify(report);
  for (const privateValue of privateValues) {
    assert.equal(serialized.includes(privateValue), false);
  }
  assert.deepEqual(
    Object.keys(report).sort(),
    ["domains", "mode", "namespace", "policyDigest", "targetFingerprint"],
  );
});

test("database failures roll back and are redacted", async () => {
  const calls = [];
  let releases = 0;
  const pool = {
    async connect() {
      return {
        async query(query) {
          calls.push(query);
          if (typeof query !== "string") {
            throw new Error(
              "customer.private@example.com at postgresql://user:secret@private-host/database",
            );
          }
          return { rows: [] };
        },
        release() {
          releases += 1;
        },
      };
    },
  };
  await assert.rejects(
    runRetentionInventory({
      policy: buildPolicy(),
      namespace: "test",
      databaseUrl:
        "postgresql://operator:password@db.example.test/database?sslmode=verify-full",
      pool,
    }),
    (error) => {
      assert.ok(error instanceof Customer360RetentionError);
      assert.equal(error.message, "Retention inventory database read failed.");
      return true;
    },
  );
  assert.equal(calls[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(releases, 1);
});

test("invalid policy fails before a pool can connect", async () => {
  let connections = 0;
  const policy = buildPolicy();
  delete policy.domains.commerceMaterializations;
  await assert.rejects(
    runRetentionInventory({
      policy,
      namespace: "test",
      databaseUrl:
        "postgresql://operator:password@db.example.test/database?sslmode=verify-full",
      pool: {
        connect() {
          connections += 1;
          throw new Error("must not connect");
        },
      },
    }),
    /must contain exactly/,
  );
  assert.equal(connections, 0);
});

test("remote targets force authenticated TLS and fingerprint safely", () => {
  assert.match(fingerprintDatabaseTarget(
    "postgresql://operator:password@db.example.test/database?sslmode=require",
    "test",
  ), /^sha256:[0-9a-f]{64}$/);
  assert.throws(() => fingerprintDatabaseTarget(
    "postgresql://operator:password@db.example.test/database?sslmode=disable",
    "test",
  ));
  assert.throws(
    () => fingerprintDatabaseTarget(
      "postgresql://db.example.test/database?sslmode=verify-full",
      "test",
    ),
    /database URL is invalid/,
  );
  const first = fingerprintDatabaseTarget(
    "postgresql://operator:first@db.example.test:5432/database?sslmode=verify-full",
    "test",
  );
  const rotatedCredential = fingerprintDatabaseTarget(
    "postgresql://operator:second@db.example.test:5432/database?sslmode=verify-full",
    "test",
  );
  const production = fingerprintDatabaseTarget(
    "postgresql://operator:first@db.example.test:5432/database?sslmode=verify-full",
    "production",
  );
  assert.equal(first, rotatedCredential);
  assert.notEqual(first, production);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.includes("operator"), false);
  assert.equal(first.includes("database"), false);
});

test("no-write self-test covers every domain without a database", async () => {
  const result = await runRetentionSelfTest();
  assert.deepEqual(
    {
      mode: result.mode,
      domains: result.domains,
      databaseConnections: result.databaseConnections,
      simulatedPoolConnections: result.simulatedPoolConnections,
      writeStatements: result.writeStatements,
    },
    {
      mode: "dry_run_inventory",
      domains: 8,
      databaseConnections: 0,
      simulatedPoolConnections: 1,
      writeStatements: 0,
    },
  );
});

function buildPolicy() {
  return {
    version: 1,
    domains: Object.fromEntries(
      RETENTION_DOMAINS.map((domain, index) => [
        domain.key,
        domain.immutable || index % 3 === 0
          ? {
              action: "preserve",
              ageBucketsDays: [30 + index, 90 + index],
              minimumAgeDays: null,
            }
          : {
              action: index % 2 === 0 ? "delete" : "review",
              ageBucketsDays: [30 + index, 90 + index],
              minimumAgeDays: 365 + index,
            },
      ]),
    ),
  };
}

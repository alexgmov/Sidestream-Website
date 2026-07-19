import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const verifier = path.join(
  repositoryRoot,
  "scripts",
  "verify-customer-360-preview-environment.mjs",
);

function isolatedFixtures() {
  return {
    preview: {
      SIDESTREAM_TEST_POSTGRES_URL:
        "postgresql://preview-license:preview-db-secret@preview-db.example.invalid/sidestream_preview?sslmode=require",
      SIDESTREAM_POSTGRES_URL:
        "postgres://preview-runtime:other-preview-secret@PREVIEW-DB.example.invalid:5432/sidestream_preview?sslmode=require",
      SIDESTREAM_TELEMETRY_POSTGRES_URL:
        "postgresql://preview-reader:preview-telemetry-secret@preview-telemetry.example.invalid/telemetry_preview",
      STRIPE_SECRET_KEY: "sk_test_preview_checkout_secret",
      STRIPE_WEBHOOK_SECRET: "whsec_preview_webhook_secret",
      GOOGLE_CLIENT_ID: "preview-client.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "preview-google-client-secret",
      SIDESTREAM_BASE_URL: "https://preview.sidestream.example",
      GOOGLE_REDIRECT_URI:
        "https://preview.sidestream.example/api/auth/google/callback",
      SIDESTREAM_CRM_ADMIN_SECRET: "preview-crm-admin-secret",
      CRON_SECRET: "preview-cron-secret-value",
      SIDESTREAM_TEST_API_HOSTS: "preview.sidestream.example",
      SIDESTREAM_LICENSE_HASH_SECRET: "preview-license-hash-secret-value-0001",
      SIDESTREAM_RATE_LIMIT_HASH_SECRET: "preview-rate-hash-secret-value-000002",
      SIDESTREAM_LEAD_HASH_SECRET: "preview-lead-hash-secret-value-000003",
      SIDESTREAM_STRIPE_ACCOUNT_ID: "acct_previewCustomer360",
      SIDESTREAM_PRO_PRODUCT_ID: "prod_previewCustomer360",
      SIDESTREAM_PRO_PRICE_ID: "price_previewCustomer360",
      VERCEL_AUTOMATION_BYPASS_SECRET: "preview-vercel-bypass-secret",
    },
    production: {
      SIDESTREAM_POSTGRES_URL:
        "postgresql://production-runtime:production-db-secret@production-db.example.invalid/sidestream?sslmode=require",
      SIDESTREAM_TELEMETRY_POSTGRES_URL:
        "postgresql://production-reader:production-telemetry-secret@production-telemetry.example.invalid/telemetry",
      STRIPE_SECRET_KEY: "sk_live_production_checkout_secret",
      STRIPE_WEBHOOK_SECRET: "whsec_production_webhook_secret",
      GOOGLE_CLIENT_ID: "production-client.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "production-google-client-secret",
      SIDESTREAM_BASE_URL: "https://sidestream.example",
      GOOGLE_REDIRECT_URI:
        "https://sidestream.example/api/auth/google/callback",
      SIDESTREAM_CRM_ADMIN_SECRET: "production-crm-admin-secret",
      CRON_SECRET: "production-cron-secret-value",
      SIDESTREAM_LICENSE_HASH_SECRET: "production-license-hash-secret-value-01",
      SIDESTREAM_RATE_LIMIT_HASH_SECRET: "production-rate-hash-secret-value-002",
      SIDESTREAM_LEAD_HASH_SECRET: "production-lead-hash-secret-value-003",
      SIDESTREAM_STRIPE_ACCOUNT_ID: "acct_productionCustomer360",
      SIDESTREAM_PRO_PRODUCT_ID: "prod_productionCustomer360",
      SIDESTREAM_PRO_PRICE_ID: "price_productionCustomer360",
    },
  };
}

test("safe isolated snapshots pass with fingerprints and no secret values", async (t) => {
  const fixtures = isolatedFixtures();
  const result = await runVerifier(t, fixtures);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /PASS PREVIEW\.SIDESTREAM_TEST_POSTGRES_URL/);
  assert.match(result.stdout, /PASS PRODUCTION\.SIDESTREAM_POSTGRES_URL/);
  assert.match(result.stdout, /sha256:[0-9a-f]{64}/);
  assert.equal(
    result.stdout.trim().split("\n").every((line) =>
      /^(?:PASS|FAIL)(?: [A-Z0-9_.]+)+(?: sha256:[0-9a-f]{64})*$/.test(line)
    ),
    true,
  );
  assertRedacted(result, fixtures);
});

test("shared Preview and Production targets are rejected through URL aliases", async (t) => {
  const fixtures = isolatedFixtures();
  fixtures.production.SIDESTREAM_POSTGRES_URL =
    "postgres://other-user:other-password@PREVIEW-DB.example.invalid:5432/sidestream_preview?sslmode=disable";
  const result = await runVerifier(t, fixtures);

  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /FAIL PREVIEW\.SIDESTREAM_TEST_POSTGRES_URL PRODUCTION\.SIDESTREAM_POSTGRES_URL/,
  );
  assertRedacted(result, fixtures);
});

test("Preview pooled and direct aliases pass only when their normalized target matches", async (t) => {
  const fixtures = isolatedFixtures();
  let result = await runVerifier(t, fixtures);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  fixtures.preview.SIDESTREAM_POSTGRES_URL =
    "postgres://preview-runtime:secret@different-preview-db.example.invalid/sidestream_preview";
  result = await runVerifier(t, fixtures);
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /FAIL PREVIEW\.SIDESTREAM_TEST_POSTGRES_URL PREVIEW\.SIDESTREAM_POSTGRES_URL/,
  );
  assertRedacted(result, fixtures);
});

test("missing snapshot variables fail instead of inheriting ambient selectors", async (t) => {
  const fixtures = isolatedFixtures();
  delete fixtures.preview.SIDESTREAM_TEST_POSTGRES_URL;
  delete fixtures.preview.STRIPE_SECRET_KEY;
  delete fixtures.preview.SIDESTREAM_CRM_ADMIN_SECRET;
  const result = await runVerifier(t, fixtures, {
    SIDESTREAM_TEST_POSTGRES_URL:
      "postgres://ambient:ambient-db-secret@ambient.example.invalid/ambient",
    STRIPE_SECRET_KEY: "sk_test_ambient_secret_must_not_apply",
    SIDESTREAM_CRM_ADMIN_SECRET: "ambient-crm-secret-must-not-apply",
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL PREVIEW\.SIDESTREAM_TEST_POSTGRES_URL/);
  assert.match(result.stdout, /FAIL PREVIEW\.STRIPE_SECRET_KEY/);
  assert.match(
    result.stdout,
    /FAIL PREVIEW\.SIDESTREAM_CRM_ADMIN_SECRET PRODUCTION\.SIDESTREAM_CRM_ADMIN_SECRET/,
  );
  assert.doesNotMatch(result.stdout + result.stderr, /ambient/i);
});

test("malformed database and base URLs fail without echoing their values", async (t) => {
  const fixtures = isolatedFixtures();
  fixtures.preview.SIDESTREAM_TEST_POSTGRES_URL =
    "not-a-postgres-url-with-private-sentinel";
  fixtures.preview.SIDESTREAM_BASE_URL =
    "http://preview.sidestream.example/private-origin-sentinel";
  const result = await runVerifier(t, fixtures);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL PREVIEW\.SIDESTREAM_TEST_POSTGRES_URL/);
  assert.match(
    result.stdout,
    /FAIL PREVIEW\.SIDESTREAM_BASE_URL PRODUCTION\.SIDESTREAM_BASE_URL/,
  );
  assert.doesNotMatch(result.stdout + result.stderr, /private-sentinel/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-origin-sentinel/);
});

test("a live Stripe secret in Preview fails closed", async (t) => {
  const fixtures = isolatedFixtures();
  fixtures.preview.STRIPE_SECRET_KEY = "sk_live_preview_must_never_run";
  const result = await runVerifier(t, fixtures);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL PREVIEW\.STRIPE_SECRET_KEY/);
  assertRedacted(result, fixtures);
});

test("FREEDEV is sandbox-only and bound to the reviewed account, Product, and Price", async () => {
  const source = await readFile(new URL(
    "../../scripts/ensure-freedev-promo.mjs",
    import.meta.url,
  ), "utf8");
  assert.match(source, /\^sk_test_/);
  assert.doesNotMatch(source, /allow-live|sk_live_/i);
  assert.match(source, /SIDESTREAM_STRIPE_ACCOUNT_ID/);
  assert.match(source, /stripe\.accounts\.retrieve\(\)/);
  assert.match(source, /applies_to: \{ products: \[productId\] \}/);
  assert.match(source, /price\.unit_amount !== 999/);
  assert.match(source, /price\.lookup_key !== PRICE_LOOKUP_KEY/);
  assert.match(source, /sidestream_stripe_account_id/);
});

test("shared CRM, cron, webhook, and Google secrets are rejected", async (t) => {
  for (const variable of [
    "SIDESTREAM_CRM_ADMIN_SECRET",
    "CRON_SECRET",
    "STRIPE_WEBHOOK_SECRET",
    "GOOGLE_CLIENT_SECRET",
  ]) {
    await t.test(variable, async (t) => {
      const fixtures = isolatedFixtures();
      fixtures.preview[variable] = fixtures.production[variable];
      const result = await runVerifier(t, fixtures);

      assert.equal(result.status, 1, variable);
      assert.match(
        result.stdout,
        new RegExp(`FAIL PREVIEW\\.${variable} PRODUCTION\\.${variable}`),
      );
      assertRedacted(result, fixtures);
    });
  }
});

test("telemetry targets must be dedicated to each environment", async (t) => {
  const fixtures = isolatedFixtures();
  fixtures.preview.SIDESTREAM_TELEMETRY_POSTGRES_URL =
    "postgres://telemetry-reader:hidden@preview-db.example.invalid:5432/sidestream_preview?application_name=readonly";
  const result = await runVerifier(t, fixtures);

  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /FAIL PREVIEW\.SIDESTREAM_TELEMETRY_POSTGRES_URL/,
  );
  assertRedacted(result, fixtures);
});

test("stdout and stderr redact every configured value on compound failure", async (t) => {
  const fixtures = isolatedFixtures();
  const sentinel = "NEVER_PRINT_THIS_SECRET_VALUE";
  fixtures.preview.SIDESTREAM_CRM_ADMIN_SECRET = sentinel;
  fixtures.production.SIDESTREAM_CRM_ADMIN_SECRET = sentinel;
  fixtures.preview.CRON_SECRET = sentinel;
  fixtures.production.CRON_SECRET = sentinel;
  fixtures.preview.STRIPE_WEBHOOK_SECRET = `whsec_${sentinel}`;
  fixtures.production.STRIPE_WEBHOOK_SECRET = `whsec_${sentinel}`;
  fixtures.preview.SIDESTREAM_TEST_POSTGRES_URL =
    `postgres://preview:${sentinel}@shared-secret-host.example.invalid/shared_secret_db`;
  fixtures.preview.SIDESTREAM_POSTGRES_URL =
    `postgres://preview-runtime:${sentinel}@shared-secret-host.example.invalid/shared_secret_db`;
  fixtures.production.SIDESTREAM_POSTGRES_URL =
    `postgres://production:${sentinel}@shared-secret-host.example.invalid/shared_secret_db`;
  const result = await runVerifier(t, fixtures);

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(sentinel));
  assert.doesNotMatch(result.stdout + result.stderr, /shared-secret-host/);
  assert.doesNotMatch(result.stdout + result.stderr, /shared_secret_db/);
  assertRedacted(result, fixtures);
});

async function runVerifier(t, fixtures, ambient = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "sidestream-c360-preview-env-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previewFile = path.join(directory, "preview.env");
  const productionFile = path.join(directory, "production.env");
  await Promise.all([
    writeFile(previewFile, serializeEnvironment(fixtures.preview), { mode: 0o600 }),
    writeFile(productionFile, serializeEnvironment(fixtures.production), { mode: 0o600 }),
  ]);
  return spawnSync(process.execPath, [
    verifier,
    "--preview-env-file",
    previewFile,
    "--production-env-file",
    productionFile,
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...ambient },
  });
}

function serializeEnvironment(environment) {
  return `${Object.entries(environment)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join("\n")}\n`;
}

function assertRedacted(result, fixtures) {
  const output = result.stdout + result.stderr;
  for (const environment of [fixtures.preview, fixtures.production]) {
    for (const value of Object.values(environment)) {
      assert.equal(output.includes(value), false, "output exposed a fixture value");
    }
  }
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CUSTOMER_360_NON_POSTGRES_TESTS,
  CUSTOMER_360_POSTGRES_TESTS,
  assertCustomer360TestsClassified,
} from "../../scripts/run-customer-360-tests.mjs";
import {
  RUNTIME_DATABASE_ENV_NAMES,
  createIsolatedTestDatabaseEnvironment,
  requireSafeTestDatabaseUrl,
} from "../../scripts/run-postgres-integration.mjs";
import { listApiTestFiles } from "../../scripts/run-api-tests.mjs";

const disposable = "postgres://disposable:secret@fixture.invalid:5433/customer_360";
const networkGuard = path.resolve("tests/helpers/customer-360-network-guard.mjs");

test("Customer 360 test URL is mandatory and distinct from every deployed database class", () => {
  assert.throws(() => requireSafeTestDatabaseUrl({}), /required.*never skip silently/i);
  for (const name of [
    "SIDESTREAM_POSTGRES_URL",
    "SIDESTREAM_PREVIEW_POSTGRES_URL",
    "SIDESTREAM_DEPLOYED_TEST_POSTGRES_URL",
    "SIDESTREAM_TELEMETRY_POSTGRES_URL",
  ]) {
    assert.ok(RUNTIME_DATABASE_ENV_NAMES.includes(name), name);
    assert.throws(() => requireSafeTestDatabaseUrl({
      SIDESTREAM_TEST_POSTGRES_URL: disposable,
      [name]: "postgres://other:credentials@fixture.invalid:5433/customer_360?sslmode=require",
    }), new RegExp(`must not match runtime database ${name}`));
  }
  for (const name of RUNTIME_DATABASE_ENV_NAMES) {
    assert.throws(() => requireSafeTestDatabaseUrl({
      SIDESTREAM_TEST_POSTGRES_URL: disposable,
      [name]: "postgres://runtime:secret@fixture.invalid:5433/runtime_shadow",
    }), new RegExp(`must not share a Postgres endpoint with runtime database ${name}`));
  }
  assert.equal(requireSafeTestDatabaseUrl({
    SIDESTREAM_TEST_POSTGRES_URL: disposable,
    SIDESTREAM_POSTGRES_URL: "postgres://runtime:secret@runtime.invalid/sidestream",
    SIDESTREAM_TELEMETRY_POSTGRES_URL:
      "postgres://reader:secret@telemetry.invalid/sidestream_telemetry",
  }), disposable);
});

test("Customer 360 guard rejects a runtime database on the test socket before test code runs", () => {
  const marker = "CUSTOMER_360_TEST_BODY_REACHED";
  const result = spawnSync(process.execPath, [
    "--import",
    networkGuard,
    "--input-type=module",
    "-e",
    `process.stdout.write(${JSON.stringify(marker)})`,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: guardEnvironment({
      SIDESTREAM_TEST_POSTGRES_URL: disposable,
      SIDESTREAM_POSTGRES_URL:
        "postgres://runtime:secret@fixture.invalid:5433/production_shadow",
    }),
  });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, new RegExp(marker));
  assert.match(
    result.stderr,
    /must not share a Postgres endpoint with runtime database SIDESTREAM_POSTGRES_URL/,
  );
});

test("Customer 360 guarded children cannot inherit runtime database URL selectors", () => {
  const isolated = createIsolatedTestDatabaseEnvironment(guardEnvironment({
    SIDESTREAM_TEST_POSTGRES_URL: disposable,
    SIDESTREAM_POSTGRES_URL: "postgres://runtime:secret@runtime.invalid/sidestream",
    SIDESTREAM_TELEMETRY_POSTGRES_URL:
      "postgres://reader:secret@telemetry.invalid/sidestream_telemetry",
  }));
  assert.equal(isolated.SIDESTREAM_TEST_POSTGRES_URL, disposable);
  for (const name of RUNTIME_DATABASE_ENV_NAMES) {
    assert.equal(Object.hasOwn(isolated, name), false, name);
  }

  const result = spawnSync(process.execPath, [
    "--import",
    networkGuard,
    "--input-type=module",
    "-e",
    `
      const runtimeNames = ${JSON.stringify(RUNTIME_DATABASE_ENV_NAMES)};
      const leaked = runtimeNames.filter((name) => process.env[name] !== undefined);
      if (leaked.length) throw new Error(\`runtime URL selectors leaked: \${leaked.join(", ")}\`);
      process.stdout.write("CUSTOMER_360_RUNTIME_URLS_SCRUBBED");
    `,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: guardEnvironment({
      SIDESTREAM_TEST_POSTGRES_URL: disposable,
      SIDESTREAM_POSTGRES_URL: "postgres://runtime:secret@runtime.invalid/sidestream",
      SIDESTREAM_TELEMETRY_POSTGRES_URL:
        "postgres://reader:secret@telemetry.invalid/sidestream_telemetry",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "CUSTOMER_360_RUNTIME_URLS_SCRUBBED");
});

test("Customer 360 suites are complete, disjoint, and API-safe", async () => {
  const discovered = await assertCustomer360TestsClassified();
  assert.ok(CUSTOMER_360_NON_POSTGRES_TESTS.includes(
    "customer-360/isolated-postgres-gate.test.mjs",
  ));
  assert.equal(new Set([
    ...CUSTOMER_360_NON_POSTGRES_TESTS,
    ...CUSTOMER_360_POSTGRES_TESTS,
  ]).size, discovered.length);
  assert.ok(CUSTOMER_360_POSTGRES_TESTS.every((filename) =>
    !CUSTOMER_360_NON_POSTGRES_TESTS.includes(filename)
  ));

  const apiFiles = new Set((await listApiTestFiles()).map((filename) =>
    path.relative(path.resolve("tests"), filename).split(path.sep).join("/")
  ));
  for (const filename of CUSTOMER_360_NON_POSTGRES_TESTS) {
    assert.ok(apiFiles.has(filename), `test:api must include ${filename}`);
  }
  for (const filename of CUSTOMER_360_POSTGRES_TESTS) {
    assert.equal(apiFiles.has(filename), false, `test:api must exclude ${filename}`);
  }
});

test("API registry rejects a new unclassified Postgres-looking suite", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidestream-api-registry-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  await writeFile(path.join(directory, "new-postgres-suite.test.mjs"), "");

  await assert.rejects(
    listApiTestFiles(directory),
    /Classify new Postgres tests explicitly: new-postgres-suite\.test\.mjs/,
  );
});

function guardEnvironment(overrides) {
  const environment = { ...process.env };
  for (const name of RUNTIME_DATABASE_ENV_NAMES) delete environment[name];
  return { ...environment, ...overrides };
}

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  CUSTOMER_360_NON_POSTGRES_TESTS,
  CUSTOMER_360_POSTGRES_TESTS,
  assertCustomer360TestsClassified,
} from "../../scripts/run-customer-360-tests.mjs";
import {
  RUNTIME_DATABASE_ENV_NAMES,
  requireSafeTestDatabaseUrl,
} from "../../scripts/run-postgres-integration.mjs";
import { listApiTestFiles } from "../../scripts/run-api-tests.mjs";

const disposable = "postgres://disposable:secret@fixture.invalid:5433/customer_360";

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
  assert.equal(requireSafeTestDatabaseUrl({
    SIDESTREAM_TEST_POSTGRES_URL: disposable,
    SIDESTREAM_POSTGRES_URL: "postgres://runtime:secret@runtime.invalid/sidestream",
    SIDESTREAM_TELEMETRY_POSTGRES_URL:
      "postgres://reader:secret@telemetry.invalid/sidestream_telemetry",
  }), disposable);
});

test("Customer 360 suites are complete, disjoint, and API-safe", async () => {
  const discovered = await assertCustomer360TestsClassified();
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

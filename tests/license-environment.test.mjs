import assert from "node:assert/strict";
import test from "node:test";
import {
  LICENSE_ENVIRONMENT_DEPLOYMENTS,
  LICENSE_ENVIRONMENT_VARIABLES,
  MAX_DIAGNOSTIC_BUILD_CHANNEL_LENGTH,
  getLicenseDiagnosticMetadata,
  licenseCredentialMatchesEnvironment,
  resolveLicenseEnvironment,
} from "../api/_lib/license-environment.ts";

const productionDatabase =
  "postgresql://prod-user:secret@prod.db.example/sidestream";
const testDatabase =
  "postgresql://test-user:secret@test.db.example/sidestream_test";

function productionEnv(overrides = {}) {
  return {
    SIDESTREAM_LICENSE_NAMESPACE: "production",
    VERCEL_ENV: "production",
    SIDESTREAM_POSTGRES_URL: productionDatabase,
    ...overrides,
  };
}

function testEnv(overrides = {}) {
  return {
    SIDESTREAM_LICENSE_NAMESPACE: "test",
    VERCEL_ENV: "preview",
    SIDESTREAM_TEST_API_HOSTS: "test-api.sidestream.example",
    SIDESTREAM_TEST_POSTGRES_URL: testDatabase,
    ...overrides,
  };
}

function isolatedTestProductionEnv(overrides = {}) {
  return testEnv({
    VERCEL_ENV: "production",
    SIDESTREAM_TEST_PRODUCTION_TARGET: "1",
    ...overrides,
  });
}

test("deployment contract gives Test a separate API host and database variable", () => {
  assert.deepEqual(LICENSE_ENVIRONMENT_VARIABLES, {
    namespace: "SIDESTREAM_LICENSE_NAMESPACE",
    deploymentEnvironment: "VERCEL_ENV",
    testProductionTarget: "SIDESTREAM_TEST_PRODUCTION_TARGET",
    productionApiHosts: "SIDESTREAM_PRODUCTION_API_HOSTS",
    testApiHosts: "SIDESTREAM_TEST_API_HOSTS",
    productionDatabaseUrl: "SIDESTREAM_POSTGRES_URL",
    testDatabaseUrl: "SIDESTREAM_TEST_POSTGRES_URL",
  });
  assert.notEqual(
    LICENSE_ENVIRONMENT_DEPLOYMENTS.production.databaseUrlEnvironmentVariable,
    LICENSE_ENVIRONMENT_DEPLOYMENTS.test.databaseUrlEnvironmentVariable,
  );
  assert.notEqual(
    LICENSE_ENVIRONMENT_DEPLOYMENTS.production.apiHostsEnvironmentVariable,
    LICENSE_ENVIRONMENT_DEPLOYMENTS.test.apiHostsEnvironmentVariable,
  );
});

test("production resolves only from agreeing server deployment and host state", () => {
  const environment = resolveLicenseEnvironment({
    serverEnv: productionEnv(),
    trustedRequestHost: "SIDESTREAM.TV:443",
    buildChannel: "test",
    appVersion: "client-controlled",
    source: "client-controlled",
    metadata: { namespace: "test" },
  });

  assert.deepEqual(environment, {
    namespace: "production",
    apiHost: "sidestream.tv",
    allowedApiHosts: [
      "sidestream.tv",
      "www.sidestream.tv",
      "sidestream-xi.vercel.app",
    ],
    database: {
      environmentVariable: "SIDESTREAM_POSTGRES_URL",
      connectionString: productionDatabase,
    },
    credentialNamespaceRequired: true,
  });
});

test("Test resolves only with its explicit API allowlist and dedicated database", () => {
  const environment = resolveLicenseEnvironment({
    serverEnv: testEnv({ SIDESTREAM_POSTGRES_URL: productionDatabase }),
    trustedRequestHost: "test-api.sidestream.example",
  });

  assert.deepEqual(environment, {
    namespace: "test",
    apiHost: "test-api.sidestream.example",
    allowedApiHosts: ["test-api.sidestream.example"],
    database: {
      environmentVariable: "SIDESTREAM_TEST_POSTGRES_URL",
      connectionString: testDatabase,
    },
    credentialNamespaceRequired: true,
  });
});

test("isolated Test Production target resolves with and without a trusted host", () => {
  const serverEnv = isolatedTestProductionEnv();
  const expectedDatabase = {
    environmentVariable: "SIDESTREAM_TEST_POSTGRES_URL",
    connectionString: testDatabase,
  };

  assert.deepEqual(resolveLicenseEnvironment({ serverEnv }), {
    namespace: "test",
    apiHost: null,
    allowedApiHosts: ["test-api.sidestream.example"],
    database: expectedDatabase,
    credentialNamespaceRequired: true,
  });
  assert.deepEqual(resolveLicenseEnvironment({
    serverEnv,
    trustedRequestHost: "test-api.sidestream.example",
  }), {
    namespace: "test",
    apiHost: "test-api.sidestream.example",
    allowedApiHosts: ["test-api.sidestream.example"],
    database: expectedDatabase,
    credentialNamespaceRequired: true,
  });
});

test("isolated Test Production target opt-in fails closed on every conflict", () => {
  const cases = [
    {
      name: "missing opt-in",
      serverEnv: isolatedTestProductionEnv({
        SIDESTREAM_TEST_PRODUCTION_TARGET: undefined,
      }),
    },
    {
      name: "malformed opt-in",
      serverEnv: isolatedTestProductionEnv({
        SIDESTREAM_TEST_PRODUCTION_TARGET: "true",
      }),
    },
    {
      name: "whitespace-padded opt-in",
      serverEnv: isolatedTestProductionEnv({
        SIDESTREAM_TEST_PRODUCTION_TARGET: " 1 ",
      }),
    },
    {
      name: "non-string opt-in",
      serverEnv: isolatedTestProductionEnv({
        SIDESTREAM_TEST_PRODUCTION_TARGET: 1,
      }),
    },
    {
      name: "opt-in without explicit Test namespace",
      serverEnv: isolatedTestProductionEnv({
        SIDESTREAM_LICENSE_NAMESPACE: undefined,
      }),
    },
    {
      name: "opt-in with Production namespace",
      serverEnv: productionEnv({
        SIDESTREAM_TEST_PRODUCTION_TARGET: "1",
        SIDESTREAM_TEST_API_HOSTS: "test-api.sidestream.example",
        SIDESTREAM_TEST_POSTGRES_URL: testDatabase,
      }),
    },
    {
      name: "opt-in without Production deployment state",
      serverEnv: isolatedTestProductionEnv({
        VERCEL_ENV: undefined,
      }),
    },
    {
      name: "opt-in with Preview deployment state",
      serverEnv: isolatedTestProductionEnv({
        VERCEL_ENV: "preview",
      }),
    },
    {
      name: "missing Test hosts",
      serverEnv: isolatedTestProductionEnv({
        SIDESTREAM_TEST_API_HOSTS: undefined,
      }),
    },
    {
      name: "missing Test database",
      serverEnv: isolatedTestProductionEnv({
        SIDESTREAM_TEST_POSTGRES_URL: undefined,
      }),
    },
    {
      name: "unknown trusted host",
      serverEnv: isolatedTestProductionEnv(),
      trustedRequestHost: "unknown.example",
    },
    {
      name: "Production trusted host",
      serverEnv: isolatedTestProductionEnv(),
      trustedRequestHost: "sidestream.tv",
    },
    {
      name: "overlapping Test and Production host",
      serverEnv: isolatedTestProductionEnv({
        SIDESTREAM_TEST_API_HOSTS: "sidestream.tv",
      }),
      trustedRequestHost: "sidestream.tv",
    },
    {
      name: "matching Production and Test database",
      serverEnv: isolatedTestProductionEnv({
        SIDESTREAM_POSTGRES_URL:
          "postgresql://other-user:other-secret@test.db.example/sidestream_test",
      }),
    },
  ];

  for (const { name, ...options } of cases) {
    assert.equal(resolveLicenseEnvironment(options), null, name);
  }
});

test("real Production still resolves normally when Test Production opt-in is absent", () => {
  const serverEnv = productionEnv();
  assert.equal("SIDESTREAM_TEST_PRODUCTION_TARGET" in serverEnv, false);
  assert.equal(resolveLicenseEnvironment({
    serverEnv,
    trustedRequestHost: "sidestream.tv",
  })?.namespace, "production");
});

test("known trusted host can resolve when deployment state is unavailable", () => {
  const production = productionEnv({
    SIDESTREAM_LICENSE_NAMESPACE: undefined,
    VERCEL_ENV: undefined,
  });
  assert.equal(resolveLicenseEnvironment({
    serverEnv: production,
    trustedRequestHost: "sidestream-xi.vercel.app",
  })?.namespace, "production");

  const test = testEnv({
    SIDESTREAM_LICENSE_NAMESPACE: undefined,
    VERCEL_ENV: undefined,
  });
  assert.equal(resolveLicenseEnvironment({
    serverEnv: test,
    trustedRequestHost: "test-api.sidestream.example",
  })?.namespace, "test");
});

test("unknown, incomplete, overlapping, and conflicting state fails closed", () => {
  const cases = [
    { serverEnv: productionEnv({ SIDESTREAM_LICENSE_NAMESPACE: "staging" }) },
    { serverEnv: productionEnv({ VERCEL_ENV: "staging" }) },
    {
      serverEnv: productionEnv(),
      trustedRequestHost: "attacker.example",
    },
    {
      serverEnv: productionEnv({
        SIDESTREAM_TEST_API_HOSTS: "test-api.sidestream.example",
      }),
      trustedRequestHost: "test-api.sidestream.example",
    },
    {
      serverEnv: testEnv({ SIDESTREAM_TEST_API_HOSTS: undefined }),
      trustedRequestHost: undefined,
    },
    {
      serverEnv: testEnv({ SIDESTREAM_TEST_POSTGRES_URL: undefined }),
      trustedRequestHost: "test-api.sidestream.example",
    },
    {
      serverEnv: testEnv({ SIDESTREAM_TEST_API_HOSTS: "sidestream.tv" }),
      trustedRequestHost: "sidestream.tv",
    },
    {
      serverEnv: testEnv({
        SIDESTREAM_POSTGRES_URL: productionDatabase,
        SIDESTREAM_TEST_POSTGRES_URL:
          "postgresql://other-user:other-secret@prod.db.example/sidestream",
      }),
      trustedRequestHost: "test-api.sidestream.example",
    },
    { serverEnv: {} },
  ];

  for (const options of cases) {
    assert.equal(resolveLicenseEnvironment(options), null);
  }
});

test("production and Test credentials are mutually exclusive after cutover", () => {
  const production = resolveLicenseEnvironment({ serverEnv: productionEnv() });
  const testEnvironment = resolveLicenseEnvironment({ serverEnv: testEnv() });

  assert.equal(licenseCredentialMatchesEnvironment({
    environment: production,
    credentialNamespace: "production",
  }), true);
  assert.equal(licenseCredentialMatchesEnvironment({
    environment: production,
    credentialNamespace: "test",
  }), false);
  assert.equal(licenseCredentialMatchesEnvironment({
    environment: testEnvironment,
    credentialNamespace: "test",
  }), true);
  assert.equal(licenseCredentialMatchesEnvironment({
    environment: testEnvironment,
    credentialNamespace: "production",
  }), false);
  assert.equal(licenseCredentialMatchesEnvironment({
    environment: production,
    credentialNamespace: undefined,
  }), false);
  assert.equal(licenseCredentialMatchesEnvironment({
    environment: null,
    credentialNamespace: "production",
  }), false);
});

test("buildChannel is bounded diagnostic metadata and cannot select a namespace", () => {
  assert.deepEqual(getLicenseDiagnosticMetadata({
    buildChannel: " Test-Beta.1 ",
    appVersion: "1.2.3",
    source: "production",
    namespace: "test",
  }), { buildChannel: "test-beta.1" });
  assert.deepEqual(getLicenseDiagnosticMetadata({ buildChannel: "test\nproduction" }), {
    buildChannel: null,
  });
  assert.deepEqual(getLicenseDiagnosticMetadata({
    buildChannel: "x".repeat(MAX_DIAGNOSTIC_BUILD_CHANNEL_LENGTH + 1),
  }), { buildChannel: null });
  assert.deepEqual(getLicenseDiagnosticMetadata({ appVersion: "test" }), {
    buildChannel: null,
  });

  assert.equal(resolveLicenseEnvironment({
    serverEnv: productionEnv(),
    buildChannel: "test",
    appVersion: "test",
    source: "test",
    metadata: { environment: "test" },
  })?.namespace, "production");
});

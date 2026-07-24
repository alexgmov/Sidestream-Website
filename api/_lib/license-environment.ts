export const LICENSE_ENVIRONMENT_VARIABLES = {
  namespace: "SIDESTREAM_LICENSE_NAMESPACE",
  deploymentEnvironment: "VERCEL_ENV",
  testProductionTarget: "SIDESTREAM_TEST_PRODUCTION_TARGET",
  productionApiHosts: "SIDESTREAM_PRODUCTION_API_HOSTS",
  testApiHosts: "SIDESTREAM_TEST_API_HOSTS",
  productionDatabaseUrl: "SIDESTREAM_POSTGRES_URL",
  testDatabaseUrl: "SIDESTREAM_TEST_POSTGRES_URL",
} as const;

export const LICENSE_ENVIRONMENT_DEPLOYMENTS = {
  production: {
    namespace: "production",
    deploymentEnvironments: ["production"],
    apiHostsEnvironmentVariable:
      LICENSE_ENVIRONMENT_VARIABLES.productionApiHosts,
    databaseUrlEnvironmentVariable:
      LICENSE_ENVIRONMENT_VARIABLES.productionDatabaseUrl,
  },
  test: {
    namespace: "test",
    deploymentEnvironments: ["preview", "development", "test"],
    apiHostsEnvironmentVariable: LICENSE_ENVIRONMENT_VARIABLES.testApiHosts,
    databaseUrlEnvironmentVariable:
      LICENSE_ENVIRONMENT_VARIABLES.testDatabaseUrl,
  },
} as const;

export const PRODUCTION_LICENSE_API_HOSTS = [
  "sidestream.tv",
  "www.sidestream.tv",
  "sidestream-xi.vercel.app",
] as const;

export const MAX_DIAGNOSTIC_BUILD_CHANNEL_LENGTH = 32;

export type LicenseEnvironment = keyof typeof LICENSE_ENVIRONMENT_DEPLOYMENTS;

export type ResolvedLicenseEnvironment = Readonly<{
  namespace: LicenseEnvironment;
  apiHost: string | null;
  allowedApiHosts: readonly string[];
  database: Readonly<{
    environmentVariable: string;
    connectionString: string;
  }>;
  credentialNamespaceRequired: true;
}>;

export type LicenseEnvironmentServerState = Readonly<Record<string, unknown>>;

/**
 * Resolves the credential/database namespace exclusively from server-owned
 * deployment configuration and a platform-trusted request host. The returned
 * database connection string is server-only and must never be serialized.
 *
 * Test is a separate deployment boundary: configure SIDESTREAM_TEST_API_HOSTS
 * with exact hostnames and SIDESTREAM_TEST_POSTGRES_URL with a dedicated Test
 * database. Test must not reuse the production API hostname or database.
 */
export function resolveLicenseEnvironment(options: {
  serverEnv: LicenseEnvironmentServerState;
  trustedRequestHost?: unknown;
}): ResolvedLicenseEnvironment | null {
  const explicitNamespace = readConfiguredNamespace(options.serverEnv);
  if (explicitNamespace === "invalid") return null;

  const testProductionTarget = readTestProductionTarget(options.serverEnv);
  if (testProductionTarget === "invalid") return null;

  const deploymentNamespace = readDeploymentNamespace(
    options.serverEnv,
    explicitNamespace,
    testProductionTarget,
  );
  if (deploymentNamespace === "invalid") return null;

  const productionHosts = readApiHosts(
    options.serverEnv[LICENSE_ENVIRONMENT_VARIABLES.productionApiHosts],
    PRODUCTION_LICENSE_API_HOSTS,
  );
  const testHosts = readApiHosts(
    options.serverEnv[LICENSE_ENVIRONMENT_VARIABLES.testApiHosts],
  );
  if (productionHosts === null || testHosts === null) return null;
  if (productionHosts.some((host) => testHosts.includes(host))) return null;

  const hostWasSupplied = options.trustedRequestHost !== undefined;
  const requestHost = hostWasSupplied
    ? normalizeHost(options.trustedRequestHost)
    : null;
  if (hostWasSupplied && requestHost === null) return null;

  const hostNamespace = requestHost === null
    ? null
    : productionHosts.includes(requestHost)
      ? "production"
      : testHosts.includes(requestHost)
        ? "test"
        : "invalid";
  if (hostNamespace === "invalid") return null;

  const candidates = [
    explicitNamespace,
    deploymentNamespace,
    hostNamespace,
  ].filter((candidate): candidate is LicenseEnvironment => candidate !== null);
  if (candidates.length === 0 || candidates.some((value) => value !== candidates[0])) {
    return null;
  }

  const namespace = candidates[0];
  if (namespace === "test" && testHosts.length === 0) return null;

  const productionDatabase = readDatabaseConfiguration(
    options.serverEnv[LICENSE_ENVIRONMENT_VARIABLES.productionDatabaseUrl],
    LICENSE_ENVIRONMENT_VARIABLES.productionDatabaseUrl,
  );
  const testDatabase = readDatabaseConfiguration(
    options.serverEnv[LICENSE_ENVIRONMENT_VARIABLES.testDatabaseUrl],
    LICENSE_ENVIRONMENT_VARIABLES.testDatabaseUrl,
  );

  const selectedDatabase = namespace === "production"
    ? productionDatabase
    : testDatabase;
  if (selectedDatabase === null) return null;

  if (
    productionDatabase !== null &&
    testDatabase !== null &&
    productionDatabase.targetIdentity === testDatabase.targetIdentity
  ) {
    return null;
  }

  return {
    namespace,
    apiHost: requestHost,
    allowedApiHosts: namespace === "production"
      ? Object.freeze([...productionHosts])
      : Object.freeze([...testHosts]),
    database: {
      environmentVariable: selectedDatabase.environmentVariable,
      connectionString: selectedDatabase.connectionString,
    },
    credentialNamespaceRequired: true,
  };
}

/** Strict after-cutover credential isolation; missing legacy claims fail closed. */
export function licenseCredentialMatchesEnvironment(options: {
  environment: ResolvedLicenseEnvironment | null;
  credentialNamespace: unknown;
}) {
  return options.environment !== null &&
    options.credentialNamespace === options.environment.namespace;
}

/** Client buildChannel is retained only as bounded, log-safe diagnostics. */
export function getLicenseDiagnosticMetadata(value: unknown) {
  const buildChannel = isRecord(value) ? value.buildChannel : null;
  if (typeof buildChannel !== "string") return { buildChannel: null } as const;

  const normalized = buildChannel.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_DIAGNOSTIC_BUILD_CHANNEL_LENGTH ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(normalized)
  ) {
    return { buildChannel: null } as const;
  }

  return { buildChannel: normalized } as const;
}

function readConfiguredNamespace(
  serverEnv: LicenseEnvironmentServerState,
): LicenseEnvironment | "invalid" | null {
  const value = serverEnv[LICENSE_ENVIRONMENT_VARIABLES.namespace];
  if (value === undefined || value === null || value === "") return null;

  const normalized = normalizeString(value);
  return normalized === "production" || normalized === "test"
    ? normalized
    : "invalid";
}

function readDeploymentNamespace(
  serverEnv: LicenseEnvironmentServerState,
  explicitNamespace: LicenseEnvironment | null,
  testProductionTarget: boolean,
): LicenseEnvironment | "invalid" | null {
  const value = serverEnv[LICENSE_ENVIRONMENT_VARIABLES.deploymentEnvironment];
  if (value === undefined || value === null || value === "") {
    return testProductionTarget ? "invalid" : null;
  }

  const normalized = normalizeString(value);
  if (testProductionTarget) {
    return explicitNamespace === "test" && normalized === "production"
      ? "test"
      : "invalid";
  }
  if (normalized === "production") return "production";
  if (normalized === "preview" || normalized === "development" || normalized === "test") {
    return "test";
  }
  return "invalid";
}

function readTestProductionTarget(
  serverEnv: LicenseEnvironmentServerState,
): boolean | "invalid" {
  const value = serverEnv[LICENSE_ENVIRONMENT_VARIABLES.testProductionTarget];
  if (value === undefined || value === null || value === "") return false;
  return value === "1" ? true : "invalid";
}

function readApiHosts(
  value: unknown,
  defaults: readonly string[] = [],
): string[] | null {
  const configuredValues = value === undefined || value === null || value === ""
    ? []
    : typeof value === "string"
      ? value.split(",")
      : Array.isArray(value)
        ? value
        : null;
  if (configuredValues === null || configuredValues.length > 20) return null;

  const hosts = new Set(defaults);
  for (const configuredValue of configuredValues) {
    const host = normalizeHost(configuredValue);
    if (host === null) return null;
    hosts.add(host);
  }
  return [...hosts];
}

function normalizeHost(value: unknown) {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toLowerCase();
  if (
    candidate.length === 0 ||
    candidate.length > 253 ||
    /[\s/@?#\\]/.test(candidate)
  ) {
    return null;
  }

  try {
    const url = new URL(`https://${candidate}`);
    const hostname = url.hostname.replace(/\.$/, "");
    if (!hostname || url.pathname !== "/") return null;
    return url.port ? `${hostname}:${url.port}` : hostname;
  } catch {
    return null;
  }
}

function readDatabaseConfiguration(value: unknown, environmentVariable: string) {
  if (typeof value !== "string") return null;
  const connectionString = value.trim();
  if (
    connectionString.length === 0 ||
    connectionString.length > 4096 ||
    connectionString.includes("[YOUR-") ||
    connectionString === "changeme"
  ) {
    return null;
  }

  try {
    const url = new URL(connectionString);
    if (
      (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
      !url.hostname ||
      url.pathname.length <= 1
    ) {
      return null;
    }

    const targetIdentity = [
      url.hostname.toLowerCase(),
      url.port || "5432",
      url.pathname.replace(/\/+$/, ""),
    ].join("|");
    return { connectionString, environmentVariable, targetIdentity } as const;
  } catch {
    return null;
  }
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

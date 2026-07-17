#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const PREVIEW_DATABASE_VARIABLES = Object.freeze([
  "SIDESTREAM_TEST_POSTGRES_URL",
  "SIDESTREAM_POSTGRES_URL",
  "SIDESTREAM_POSTGRES_PRISMA_URL",
  "SIDESTREAM_POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
]);
const PRODUCTION_DATABASE_VARIABLES = Object.freeze([
  "SIDESTREAM_POSTGRES_URL",
  "SIDESTREAM_POSTGRES_PRISMA_URL",
  "SIDESTREAM_POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
]);

export async function verifyCustomer360PreviewEnvironmentFiles(options) {
  const previewResult = await readEnvironmentSnapshot(options?.previewFile);
  const productionResult = await readEnvironmentSnapshot(options?.productionFile);
  const fileChecks = [
    check(["PREVIEW_ENV_FILE"], previewResult.environment !== null),
    check(["PRODUCTION_ENV_FILE"], productionResult.environment !== null),
  ];
  if (!previewResult.environment || !productionResult.environment) {
    return result(fileChecks);
  }

  return verifyCustomer360PreviewEnvironmentSnapshots({
    preview: previewResult.environment,
    production: productionResult.environment,
  });
}

export function verifyCustomer360PreviewEnvironmentSnapshots(options) {
  const preview = options?.preview || Object.create(null);
  const production = options?.production || Object.create(null);
  const checks = [];

  const previewDatabase = databaseTarget(
    preview.SIDESTREAM_TEST_POSTGRES_URL,
  );
  const previewRuntimeDatabase = databaseTarget(
    preview.SIDESTREAM_POSTGRES_URL,
  );
  const productionDatabase = databaseTarget(
    production.SIDESTREAM_POSTGRES_URL,
  );
  const previewDatabaseAliases = configuredDatabaseTargets(
    preview,
    PREVIEW_DATABASE_VARIABLES,
  );
  const productionDatabaseAliases = configuredDatabaseTargets(
    production,
    PRODUCTION_DATABASE_VARIABLES,
  );

  checks.push(check(
    ["PREVIEW.SIDESTREAM_TEST_POSTGRES_URL"],
    previewDatabase !== null,
    fingerprints(previewDatabase),
  ));
  checks.push(check(
    ["PREVIEW.SIDESTREAM_POSTGRES_URL"],
    previewRuntimeDatabase !== null,
    fingerprints(previewRuntimeDatabase),
  ));
  checks.push(check(
    ["PRODUCTION.SIDESTREAM_POSTGRES_URL"],
    productionDatabase !== null,
    fingerprints(productionDatabase),
  ));
  checks.push(check(
    previewDatabaseAliases.names.map((name) => `PREVIEW.${name}`),
    previewDatabaseAliases.valid &&
      sameTarget(previewDatabase, previewRuntimeDatabase) &&
      previewDatabaseAliases.targets.every((target) => sameTarget(target, previewDatabase)),
    fingerprints(...previewDatabaseAliases.targets),
  ));
  checks.push(check(
    productionDatabaseAliases.names.map((name) => `PRODUCTION.${name}`),
    productionDatabaseAliases.valid &&
      productionDatabaseAliases.targets.every((target) => sameTarget(target, productionDatabase)),
    fingerprints(...productionDatabaseAliases.targets),
  ));
  checks.push(check(
    [
      "PREVIEW.SIDESTREAM_TEST_POSTGRES_URL",
      "PRODUCTION.SIDESTREAM_POSTGRES_URL",
    ],
    differentTargets(previewDatabase, productionDatabase),
    fingerprints(previewDatabase, productionDatabase),
  ));

  const previewTelemetry = databaseTarget(
    preview.SIDESTREAM_TELEMETRY_POSTGRES_URL,
  );
  const productionTelemetry = databaseTarget(
    production.SIDESTREAM_TELEMETRY_POSTGRES_URL,
  );
  checks.push(check(
    ["PREVIEW.SIDESTREAM_TELEMETRY_POSTGRES_URL"],
    previewTelemetry !== null &&
      previewDatabaseAliases.targets.every((target) => differentTargets(previewTelemetry, target)),
    fingerprints(previewTelemetry),
  ));
  checks.push(check(
    ["PRODUCTION.SIDESTREAM_TELEMETRY_POSTGRES_URL"],
    productionTelemetry !== null &&
      productionDatabaseAliases.targets.every((target) => differentTargets(productionTelemetry, target)),
    fingerprints(productionTelemetry),
  ));
  checks.push(check(
    [
      "PREVIEW.SIDESTREAM_TELEMETRY_POSTGRES_URL",
      "PRODUCTION.SIDESTREAM_TELEMETRY_POSTGRES_URL",
    ],
    differentTargets(previewTelemetry, productionTelemetry) &&
      differentTargets(previewTelemetry, productionDatabase) &&
      differentTargets(productionTelemetry, previewDatabase),
    fingerprints(previewTelemetry, productionTelemetry),
  ));

  checks.push(check(
    ["PREVIEW.STRIPE_SECRET_KEY"],
    validStripeKey(preview.STRIPE_SECRET_KEY, "test"),
  ));
  checks.push(check(
    ["PRODUCTION.STRIPE_SECRET_KEY"],
    validStripeKey(production.STRIPE_SECRET_KEY, "live"),
  ));
  checks.push(distinctSecretCheck(
    preview,
    production,
    "STRIPE_WEBHOOK_SECRET",
    validStripeWebhookSecret,
  ));
  checks.push(distinctValueCheck(
    preview,
    production,
    "GOOGLE_CLIENT_ID",
    validGoogleClientId,
  ));
  checks.push(distinctSecretCheck(
    preview,
    production,
    "GOOGLE_CLIENT_SECRET",
    validSecret,
  ));

  const previewOrigin = httpsOrigin(preview.SIDESTREAM_BASE_URL);
  const productionOrigin = httpsOrigin(production.SIDESTREAM_BASE_URL);
  checks.push(check(
    ["PREVIEW.SIDESTREAM_BASE_URL", "PRODUCTION.SIDESTREAM_BASE_URL"],
    previewOrigin !== null &&
      productionOrigin !== null &&
      previewOrigin !== productionOrigin,
  ));
  checks.push(check(
    ["PREVIEW.GOOGLE_REDIRECT_URI"],
    validOptionalGoogleRedirect(
      preview.GOOGLE_REDIRECT_URI,
      previewOrigin,
    ),
  ));
  checks.push(check(
    ["PRODUCTION.GOOGLE_REDIRECT_URI"],
    validOptionalGoogleRedirect(
      production.GOOGLE_REDIRECT_URI,
      productionOrigin,
    ),
  ));
  checks.push(distinctSecretCheck(
    preview,
    production,
    "SIDESTREAM_CRM_ADMIN_SECRET",
    validSecret,
  ));
  checks.push(distinctSecretCheck(
    preview,
    production,
    "CRON_SECRET",
    validSecret,
  ));

  return result(checks);
}

export function formatVerificationResult(verification) {
  return verification.checks.map((entry) => [
    entry.pass ? "PASS" : "FAIL",
    ...entry.variables,
    ...entry.fingerprints,
  ].join(" ")).join("\n");
}

async function readEnvironmentSnapshot(filename) {
  if (typeof filename !== "string" || filename.length === 0) {
    return { environment: null };
  }
  try {
    const source = await readFile(filename);
    if (source.byteLength === 0 || source.byteLength > MAX_SNAPSHOT_BYTES) {
      return { environment: null };
    }
    const text = source.toString("utf8");
    if (text.includes("\0")) return { environment: null };
    return { environment: parseEnv(text) };
  } catch {
    return { environment: null };
  }
}

function configuredDatabaseTargets(environment, names) {
  const configuredNames = names.filter((name) => configuredValue(environment[name]) !== null);
  const targets = configuredNames.map((name) => databaseTarget(environment[name]));
  return {
    names: configuredNames.length > 0 ? configuredNames : [names[0]],
    targets: targets.filter((target) => target !== null),
    valid: configuredNames.length > 0 && targets.every((target) => target !== null),
  };
}

function databaseTarget(rawValue) {
  const value = configuredValue(rawValue);
  if (!value || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
      !url.hostname ||
      !url.pathname.startsWith("/") ||
      url.pathname === "/" ||
      url.hash
    ) {
      return null;
    }
    const database = decodeURIComponent(url.pathname.slice(1));
    if (!database || database.includes("/") || /[\u0000-\u001f\u007f]/.test(database)) {
      return null;
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!hostname) return null;
    const identity = `${hostname}:${url.port || "5432"}/${database}`;
    return Object.freeze({
      identity,
      fingerprint: `sha256:${createHash("sha256").update(identity).digest("hex")}`,
    });
  } catch {
    return null;
  }
}

function httpsOrigin(rawValue) {
  const value = configuredValue(rawValue);
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function validOptionalGoogleRedirect(rawValue, baseOrigin) {
  const value = configuredValue(rawValue);
  if (value === null) return baseOrigin !== null;
  if (!baseOrigin || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.origin === baseOrigin &&
      url.pathname === "/api/auth/google/callback" &&
      !url.search &&
      !url.hash;
  } catch {
    return false;
  }
}

function validStripeKey(value, mode) {
  const configured = configuredValue(value);
  return configured !== null &&
    new RegExp(`^sk_${mode}_[A-Za-z0-9_]{8,}$`).test(configured);
}

function validStripeWebhookSecret(value) {
  const configured = configuredValue(value);
  return configured !== null && /^whsec_[A-Za-z0-9_=-]{8,}$/.test(configured);
}

function validGoogleClientId(value) {
  const configured = configuredValue(value);
  return configured !== null &&
    configured.length <= 512 &&
    /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(configured);
}

function validSecret(value) {
  return typeof value === "string" &&
    value.length >= 16 &&
    value.length <= 512 &&
    /^[\x21-\x7e]+$/.test(value) &&
    !placeholderValue(value);
}

function configuredValue(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    placeholderValue(value)
  ) {
    return null;
  }
  return value;
}

function placeholderValue(value) {
  return value === "changeme" || value.includes("[YOUR-");
}

function distinctSecretCheck(preview, production, variable, validator) {
  const previewValue = preview[variable];
  const productionValue = production[variable];
  return check(
    [`PREVIEW.${variable}`, `PRODUCTION.${variable}`],
    validator(previewValue) &&
      validator(productionValue) &&
      secretDigest(previewValue) !== secretDigest(productionValue),
  );
}

function distinctValueCheck(preview, production, variable, validator) {
  const previewValue = preview[variable];
  const productionValue = production[variable];
  return check(
    [`PREVIEW.${variable}`, `PRODUCTION.${variable}`],
    validator(previewValue) &&
      validator(productionValue) &&
      previewValue !== productionValue,
  );
}

function secretDigest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function sameTarget(left, right) {
  return left !== null && right !== null && left.identity === right.identity;
}

function differentTargets(left, right) {
  return left !== null && right !== null && left.identity !== right.identity;
}

function fingerprints(...targets) {
  return [...new Set(targets.filter(Boolean).map((target) => target.fingerprint))];
}

function check(variables, pass, targetFingerprints = []) {
  return Object.freeze({
    pass: pass === true,
    variables: Object.freeze([...variables]),
    fingerprints: Object.freeze([...targetFingerprints]),
  });
}

function result(checks) {
  const frozenChecks = Object.freeze([...checks]);
  return Object.freeze({
    ok: frozenChecks.every((entry) => entry.pass),
    checks: frozenChecks,
  });
}

function parseArguments(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equalsIndex = argument.indexOf("=");
    const name = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? null : argument.slice(equalsIndex + 1);
    if (["--preview", "--preview-env", "--preview-env-file"].includes(name)) {
      if (options.previewFile) return null;
      options.previewFile = inlineValue ?? argv[++index];
    } else if (["--production", "--production-env", "--production-env-file"].includes(name)) {
      if (options.productionFile) return null;
      options.productionFile = inlineValue ?? argv[++index];
    } else if (argument.startsWith("-")) {
      return null;
    } else {
      positional.push(argument);
    }
  }
  if (positional.length > 0) {
    if (positional.length !== 2 || options.previewFile || options.productionFile) return null;
    [options.previewFile, options.productionFile] = positional;
  }
  if (!options.previewFile || !options.productionFile) return null;
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    process.stdout.write("FAIL PREVIEW_ENV_FILE\nFAIL PRODUCTION_ENV_FILE\n");
    process.exitCode = 1;
    return;
  }
  const verification = await verifyCustomer360PreviewEnvironmentFiles(options);
  process.stdout.write(`${formatVerificationResult(verification)}\n`);
  process.exitCode = verification.ok ? 0 : 1;
}

const entryUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === entryUrl) {
  main().catch(() => {
    process.stderr.write("FAIL PREVIEW_ENV_FILE\nFAIL PRODUCTION_ENV_FILE\n");
    process.exitCode = 1;
  });
}

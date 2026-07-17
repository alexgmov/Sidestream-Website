#!/usr/bin/env node

import { isIP } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_JSON_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const WRONG_BEARER = "wrong";
const PRODUCTION_HOSTS = new Set([
  "sidestream.tv",
  "www.sidestream.tv",
  "sidestream-xi.vercel.app",
]);
const ALLOWED_QUALITY_FLAGS = new Set([
  "usage_not_synced",
  "missing_install_membership",
  "usage_install_count_mismatch",
  "pending_download_outcomes",
  "unknown_download_outcomes",
  "outcome_counts_inconsistent",
  "attempt_counts_inconsistent",
  "pending_identity_review",
  "commerce_identity_conflict",
]);

export const READ_ONLY_MODE = "read-only";
export const USAGE_SYNC_MODE = "usage-sync";

export const ROUTE_PRESENCE_PROBES = Object.freeze([
  Object.freeze({
    id: "route.download",
    path: "/api/download",
    method: "HEAD",
    status: 200,
  }),
  Object.freeze({
    id: "route.account_page",
    path: "/account.html",
    method: "HEAD",
    status: 200,
  }),
  Object.freeze({
    id: "route.account_session",
    path: "/api/auth/session",
    method: "GET",
    status: 200,
  }),
  Object.freeze({
    id: "route.account_device",
    path: "/api/account/device",
    method: "OPTIONS",
    status: 405,
    allow: "GET",
  }),
  Object.freeze({
    id: "route.activation_start",
    path: "/api/activation/start",
    method: "OPTIONS",
    status: 405,
    allow: "POST",
  }),
  Object.freeze({
    id: "route.activation_status",
    path: "/api/activation/status",
    method: "OPTIONS",
    status: 405,
    allow: "POST",
  }),
  Object.freeze({
    id: "route.activation_claim",
    path: "/api/activation/claim",
    method: "OPTIONS",
    status: 405,
    allow: "GET, POST",
  }),
  Object.freeze({
    id: "route.license_verify",
    path: "/api/license/verify",
    method: "OPTIONS",
    status: 405,
    allow: "POST",
  }),
  Object.freeze({
    id: "route.license_refresh",
    path: "/api/license/refresh",
    method: "OPTIONS",
    status: 405,
    allow: "POST",
  }),
  Object.freeze({
    id: "route.license_authorize_download",
    path: "/api/license/authorize-download",
    method: "OPTIONS",
    status: 405,
    allow: "POST",
  }),
  Object.freeze({
    id: "route.license_deactivate",
    path: "/api/license/deactivate",
    method: "OPTIONS",
    status: 405,
    allow: "POST",
  }),
  Object.freeze({
    id: "route.billing_portal",
    path: "/api/billing/portal",
    method: "OPTIONS",
    status: 405,
    allow: "POST",
  }),
  Object.freeze({
    id: "route.billing_receipt",
    path: "/api/billing/receipt",
    method: "OPTIONS",
    status: 405,
    allow: "POST",
  }),
  Object.freeze({
    id: "route.release",
    path: "/api/releases/latest?channel=stable",
    method: "HEAD",
    status: 200,
  }),
]);

const CUSTOMER_LIST_PATH = "/api/internal/customers";
const USAGE_SYNC_PATH = "/api/internal/customer-usage/sync";
const LIST_BODY = Object.freeze({ licenseNamespace: "test", limit: 1 });
const INVALID_NAMESPACE_BODY = Object.freeze({
  licenseNamespace: "preview",
  limit: 1,
});

export class PreviewDeploymentInputError extends Error {
  constructor(code) {
    super(code);
    this.name = "PreviewDeploymentInputError";
    this.code = code;
  }
}

export function usageSyncConfirmationForHost(hostname) {
  return `RUN_CUSTOMER_360_USAGE_SYNC_ONCE:${normalizeHost(hostname) || "invalid"}`;
}

export function parsePreviewDeploymentArguments(argv) {
  if (!Array.isArray(argv)) throw new PreviewDeploymentInputError("invalid_arguments");
  if (argv.length === 1 && argv[0] === "--help") return { help: true };

  const values = new Map();
  const allowed = new Set([
    "--origin",
    "--expected-deployment-host",
    "--mode",
    "--confirm",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const selector = argv[index];
    if (!allowed.has(selector)) {
      throw new PreviewDeploymentInputError("unknown_or_ambiguous_selector");
    }
    if (values.has(selector)) {
      throw new PreviewDeploymentInputError("duplicate_selector");
    }
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw new PreviewDeploymentInputError("missing_selector_value");
    }
    values.set(selector, value);
    index += 1;
  }

  const origin = values.get("--origin");
  const expectedDeploymentHost = values.get("--expected-deployment-host");
  if (!origin || !expectedDeploymentHost) {
    throw new PreviewDeploymentInputError("missing_required_selector");
  }

  const mode = values.get("--mode") || READ_ONLY_MODE;
  if (mode !== READ_ONLY_MODE && mode !== USAGE_SYNC_MODE) {
    throw new PreviewDeploymentInputError("invalid_mode");
  }
  const confirmation = values.get("--confirm");
  if (mode === READ_ONLY_MODE && confirmation !== undefined) {
    throw new PreviewDeploymentInputError("confirmation_forbidden_in_read_only");
  }

  const target = validatePreviewTarget(origin, expectedDeploymentHost);
  if (mode === USAGE_SYNC_MODE) {
    if (confirmation !== usageSyncConfirmationForHost(target.hostname)) {
      throw new PreviewDeploymentInputError("usage_sync_confirmation_required");
    }
  }

  return {
    origin: target.origin,
    expectedDeploymentHost: target.hostname,
    mode,
    confirmation,
  };
}

export function validatePreviewTarget(rawOrigin, rawExpectedDeploymentHost) {
  if (
    typeof rawOrigin !== "string" ||
    typeof rawExpectedDeploymentHost !== "string" ||
    rawOrigin.length === 0 ||
    rawOrigin.length > 2048
  ) {
    throw new PreviewDeploymentInputError("invalid_preview_target");
  }

  let parsed;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    throw new PreviewDeploymentInputError("invalid_preview_target");
  }

  const hostname = normalizeHost(parsed.hostname);
  const expectedHostname = normalizeExpectedHost(rawExpectedDeploymentHost);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !hostname ||
    parsed.hostname.toLowerCase() !== hostname ||
    !expectedHostname ||
    hostname !== expectedHostname ||
    isForbiddenHost(hostname)
  ) {
    throw new PreviewDeploymentInputError("invalid_preview_target");
  }

  return Object.freeze({
    origin: parsed.origin,
    hostname,
  });
}

export async function verifyCustomer360PreviewDeployment(options, dependencies = {}) {
  const checks = [];
  let target;
  try {
    target = validatePreviewTarget(
      options?.origin,
      options?.expectedDeploymentHost,
    );
  } catch {
    checks.push(check("configuration.preview_target", false));
    return verificationResult(options?.mode, checks, 0);
  }

  const mode = options?.mode || READ_ONLY_MODE;
  if (mode !== READ_ONLY_MODE && mode !== USAGE_SYNC_MODE) {
    checks.push(check("configuration.mode", false));
    return verificationResult(mode, checks, 0);
  }
  if (
    mode === READ_ONLY_MODE &&
    options?.confirmation !== undefined
  ) {
    checks.push(check("configuration.read_only", false));
    return verificationResult(mode, checks, 0);
  }
  if (
    mode === USAGE_SYNC_MODE &&
    options?.confirmation !== usageSyncConfirmationForHost(target.hostname)
  ) {
    checks.push(check("configuration.usage_sync_confirmation", false));
    return verificationResult(mode, checks, 0);
  }

  const environment = dependencies.environment || process.env;
  const adminSecret = validSecret(environment.SIDESTREAM_CRM_ADMIN_SECRET);
  if (!adminSecret) {
    checks.push(check("configuration.admin_secret", false));
    return verificationResult(mode, checks, 0);
  }
  const cronSecret = mode === USAGE_SYNC_MODE
    ? validSecret(environment.CRON_SECRET)
    : null;
  if (mode === USAGE_SYNC_MODE && !cronSecret) {
    checks.push(check("configuration.cron_secret", false));
    return verificationResult(mode, checks, 0);
  }

  const fetchImplementation = dependencies.fetch || globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    checks.push(check("configuration.fetch", false));
    return verificationResult(mode, checks, 0);
  }
  const createSignal = dependencies.createSignal || (() =>
    AbortSignal.timeout(REQUEST_TIMEOUT_MS));
  let requestCount = 0;

  const request = async (pathname, init) => {
    const url = new URL(pathname, `${target.origin}/`);
    if (url.origin !== target.origin) throw new Error("request_target_rejected");
    requestCount += 1;
    const signal = createSignal();
    return fetchImplementation(url.href, {
      ...init,
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
  };

  await runResponseCheck(checks, "deployment.host_evidence", async () => {
    const response = await request("/", {
      method: "HEAD",
      headers: { Accept: "text/html" },
    });
    return response.status === 200 && hasVercelEvidence(response);
  });
  if (!checks.at(-1)?.pass) {
    return verificationResult(mode, checks, requestCount);
  }

  await runJsonResponseCheck(checks, "admin.missing_credential", async () =>
    request(CUSTOMER_LIST_PATH, jsonPost(LIST_BODY)), (response, body) =>
    response.status === 401 &&
      body?.code === "unauthorized" &&
      hasNoStore(response));

  await runJsonResponseCheck(checks, "admin.wrong_credential", async () =>
    request(CUSTOMER_LIST_PATH, jsonPost(LIST_BODY, WRONG_BEARER)), (response, body) =>
    response.status === 401 &&
      body?.code === "unauthorized" &&
      hasNoStore(response));

  await runJsonResponseCheck(checks, "cron.missing_credential", async () =>
    request(USAGE_SYNC_PATH, jsonGet()), (response, body) =>
    response.status === 401 &&
      body?.code === "unauthorized" &&
      hasNoStore(response));

  await runJsonResponseCheck(checks, "cron.wrong_credential", async () =>
    request(USAGE_SYNC_PATH, jsonGet(WRONG_BEARER)), (response, body) =>
    response.status === 401 &&
      body?.code === "unauthorized" &&
      hasNoStore(response));
  if (!checks.every((entry) => entry.pass)) {
    return verificationResult(mode, checks, requestCount);
  }

  await runJsonResponseCheck(checks, "admin.origin_rejection", async () =>
    request(CUSTOMER_LIST_PATH, {
      ...jsonPost(LIST_BODY),
      headers: {
        ...jsonPost(LIST_BODY).headers,
        Origin: "https://operator-browser-origin.invalid",
      },
    }), (response, body) =>
    response.status === 403 &&
      body?.code === "browser_origin_forbidden" &&
      hasNoStore(response));
  if (!checks.at(-1)?.pass) {
    return verificationResult(mode, checks, requestCount);
  }

  await runJsonResponseCheck(checks, "admin.namespace_validation", async () =>
    request(
      CUSTOMER_LIST_PATH,
      jsonPost(INVALID_NAMESPACE_BODY, adminSecret),
    ), (response, body) =>
    response.status === 400 &&
      body?.code === "invalid_namespace" &&
      hasNoStore(response));

  await runJsonResponseCheck(checks, "admin.list_shape", async () =>
    request(CUSTOMER_LIST_PATH, jsonPost(LIST_BODY, adminSecret)), (response, body) =>
    response.status === 200 &&
      hasNoStore(response) &&
      isCustomerListResponse(body));

  for (const probe of ROUTE_PRESENCE_PROBES) {
    await runResponseCheck(checks, probe.id, async () => {
      const response = await request(probe.path, {
        method: probe.method,
        headers: { Accept: "application/json" },
      });
      return response.status === probe.status &&
        (!probe.allow || normalizedAllow(response) === probe.allow);
    });
  }

  const readOnlyPassed = checks.every((entry) => entry.pass);
  if (mode === USAGE_SYNC_MODE && readOnlyPassed) {
    await runJsonResponseCheck(checks, "usage_sync.once", async () =>
      request(USAGE_SYNC_PATH, jsonGet(cronSecret)), (response, body) =>
      response.status === 200 &&
        hasNoStore(response) &&
        isUsageSyncResponse(body));
  }

  return verificationResult(mode, checks, requestCount);
}

export function formatPreviewDeploymentVerification(verification) {
  return verification.checks
    .map((entry) => `${entry.pass ? "PASS" : "FAIL"} ${entry.id}`)
    .join("\n");
}

export function previewDeploymentUsage() {
  return [
    "Usage:",
    "  npm run verify:customer-360-preview-deployment -- --origin https://preview.example --expected-deployment-host preview.example",
    "  npm run verify:customer-360-preview-deployment -- --origin https://preview.example --expected-deployment-host preview.example --mode usage-sync --confirm RUN_CUSTOMER_360_USAGE_SYNC_ONCE:preview.example",
    "Environment:",
    "  SIDESTREAM_CRM_ADMIN_SECRET is required for read-only verification.",
    "  CRON_SECRET is additionally required only for usage-sync mode.",
  ].join("\n");
}

function normalizeExpectedHost(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 253 ||
    value.trim() !== value ||
    value.includes(":") ||
    value.includes("/") ||
    value.includes("@") ||
    value.includes("#") ||
    value.includes("?")
  ) {
    return null;
  }
  const normalized = normalizeHost(value);
  if (!normalized || normalized !== value.toLowerCase()) return null;
  return normalized;
}

function normalizeHost(value) {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase().replace(/\.$/, "");
  if (
    normalized.length === 0 ||
    normalized.length > 253 ||
    !normalized.includes(".") ||
    /[^a-z0-9.-]/.test(normalized) ||
    normalized.split(".").some((label) =>
      label.length === 0 ||
      label.length > 63 ||
      label.startsWith("-") ||
      label.endsWith("-")
    )
  ) {
    return null;
  }
  return normalized;
}

function isForbiddenHost(hostname) {
  return PRODUCTION_HOSTS.has(hostname) ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    isIP(hostname) !== 0;
}

function validSecret(value) {
  return typeof value === "string" &&
    value.length >= 16 &&
    value.length <= 512 &&
    /^[\x21-\x7e]+$/.test(value)
    ? value
    : null;
}

function jsonPost(body, bearer) {
  return {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  };
}

function jsonGet(bearer) {
  return {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
  };
}

function check(id, pass) {
  return Object.freeze({ id, pass: Boolean(pass) });
}

function verificationResult(mode, checks, requestCount) {
  return Object.freeze({
    mode: mode || READ_ONLY_MODE,
    pass: checks.length > 0 && checks.every((entry) => entry.pass),
    checks: Object.freeze([...checks]),
    requestCount,
  });
}

async function runResponseCheck(checks, id, operation) {
  let pass = false;
  try {
    pass = Boolean(await operation());
  } catch {
    pass = false;
  }
  checks.push(check(id, pass));
}

async function runJsonResponseCheck(checks, id, operation, validate) {
  return runResponseCheck(checks, id, async () => {
    const response = await operation();
    const body = await readBoundedJson(response);
    return validate(response, body);
  });
}

async function readBoundedJson(response) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new Error("response_too_large");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) {
    throw new Error("response_too_large");
  }
  const parsed = JSON.parse(text);
  if (!isPlainObject(parsed)) throw new Error("invalid_response_shape");
  return parsed;
}

function hasNoStore(response) {
  return (response.headers.get("cache-control") || "")
    .split(",")
    .some((value) => value.trim().toLowerCase() === "no-store");
}

function hasVercelEvidence(response) {
  const server = response.headers.get("server") || "";
  const requestId = response.headers.get("x-vercel-id") || "";
  return server.toLowerCase() === "vercel" &&
    /^[a-z0-9:_-]{3,256}$/i.test(requestId);
}

function normalizedAllow(response) {
  return (response.headers.get("allow") || "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean)
    .join(", ");
}

function isCustomerListResponse(value) {
  if (!hasExactKeys(value, ["customers", "nextCursor"])) return false;
  if (!Array.isArray(value.customers)) return false;
  if (!(value.nextCursor === null || isBoundedString(value.nextCursor, 4096))) {
    return false;
  }
  return value.customers.every(isCustomerShape);
}

function isCustomerShape(value) {
  if (!hasExactKeys(value, [
    "customerId",
    "licenseNamespace",
    "name",
    "email",
    "profileLifecycle",
    "installLifecycle",
    "billingModel",
    "entitlementStatus",
    "firstPaidAt",
    "lastPaidAt",
    "firstUpgradedAt",
    "lastUpgradedAt",
    "commerceSyncedAt",
    "money",
    "usage",
    "dataQualityFlags",
  ])) return false;
  return isUuid(value.customerId) &&
    value.licenseNamespace === "test" &&
    isNullableBoundedString(value.name, 1024) &&
    isNullableBoundedString(value.email, 320) &&
    isProfileLifecycle(value.profileLifecycle) &&
    isInstallLifecycle(value.installLifecycle) &&
    (value.billingModel === null || [
      "one_time",
      "subscription",
      "comped",
      "mixed",
    ].includes(value.billingModel)) &&
    isNullableBoundedString(value.entitlementStatus, 128) &&
    isNullableIso(value.firstPaidAt) &&
    isNullableIso(value.lastPaidAt) &&
    isNullableIso(value.firstUpgradedAt) &&
    isNullableIso(value.lastUpgradedAt) &&
    isNullableIso(value.commerceSyncedAt) &&
    Array.isArray(value.money) &&
    value.money.every(isMoneyShape) &&
    isUsageShape(value.usage) &&
    Array.isArray(value.dataQualityFlags) &&
    value.dataQualityFlags.every((flag) => ALLOWED_QUALITY_FLAGS.has(flag));
}

function isProfileLifecycle(value) {
  return hasExactKeys(value, [
    "createdAt",
    "updatedAt",
    "firstSeenAt",
    "lastActivityAt",
  ]) &&
    isIso(value.createdAt) &&
    isIso(value.updatedAt) &&
    isNullableIso(value.firstSeenAt) &&
    isNullableIso(value.lastActivityAt);
}

function isInstallLifecycle(value) {
  return hasExactKeys(value, [
    "installCount",
    "firstSeenAt",
    "lastSeenAt",
    "platform",
    "appVersion",
  ]) &&
    isDecimal(value.installCount) &&
    isNullableIso(value.firstSeenAt) &&
    isNullableIso(value.lastSeenAt) &&
    isNullableBoundedString(value.platform, 64) &&
    isNullableBoundedString(value.appVersion, 128);
}

function isMoneyShape(value) {
  return hasExactKeys(value, [
    "currency",
    "grossPaidMinor",
    "offStripePaidMinor",
    "refundedMinor",
    "disputedMinor",
    "netPaidMinor",
    "paidTransactionCount",
    "firstPaidAt",
    "lastPaidAt",
    "materializedAt",
  ]) &&
    /^[a-z]{3}$/.test(value.currency) &&
    isDecimal(value.grossPaidMinor) &&
    isDecimal(value.offStripePaidMinor) &&
    isDecimal(value.refundedMinor) &&
    isDecimal(value.disputedMinor) &&
    isDecimal(value.netPaidMinor) &&
    isDecimal(value.paidTransactionCount) &&
    isNullableIso(value.firstPaidAt) &&
    isNullableIso(value.lastPaidAt) &&
    isIso(value.materializedAt);
}

function isUsageShape(value) {
  return hasExactKeys(value, [
    "firstDownloadAttemptAt",
    "firstDownloadSucceededAt",
    "downloadOutcomeNumerator",
    "downloadOutcomeDenominator",
    "lastUseAt",
    "activeDays7",
    "activeDays30",
    "downloadFrequency30d",
    "syncedAt",
    "sourceFreshnessAt",
  ]) &&
    isNullableIso(value.firstDownloadAttemptAt) &&
    isNullableIso(value.firstDownloadSucceededAt) &&
    isNullableDecimal(value.downloadOutcomeNumerator) &&
    isNullableDecimal(value.downloadOutcomeDenominator) &&
    isNullableIso(value.lastUseAt) &&
    isNullableDecimal(value.activeDays7) &&
    isNullableDecimal(value.activeDays30) &&
    isNullableFrequency(value.downloadFrequency30d) &&
    isNullableIso(value.syncedAt) &&
    isNullableIso(value.sourceFreshnessAt);
}

function isUsageSyncResponse(value) {
  return hasExactKeys(value, [
    "ok",
    "outcome",
    "licenseNamespace",
    "batches",
    "sourceRowsScanned",
    "dailyBucketsWritten",
    "profilesRefreshed",
    "sourceFreshnessAt",
  ]) &&
    value.ok === true &&
    ["completed", "skipped", "locked"].includes(value.outcome) &&
    value.licenseNamespace === "test" &&
    isNonnegativeInteger(value.batches) &&
    isNonnegativeInteger(value.sourceRowsScanned) &&
    isNonnegativeInteger(value.dailyBucketsWritten) &&
    isNonnegativeInteger(value.profilesRefreshed) &&
    isNullableIso(value.sourceFreshnessAt);
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isPlainObject(value) {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function isUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isDecimal(value) {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
}

function isNullableDecimal(value) {
  return value === null || isDecimal(value);
}

function isNullableFrequency(value) {
  return value === null || (
    typeof value === "string" &&
    /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)
  );
}

function isNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isBoundedString(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isNullableBoundedString(value, maximum) {
  return value === null || isBoundedString(value, maximum);
}

function isIso(value) {
  return typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value));
}

function isNullableIso(value) {
  return value === null || isIso(value);
}

async function main() {
  let options;
  try {
    options = parsePreviewDeploymentArguments(process.argv.slice(2));
  } catch {
    console.error("FAIL invalid_arguments");
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(previewDeploymentUsage());
    return;
  }

  const verification = await verifyCustomer360PreviewDeployment(options);
  const output = formatPreviewDeploymentVerification(verification);
  if (output) console.log(output);
  if (!verification.pass) process.exitCode = 1;
}

const entryUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === entryUrl) {
  main().catch(() => {
    console.error("FAIL verification_failed");
    process.exitCode = 1;
  });
}

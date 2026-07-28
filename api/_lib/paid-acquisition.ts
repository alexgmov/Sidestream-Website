// @ts-nocheck
/**
 * Server-only paid-acquisition primitives.
 *
 * This module deliberately has no browser, Stripe, or database dependency. The
 * integration route is responsible for storing the returned records in one
 * transaction and for passing only server-verified provider facts here.
 */
import {
  createHash,
  createHmac,
  randomBytes as nodeRandomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { domainToASCII } from "node:url";
import type { PoolClient } from "pg";

export const PAID_ACQUISITION_CONTRACT_VERSION = 1;
export const PAID_ACQUISITION_EXPERIMENT_ID = "mc-mobile-paid-v1";
export const PAID_ACQUISITION_CONTROL_COHORT = "mc-control-v1";
export const PAID_ACQUISITION_PAID_COHORT = "mc-paid-v1";
export const PAID_ACQUISITION_COOKIE_NAME =
  "__Host-sidestream-mc-mobile-paid-v1";
export const PAID_ACQUISITION_ENTRY_PATH = "/mc";
export const PAID_ACQUISITION_COOKIE_MAX_AGE_SECONDS = 2_592_000;
export const PAID_ACQUISITION_ENTRY_MAX_AGE_SECONDS = 600;

export const PAID_ACQUISITION_EVENT_NAMES = Object.freeze([
  "mc_entry_eligible",
  "mc_landing_viewed",
  "mc_checkout_started",
  "mc_checkout_paid",
  "mc_installer_email_accepted",
  "mc_installer_downloaded",
  "mc_activation_started",
  "mc_activation_claimed",
  "mc_entitlement_issued",
  "mc_refund_recorded",
  "mc_dispute_recorded",
]);

export const PAID_ACQUISITION_EVENT_OUTCOMES = Object.freeze([
  "success",
  "pending",
  "rejected",
  "retryable",
  "revoked",
]);

const ENVIRONMENTS = new Set(["test", "production"]);
const COHORTS = new Set([
  PAID_ACQUISITION_CONTROL_COHORT,
  PAID_ACQUISITION_PAID_COHORT,
]);
const EVENT_NAMES = new Set(PAID_ACQUISITION_EVENT_NAMES);
const EVENT_OUTCOMES = new Set(PAID_ACQUISITION_EVENT_OUTCOMES);
const PLATFORMS = new Set(["macos", "windows", "unknown"]);
const UTM_MEDIUMS = new Set(["dm", "social"]);
const SAFE_UTM_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASE64URL_128 = /^[A-Za-z0-9_-]{22}$/;
const BASE64URL_256 = /^[A-Za-z0-9_-]{43}$/;
const LOWER_HEX_256 = /^[a-f0-9]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ASCII_WHITESPACE_EDGES = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const INTERNAL_EMAIL_WHITESPACE = /\s/u;
const SAFE_PROVIDER_REFERENCE = /^[\x21-\x7e]{1,255}$/;
const ASSIGNMENT_SIGNATURE_CONTEXT =
  "sidestream-paid-acquisition-assignment-cookie-v1";
const ASSIGNMENT_ID_CONTEXT = "sidestream-paid-acquisition-assignment-id-v1";
const REQUEST_FINGERPRINT_CONTEXT =
  "sidestream-paid-acquisition-checkout-request-v1";
const LANDING_PROOF_CONTEXT = "sidestream-paid-acquisition-landing-proof-v1";
const RECEIPT_CONTEXT = "sidestream-paid-acquisition-receipt-v1";
const PAID_SOURCE = "paid-acquisition-mc-v1";
const RECEIPT_TTL_SECONDS = 7 * 24 * 60 * 60;
const RECEIPT_COOKIE_MAX_AGE_SECONDS = RECEIPT_TTL_SECONDS;
const PAID_INSTALLER_EMAIL_TYPE = "paid-installer-v1";

export const PAID_ACQUISITION_SOURCE = PAID_SOURCE;
export const PAID_ACQUISITION_RECEIPT_COOKIE =
  "__Host-sidestream-paid-acquisition-receipt";
export const PAID_ACQUISITION_RECEIPT_MAX_AGE_SECONDS =
  RECEIPT_COOKIE_MAX_AGE_SECONDS;

export class PaidAcquisitionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PaidAcquisitionError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PaidAcquisitionError(code, message);
}

function assertPlainObject(value, code = "invalid_request") {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(code, "Expected a plain object.");
  }
}

function assertOnlyKeys(value, allowed, code = "invalid_request") {
  assertPlainObject(value, code);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(code, `Unexpected field: ${key}.`);
    }
  }
}

function asSecretBuffer(secret) {
  const value =
    typeof secret === "string"
      ? Buffer.from(secret, "utf8")
      : Buffer.isBuffer(secret) || secret instanceof Uint8Array
        ? Buffer.from(secret)
        : null;
  if (!value || value.length < 32) {
    fail("environment_unavailable", "Assignment signing is unavailable.");
  }
  return value;
}

function asEpochSeconds(value, field) {
  const seconds =
    value instanceof Date ? Math.floor(value.getTime() / 1000) : value;
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    fail("invalid_request", `${field} must be epoch seconds.`);
  }
  return seconds;
}

function asEnvironment(value) {
  if (!ENVIRONMENTS.has(value)) {
    fail("environment_unavailable", "Paid acquisition environment unavailable.");
  }
  return value;
}

function hmacHex(secret, value) {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeHexEqual(left, right) {
  if (!LOWER_HEX_256.test(left) || !LOWER_HEX_256.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function safeBase64urlEqual(left, right) {
  if (!BASE64URL_256.test(left) || !BASE64URL_256.test(right)) return false;
  return timingSafeEqual(
    Buffer.from(left, "base64url"),
    Buffer.from(right, "base64url"),
  );
}

function assignmentMessage(version, nonce, cohort, issuedAt) {
  return [
    ASSIGNMENT_SIGNATURE_CONTEXT,
    version,
    nonce,
    cohort,
    issuedAt,
  ].join(":");
}

function assignmentIdHash(secret, nonce) {
  return hmacHex(secret, `${ASSIGNMENT_ID_CONTEXT}:${nonce}`);
}

function assignmentSignatureHash(signature) {
  return sha256Hex(`paid-acquisition-cookie-signature:${signature}`);
}

function freezeRecord(value) {
  return Object.freeze({ ...value });
}

function normalizeAttribution(input = {}) {
  assertOnlyKeys(
    input,
    new Set(["utmMedium", "utmCampaign", "utmContent", "utmId"]),
  );

  const output = {
    utmMedium: null,
    utmCampaign: null,
    utmContent: null,
    utmId: null,
  };

  if (input.utmMedium !== undefined && input.utmMedium !== null) {
    if (!UTM_MEDIUMS.has(input.utmMedium)) {
      fail("invalid_request", "Invalid UTM medium.");
    }
    output.utmMedium = input.utmMedium;
  }

  for (const [inputKey, outputKey] of [
    ["utmCampaign", "utmCampaign"],
    ["utmContent", "utmContent"],
    ["utmId", "utmId"],
  ]) {
    const value = input[inputKey];
    if (value !== undefined && value !== null) {
      if (typeof value !== "string" || !SAFE_UTM_VALUE.test(value)) {
        fail("invalid_request", `Invalid ${inputKey}.`);
      }
      output[outputKey] = value;
    }
  }

  return freezeRecord(output);
}

/**
 * Creates the exact compact assignment-cookie value understood by this module.
 * The router owns when this is called; a Checkout route must only validate it.
 */
export function createPaidAcquisitionAssignmentCookie({
  nonce,
  cohort,
  issuedAt,
  secret,
}) {
  if (!BASE64URL_128.test(nonce) || !COHORTS.has(cohort)) {
    fail("invalid_request", "Invalid assignment.");
  }
  const issuedAtSeconds = asEpochSeconds(issuedAt, "issuedAt");
  const secretBuffer = asSecretBuffer(secret);
  const signature = createHmac("sha256", secretBuffer)
    .update(
      assignmentMessage(
        PAID_ACQUISITION_CONTRACT_VERSION,
        nonce,
        cohort,
        issuedAtSeconds,
      ),
      "utf8",
    )
    .digest("base64url");
  const value = [
    PAID_ACQUISITION_CONTRACT_VERSION,
    nonce,
    cohort,
    issuedAtSeconds,
    signature,
  ].join(".");
  if (value.length > 192) {
    fail("invalid_request", "Assignment cookie is too large.");
  }
  return value;
}

/**
 * Validates browser-supplied cookie state cryptographically and returns a
 * server-owned representation. Invalid, expired, or forged values fail closed.
 */
export function validatePaidAcquisitionAssignmentCookie(
  cookieValue,
  { secret, now = Math.floor(Date.now() / 1000) } = {},
) {
  if (
    typeof cookieValue !== "string" ||
    cookieValue.length > 192 ||
    !/^[\x21-\x7e]+$/.test(cookieValue)
  ) {
    fail("ineligible_entry", "Paid acquisition assignment is invalid.");
  }

  const parts = cookieValue.split(".");
  if (parts.length !== 5) {
    fail("ineligible_entry", "Paid acquisition assignment is invalid.");
  }
  const [versionRaw, nonce, cohort, issuedAtRaw, signature] = parts;
  const version = Number(versionRaw);
  const issuedAt = Number(issuedAtRaw);
  const nowSeconds = asEpochSeconds(now, "now");

  if (
    version !== PAID_ACQUISITION_CONTRACT_VERSION ||
    !BASE64URL_128.test(nonce) ||
    !COHORTS.has(cohort) ||
    !/^(0|[1-9][0-9]*)$/.test(issuedAtRaw) ||
    !Number.isSafeInteger(issuedAt) ||
    !BASE64URL_256.test(signature)
  ) {
    fail("ineligible_entry", "Paid acquisition assignment is invalid.");
  }

  const secretBuffer = asSecretBuffer(secret);
  const expectedSignature = createHmac("sha256", secretBuffer)
    .update(assignmentMessage(version, nonce, cohort, issuedAt), "utf8")
    .digest("base64url");
  if (!safeBase64urlEqual(signature, expectedSignature)) {
    fail("ineligible_entry", "Paid acquisition assignment is invalid.");
  }
  if (
    issuedAt > nowSeconds ||
    nowSeconds - issuedAt > PAID_ACQUISITION_COOKIE_MAX_AGE_SECONDS
  ) {
    fail("ineligible_entry", "Paid acquisition assignment is expired.");
  }

  return freezeRecord({
    contractVersion: version,
    experimentId: PAID_ACQUISITION_EXPERIMENT_ID,
    cohort,
    nonce,
    issuedAt,
    assignmentIdHash: assignmentIdHash(secretBuffer, nonce),
    assignmentCookieSignatureHash: assignmentSignatureHash(signature),
  });
}

/**
 * Issues a short-lived opaque entry token and the server record that must be
 * persisted before the token is rendered. Raw assignment nonces are omitted
 * from the record.
 */
export function createPaidAcquisitionEntryContext({
  assignmentCookieValue,
  assignmentSecret,
  environment,
  attribution = {},
  now = Math.floor(Date.now() / 1000),
  randomBytes = nodeRandomBytes,
}) {
  const trustedEnvironment = asEnvironment(environment);
  const nowSeconds = asEpochSeconds(now, "now");
  const assignment = validatePaidAcquisitionAssignmentCookie(
    assignmentCookieValue,
    { secret: assignmentSecret, now: nowSeconds },
  );
  if (assignment.cohort !== PAID_ACQUISITION_PAID_COHORT) {
    fail("ineligible_entry", "Control assignments cannot create paid state.");
  }

  const normalizedAttribution = normalizeAttribution(attribution);
  const tokenBytes = randomBytes(32);
  if (
    !(tokenBytes instanceof Uint8Array) ||
    Buffer.from(tokenBytes).length !== 32
  ) {
    fail("temporarily_unavailable", "Entry-token generation failed.");
  }
  const entryToken = Buffer.from(tokenBytes).toString("base64url");
  const expiresAt = nowSeconds + PAID_ACQUISITION_ENTRY_MAX_AGE_SECONDS;

  return freezeRecord({
    entryToken,
    context: freezeRecord({
      contractVersion: PAID_ACQUISITION_CONTRACT_VERSION,
      environment: trustedEnvironment,
      experimentId: PAID_ACQUISITION_EXPERIMENT_ID,
      cohort: PAID_ACQUISITION_PAID_COHORT,
      entryPath: PAID_ACQUISITION_ENTRY_PATH,
      assignmentIdHash: assignment.assignmentIdHash,
      assignmentCookieSignatureHash:
        assignment.assignmentCookieSignatureHash,
      entryTokenHash: sha256Hex(entryToken),
      attribution: normalizedAttribution,
      attributionHash: sha256Hex(JSON.stringify(normalizedAttribution)),
      createdAt: nowSeconds,
      expiresAt,
    }),
  });
}

/**
 * Re-validates every browser-carried value against persisted, server-owned
 * context. A browser cannot select cohort, environment, or attribution.
 */
export function validatePaidAcquisitionCheckoutEntry({
  entryToken,
  persistedContext,
  assignmentCookieValue,
  assignmentSecret,
  trustedEnvironment,
  now = Math.floor(Date.now() / 1000),
}) {
  if (typeof entryToken !== "string" || !BASE64URL_256.test(entryToken)) {
    fail("ineligible_entry", "Paid entry token is invalid.");
  }
  assertOnlyKeys(
    persistedContext,
    new Set([
      "contractVersion",
      "environment",
      "experimentId",
      "cohort",
      "entryPath",
      "assignmentIdHash",
      "assignmentCookieSignatureHash",
      "entryTokenHash",
      "attribution",
      "attributionHash",
      "createdAt",
      "expiresAt",
    ]),
    "ineligible_entry",
  );

  const environment = asEnvironment(trustedEnvironment);
  const nowSeconds = asEpochSeconds(now, "now");
  const expectedAttribution = normalizeAttribution(persistedContext.attribution);
  const expectedAttributionHash = sha256Hex(
    JSON.stringify(expectedAttribution),
  );
  const assignment = validatePaidAcquisitionAssignmentCookie(
    assignmentCookieValue,
    { secret: assignmentSecret, now: nowSeconds },
  );

  if (
    persistedContext.contractVersion !==
      PAID_ACQUISITION_CONTRACT_VERSION ||
    persistedContext.environment !== environment ||
    persistedContext.experimentId !== PAID_ACQUISITION_EXPERIMENT_ID ||
    persistedContext.cohort !== PAID_ACQUISITION_PAID_COHORT ||
    persistedContext.entryPath !== PAID_ACQUISITION_ENTRY_PATH ||
    !safeHexEqual(
      persistedContext.assignmentIdHash,
      assignment.assignmentIdHash,
    ) ||
    !safeHexEqual(
      persistedContext.assignmentCookieSignatureHash,
      assignment.assignmentCookieSignatureHash,
    ) ||
    !safeHexEqual(persistedContext.entryTokenHash, sha256Hex(entryToken)) ||
    !safeHexEqual(persistedContext.attributionHash, expectedAttributionHash) ||
    assignment.cohort !== PAID_ACQUISITION_PAID_COHORT ||
    !Number.isSafeInteger(persistedContext.createdAt) ||
    !Number.isSafeInteger(persistedContext.expiresAt) ||
    persistedContext.expiresAt - persistedContext.createdAt !==
      PAID_ACQUISITION_ENTRY_MAX_AGE_SECONDS ||
    persistedContext.createdAt > nowSeconds ||
    nowSeconds > persistedContext.expiresAt
  ) {
    fail("ineligible_entry", "Paid entry context is invalid or expired.");
  }

  return freezeRecord({
    ...persistedContext,
    attribution: expectedAttribution,
  });
}

function assertUuid(value, field) {
  if (typeof value !== "string" || !UUID.test(value)) {
    fail("invalid_request", `${field} must be a UUID.`);
  }
  return value.toLowerCase();
}

function assertProviderReference(value, field) {
  if (typeof value !== "string" || !SAFE_PROVIDER_REFERENCE.test(value)) {
    fail("invalid_request", `${field} is invalid.`);
  }
  return value;
}

function assertValidatedEntry(entry) {
  assertPlainObject(entry, "ineligible_entry");
  if (
    entry.contractVersion !== PAID_ACQUISITION_CONTRACT_VERSION ||
    entry.experimentId !== PAID_ACQUISITION_EXPERIMENT_ID ||
    entry.cohort !== PAID_ACQUISITION_PAID_COHORT ||
    entry.entryPath !== PAID_ACQUISITION_ENTRY_PATH ||
    !ENVIRONMENTS.has(entry.environment) ||
    !LOWER_HEX_256.test(entry.assignmentIdHash) ||
    !LOWER_HEX_256.test(entry.entryTokenHash) ||
    !LOWER_HEX_256.test(entry.attributionHash)
  ) {
    fail("ineligible_entry", "Paid entry context is invalid.");
  }
}

/**
 * Builds the immutable binding to persist before creating a provider Checkout
 * Session. The caller must enforce unique idempotency-key and assignment/entry
 * constraints in the same transaction.
 */
export function bindPaidAcquisitionCheckoutIntent({
  validatedEntry,
  checkoutIntentRef,
  idempotencyKey,
  createdAt = Math.floor(Date.now() / 1000),
}) {
  assertValidatedEntry(validatedEntry);
  const normalizedIntentRef = assertUuid(
    checkoutIntentRef,
    "checkoutIntentRef",
  );
  const normalizedIdempotencyKey = assertUuid(idempotencyKey, "idempotencyKey");
  const createdAtSeconds = asEpochSeconds(createdAt, "createdAt");
  const requestFingerprint = sha256Hex(
    [
      REQUEST_FINGERPRINT_CONTEXT,
      validatedEntry.environment,
      validatedEntry.experimentId,
      validatedEntry.cohort,
      validatedEntry.assignmentIdHash,
      validatedEntry.entryTokenHash,
      validatedEntry.attributionHash,
    ].join(":"),
  );

  return freezeRecord({
    contractVersion: PAID_ACQUISITION_CONTRACT_VERSION,
    environment: validatedEntry.environment,
    experimentId: PAID_ACQUISITION_EXPERIMENT_ID,
    cohort: PAID_ACQUISITION_PAID_COHORT,
    assignmentIdHash: validatedEntry.assignmentIdHash,
    entryTokenHash: validatedEntry.entryTokenHash,
    attribution: normalizeAttribution(validatedEntry.attribution),
    attributionHash: validatedEntry.attributionHash,
    checkoutIntentRef: normalizedIntentRef,
    idempotencyKey: normalizedIdempotencyKey,
    requestFingerprint,
    createdAt: createdAtSeconds,
  });
}

function sameIntentIdentity(left, right) {
  return (
    left.contractVersion === right.contractVersion &&
    left.environment === right.environment &&
    left.experimentId === right.experimentId &&
    left.cohort === right.cohort &&
    left.assignmentIdHash === right.assignmentIdHash &&
    left.entryTokenHash === right.entryTokenHash &&
    left.attributionHash === right.attributionHash &&
    left.idempotencyKey === right.idempotencyKey &&
    left.requestFingerprint === right.requestFingerprint
  );
}

/**
 * Resolves a locked start record. Exact replay returns the original intent;
 * key reuse with different context, or a second intent for one entry, conflicts.
 */
export function resolvePaidAcquisitionCheckoutStart({
  existingIntent,
  proposedIntent,
}) {
  assertPlainObject(proposedIntent);
  if (existingIntent === null || existingIntent === undefined) {
    return freezeRecord({
      action: "create",
      reused: false,
      intent: proposedIntent,
    });
  }
  assertPlainObject(existingIntent);

  if (sameIntentIdentity(existingIntent, proposedIntent)) {
    return freezeRecord({
      action: "reuse",
      reused: true,
      intent: existingIntent,
    });
  }
  fail(
    "checkout_conflict",
    "Checkout idempotency key or paid entry is already bound.",
  );
}

/**
 * Conservative shared normalizer for server-verified Checkout and Google
 * emails. It intentionally does not apply provider-specific alias rules.
 */
export function normalizePaidAcquisitionVerifiedEmail(value) {
  if (typeof value !== "string") {
    fail("invalid_customer_identity", "Verified customer identity is invalid.");
  }
  const normalizedInput = value
    .replace(ASCII_WHITESPACE_EDGES, "")
    .normalize("NFC");
  if (
    normalizedInput.length === 0 ||
    CONTROL_CHARACTERS.test(normalizedInput) ||
    INTERNAL_EMAIL_WHITESPACE.test(normalizedInput)
  ) {
    fail("invalid_customer_identity", "Verified customer identity is invalid.");
  }

  const separator = normalizedInput.indexOf("@");
  if (
    separator <= 0 ||
    separator !== normalizedInput.lastIndexOf("@") ||
    separator === normalizedInput.length - 1
  ) {
    fail("invalid_customer_identity", "Verified customer identity is invalid.");
  }

  const local = normalizedInput.slice(0, separator);
  const domain = normalizedInput.slice(separator + 1);
  if (
    local.length > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    /[()<>\[\]\\,;:"]/u.test(local)
  ) {
    fail("invalid_customer_identity", "Verified customer identity is invalid.");
  }

  const asciiDomain = domainToASCII(domain).toLowerCase();
  if (
    asciiDomain.length === 0 ||
    asciiDomain.length > 253 ||
    asciiDomain.startsWith(".") ||
    asciiDomain.endsWith(".")
  ) {
    fail("invalid_customer_identity", "Verified customer identity is invalid.");
  }
  for (const label of asciiDomain.split(".")) {
    if (
      label.length === 0 ||
      label.length > 63 ||
      !/^[a-z0-9-]+$/.test(label) ||
      label.startsWith("-") ||
      label.endsWith("-")
    ) {
      fail(
        "invalid_customer_identity",
        "Verified customer identity is invalid.",
      );
    }
  }

  const normalized = `${local.toLowerCase()}@${asciiDomain}`;
  if (
    CONTROL_CHARACTERS.test(normalized) ||
    Buffer.byteLength(normalized, "utf8") > 254
  ) {
    fail("invalid_customer_identity", "Verified customer identity is invalid.");
  }
  return normalized;
}

function sameCompletion(left, right) {
  return (
    left.contractVersion === right.contractVersion &&
    left.environment === right.environment &&
    left.experimentId === right.experimentId &&
    left.cohort === right.cohort &&
    left.checkoutIntentRef === right.checkoutIntentRef &&
    left.verifiedCheckoutSessionRef === right.verifiedCheckoutSessionRef &&
    left.canonicalPaymentRef === right.canonicalPaymentRef &&
    left.checkoutEmailNormalized === right.checkoutEmailNormalized
  );
}

/**
 * Binds server-retrieved, paid Checkout truth to the existing intent. The
 * integration layer must perform provider retrieval and payment/line-item
 * verification before calling this function.
 */
export function resolvePaidAcquisitionCheckoutCompletion({
  intent,
  verifiedCheckoutSessionRef,
  canonicalPaymentRef,
  verifiedCheckoutEmail,
  existingCompletion = null,
  completedAt = Math.floor(Date.now() / 1000),
}) {
  assertPlainObject(intent);
  if (
    intent.contractVersion !== PAID_ACQUISITION_CONTRACT_VERSION ||
    intent.experimentId !== PAID_ACQUISITION_EXPERIMENT_ID ||
    intent.cohort !== PAID_ACQUISITION_PAID_COHORT ||
    !ENVIRONMENTS.has(intent.environment) ||
    !UUID.test(intent.checkoutIntentRef)
  ) {
    fail("checkout_conflict", "Checkout intent binding is invalid.");
  }

  const proposedCompletion = freezeRecord({
    contractVersion: PAID_ACQUISITION_CONTRACT_VERSION,
    environment: intent.environment,
    experimentId: PAID_ACQUISITION_EXPERIMENT_ID,
    cohort: PAID_ACQUISITION_PAID_COHORT,
    checkoutIntentRef: intent.checkoutIntentRef,
    verifiedCheckoutSessionRef: assertProviderReference(
      verifiedCheckoutSessionRef,
      "verifiedCheckoutSessionRef",
    ),
    canonicalPaymentRef: assertProviderReference(
      canonicalPaymentRef,
      "canonicalPaymentRef",
    ),
    checkoutEmailNormalized: normalizePaidAcquisitionVerifiedEmail(
      verifiedCheckoutEmail,
    ),
    completedAt: asEpochSeconds(completedAt, "completedAt"),
  });

  if (existingCompletion === null || existingCompletion === undefined) {
    return freezeRecord({
      action: "complete",
      reused: false,
      completion: proposedCompletion,
    });
  }
  assertPlainObject(existingCompletion);
  if (sameCompletion(existingCompletion, proposedCompletion)) {
    return freezeRecord({
      action: "reuse",
      reused: true,
      completion: existingCompletion,
    });
  }
  fail(
    "checkout_conflict",
    "Checkout completion conflicts with the committed provider truth.",
  );
}

/**
 * Builds the exact privacy-safe event shape. Unexpected keys are rejected so
 * email, provider payloads, raw request data, or identifiers cannot be dropped
 * silently into telemetry.
 */
export function createPaidAcquisitionLifecycleEvent(input) {
  assertOnlyKeys(
    input,
    new Set([
      "eventId",
      "occurredAt",
      "environment",
      "cohort",
      "eventName",
      "outcome",
      "anonymousDayHash",
      "attribution",
      "platform",
    ]),
  );

  const environment = asEnvironment(input.environment);
  if (!COHORTS.has(input.cohort)) {
    fail("invalid_request", "Invalid event cohort.");
  }
  if (!EVENT_NAMES.has(input.eventName)) {
    fail("invalid_request", "Invalid event name.");
  }
  if (
    input.cohort === PAID_ACQUISITION_CONTROL_COHORT &&
    input.eventName !== "mc_entry_eligible"
  ) {
    fail("invalid_request", "Control cohort cannot emit paid lifecycle events.");
  }
  if (!EVENT_OUTCOMES.has(input.outcome)) {
    fail("invalid_request", "Invalid event outcome.");
  }
  if (
    typeof input.anonymousDayHash !== "string" ||
    !LOWER_HEX_256.test(input.anonymousDayHash)
  ) {
    fail("invalid_request", "Invalid anonymous day hash.");
  }
  if (
    input.platform !== undefined &&
    input.platform !== null &&
    !PLATFORMS.has(input.platform)
  ) {
    fail("invalid_request", "Invalid event platform.");
  }

  const eventId =
    input.eventId === undefined
      ? randomUUID()
      : assertUuid(input.eventId, "eventId");
  const occurredAtDate =
    input.occurredAt === undefined
      ? new Date()
      : input.occurredAt instanceof Date
        ? input.occurredAt
        : new Date(input.occurredAt);
  if (Number.isNaN(occurredAtDate.getTime())) {
    fail("invalid_request", "Invalid event timestamp.");
  }
  const attribution = normalizeAttribution(input.attribution ?? {});

  return freezeRecord({
    schema_version: PAID_ACQUISITION_CONTRACT_VERSION,
    event_id: eventId,
    occurred_at: occurredAtDate.toISOString(),
    environment,
    experiment_id: PAID_ACQUISITION_EXPERIMENT_ID,
    cohort: input.cohort,
    event_name: input.eventName,
    outcome: input.outcome,
    anonymous_day_hash: input.anonymousDayHash,
    utm_medium: attribution.utmMedium,
    utm_campaign: attribution.utmCampaign,
    utm_content: attribution.utmContent,
    utm_id: attribution.utmId,
    platform: input.platform ?? null,
  });
}

export function createPaidAcquisitionLandingProof(options: {
  assignmentCookieValue: string;
  attributionQuery: string;
  secret: string | Buffer | Uint8Array;
}) {
  const secret = asSecretBuffer(options.secret);
  if (
    typeof options.assignmentCookieValue !== "string" ||
    options.assignmentCookieValue.length > 192 ||
    typeof options.attributionQuery !== "string" ||
    options.attributionQuery.length > 320
  ) {
    fail("ineligible_entry", "Paid landing proof input is invalid.");
  }
  return createHmac("sha256", secret)
    .update(
      `${LANDING_PROOF_CONTEXT}:${options.assignmentCookieValue}:${options.attributionQuery}`,
      "utf8",
    )
    .digest("base64url");
}

export function validatePaidAcquisitionLandingProof(options: {
  assignmentCookieValue: string;
  attributionQuery: string;
  proof: string;
  secret: string | Buffer | Uint8Array;
}) {
  const expected = createPaidAcquisitionLandingProof(options);
  if (!safeBase64urlEqual(options.proof, expected)) {
    fail("ineligible_entry", "Paid landing proof is invalid.");
  }
  return true;
}

export function hashPaidAcquisitionToken(value: string) {
  if (
    typeof value !== "string" ||
    !BASE64URL_256.test(value)
  ) {
    fail("invalid_request", "Paid acquisition token is invalid.");
  }
  return sha256Hex(value);
}

export function createPaidAcquisitionReceipt(options: {
  environment: "test" | "production";
  verifiedCheckoutSessionRef: string;
  secret: string | Buffer | Uint8Array;
}) {
  const environment = asEnvironment(options.environment);
  const sessionRef = assertProviderReference(
    options.verifiedCheckoutSessionRef,
    "verifiedCheckoutSessionRef",
  );
  return createHmac("sha256", asSecretBuffer(options.secret))
    .update(`${RECEIPT_CONTEXT}:${environment}:${sessionRef}`, "utf8")
    .digest("base64url");
}

export function createPaidAcquisitionReceiptCookie(options: {
  receipt: string;
  environment: "test" | "production";
  secret: string | Buffer | Uint8Array;
}) {
  const receipt = assertReceipt(options.receipt);
  const environment = asEnvironment(options.environment);
  const signature = createHmac("sha256", asSecretBuffer(options.secret))
    .update(`${RECEIPT_CONTEXT}-cookie:${environment}:${receipt}`, "utf8")
    .digest("base64url");
  return `${receipt}.${signature}`;
}

export function validatePaidAcquisitionReceiptCookie(options: {
  cookieValue: string;
  environment: "test" | "production";
  secret: string | Buffer | Uint8Array;
}) {
  const parts =
    typeof options.cookieValue === "string"
      ? options.cookieValue.split(".")
      : [];
  if (parts.length !== 2) {
    fail("invalid_request", "Paid claim receipt is invalid.");
  }
  const [receipt, signature] = parts;
  assertReceipt(receipt);
  const expected = createPaidAcquisitionReceiptCookie({
    receipt,
    environment: options.environment,
    secret: options.secret,
  }).split(".")[1];
  if (!safeBase64urlEqual(signature, expected)) {
    fail("invalid_request", "Paid claim receipt is invalid.");
  }
  return receipt;
}

function assertReceipt(value: unknown) {
  if (typeof value !== "string" || !BASE64URL_256.test(value)) {
    fail("invalid_request", "Paid onboarding receipt is invalid.");
  }
  return value;
}

export async function persistPaidAcquisitionEntry(context: any) {
  assertValidatedEntry(context);
  const attribution = normalizeAttribution(context.attribution);
  const result = await queryPaidPostgres<{ id: string }>(
    context.environment,
    `
      insert into public.sidestream_paid_acquisition_entries (
        contract_version, environment, experiment_id, cohort,
        assignment_id_hash, assignment_cookie_signature_hash,
        entry_path, entry_token_hash, attribution_hash,
        utm_medium, utm_campaign, utm_content, utm_id,
        expires_at, created_at, updated_at
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13,
        to_timestamp($14), to_timestamp($15), to_timestamp($15)
      )
      on conflict (environment, entry_token_hash) do nothing
      returning id
    `,
    [
      context.contractVersion,
      context.environment,
      context.experimentId,
      context.cohort,
      context.assignmentIdHash,
      context.assignmentCookieSignatureHash,
      context.entryPath,
      context.entryTokenHash,
      context.attributionHash,
      attribution.utmMedium,
      attribution.utmCampaign,
      attribution.utmContent,
      attribution.utmId,
      context.expiresAt,
      context.createdAt,
    ],
  );
  if (!result.rows[0]) {
    fail("temporarily_unavailable", "Paid entry could not be persisted.");
  }
  return result.rows[0].id;
}

export async function loadPaidAcquisitionEntry(
  entryToken: string,
  environment: "test" | "production",
) {
  const tokenHash = hashPaidAcquisitionToken(entryToken);
  const result = await queryPaidPostgres<any>(
    environment,
    `
      select id, contract_version, environment, experiment_id, cohort,
        assignment_id_hash, assignment_cookie_signature_hash, entry_path,
        entry_token_hash, attribution_hash, utm_medium, utm_campaign,
        utm_content, utm_id,
        extract(epoch from created_at)::bigint as created_at,
        extract(epoch from expires_at)::bigint as expires_at
      from public.sidestream_paid_acquisition_entries
      where environment = $2
        and entry_token_hash = $1
        and expires_at > now()
      order by created_at desc
      limit 2
    `,
    [tokenHash, environment],
  );
  if (result.rows.length !== 1) {
    fail("ineligible_entry", "Paid entry is unavailable.");
  }
  const row = result.rows[0];
  return {
    id: row.id,
    context: freezeRecord({
      contractVersion: row.contract_version,
      environment: row.environment,
      experimentId: row.experiment_id,
      cohort: row.cohort,
      entryPath: row.entry_path,
      assignmentIdHash: row.assignment_id_hash,
      assignmentCookieSignatureHash:
        row.assignment_cookie_signature_hash,
      entryTokenHash: row.entry_token_hash,
      attribution: freezeRecord({
        utmMedium: row.utm_medium,
        utmCampaign: row.utm_campaign,
        utmContent: row.utm_content,
        utmId: row.utm_id,
      }),
      attributionHash: row.attribution_hash,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    }),
  };
}

export async function findPaidAcquisitionCheckoutReplay(options: {
  environment: "test" | "production";
  idempotencyKey: string;
  proposedIntent: any;
}) {
  const result = await queryPaidPostgres<any>(
    options.environment,
    `
      select paid.*, core.stripe_checkout_url
      from public.sidestream_paid_acquisition_checkouts paid
      join public.sidestream_checkout_intents core
        on core.id = paid.checkout_intent_ref
      where paid.environment = $1
        and paid.idempotency_key = $2::uuid
      limit 1
    `,
    [options.environment, options.idempotencyKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  const existingIntent = paidIntentFromRow(row);
  resolvePaidAcquisitionCheckoutStart({
    existingIntent,
    proposedIntent: options.proposedIntent,
  });
  if (
    typeof row.stripe_checkout_url !== "string" ||
    !isSafeHttpsUrl(row.stripe_checkout_url)
  ) {
    fail("temporarily_unavailable", "Paid Checkout is still being created.");
  }
  return {
    checkoutIntentRef: row.checkout_intent_ref,
    url: row.stripe_checkout_url,
  };
}

export async function persistPaidAcquisitionCheckoutIntent(options: {
  entryId: string;
  intent: any;
  expiresAt: string;
}) {
  const intent = options.intent;
  const attribution = normalizeAttribution(intent.attribution);
  await queryPaidPostgres(
    intent.environment,
    `
      insert into public.sidestream_paid_acquisition_checkouts (
        entry_id, contract_version, environment, experiment_id, cohort,
        assignment_id_hash, entry_token_hash, attribution_hash,
        checkout_intent_ref, idempotency_key, request_fingerprint,
        expires_at, created_at, updated_at
      ) values (
        $1::uuid, $2, $3, $4, $5, $6, $7, $8,
        $9::uuid, $10::uuid, $11,
        $12::timestamptz, to_timestamp($13), to_timestamp($13)
      )
    `,
    [
      options.entryId,
      intent.contractVersion,
      intent.environment,
      intent.experimentId,
      intent.cohort,
      intent.assignmentIdHash,
      intent.entryTokenHash,
      intent.attributionHash,
      intent.checkoutIntentRef,
      intent.idempotencyKey,
      intent.requestFingerprint,
      options.expiresAt,
      intent.createdAt,
    ],
  );
  return attribution;
}

export async function attachPaidAcquisitionCheckoutSession(options: {
  environment: "test" | "production";
  checkoutIntentRef: string;
}) {
  const result = await queryPaidPostgres<{
    stripe_checkout_session_id: string;
  }>(
    options.environment,
    `
      update public.sidestream_paid_acquisition_checkouts paid
      set verified_checkout_session_ref = core.stripe_checkout_session_id,
          updated_at = now()
      from public.sidestream_checkout_intents core
      where paid.checkout_intent_ref = $1::uuid
        and paid.environment = $2
        and core.id = paid.checkout_intent_ref
        and core.stripe_checkout_session_id is not null
      returning core.stripe_checkout_session_id
    `,
    [options.checkoutIntentRef, options.environment],
  );
  if (!result.rows[0]) {
    fail("temporarily_unavailable", "Paid Checkout session was not persisted.");
  }
  return result.rows[0].stripe_checkout_session_id;
}

function paidIntentFromRow(row: any) {
  return freezeRecord({
    contractVersion: row.contract_version,
    environment: row.environment,
    experimentId: row.experiment_id,
    cohort: row.cohort,
    assignmentIdHash: row.assignment_id_hash,
    entryTokenHash: row.entry_token_hash,
    attribution: freezeRecord({
      utmMedium: row.utm_medium ?? null,
      utmCampaign: row.utm_campaign ?? null,
      utmContent: row.utm_content ?? null,
      utmId: row.utm_id ?? null,
    }),
    attributionHash: row.attribution_hash,
    checkoutIntentRef: row.checkout_intent_ref,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    createdAt: Math.floor(new Date(row.created_at).getTime() / 1_000),
  });
}

export async function completePaidAcquisitionCheckout(options: {
  environment: "test" | "production";
  verifiedCheckoutSessionRef: string;
  canonicalPaymentRef: string;
  verifiedCheckoutEmail: string;
  verifiedProductRef: string;
  verifiedPriceRef: string;
  verifiedQuantity: number;
  verifiedOriginalAmountMinor: number;
  verifiedDiscountAmountMinor: number;
  verifiedAmountMinor: number;
  verifiedCurrency: string;
  accountRef?: string | null;
  entitlementRef?: string | null;
  publicOrigin?: string;
}) {
  if (
    options.verifiedQuantity !== 1 ||
    options.verifiedOriginalAmountMinor !== 1499 ||
    !Number.isSafeInteger(options.verifiedDiscountAmountMinor) ||
    options.verifiedDiscountAmountMinor < 0 ||
    options.verifiedDiscountAmountMinor >= options.verifiedOriginalAmountMinor ||
    options.verifiedAmountMinor !==
      options.verifiedOriginalAmountMinor - options.verifiedDiscountAmountMinor ||
    options.verifiedCurrency !== "usd"
  ) {
    fail("checkout_conflict", "Paid Checkout product truth is invalid.");
  }
  const environment = asEnvironment(options.environment);
  const email = normalizePaidAcquisitionVerifiedEmail(
    options.verifiedCheckoutEmail,
  );
  const receipt = createPaidAcquisitionReceipt({
    environment,
    verifiedCheckoutSessionRef: options.verifiedCheckoutSessionRef,
    secret: requireReceiptSecret(),
  });
  const receiptHash = sha256Hex(receipt);
  const completed = await withPaidPostgresTransaction(
    environment,
    async (client) => {
    const selected = await client.query<any>(
      `
        select paid.*, core.id as core_intent_id
        from public.sidestream_paid_acquisition_checkouts paid
        join public.sidestream_checkout_intents core
          on core.id = paid.checkout_intent_ref
        where paid.environment = $1
          and (
            paid.verified_checkout_session_ref = $2
            or core.stripe_checkout_session_id = $2
          )
        for update of paid
      `,
      [environment, options.verifiedCheckoutSessionRef],
    );
    if (selected.rows.length === 0) return null;
    if (selected.rows.length !== 1) {
      fail("checkout_conflict", "Paid Checkout identity is ambiguous.");
    }
    const row = selected.rows[0];
    const intent = paidIntentFromRow(row);
    const completion = resolvePaidAcquisitionCheckoutCompletion({
      intent,
      verifiedCheckoutSessionRef: options.verifiedCheckoutSessionRef,
      canonicalPaymentRef: options.canonicalPaymentRef,
      verifiedCheckoutEmail: email,
      existingCompletion: row.canonical_payment_ref
        ? {
            contractVersion: row.contract_version,
            environment: row.environment,
            experimentId: row.experiment_id,
            cohort: row.cohort,
            checkoutIntentRef: row.checkout_intent_ref,
            verifiedCheckoutSessionRef: row.verified_checkout_session_ref,
            canonicalPaymentRef: row.canonical_payment_ref,
            checkoutEmailNormalized: row.checkout_email_normalized,
            completedAt: Math.floor(
              new Date(row.completed_at).getTime() / 1_000,
            ),
          }
        : null,
    });
    await client.query(
      `
        update public.sidestream_paid_acquisition_checkouts
        set verified_checkout_session_ref = $2,
            canonical_payment_ref = $3,
            checkout_email_normalized = $4,
            verified_product_ref = $5,
            verified_price_ref = $6,
            verified_quantity = $7,
            verified_amount_minor = $8,
            verified_currency = $9,
            installer_receipt_hash = $10,
            payment_state = 'active',
            completed_at = coalesce(completed_at, now()),
            receipt_expires_at = coalesce(
              receipt_expires_at,
              now() + interval '7 days'
            ),
            updated_at = now()
        where id = $1
      `,
      [
        row.id,
        options.verifiedCheckoutSessionRef,
        options.canonicalPaymentRef,
        completion.completion.checkoutEmailNormalized,
        options.verifiedProductRef,
        options.verifiedPriceRef,
        options.verifiedQuantity,
        options.verifiedAmountMinor,
        options.verifiedCurrency,
        receiptHash,
      ],
    );
    await client.query(
      `
        insert into public.sidestream_paid_acquisition_email_outbox (
          checkout_id, environment, verified_checkout_session_ref,
          email_type, email_job_state
        ) values ($1, $2, $3, $4, 'pending')
        on conflict (
          environment, verified_checkout_session_ref, email_type
        ) do nothing
      `,
      [
        row.id,
        environment,
        options.verifiedCheckoutSessionRef,
        PAID_INSTALLER_EMAIL_TYPE,
      ],
    );
    await client.query(
      `
        insert into public.sidestream_paid_acquisition_claims (
          checkout_id, environment, canonical_payment_ref,
          account_ref, entitlement_ref, claim_state, expires_at
        ) values (
          $1, $2, $3, $4::uuid, $5::uuid, 'unclaimed',
          now() + interval '7 days'
        )
        on conflict (environment, canonical_payment_ref) do update
        set account_ref = coalesce(
              public.sidestream_paid_acquisition_claims.account_ref,
              excluded.account_ref
            ),
            entitlement_ref = coalesce(
              public.sidestream_paid_acquisition_claims.entitlement_ref,
              excluded.entitlement_ref
            ),
            updated_at = now()
      `,
      [
        row.id,
        environment,
        options.canonicalPaymentRef,
        options.accountRef || null,
        options.entitlementRef || null,
      ],
    );
    return {
      checkoutId: row.id,
      email,
      receipt,
    };
    },
  );
  if (!completed) return { matched: false as const };
  if (process.env.SIDESTREAM_PAID_ACQUISITION_EMAIL_ENABLED === "1") {
    await deliverPaidAcquisitionInstallerEmail({
      environment,
      verifiedCheckoutSessionRef: options.verifiedCheckoutSessionRef,
      verifiedCheckoutEmail: completed.email,
      receipt: completed.receipt,
      publicOrigin: options.publicOrigin,
    });
  }
  return { matched: true as const, receipt };
}

export async function deliverPaidAcquisitionInstallerEmail(options: {
  environment: "test" | "production";
  verifiedCheckoutSessionRef: string;
  verifiedCheckoutEmail: string;
  receipt: string;
  publicOrigin?: string;
}) {
  const claimed = await withPaidPostgresTransaction(
    options.environment,
    async (client) => {
    const result = await client.query<{ id: string }>(
      `
        update public.sidestream_paid_acquisition_email_outbox
        set email_job_state = 'sending',
            attempt_count = attempt_count + 1,
            lease_expires_at = now() + interval '5 minutes',
            updated_at = now()
        where environment = $1
          and verified_checkout_session_ref = $2
          and email_type = $3
          and email_job_state in ('pending', 'retryable')
          and next_attempt_at <= now()
          and (lease_expires_at is null or lease_expires_at <= now())
        returning id
      `,
      [
        options.environment,
        options.verifiedCheckoutSessionRef,
        PAID_INSTALLER_EMAIL_TYPE,
      ],
    );
    return result.rows[0]?.id || "";
    },
  );
  if (!claimed) return { accepted: false as const, reused: true as const };

  const email = await import("./paid-installer-email.js");
  const job = email.createPaidInstallerEmailJob({
    checkout: {
      environment: options.environment,
      verifiedCheckoutSessionId: options.verifiedCheckoutSessionRef,
      verifiedCheckoutEmail: options.verifiedCheckoutEmail,
      paymentStatus: "paid",
    },
    onboardingReceipt: options.receipt,
    publicOrigin: options.publicOrigin,
  });
  try {
    const sent = await email.sendPaidInstallerEmail({ job });
    await queryPaidPostgres(
      options.environment,
      `
        update public.sidestream_paid_acquisition_email_outbox
        set email_job_state = 'accepted',
            provider_message_ref = $2,
            accepted_at = now(),
            lease_expires_at = null,
            last_error_code = null,
            updated_at = now()
        where id = $1::uuid
          and email_job_state = 'sending'
      `,
      [claimed, sent.emailId],
    );
    return { accepted: true as const, reused: false as const };
  } catch (error) {
    const retryable =
      error instanceof Error &&
      "retryable" in error &&
      Boolean((error as { retryable?: unknown }).retryable);
    await queryPaidPostgres(
      options.environment,
      `
        update public.sidestream_paid_acquisition_email_outbox
        set email_job_state = case
              when $2 then 'retryable'
              else 'dead_letter'
            end,
            lease_expires_at = null,
            next_attempt_at = case
              when $2 then now() + interval '5 minutes'
              else next_attempt_at
            end,
            last_error_code = case
              when $2 then 'provider_retryable'
              else 'provider_rejected'
            end,
            updated_at = now()
        where id = $1::uuid
          and email_job_state = 'sending'
      `,
      [claimed, retryable],
    );
    return { accepted: false as const, reused: false as const };
  }
}

export async function getPaidAcquisitionReceiptState(options: {
  environment: "test" | "production";
  receipt: string;
}) {
  const receiptHash = sha256Hex(assertReceipt(options.receipt));
  const result = await queryPaidPostgres<any>(
    options.environment,
    `
      select paid.id, paid.verified_checkout_session_ref,
        paid.canonical_payment_ref, paid.payment_state,
        paid.claim_state, paid.receipt_expires_at,
        paid.checkout_email_normalized,
        license.id as entitlement_ref,
        ${paidLifecycleSql("license")} as entitlement_status
      from public.sidestream_paid_acquisition_checkouts paid
      left join public.sidestream_licenses license
        on license.stripe_payment_intent_id = paid.canonical_payment_ref
      where paid.environment = $1
        and paid.installer_receipt_hash = $2
      limit 2
    `,
    [options.environment, receiptHash],
  );
  if (result.rows.length !== 1) return null;
  return result.rows[0];
}

export async function associatePaidAcquisitionActivation(
  runner: Pick<PoolClient, "query">,
  options: {
    environment: "test" | "production";
    activationRef: string;
    installerReceiptIdHash: string;
  },
) {
  const result = await runner.query<{ id: string }>(
    `
      update public.sidestream_paid_acquisition_claims claim
      set activation_ref = $3::uuid,
          updated_at = now()
      from public.sidestream_paid_acquisition_checkouts paid
      where claim.checkout_id = paid.id
        and claim.environment = $1
        and paid.environment = $1
        and paid.installer_receipt_hash = $2
        and paid.receipt_expires_at > now()
        and paid.payment_state = 'active'
        and (claim.activation_ref is null or claim.activation_ref = $3::uuid)
      returning claim.id
    `,
    [
      options.environment,
      options.installerReceiptIdHash,
      options.activationRef,
    ],
  );
  return Boolean(result.rows[0]);
}

export async function getPaidAcquisitionActivationOutcome(options: {
  environment: "test" | "production";
  activationKey: string;
}) {
  const result = await queryPaidPostgres<{
    claim_state: string;
    payment_state: string;
    expired: boolean;
  }>(
    options.environment,
    `
      select claim.claim_state, paid.payment_state,
        activation.expires_at <= now() as expired
      from public.sidestream_paid_acquisition_claims claim
      join public.sidestream_paid_acquisition_checkouts paid
        on paid.id = claim.checkout_id
      join public.sidestream_activation_sessions activation
        on activation.id = claim.activation_ref
      where claim.environment = $1
        and activation.activation_key = $2
      limit 1
    `,
    [options.environment, options.activationKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.expired) return "expired";
  if (row.payment_state === "refunded") return "refunded";
  if (row.payment_state === "disputed") return "disputed";
  if (row.claim_state === "email_mismatch") return "email_mismatch";
  if (row.claim_state === "claimed") return "claimed";
  if (row.payment_state !== "active") return "pending_payment";
  return "pending";
}

export async function claimPaidAcquisitionActivation(options: {
  environment: "test" | "production";
  receipt: string;
  activationKey: string;
  accountRef: string;
  verifiedGoogleEmail: string;
}) {
  const receiptHash = sha256Hex(assertReceipt(options.receipt));
  const googleEmail = normalizePaidAcquisitionVerifiedEmail(
    options.verifiedGoogleEmail,
  );
  return withPaidPostgresTransaction(options.environment, async (client) => {
    const selected = await client.query<any>(
      `
        select claim.id, claim.account_ref, claim.claim_state,
          paid.checkout_email_normalized, paid.payment_state,
          activation.id as activation_ref,
          activation.expires_at <= now() as activation_expired,
          license.id as entitlement_ref,
          ${paidLifecycleSql("license")} as entitlement_status
        from public.sidestream_paid_acquisition_claims claim
        join public.sidestream_paid_acquisition_checkouts paid
          on paid.id = claim.checkout_id
        join public.sidestream_activation_sessions activation
          on activation.id = claim.activation_ref
        left join public.sidestream_licenses license
          on license.stripe_payment_intent_id = paid.canonical_payment_ref
        where claim.environment = $1
          and paid.environment = $1
          and paid.installer_receipt_hash = $2
          and activation.activation_key = $3
        for update of claim
      `,
      [options.environment, receiptHash, options.activationKey],
    );
    if (selected.rows.length !== 1) return { outcome: "unavailable" as const };
    const row = selected.rows[0];
    if (row.activation_expired) {
      await setClaimState(client, row.id, "expired");
      return { outcome: "activation_expired" as const };
    }
    if (row.payment_state === "refunded") {
      await setClaimState(client, row.id, "refunded");
      return { outcome: "refunded" as const };
    }
    if (
      row.payment_state === "disputed" ||
      row.entitlement_status === "suspended"
    ) {
      await setClaimState(client, row.id, "disputed");
      return { outcome: "disputed" as const };
    }
    if (
      row.payment_state !== "active" ||
      row.entitlement_status !== "active"
    ) {
      await setClaimState(client, row.id, "payment_pending");
      return { outcome: "payment_pending" as const };
    }
    if (row.checkout_email_normalized !== googleEmail) {
      await client.query(
        `
          update public.sidestream_paid_acquisition_claims
          set claim_state = 'email_mismatch',
              google_email_normalized = $2,
              updated_at = now()
          where id = $1
        `,
        [row.id, googleEmail],
      );
      return { outcome: "email_mismatch" as const };
    }
    if (
      row.claim_state === "claimed" &&
      row.account_ref !== options.accountRef
    ) {
      return { outcome: "already_claimed" as const };
    }
    await client.query(
      `
        update public.sidestream_paid_acquisition_claims
        set account_ref = $2::uuid,
            entitlement_ref = $3::uuid,
            google_email_normalized = $4,
            claim_state = 'claimed',
            updated_at = now()
        where id = $1
          and (account_ref is null or account_ref = $2::uuid)
      `,
      [row.id, options.accountRef, row.entitlement_ref, googleEmail],
    );
    return {
      outcome: "claimed" as const,
      entitlementRef: row.entitlement_ref as string,
    };
  });
}

export async function recordPaidAcquisitionLifecycle(options: {
  environment: "test" | "production";
  canonicalPaymentRef: string;
  entitlementStatus: "active" | "suspended" | "revoked";
  reason?: string;
}) {
  const paymentState =
    options.reason === "dispute" ||
    options.entitlementStatus === "suspended"
      ? "disputed"
      : options.entitlementStatus === "revoked"
        ? "refunded"
        : "active";
  const claimState =
    paymentState === "disputed"
      ? "disputed"
      : paymentState === "refunded"
        ? "refunded"
        : null;
  await withPaidPostgresTransaction(options.environment, async (client) => {
    const updated = await client.query<{ id: string }>(
      `
        update public.sidestream_paid_acquisition_checkouts
        set payment_state = $3,
            claim_state = coalesce($4, claim_state),
            updated_at = now()
        where environment = $1
          and canonical_payment_ref = $2
        returning id
      `,
      [
        options.environment,
        options.canonicalPaymentRef,
        paymentState,
        claimState,
      ],
    );
    if (!updated.rows[0]) return;
    if (claimState) {
      await client.query(
        `
          update public.sidestream_paid_acquisition_claims
          set claim_state = $2, updated_at = now()
          where checkout_id = $1
        `,
        [updated.rows[0].id, claimState],
      );
    }
  });
}

function paidLifecycleSql(alias: string) {
  return `
    case
      when to_jsonb(${alias}) ? 'entitlement_status'
        then to_jsonb(${alias}) ->> 'entitlement_status'
      when ${alias}.stripe_checkout_session_id is not null
        then 'active'
      else 'unknown'
    end
  `;
}

async function setClaimState(
  runner: Pick<PoolClient, "query">,
  claimId: string,
  state: string,
) {
  await runner.query(
    `
      update public.sidestream_paid_acquisition_claims
      set claim_state = $2, updated_at = now()
      where id = $1
    `,
    [claimId, state],
  );
}

function requireReceiptSecret() {
  const secret =
    process.env.SIDESTREAM_PAID_ACQUISITION_RECEIPT_SECRET?.trim() || "";
  if (Buffer.byteLength(secret, "utf8") < 32) {
    fail("environment_unavailable", "Paid receipt signing is unavailable.");
  }
  return secret;
}

function isSafeHttpsUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.href.length <= 2048
    );
  } catch {
    return false;
  }
}

async function queryPaidPostgres<
  Row extends Record<string, unknown> = Record<string, unknown>,
>(
  environment: "test" | "production",
  text: string,
  params: readonly unknown[] = [],
) {
  const postgres = await import("./postgres.js");
  return postgres
    .getPostgresPool(paidPostgresTarget(environment))
    .query<Row>(text, [...params]);
}

async function withPaidPostgresTransaction<T>(
  environment: "test" | "production",
  callback: (client: PoolClient) => Promise<T>,
) {
  const postgres = await import("./postgres.js");
  const client = await postgres
    .getPostgresPool(paidPostgresTarget(environment))
    .connect();
  try {
    await client.query("begin");
    try {
      const result = await callback(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
  }
}

function paidPostgresTarget(environment: "test" | "production") {
  const environmentVariable =
    environment === "test"
      ? "SIDESTREAM_TEST_POSTGRES_URL"
      : "SIDESTREAM_POSTGRES_URL";
  const connectionString = process.env[environmentVariable]?.trim() || "";
  if (!connectionString) {
    fail(
      "environment_unavailable",
      "Paid acquisition database is unavailable.",
    );
  }
  return {
    connectionString,
    environmentVariable,
    pooled: true,
  };
}

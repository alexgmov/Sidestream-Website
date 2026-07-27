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

export class PaidAcquisitionError extends Error {
  constructor(code, message) {
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

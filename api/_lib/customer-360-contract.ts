/**
 * Executable Customer 360 privacy boundary.
 *
 * Customer 360 may contain profile/contact fields, platform and app-version
 * summaries, aggregate lifecycle timestamps, aggregate download outcomes, and
 * canonical commerce. Search/source details, URLs, raw telemetry, request
 * identity, tokens, and credentials are outside this boundary.
 */

import type { CustomerLicenseNamespace } from "./customer-profiles.js";

export type Customer360Commerce = Readonly<{
  entitlementStatus: string | null;
  commerceSyncedAt: string | null;
}>;

export type Customer360Profile = Readonly<{
  id: string;
  licenseNamespace: CustomerLicenseNamespace;
  contactEmail: string | null;
  displayName: string | null;
  platformSummary: string | null;
  appVersionSummary: string | null;
  firstSeenAt: string | null;
  lastActivityAt: string | null;
  downloadSuccessCount: number | null;
  downloadFailureCount: number | null;
  commerce: Customer360Commerce | null;
}>;

export const CUSTOMER_360_ALLOWED_FIELD_GROUPS = [
  "profile_contact",
  "platform_app_version_summary",
  "aggregate_lifecycle_timestamps",
  "aggregate_download_outcomes",
  "canonical_commerce",
] as const;
export type Customer360AllowedFieldGroup =
  (typeof CUSTOMER_360_ALLOWED_FIELD_GROUPS)[number];

/** Normalized key fragments that are forbidden at every nesting level. */
export const CUSTOMER_360_FORBIDDEN_KEY_SUBSTRINGS = [
  "searchtext",
  "searchquery",
  "searchterm",
  "sourcetitle",
  "sourceurl",
  "useragent",
  "rawip",
  "ipaddress",
  "ipaddr",
  "remoteip",
  "clientip",
  "rawtelemetry",
  "telemetrypayload",
  "rawpayload",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "token",
  "secret",
  "password",
  "credential",
] as const;

/**
 * Generic containers are explicitly forbidden. Otherwise raw event data could
 * be smuggled through a harmless-looking `metadata.value` shape while every
 * domain-specific denylist continued to pass.
 */
export const CUSTOMER_360_FORBIDDEN_EXACT_KEYS = [
  "ip",
  "url",
  "urls",
  "href",
  "query",
  "title",
  "metadata",
  "payload",
  "event",
  "value",
] as const;

const MAX_SCAN_DEPTH = 8;

type FieldRule = Readonly<{
  accepts: (value: unknown) => boolean;
  children?: Readonly<Record<string, FieldRule>>;
}>;

const nullableString = (value: unknown) => value === null || typeof value === "string";
const nullableCount = (value: unknown) =>
  value === null || (Number.isSafeInteger(value) && Number(value) >= 0);

const COMMERCE_FIELDS: Readonly<Record<string, FieldRule>> = Object.freeze({
  entitlementStatus: { accepts: nullableString },
  commerceSyncedAt: { accepts: nullableString },
});

const PROFILE_FIELDS: Readonly<Record<string, FieldRule>> = Object.freeze({
  id: { accepts: (value) => typeof value === "string" && value.length > 0 },
  licenseNamespace: {
    accepts: (value) => value === "production" || value === "test",
  },
  contactEmail: { accepts: nullableString },
  displayName: { accepts: nullableString },
  platformSummary: { accepts: nullableString },
  appVersionSummary: { accepts: nullableString },
  firstSeenAt: { accepts: nullableString },
  lastActivityAt: { accepts: nullableString },
  downloadSuccessCount: { accepts: nullableCount },
  downloadFailureCount: { accepts: nullableCount },
  commerce: {
    accepts: (value) => value === null || isPlainRecord(value),
    children: COMMERCE_FIELDS,
  },
});

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function keyViolates(normalized: string): boolean {
  if ((CUSTOMER_360_FORBIDDEN_EXACT_KEYS as readonly string[]).includes(normalized)) {
    return true;
  }
  return CUSTOMER_360_FORBIDDEN_KEY_SUBSTRINGS.some((substring) =>
    normalized.includes(substring),
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Returns every path that falls outside the explicit Customer 360 shape.
 * Unknown keys, generic raw-data containers, cycles, and over-depth objects all
 * fail closed. The schema is intentionally sparse, so allowed fields may be
 * absent and unknown lifetime counters are represented by null.
 */
export function findCustomer360PrivacyViolations(record: unknown): string[] {
  const violations = new Set<string>();
  const seen = new Set<object>();

  const scanForbidden = (value: unknown, path: string, depth: number): void => {
    if (value === null || typeof value !== "object") return;
    if (depth > MAX_SCAN_DEPTH) {
      violations.add(`${path || "$"}.__maxDepth`);
      return;
    }
    if (seen.has(value as object)) {
      violations.add(`${path || "$"}.__cycle`);
      return;
    }
    seen.add(value as object);

    if (Array.isArray(value)) {
      value.forEach((item, index) => scanForbidden(item, `${path}[${index}]`, depth + 1));
      return;
    }

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (keyViolates(normalizeKey(key))) violations.add(childPath);
      scanForbidden(child, childPath, depth + 1);
    }
  };

  const validateShape = (
    value: unknown,
    fields: Readonly<Record<string, FieldRule>>,
    path: string,
  ): void => {
    if (!isPlainRecord(value)) {
      violations.add(path || "$");
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      const rule = fields[key];
      if (!rule) {
        violations.add(childPath);
        continue;
      }
      if (!rule.accepts(child)) violations.add(childPath);
      if (rule.children && child !== null) {
        validateShape(child, rule.children, childPath);
      }
    }
  };

  scanForbidden(record, "", 0);
  validateShape(record, PROFILE_FIELDS, "");
  return [...violations];
}

/** Throws unless `record` is entirely inside the allowed Customer 360 shape. */
export function assertCustomer360PrivacyBoundary(record: unknown): void {
  const violations = findCustomer360PrivacyViolations(record);
  if (violations.length > 0) {
    throw new Error(
      `Customer 360 privacy boundary violation on fields: ${violations.join(", ")}`,
    );
  }
}

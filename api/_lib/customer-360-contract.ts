/**
 * Executable Customer 360 privacy boundary.
 *
 * Customer 360 may contain profile/contact fields, platform and app-version
 * summaries, aggregate lifecycle timestamps, aggregate download outcomes, and
 * canonical commerce. It must NEVER contain search text, source titles, URLs,
 * raw telemetry payloads, raw IPs, raw user agents, tokens, or credentials.
 *
 * The types below describe the allowed shape; `assertCustomer360PrivacyBoundary`
 * enforces the denylist at runtime so a forbidden field cannot silently reach a
 * customer-facing surface.
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
  downloadSuccessCount: number;
  downloadFailureCount: number;
  commerce: Customer360Commerce | null;
}>;

/** Field-concept groups the boundary permits, kept for documentation and review. */
export const CUSTOMER_360_ALLOWED_FIELD_GROUPS = [
  "profile_contact",
  "platform_app_version_summary",
  "aggregate_lifecycle_timestamps",
  "aggregate_download_outcomes",
  "canonical_commerce",
] as const;
export type Customer360AllowedFieldGroup =
  (typeof CUSTOMER_360_ALLOWED_FIELD_GROUPS)[number];

/**
 * Key-name concepts that must never appear in a Customer 360 record. Compared
 * against a normalized key (lowercased, alphanumeric only) as substrings, so
 * both camelCase and snake_case spellings are caught.
 */
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
 * Standalone key names that are forbidden only as an exact match, to avoid false
 * positives on allowed fields (for example `ip` is forbidden but `recipient` is
 * not, and `url` is forbidden but `appVersionSummary` is not).
 */
export const CUSTOMER_360_FORBIDDEN_EXACT_KEYS = [
  "ip",
  "url",
  "urls",
  "href",
  "query",
  "title",
] as const;

const MAX_SCAN_DEPTH = 8;

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

/**
 * Returns the dotted paths of every forbidden key found in `record`. Empty means
 * the record is inside the privacy boundary. Bounded depth guards against hostile
 * or cyclic inputs.
 */
export function findCustomer360PrivacyViolations(record: unknown): string[] {
  const violations: string[] = [];
  const seen = new Set<object>();

  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH || value === null || typeof value !== "object") {
      return;
    }
    if (seen.has(value as object)) return;
    seen.add(value as object);

    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
      return;
    }

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (keyViolates(normalizeKey(key))) {
        violations.push(childPath);
      }
      walk(child, childPath, depth + 1);
    }
  };

  walk(record, "", 0);
  return violations;
}

/** Throws if `record` carries any forbidden field. Use before returning it. */
export function assertCustomer360PrivacyBoundary(record: unknown): void {
  const violations = findCustomer360PrivacyViolations(record);
  if (violations.length > 0) {
    throw new Error(
      `Customer 360 privacy boundary violation on fields: ${violations.join(", ")}`,
    );
  }
}

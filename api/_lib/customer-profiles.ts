/**
 * Shared Customer 360 identity contract: profile/link/install/merge row shapes
 * plus the deterministic, idempotent, cycle-safe merge primitives. These are
 * pure functions with no database or network access; the runtime steps that
 * attach identity own the transactional persistence.
 */

export const CUSTOMER_LICENSE_NAMESPACES = ["production", "test"] as const;
export type CustomerLicenseNamespace =
  (typeof CUSTOMER_LICENSE_NAMESPACES)[number];

/**
 * The only evidence types that may attach to or merge a profile. Every entry is
 * deterministic and server-verified. Heuristics (IP, user agent, display name,
 * unverified email, time proximity) are deliberately absent, as is the Gmail
 * campaign/day request HMAC, which is attribution only and never identity.
 */
export const CUSTOMER_IDENTITY_LINK_TYPES = [
  "account_identity",
  "stripe_customer",
  "stripe_checkout_session",
  "stripe_payment_intent",
  "stripe_subscription",
  "activation_record",
  "install_identity_hash",
  "support_code",
  "installer_receipt_hash",
] as const;
export type CustomerIdentityLinkType =
  (typeof CUSTOMER_IDENTITY_LINK_TYPES)[number];

/**
 * Signals that must never attach or merge a profile. Kept as an explicit,
 * testable denylist so a future change cannot quietly promote a heuristic into
 * identity evidence.
 */
export const FORBIDDEN_MERGE_SIGNALS = [
  "ip",
  "user_agent",
  "display_name",
  "unverified_email",
  "time_proximity",
  "gmail_campaign_hmac",
  "installer_request_hmac",
] as const;
export type ForbiddenMergeSignal = (typeof FORBIDDEN_MERGE_SIGNALS)[number];

export const MERGE_INITIATORS = ["system", "support", "backfill"] as const;
export type MergeInitiator = (typeof MERGE_INITIATORS)[number];

export type CustomerProfileRow = Readonly<{
  id: string;
  licenseNamespace: CustomerLicenseNamespace;
  mergedInto: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
  contactEmail: string | null;
  displayName: string | null;
  platformSummary: string | null;
  appVersionSummary: string | null;
  firstSeenAt: string | null;
  lastActivityAt: string | null;
  downloadSuccessCount: number;
  downloadFailureCount: number;
  entitlementStatus: string | null;
  commerceSyncedAt: string | null;
}>;

export type CustomerIdentityLinkRow = Readonly<{
  id: string;
  profileId: string;
  licenseNamespace: CustomerLicenseNamespace;
  linkType: CustomerIdentityLinkType;
  linkValue: string;
  createdAt: string;
}>;

export type CustomerInstallRow = Readonly<{
  id: string;
  profileId: string;
  licenseNamespace: CustomerLicenseNamespace;
  installIdHash: string;
  platform: "macos" | "windows" | "unknown" | null;
  appVersion: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}>;

export type CustomerProfileMergeRow = Readonly<{
  id: string;
  licenseNamespace: CustomerLicenseNamespace;
  sourceProfileId: string;
  targetProfileId: string;
  mergeEvidenceType: CustomerIdentityLinkType;
  mergeEvidenceValueHash: string;
  initiatedBy: MergeInitiator;
  mergedAt: string;
}>;

export function isCustomerLicenseNamespace(
  value: unknown,
): value is CustomerLicenseNamespace {
  return value === "production" || value === "test";
}

export function isCustomerIdentityLinkType(
  value: unknown,
): value is CustomerIdentityLinkType {
  return (
    typeof value === "string" &&
    (CUSTOMER_IDENTITY_LINK_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Fails closed on anything outside the deterministic allowlist, including every
 * forbidden heuristic and the Gmail campaign HMAC. Use before recording a link
 * or auditing a merge.
 */
export function assertDeterministicIdentityLinkType(
  value: unknown,
): CustomerIdentityLinkType {
  if (!isCustomerIdentityLinkType(value)) {
    throw new Error(
      `Refusing non-deterministic identity evidence: ${String(value)}`,
    );
  }
  return value;
}

/**
 * Follows merged_into tombstone pointers to the surviving root profile. Cycle
 * safe: a repeated visit throws instead of looping forever, and the traversal
 * is bounded by the number of known pointers.
 */
export function resolveProfileRoot(
  profileId: string,
  mergedInto: ReadonlyMap<string, string | null>,
): string {
  const visited = new Set<string>();
  let current = profileId;
  const maxSteps = mergedInto.size + 1;
  for (let step = 0; step <= maxSteps; step += 1) {
    if (visited.has(current)) {
      throw new Error(`Merge cycle detected at profile ${current}`);
    }
    visited.add(current);
    const next = mergedInto.get(current);
    if (next === undefined || next === null) return current;
    current = next;
  }
  throw new Error(`Merge chain exceeded bound at profile ${profileId}`);
}

export type MergeCandidate = Readonly<{
  id: string;
  licenseNamespace: CustomerLicenseNamespace;
  createdAt: string;
}>;

export type ProfileMergePlan =
  | Readonly<{ merge: false; reason: "same_profile" }>
  | Readonly<{
      merge: true;
      licenseNamespace: CustomerLicenseNamespace;
      survivorId: string;
      tombstoneId: string;
      evidenceType: CustomerIdentityLinkType;
    }>;

/**
 * Deterministically decides which of two profiles survives a merge. The oldest
 * profile (earliest createdAt, ties broken by the lexicographically smallest
 * UUID) always survives, so the plan is idempotent regardless of argument order.
 * Cross-namespace merges are refused, which keeps Production and Test isolated.
 */
export function planProfileMerge(
  left: MergeCandidate,
  right: MergeCandidate,
  evidence: { linkType: unknown },
): ProfileMergePlan {
  if (left.licenseNamespace !== right.licenseNamespace) {
    throw new Error(
      "Refusing cross-namespace profile merge; Production and Test never merge",
    );
  }
  const evidenceType = assertDeterministicIdentityLinkType(evidence.linkType);
  if (left.id === right.id) {
    return { merge: false, reason: "same_profile" };
  }

  const survivor = compareMergeOrder(left, right) <= 0 ? left : right;
  const tombstone = survivor.id === left.id ? right : left;
  return {
    merge: true,
    licenseNamespace: survivor.licenseNamespace,
    survivorId: survivor.id,
    tombstoneId: tombstone.id,
    evidenceType,
  };
}

function compareMergeOrder(left: MergeCandidate, right: MergeCandidate): number {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

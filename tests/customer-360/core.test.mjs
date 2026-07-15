import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CUSTOMER_HASH_IDENTITY_LINK_TYPES,
  CUSTOMER_IDENTITY_LINK_TYPES,
  CUSTOMER_LICENSE_NAMESPACES,
  FORBIDDEN_MERGE_SIGNALS,
  assertCustomerIdentityLinkValue,
  assertDeterministicIdentityLinkType,
  isCustomerIdentityLinkType,
  isCustomerLicenseNamespace,
  mergeCustomerProfiles,
  planProfileMerge,
  resolveProfileRoot,
} from "../../api/_lib/customer-profiles.ts";
import {
  assertCustomer360PrivacyBoundary,
  findCustomer360PrivacyViolations,
} from "../../api/_lib/customer-360-contract.ts";

const MIGRATION_URL = new URL(
  "../../db/migrations/20260715120000_add_customer_360_core.sql",
  import.meta.url,
);

async function migrationSql() {
  return readFile(MIGRATION_URL, "utf8");
}

test("only production and test namespaces exist and are recognized", () => {
  assert.deepEqual([...CUSTOMER_LICENSE_NAMESPACES], ["production", "test"]);
  assert.ok(isCustomerLicenseNamespace("production"));
  assert.ok(isCustomerLicenseNamespace("test"));
  assert.ok(!isCustomerLicenseNamespace("Production"));
  assert.ok(!isCustomerLicenseNamespace("preview"));
  assert.ok(!isCustomerLicenseNamespace(null));
});

test("identity evidence allowlist is deterministic and excludes every heuristic", () => {
  assert.deepEqual([...CUSTOMER_IDENTITY_LINK_TYPES], [
    "account_identity",
    "stripe_customer",
    "stripe_checkout_session",
    "stripe_payment_intent",
    "stripe_subscription",
    "activation_record",
    "install_identity_hash",
    "support_code",
    "installer_receipt_hash",
  ]);
  for (const forbidden of FORBIDDEN_MERGE_SIGNALS) {
    assert.ok(!isCustomerIdentityLinkType(forbidden), forbidden);
    assert.throws(() => assertDeterministicIdentityLinkType(forbidden), /non-deterministic/);
  }
  // The Gmail campaign/day request HMAC is attribution, never identity.
  assert.ok(FORBIDDEN_MERGE_SIGNALS.includes("gmail_campaign_hmac"));
  assert.throws(
    () => assertDeterministicIdentityLinkType("installer_request_hmac"),
    /non-deterministic/,
  );
  assert.equal(
    assertDeterministicIdentityLinkType("installer_receipt_hash"),
    "installer_receipt_hash",
  );
  assert.equal(typeof mergeCustomerProfiles, "function");
});

test("hash-only identity values reject raw, uppercase, and malformed identifiers", () => {
  assert.deepEqual([...CUSTOMER_HASH_IDENTITY_LINK_TYPES], [
    "install_identity_hash",
    "installer_receipt_hash",
  ]);
  for (const linkType of CUSTOMER_HASH_IDENTITY_LINK_TYPES) {
    assert.throws(
      () => assertCustomerIdentityLinkValue(linkType, "raw-device-or-receipt-id"),
      /lowercase hex64/,
    );
    assert.throws(
      () => assertCustomerIdentityLinkValue(linkType, "A".repeat(64)),
      /lowercase hex64/,
    );
    assert.equal(assertCustomerIdentityLinkValue(linkType, "a".repeat(64)), "a".repeat(64));
  }
  assert.equal(
    assertCustomerIdentityLinkValue("stripe_customer", "cus_verified"),
    "cus_verified",
  );
  assert.throws(
    () => assertCustomerIdentityLinkValue("stripe_customer", " cus_untrimmed"),
    /exact characters/,
  );
});

test("profile root resolution follows tombstones and is cycle safe", () => {
  const chain = new Map([
    ["a", "b"],
    ["b", "c"],
    ["c", null],
  ]);
  assert.equal(resolveProfileRoot("a", chain), "c");
  assert.equal(resolveProfileRoot("c", chain), "c");
  // A root with no entry resolves to itself.
  assert.equal(resolveProfileRoot("z", new Map()), "z");

  const cycle = new Map([
    ["a", "b"],
    ["b", "a"],
  ]);
  assert.throws(() => resolveProfileRoot("a", cycle), /cycle/i);
});

test("merges are deterministic, idempotent, and namespace isolated", () => {
  const older = {
    id: "11111111-1111-1111-1111-111111111111",
    licenseNamespace: "production",
    createdAt: "2026-07-01T00:00:00.000Z",
  };
  const newer = {
    id: "22222222-2222-2222-2222-222222222222",
    licenseNamespace: "production",
    createdAt: "2026-07-10T00:00:00.000Z",
  };

  const forward = planProfileMerge(older, newer, { linkType: "account_identity" });
  const reverse = planProfileMerge(newer, older, { linkType: "account_identity" });
  assert.deepEqual(forward, {
    merge: true,
    licenseNamespace: "production",
    survivorId: older.id,
    tombstoneId: newer.id,
    evidenceType: "account_identity",
  });
  // Argument order must not change the outcome.
  assert.deepEqual(reverse, forward);

  // Equal timestamps fall back to the lexicographically smallest UUID.
  const tie = planProfileMerge(
    { ...newer, createdAt: older.createdAt },
    older,
    { linkType: "stripe_customer" },
  );
  assert.equal(tie.merge, true);
  assert.equal(tie.survivorId, older.id);

  // Merging a profile with itself is a no-op.
  assert.deepEqual(planProfileMerge(older, older, { linkType: "activation_record" }), {
    merge: false,
    reason: "same_profile",
  });

  // Cross-namespace merges are refused.
  assert.throws(
    () =>
      planProfileMerge(
        older,
        { ...newer, licenseNamespace: "test" },
        { linkType: "account_identity" },
      ),
    /cross-namespace/i,
  );

  // A forbidden signal can never drive a merge.
  assert.throws(
    () => planProfileMerge(older, newer, { linkType: "user_agent" }),
    /non-deterministic/,
  );
});

test("privacy boundary accepts an allowed record and rejects forbidden fields", () => {
  const allowed = {
    id: "profile-1",
    licenseNamespace: "production",
    contactEmail: "buyer@example.com",
    displayName: "Buyer",
    platformSummary: "macos",
    appVersionSummary: "1.0.12",
    firstSeenAt: "2026-07-01T00:00:00.000Z",
    lastActivityAt: "2026-07-10T00:00:00.000Z",
    downloadSuccessCount: null,
    downloadFailureCount: null,
    commerce: { entitlementStatus: "active", commerceSyncedAt: "2026-07-10T00:00:00.000Z" },
  };
  assert.deepEqual(findCustomer360PrivacyViolations(allowed), []);
  assert.doesNotThrow(() => assertCustomer360PrivacyBoundary(allowed));

  for (const forbidden of [
    { searchText: "how to download" },
    { searchQuery: "x" },
    { sourceTitle: "Some Video" },
    { sourceUrl: "https://youtube.com/watch" },
    { url: "https://example.com" },
    { rawIp: "203.0.113.9" },
    { ipAddress: "203.0.113.9" },
    { ip: "203.0.113.9" },
    { userAgent: "Mozilla/5.0" },
    { telemetryPayload: {} },
    { accessToken: "secret" },
    { refreshToken: "secret" },
    { credential: "x" },
    { password: "x" },
    { apiKey: "x" },
  ]) {
    assert.throws(
      () => assertCustomer360PrivacyBoundary(forbidden),
      /privacy boundary violation/,
      JSON.stringify(forbidden),
    );
  }

  // Nested forbidden fields and their unknown container both fail closed.
  const nested = { commerce: { latestCharge: { userAgent: "curl" } } };
  const violations = findCustomer360PrivacyViolations(nested);
  assert.ok(violations.includes("commerce.latestCharge"));
  assert.ok(violations.includes("commerce.latestCharge.userAgent"));

  // Unknown keys are rejected even when they do not match a denylist concept.
  assert.deepEqual(findCustomer360PrivacyViolations({ arbitrarySummary: "x" }), [
    "arbitrarySummary",
  ]);

  // Allowed field names that merely resemble forbidden concepts still pass.
  assert.deepEqual(
    findCustomer360PrivacyViolations({ appVersionSummary: "1.0" }),
    [],
  );

  const genericTelemetry = {
    metadata: { payload: { event: "search", value: "raw query and source title" } },
  };
  assert.ok(findCustomer360PrivacyViolations(genericTelemetry).length > 0);
  assert.throws(
    () => assertCustomer360PrivacyBoundary(genericTelemetry),
    /privacy boundary violation/,
  );

  let deep = { rawIp: "203.0.113.9" };
  for (let index = 0; index < 12; index += 1) deep = { profile: deep };
  assert.ok(
    findCustomer360PrivacyViolations(deep).some((path) => path.includes("__maxDepth")),
  );

  const cycle = {};
  cycle.commerce = cycle;
  assert.ok(findCustomer360PrivacyViolations(cycle).some((path) => path.includes("__cycle")));
});

test("migration defines the sparse, namespace-scoped, append-only identity core", async () => {
  const sql = await migrationSql();

  for (const table of [
    "public.sidestream_customer_profiles",
    "public.sidestream_customer_identity_links",
    "public.sidestream_customer_installs",
    "public.sidestream_customer_profile_merges",
  ]) {
    assert.match(sql, new RegExp(`create table if not exists ${table.replace(".", "\\.")}`));
    assert.match(sql, new RegExp(`alter table ${table.replace(".", "\\.")} enable row level security`));
  }

  // One canonical profile UUID with a self-referential same-namespace tombstone.
  assert.match(sql, /id uuid primary key default gen_random_uuid\(\)/);
  assert.match(sql, /merged_into uuid/);
  assert.match(
    sql,
    /sidestream_customer_profiles_merge_same_namespace_fk[\s\S]*?foreign key \(merged_into, license_namespace\)[\s\S]*?references public\.sidestream_customer_profiles \(id, license_namespace\)/,
  );

  // Every table constrains the namespace to production/test only.
  assert.equal(
    (sql.match(/license_namespace in \('production', 'test'\)/g) || []).length,
    4,
  );

  // Sparse fields are nullable (no not-null on contact/commerce columns).
  assert.match(sql, /contact_email text,/);
  assert.match(sql, /entitlement_status text,/);
  assert.doesNotMatch(sql, /contact_email text not null/);
  assert.doesNotMatch(sql, /entitlement_status text not null/);
  assert.match(sql, /download_success_count bigint,/);
  assert.match(sql, /download_failure_count bigint,/);
  assert.doesNotMatch(sql, /download_(?:success|failure)_count bigint not null/);
  assert.doesNotMatch(sql, /download_(?:success|failure)_count bigint[^\n]*default 0/);

  // Deterministic evidence: a value maps to one profile per namespace, and the
  // link/merge allowlists never include a heuristic or the Gmail HMAC.
  assert.match(sql, /unique \(license_namespace, link_type, link_value\)/);
  for (const linkType of CUSTOMER_IDENTITY_LINK_TYPES) {
    assert.ok(sql.includes(`'${linkType}'`), linkType);
  }
  for (const forbidden of ["user_agent", "unverified_email", "gmail", "installer_request", "ip_address"]) {
    assert.ok(!sql.includes(`'${forbidden}'`), forbidden);
  }

  // Cross-namespace links/installs/merges are structurally impossible.
  assert.match(sql, /sidestream_customer_identity_links_profile_same_namespace_fk/);
  assert.match(sql, /sidestream_customer_installs_profile_same_namespace_fk/);
  assert.match(sql, /sidestream_customer_profile_merges_source_same_namespace_fk/);
  assert.match(sql, /sidestream_customer_profile_merges_target_same_namespace_fk/);

  // Install identity and merge evidence are stored only as lowercase hashes.
  assert.match(sql, /install_id_hash text not null[\s\S]*?~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(sql, /merge_evidence_value_hash text not null[\s\S]*?~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(
    sql,
    /link_type not in \('install_identity_hash', 'installer_receipt_hash'\)[\s\S]*?link_value ~ '\^\[0-9a-f\]\{64\}\$'/,
  );

  // The database rejects cycles and makes the audit immutable under owner writes.
  assert.match(sql, /sidestream_customer_profiles_guard_merge_cycle/);
  assert.match(sql, /Customer profile merge cycle detected/);
  assert.match(sql, /sidestream_customer_membership_require_live_profile/);
  assert.match(
    sql,
    /sidestream_customer_profile_merges_source_once_unique\s+unique \(license_namespace, source_profile_id\)/,
  );
  assert.match(sql, /sidestream_customer_profile_merges_immutable_guard/);
  assert.match(sql, /before update or delete on public\.sidestream_customer_profile_merges/);

  // Server-role-only: direct Supabase API roles are revoked.
  assert.match(sql, /revoke all on table public\.sidestream_customer_profiles from public/);
  assert.match(sql, /revoke all on table public\.%I from %I/);
  assert.match(sql, /array\[\s*'anon',\s*'authenticated'\s*\]/);
});

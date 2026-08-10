#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);

export const FRESH_PAID_OPERATION = "fresh-meta-paid-production";
export const RECOVERY_OPERATION = "prepare-fresh-meta-paid-recovery";
export const PRODUCTION_NAMESPACE = "production";
export const FIXED_QA_IDENTITY_CONFIRMATION = "alex-garrett-fixed-qa";
export const APPLY_CONFIRMATION = "DELETE-FRESH-META-PAID-ALEX-ONLY";
export const RECOVERY_CONFIRMATION = "CREATE-RECOVERABLE-NEON-CHILD";
export const TARGET_IDENTITY = Object.freeze({
  displayName: "Alex Garrett",
  emails: Object.freeze([
    "alex@alexg.mov",
    "alexg@wispr.ai",
    "alexgarrett2468@gmail.com",
  ]),
});
export const PRODUCTION_TARGET = Object.freeze({
  environment: PRODUCTION_NAMESPACE,
  neonProjectId: "dark-butterfly-59697025",
  neonDatabase: "neondb",
  neonRole: "neondb_owner",
  stripeAccountId: "acct_1Tp340DFKjeGlioX",
  stripeKeyEnvironmentVariable:
    "SIDESTREAM_RESET_PRODUCTION_STRIPE_SECRET_KEY",
});

const NEON_CLI_PACKAGE = "neonctl@2.37.1";
const DATABASE_LOCK = "sidestream:fresh-meta-paid-production:v1";
const MAX_TARGET_ROWS = 250;
const REQUIRED_TABLES = Object.freeze([
  "sidestream_accounts",
  "sidestream_account_sessions",
  "sidestream_licenses",
  "sidestream_license_tokens",
  "sidestream_activation_sessions",
  "sidestream_checkout_intents",
  "sidestream_account_devices",
  "sidestream_device_transfers",
  "sidestream_paid_acquisition_entries",
  "sidestream_paid_acquisition_checkouts",
  "sidestream_paid_acquisition_email_outbox",
  "sidestream_paid_acquisition_claims",
  "sidestream_paid_acquisition_events",
  "sidestream_acquisitions",
  "sidestream_acquisition_stages",
  "sidestream_acquisition_conflicts",
  "sidestream_paid_telemetry_profile_bindings",
  "sidestream_customer_profiles",
  "sidestream_customer_installs",
  "sidestream_customer_identity_links",
  "sidestream_customer_identity_reviews",
  "sidestream_customer_profile_merges",
  "sidestream_customer_commerce_materializations",
  "sidestream_customer_commerce_aliases",
  "sidestream_customer_commerce_invoice_payments",
  "sidestream_customer_money_totals",
  "sidestream_customer_usage_daily",
  "sidestream_customer_usage_sync_state",
  "sidestream_anonymous_acquisition_sessions",
  "sidestream_anonymous_acquisition_conflicts",
  "sidestream_stripe_events",
]);

export class ResetCliError extends Error {}

export function parseArgs(argv) {
  let operationExplicit = false;
  const options = {
    operation: FRESH_PAID_OPERATION,
    apply: false,
    help: false,
    branchName: "",
    branchId: "",
    endpointId: "",
    connectedTargetFingerprint: "",
    namespaceConfirmation: "",
    identityConfirmation: "",
    applyConfirmation: "",
    recoveryBranchId: "",
    recoveryBranchConfirmation: "",
  };
  const valueOptions = new Map([
    ["--operation", "operation"],
    ["--branch-name", "branchName"],
    ["--branch-id", "branchId"],
    ["--endpoint-id", "endpointId"],
    ["--connected-target-fingerprint", "connectedTargetFingerprint"],
    ["--confirm-namespace", "namespaceConfirmation"],
    ["--confirm-identity", "identityConfirmation"],
    ["--confirm", "applyConfirmation"],
    ["--recovery-branch-id", "recoveryBranchId"],
    ["--confirm-recovery-branch", "recoveryBranchConfirmation"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      options.apply = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const option = [...valueOptions.keys()].find((name) =>
      argument === name || argument.startsWith(`${name}=`)
    );
    if (!option) throw new ResetCliError(`Unknown argument: ${argument}`);
    const [value, nextIndex] = readOption(argv, index, option);
    options[valueOptions.get(option)] = value;
    if (option === "--operation") operationExplicit = true;
    index = nextIndex;
  }

  if (options.help) return options;
  if (![FRESH_PAID_OPERATION, RECOVERY_OPERATION].includes(options.operation)) {
    throw new ResetCliError("The reset operation is not allowlisted.");
  }
  validateExplicitTargetSelectors(options);

  if (options.operation === RECOVERY_OPERATION) {
    if (options.apply && !operationExplicit) {
      throw new ResetCliError("Recovery apply requires the exact explicit operation name.");
    }
    if (options.apply && options.applyConfirmation !== RECOVERY_CONFIRMATION) {
      throw new ResetCliError(
        `Recovery creation requires --confirm ${RECOVERY_CONFIRMATION}.`,
      );
    }
    return options;
  }

  if (options.apply) {
    if (!operationExplicit) {
      throw new ResetCliError("Apply mode requires the exact explicit operation name.");
    }
    const exact = [
      [options.namespaceConfirmation, PRODUCTION_NAMESPACE, "namespace"],
      [options.identityConfirmation, FIXED_QA_IDENTITY_CONFIRMATION, "identity"],
      [options.applyConfirmation, APPLY_CONFIRMATION, "operation"],
      [options.recoveryBranchConfirmation, options.recoveryBranchId, "recovery branch"],
    ];
    for (const [actual, expected, label] of exact) {
      if (!expected || actual !== expected) {
        throw new ResetCliError(`Apply mode requires the exact ${label} confirmation.`);
      }
    }
    if (!isSafeFingerprint(options.connectedTargetFingerprint)) {
      throw new ResetCliError(
        "Apply mode requires the exact dry-run connected target fingerprint.",
      );
    }
  }
  return options;
}

export function validateExplicitTargetSelectors(options) {
  if (!isNeonBranchId(options.branchId)) {
    throw new ResetCliError("An explicit Neon branch ID is required.");
  }
  if (!isNeonEndpointId(options.endpointId)) {
    throw new ResetCliError("An explicit direct Neon endpoint ID is required.");
  }
  if (
    typeof options.branchName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,62}$/.test(options.branchName) ||
    options.branchName.trim().toLowerCase() === "main"
  ) {
    throw new ResetCliError(
      "An explicit deployed non-main Neon branch name is required.",
    );
  }
}

export function parseNeonBranchInventory(output) {
  let parsed;
  try {
    parsed = JSON.parse(String(output || ""));
  } catch {
    throw new ResetCliError("Authenticated Neon branch metadata was not valid JSON.");
  }
  const candidates = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.branches)
      ? parsed.branches
      : Array.isArray(parsed?.data)
        ? parsed.data
        : parsed?.branch
          ? [parsed.branch]
          : parsed?.id
            ? [parsed]
            : [];
  return candidates.map((branch) => ({
    id: String(branch.id || branch.branch_id || ""),
    name: String(branch.name || branch.branch_name || ""),
    parentId: branch.parent_id || branch.parentId || null,
    state: String(branch.current_state || branch.state || ""),
    endpoints: (
      branch.endpoints || branch.compute_endpoints ||
      (branch.compute_endpoint ? [branch.compute_endpoint] : []) ||
      (branch.endpoint ? [branch.endpoint] : [])
    )
      .map((endpoint) => String(endpoint.id || endpoint.endpoint_id || endpoint))
      .filter(Boolean),
  }));
}

export function parseNeonEndpointInventory(output) {
  let parsed;
  try {
    parsed = JSON.parse(String(output || ""));
  } catch {
    throw new ResetCliError("Authenticated Neon endpoint metadata was not valid JSON.");
  }
  const candidates = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.endpoints)
      ? parsed.endpoints
      : Array.isArray(parsed?.data)
        ? parsed.data
        : [];
  return candidates.map((endpoint) => ({
    id: String(endpoint.id || endpoint.endpoint_id || ""),
    branchId: String(endpoint.branch_id || endpoint.branchId || ""),
  })).filter((endpoint) => endpoint.id && endpoint.branchId);
}

export function verifyNeonBranchMetadata(branches, selectors, {
  recoveryParentId = "",
} = {}) {
  const matches = branches.filter((branch) => branch.id === selectors.branchId);
  if (matches.length !== 1) {
    throw new ResetCliError("The explicit Neon branch ID did not resolve exactly once.");
  }
  const branch = matches[0];
  if (branch.name !== selectors.branchName || branch.name.trim().toLowerCase() === "main") {
    throw new ResetCliError("The explicit Neon branch name did not attest.");
  }
  if (!branch.endpoints.includes(selectors.endpointId)) {
    throw new ResetCliError("The explicit Neon endpoint does not belong to the branch.");
  }
  if (recoveryParentId && branch.parentId !== recoveryParentId) {
    throw new ResetCliError("The recovery branch is not a child of the deployed branch.");
  }
  if (branch.state && !["ready", "idle", "active"].includes(branch.state.toLowerCase())) {
    throw new ResetCliError("The Neon branch is not ready.");
  }
  return Object.freeze(branch);
}

export function extractNeonConnectionString(output) {
  const trimmed = String(output || "").trim();
  if (trimmed.startsWith("postgres://") || trimmed.startsWith("postgresql://")) {
    return trimmed;
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ResetCliError("Authenticated Neon did not return a connection string.");
  }
  const values = parsed && typeof parsed === "object"
    ? [parsed.connection_string, parsed.connectionString, parsed.url, ...Object.values(parsed)]
    : [parsed];
  const value = values.find((candidate) =>
    typeof candidate === "string" && /^postgres(?:ql)?:\/\//.test(candidate)
  );
  if (!value) throw new ResetCliError("Authenticated Neon did not return a connection string.");
  return value;
}

export function verifyNeonConnectionString(connectionString, target, selectors) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new ResetCliError("Neon returned an invalid connection string.");
  }
  const hostname = url.hostname.toLowerCase();
  const endpointId = hostname.split(".")[0];
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(hostname) ||
    endpointId !== selectors.endpointId
  ) {
    throw new ResetCliError("The connection is not the explicit direct Neon endpoint.");
  }
  if (
    hostname.includes("-pooler.") || hostname.includes("-pool.") ||
    url.port === "6543" || url.searchParams.has("pgbouncer") ||
    url.searchParams.has("connection_limit")
  ) {
    throw new ResetCliError("The operation refuses pooled/runtime Postgres endpoints.");
  }
  if (
    decodeURIComponent(url.username) !== target.neonRole ||
    decodeURIComponent(url.pathname.slice(1)) !== target.neonDatabase
  ) {
    throw new ResetCliError("The connected Neon role or database is unexpected.");
  }
  url.searchParams.set("sslmode", "verify-full");
  return Object.freeze({ connectionString: url.toString(), endpointId });
}

export function buildConnectedTargetFingerprint(attestation) {
  const ordered = [
    attestation.projectId,
    attestation.branchName,
    attestation.branchId,
    attestation.endpointId,
    attestation.database,
    attestation.role,
    attestation.namespace,
  ];
  if (ordered.some((value) => typeof value !== "string" || !value)) {
    throw new ResetCliError("Connected target attestation is incomplete.");
  }
  return createHash("sha256")
    .update(`sidestream-fresh-paid-target-v1\0${ordered.join("\0")}`)
    .digest("hex");
}

export async function attestConnectedTarget(client, target, selectors) {
  const result = await client.query(`
    /* fresh-paid:connected-target-attestation */
    select current_database() as database_name,
      current_user as role_name,
      count(*) filter (where license_namespace = $1)::integer as namespace_rows,
      count(*) filter (where license_namespace <> $1)::integer as other_namespace_rows
    from public.sidestream_customer_profiles
  `, [PRODUCTION_NAMESPACE]);
  const row = result.rows[0] || {};
  if (row.database_name !== target.neonDatabase || row.role_name !== target.neonRole) {
    throw new ResetCliError("Connected database attestation did not match.");
  }
  const attestation = {
    projectId: target.neonProjectId,
    branchName: selectors.branchName,
    branchId: selectors.branchId,
    endpointId: selectors.endpointId,
    database: row.database_name,
    role: row.role_name,
    namespace: PRODUCTION_NAMESPACE,
  };
  return {
    fingerprint: buildConnectedTargetFingerprint(attestation),
    namespaceRows: Number(row.namespace_rows || 0),
  };
}

export async function assertExpectedSchema(client) {
  const result = await client.query(`
    /* fresh-paid:expected-schema */
    select table_name
    from information_schema.tables
    where table_schema = 'public' and table_name = any($1::text[])
  `, [REQUIRED_TABLES]);
  const found = new Set(result.rows.map((row) => row.table_name));
  const missing = REQUIRED_TABLES.filter((table) => !found.has(table));
  if (missing.length) {
    throw new ResetCliError(
      `Production schema is missing ${missing.length} required reset tables.`,
    );
  }
}

export async function inventoryFreshPaidClosure(client, stripeCustomerIds = []) {
  await assertExpectedSchema(client);
  const emails = [...TARGET_IDENTITY.emails];
  const result = await client.query(`
    /* fresh-paid:inventory-closure */
    with recursive
    seed_accounts as (
      select id, stripe_customer_id
      from public.sidestream_accounts
      where lower(btrim(email)) = any($1::text[])
        or stripe_customer_id = any($2::text[])
    ),
    seed_customer_ids as (
      select unnest($2::text[]) as id
      union select stripe_customer_id from seed_accounts where stripe_customer_id is not null
    ),
    seed_licenses as (
      select license.* from public.sidestream_licenses license
      where license.account_id in (select id from seed_accounts)
         or license.stripe_customer_id in (select id from seed_customer_ids)
    ),
    seed_activations as (
      select activation.* from public.sidestream_activation_sessions activation
      where activation.account_id in (select id from seed_accounts)
         or activation.license_id in (select id from seed_licenses)
    ),
    seed_core as (
      select core.* from public.sidestream_checkout_intents core
      where core.account_id in (select id from seed_accounts)
         or core.activation_session_id in (select id from seed_activations)
         or core.stripe_customer_id in (select id from seed_customer_ids)
         or core.stripe_checkout_session_id in (
           select stripe_checkout_session_id from seed_licenses
           where stripe_checkout_session_id is not null
         )
    ),
    seed_paid as (
      select distinct paid.*
      from public.sidestream_paid_acquisition_checkouts paid
      left join public.sidestream_paid_acquisition_claims claim
        on claim.checkout_id = paid.id
      where paid.environment = 'production'
        and (
          paid.checkout_intent_ref in (select id from seed_core)
          or claim.account_ref in (select id from seed_accounts)
          or claim.entitlement_ref in (select id from seed_licenses)
          or lower(btrim(coalesce(claim.google_email_normalized, ''))) = any($1::text[])
          or lower(btrim(coalesce(paid.checkout_email_normalized, ''))) = any($1::text[])
        )
    ),
    seed_claims as (
      select claim.* from public.sidestream_paid_acquisition_claims claim
      where claim.checkout_id in (select id from seed_paid)
    ),
    seed_bindings as (
      select binding.* from public.sidestream_paid_telemetry_profile_bindings binding
      where binding.license_namespace = 'production' and (
        binding.claim_id in (select id from seed_claims)
        or binding.checkout_id in (select id from seed_paid)
        or binding.account_id in (select id from seed_accounts)
        or binding.entitlement_id in (select id from seed_licenses)
        or binding.activation_ref in (select id from seed_activations)
      )
    ),
    seed_profiles as (
      select profile_id_at_binding as id from seed_bindings
      union select profile_id from public.sidestream_customer_identity_links
        where license_namespace = 'production' and (
          (link_type = 'account_identity' and link_value in (
            select id::text from seed_accounts
          )) or (link_type = 'stripe_customer' and link_value in (
            select id from seed_customer_ids
          )) or (link_type = 'activation_record' and link_value in (
            select id::text from seed_activations
          ))
        )
      union select id from public.sidestream_customer_profiles
        where license_namespace = 'production' and (
          lower(btrim(coalesce(contact_email, ''))) = any($1::text[])
        )
    ),
    profile_closure(id) as (
      select id from seed_profiles
      union
      select case
        when profile.id = closure.id then profile.merged_into
        else profile.id
      end
      from profile_closure closure
      join public.sidestream_customer_profiles profile
        on profile.license_namespace = 'production'
       and (
         (profile.id = closure.id and profile.merged_into is not null)
         or profile.merged_into = closure.id
       )
    ),
    profile_identity_links as (
      select link.* from public.sidestream_customer_identity_links link
      where link.license_namespace = 'production'
        and link.profile_id in (select id from profile_closure)
    ),
    profile_customer_ids as (
      select link_value as id from profile_identity_links
      where link_type = 'stripe_customer'
    ),
    profile_activation_ids as (
      select link_value::uuid as id from profile_identity_links
      where link_type = 'activation_record'
        and link_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
    target_accounts as (
      select id, stripe_customer_id
      from public.sidestream_accounts
      where lower(btrim(email)) = any($1::text[])
         or stripe_customer_id in (
           select id from seed_customer_ids
           union select id from profile_customer_ids
         )
    ),
    customer_ids as (
      select id from seed_customer_ids
      union select id from profile_customer_ids
      union select stripe_customer_id from target_accounts where stripe_customer_id is not null
    ),
    target_licenses as (
      select license.* from public.sidestream_licenses license
      where license.account_id in (select id from target_accounts)
         or license.stripe_customer_id in (select id from customer_ids)
    ),
    target_activations as (
      select activation.* from public.sidestream_activation_sessions activation
      where activation.account_id in (select id from target_accounts)
         or activation.license_id in (select id from target_licenses)
         or activation.id in (select id from profile_activation_ids)
    ),
    root_core as (
      select core.* from public.sidestream_checkout_intents core
      where core.account_id in (select id from target_accounts)
         or core.activation_session_id in (select id from target_activations)
         or core.stripe_customer_id in (select id from customer_ids)
         or core.stripe_checkout_session_id in (
           select stripe_checkout_session_id from target_licenses
           where stripe_checkout_session_id is not null
         )
         or core.id in (select checkout_intent_ref from seed_paid)
    ),
    root_acquisition_ids as (
      select acquisition_id as id from root_core where acquisition_id is not null
    ),
    expanded_core as (
      select * from root_core
      union
      select core.* from public.sidestream_checkout_intents core
      where core.acquisition_id in (select id from root_acquisition_ids)
    ),
    target_acquisitions as (
      select acquisition.* from public.sidestream_acquisitions acquisition
      where acquisition.id in (select id from root_acquisition_ids)
    ),
    target_paid as (
      select distinct paid.*
      from public.sidestream_paid_acquisition_checkouts paid
      left join public.sidestream_paid_acquisition_claims claim
        on claim.checkout_id = paid.id
      where paid.environment = 'production'
        and (
          paid.checkout_intent_ref in (select id from expanded_core)
          or claim.account_ref in (select id from target_accounts)
          or claim.entitlement_ref in (select id from target_licenses)
          or lower(btrim(coalesce(claim.google_email_normalized, ''))) = any($1::text[])
          or lower(btrim(coalesce(paid.checkout_email_normalized, ''))) = any($1::text[])
        )
    ),
    target_claims as (
      select claim.* from public.sidestream_paid_acquisition_claims claim
      where claim.checkout_id in (select id from target_paid)
    ),
    target_bindings as (
      select binding.* from public.sidestream_paid_telemetry_profile_bindings binding
      where binding.license_namespace = 'production' and (
        binding.claim_id in (select id from target_claims)
        or binding.checkout_id in (select id from target_paid)
        or binding.acquisition_id in (select id from target_acquisitions)
        or binding.account_id in (select id from target_accounts)
        or binding.entitlement_id in (select id from target_licenses)
        or binding.activation_ref in (select id from target_activations)
      )
    ),
    target_installs as (
      select install.* from public.sidestream_customer_installs install
      where install.license_namespace = 'production'
        and install.profile_id in (select id from profile_closure)
    ),
    target_commerce as (
      select materialization.*
      from public.sidestream_customer_commerce_materializations materialization
      where materialization.license_namespace = 'production'
        and materialization.profile_id in (select id from profile_closure)
    )
    select jsonb_build_object(
      'accountIds', coalesce((select jsonb_agg(id order by id) from target_accounts), '[]'),
      'customerIds', coalesce((select jsonb_agg(id order by id) from customer_ids), '[]'),
      'checkoutSessionRefs', coalesce((select jsonb_agg(value order by value) from (select stripe_checkout_session_id as value from expanded_core where stripe_checkout_session_id is not null union select verified_checkout_session_ref from target_paid where verified_checkout_session_ref is not null union select stripe_checkout_session_id from target_licenses where stripe_checkout_session_id is not null) refs), '[]'),
      'paymentRefs', coalesce((select jsonb_agg(value order by value) from (select canonical_payment_ref as value from target_paid where canonical_payment_ref is not null union select stripe_payment_intent_id from target_licenses where stripe_payment_intent_id is not null) refs), '[]'),
      'subscriptionRefs', coalesce((select jsonb_agg(stripe_subscription_id order by stripe_subscription_id) from target_licenses where stripe_subscription_id is not null), '[]'),
      'licenseIds', coalesce((select jsonb_agg(id order by id) from target_licenses), '[]'),
      'activationIds', coalesce((select jsonb_agg(id order by id) from target_activations), '[]'),
      'checkoutIntentIds', coalesce((select jsonb_agg(id order by id) from expanded_core), '[]'),
      'paidCheckoutIds', coalesce((select jsonb_agg(id order by id) from target_paid), '[]'),
      'paidEntryIds', coalesce((select jsonb_agg(entry_id order by entry_id) from target_paid), '[]'),
      'paidClaimIds', coalesce((select jsonb_agg(id order by id) from target_claims), '[]'),
      'paidOutboxIds', coalesce((select jsonb_agg(id order by id) from public.sidestream_paid_acquisition_email_outbox where checkout_id in (select id from target_paid)), '[]'),
      'acquisitionIds', coalesce((select jsonb_agg(id order by id) from target_acquisitions), '[]'),
      'stageIds', coalesce((select jsonb_agg(id order by id) from public.sidestream_acquisition_stages where acquisition_id in (select id from target_acquisitions)), '[]'),
      'acquisitionConflictIds', coalesce((select jsonb_agg(id order by id) from public.sidestream_acquisition_conflicts where acquisition_id in (select id from target_acquisitions)), '[]'),
      'bindingIds', coalesce((select jsonb_agg(id order by id) from target_bindings), '[]'),
      'profileIds', coalesce((select jsonb_agg(id order by id) from profile_closure), '[]'),
      'installIds', coalesce((select jsonb_agg(id order by id) from target_installs), '[]'),
      'installHashes', coalesce((select jsonb_agg(install_id_hash order by install_id_hash) from target_installs), '[]'),
      'identityLinkIds', coalesce((select jsonb_agg(id order by id) from profile_identity_links), '[]'),
      'identityReviewIds', coalesce((select jsonb_agg(id order by id) from public.sidestream_customer_identity_reviews where license_namespace = 'production' and (candidate_profile_id in (select id from profile_closure) or existing_profile_id in (select id from profile_closure))), '[]'),
      'profileMergeIds', coalesce((select jsonb_agg(id order by id) from public.sidestream_customer_profile_merges where license_namespace = 'production' and (source_profile_id in (select id from profile_closure) or target_profile_id in (select id from profile_closure))), '[]'),
      'commerceMaterializationIds', coalesce((select jsonb_agg(id order by id) from target_commerce), '[]'),
      'commercePaymentKeys', coalesce((select jsonb_agg(distinct payment_key order by payment_key) from target_commerce), '[]'),
      'commerceInvoicePaymentIds', coalesce((select jsonb_agg(invoice_payment_id order by invoice_payment_id) from public.sidestream_customer_commerce_invoice_payments where license_namespace = 'production' and (instrument_id in (select source_object_id from target_commerce) or invoice_id in (select source_object_id from target_commerce))), '[]'),
      'moneyProfileIds', coalesce((select jsonb_agg(distinct profile_id order by profile_id) from public.sidestream_customer_money_totals where license_namespace = 'production' and profile_id in (select id from profile_closure)), '[]'),
      'anonymousSessionIds', coalesce((select jsonb_agg(id order by id) from public.sidestream_anonymous_acquisition_sessions where license_namespace = 'production' and claimed_profile_id in (select id from profile_closure)), '[]'),
      'tokenIds', coalesce((select jsonb_agg(id order by id) from public.sidestream_license_tokens where account_id in (select id from target_accounts) or license_id in (select id from target_licenses) or activation_session_id in (select id from target_activations)), '[]'),
      'deviceIds', coalesce((select jsonb_agg(id order by id) from public.sidestream_account_devices where account_id in (select id from target_accounts)), '[]'),
      'transferIds', coalesce((select jsonb_agg(id order by id) from public.sidestream_device_transfers where account_id in (select id from target_accounts)), '[]')
    ) as closure
  `, [emails, uniqueStrings(stripeCustomerIds)]);
  const closure = normalizeClosure(result.rows[0]?.closure || {});
  enforceClosureLimits(closure);
  await assertClosureDoesNotCrossCustomers(client, closure);
  return closure;
}

export async function assertClosureDoesNotCrossCustomers(client, closure) {
  const result = await client.query(`
    /* fresh-paid:ownership-boundary */
    select
      (select count(*) from public.sidestream_customer_identity_links link
       where link.license_namespace = 'production'
         and link.profile_id = any($1::uuid[])
         and ((link.link_type = 'account_identity' and not (link.link_value = any($2::text[])))
           or (link.link_type = 'stripe_customer' and not (link.link_value = any($3::text[])))
           or (link.link_type = 'stripe_checkout_session' and not (link.link_value = any($9::text[])))
           or (link.link_type = 'stripe_payment_intent' and not (link.link_value = any($10::text[])))
           or (link.link_type = 'stripe_subscription' and not (link.link_value = any($11::text[])))
           or (link.link_type = 'activation_record' and not (link.link_value = any($12::text[])))))::integer as foreign_identity_links,
      (select count(*) from public.sidestream_paid_telemetry_profile_bindings binding
       where binding.license_namespace = 'production'
         and binding.profile_id_at_binding = any($1::uuid[])
         and not (binding.id = any($4::uuid[])))::integer as foreign_bindings,
      (select count(*) from public.sidestream_paid_telemetry_profile_bindings binding
       where binding.id = any($4::uuid[])
         and (not (binding.profile_id_at_binding = any($1::uuid[]))
           or binding.acquisition_id is null
           or not (binding.acquisition_id = any($5::uuid[]))))::integer as foreign_binding_owners,
      (select count(*) from public.sidestream_accounts account
       where account.id = any($2::uuid[])
         and not (lower(btrim(account.email)) = any($13::text[])))::integer as foreign_live_accounts,
      (select count(*) from public.sidestream_licenses license
       where license.id = any($14::uuid[])
         and not (license.account_id = any($2::uuid[])))::integer as foreign_license_accounts,
      (select count(*) from public.sidestream_activation_sessions activation
       where activation.id = any($12::uuid[])
         and ((activation.account_id is not null and not (activation.account_id = any($2::uuid[])))
           or (activation.license_id is not null and not (activation.license_id = any($14::uuid[])))))::integer as foreign_activation_owners,
      (select count(*) from public.sidestream_checkout_intents core
       where core.id = any($6::uuid[])
         and ((core.account_id is not null and not (core.account_id = any($2::uuid[])))
           or (core.activation_session_id is not null and not (core.activation_session_id = any($12::uuid[])))
           or (core.stripe_customer_id is not null and not (core.stripe_customer_id = any($3::text[])))))::integer as foreign_checkout_owners,
      (select count(*) from public.sidestream_checkout_intents core
       where core.acquisition_id = any($5::uuid[])
         and not (core.id = any($6::uuid[])))::integer as foreign_checkout_intents,
      (select count(*) from public.sidestream_paid_acquisition_checkouts paid
       where paid.entry_id = any($7::uuid[])
         and not (paid.id = any($8::uuid[])))::integer as foreign_paid_checkouts
  `, [
    closure.profileIds,
    closure.accountIds.map(String),
    closure.customerIds,
    closure.bindingIds,
    closure.acquisitionIds,
    closure.checkoutIntentIds,
    closure.paidEntryIds,
    closure.paidCheckoutIds,
    closure.checkoutSessionRefs,
    closure.paymentRefs,
    closure.subscriptionRefs,
    closure.activationIds.map(String),
    [...TARGET_IDENTITY.emails],
    closure.licenseIds,
  ]);
  const crossings = Object.values(result.rows[0] || {}).reduce(
    (sum, value) => sum + Number(value || 0),
    0,
  );
  if (crossings !== 0) {
    throw new ResetCliError(
      "Fresh-paid ownership is ambiguous or crosses an unrelated live customer.",
    );
  }
}

export async function capturePreservationInvariants(client, closure) {
  const result = await client.query(`
    /* fresh-paid:preservation-invariants */
    select
      (select count(*)::integer from public.sidestream_customer_profiles
       where license_namespace = 'production' and not (id = any($1::uuid[]))) as unrelated_profiles,
      (select md5(coalesce(string_agg(id::text, ',' order by id), ''))
       from public.sidestream_customer_profiles
       where license_namespace = 'production' and not (id = any($1::uuid[]))) as unrelated_profiles_fingerprint,
      (select count(*)::integer from public.sidestream_accounts
       where not (id = any($2::uuid[]))) as unrelated_accounts,
      (select md5(coalesce(string_agg(id::text, ',' order by id), ''))
       from public.sidestream_accounts where not (id = any($2::uuid[]))) as unrelated_accounts_fingerprint,
      (select count(*)::integer from public.sidestream_stripe_events) as stripe_event_history,
      (select md5(coalesce(string_agg(event_id, ',' order by event_id), ''))
       from public.sidestream_stripe_events) as stripe_event_history_fingerprint,
      (select count(*)::integer from public.sidestream_paid_acquisition_events) as paid_acquisition_event_history,
      (select md5(coalesce(string_agg(row_to_json(event)::text, ',' order by event.event_id), ''))
       from public.sidestream_paid_acquisition_events event) as paid_acquisition_event_history_fingerprint,
      (select count(*)::integer from public.sidestream_customer_usage_sync_state) as global_usage_sync_rows,
      (select md5(coalesce(string_agg(license_namespace || ':' || committed_batch_count::text, ',' order by license_namespace), ''))
       from public.sidestream_customer_usage_sync_state) as global_usage_sync_fingerprint,
      (select count(*)::integer from public.sidestream_installer_requests) as installer_analytics_rows,
      (select count(*)::integer from public.sidestream_download_leads) as download_analytics_rows
  `, [closure.profileIds, closure.accountIds]);
  return Object.freeze({ ...result.rows[0] });
}

export async function applyFreshPaidDatabaseReset(pool, closure) {
  const client = await pool.connect();
  try {
    await client.query("begin transaction isolation level serializable read write");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [DATABASE_LOCK]);
    const locked = await inventoryFreshPaidClosure(client, closure.customerIds);
    if (closureFingerprint(locked) !== closureFingerprint(closure)) {
      throw new ResetCliError("Fresh-paid target closure changed after dry-run inventory.");
    }
    const before = await capturePreservationInvariants(client, locked);
    const deleted = {};

    await setImmutableAuditTriggers(client, false);
    deleted.bindings = await deleteIds(client, "sidestream_paid_telemetry_profile_bindings", "id", locked.bindingIds, "uuid");
    deleted.usage = await deleteIds(client, "sidestream_customer_usage_daily", "install_id_hash", locked.installHashes, "text");
    deleted.identityReviews = await deleteIds(client, "sidestream_customer_identity_reviews", "id", locked.identityReviewIds, "uuid");
    deleted.profileMerges = await deleteIds(client, "sidestream_customer_profile_merges", "id", locked.profileMergeIds, "uuid");
    deleted.moneyTotals = await deleteIds(client, "sidestream_customer_money_totals", "profile_id", locked.profileIds, "uuid");
    deleted.commerceAliases = await deleteIds(client, "sidestream_customer_commerce_aliases", "payment_key", locked.commercePaymentKeys, "text");
    deleted.commerceInvoicePayments = await deleteIds(client, "sidestream_customer_commerce_invoice_payments", "invoice_payment_id", locked.commerceInvoicePaymentIds, "text");
    deleted.commerceMaterializations = await deleteIds(client, "sidestream_customer_commerce_materializations", "id", locked.commerceMaterializationIds, "uuid");
    deleted.anonymousConflicts = await deleteByParent(client, "sidestream_anonymous_acquisition_conflicts", "session_id", locked.anonymousSessionIds);
    deleted.anonymousSessions = await deleteIds(client, "sidestream_anonymous_acquisition_sessions", "id", locked.anonymousSessionIds, "uuid");
    deleted.identityLinks = await deleteIds(client, "sidestream_customer_identity_links", "id", locked.identityLinkIds, "uuid");
    deleted.installs = await deleteIds(client, "sidestream_customer_installs", "id", locked.installIds, "uuid");
    deleted.acquisitionStages = await deleteIds(client, "sidestream_acquisition_stages", "id", locked.stageIds, "uuid");
    deleted.acquisitionConflicts = await deleteIds(client, "sidestream_acquisition_conflicts", "id", locked.acquisitionConflictIds, "uuid");
    deleted.paidOutbox = await deleteIds(client, "sidestream_paid_acquisition_email_outbox", "id", locked.paidOutboxIds, "uuid");
    deleted.paidClaims = await deleteIds(client, "sidestream_paid_acquisition_claims", "id", locked.paidClaimIds, "uuid");
    deleted.paidCheckouts = await deleteIds(client, "sidestream_paid_acquisition_checkouts", "id", locked.paidCheckoutIds, "uuid");
    deleted.paidEntries = await deleteIds(client, "sidestream_paid_acquisition_entries", "id", locked.paidEntryIds, "uuid");
    deleted.transfers = await deleteIds(client, "sidestream_device_transfers", "id", locked.transferIds, "uuid");
    deleted.tokens = await deleteIds(client, "sidestream_license_tokens", "id", locked.tokenIds, "uuid");
    deleted.devices = await deleteIds(client, "sidestream_account_devices", "id", locked.deviceIds, "uuid");
    deleted.checkoutIntents = await deleteIds(client, "sidestream_checkout_intents", "id", locked.checkoutIntentIds, "uuid");
    deleted.activations = await deleteIds(client, "sidestream_activation_sessions", "id", locked.activationIds, "uuid");
    deleted.licenses = await deleteIds(client, "sidestream_licenses", "id", locked.licenseIds, "uuid");
    deleted.accountSessions = await deleteIds(client, "sidestream_account_sessions", "account_id", locked.accountIds, "uuid");
    deleted.accounts = await deleteIds(client, "sidestream_accounts", "id", locked.accountIds, "uuid");
    deleted.profiles = await deleteIds(client, "sidestream_customer_profiles", "id", locked.profileIds, "uuid");
    deleted.acquisitions = await deleteIds(client, "sidestream_acquisitions", "id", locked.acquisitionIds, "uuid");
    await setImmutableAuditTriggers(client, true);

    const after = await capturePreservationInvariants(client, emptyLike(locked));
    if (!invariantsEqual(before, after)) {
      throw new ResetCliError("A preservation invariant changed; reset rolled back.");
    }
    await client.query("commit");
    return { deleted, before, after };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export function buildResetReport({
  mode,
  targetFingerprint,
  closure,
  deleted = null,
  clean = null,
  financialInvariant = null,
}) {
  return {
    operation: FRESH_PAID_OPERATION,
    mode,
    namespace: PRODUCTION_NAMESPACE,
    connectedTargetFingerprint: targetFingerprint,
    fixedQaIdentityFingerprint: safeFingerprint(
      [TARGET_IDENTITY.displayName, ...TARGET_IDENTITY.emails].join("\0"),
    ),
    targetStateFingerprint: closureFingerprint(closure),
    counts: closureCounts(closure),
    financialInvariant,
    deletedCounts: deleted,
    clean,
    preserved: {
      unrelatedCustomers: true,
      globalUsageSync: true,
      downloadAndReferralAnalytics: true,
      rawTelemetry: true,
      anonymousPaidAcquisitionEvents: true,
      stripeFinancialAndEventHistory: true,
    },
  };
}

export function closureCounts(closure) {
  return Object.fromEntries(
    Object.entries(closure).map(([key, value]) => [key, value.length]),
  );
}

export function closureFingerprint(closure) {
  const canonical = Object.keys(closure).sort().map((key) =>
    `${key}:${[...closure[key]].sort().join(",")}`
  ).join("\n");
  return safeFingerprint(canonical);
}

export function allCountsZero(counts) {
  return Object.values(counts).every((count) => Number(count) === 0);
}

export function validateStripeKey(key) {
  if (typeof key !== "string" || !key.trim().startsWith("sk_live_")) {
    throw new ResetCliError("The Production reset requires an explicit live Stripe secret key.");
  }
  return key.trim();
}

export async function listMatchingStripeCustomers(stripe) {
  const matches = [];
  let startingAfter;
  do {
    const page = await stripe.customers.list({
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const customer of page.data || []) {
      if (!customer?.deleted && matchesTargetIdentity(customer)) matches.push(customer);
    }
    if (!page.has_more) break;
    const last = page.data?.at(-1);
    if (!last?.id) throw new ResetCliError("Stripe pagination did not advance.");
    startingAfter = last.id;
  } while (true);
  if (matches.length > 25) throw new ResetCliError("Too many Stripe Customer matches.");
  return matches;
}

export function matchesTargetIdentity(customer) {
  const email = normalizeIdentityValue(customer?.email);
  return TARGET_IDENTITY.emails.includes(email);
}

export async function deleteMatchingStripeCustomerObjects(stripe, customers, allowedIds) {
  let deleted = 0;
  for (const customer of customers) {
    if (!allowedIds.has(customer.id)) {
      throw new ResetCliError("A Stripe Customer escaped the fixed QA identity boundary.");
    }
    const result = await stripe.customers.del(customer.id);
    if (result?.id !== customer.id || result?.deleted !== true) {
      throw new ResetCliError("Stripe did not confirm Customer identity deletion.");
    }
    deleted += 1;
  }
  return deleted;
}

export async function loadClosureStripeCustomers(stripe, customerIds, known = []) {
  const byId = new Map(known.map((customer) => [customer.id, customer]));
  for (const customerId of customerIds) {
    if (byId.has(customerId)) continue;
    const customer = await stripe.customers.retrieve(customerId);
    if (!customer?.deleted && customer?.id === customerId) byId.set(customerId, customer);
  }
  const live = [...byId.values()].filter((customer) => customerIds.includes(customer.id));
  if (live.some((customer) => !matchesTargetIdentity(customer))) {
    throw new ResetCliError(
      "A profile-owned live Stripe Customer is outside the fixed QA identity boundary.",
    );
  }
  return live;
}

export async function captureStripeFinancialInvariants(stripe, customerIds) {
  const objects = [];
  for (const customer of customerIds) {
    for (const [type, service] of [
      ["invoice", stripe.invoices],
      ["payment_intent", stripe.paymentIntents],
      ["charge", stripe.charges],
    ]) {
      if (!service?.list) continue;
      for (const object of await listAllStripe(service, { customer })) {
        objects.push(financialObjectSnapshot(type, object));
        if (type === "charge") {
          if (stripe.refunds?.list) {
            for (const refund of await listAllStripe(stripe.refunds, { charge: object.id })) {
              objects.push(financialObjectSnapshot("refund", refund));
            }
          }
          if (stripe.disputes?.list) {
            for (const dispute of await listAllStripe(stripe.disputes, { charge: object.id })) {
              objects.push(financialObjectSnapshot("dispute", dispute));
            }
          }
        }
      }
    }
  }
  const unique = [...new Map(objects.map((object) => [`${object.type}:${object.id}`, object])).values()]
    .sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`));
  return {
    privateObjects: unique,
    report: {
      counts: Object.fromEntries(["invoice", "payment_intent", "charge", "refund", "dispute"]
        .map((type) => [type, unique.filter((object) => object.type === type).length])),
      fingerprint: safeFingerprint(JSON.stringify(unique)),
    },
  };
}

export async function verifyStripeFinancialInvariants(stripe, invariant) {
  const services = {
    invoice: stripe.invoices,
    payment_intent: stripe.paymentIntents,
    charge: stripe.charges,
    refund: stripe.refunds,
    dispute: stripe.disputes,
  };
  const after = [];
  for (const expected of invariant.privateObjects) {
    const service = services[expected.type];
    if (!service?.retrieve) {
      throw new ResetCliError("Stripe financial verification service is unavailable.");
    }
    const current = financialObjectSnapshot(
      expected.type,
      await service.retrieve(expected.id),
    );
    after.push(current);
  }
  after.sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`));
  if (safeFingerprint(JSON.stringify(after)) !== invariant.report.fingerprint) {
    throw new ResetCliError("Stripe financial preservation invariant changed.");
  }
  return invariant.report;
}

export async function verifyRecoveryBranch(branches, options) {
  if (!isNeonBranchId(options.recoveryBranchId)) {
    throw new ResetCliError("Apply requires a verified recovery branch ID.");
  }
  const matches = branches.filter((branch) => branch.id === options.recoveryBranchId);
  if (matches.length !== 1 || matches[0].parentId !== options.branchId) {
    throw new ResetCliError("Recovery branch verification failed.");
  }
  if (matches[0].state && !["ready", "idle", "active"].includes(matches[0].state.toLowerCase())) {
    throw new ResetCliError("Recovery branch is not ready.");
  }
  return safeFingerprint([
    PRODUCTION_TARGET.neonProjectId,
    matches[0].id,
    matches[0].parentId,
    matches[0].name,
  ].join("\0"));
}

async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArgs(argv);
  if (options.help) return printHelp();
  const branches = await loadNeonBranches(PRODUCTION_TARGET.neonProjectId, environment);
  verifyNeonBranchMetadata(branches, options);

  if (options.operation === RECOVERY_OPERATION) {
    if (!options.apply) {
      console.log(JSON.stringify({
        operation: RECOVERY_OPERATION,
        mode: "dry-run",
        parentTargetFingerprint: safeFingerprint([
          PRODUCTION_TARGET.neonProjectId,
          options.branchId,
          options.endpointId,
        ].join("\0")),
        wouldCreateChildBranch: true,
      }, null, 2));
      return;
    }
    const recovery = await createRecoveryBranch(options, environment);
    console.log(JSON.stringify({
      operation: RECOVERY_OPERATION,
      mode: "apply",
      recoveryBranchFingerprint: safeFingerprint([
        PRODUCTION_TARGET.neonProjectId,
        recovery.id,
        recovery.parentId,
        recovery.name,
      ].join("\0")),
      verified: recovery.parentId === options.branchId,
    }, null, 2));
    return;
  }

  if (options.apply) await verifyRecoveryBranch(branches, options);
  const database = await resolveNeonDatabase(options, environment);
  const [{ Pool }, { default: Stripe }] = await Promise.all([
    import("pg"),
    import("stripe"),
  ]);
  const pool = new Pool({
    connectionString: database.connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    query_timeout: 30_000,
  });
  const stripe = new Stripe(validateStripeKey(
    environment[PRODUCTION_TARGET.stripeKeyEnvironmentVariable],
  ), { apiVersion: Stripe.API_VERSION, maxNetworkRetries: 2, timeout: 20_000 });
  try {
    const attestation = await attestConnectedTarget(pool, PRODUCTION_TARGET, options);
    if (options.apply && options.connectedTargetFingerprint !== attestation.fingerprint) {
      throw new ResetCliError("Connected target fingerprint does not match the dry-run.");
    }
    const account = await stripe.accounts.retrieve();
    if (account?.id !== PRODUCTION_TARGET.stripeAccountId || account?.charges_enabled !== true) {
      throw new ResetCliError("Production Stripe account attestation failed.");
    }
    let customers = await listMatchingStripeCustomers(stripe);
    const closure = await withReadOnlyTransaction(pool, (client) =>
      inventoryFreshPaidClosure(client, customers.map((customer) => customer.id))
    );
    customers = await loadClosureStripeCustomers(stripe, closure.customerIds, customers);
    const stripeFinancial = await captureStripeFinancialInvariants(
      stripe,
      closure.customerIds,
    );
    if (!options.apply) {
      console.log(JSON.stringify(buildResetReport({
        mode: "dry-run",
        targetFingerprint: attestation.fingerprint,
        closure,
        financialInvariant: stripeFinancial.report,
      }), null, 2));
      return;
    }

    const result = await applyFreshPaidDatabaseReset(pool, closure);
    const allowedCustomers = new Set(closure.customerIds);
    const deletedStripeCustomers = await deleteMatchingStripeCustomerObjects(
      stripe,
      customers,
      allowedCustomers,
    );
    await verifyStripeFinancialInvariants(stripe, stripeFinancial);
    const [remaining, remainingStripeCustomers] = await Promise.all([
      withReadOnlyTransaction(pool, (client) => inventoryFreshPaidClosure(client, [])),
      listMatchingStripeCustomers(stripe),
    ]);
    const clean = allCountsZero(closureCounts(remaining)) &&
      remainingStripeCustomers.length === 0;
    console.log(JSON.stringify(buildResetReport({
      mode: "apply",
      targetFingerprint: attestation.fingerprint,
      closure: remaining,
      deleted: { ...result.deleted, stripeCustomers: deletedStripeCustomers },
      clean,
      financialInvariant: stripeFinancial.report,
    }), null, 2));
    if (!clean) throw new ResetCliError("Second-run verification found target state.");
  } finally {
    await pool.end();
  }
}

export async function loadNeonBranches(projectId, environment) {
  const branchResult = await runNeon([
    "branches", "list", "--project-id", projectId, "--output", "json", "--no-color",
  ], environment, "Could not read authenticated Neon branch metadata.");
  const endpointResult = await runNeon([
    "api", `/projects/${projectId}/endpoints`,
  ], environment, "Could not read authenticated Neon endpoint metadata.");
  const endpoints = parseNeonEndpointInventory(endpointResult.stdout);
  return parseNeonBranchInventory(branchResult.stdout).map((branch) => ({
    ...branch,
    endpoints: uniqueStrings([
      ...branch.endpoints,
      ...endpoints.filter((endpoint) => endpoint.branchId === branch.id)
        .map((endpoint) => endpoint.id),
    ]),
  }));
}

export async function resolveNeonDatabase(options, environment) {
  const { stdout } = await runNeon([
    "connection-string",
    options.branchId,
    "--project-id", PRODUCTION_TARGET.neonProjectId,
    "--role-name", PRODUCTION_TARGET.neonRole,
    "--database-name", PRODUCTION_TARGET.neonDatabase,
    "--output", "json",
    "--no-color",
  ], environment, "Could not resolve the explicit deployed Neon branch.");
  return verifyNeonConnectionString(
    extractNeonConnectionString(stdout),
    PRODUCTION_TARGET,
    options,
  );
}

async function createRecoveryBranch(options, environment) {
  const name = `fresh-meta-paid-recovery-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
  const { stdout } = await runNeon([
    "branches", "create",
    "--project-id", PRODUCTION_TARGET.neonProjectId,
    "--parent", options.branchId,
    "--name", name,
    "--output", "json",
    "--no-color",
  ], environment, "Could not create the recoverable Neon child branch.");
  const branches = parseNeonBranchInventory(stdout);
  const branch = branches[0];
  if (!branch || branch.parentId !== options.branchId || branch.name !== name) {
    throw new ResetCliError("Created recovery branch did not attest as the exact child.");
  }
  return branch;
}

async function runNeon(args, environment, message) {
  try {
    return await execFile("npx", ["--yes", NEON_CLI_PACKAGE, ...args], {
      encoding: "utf8",
      env: buildNeonCliEnvironment(environment),
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
  } catch {
    throw new ResetCliError(message);
  }
}

export function buildNeonCliEnvironment(environment = process.env) {
  const sanitized = { ...environment };
  delete sanitized[PRODUCTION_TARGET.stripeKeyEnvironmentVariable];
  delete sanitized.SIDESTREAM_TELEMETRY_POSTGRES_URL;
  delete sanitized.SIDESTREAM_FRESH_PAID_TELEMETRY_POSTGRES_URL;
  return sanitized;
}

export async function withReadOnlyTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    const value = await callback(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function setImmutableAuditTriggers(client, enabled) {
  const action = enabled ? "enable" : "disable";
  for (const table of [
    "sidestream_customer_identity_reviews",
    "sidestream_customer_profile_merges",
    "sidestream_acquisition_stages",
    "sidestream_acquisition_conflicts",
  ]) {
    await client.query(`alter table public.${table} ${action} trigger user`);
  }
}

async function deleteIds(client, table, column, ids, cast) {
  if (!ids.length) return 0;
  const result = await client.query(
    `delete from public.${table} where ${column} = any($1::${cast}[])`,
    [ids],
  );
  return result.rowCount || 0;
}

async function deleteByParent(client, table, column, ids) {
  return deleteIds(client, table, column, ids, "uuid");
}

function normalizeClosure(value) {
  const keys = [
    "accountIds", "customerIds", "checkoutSessionRefs", "paymentRefs",
    "subscriptionRefs", "licenseIds", "activationIds",
    "checkoutIntentIds", "paidCheckoutIds", "paidEntryIds", "paidClaimIds",
    "paidOutboxIds", "acquisitionIds", "stageIds",
    "acquisitionConflictIds", "bindingIds", "profileIds", "installIds",
    "installHashes", "identityLinkIds", "identityReviewIds", "profileMergeIds",
    "commerceMaterializationIds", "commercePaymentKeys", "commerceInvoicePaymentIds", "moneyProfileIds",
    "anonymousSessionIds", "tokenIds", "deviceIds", "transferIds",
  ];
  return Object.fromEntries(keys.map((key) => [key, uniqueStrings(value[key])]));
}

async function listAllStripe(service, parameters) {
  const rows = [];
  let startingAfter;
  do {
    const page = await service.list({
      ...parameters,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    rows.push(...page.data || []);
    if (!page.has_more) break;
    const last = page.data?.at(-1);
    if (!last?.id) throw new ResetCliError("Stripe financial pagination did not advance.");
    startingAfter = last.id;
  } while (true);
  return rows;
}

function financialObjectSnapshot(type, object) {
  return {
    type,
    id: String(object?.id || ""),
    amount: Number(object?.amount ?? object?.amount_paid ?? object?.amount_due ?? 0),
    currency: String(object?.currency || ""),
    status: String(object?.status || ""),
    created: Number(object?.created || 0),
  };
}

function emptyLike(closure) {
  return Object.fromEntries(Object.keys(closure).map((key) => [key, []]));
}

function enforceClosureLimits(closure) {
  for (const [key, values] of Object.entries(closure)) {
    if (values.length > MAX_TARGET_ROWS) {
      throw new ResetCliError(`Fresh-paid closure exceeded the safety limit for ${key}.`);
    }
  }
}

function invariantsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value).trim())
    .filter(Boolean))];
}

function safeFingerprint(value) {
  return createHash("sha256")
    .update(`sidestream-safe-report-v1\0${String(value)}`)
    .digest("hex");
}

function isSafeFingerprint(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isNeonBranchId(value) {
  return typeof value === "string" && /^br-[a-z0-9-]{4,80}$/.test(value);
}

function isNeonEndpointId(value) {
  return typeof value === "string" && /^ep-[a-z0-9-]{4,80}$/.test(value);
}

function normalizeIdentityValue(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function readOption(argv, index, name) {
  const argument = argv[index];
  if (argument.startsWith(`${name}=`)) {
    const value = argument.slice(name.length + 1).trim();
    if (!value) throw new ResetCliError(`${name} requires a value.`);
    return [value, index];
  }
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new ResetCliError(`${name} requires a value.`);
  }
  return [value, index + 1];
}

function printHelp() {
  console.log(`Usage:
  npm run fresh-paid:reset -- --branch-name <deployed-name> --branch-id <br-id> --endpoint-id <ep-id>
  npm run fresh-paid:reset -- --operation ${RECOVERY_OPERATION} --branch-name <deployed-name> --branch-id <br-id> --endpoint-id <ep-id>
  npm run fresh-paid:reset -- --apply --operation ${FRESH_PAID_OPERATION} <exact dry-run and recovery confirmations>

Dry-run is the default. No implicit/default Neon branch is accepted. Apply also
requires the dry-run target fingerprint, fixed Production namespace and QA
identity confirmations, and the exact verified child recovery branch.`);
}

const entryUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error(
      error instanceof ResetCliError
        ? error.message
        : "Fresh-paid reset failed closed before a safe report was available.",
    );
    process.exitCode = 1;
  });
}

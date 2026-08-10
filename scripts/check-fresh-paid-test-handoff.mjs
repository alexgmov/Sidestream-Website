#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  PRODUCTION_TARGET,
  ResetCliError,
  attestConnectedTarget,
  buildConnectedTargetFingerprint,
  loadNeonBranches,
  parseNeonBranchInventory,
  resolveNeonDatabase,
  verifyNeonBranchMetadata,
  verifyNeonConnectionString,
  withReadOnlyTransaction,
} from "./reset-alex-upgrade-state.mjs";

export const PREFLIGHT_OPERATION = "fresh-meta-paid-post-auth-preflight";
export const RAW_TELEMETRY_MODE = "raw-telemetry-exact-install-follow-up";

export class FreshPaidPreflightError extends Error {}

export function parsePreflightArgs(argv) {
  const options = {
    operation: PREFLIGHT_OPERATION,
    mode: "post-auth",
    help: false,
    branchName: "",
    branchId: "",
    endpointId: "",
    connectedTargetFingerprint: "",
    telemetryProjectId: "",
    telemetryBranchName: "",
    telemetryBranchId: "",
    telemetryEndpointId: "",
    telemetryDatabase: "",
    telemetryRole: "",
    telemetryConnectedTargetFingerprint: "",
  };
  const valueOptions = new Map([
    ["--operation", "operation"],
    ["--branch-name", "branchName"],
    ["--branch-id", "branchId"],
    ["--endpoint-id", "endpointId"],
    ["--connected-target-fingerprint", "connectedTargetFingerprint"],
    ["--telemetry-project-id", "telemetryProjectId"],
    ["--telemetry-branch-name", "telemetryBranchName"],
    ["--telemetry-branch-id", "telemetryBranchId"],
    ["--telemetry-endpoint-id", "telemetryEndpointId"],
    ["--telemetry-database", "telemetryDatabase"],
    ["--telemetry-role", "telemetryRole"],
    ["--telemetry-connected-target-fingerprint", "telemetryConnectedTargetFingerprint"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--raw-telemetry-follow-up") {
      options.mode = RAW_TELEMETRY_MODE;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const option = [...valueOptions.keys()].find((name) =>
      argument === name || argument.startsWith(`${name}=`)
    );
    if (!option) throw new FreshPaidPreflightError(`Unknown argument: ${argument}`);
    const [value, next] = readOption(argv, index, option);
    options[valueOptions.get(option)] = value;
    index = next;
  }
  if (options.help) return options;
  if (options.operation !== PREFLIGHT_OPERATION) {
    throw new FreshPaidPreflightError("The preflight operation is not allowlisted.");
  }
  for (const key of ["branchName", "branchId", "endpointId", "connectedTargetFingerprint"]) {
    if (!options[key]) throw new FreshPaidPreflightError(`Missing required ${key}.`);
  }
  if (!/^[0-9a-f]{64}$/.test(options.connectedTargetFingerprint)) {
    throw new FreshPaidPreflightError("The connected target fingerprint is invalid.");
  }
  if (options.mode === RAW_TELEMETRY_MODE) {
    for (const key of [
      "telemetryProjectId", "telemetryBranchName", "telemetryBranchId",
      "telemetryEndpointId", "telemetryDatabase", "telemetryRole",
      "telemetryConnectedTargetFingerprint",
    ]) {
      if (!options[key]) throw new FreshPaidPreflightError(`Missing required ${key}.`);
    }
  }
  return options;
}

export function readCurrentLocalProductionIdentity({
  telemetryStatePath = path.join(
    os.homedir(), "Library", "Application Support", "Sidestream", "telemetry-state.json",
  ),
  receiptPath = "/Library/Application Support/Sidestream/installer-receipt.json",
  packagePath = "/Library/Application Support/Adobe/CEP/extensions/Sidestream/package.json",
  fileSystem = fs,
} = {}) {
  const telemetry = readBoundedJson(telemetryStatePath, fileSystem);
  const receipt = readBoundedJson(receiptPath, fileSystem);
  const packageJson = readBoundedJson(packagePath, fileSystem);
  const installIdHash = normalizeHash(telemetry.installIdHash || telemetry.install_id_hash);
  const installerReceiptIdHash = normalizeHash(
    receipt.installerReceiptIdHash || receipt.installer_receipt_id_hash,
  );
  const version = String(packageJson.version || "");
  const validReceipt = receipt.schemaVersion === "sidestream_installer_receipt_v2" &&
    receipt.receiptCommitMode === "atomic_replace" &&
    receipt.buildChannel === "production" &&
    receipt.onboardingChannel === "paid-onboarding" &&
    receipt.verification?.status === "passed" &&
    receipt.packageVersion === version &&
    receipt.verification?.expectedVersion === version &&
    receipt.verification?.installedVersion === version;
  const validPackage = packageJson.sidestreamBuild?.channel === "production" &&
    packageJson.sidestreamBuild?.onboardingChannel === "paid-onboarding";
  if (!installIdHash || !installerReceiptIdHash || !validReceipt || !validPackage) {
    throw new FreshPaidPreflightError(
      "STOP: current local Production paid identity is missing or not exactly verified.",
    );
  }
  return Object.freeze({ installIdHash, installerReceiptIdHash, version });
}

export async function queryPostAuthPreflight(client, identity) {
  const result = await client.query(`
    /* fresh-paid:post-auth-preflight */
    with exact_binding as (
      select binding.*
      from public.sidestream_paid_telemetry_profile_bindings binding
      join public.sidestream_paid_acquisition_claims claim
        on claim.id = binding.claim_id
      join public.sidestream_paid_acquisition_checkouts paid
        on paid.id = binding.checkout_id and paid.id = claim.checkout_id
      join public.sidestream_checkout_intents core
        on core.id = paid.checkout_intent_ref
      join public.sidestream_acquisitions acquisition
        on acquisition.id = binding.acquisition_id
        and acquisition.id = core.acquisition_id
      join public.sidestream_customer_profiles profile
        on profile.id = binding.profile_id_at_binding
        and profile.license_namespace = binding.license_namespace
        and profile.merged_into is null
      join public.sidestream_customer_installs install
        on install.id = binding.install_membership_id
        and install.profile_id = profile.id
        and install.license_namespace = profile.license_namespace
      where binding.license_namespace = 'production'
        and binding.install_id_hash = $1
        and binding.installer_receipt_id_hash = $2
        and install.install_id_hash = $1
        and claim.claim_state = 'claimed'
        and claim.activation_ref is not null
        and claim.activation_ref = binding.activation_ref
        and paid.claim_state = 'claimed'
        and paid.payment_state = 'active'
        and acquisition.integrity_state = 'intact'
        and acquisition.first_observed_source = 'meta'
        and acquisition.first_observed_medium = 'social'
        and acquisition.first_observed_campaign = 'sidestream_direct_offer_test'
    )
    select
      (select count(*)::integer from exact_binding) as exact_bindings,
      (select count(distinct claim_id)::integer from exact_binding) as claimed_claims,
      (select count(distinct activation_ref)::integer from exact_binding) as activation_refs,
      (select count(*)::integer from public.sidestream_acquisition_stages stage
        where stage.acquisition_id in (select acquisition_id from exact_binding)
          and stage.license_namespace = 'production'
          and stage.stage = 'authentication_completed') as authentication_completed,
      (select count(*)::integer from public.sidestream_acquisition_stages stage
        where stage.acquisition_id in (select acquisition_id from exact_binding)
          and stage.license_namespace = 'production'
          and stage.stage = 'installation_claimed') as installation_claimed,
      (select count(*)::integer from public.sidestream_customer_installs install
        join exact_binding binding on binding.install_membership_id = install.id
          and binding.profile_id_at_binding = install.profile_id
        where install.license_namespace = 'production'
          and install.install_id_hash = $1) as telemetry_owners,
      (select count(*)::integer from exact_binding binding
        join public.sidestream_customer_identity_links receipt_link
          on receipt_link.id = binding.installer_receipt_identity_link_id
          and receipt_link.profile_id = binding.profile_id_at_binding
          and receipt_link.link_type = 'installer_receipt_hash'
          and receipt_link.link_value = $2) as exact_receipt_owners
  `, [identity.installIdHash, identity.installerReceiptIdHash]);
  return result.rows[0] || {};
}

export function evaluatePostAuthPreflight(row) {
  const counts = {
    claimedClaims: Number(row.claimed_claims || 0),
    activationRefs: Number(row.activation_refs || 0),
    authenticationCompleted: Number(row.authentication_completed || 0),
    installationClaimed: Number(row.installation_claimed || 0),
    exactBindings: Number(row.exact_bindings || 0),
    telemetryOwners: Number(row.telemetry_owners || 0),
    exactReceiptOwners: Number(row.exact_receipt_owners || 0),
  };
  const go = Object.values(counts).every((value) => value === 1);
  return { decision: go ? "GO" : "STOP", counts };
}

export async function queryRawTelemetryFollowUp(client, identity) {
  const result = await client.query(`
    /* fresh-paid:raw-telemetry-exact-install-follow-up */
    with session_facts as (
      select session_id, max(nullif(btrim(install_id_hash), '')) as install_id_hash
      from public.sidestream_sessions
      where coalesce(nullif(build_channel, ''), 'production') = 'production'
      group by session_id
    ), exact_events as (
      select event.telemetry_event_id, event.event_name,
        coalesce(nullif(btrim(event.install_id_hash), ''), session.install_id_hash) as install_id_hash,
        coalesce(
          nullif(event.payload ->> 'installer_receipt_id_hash', ''),
          nullif(event.payload ->> 'installerReceiptIdHash', ''),
          nullif(event.data_points #>> '{details,installerReceiptIdHash}', ''),
          nullif(event.data_points #>> '{details,installer_receipt_id_hash}', '')
        ) as receipt_hash
      from public.sidestream_telemetry_events event
      left join session_facts session on session.session_id = event.session_id
      where coalesce(nullif(event.build_channel, ''), 'production') = 'production'
        and coalesce(nullif(btrim(event.install_id_hash), ''), session.install_id_hash) = $1
    )
    select
      count(*) filter (where receipt_hash = $2)::integer as exact_receipt_events,
      count(*) filter (where event_name = 'download_requested')::integer as download_requested,
      count(*) filter (where event_name = 'download_completed')::integer as download_completed,
      count(*) filter (where event_name = 'premiere_import_completed')::integer as premiere_import_completed
    from exact_events
  `, [identity.installIdHash, identity.installerReceiptIdHash]);
  return result.rows[0] || {};
}

export function evaluateRawTelemetryFollowUp(row) {
  const counts = {
    exactReceiptEvents: Number(row.exact_receipt_events || 0),
    downloadRequested: Number(row.download_requested || 0),
    downloadCompleted: Number(row.download_completed || 0),
    premiereImportCompleted: Number(row.premiere_import_completed || 0),
  };
  return {
    decision: counts.exactReceiptEvents >= 1 && counts.downloadCompleted >= 1
      ? "GO"
      : "STOP",
    counts,
  };
}

export function buildPreflightReport({ mode, decision, counts, targetFingerprint, identity }) {
  return {
    operation: PREFLIGHT_OPERATION,
    mode,
    decision,
    connectedTargetFingerprint: targetFingerprint,
    localIdentityFingerprint: createHash("sha256")
      .update(`fresh-paid-local-identity-v1\0${identity.installIdHash}\0${identity.installerReceiptIdHash}`)
      .digest("hex"),
    counts,
    instruction: decision === "GO"
      ? (mode === RAW_TELEMETRY_MODE ? "follow-up-complete" : "download-may-begin")
      : "do-not-download",
  };
}

async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parsePreflightArgs(argv);
  if (options.help) return printHelp();
  const identity = readCurrentLocalProductionIdentity();
  const branches = await loadNeonBranches(PRODUCTION_TARGET.neonProjectId, environment);
  verifyNeonBranchMetadata(parseNeonBranchInventory(JSON.stringify(branches)), options);
  const database = await resolveNeonDatabase(options, environment);
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: database.connectionString,
    max: 1,
    connectionTimeoutMillis: 7_500,
    idleTimeoutMillis: 3_000,
    statement_timeout: 15_000,
    query_timeout: 15_000,
  });
  try {
    const attestation = await attestConnectedTarget(pool, PRODUCTION_TARGET, options);
    if (attestation.fingerprint !== options.connectedTargetFingerprint) {
      throw new FreshPaidPreflightError("STOP: Website connected target changed.");
    }
    const result = await withReadOnlyTransaction(pool, (client) =>
      queryPostAuthPreflight(client, identity)
    );
    const evaluated = evaluatePostAuthPreflight(result);
    if (options.mode !== RAW_TELEMETRY_MODE || evaluated.decision !== "GO") {
      console.log(JSON.stringify(buildPreflightReport({
        mode: "post-auth",
        ...evaluated,
        targetFingerprint: attestation.fingerprint,
        identity,
      }), null, 2));
      return;
    }
    const telemetry = await runRawTelemetryMode(options, environment, identity, Pool);
    console.log(JSON.stringify(buildPreflightReport({
      mode: RAW_TELEMETRY_MODE,
      ...telemetry.evaluated,
      targetFingerprint: telemetry.targetFingerprint,
      identity,
    }), null, 2));
  } finally {
    await pool.end();
  }
}

async function runRawTelemetryMode(options, environment, identity, Pool) {
  const target = {
    neonProjectId: options.telemetryProjectId,
    neonDatabase: options.telemetryDatabase,
    neonRole: options.telemetryRole,
  };
  const selectors = {
    branchName: options.telemetryBranchName,
    branchId: options.telemetryBranchId,
    endpointId: options.telemetryEndpointId,
  };
  const branches = await loadNeonBranches(target.neonProjectId, environment);
  verifyNeonBranchMetadata(branches, selectors);
  const verified = verifyNeonConnectionString(
    environment.SIDESTREAM_FRESH_PAID_TELEMETRY_POSTGRES_URL,
    target,
    selectors,
  );
  const targetFingerprint = buildConnectedTargetFingerprint({
    projectId: target.neonProjectId,
    branchName: selectors.branchName,
    branchId: selectors.branchId,
    endpointId: selectors.endpointId,
    database: target.neonDatabase,
    role: target.neonRole,
    namespace: "production",
  });
  if (targetFingerprint !== options.telemetryConnectedTargetFingerprint) {
    throw new FreshPaidPreflightError("STOP: raw telemetry connected target changed.");
  }
  const pool = new Pool({
    connectionString: verified.connectionString,
    max: 1,
    connectionTimeoutMillis: 7_500,
    idleTimeoutMillis: 3_000,
    statement_timeout: 15_000,
    query_timeout: 15_000,
  });
  try {
    const connected = await pool.query(
      "select current_database() as database_name, current_user as role_name",
    );
    if (
      connected.rows[0]?.database_name !== target.neonDatabase ||
      connected.rows[0]?.role_name !== target.neonRole
    ) {
      throw new FreshPaidPreflightError("STOP: raw telemetry database attestation failed.");
    }
    const row = await withReadOnlyTransaction(pool, (client) =>
      queryRawTelemetryFollowUp(client, identity)
    );
    return { evaluated: evaluateRawTelemetryFollowUp(row), targetFingerprint };
  } finally {
    await pool.end();
  }
}

function readBoundedJson(filePath, fileSystem) {
  let contents;
  try {
    const stat = fileSystem.statSync(filePath);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("invalid");
    contents = fileSystem.readFileSync(filePath, "utf8");
  } catch {
    throw new FreshPaidPreflightError("STOP: required local Production state is unavailable.");
  }
  try {
    const parsed = JSON.parse(contents);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed;
  } catch {
    throw new FreshPaidPreflightError("STOP: required local Production state is invalid.");
  }
}

function normalizeHash(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : "";
}

function readOption(argv, index, name) {
  const argument = argv[index];
  if (argument.startsWith(`${name}=`)) {
    const value = argument.slice(name.length + 1).trim();
    if (!value) throw new FreshPaidPreflightError(`${name} requires a value.`);
    return [value, index];
  }
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new FreshPaidPreflightError(`${name} requires a value.`);
  }
  return [value, index + 1];
}

function printHelp() {
  console.log(`Usage:
  npm run fresh-paid:preflight -- --branch-name <name> --branch-id <br-id> --endpoint-id <ep-id> --connected-target-fingerprint <sha256>

This command is read-only and returns STOP or GO. Run post-auth before the first
download. Add --raw-telemetry-follow-up after one download with the separately
attested read-only telemetry target selectors.`);
}

const entryUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    const safe = error instanceof FreshPaidPreflightError || error instanceof ResetCliError
      ? error.message
      : "STOP: preflight failed closed.";
    console.error(safe);
    process.exitCode = 1;
  });
}

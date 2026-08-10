import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLY_CONFIRMATION,
  FIXED_QA_IDENTITY_CONFIRMATION,
  FRESH_PAID_OPERATION,
  PRODUCTION_TARGET,
  RECOVERY_CONFIRMATION,
  RECOVERY_OPERATION,
  allCountsZero,
  attestConnectedTarget,
  buildConnectedTargetFingerprint,
  buildNeonCliEnvironment,
  buildResetReport,
  closureFingerprint,
  extractNeonConnectionString,
  parseArgs,
  parseNeonBranchInventory,
  verifyNeonBranchMetadata,
  verifyNeonConnectionString,
  verifyRecoveryBranch,
} from "../scripts/reset-alex-upgrade-state.mjs";

const SELECTORS = Object.freeze({
  branchName: "production-deployed",
  branchId: "br-production-1234",
  endpointId: "ep-production-1234",
});
const TARGET_FINGERPRINT = buildConnectedTargetFingerprint({
  projectId: PRODUCTION_TARGET.neonProjectId,
  ...SELECTORS,
  database: PRODUCTION_TARGET.neonDatabase,
  role: PRODUCTION_TARGET.neonRole,
  namespace: "production",
});

test("fresh-paid reset is dry-run by default and refuses implicit or main branches", () => {
  assert.deepEqual(parseArgs([
    "--branch-name", SELECTORS.branchName,
    "--branch-id", SELECTORS.branchId,
    "--endpoint-id", SELECTORS.endpointId,
  ]), {
    operation: FRESH_PAID_OPERATION,
    apply: false,
    help: false,
    ...SELECTORS,
    connectedTargetFingerprint: "",
    namespaceConfirmation: "",
    identityConfirmation: "",
    applyConfirmation: "",
    recoveryBranchId: "",
    recoveryBranchConfirmation: "",
  });
  assert.throws(() => parseArgs([
    "--branch-name", "main",
    "--branch-id", SELECTORS.branchId,
    "--endpoint-id", SELECTORS.endpointId,
  ]), /non-main/);
  assert.throws(() => parseArgs([
    "--branch-name", SELECTORS.branchName,
    "--endpoint-id", SELECTORS.endpointId,
  ]), /branch ID/);
});

test("apply binds operation, namespace, QA identity, target fingerprint, and recovery branch", () => {
  const recovery = "br-recovery-1234";
  const options = parseArgs([
    "--apply",
    "--operation", FRESH_PAID_OPERATION,
    "--branch-name", SELECTORS.branchName,
    "--branch-id", SELECTORS.branchId,
    "--endpoint-id", SELECTORS.endpointId,
    "--connected-target-fingerprint", TARGET_FINGERPRINT,
    "--confirm-namespace", "production",
    "--confirm-identity", FIXED_QA_IDENTITY_CONFIRMATION,
    "--confirm", APPLY_CONFIRMATION,
    "--recovery-branch-id", recovery,
    "--confirm-recovery-branch", recovery,
  ]);
  assert.equal(options.apply, true);
  assert.throws(() => parseArgs([
    "--apply",
    "--branch-name", SELECTORS.branchName,
    "--branch-id", SELECTORS.branchId,
    "--endpoint-id", SELECTORS.endpointId,
  ]), /explicit operation name/);
  assert.throws(() => parseArgs([
    "--apply",
    "--operation", FRESH_PAID_OPERATION,
    "--branch-name", SELECTORS.branchName,
    "--branch-id", SELECTORS.branchId,
    "--endpoint-id", SELECTORS.endpointId,
    "--connected-target-fingerprint", TARGET_FINGERPRINT,
    "--confirm-namespace", "test",
  ]), /namespace/);
});

test("recovery creation has its own dry-run and exact confirmation", () => {
  const base = [
    "--operation", RECOVERY_OPERATION,
    "--branch-name", SELECTORS.branchName,
    "--branch-id", SELECTORS.branchId,
    "--endpoint-id", SELECTORS.endpointId,
  ];
  assert.equal(parseArgs(base).apply, false);
  assert.throws(() => parseArgs([...base, "--apply"]), /Recovery creation/);
  assert.equal(parseArgs([
    ...base, "--apply", "--confirm", RECOVERY_CONFIRMATION,
  ]).apply, true);
});

test("Neon metadata verifies project-scoped branch, endpoint, and recovery parent", async () => {
  const branches = parseNeonBranchInventory(JSON.stringify({ branches: [
    {
      id: SELECTORS.branchId,
      name: SELECTORS.branchName,
      parent_id: null,
      current_state: "ready",
      endpoints: [{ id: SELECTORS.endpointId }],
    },
    {
      id: "br-recovery-1234",
      name: "fresh-meta-paid-recovery-20260810",
      parent_id: SELECTORS.branchId,
      current_state: "ready",
      endpoints: [],
    },
  ] }));
  assert.equal(verifyNeonBranchMetadata(branches, SELECTORS).id, SELECTORS.branchId);
  assert.match(await verifyRecoveryBranch(branches, {
    branchId: SELECTORS.branchId,
    recoveryBranchId: "br-recovery-1234",
  }), /^[0-9a-f]{64}$/);
  assert.throws(() => verifyNeonBranchMetadata(branches, {
    ...SELECTORS,
    endpointId: "ep-unexpected-1234",
  }), /does not belong/);
  await assert.rejects(() => verifyRecoveryBranch(branches, {
    branchId: "br-other-1234",
    recoveryBranchId: "br-recovery-1234",
  }), /verification failed/);
});

test("connection verification accepts only the explicit direct endpoint, role, and database", () => {
  const raw = `postgresql://neondb_owner:secret@${SELECTORS.endpointId}.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require`;
  assert.equal(extractNeonConnectionString(JSON.stringify({ connection_string: raw })), raw);
  const verified = verifyNeonConnectionString(raw, PRODUCTION_TARGET, SELECTORS);
  assert.equal(verified.endpointId, SELECTORS.endpointId);
  assert.equal(new URL(verified.connectionString).searchParams.get("sslmode"), "verify-full");
  assert.throws(() => verifyNeonConnectionString(
    raw.replace(SELECTORS.endpointId, `${SELECTORS.endpointId}-pooler`),
    PRODUCTION_TARGET,
    SELECTORS,
  ), /explicit direct/);
  assert.throws(() => verifyNeonConnectionString(
    raw.replace("neondb_owner", "other_role"),
    PRODUCTION_TARGET,
    SELECTORS,
  ), /role or database/);
});

test("connected database attestation contributes to the apply fingerprint", async () => {
  const client = {
    async query(sql, params) {
      assert.match(sql, /current_database/);
      assert.deepEqual(params, ["production"]);
      return { rows: [{
        database_name: "neondb",
        role_name: "neondb_owner",
        namespace_rows: 4,
        other_namespace_rows: 0,
      }] };
    },
  };
  const attested = await attestConnectedTarget(client, PRODUCTION_TARGET, SELECTORS);
  assert.equal(attested.fingerprint, TARGET_FINGERPRINT);
  assert.equal(attested.namespaceRows, 4);
});

test("reports contain only counts and safe fingerprints", () => {
  const closure = {
    accountIds: ["10000000-0000-4000-8000-000000000001"],
    customerIds: ["cus_private"],
    installHashes: ["a".repeat(64)],
  };
  const report = buildResetReport({
    mode: "dry-run",
    targetFingerprint: TARGET_FINGERPRINT,
    closure,
  });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("alex@"), false);
  assert.equal(serialized.includes("cus_private"), false);
  assert.equal(serialized.includes("a".repeat(64)), false);
  assert.equal(serialized.includes("postgresql://"), false);
  assert.match(report.targetStateFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(report.counts.customerIds, 1);
  assert.equal(closureFingerprint(closure), report.targetStateFingerprint);
  assert.equal(allCountsZero({ accounts: 0, profiles: 0 }), true);
  assert.equal(allCountsZero({ accounts: 0, profiles: 1 }), false);
});

test("Neon child process never inherits reset or telemetry credentials", () => {
  const sanitized = buildNeonCliEnvironment({
    PATH: "/bin",
    SIDESTREAM_RESET_PRODUCTION_STRIPE_SECRET_KEY: "sk_live_private",
    SIDESTREAM_TELEMETRY_POSTGRES_URL: "postgresql://private",
    SIDESTREAM_FRESH_PAID_TELEMETRY_POSTGRES_URL: "postgresql://private",
  });
  assert.deepEqual(sanitized, { PATH: "/bin" });
});

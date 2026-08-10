import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RAW_TELEMETRY_MODE,
  buildPreflightReport,
  evaluatePostAuthPreflight,
  evaluateRawTelemetryFollowUp,
  parsePreflightArgs,
  queryPostAuthPreflight,
  queryRawTelemetryFollowUp,
  readCurrentLocalProductionIdentity,
} from "../scripts/check-fresh-paid-test-handoff.mjs";

const INSTALL = "a".repeat(64);
const RECEIPT = "b".repeat(64);
const TARGET = "c".repeat(64);

test("preflight requires an exact Website target fingerprint and raw mode requires a separate explicit telemetry target", () => {
  const base = [
    "--branch-name", "production-deployed",
    "--branch-id", "br-production-1234",
    "--endpoint-id", "ep-production-1234",
    "--connected-target-fingerprint", TARGET,
  ];
  assert.equal(parsePreflightArgs(base).mode, "post-auth");
  assert.throws(() => parsePreflightArgs(base.slice(0, -2)), /Missing required/);
  assert.throws(() => parsePreflightArgs([
    ...base, "--raw-telemetry-follow-up",
  ]), /telemetryProjectId/);
  const raw = parsePreflightArgs([
    ...base,
    "--raw-telemetry-follow-up",
    "--telemetry-project-id", "project-1234",
    "--telemetry-branch-name", "production",
    "--telemetry-branch-id", "br-telemetry-1234",
    "--telemetry-endpoint-id", "ep-telemetry-1234",
    "--telemetry-database", "telemetry",
    "--telemetry-role", "reader",
    "--telemetry-connected-target-fingerprint", "d".repeat(64),
  ]);
  assert.equal(raw.mode, RAW_TELEMETRY_MODE);
});

test("local identity parser accepts only current verified paid-onboarding Production state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-paid-preflight-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const telemetryStatePath = path.join(root, "telemetry-state.json");
  const receiptPath = path.join(root, "installer-receipt.json");
  const packagePath = path.join(root, "package.json");
  fs.writeFileSync(telemetryStatePath, JSON.stringify({ installIdHash: INSTALL }));
  fs.writeFileSync(receiptPath, JSON.stringify({
    schemaVersion: "sidestream_installer_receipt_v2",
    receiptCommitMode: "atomic_replace",
    installerReceiptIdHash: RECEIPT,
    buildChannel: "production",
    onboardingChannel: "paid-onboarding",
    packageVersion: "1.0.18",
    verification: {
      status: "passed",
      expectedVersion: "1.0.18",
      installedVersion: "1.0.18",
    },
  }));
  fs.writeFileSync(packagePath, JSON.stringify({
    version: "1.0.18",
    sidestreamBuild: {
      channel: "production",
      onboardingChannel: "paid-onboarding",
    },
  }));
  const identity = readCurrentLocalProductionIdentity({
    telemetryStatePath, receiptPath, packagePath,
  });
  assert.deepEqual(identity, {
    installIdHash: INSTALL,
    installerReceiptIdHash: RECEIPT,
    version: "1.0.18",
  });
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  receipt.verification.status = "pending";
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.throws(() => readCurrentLocalProductionIdentity({
    telemetryStatePath, receiptPath, packagePath,
  }), /STOP/);
});

test("post-auth GO requires every exact claim, stage, binding, and telemetry-owner count to be one", () => {
  const passing = {
    claimed_claims: 1,
    activation_refs: 1,
    authentication_completed: 1,
    installation_claimed: 1,
    exact_bindings: 1,
    telemetry_owners: 1,
    exact_receipt_owners: 1,
  };
  assert.equal(evaluatePostAuthPreflight(passing).decision, "GO");
  assert.equal(evaluatePostAuthPreflight({ ...passing, activation_refs: 0 }).decision, "STOP");
  assert.equal(evaluatePostAuthPreflight({ ...passing, exact_bindings: 2 }).decision, "STOP");
});

test("post-auth query binds both local hashes without exposing them in its result", async () => {
  let observed;
  const row = await queryPostAuthPreflight({
    async query(sql, params) {
      observed = { sql, params };
      return { rows: [{ exact_bindings: 1 }] };
    },
  }, { installIdHash: INSTALL, installerReceiptIdHash: RECEIPT });
  assert.deepEqual(observed.params, [INSTALL, RECEIPT]);
  assert.match(observed.sql, /first_observed_source = 'meta'/);
  assert.match(observed.sql, /first_observed_medium = 'social'/);
  assert.match(observed.sql, /sidestream_direct_offer_test/);
  assert.deepEqual(row, { exact_bindings: 1 });
});

test("raw telemetry follow-up is exact-install and requires a completed download", async () => {
  let observed;
  await queryRawTelemetryFollowUp({
    async query(sql, params) {
      observed = { sql, params };
      return { rows: [{}] };
    },
  }, { installIdHash: INSTALL, installerReceiptIdHash: RECEIPT });
  assert.deepEqual(observed.params, [INSTALL, RECEIPT]);
  assert.match(observed.sql, /sidestream_telemetry_events/);
  assert.equal(evaluateRawTelemetryFollowUp({
    exact_receipt_events: 1,
    download_requested: 1,
    download_completed: 1,
    premiere_import_completed: 0,
  }).decision, "GO");
  assert.equal(evaluateRawTelemetryFollowUp({
    exact_receipt_events: 1,
    download_completed: 0,
  }).decision, "STOP");
});

test("preflight report never prints local identity values", () => {
  const report = buildPreflightReport({
    mode: "post-auth",
    decision: "GO",
    counts: { exactBindings: 1 },
    targetFingerprint: TARGET,
    identity: { installIdHash: INSTALL, installerReceiptIdHash: RECEIPT },
  });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(INSTALL), false);
  assert.equal(serialized.includes(RECEIPT), false);
  assert.equal(report.instruction, "download-may-begin");
});

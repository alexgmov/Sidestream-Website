import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LauncherAttributionError,
  createRenamedLauncherLedger,
  parseLauncherFilename
} from "../api/_lib/renamed-launcher-attribution.mjs";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sidestream-launcher-ledger-"));
  let clock = Date.parse("2026-08-10T12:00:00.000Z");
  const ledger = createRenamedLauncherLedger({
    filePath: path.join(directory, "ledger.json"),
    signingSecret: "test-only-signing-secret-with-more-than-32-bytes",
    now: () => clock
  });

  return {
    directory,
    ledger,
    advance(milliseconds) {
      clock += milliseconds;
    },
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

function issue(fixtureState, overrides = {}) {
  return fixtureState.ledger.issue({
    releaseId: "sidestream-test-1.0.19",
    platform: "macos-universal",
    lifetimeSeconds: 300,
    ...overrides
  });
}

function redeem(fixtureState, issued, overrides = {}) {
  return fixtureState.ledger.redeem({
    claimToken: issued.claimToken,
    launcherFilename: issued.launcherFilename,
    redemptionAttemptId: crypto.randomBytes(24).toString("base64url"),
    releaseId: issued.releaseId,
    platform: issued.platform,
    ...overrides
  });
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof LauncherAttributionError);
    assert.equal(error.code, code);
    return true;
  });
}

test("one opaque claim binds exact acquisition, launcher, receipt, and install identities", () => {
  const state = fixture();
  try {
    const issued = issue(state);
    const attempt = crypto.randomBytes(24).toString("base64url");
    const binding = redeem(state, issued, { redemptionAttemptId: attempt });
    const retry = redeem(state, issued, { redemptionAttemptId: attempt });
    const receiptHash = "a".repeat(64);
    const installHash = "b".repeat(64);

    assert.equal(parseLauncherFilename(issued.launcherFilename), issued.claimToken);
    assert.deepEqual(retry, binding, "same-process network retry must be idempotent");

    state.ledger.recordInstallerCompleted({
      ...binding,
      installerReceiptIdHash: receiptHash
    });
    const result = state.ledger.bindFirstPluginOpen({
      ...binding,
      installerReceiptIdHash: receiptHash,
      installIdHash: installHash
    });
    const replay = state.ledger.bindFirstPluginOpen({
      ...binding,
      installerReceiptIdHash: receiptHash,
      installIdHash: installHash
    });

    assert.equal(result.acquisitionId, issued.acquisitionId);
    assert.equal(result.installIdHash, installHash);
    assert.equal(result.installerReceiptIdHash, receiptHash);
    assert.deepEqual(replay, result, "same exact final binding must be idempotent");

    const onDisk = fs.readFileSync(path.join(state.directory, "ledger.json"), "utf8");
    assert.doesNotMatch(onDisk, new RegExp(issued.claimToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(onDisk, new RegExp(issued.claimTokenHash));
  } finally {
    state.cleanup();
  }
});

test("invalid, expired, reused, release-mismatched, and platform-mismatched claims fail closed", () => {
  const state = fixture();
  try {
    const issued = issue(state, { lifetimeSeconds: 60 });
    expectCode(
      () => redeem(state, issued, { claimToken: "x".repeat(43) }),
      "invalid_claim"
    );
    expectCode(
      () => redeem(state, issued, { launcherFilename: `Other--${issued.claimToken}.app` }),
      "invalid_launcher_filename"
    );
    expectCode(
      () => redeem(state, issued, { launcherFilename: `/tmp/${issued.launcherFilename}` }),
      "invalid_launcher_filename"
    );
    expectCode(
      () => redeem(state, issued, { releaseId: "sidestream-test-9.9.9" }),
      "release_mismatch"
    );
    expectCode(
      () => redeem(state, issued, { platform: "windows-x64" }),
      "platform_mismatch"
    );

    const redeemed = redeem(state, issued);
    expectCode(() => redeem(state, issued), "claim_reused");
    expectCode(
      () => state.ledger.recordInstallerCompleted({
        ...redeemed,
        installerReceiptIdHash: "c".repeat(63)
      }),
      "invalid_installer_receipt"
    );

    const expiring = issue(state, { lifetimeSeconds: 60 });
    state.advance(60_001);
    expectCode(() => redeem(state, expiring), "claim_expired");
    const persisted = JSON.parse(fs.readFileSync(path.join(state.directory, "ledger.json"), "utf8"));
    assert.equal(persisted.claims[expiring.claimTokenHash].state, "expired");
  } finally {
    state.cleanup();
  }
});

test("receipt and install mismatches cannot replace an existing exact binding", () => {
  const state = fixture();
  try {
    const issued = issue(state);
    const binding = redeem(state, issued);
    state.ledger.recordInstallerCompleted({
      ...binding,
      installerReceiptIdHash: "d".repeat(64)
    });
    expectCode(
      () => state.ledger.recordInstallerCompleted({
        ...binding,
        installerReceiptIdHash: "e".repeat(64)
      }),
      "installer_receipt_mismatch"
    );
    state.ledger.bindFirstPluginOpen({
      ...binding,
      installerReceiptIdHash: "d".repeat(64),
      installIdHash: "f".repeat(64)
    });
    expectCode(
      () => state.ledger.bindFirstPluginOpen({
        ...binding,
        installerReceiptIdHash: "d".repeat(64),
        installIdHash: "0".repeat(64)
      }),
      "installation_binding_mismatch"
    );

    const secondIssued = issue(state);
    const secondBinding = redeem(state, secondIssued);
    expectCode(
      () => state.ledger.recordInstallerCompleted({
        ...secondBinding,
        installerReceiptIdHash: "d".repeat(64)
      }),
      "installation_already_bound"
    );
  } finally {
    state.cleanup();
  }
});

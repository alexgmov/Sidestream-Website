import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_DEVICE_POLICY_MODE,
  DEFAULT_DEVICE_TRANSFER_LIMIT,
  DEVICE_POLICY_ERROR_CODES,
  DEVICE_TRANSFER_WINDOW_MS,
  MAX_DEVICE_TRANSFER_LIMIT,
  applyDevicePolicyMode,
  decideDeviceActivation,
  evaluateDeviceTransferLimit,
  getDeviceRevocationErrorCode,
  isSameAccountDevice,
  resolveDevicePolicyMode,
  resolveDeviceTransferLimit,
  selectDeviceNamespace,
} from "../api/_lib/device-policy.ts";

const productionDevice = {
  namespace: "production",
  deviceIdHash: "a".repeat(64),
  revokedAt: null,
};

test("namespace selection uses trusted deployment state and requires an explicit test gate", () => {
  assert.equal(selectDeviceNamespace({
    trustedDeploymentEnvironment: "production",
    allowTestNamespace: true,
  }), "production");
  assert.equal(selectDeviceNamespace({
    trustedDeploymentEnvironment: "production",
    allowTestNamespace: true,
    buildChannel: "test",
  }), "production");
  assert.equal(selectDeviceNamespace({
    trustedDeploymentEnvironment: "preview",
    allowTestNamespace: false,
  }), null);
  assert.equal(selectDeviceNamespace({
    trustedDeploymentEnvironment: "preview",
    allowTestNamespace: true,
  }), "test");
  assert.equal(selectDeviceNamespace({
    trustedDeploymentEnvironment: "development",
    allowTestNamespace: true,
  }), "test");
  assert.equal(selectDeviceNamespace({
    trustedDeploymentEnvironment: "unknown",
    allowTestNamespace: true,
  }), null);
});

test("same active account device is idempotent only inside its namespace", () => {
  assert.equal(isSameAccountDevice({
    namespace: "production",
    requestedDeviceIdHash: "a".repeat(64),
    activeDevice: productionDevice,
  }), true);
  assert.equal(isSameAccountDevice({
    namespace: "production",
    requestedDeviceIdHash: "b".repeat(64),
    activeDevice: productionDevice,
  }), false);
  assert.equal(isSameAccountDevice({
    namespace: "test",
    requestedDeviceIdHash: "a".repeat(64),
    activeDevice: productionDevice,
  }), false);
});

test("activation distinguishes new, same-device, and transfer-required cases", () => {
  assert.deepEqual(decideDeviceActivation({
    namespace: "production",
    requestedDeviceIdHash: "a".repeat(64),
    activeDevice: null,
  }), { decision: "activate", errorCode: null });
  assert.deepEqual(decideDeviceActivation({
    namespace: "production",
    requestedDeviceIdHash: "a".repeat(64),
    activeDevice: productionDevice,
  }), { decision: "same_device", errorCode: null });
  assert.deepEqual(decideDeviceActivation({
    namespace: "production",
    requestedDeviceIdHash: "b".repeat(64),
    activeDevice: productionDevice,
  }), {
    decision: "transfer_required",
    errorCode: "transfer_required",
  });
  assert.deepEqual(decideDeviceActivation({
    namespace: "test",
    requestedDeviceIdHash: "b".repeat(64),
    activeDevice: productionDevice,
  }), { decision: "activate", errorCode: null });
  assert.deepEqual(decideDeviceActivation({
    namespace: "production",
    requestedDeviceIdHash: "b".repeat(64),
    activeDevice: { ...productionDevice, revokedAt: "2026-07-14T19:00:00.000Z" },
  }), { decision: "activate", errorCode: null });
});

test("transfer limits are capped and use an inclusive rolling window", () => {
  assert.equal(resolveDeviceTransferLimit(undefined), DEFAULT_DEVICE_TRANSFER_LIMIT);
  assert.equal(resolveDeviceTransferLimit("5"), 5);
  assert.equal(resolveDeviceTransferLimit(0), DEFAULT_DEVICE_TRANSFER_LIMIT);
  assert.equal(resolveDeviceTransferLimit(999), MAX_DEVICE_TRANSFER_LIMIT);

  const nowMs = Date.UTC(2026, 6, 14, 19);
  const allowed = evaluateDeviceTransferLimit({
    nowMs,
    configuredLimit: 3,
    transferTimestampsMs: [
      nowMs - DEVICE_TRANSFER_WINDOW_MS,
      nowMs - 1,
      nowMs - DEVICE_TRANSFER_WINDOW_MS - 1,
      nowMs + 1,
    ],
  });
  assert.deepEqual(allowed, {
    allowed: true,
    errorCode: null,
    limit: 3,
    transferCount: 2,
    remainingTransfers: 1,
    windowStartedAtMs: nowMs - DEVICE_TRANSFER_WINDOW_MS,
  });

  const blocked = evaluateDeviceTransferLimit({
    nowMs,
    configuredLimit: 3,
    transferTimestampsMs: [nowMs - 2, nowMs - 1, nowMs],
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.errorCode, "transfer_limit_reached");
  assert.equal(blocked.remainingTransfers, 0);
});

test("policy defaults to observe and only explicit enforce blocks", () => {
  assert.equal(DEFAULT_DEVICE_POLICY_MODE, "observe");
  assert.equal(resolveDevicePolicyMode(undefined), "observe");
  assert.equal(resolveDevicePolicyMode("unexpected"), "observe");
  assert.equal(resolveDevicePolicyMode(" OFF "), "off");
  assert.equal(resolveDevicePolicyMode("ENFORCE"), "enforce");

  assert.deepEqual(applyDevicePolicyMode({
    mode: undefined,
    errorCode: DEVICE_POLICY_ERROR_CODES.TRANSFER_REQUIRED,
  }), {
    mode: "observe",
    allowed: true,
    publicErrorCode: null,
    observedErrorCode: "transfer_required",
  });
  assert.deepEqual(applyDevicePolicyMode({
    mode: "off",
    errorCode: DEVICE_POLICY_ERROR_CODES.TRANSFER_REQUIRED,
  }), {
    mode: "off",
    allowed: true,
    publicErrorCode: null,
    observedErrorCode: null,
  });
  assert.deepEqual(applyDevicePolicyMode({
    mode: "enforce",
    errorCode: DEVICE_POLICY_ERROR_CODES.TRANSFER_REQUIRED,
  }), {
    mode: "enforce",
    allowed: false,
    publicErrorCode: "transfer_required",
    observedErrorCode: null,
  });
});

test("public device errors stay stable across transfer and revocation paths", () => {
  assert.deepEqual(DEVICE_POLICY_ERROR_CODES, {
    TRANSFER_REQUIRED: "transfer_required",
    TRANSFER_LIMIT_REACHED: "transfer_limit_reached",
    DEVICE_DEACTIVATED: "device_deactivated",
    DEVICE_REPLACED: "device_replaced",
  });
  assert.equal(getDeviceRevocationErrorCode("deactivated"), "device_deactivated");
  assert.equal(getDeviceRevocationErrorCode("replaced"), "device_replaced");
});

test("migration is additive, private, HMAC-only, and database-enforces active seats", async () => {
  const migration = await readFile(new URL(
    "../db/migrations/20260714190000_add_single_active_account_devices.sql",
    import.meta.url,
  ), "utf8");

  assert.match(migration, /create table if not exists public\.sidestream_account_devices/i);
  assert.match(migration, /create table if not exists public\.sidestream_device_transfers/i);
  assert.match(
    migration,
    /create unique index[^;]+account_id[^;]+license_namespace = 'production' and revoked_at is null/is,
  );
  assert.match(
    migration,
    /create unique index[^;]+account_id[^;]+license_namespace = 'test' and revoked_at is null/is,
  );
  assert.match(migration, /device_id_hash ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(
    migration,
    /revoked_at is not null\s+and revocation_reason is not null\s+and revocation_reason in/is,
  );
  assert.match(
    migration,
    /foreign key \(from_device_id, account_id, license_namespace\)[^;]+sidestream_account_devices/is,
  );
  assert.match(migration, /alter table public\.sidestream_account_devices enable row level security/i);
  assert.match(migration, /alter table public\.sidestream_device_transfers enable row level security/i);
  assert.doesNotMatch(migration, /\b(insert\s+into|update\s+public\.|delete\s+from)\b/i);

  for (const forbiddenColumn of [
    "hostname",
    "hardware_serial",
    "mac_address",
    "raw_device_id",
    "token",
    "private_key",
    "ip_address",
    "user_agent",
  ]) {
    assert.doesNotMatch(migration, new RegExp(`\\b${forbiddenColumn}\\b`, "i"));
  }
});

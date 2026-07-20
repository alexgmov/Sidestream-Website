import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  deriveActivationTokenPair,
  deriveRefreshRotationTokens,
  normalizeCredentialDeviceScope,
} from "../api/_lib/entitlement.ts";
import {
  evaluateDeviceCredentialBinding,
  isCredentialGenerationCurrent,
  normalizeDevicePlatform,
} from "../api/_lib/device-policy.ts";

const productionDevice = {
  namespace: "production",
  deviceIdHash: "a".repeat(64),
  revokedAt: null,
  revocationReason: null,
};

test("new credential families are deterministic and bound to namespace plus generation", () => {
  const productionGenerationOne = {
    licenseNamespace: "production",
    deviceGeneration: 1,
  };
  const activation = deriveActivationTokenPair(
    "activation-1",
    "device-1",
    "secret",
    productionGenerationOne,
  );
  assert.deepEqual(
    activation,
    deriveActivationTokenPair(
      "activation-1",
      "device-1",
      "secret",
      productionGenerationOne,
    ),
  );
  assert.notDeepEqual(
    activation,
    deriveActivationTokenPair("activation-1", "device-1", "secret", {
      licenseNamespace: "production",
      deviceGeneration: 2,
    }),
  );
  assert.notDeepEqual(
    activation,
    deriveActivationTokenPair("activation-1", "device-1", "secret", {
      licenseNamespace: "test",
      deviceGeneration: 1,
    }),
  );

  const refresh = deriveRefreshRotationTokens(
    "refresh-1",
    "secret",
    productionGenerationOne,
  );
  assert.deepEqual(
    refresh,
    deriveRefreshRotationTokens("refresh-1", "secret", productionGenerationOne),
  );
  assert.notDeepEqual(
    refresh,
    deriveRefreshRotationTokens("refresh-1", "secret", {
      licenseNamespace: "test",
      deviceGeneration: 1,
    }),
  );

  assert.deepEqual(normalizeCredentialDeviceScope({
    licenseNamespace: "production",
    deviceGeneration: "12",
  }), {
    licenseNamespace: "production",
    deviceGeneration: "12",
  });
  assert.throws(() => normalizeCredentialDeviceScope({
    licenseNamespace: "production",
    deviceGeneration: 0,
  }), /generation/i);
});

test("unscoped deterministic derivation remains available for legacy response replay", () => {
  const activation = deriveActivationTokenPair("activation-1", "device-1", "secret");
  assert.deepEqual(
    activation,
    deriveActivationTokenPair("activation-1", "device-1", "secret"),
  );
  const refresh = deriveRefreshRotationTokens("refresh-1", "secret");
  assert.deepEqual(refresh, deriveRefreshRotationTokens("refresh-1", "secret"));
});

test("credential binding distinguishes observation from definitive replacement", () => {
  const current = evaluateDeviceCredentialBinding({
    namespace: "production",
    requestedDeviceIdHash: productionDevice.deviceIdHash,
    activeDevice: productionDevice,
    latestRequestedDevice: productionDevice,
    credentialCreatedAt: "2026-07-14T19:01:00.000Z",
    activeDeviceActivatedAt: "2026-07-14T19:00:00.000Z",
    mode: "enforce",
  });
  assert.deepEqual(current, {
    allowed: true,
    publicErrorCode: null,
    observedErrorCode: null,
    definitive: false,
  });

  const observed = evaluateDeviceCredentialBinding({
    namespace: "production",
    requestedDeviceIdHash: "b".repeat(64),
    activeDevice: productionDevice,
    latestRequestedDevice: null,
    credentialCreatedAt: "2026-07-14T19:01:00.000Z",
    activeDeviceActivatedAt: "2026-07-14T19:00:00.000Z",
    mode: "observe",
  });
  assert.deepEqual(observed, {
    allowed: true,
    publicErrorCode: null,
    observedErrorCode: "device_replaced",
    definitive: false,
  });

  const staleObservedCredential = evaluateDeviceCredentialBinding({
    namespace: "production",
    requestedDeviceIdHash: "b".repeat(64),
    activeDevice: productionDevice,
    latestRequestedDevice: null,
    credentialCreatedAt: "2026-07-14T18:59:59.999Z",
    activeDeviceActivatedAt: "2026-07-14T19:00:00.000Z",
    mode: "observe",
  });
  assert.deepEqual(staleObservedCredential, {
    allowed: false,
    publicErrorCode: "device_replaced",
    observedErrorCode: null,
    definitive: true,
  });

  const replaced = evaluateDeviceCredentialBinding({
    namespace: "production",
    requestedDeviceIdHash: "b".repeat(64),
    activeDevice: productionDevice,
    latestRequestedDevice: {
      namespace: "production",
      deviceIdHash: "b".repeat(64),
      revokedAt: "2026-07-14T19:02:00.000Z",
      revocationReason: "replaced",
    },
    credentialCreatedAt: "2026-07-14T19:01:00.000Z",
    activeDeviceActivatedAt: "2026-07-14T19:03:00.000Z",
    mode: "observe",
  });
  assert.deepEqual(replaced, {
    allowed: false,
    publicErrorCode: "device_replaced",
    observedErrorCode: null,
    definitive: true,
  });
});

test("generation comparison and coarse platform metadata are fail closed", () => {
  assert.equal(isCredentialGenerationCurrent({
    credentialCreatedAt: "2026-07-14T19:00:00.000Z",
    deviceActivatedAt: "2026-07-14T19:00:00.000Z",
  }), true);
  assert.equal(isCredentialGenerationCurrent({
    credentialCreatedAt: "2026-07-14T18:59:59.999Z",
    deviceActivatedAt: "2026-07-14T19:00:00.000Z",
  }), false);
  assert.equal(isCredentialGenerationCurrent({
    credentialCreatedAt: "invalid",
    deviceActivatedAt: "2026-07-14T19:00:00.000Z",
  }), false);
  assert.equal(normalizeDevicePlatform("darwin"), "macos");
  assert.equal(normalizeDevicePlatform("win32"), "windows");
  assert.equal(normalizeDevicePlatform("linux"), "unknown");
});

test("account core serializes every credential path on the account namespace", async () => {
  const source = await readFile(new URL("../api/_lib/account.ts", import.meta.url), "utf8");
  assert.match(source, /ACCOUNT_DEVICE_LOCK_PREFIX = "sidestream:device-support"/);
  assert.match(source, /getAccountDeviceLockKey\(accountId, environment\.namespace\)/);
  assert.match(source, /from public\.sidestream_account_devices[\s\S]+for update/i);
  assert.match(source, /insert into public\.sidestream_account_devices/i);
  assert.match(source, /count\(\*\)::text as device_generation/i);
  assert.match(source, /purpose: options\.previouslyIssuedAt \? "credential" : "activation"/);
  assert.match(source, /deriveActivationTokenPair\([\s\S]+deviceScope/);
  assert.match(source, /deriveRefreshRotationTokens\([\s\S]+deviceScope/);
  assert.match(source, /sidestream_device_policy_observation/);

  const activationStatusStart = source.indexOf("export async function getActivationStatus");
  const activationStatusEnd = source.indexOf("export async function verifyLicenseToken");
  assert.ok(activationStatusStart >= 0 && activationStatusEnd > activationStatusStart);
  const activationStatus = source.slice(activationStatusStart, activationStatusEnd);
  const activeLicenseOrder = activationStatus.indexOf(
    "when license_state.entitlement_status = 'active'",
  );
  const issuance = activationStatus.indexOf("const issued = schema.accountDevices");
  assert.ok(activeLicenseOrder >= 0 && activeLicenseOrder < issuance);

  const bindingCheck = source.indexOf("const activationBinding = await checkActivationDeviceBinding");
  const replayCutoff = source.indexOf("!isActivationTokenReplayAllowed", bindingCheck);
  assert.ok(bindingCheck >= 0 && replayCutoff > bindingCheck);
});

test("confirmed transfer is one transaction with CAS, total family revocation, and one audit", async () => {
  const source = await readFile(new URL("../api/_lib/account.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function confirmAccountDeviceTransfer");
  const end = source.indexOf("async function findAccountIdByStripeCustomer", start);
  assert.ok(start >= 0 && end > start);
  const transfer = source.slice(start, end);

  const lock = transfer.indexOf("pg_advisory_xact_lock");
  const rowLock = transfer.indexOf("for update");
  const revokePrior = transfer.indexOf("revocation_reason = 'replaced'");
  const revokeFamilies = transfer.indexOf("update public.sidestream_license_tokens");
  const insertDevice = transfer.indexOf("insert into public.sidestream_account_devices");
  const audit = transfer.indexOf("insert into public.sidestream_device_transfers");
  const commit = transfer.lastIndexOf('client.query("commit")');
  assert.ok(
    lock >= 0 && rowLock > lock && revokePrior > rowLock &&
      revokeFamilies > revokePrior && insertDevice > revokeFamilies &&
      audit > insertDevice && commit > audit,
  );
  assert.match(transfer, /safeEqual\(priorDevice\.id, options\.expectedPriorDeviceId\)/);
  assert.match(transfer, /and device_id_hash = \$4[\s\S]+and revoked_at is null/);
  assert.match(
    transfer,
    /where account_id = \$1\s+and revoked_at is null/,
    "the namespace-selected database must revoke every live family for the account",
  );
  assert.equal((transfer.match(/insert into public\.sidestream_device_transfers/g) || []).length, 1);
});

test("license routes resolve trusted deployment state and fail closed before core calls", async () => {
  for (const route of [
    "../api/activation/status.ts",
    "../api/license/verify.ts",
    "../api/license/refresh.ts",
  ]) {
    const source = await readFile(new URL(route, import.meta.url), "utf8");
    assert.match(source, /resolveRequestLicenseEnvironment\(request\)/);
    assert.match(source, /license_environment_unavailable/);
    assert.match(source, /method !== "POST"/);
  }

  const source = await readFile(new URL("../api/_lib/account.ts", import.meta.url), "utf8");
  assert.match(source, /trustedRequestHost: firstHeaderValue\(request\.headers\.host\)/);
  assert.match(source, /environment\.namespace !== trustedServerEnvironment\.namespace/);
  assert.match(source, /environment\.database\.connectionString/);
});

test("device HMAC secret and read-only activation context remain backward compatible", async () => {
  const source = await readFile(new URL("../api/_lib/account.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /SIDESTREAM_LICENSE_HASH_SECRET \|\|\s+getOptionalPostgresConnectionString\(\) \|\|\s+"sidestream-license-dev-salt"/,
  );
  assert.match(
    source,
    /createHmac\("sha256", getPrivateServerSecret\(\)\)\.update\(value\)\.digest\("hex"\)/,
  );

  const contextStart = source.indexOf("export async function getActivationClaimContext");
  const contextEnd = source.indexOf("export async function claimActivationToAccount", contextStart);
  const context = source.slice(contextStart, contextEnd);
  assert.doesNotMatch(context, /\b(insert|update|delete)\b/i);
});

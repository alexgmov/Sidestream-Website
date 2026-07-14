export const DEVICE_NAMESPACES = ["production", "test"] as const;
export type DeviceNamespace = (typeof DEVICE_NAMESPACES)[number];

export const DEVICE_POLICY_MODES = ["off", "observe", "enforce"] as const;
export type DevicePolicyMode = (typeof DEVICE_POLICY_MODES)[number];

export const DEFAULT_DEVICE_POLICY_MODE: DevicePolicyMode = "observe";

export const DEVICE_POLICY_ERROR_CODES = {
  TRANSFER_REQUIRED: "transfer_required",
  TRANSFER_LIMIT_REACHED: "transfer_limit_reached",
  DEVICE_DEACTIVATED: "device_deactivated",
  DEVICE_REPLACED: "device_replaced",
} as const;

export type DevicePolicyErrorCode =
  (typeof DEVICE_POLICY_ERROR_CODES)[keyof typeof DEVICE_POLICY_ERROR_CODES];

export const DEFAULT_DEVICE_TRANSFER_LIMIT = 3;
export const MAX_DEVICE_TRANSFER_LIMIT = 10;
export const DEVICE_TRANSFER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type DeviceHistoryRecord = Readonly<{
  id: string;
  deviceIdHash: string;
  activatedAt: Date | string | number;
}>;

export type DeviceTransferRecord = Readonly<{
  fromDeviceId: string;
  toDeviceId: string;
  transferredAt: Date | string | number;
}>;

export type AccountDevicePolicyRecord = Readonly<{
  namespace: DeviceNamespace;
  deviceIdHash: string;
  revokedAt: Date | string | number | null;
  revocationReason?: DeviceRevocationReason | null;
}>;

export type DeviceRevocationReason = "deactivated" | "replaced";
export type DevicePlatform = "macos" | "windows" | "unknown";

export type DeviceActivationDecision =
  | { decision: "activate"; errorCode: null }
  | { decision: "same_device"; errorCode: null }
  | {
    decision: "transfer_required";
    errorCode: typeof DEVICE_POLICY_ERROR_CODES.TRANSFER_REQUIRED;
  };

export function selectDeviceNamespace(options: {
  trustedDeploymentEnvironment: unknown;
  allowTestNamespace?: boolean;
}): DeviceNamespace | null {
  const environment = typeof options.trustedDeploymentEnvironment === "string"
    ? options.trustedDeploymentEnvironment.trim().toLowerCase()
    : "";

  if (environment === "production") return "production";
  if (
    options.allowTestNamespace === true &&
    (environment === "preview" ||
      environment === "development" ||
      environment === "test")
  ) {
    return "test";
  }

  return null;
}

export function resolveDevicePolicyMode(value: unknown): DevicePolicyMode {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "off" || normalized === "observe" || normalized === "enforce") {
    return normalized;
  }

  return DEFAULT_DEVICE_POLICY_MODE;
}

export function isSameAccountDevice(options: {
  namespace: DeviceNamespace;
  requestedDeviceIdHash: string;
  activeDevice: AccountDevicePolicyRecord | null;
}) {
  const { activeDevice } = options;
  return activeDevice !== null &&
    activeDevice.revokedAt === null &&
    activeDevice.namespace === options.namespace &&
    opaqueIdsMatch(activeDevice.deviceIdHash, options.requestedDeviceIdHash);
}

export function decideDeviceActivation(options: {
  namespace: DeviceNamespace;
  requestedDeviceIdHash: string;
  activeDevice: AccountDevicePolicyRecord | null;
}): DeviceActivationDecision {
  if (
    options.activeDevice === null ||
    options.activeDevice.revokedAt !== null ||
    options.activeDevice.namespace !== options.namespace
  ) {
    return { decision: "activate", errorCode: null };
  }

  if (isSameAccountDevice(options)) {
    return { decision: "same_device", errorCode: null };
  }

  return {
    decision: "transfer_required",
    errorCode: DEVICE_POLICY_ERROR_CODES.TRANSFER_REQUIRED,
  };
}

export function resolveDeviceTransferLimit(value: unknown) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return DEFAULT_DEVICE_TRANSFER_LIMIT;
  }

  return Math.min(parsed, MAX_DEVICE_TRANSFER_LIMIT);
}

export function evaluateDeviceTransferLimit(options: {
  transferTimestampsMs: readonly number[];
  nowMs: number;
  configuredLimit?: unknown;
}) {
  if (!Number.isFinite(options.nowMs)) {
    throw new TypeError("nowMs must be a finite timestamp");
  }

  const limit = resolveDeviceTransferLimit(options.configuredLimit);
  const windowStartedAtMs = options.nowMs - DEVICE_TRANSFER_WINDOW_MS;
  const transferCount = options.transferTimestampsMs.reduce((count, timestamp) => {
    if (
      Number.isFinite(timestamp) &&
      timestamp >= windowStartedAtMs &&
      timestamp <= options.nowMs
    ) {
      return count + 1;
    }
    return count;
  }, 0);
  const limitReached = transferCount >= limit;

  return {
    allowed: !limitReached,
    errorCode: limitReached
      ? DEVICE_POLICY_ERROR_CODES.TRANSFER_LIMIT_REACHED
      : null,
    limit,
    transferCount,
    remainingTransfers: Math.max(0, limit - transferCount),
    windowStartedAtMs,
  } as const;
}

export function getConfirmedDeviceMoveTimestamps(options: {
  devices: readonly DeviceHistoryRecord[];
  transfers?: readonly DeviceTransferRecord[];
}) {
  const devicesById = new Map(options.devices.map((device) => [device.id, device]));
  const movesByDestination = new Map<string, number>();
  let previousHash = "";

  for (const device of options.devices) {
    const activatedAtMs = timestampMs(device.activatedAt);
    if (
      previousHash &&
      previousHash !== device.deviceIdHash &&
      activatedAtMs !== null
    ) {
      movesByDestination.set(device.id, activatedAtMs);
    }
    previousHash = device.deviceIdHash;
  }

  for (const transfer of options.transfers || []) {
    const fromDevice = devicesById.get(transfer.fromDeviceId);
    const toDevice = devicesById.get(transfer.toDeviceId);
    const transferredAtMs = timestampMs(transfer.transferredAt);
    if (
      fromDevice &&
      toDevice &&
      fromDevice.deviceIdHash !== toDevice.deviceIdHash &&
      transferredAtMs !== null
    ) {
      movesByDestination.set(toDevice.id, transferredAtMs);
    }
  }

  return [...movesByDestination.values()];
}

export function getDeviceTransferLimitOverride(
  features: Record<string, unknown> | null | undefined,
  namespace: DeviceNamespace,
  nowMs: number,
) {
  const policy = asRecord(features?.singleDevicePolicy);
  const overrides = asRecord(policy?.transferLimitOverrides);
  const override = asRecord(overrides?.[namespace]);
  const expiresAtMs = timestampMs(String(override?.expiresAt || ""));
  return Number.isSafeInteger(override?.limit) &&
      Number(override?.limit) > 0 &&
      expiresAtMs !== null &&
      expiresAtMs > nowMs
    ? Number(override?.limit)
    : undefined;
}

export function applyDevicePolicyMode(options: {
  mode?: unknown;
  errorCode: DevicePolicyErrorCode | null;
}) {
  const mode = resolveDevicePolicyMode(options.mode);
  const enforcementError = mode === "enforce" ? options.errorCode : null;
  const observedError = mode === "observe" ? options.errorCode : null;

  return {
    mode,
    allowed: enforcementError === null,
    publicErrorCode: enforcementError,
    observedErrorCode: observedError,
  } as const;
}

export function getDeviceRevocationErrorCode(reason: DeviceRevocationReason) {
  return reason === "replaced"
    ? DEVICE_POLICY_ERROR_CODES.DEVICE_REPLACED
    : DEVICE_POLICY_ERROR_CODES.DEVICE_DEACTIVATED;
}

export function normalizeDevicePlatform(value: unknown): DevicePlatform {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["mac", "macos", "darwin", "osx"].includes(normalized)) return "macos";
  if (["win", "win32", "win64", "windows"].includes(normalized)) return "windows";
  return "unknown";
}

export function isCredentialGenerationCurrent(options: {
  credentialCreatedAt: Date | string | number;
  deviceActivatedAt: Date | string | number;
}) {
  const credentialCreatedAtMs = timestampMs(options.credentialCreatedAt);
  const deviceActivatedAtMs = timestampMs(options.deviceActivatedAt);
  return credentialCreatedAtMs !== null &&
    deviceActivatedAtMs !== null &&
    credentialCreatedAtMs >= deviceActivatedAtMs;
}

export function evaluateDeviceCredentialBinding(options: {
  namespace: DeviceNamespace;
  requestedDeviceIdHash: string;
  activeDevice: AccountDevicePolicyRecord | null;
  latestRequestedDevice: AccountDevicePolicyRecord | null;
  credentialCreatedAt: Date | string | number;
  activeDeviceActivatedAt?: Date | string | number | null;
  mode?: unknown;
}) {
  const latestRequestedDevice = options.latestRequestedDevice;
  if (latestRequestedDevice && latestRequestedDevice.revokedAt !== null) {
    const publicErrorCode = getDeviceRevocationErrorCode(
      latestRequestedDevice.revocationReason === "deactivated"
        ? "deactivated"
        : "replaced",
    );
    return {
      allowed: false,
      publicErrorCode,
      observedErrorCode: null,
      definitive: true,
    } as const;
  }

  if (
    options.activeDevice &&
    options.activeDeviceActivatedAt !== null &&
    options.activeDeviceActivatedAt !== undefined &&
    !isCredentialGenerationCurrent({
      credentialCreatedAt: options.credentialCreatedAt,
      deviceActivatedAt: options.activeDeviceActivatedAt,
    })
  ) {
    return {
      allowed: false,
      publicErrorCode: DEVICE_POLICY_ERROR_CODES.DEVICE_REPLACED,
      observedErrorCode: null,
      definitive: true,
    } as const;
  }

  if (
    options.activeDevice &&
    isSameAccountDevice({
      namespace: options.namespace,
      requestedDeviceIdHash: options.requestedDeviceIdHash,
      activeDevice: options.activeDevice,
    })
  ) {
    return {
      allowed: true,
      publicErrorCode: null,
      observedErrorCode: null,
      definitive: false,
    } as const;
  }

  const candidateErrorCode = options.activeDevice
    ? DEVICE_POLICY_ERROR_CODES.DEVICE_REPLACED
    : DEVICE_POLICY_ERROR_CODES.DEVICE_DEACTIVATED;
  const policy = applyDevicePolicyMode({
    mode: options.mode,
    errorCode: candidateErrorCode,
  });
  return {
    allowed: policy.allowed,
    publicErrorCode: policy.publicErrorCode,
    observedErrorCode: policy.observedErrorCode,
    definitive: false,
  } as const;
}

function opaqueIdsMatch(left: string, right: string) {
  if (!left || left.length !== right.length) return false;

  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function timestampMs(value: Date | string | number) {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

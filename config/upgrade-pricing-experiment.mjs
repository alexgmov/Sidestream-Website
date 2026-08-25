export const UPGRADE_PRICING_LEGACY_EXPERIMENT_ID = "upgrade-pricing-v1";
export const UPGRADE_PRICING_EXPERIMENT_ID = "upgrade-pricing-v2";
export const UPGRADE_PRICING_CONTROL_VARIANT = "control_one_time";
export const UPGRADE_PRICING_MONTHLY_VARIANT = "monthly_half";
export const UPGRADE_PRICING_ANNUAL_VARIANT = "annual_same_price";

export const UPGRADE_PRICING_EXPERIMENT_CONFIG = Object.freeze({
  experimentId: UPGRADE_PRICING_EXPERIMENT_ID,
  assignmentVersion: 2,
  bucketCount: 10_000,
  enabledEnvironmentVariable: "SIDESTREAM_UPGRADE_PRICING_V2_ENABLED",
  rolloutEnvironmentVariable: "SIDESTREAM_UPGRADE_PRICING_V2_ROLLOUT_BPS",
  secretEnvironmentVariable: "SIDESTREAM_UPGRADE_PRICING_V2_SECRET",
  defaultEnabled: false,
  defaultRolloutBasisPoints: 0,
  openedAt: null,
  closedAt: null,
  variants: Object.freeze([
    UPGRADE_PRICING_CONTROL_VARIANT,
    UPGRADE_PRICING_ANNUAL_VARIANT,
  ]),
});

/**
 * Reads only server process configuration. Browser values are deliberately not
 * accepted as an input to the rollout decision.
 */
export function readUpgradePricingRollout(environment = process.env) {
  if (UPGRADE_PRICING_EXPERIMENT_CONFIG.closedAt) {
    return Object.freeze({
      enabled: false,
      rolloutBasisPoints: 0,
      reason: "kill_switch",
    });
  }

  const enabledValue = cleanEnvironmentValue(
    environment[UPGRADE_PRICING_EXPERIMENT_CONFIG.enabledEnvironmentVariable],
  );
  const enabled = enabledValue === ""
    ? UPGRADE_PRICING_EXPERIMENT_CONFIG.defaultEnabled
    : enabledValue === "true";
  if (!enabled) {
    return Object.freeze({
      enabled: false,
      rolloutBasisPoints: 0,
      reason: enabledValue === "" || enabledValue === "false"
        ? "kill_switch"
        : "invalid_enabled_configuration",
    });
  }

  const rolloutValue = cleanEnvironmentValue(
    environment[UPGRADE_PRICING_EXPERIMENT_CONFIG.rolloutEnvironmentVariable],
  );
  if (rolloutValue === "") {
    return Object.freeze({
      enabled: true,
      rolloutBasisPoints: UPGRADE_PRICING_EXPERIMENT_CONFIG.defaultRolloutBasisPoints,
      reason: "source_default",
    });
  }
  if (!/^\d{1,5}$/.test(rolloutValue)) {
    return Object.freeze({
      enabled: false,
      rolloutBasisPoints: 0,
      reason: "invalid_rollout_configuration",
    });
  }
  const rolloutBasisPoints = Number(rolloutValue);
  if (!Number.isInteger(rolloutBasisPoints) || rolloutBasisPoints > 10_000) {
    return Object.freeze({
      enabled: false,
      rolloutBasisPoints: 0,
      reason: "invalid_rollout_configuration",
    });
  }
  return Object.freeze({
    enabled: true,
    rolloutBasisPoints,
    reason: rolloutBasisPoints === 0 ? "rollout_zero" : "configured",
  });
}

function cleanEnvironmentValue(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

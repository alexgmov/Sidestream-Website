import { createHmac } from "node:crypto";
import { SIDESTREAM_PRICING_CONTRACT } from "../../config/pricing-contract.mjs";
// The runtime contract is intentionally dependency-free JavaScript so operator
// and test code can read it without compiling the API TypeScript graph.
// @ts-expect-error The owned config surface is an .mjs runtime contract.
import * as upgradePricingConfig from "../../config/upgrade-pricing-experiment.mjs";

const {
  readUpgradePricingRollout,
  UPGRADE_PRICING_ANNUAL_VARIANT,
  UPGRADE_PRICING_CONTROL_VARIANT,
  UPGRADE_PRICING_EXPERIMENT_CONFIG,
  UPGRADE_PRICING_EXPERIMENT_ID,
  UPGRADE_PRICING_LEGACY_EXPERIMENT_ID,
  UPGRADE_PRICING_MONTHLY_VARIANT,
} = upgradePricingConfig;

export {
  UPGRADE_PRICING_ANNUAL_VARIANT,
  UPGRADE_PRICING_CONTROL_VARIANT,
  UPGRADE_PRICING_EXPERIMENT_ID,
  UPGRADE_PRICING_LEGACY_EXPERIMENT_ID,
  UPGRADE_PRICING_MONTHLY_VARIANT,
};

export type UpgradePricingExperimentId =
  | "upgrade-pricing-v1"
  | "upgrade-pricing-v2";
export type UpgradePricingVariant =
  | "control_one_time"
  | "monthly_half"
  | "annual_same_price";
export type UpgradePricingBillingModel = "one_time" | "subscription";
export type UpgradePricingRecurringInterval = "month" | "year";

export type UpgradePricingPersistedAssignment = Readonly<{
  assignmentId: string;
  assignmentVersion: 1 | 2;
  experimentId: UpgradePricingExperimentId;
  accountId: string;
  variant: UpgradePricingVariant;
  billingModel: UpgradePricingBillingModel;
  bucket: number;
  rolloutBasisPoints: number;
  assignedAt: Date | string;
}>;

export type UpgradePricingDecisionReason =
  | "existing_assignment"
  | "rollout_control"
  | "rollout_monthly"
  | "rollout_annual"
  | "kill_switch"
  | "rollout_zero"
  | "assignment_unavailable"
  | "unsupported_currency";

export type UpgradePricingDecision = Readonly<{
  experimentId: UpgradePricingExperimentId;
  assignmentVersion: 1 | 2;
  accountId: string;
  variant: UpgradePricingVariant;
  billingModel: UpgradePricingBillingModel;
  assignedVariant: UpgradePricingVariant | null;
  bucket: number | null;
  rolloutBasisPoints: number;
  recurringAmountMinor: number | null;
  recurringInterval: UpgradePricingRecurringInterval | null;
  reason: UpgradePricingDecisionReason;
  assignmentId: string | null;
  assignedAt: string | null;
  shouldPersistAssignment: boolean;
  recurringCohortEligible: boolean;
  usedExistingAssignment: boolean;
}>;

export class UpgradePricingExperimentError extends Error {
  readonly code: "invalid_offer" | "unsupported_currency";

  constructor(code: "invalid_offer" | "unsupported_currency", message: string) {
    super(message);
    this.name = "UpgradePricingExperimentError";
    this.code = code;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MINIMUM_ASSIGNMENT_SECRET_BYTES = 32;

/**
 * Monthly candidates must match an exact current server-owned catalog offer.
 * Keeping the recurring amount explicit prevents a later one-time price edit
 * from silently repricing subscriptions. The legacy `monthly_half` variant ID
 * remains stable for persisted assignments and historical Stripe metadata.
 */
export function deriveMonthlyOfferAmount(
  currencyValue: unknown,
  oneTimeAmountMinorValue: unknown,
): number {
  const currency = typeof currencyValue === "string"
    ? currencyValue.trim().toLowerCase()
    : "";
  const oneTimeAmountMinor = Number(oneTimeAmountMinorValue);
  if (!Number.isSafeInteger(oneTimeAmountMinor) || oneTimeAmountMinor <= 0) {
    throw new UpgradePricingExperimentError(
      "invalid_offer",
      "The server-owned one-time amount must be a positive safe integer",
    );
  }
  const currencyOffers = SIDESTREAM_PRICING_CONTRACT.checkoutCatalog.filter(
    (offer) => offer.currency === currency,
  );
  if (currencyOffers.length === 0) {
    throw new UpgradePricingExperimentError(
      "unsupported_currency",
      "The one-time offer currency has no approved monthly offer",
    );
  }
  const offer = currencyOffers.find(
    (candidate) => candidate.amountMinor === oneTimeAmountMinor,
  );
  if (
    !offer ||
    !Number.isSafeInteger(offer.monthlyAmountMinor) ||
    offer.monthlyAmountMinor <= 0
  ) {
    throw new UpgradePricingExperimentError(
      "invalid_offer",
      "The server-owned one-time offer has no exact approved monthly amount",
    );
  }
  return offer.monthlyAmountMinor;
}

export const deriveMonthlyHalfAmount = deriveMonthlyOfferAmount;
export const roundUpgradePricingMonthlyAmount = deriveMonthlyOfferAmount;
export const deriveMonthlyHalfAmountMinor = deriveMonthlyOfferAmount;

/**
 * The v2 treatment matches the current one-time amount and is available only
 * for a catalog entry with explicit annual terms. Today that is the global USD
 * offer; regional offers stay one-time and outside the annual cohort.
 */
export function deriveAnnualOfferAmount(
  currencyValue: unknown,
  oneTimeAmountMinorValue: unknown,
): number {
  const currency = typeof currencyValue === "string"
    ? currencyValue.trim().toLowerCase()
    : "";
  const oneTimeAmountMinor = Number(oneTimeAmountMinorValue);
  if (!Number.isSafeInteger(oneTimeAmountMinor) || oneTimeAmountMinor <= 0) {
    throw new UpgradePricingExperimentError(
      "invalid_offer",
      "The server-owned one-time amount must be a positive safe integer",
    );
  }
  const offer = SIDESTREAM_PRICING_CONTRACT.checkoutCatalog.find(
    (candidate) =>
      candidate.currency === currency &&
      candidate.amountMinor === oneTimeAmountMinor,
  );
  if (!offer) {
    throw new UpgradePricingExperimentError(
      "unsupported_currency",
      "The one-time offer currency has no approved annual offer",
    );
  }
  if (
    !Number.isSafeInteger(offer.annualAmountMinor) ||
    (offer.annualAmountMinor || 0) <= 0 ||
    !offer.annualPriceSource
  ) {
    throw new UpgradePricingExperimentError(
      "invalid_offer",
      "The server-owned one-time offer has no exact approved annual amount",
    );
  }
  return offer.annualAmountMinor!;
}

export function upgradePricingBucket(options: {
  accountId: unknown;
  secret: unknown;
}): number {
  const accountId = normalizeAccountId(options.accountId);
  const secret = normalizeAssignmentSecret(options.secret);
  const digest = createHmac("sha256", secret)
    .update(`${UPGRADE_PRICING_EXPERIMENT_ID}\0${accountId}`, "utf8")
    .digest();
  return Number(
    digest.readBigUInt64BE(0) % BigInt(UPGRADE_PRICING_EXPERIMENT_CONFIG.bucketCount),
  );
}

export const getUpgradePricingBucket = upgradePricingBucket;

/**
 * Decides only accounts without a persisted v1 or v2 assignment. Historical
 * v1 assignments keep their original one-time/monthly terms. Any inability to
 * price the current annual treatment produces an explicit one-time fallback
 * that must not be counted as an annual assignment or exposure.
 */
export function decideUpgradePricing(options: {
  accountId: unknown;
  currency: unknown;
  oneTimeAmountMinor: unknown;
  existingAssignment?: UpgradePricingPersistedAssignment | null;
  environment?: NodeJS.ProcessEnv;
  enabled?: boolean;
  rolloutBasisPoints?: number;
  secret?: unknown;
}): UpgradePricingDecision {
  const accountId = typeof options.accountId === "string"
    ? options.accountId.trim().toLowerCase()
    : "";
  const rollout = explicitOrEnvironmentRollout(options);
  const existing = normalizeExistingAssignment(options.existingAssignment, accountId);

  if (options.existingAssignment && !existing) {
    return fallbackDecision({
      accountId,
      experimentId: UPGRADE_PRICING_EXPERIMENT_ID,
      assignmentVersion: UPGRADE_PRICING_EXPERIMENT_CONFIG.assignmentVersion,
      assignedVariant: null,
      rolloutBasisPoints: rollout.rolloutBasisPoints,
      reason: "assignment_unavailable",
    });
  }

  if (existing) {
    if (
      existing.variant === UPGRADE_PRICING_MONTHLY_VARIANT ||
      existing.variant === UPGRADE_PRICING_ANNUAL_VARIANT
    ) {
      try {
        const recurringAmountMinor = existing.variant === UPGRADE_PRICING_MONTHLY_VARIANT
          ? deriveMonthlyOfferAmount(options.currency, options.oneTimeAmountMinor)
          : deriveAnnualOfferAmount(options.currency, options.oneTimeAmountMinor);
        return assignedDecision({
          accountId,
          existing,
          recurringAmountMinor,
          reason: "existing_assignment",
        });
      } catch (error) {
        if (error instanceof UpgradePricingExperimentError) {
          return fallbackDecision({
            accountId,
            experimentId: existing.experimentId,
            assignmentVersion: existing.assignmentVersion,
            assignedVariant: existing.variant,
            rolloutBasisPoints: existing.rolloutBasisPoints,
            reason: decisionFailureReason(error),
          });
        }
        throw error;
      }
    }
    return assignedDecision({
      accountId,
      existing,
      recurringAmountMinor: null,
      reason: "existing_assignment",
    });
  }

  if (!rollout.enabled) {
    return fallbackDecision({
      accountId,
      experimentId: UPGRADE_PRICING_EXPERIMENT_ID,
      assignmentVersion: UPGRADE_PRICING_EXPERIMENT_CONFIG.assignmentVersion,
      assignedVariant: null,
      rolloutBasisPoints: 0,
      reason: rollout.reason === "kill_switch"
        ? "kill_switch"
        : "assignment_unavailable",
    });
  }

  let bucket: number;
  try {
    bucket = upgradePricingBucket({
      accountId,
      secret: options.secret ?? options.environment?.[
        UPGRADE_PRICING_EXPERIMENT_CONFIG.secretEnvironmentVariable
      ] ?? process.env[UPGRADE_PRICING_EXPERIMENT_CONFIG.secretEnvironmentVariable],
    });
  } catch {
    return fallbackDecision({
      accountId,
      experimentId: UPGRADE_PRICING_EXPERIMENT_ID,
      assignmentVersion: UPGRADE_PRICING_EXPERIMENT_CONFIG.assignmentVersion,
      assignedVariant: null,
      rolloutBasisPoints: rollout.rolloutBasisPoints,
      reason: "assignment_unavailable",
    });
  }

  const annualSelected = bucket < rollout.rolloutBasisPoints;
  if (!annualSelected) {
    return newAssignmentDecision({
      accountId,
      bucket,
      rolloutBasisPoints: rollout.rolloutBasisPoints,
      variant: UPGRADE_PRICING_CONTROL_VARIANT,
      recurringAmountMinor: null,
      reason: rollout.rolloutBasisPoints === 0 ? "rollout_zero" : "rollout_control",
    });
  }

  try {
    return newAssignmentDecision({
      accountId,
      bucket,
      rolloutBasisPoints: rollout.rolloutBasisPoints,
      variant: UPGRADE_PRICING_ANNUAL_VARIANT,
      recurringAmountMinor: deriveAnnualOfferAmount(
        options.currency,
        options.oneTimeAmountMinor,
      ),
      reason: "rollout_annual",
    });
  } catch (error) {
    if (!(error instanceof UpgradePricingExperimentError)) throw error;
    return fallbackDecision({
      accountId,
      experimentId: UPGRADE_PRICING_EXPERIMENT_ID,
      assignmentVersion: UPGRADE_PRICING_EXPERIMENT_CONFIG.assignmentVersion,
      assignedVariant: null,
      rolloutBasisPoints: rollout.rolloutBasisPoints,
      reason: decisionFailureReason(error),
    });
  }
}

export const decideUpgradePricingAssignment = decideUpgradePricing;

function explicitOrEnvironmentRollout(options: {
  enabled?: boolean;
  rolloutBasisPoints?: number;
  environment?: NodeJS.ProcessEnv;
}) {
  if (options.enabled === undefined && options.rolloutBasisPoints === undefined) {
    return readUpgradePricingRollout(options.environment || process.env);
  }
  const enabled = options.enabled === true;
  const rolloutBasisPoints = Number(options.rolloutBasisPoints);
  if (!enabled) {
    return { enabled: false, rolloutBasisPoints: 0, reason: "kill_switch" };
  }
  if (
    !Number.isInteger(rolloutBasisPoints) ||
    rolloutBasisPoints < 0 ||
    rolloutBasisPoints > UPGRADE_PRICING_EXPERIMENT_CONFIG.bucketCount
  ) {
    return {
      enabled: false,
      rolloutBasisPoints: 0,
      reason: "invalid_rollout_configuration",
    };
  }
  return { enabled: true, rolloutBasisPoints, reason: "configured" };
}

function newAssignmentDecision(options: {
  accountId: string;
  bucket: number;
  rolloutBasisPoints: number;
  variant: UpgradePricingVariant;
  recurringAmountMinor: number | null;
  reason: UpgradePricingDecisionReason;
}): UpgradePricingDecision {
  return Object.freeze({
    experimentId: UPGRADE_PRICING_EXPERIMENT_ID,
    assignmentVersion: UPGRADE_PRICING_EXPERIMENT_CONFIG.assignmentVersion,
    accountId: options.accountId,
    variant: options.variant,
    billingModel: billingModelForVariant(options.variant),
    assignedVariant: options.variant,
    bucket: options.bucket,
    rolloutBasisPoints: options.rolloutBasisPoints,
    recurringAmountMinor: options.recurringAmountMinor,
    recurringInterval: recurringIntervalForVariant(options.variant),
    reason: options.reason,
    assignmentId: null,
    assignedAt: null,
    shouldPersistAssignment: true,
    recurringCohortEligible: options.variant === UPGRADE_PRICING_ANNUAL_VARIANT,
    usedExistingAssignment: false,
  });
}

function assignedDecision(options: {
  accountId: string;
  existing: UpgradePricingPersistedAssignment;
  recurringAmountMinor: number | null;
  reason: UpgradePricingDecisionReason;
}): UpgradePricingDecision {
  return Object.freeze({
    experimentId: options.existing.experimentId,
    assignmentVersion: options.existing.assignmentVersion,
    accountId: options.accountId,
    variant: options.existing.variant,
    billingModel: options.existing.billingModel,
    assignedVariant: options.existing.variant,
    bucket: options.existing.bucket,
    rolloutBasisPoints: options.existing.rolloutBasisPoints,
    recurringAmountMinor: options.recurringAmountMinor,
    recurringInterval: recurringIntervalForVariant(options.existing.variant),
    reason: options.reason,
    assignmentId: options.existing.assignmentId,
    assignedAt: new Date(options.existing.assignedAt).toISOString(),
    shouldPersistAssignment: false,
    recurringCohortEligible:
      options.existing.variant === UPGRADE_PRICING_MONTHLY_VARIANT ||
      options.existing.variant === UPGRADE_PRICING_ANNUAL_VARIANT,
    usedExistingAssignment: true,
  });
}

function fallbackDecision(options: {
  accountId: string;
  experimentId: UpgradePricingExperimentId;
  assignmentVersion: 1 | 2;
  assignedVariant: UpgradePricingVariant | null;
  rolloutBasisPoints: number;
  reason: Extract<
    UpgradePricingDecisionReason,
    "kill_switch" | "assignment_unavailable" | "unsupported_currency"
  >;
}): UpgradePricingDecision {
  return Object.freeze({
    experimentId: options.experimentId,
    assignmentVersion: options.assignmentVersion,
    accountId: options.accountId,
    variant: UPGRADE_PRICING_CONTROL_VARIANT,
    billingModel: "one_time",
    assignedVariant: options.assignedVariant,
    bucket: null,
    rolloutBasisPoints: options.rolloutBasisPoints,
    recurringAmountMinor: null,
    recurringInterval: null,
    reason: options.reason,
    assignmentId: null,
    assignedAt: null,
    shouldPersistAssignment: false,
    recurringCohortEligible: false,
    usedExistingAssignment: options.assignedVariant !== null,
  });
}

function normalizeExistingAssignment(
  value: UpgradePricingPersistedAssignment | null | undefined,
  accountId: string,
): UpgradePricingPersistedAssignment | null {
  if (!value) return null;
  if (
    typeof value.assignmentId !== "string" ||
    typeof value.accountId !== "string" ||
    typeof value.experimentId !== "string" ||
    typeof value.variant !== "string" ||
    typeof value.billingModel !== "string" ||
    ![UPGRADE_PRICING_LEGACY_EXPERIMENT_ID, UPGRADE_PRICING_EXPERIMENT_ID]
      .includes(value.experimentId) ||
    (
      value.experimentId === UPGRADE_PRICING_LEGACY_EXPERIMENT_ID
        ? value.assignmentVersion !== 1
        : value.assignmentVersion !== 2
    ) ||
    value.accountId.trim().toLowerCase() !== accountId ||
    !UUID_PATTERN.test(value.assignmentId) ||
    !UUID_PATTERN.test(accountId) ||
    !Number.isInteger(value.bucket) ||
    value.bucket < 0 ||
    value.bucket >= UPGRADE_PRICING_EXPERIMENT_CONFIG.bucketCount ||
    !Number.isInteger(value.rolloutBasisPoints) ||
    value.rolloutBasisPoints < 0 ||
    value.rolloutBasisPoints > UPGRADE_PRICING_EXPERIMENT_CONFIG.bucketCount ||
    (
      value.variant === UPGRADE_PRICING_CONTROL_VARIANT
        ? value.billingModel !== "one_time"
        : [UPGRADE_PRICING_MONTHLY_VARIANT, UPGRADE_PRICING_ANNUAL_VARIANT]
            .includes(value.variant)
          ? value.billingModel !== "subscription"
          : true
    ) ||
    (
      value.experimentId === UPGRADE_PRICING_LEGACY_EXPERIMENT_ID
        ? ![UPGRADE_PRICING_CONTROL_VARIANT, UPGRADE_PRICING_MONTHLY_VARIANT]
            .includes(value.variant)
        : ![UPGRADE_PRICING_CONTROL_VARIANT, UPGRADE_PRICING_ANNUAL_VARIANT]
            .includes(value.variant)
    ) ||
    !Number.isFinite(new Date(value.assignedAt).getTime())
  ) {
    return null;
  }
  return value;
}

function billingModelForVariant(
  variant: UpgradePricingVariant,
): UpgradePricingBillingModel {
  if (variant === UPGRADE_PRICING_CONTROL_VARIANT) return "one_time";
  if (
    variant === UPGRADE_PRICING_MONTHLY_VARIANT ||
    variant === UPGRADE_PRICING_ANNUAL_VARIANT
  ) return "subscription";
  throw new Error("Invalid persisted Upgrade pricing variant");
}

function recurringIntervalForVariant(
  variant: UpgradePricingVariant,
): UpgradePricingRecurringInterval | null {
  if (variant === UPGRADE_PRICING_MONTHLY_VARIANT) return "month";
  if (variant === UPGRADE_PRICING_ANNUAL_VARIANT) return "year";
  return null;
}

export const upgradePricingBillingModelForVariant = billingModelForVariant;

function normalizeAccountId(value: unknown) {
  const accountId = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!UUID_PATTERN.test(accountId)) throw new Error("Invalid authenticated account ID");
  return accountId;
}

function normalizeAssignmentSecret(value: unknown) {
  const secret = typeof value === "string" ? value : "";
  if (Buffer.byteLength(secret, "utf8") < MINIMUM_ASSIGNMENT_SECRET_BYTES) {
    throw new Error("Upgrade pricing assignment secret is unavailable");
  }
  return secret;
}

function decisionFailureReason(error: UpgradePricingExperimentError) {
  return error.code === "unsupported_currency"
    ? "unsupported_currency" as const
    : "assignment_unavailable" as const;
}

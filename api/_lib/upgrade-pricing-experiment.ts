import { createHmac } from "node:crypto";
import { SIDESTREAM_PRICING_CONTRACT } from "../../config/pricing-contract.mjs";
// The runtime contract is intentionally dependency-free JavaScript so operator
// and test code can read it without compiling the API TypeScript graph.
// @ts-expect-error The owned config surface is an .mjs runtime contract.
import * as upgradePricingConfig from "../../config/upgrade-pricing-experiment.mjs";

const {
  readUpgradePricingRollout,
  UPGRADE_PRICING_CONTROL_VARIANT,
  UPGRADE_PRICING_EXPERIMENT_CONFIG,
  UPGRADE_PRICING_EXPERIMENT_ID,
  UPGRADE_PRICING_MONTHLY_VARIANT,
} = upgradePricingConfig;

export {
  UPGRADE_PRICING_CONTROL_VARIANT,
  UPGRADE_PRICING_EXPERIMENT_ID,
  UPGRADE_PRICING_MONTHLY_VARIANT,
};

export type UpgradePricingVariant =
  | "control_one_time"
  | "monthly_half";
export type UpgradePricingBillingModel = "one_time" | "subscription";

export type UpgradePricingPersistedAssignment = Readonly<{
  assignmentId: string;
  experimentId: "upgrade-pricing-v1";
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
  | "kill_switch"
  | "rollout_zero"
  | "assignment_unavailable"
  | "unsupported_currency";

export type UpgradePricingDecision = Readonly<{
  experimentId: "upgrade-pricing-v1";
  assignmentVersion: 1;
  accountId: string;
  variant: UpgradePricingVariant;
  billingModel: UpgradePricingBillingModel;
  assignedVariant: UpgradePricingVariant | null;
  bucket: number | null;
  rolloutBasisPoints: number;
  monthlyAmountMinor: number | null;
  reason: UpgradePricingDecisionReason;
  assignmentId: string | null;
  assignedAt: string | null;
  shouldPersistAssignment: boolean;
  monthlyCohortEligible: boolean;
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
 * Decides only future unassigned accounts. A caller must load a persisted
 * account assignment first and pass it here; rollout and kill-switch changes
 * never rewrite that assignment. Any inability to make or price a monthly
 * assignment produces an explicit one-time fallback that must not be counted
 * as a monthly assignment or exposure.
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
      assignedVariant: null,
      rolloutBasisPoints: rollout.rolloutBasisPoints,
      reason: "assignment_unavailable",
    });
  }

  if (existing) {
    if (existing.variant === UPGRADE_PRICING_MONTHLY_VARIANT) {
      try {
        const monthlyAmountMinor = deriveMonthlyOfferAmount(
          options.currency,
          options.oneTimeAmountMinor,
        );
        return assignedDecision({
          accountId,
          existing,
          monthlyAmountMinor,
          reason: "existing_assignment",
        });
      } catch (error) {
        if (error instanceof UpgradePricingExperimentError) {
          return fallbackDecision({
            accountId,
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
      monthlyAmountMinor: null,
      reason: "existing_assignment",
    });
  }

  if (!rollout.enabled) {
    return fallbackDecision({
      accountId,
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
      assignedVariant: null,
      rolloutBasisPoints: rollout.rolloutBasisPoints,
      reason: "assignment_unavailable",
    });
  }

  const monthlySelected = bucket < rollout.rolloutBasisPoints;
  if (!monthlySelected) {
    return newAssignmentDecision({
      accountId,
      bucket,
      rolloutBasisPoints: rollout.rolloutBasisPoints,
      variant: UPGRADE_PRICING_CONTROL_VARIANT,
      monthlyAmountMinor: null,
      reason: rollout.rolloutBasisPoints === 0 ? "rollout_zero" : "rollout_control",
    });
  }

  try {
    return newAssignmentDecision({
      accountId,
      bucket,
      rolloutBasisPoints: rollout.rolloutBasisPoints,
      variant: UPGRADE_PRICING_MONTHLY_VARIANT,
      monthlyAmountMinor: deriveMonthlyOfferAmount(
        options.currency,
        options.oneTimeAmountMinor,
      ),
      reason: "rollout_monthly",
    });
  } catch (error) {
    if (!(error instanceof UpgradePricingExperimentError)) throw error;
    return fallbackDecision({
      accountId,
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
  monthlyAmountMinor: number | null;
  reason: UpgradePricingDecisionReason;
}): UpgradePricingDecision {
  return Object.freeze({
    experimentId: UPGRADE_PRICING_EXPERIMENT_ID,
    assignmentVersion: 1,
    accountId: options.accountId,
    variant: options.variant,
    billingModel: billingModelForVariant(options.variant),
    assignedVariant: options.variant,
    bucket: options.bucket,
    rolloutBasisPoints: options.rolloutBasisPoints,
    monthlyAmountMinor: options.monthlyAmountMinor,
    reason: options.reason,
    assignmentId: null,
    assignedAt: null,
    shouldPersistAssignment: true,
    monthlyCohortEligible: options.variant === UPGRADE_PRICING_MONTHLY_VARIANT,
    usedExistingAssignment: false,
  });
}

function assignedDecision(options: {
  accountId: string;
  existing: UpgradePricingPersistedAssignment;
  monthlyAmountMinor: number | null;
  reason: UpgradePricingDecisionReason;
}): UpgradePricingDecision {
  return Object.freeze({
    experimentId: UPGRADE_PRICING_EXPERIMENT_ID,
    assignmentVersion: 1,
    accountId: options.accountId,
    variant: options.existing.variant,
    billingModel: options.existing.billingModel,
    assignedVariant: options.existing.variant,
    bucket: options.existing.bucket,
    rolloutBasisPoints: options.existing.rolloutBasisPoints,
    monthlyAmountMinor: options.monthlyAmountMinor,
    reason: options.reason,
    assignmentId: options.existing.assignmentId,
    assignedAt: new Date(options.existing.assignedAt).toISOString(),
    shouldPersistAssignment: false,
    monthlyCohortEligible:
      options.existing.variant === UPGRADE_PRICING_MONTHLY_VARIANT,
    usedExistingAssignment: true,
  });
}

function fallbackDecision(options: {
  accountId: string;
  assignedVariant: UpgradePricingVariant | null;
  rolloutBasisPoints: number;
  reason: Extract<
    UpgradePricingDecisionReason,
    "kill_switch" | "assignment_unavailable" | "unsupported_currency"
  >;
}): UpgradePricingDecision {
  return Object.freeze({
    experimentId: UPGRADE_PRICING_EXPERIMENT_ID,
    assignmentVersion: 1,
    accountId: options.accountId,
    variant: UPGRADE_PRICING_CONTROL_VARIANT,
    billingModel: "one_time",
    assignedVariant: options.assignedVariant,
    bucket: null,
    rolloutBasisPoints: options.rolloutBasisPoints,
    monthlyAmountMinor: null,
    reason: options.reason,
    assignmentId: null,
    assignedAt: null,
    shouldPersistAssignment: false,
    monthlyCohortEligible: false,
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
    value.experimentId !== UPGRADE_PRICING_EXPERIMENT_ID ||
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
        : value.variant === UPGRADE_PRICING_MONTHLY_VARIANT
          ? value.billingModel !== "subscription"
          : true
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
  if (variant === UPGRADE_PRICING_MONTHLY_VARIANT) return "subscription";
  throw new Error("Invalid persisted Upgrade pricing variant");
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

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

export const PAID_TELEMETRY_REPAIR_OPERATION =
  "RECONCILE_ONE_PAID_TELEMETRY_HANDOFF";
export const PAID_TELEMETRY_REPAIR_VERSION = 1;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const PAID_SOURCE = "paid-acquisition-mc-v1";
const STAGE_CONTEXT = "sidestream-acquisition-stage-v1";
const BINDING_CONTEXT = "sidestream-paid-telemetry-profile-binding-v1";
const MERGE_LOCK_CONTEXT = "sidestream_customer_profile_merge";
const REPAIR_LOCK_CONTEXT = "sidestream_paid_telemetry_handoff_repair";

export type PaidTelemetryRepairNamespace = "test" | "production";

type QueryClient = Pick<PoolClient, "query">;

type PaidPathRow = Readonly<{
  acquisition_id: string;
  integrity_state: string;
  checkout_intent_id: string;
  checkout_created_at: Date | string;
  checkout_state: string;
  checkout_account_id: string | null;
  checkout_session_id: string | null;
  checkout_price_id: string | null;
  checkout_product_id: string | null;
  paid_checkout_id: string;
  paid_environment: string;
  paid_payment_state: string;
  paid_claim_state: string;
  paid_completed: boolean;
  paid_completed_at: Date | string | null;
  paid_authorization_active: boolean;
  paid_checkout_session_ref: string | null;
  paid_payment_ref: string | null;
  paid_product_ref: string | null;
  paid_price_ref: string | null;
  paid_quantity: number | null;
  paid_amount_minor: string | null;
  paid_currency: string | null;
  paid_email: string | null;
  claim_id: string;
  claim_state: string;
  claim_active: boolean;
  claim_payment_ref: string;
  claim_activation_ref: string | null;
  claim_account_ref: string | null;
  claim_entitlement_ref: string | null;
  claim_email: string | null;
  account_id: string;
  account_email: string;
  entitlement_id: string;
  entitlement_account_id: string;
  entitlement_status: string;
  entitlement_plan_key: string;
  entitlement_checkout_session_id: string | null;
  entitlement_payment_intent_id: string | null;
  entitlement_product_id: string | null;
  entitlement_price_id: string | null;
  entitlement_amount_paid: string;
  entitlement_amount_refunded: string;
  entitlement_currency: string | null;
  activation_id: string;
  activation_account_id: string | null;
  activation_entitlement_id: string | null;
  activation_source: string;
  activation_status: string;
  activation_completed: boolean;
  activation_active: boolean;
}>;

type ReviewedPathBoundaryRow = Readonly<{
  review_id: string;
  activation_id: string;
  account_id: string;
  candidate_profile_id: string;
  existing_profile_id: string;
  candidate_root_id: string;
  existing_root_id: string;
  activation_profile_id: string;
  direct_account_or_stripe_count: number;
  existing_account_owner_count: number;
  exact_account_owner_count: number;
  exact_binding_count: number;
}>;

type ExactIdentityRow = Readonly<{
  review_kind: "install_bridge" | "account_bridge";
  review_id: string;
  candidate_profile_id: string;
  existing_profile_id: string;
  candidate_root_id: string;
  existing_root_id: string;
  review_created_at: Date | string;
  install_membership_id: string;
  install_profile_id: string;
  install_id_hash: string;
  install_identity_link_id: string;
  activation_identity_link_id: string;
  activation_profile_id: string;
  account_identity_link_id: string;
  receipt_identity_link_id: string;
  receipt_id_hash: string;
  receipt_created_at: Date | string;
  candidate_account_count: number;
  existing_account_count: number;
}>;

type BindingRow = Readonly<{
  id: string;
  license_namespace: string;
  claim_id: string;
  checkout_id: string;
  acquisition_id: string;
  account_id: string;
  entitlement_id: string;
  activation_ref: string;
  profile_id_at_binding: string;
  install_membership_id: string;
  install_id_hash: string;
  install_identity_link_id: string;
  activation_identity_link_id: string;
  account_identity_link_id: string;
  installer_receipt_identity_link_id: string;
  installer_receipt_id_hash: string;
  binding_key: string;
}>;

type MutableCounts = Readonly<{
  authenticationStages: number;
  installationStages: number;
  bindings: number;
  mergeAudits: number;
  acquisitionConflicts: number;
  lifecycleStops: number;
  commerceFacts: number;
  commerceProfiles: number;
  commerceConflicts: number;
}>;

type CommerceStateRow = Readonly<{
  payment_key_count: number;
  fact_count: number;
  profile_count: number;
  unowned_fact_count: number;
  base_conflict_count: number;
  recoverable_fact_count: number;
  recoverable_fact_id: string | null;
  recoverable_payment_key: string | null;
  attached_positive: boolean;
}>;

type RecoverableCommerceFact = Readonly<{
  id: string;
  paymentKey: string;
}>;

type ExactJourney = Readonly<{
  path: PaidPathRow;
  identity: ExactIdentityRow;
  binding: BindingRow | null;
  authenticationKey: string;
  installationKey: string;
  bindingKey: string;
  fingerprint: string;
  counts: MutableCounts;
  commerceRecovery: RecoverableCommerceFact | null;
  attachedPositiveCommerce: boolean;
}>;

export type PaidTelemetryRepairReport = Readonly<{
  reasonCode:
    | "repair_ready"
    | "already_repaired"
    | "acquisition_missing_or_ambiguous"
    | "paid_path_missing_or_ambiguous"
    | "payment_or_account_conflict"
    | "exact_identity_missing_or_ambiguous"
    | "namespace_or_profile_conflict"
    | "lifecycle_stop_present"
    | "commerce_conflict"
    | "binding_conflict";
  eligible: boolean;
  wouldMutate: boolean;
  journeyFingerprint: string | null;
  booleans: Readonly<{
    canonicalAcquisition: boolean;
    exactPaidPath: boolean;
    activePayment: boolean;
    exactIdentity: boolean;
    profilesConverged: boolean;
    authenticationRecorded: boolean;
    installationRecorded: boolean;
    immutableBinding: boolean;
    commerceConsistent: boolean;
  }>;
  counts: MutableCounts;
}>;

const ZERO_COUNTS: MutableCounts = Object.freeze({
  authenticationStages: 0,
  installationStages: 0,
  bindings: 0,
  mergeAudits: 0,
  acquisitionConflicts: 0,
  lifecycleStops: 0,
  commerceFacts: 0,
  commerceProfiles: 0,
  commerceConflicts: 0,
});

export class PaidTelemetryRepairError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PaidTelemetryRepairError";
    this.code = code;
  }
}

export function assertPaidTelemetryRepairSelector(input: Readonly<{
  acquisitionId: string;
  namespace: string;
}>): Readonly<{ acquisitionId: string; namespace: PaidTelemetryRepairNamespace }> {
  const acquisitionId = String(input.acquisitionId || "").toLowerCase();
  if (!UUID.test(acquisitionId)) {
    throw new PaidTelemetryRepairError(
      "invalid_acquisition_selector",
      "Repair selection requires one canonical acquisition UUID.",
    );
  }
  if (input.namespace !== "test" && input.namespace !== "production") {
    throw new PaidTelemetryRepairError(
      "invalid_namespace_selector",
      "Repair selection requires the exact test or production namespace.",
    );
  }
  return Object.freeze({ acquisitionId, namespace: input.namespace });
}

export function derivePaidTelemetryJourneyFingerprint(input: Readonly<{
  namespace: PaidTelemetryRepairNamespace;
  path: PaidPathRow;
  identity: ExactIdentityRow;
}>): string {
  const { path, identity } = input;
  const immutable = {
    version: PAID_TELEMETRY_REPAIR_VERSION,
    namespace: input.namespace,
    acquisitionId: path.acquisition_id,
    checkoutIntentId: path.checkout_intent_id,
    paidCheckoutId: path.paid_checkout_id,
    claimId: path.claim_id,
    accountId: path.account_id,
    entitlementId: path.entitlement_id,
    activationId: path.activation_id,
    reviewId: identity.review_id,
    candidateProfileId: identity.candidate_profile_id,
    existingProfileId: identity.existing_profile_id,
    installMembershipId: identity.install_membership_id,
    installIdHash: identity.install_id_hash,
    receiptIdHash: identity.receipt_id_hash,
    installLinkId: identity.install_identity_link_id,
    activationLinkId: identity.activation_identity_link_id,
    accountLinkId: identity.account_identity_link_id,
    receiptLinkId: identity.receipt_identity_link_id,
  };
  return `journey-${sha256(JSON.stringify(immutable)).slice(0, 32)}`;
}

export async function inspectPaidTelemetryHandoffRepair(
  client: QueryClient,
  input: Readonly<{
    acquisitionId: string;
    namespace: string;
    lock?: boolean;
  }>,
): Promise<PaidTelemetryRepairReport> {
  const selector = assertPaidTelemetryRepairSelector(input);
  if (input.lock) {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `${REPAIR_LOCK_CONTEXT}:${selector.namespace}:${selector.acquisitionId}`,
    ]);
  }
  const discovery = await discoverExactJourney(client, selector, Boolean(input.lock));
  return reportForDiscovery(discovery);
}

export async function applyPaidTelemetryHandoffRepair(
  client: QueryClient,
  input: Readonly<{
    acquisitionId: string;
    namespace: string;
    confirmJourney: string;
  }>,
): Promise<PaidTelemetryRepairReport> {
  const selector = assertPaidTelemetryRepairSelector(input);
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `${REPAIR_LOCK_CONTEXT}:${selector.namespace}:${selector.acquisitionId}`,
  ]);
  const discovery = await discoverExactJourney(client, selector, true);
  const before = reportForDiscovery(discovery);
  if (!before.journeyFingerprint || input.confirmJourney !== before.journeyFingerprint) {
    throw new PaidTelemetryRepairError(
      "journey_confirmation_mismatch",
      "Apply requires the exact single-journey fingerprint emitted by dry-run.",
    );
  }
  if (!before.eligible) {
    throw new PaidTelemetryRepairError(
      before.reasonCode,
      "The selected paid journey is not eligible for repair.",
    );
  }
  if (before.reasonCode === "already_repaired") return before;
  if (!discovery.journey) {
    throw new PaidTelemetryRepairError(
      "exact_journey_missing",
      "Exact single-journey evidence disappeared while locked.",
    );
  }

  const journey = discovery.journey;
  await insertExactStage(client, {
    namespace: selector.namespace,
    acquisitionId: selector.acquisitionId,
    stage: "authentication_completed",
    countingGrain: "authentication",
    deduplicationKey: journey.authenticationKey,
    occurredAt: journey.path.checkout_created_at,
  });
  await insertExactStage(client, {
    namespace: selector.namespace,
    acquisitionId: selector.acquisitionId,
    stage: "installation_claimed",
    countingGrain: "installation",
    deduplicationKey: journey.installationKey,
    occurredAt: journey.identity.review_created_at,
  });
  await client.query(
    `update public.sidestream_acquisitions
     set trusted_delivery_evidence = case
       when 'verified_installation_claim' = any(
         case
           when 'authenticated_account' = any(trusted_delivery_evidence)
             then trusted_delivery_evidence
           else array_append(trusted_delivery_evidence, 'authenticated_account')
         end
       ) then case
         when 'authenticated_account' = any(trusted_delivery_evidence)
           then trusted_delivery_evidence
         else array_append(trusted_delivery_evidence, 'authenticated_account')
       end
       else array_append(
         case
           when 'authenticated_account' = any(trusted_delivery_evidence)
             then trusted_delivery_evidence
           else array_append(trusted_delivery_evidence, 'authenticated_account')
         end,
         'verified_installation_claim'
       )
     end,
     updated_at = now()
     where id = $1::uuid and license_namespace = $2 and integrity_state = 'intact'`,
    [selector.acquisitionId, selector.namespace],
  );
  const paidCheckout = await client.query(
    `update public.sidestream_paid_acquisition_checkouts
     set claim_state = 'claimed', updated_at = now()
     where id = $1::uuid
       and environment = $2
       and payment_state = 'active'
       and claim_state in ('unclaimed', 'claimed')
     returning id`,
    [journey.path.paid_checkout_id, selector.namespace],
  );
  const claim = await client.query(
    `update public.sidestream_paid_acquisition_claims
     set activation_ref = $2::uuid, claim_state = 'claimed', updated_at = now()
     where id = $1::uuid
       and environment = $3
       and account_ref = $4::uuid
       and entitlement_ref = $5::uuid
       and claim_state in ('unclaimed', 'claimed')
       and (activation_ref is null or activation_ref = $2::uuid)
     returning id`,
    [
      journey.path.claim_id,
      journey.path.activation_id,
      selector.namespace,
      journey.path.account_id,
      journey.path.entitlement_id,
    ],
  );
  if (paidCheckout.rows.length !== 1 || claim.rows.length !== 1) {
    throw new PaidTelemetryRepairError(
      "claim_changed_while_locked",
      "The exact paid claim changed while the repair was locked.",
    );
  }

  const survivorId = await mergeExactProfiles(client, selector.namespace, journey);
  if (journey.commerceRecovery) {
    await repairExactRecoverableCommerce(
      client,
      selector.namespace,
      journey,
      survivorId,
    );
  }
  await insertExactBinding(client, selector.namespace, journey, survivorId);

  const afterDiscovery = await discoverExactJourney(client, selector, true);
  const after = reportForDiscovery(afterDiscovery);
  if (
    after.reasonCode !== "already_repaired" ||
    after.journeyFingerprint !== before.journeyFingerprint
  ) {
    throw new PaidTelemetryRepairError(
      "repair_did_not_converge",
      "The exact paid journey did not converge inside the repair transaction.",
    );
  }
  return after;
}

type Discovery = Readonly<{
  reasonCode: PaidTelemetryRepairReport["reasonCode"];
  journey: ExactJourney | null;
  rootCount: number;
  pathCount: number;
  identityCount: number;
  counts: MutableCounts;
}>;

async function discoverExactJourney(
  client: QueryClient,
  selector: Readonly<{
    acquisitionId: string;
    namespace: PaidTelemetryRepairNamespace;
  }>,
  lock: boolean,
): Promise<Discovery> {
  const rootResult = await client.query<{ id: string; integrity_state: string }>(
    `select id, integrity_state
     from public.sidestream_acquisitions
     where id = $1::uuid and license_namespace = $2
     limit 2${lock ? " for update" : ""}`,
    [selector.acquisitionId, selector.namespace],
  );
  if (rootResult.rows.length !== 1 || rootResult.rows[0]?.integrity_state !== "intact") {
    return discoveryFailure(
      "acquisition_missing_or_ambiguous",
      rootResult.rows.length,
      0,
      0,
    );
  }

  const reviewedBoundaryResult = await client.query<ReviewedPathBoundaryRow>(
    reviewedPathBoundarySql(lock),
    [selector.acquisitionId, selector.namespace, PAID_SOURCE],
  );
  const reviewedBoundary = reviewedBoundaryResult.rows.length === 1
    ? normalizeReviewedPathBoundary(reviewedBoundaryResult.rows[0])
    : null;
  if (
    reviewedBoundaryResult.rows.length > 1 ||
    (reviewedBoundary && !reviewedPathBoundaryAgrees(reviewedBoundary))
  ) {
    return discoveryFailure(
      "paid_path_missing_or_ambiguous",
      1,
      reviewedBoundaryResult.rows.length,
      0,
    );
  }

  const pathResult = await client.query<PaidPathRow>(paidPathSql(lock, Boolean(reviewedBoundary)), [
    selector.acquisitionId,
    selector.namespace,
    PAID_SOURCE,
    ...(reviewedBoundary ? [reviewedBoundary.activation_id] : []),
  ]);
  if (pathResult.rows.length !== 1) {
    return discoveryFailure(
      "paid_path_missing_or_ambiguous",
      1,
      pathResult.rows.length,
      0,
    );
  }
  const path = normalizePath(pathResult.rows[0]);
  if (!paidPathAgrees(path, selector.namespace)) {
    return discoveryFailure("payment_or_account_conflict", 1, 1, 0);
  }

  const identityResult = await client.query<ExactIdentityRow>(exactIdentitySql(lock), [
    selector.namespace,
    path.activation_id,
    path.account_id,
  ]);
  const identityRows = identityResult.rows.map(normalizeIdentity);
  const exactRows = identityRows.filter((row) => exactIdentityAgrees(row));
  if (identityRows.length !== 1 || exactRows.length !== 1) {
    return discoveryFailure(
      "exact_identity_missing_or_ambiguous",
      1,
      1,
      identityRows.length,
    );
  }
  const identity = exactRows[0];
  const authenticationKey = deriveStageKey(
    selector.namespace,
    "authentication_completed",
    `google-account:${path.acquisition_id}:${path.account_id}`,
  );
  const installationKey = deriveStageKey(
    selector.namespace,
    "installation_claimed",
    `installation:${identity.install_id_hash}`,
  );
  const bindingKey = sha256([
    BINDING_CONTEXT,
    selector.namespace,
    path.claim_id,
    path.paid_checkout_id,
    path.acquisition_id,
    path.account_id,
    path.activation_id,
    identity.install_id_hash,
    identity.receipt_id_hash,
  ].join(":"));

  const bindingResult = await client.query<BindingRow>(
      `select *
       from public.sidestream_paid_telemetry_profile_bindings
       where claim_id = $1::uuid
          or acquisition_id = $2::uuid
          or (license_namespace = $3 and activation_ref = $4::uuid)
       order by created_at, id
       limit 3${lock ? " for update" : ""}`,
      [path.claim_id, path.acquisition_id, selector.namespace, path.activation_id],
    );
  const stateResult = await client.query<MutableCounts>(mutableCountsSql(), [
    selector.namespace,
    path.acquisition_id,
    authenticationKey,
    installationKey,
    identity.candidate_profile_id,
    identity.existing_profile_id,
  ]);
  const commerceResult = await client.query<CommerceStateRow>(commerceStateSql(), [
    selector.namespace,
    identity.candidate_profile_id,
    identity.existing_profile_id,
    path.paid_checkout_session_ref,
    path.entitlement_payment_intent_id,
    path.paid_payment_ref,
    path.paid_currency,
  ]);
  const commerce = normalizeCommerceState(commerceResult.rows[0]);
  const counts = normalizeCounts({
    ...stateResult.rows[0],
    commerceFacts: commerce.factCount,
    commerceProfiles: commerce.profileCount,
    commerceConflicts: commerce.conflictCount,
  });
  if (counts.lifecycleStops > 0) {
    return {
      reasonCode: "lifecycle_stop_present",
      journey: null,
      rootCount: 1,
      pathCount: 1,
      identityCount: 1,
      counts,
    };
  }
  if (!commerce.attachedPositive && !commerce.recoverableFact) {
    return {
      reasonCode: "commerce_conflict",
      journey: null,
      rootCount: 1,
      pathCount: 1,
      identityCount: 1,
      counts,
    };
  }
  if (counts.acquisitionConflicts > 0) {
    return {
      reasonCode: "namespace_or_profile_conflict",
      journey: null,
      rootCount: 1,
      pathCount: 1,
      identityCount: 1,
      counts,
    };
  }

  const bindingRows = bindingResult.rows;
  const binding = bindingRows.length === 1 ? bindingRows[0] : null;
  if (
    bindingRows.length > 1 ||
    (binding && !bindingAgrees(binding, selector.namespace, path, identity, bindingKey))
  ) {
    return {
      reasonCode: "binding_conflict",
      journey: null,
      rootCount: 1,
      pathCount: 1,
      identityCount: 1,
      counts,
    };
  }

  const fingerprint = derivePaidTelemetryJourneyFingerprint({
    namespace: selector.namespace,
    path,
    identity,
  });
  return {
    reasonCode: "repair_ready",
    journey: {
      path,
      identity,
      binding,
      authenticationKey,
      installationKey,
      bindingKey,
      fingerprint,
      counts,
      commerceRecovery: commerce.recoverableFact,
      attachedPositiveCommerce: commerce.attachedPositive,
    },
    rootCount: 1,
    pathCount: 1,
    identityCount: 1,
    counts,
  };
}

function reportForDiscovery(discovery: Discovery): PaidTelemetryRepairReport {
  const journey = discovery.journey;
  const counts = discovery.counts;
  const exactPaidPath = discovery.pathCount === 1;
  const exactIdentity = discovery.identityCount === 1 && Boolean(journey);
  const profilesConverged = Boolean(
    journey && journey.identity.candidate_root_id === journey.identity.existing_root_id,
  );
  const authenticationRecorded = counts.authenticationStages === 1;
  const installationRecorded = counts.installationStages === 1;
  const immutableBinding = counts.bindings === 1 && Boolean(journey?.binding);
  const commerceConsistent = journey
    ? counts.commerceConflicts === 0 &&
      Boolean(journey.attachedPositiveCommerce || journey.commerceRecovery)
    : counts.commerceConflicts === 0 && counts.commerceProfiles <= 1;
  const alreadyRepaired = Boolean(
    journey && profilesConverged && authenticationRecorded &&
    installationRecorded && immutableBinding && journey.attachedPositiveCommerce,
  );
  const eligible = Boolean(
    journey && counts.acquisitionConflicts === 0 && counts.lifecycleStops === 0 &&
    commerceConsistent && (
      alreadyRepaired ||
      (!profilesConverged && !immutableBinding && counts.bindings === 0)
    ),
  );
  let reasonCode = discovery.reasonCode;
  if (journey && alreadyRepaired) reasonCode = "already_repaired";
  else if (journey && eligible) reasonCode = "repair_ready";
  else if (journey && !eligible) reasonCode = "namespace_or_profile_conflict";

  return Object.freeze({
    reasonCode,
    eligible,
    wouldMutate: reasonCode === "repair_ready",
    journeyFingerprint: journey?.fingerprint || null,
    booleans: Object.freeze({
      canonicalAcquisition: discovery.rootCount === 1,
      exactPaidPath,
      activePayment: Boolean(journey),
      exactIdentity,
      profilesConverged,
      authenticationRecorded,
      installationRecorded,
      immutableBinding,
      commerceConsistent,
    }),
    counts,
  });
}

function discoveryFailure(
  reasonCode: Discovery["reasonCode"],
  rootCount: number,
  pathCount: number,
  identityCount: number,
): Discovery {
  return {
    reasonCode,
    journey: null,
    rootCount: boundedCount(rootCount),
    pathCount: boundedCount(pathCount),
    identityCount: boundedCount(identityCount),
    counts: ZERO_COUNTS,
  };
}

function reviewedPathBoundarySql(lock: boolean): string {
  return `
    select review.id as review_id,
      activation.id as activation_id,
      account.id as account_id,
      review.candidate_profile_id,
      review.existing_profile_id,
      coalesce(candidate.merged_into, candidate.id) as candidate_root_id,
      coalesce(existing.merged_into, existing.id) as existing_root_id,
      activation_link.profile_id as activation_profile_id,
      (select count(*)::int
       from public.sidestream_customer_identity_links direct_link
       where direct_link.license_namespace = acquisition.license_namespace
         and direct_link.profile_id = activation_link.profile_id
         and (
           direct_link.link_type = 'account_identity'
           or direct_link.link_type like 'stripe_%'
         )) as direct_account_or_stripe_count,
      (select count(*)::int
       from public.sidestream_customer_identity_links existing_account
       where existing_account.license_namespace = acquisition.license_namespace
         and existing_account.profile_id = coalesce(existing.merged_into, existing.id)
         and existing_account.link_type = 'account_identity'
         and existing_account.link_value = account.id::text)
        as existing_account_owner_count,
      (select count(*)::int
       from public.sidestream_customer_identity_links exact_account
       join public.sidestream_customer_profiles exact_owner
         on exact_owner.id = exact_account.profile_id
         and exact_owner.license_namespace = exact_account.license_namespace
         and exact_owner.merged_into is null
       where exact_account.license_namespace = acquisition.license_namespace
         and exact_account.link_type = 'account_identity'
         and exact_account.link_value = account.id::text)
        as exact_account_owner_count,
      (select count(*)::int
       from public.sidestream_paid_telemetry_profile_bindings exact_binding
       where exact_binding.license_namespace = acquisition.license_namespace
         and exact_binding.acquisition_id = acquisition.id
         and exact_binding.activation_ref = activation.id
         and exact_binding.account_id = account.id)
        as exact_binding_count
    from public.sidestream_acquisitions acquisition
    join public.sidestream_checkout_intents core
      on core.acquisition_id = acquisition.id
    join public.sidestream_paid_acquisition_checkouts paid
      on paid.checkout_intent_ref = core.id
      and paid.environment = acquisition.license_namespace
    join public.sidestream_paid_acquisition_claims claim
      on claim.checkout_id = paid.id
      and claim.environment = paid.environment
    join public.sidestream_accounts account
      on account.id = claim.account_ref
    join public.sidestream_activation_sessions activation
      on activation.id = claim.activation_ref
    join public.sidestream_customer_identity_links activation_link
      on activation_link.license_namespace = acquisition.license_namespace
      and activation_link.link_type = 'activation_record'
      and activation_link.link_value = activation.id::text
    join public.sidestream_customer_profiles candidate
      on candidate.license_namespace = acquisition.license_namespace
      and (
        candidate.id = activation_link.profile_id
        or coalesce(candidate.merged_into, candidate.id) = activation_link.profile_id
      )
    join public.sidestream_customer_identity_reviews review
      on review.license_namespace = acquisition.license_namespace
      and review.candidate_profile_id = candidate.id
    join public.sidestream_customer_profiles existing
      on existing.id = review.existing_profile_id
      and existing.license_namespace = review.license_namespace
    where acquisition.id = $1::uuid
      and acquisition.license_namespace = $2
      and activation.source = $3
      and review.evidence_type = 'account_identity'
      and review.evidence_value_hash = encode(
        digest('account_identity:' || account.id::text, 'sha256'),
        'hex'
      )
      and review.evidence_trust = 'verified_server'
      and review.attachment_source = 'activation_claim'
      and review.review_state = 'pending_review'
      and (
        not exists (
          select 1
          from public.sidestream_paid_telemetry_profile_bindings any_binding
          where any_binding.license_namespace = acquisition.license_namespace
            and any_binding.acquisition_id = acquisition.id
        )
        or exists (
          select 1
          from public.sidestream_paid_telemetry_profile_bindings exact_binding
          where exact_binding.license_namespace = acquisition.license_namespace
            and exact_binding.acquisition_id = acquisition.id
            and exact_binding.activation_ref = activation.id
            and exact_binding.account_id = account.id
        )
      )
    limit 3${lock
      ? " for update of acquisition, core, paid, claim, account, activation, activation_link, candidate, review, existing"
      : ""}
  `;
}

function paidPathSql(lock: boolean, selectReviewedPath: boolean): string {
  return `
    select acquisition.id as acquisition_id,
      acquisition.integrity_state,
      core.id as checkout_intent_id,
      core.created_at as checkout_created_at,
      core.state as checkout_state,
      core.account_id as checkout_account_id,
      core.stripe_checkout_session_id as checkout_session_id,
      core.stripe_price_id as checkout_price_id,
      core.stripe_product_id as checkout_product_id,
      paid.id as paid_checkout_id,
      paid.environment as paid_environment,
      paid.payment_state as paid_payment_state,
      paid.claim_state as paid_claim_state,
      paid.completed_at is not null as paid_completed,
      paid.completed_at as paid_completed_at,
      paid.receipt_expires_at > now() as paid_authorization_active,
      paid.verified_checkout_session_ref as paid_checkout_session_ref,
      paid.canonical_payment_ref as paid_payment_ref,
      paid.verified_product_ref as paid_product_ref,
      paid.verified_price_ref as paid_price_ref,
      paid.verified_quantity as paid_quantity,
      paid.verified_amount_minor::text as paid_amount_minor,
      paid.verified_currency as paid_currency,
      paid.checkout_email_normalized as paid_email,
      claim.id as claim_id,
      claim.claim_state,
      claim.expires_at > now() as claim_active,
      claim.canonical_payment_ref as claim_payment_ref,
      claim.activation_ref as claim_activation_ref,
      claim.account_ref as claim_account_ref,
      claim.entitlement_ref as claim_entitlement_ref,
      claim.google_email_normalized as claim_email,
      account.id as account_id,
      account.email as account_email,
      entitlement.id as entitlement_id,
      entitlement.account_id as entitlement_account_id,
      coalesce(to_jsonb(entitlement)->>'entitlement_status', entitlement.status) as entitlement_status,
      entitlement.plan_key as entitlement_plan_key,
      entitlement.stripe_checkout_session_id as entitlement_checkout_session_id,
      entitlement.stripe_payment_intent_id as entitlement_payment_intent_id,
      entitlement.stripe_product_id as entitlement_product_id,
      entitlement.stripe_price_id as entitlement_price_id,
      entitlement.amount_paid::text as entitlement_amount_paid,
      entitlement.amount_refunded::text as entitlement_amount_refunded,
      entitlement.currency as entitlement_currency,
      activation.id as activation_id,
      activation.account_id as activation_account_id,
      activation.license_id as activation_entitlement_id,
      activation.source as activation_source,
      activation.status as activation_status,
      activation.completed_at is not null as activation_completed,
      activation.expires_at > now() as activation_active
    from public.sidestream_acquisitions acquisition
    join public.sidestream_checkout_intents core
      on core.acquisition_id = acquisition.id
    join public.sidestream_paid_acquisition_checkouts paid
      on paid.checkout_intent_ref = core.id
      and paid.environment = acquisition.license_namespace
    join public.sidestream_paid_acquisition_claims claim
      on claim.checkout_id = paid.id
      and claim.environment = paid.environment
    join public.sidestream_accounts account
      on account.id = claim.account_ref
    join public.sidestream_licenses entitlement
      on entitlement.id = claim.entitlement_ref
    join public.sidestream_activation_sessions activation
      on activation.id = claim.activation_ref
      or (
        claim.activation_ref is null
        and exists (
          select 1
          from public.sidestream_customer_identity_links link
          join public.sidestream_customer_identity_links activation_link
            on activation_link.license_namespace = link.license_namespace
            and activation_link.profile_id = link.profile_id
            and activation_link.link_type = 'activation_record'
            and activation_link.link_value = activation.id::text
          where link.license_namespace = acquisition.license_namespace
            and link.link_type = 'account_identity'
            and link.link_value = account.id::text
        )
      )
    where acquisition.id = $1::uuid
      and acquisition.license_namespace = $2
      and activation.source = $3
      ${selectReviewedPath ? "and activation.id = $4::uuid" : ""}
      and exists (
        select 1
        from public.sidestream_customer_identity_links current_activation
        join public.sidestream_customer_profiles current_profile
          on current_profile.id = current_activation.profile_id
          and current_profile.license_namespace = current_activation.license_namespace
          and current_profile.merged_into is null
        join public.sidestream_customer_identity_links current_receipt
          on current_receipt.license_namespace = current_activation.license_namespace
          and current_receipt.profile_id = current_activation.profile_id
          and current_receipt.link_type = 'installer_receipt_hash'
        where current_activation.license_namespace = acquisition.license_namespace
          and current_activation.link_type = 'activation_record'
          and current_activation.link_value = activation.id::text
          and (
            not exists (
              select 1
              from public.sidestream_paid_telemetry_profile_bindings any_binding
              where any_binding.license_namespace = acquisition.license_namespace
                and any_binding.acquisition_id = acquisition.id
            )
            or exists (
              select 1
              from public.sidestream_paid_telemetry_profile_bindings exact_binding
              where exact_binding.license_namespace = acquisition.license_namespace
                and exact_binding.acquisition_id = acquisition.id
                and exact_binding.activation_ref = activation.id
                and exact_binding.installer_receipt_id_hash = current_receipt.link_value
            )
          )
          and (
            exists (
              select 1
              from public.sidestream_customer_identity_links direct_account
              where direct_account.license_namespace = acquisition.license_namespace
                and direct_account.profile_id = current_activation.profile_id
                and direct_account.link_type = 'account_identity'
                and direct_account.link_value = account.id::text
            )
            or exists (
              select 1
              from public.sidestream_customer_identity_reviews account_review
              join public.sidestream_customer_profiles reviewed_candidate
                on reviewed_candidate.id = account_review.candidate_profile_id
                and reviewed_candidate.license_namespace = account_review.license_namespace
              join public.sidestream_customer_profiles reviewed_existing
                on reviewed_existing.id = account_review.existing_profile_id
                and reviewed_existing.license_namespace = account_review.license_namespace
              join public.sidestream_customer_identity_links reviewed_account
                on reviewed_account.license_namespace = account_review.license_namespace
                and reviewed_account.profile_id = coalesce(
                  reviewed_existing.merged_into,
                  reviewed_existing.id
                )
                and reviewed_account.link_type = 'account_identity'
                and reviewed_account.link_value = account.id::text
              where account_review.license_namespace = acquisition.license_namespace
                and coalesce(reviewed_candidate.merged_into, reviewed_candidate.id) =
                  current_activation.profile_id
                and account_review.evidence_type = 'account_identity'
                and account_review.evidence_value_hash = encode(
                  digest('account_identity:' || account.id::text, 'sha256'),
                  'hex'
                )
                and account_review.evidence_trust = 'verified_server'
                and account_review.attachment_source = 'activation_claim'
                and account_review.review_state = 'pending_review'
            )
          )
      )
    order by core.created_at, core.id, paid.created_at, paid.id, claim.created_at, claim.id
    limit 3${lock ? " for update of acquisition, core, paid, claim, account, entitlement, activation" : ""}
  `;
}

function normalizeReviewedPathBoundary(
  row: ReviewedPathBoundaryRow,
): ReviewedPathBoundaryRow {
  return Object.freeze({
    ...row,
    direct_account_or_stripe_count: Number(row.direct_account_or_stripe_count),
    existing_account_owner_count: Number(row.existing_account_owner_count),
    exact_account_owner_count: Number(row.exact_account_owner_count),
    exact_binding_count: Number(row.exact_binding_count),
  });
}

function reviewedPathBoundaryAgrees(row: ReviewedPathBoundaryRow): boolean {
  const exactUnboundReview =
    row.candidate_root_id !== row.existing_root_id &&
    row.direct_account_or_stripe_count === 0 &&
    row.exact_binding_count === 0;
  const exactRepairedReview =
    row.candidate_root_id === row.existing_root_id &&
    row.exact_binding_count === 1;
  return UUID.test(row.review_id) &&
    UUID.test(row.activation_id) &&
    UUID.test(row.account_id) &&
    UUID.test(row.candidate_profile_id) &&
    UUID.test(row.existing_profile_id) &&
    row.candidate_root_id === row.activation_profile_id &&
    row.existing_account_owner_count === 1 &&
    row.exact_account_owner_count === 1 &&
    (exactUnboundReview || exactRepairedReview);
}

function exactIdentitySql(lock: boolean): string {
  return `
    select case
        when review.evidence_type = 'account_identity' then 'account_bridge'
        else 'install_bridge'
      end as review_kind,
      review.id as review_id,
      review.candidate_profile_id,
      review.existing_profile_id,
      coalesce(candidate.merged_into, candidate.id) as candidate_root_id,
      coalesce(existing.merged_into, existing.id) as existing_root_id,
      review.created_at as review_created_at,
      install.id as install_membership_id,
      install.profile_id as install_profile_id,
      install.install_id_hash,
      install_link.id as install_identity_link_id,
      activation_link.id as activation_identity_link_id,
      activation_link.profile_id as activation_profile_id,
      account_link.id as account_identity_link_id,
      receipt_link.id as receipt_identity_link_id,
      receipt_link.link_value as receipt_id_hash,
      receipt_link.created_at as receipt_created_at,
      (select count(*)::int
       from public.sidestream_customer_identity_links candidate_account
       where candidate_account.license_namespace = $1
         and candidate_account.profile_id = coalesce(candidate.merged_into, candidate.id)
         and candidate_account.link_type = 'account_identity') as candidate_account_count,
      (select count(*)::int
       from public.sidestream_customer_identity_links existing_account
       where existing_account.license_namespace = $1
         and existing_account.profile_id = coalesce(existing.merged_into, existing.id)
         and existing_account.link_type = 'account_identity') as existing_account_count
    from public.sidestream_customer_identity_reviews review
    join public.sidestream_customer_profiles candidate
      on candidate.id = review.candidate_profile_id
      and candidate.license_namespace = review.license_namespace
    join public.sidestream_customer_profiles existing
      on existing.id = review.existing_profile_id
      and existing.license_namespace = review.license_namespace
    join public.sidestream_customer_installs install
      on install.license_namespace = review.license_namespace
      and install.profile_id = case
        when review.evidence_type = 'account_identity'
          then coalesce(candidate.merged_into, candidate.id)
        else coalesce(existing.merged_into, existing.id)
      end
    join public.sidestream_customer_identity_links install_link
      on install_link.license_namespace = install.license_namespace
      and install_link.profile_id = install.profile_id
      and install_link.link_type = 'install_identity_hash'
      and install_link.link_value = install.install_id_hash
    join public.sidestream_customer_identity_links activation_link
      on activation_link.license_namespace = review.license_namespace
      and activation_link.profile_id = coalesce(candidate.merged_into, candidate.id)
      and activation_link.link_type = 'activation_record'
      and activation_link.link_value = $2::text
    join public.sidestream_customer_identity_links account_link
      on account_link.license_namespace = review.license_namespace
      and account_link.profile_id = case
        when review.evidence_type = 'account_identity'
          then coalesce(existing.merged_into, existing.id)
        else activation_link.profile_id
      end
      and account_link.link_type = 'account_identity'
      and account_link.link_value = $3::text
    join public.sidestream_customer_identity_links receipt_link
      on receipt_link.license_namespace = review.license_namespace
      and receipt_link.profile_id = activation_link.profile_id
      and receipt_link.link_type = 'installer_receipt_hash'
      and (
        review.evidence_type = 'account_identity'
        or receipt_link.created_at = review.created_at
      )
    where review.license_namespace = $1
      and review.attachment_source = 'activation_claim'
      and review.review_state = 'pending_review'
      and (
        (
          review.evidence_type = 'install_identity_hash'
          and review.evidence_trust = 'client_association'
          and review.evidence_value_hash = encode(
            digest('install_identity_hash:' || install.install_id_hash, 'sha256'),
            'hex'
          )
        )
        or (
          review.evidence_type = 'account_identity'
          and review.evidence_trust = 'verified_server'
          and review.evidence_value_hash = encode(
            digest('account_identity:' || $3::text, 'sha256'),
            'hex'
          )
          and (
            coalesce(candidate.merged_into, candidate.id) <>
              coalesce(existing.merged_into, existing.id)
            or exists (
              select 1
              from public.sidestream_paid_telemetry_profile_bindings exact_binding
              where exact_binding.license_namespace = $1
                and exact_binding.activation_ref = $2::uuid
                and exact_binding.account_id = $3::uuid
                and exact_binding.install_id_hash = install.install_id_hash
                and exact_binding.installer_receipt_id_hash = receipt_link.link_value
            )
          )
        )
      )
    order by review.created_at, review.id, receipt_link.id
    limit 3${lock ? " for update of review, candidate, existing, install, install_link, activation_link, account_link, receipt_link" : ""}
  `;
}

function mutableCountsSql(): string {
  return `
    select
      (select least(count(*), 3)::int
       from public.sidestream_acquisition_stages stage
       where stage.license_namespace = $1
         and stage.stage = 'authentication_completed'
         and stage.deduplication_key = $3
         and stage.acquisition_id = $2::uuid) as "authenticationStages",
      (select least(count(*), 3)::int
       from public.sidestream_acquisition_stages stage
       where stage.license_namespace = $1
         and stage.stage = 'installation_claimed'
         and stage.deduplication_key = $4
         and stage.acquisition_id = $2::uuid) as "installationStages",
      (select least(count(*), 3)::int
       from public.sidestream_paid_telemetry_profile_bindings binding
       where binding.license_namespace = $1
         and binding.acquisition_id = $2::uuid) as bindings,
      (select least(count(*), 3)::int
       from public.sidestream_customer_profile_merges merge
       where merge.license_namespace = $1
         and merge.merge_evidence_type = 'installer_receipt_hash'
         and merge.source_profile_id in ($5::uuid, $6::uuid)
         and merge.target_profile_id in ($5::uuid, $6::uuid)) as "mergeAudits",
      least(
        (select count(*)
         from public.sidestream_acquisition_conflicts conflict
         where conflict.license_namespace = $1
           and conflict.acquisition_id = $2::uuid)
        +
        (select count(*)
         from public.sidestream_acquisition_stages owner_conflict
         where owner_conflict.license_namespace = $1
           and owner_conflict.deduplication_key in ($3, $4)
           and owner_conflict.acquisition_id <> $2::uuid),
        3
      )::int as "acquisitionConflicts",
      (select least(count(*), 3)::int
       from public.sidestream_acquisition_stages stage
       where stage.license_namespace = $1
         and stage.acquisition_id = $2::uuid
         and stage.stage in ('refunded', 'disputed')) as "lifecycleStops"
  `;
}

function commerceStateSql(): string {
  return `
    with exact_payment_keys as (
      select seed.payment_key
      from public.sidestream_customer_commerce_materializations seed
      where seed.license_namespace = $1
        and seed.source_object_id = any(
          array_remove(array[$4, $5, $6]::text[], null)
        )
      union
      select alias.payment_key
      from public.sidestream_customer_commerce_aliases alias
      where alias.license_namespace = $1
        and alias.alias_id = any(
          array_remove(array[$4, $5, $6]::text[], null)
        )
    ), exact_commerce as (
      select fact.*
      from public.sidestream_customer_commerce_materializations fact
      where fact.license_namespace = $1
        and fact.payment_key in (select payment_key from exact_payment_keys)
    ), facts as (
      select
        fact.*,
        (
          fact.fact_kind = 'payment'
          and fact.source_confidence = 'verified'
          and fact.source_object_type = 'checkout_session'
          and fact.source_object_id = $4
          and fact.event_type in (
            'checkout.session.completed',
            'checkout.session.async_payment_succeeded'
          )
          and fact.state in ('paid', 'no_payment_required')
          and fact.currency = $7
          and fact.profile_id is null
          and fact.gross_paid_minor = 0
          and fact.net_paid_minor = 0
          and fact.refunded_minor = 0
          and fact.disputed_minor = 0
          and fact.inquiry_minor = 0
          and not fact.identity_conflict
          and (
            select count(*)
            from jsonb_array_elements(fact.identity_evidence) evidence
            where evidence->>'linkType' = 'stripe_checkout_session'
              and evidence->>'linkValue' = $4
          ) = 1
          and not exists (
            select 1
            from jsonb_array_elements(fact.identity_evidence) evidence
            where evidence->>'linkType' = 'stripe_checkout_session'
              and evidence->>'linkValue' <> $4
          )
          and (
            $6 = $4
            or (
              (select count(*)
               from jsonb_array_elements(fact.identity_evidence) evidence
               where evidence->>'linkType' = 'stripe_payment_intent'
                 and evidence->>'linkValue' = $6) = 1
              and not exists (
                select 1
                from jsonb_array_elements(fact.identity_evidence) evidence
                where evidence->>'linkType' = 'stripe_payment_intent'
                  and evidence->>'linkValue' <> $6
              )
            )
          )
        ) as recoverable
      from exact_commerce fact
    ), aggregate_state as (
      select
        (select count(*) from exact_payment_keys)::int as payment_key_count,
        count(*)::int as fact_count,
        count(distinct profile_id) filter (where profile_id is not null)::int
          as profile_count,
        count(*) filter (where profile_id is null)::int as unowned_fact_count,
        count(*) filter (
          where identity_conflict
            or refunded_minor > 0
            or disputed_minor > 0
            or inquiry_minor > 0
            or (gross_paid_minor > 0 and net_paid_minor <= 0)
            or (profile_id is not null and profile_id not in ($2::uuid, $3::uuid))
        )::int as base_conflict_count,
        count(*) filter (where recoverable)::int as recoverable_fact_count,
        min(id::text) filter (where recoverable) as recoverable_fact_id,
        min(payment_key) filter (where recoverable) as recoverable_payment_key,
        coalesce(bool_or(
          fact_kind = 'payment' and gross_paid_minor > 0 and net_paid_minor > 0
        ), false) as has_positive_payment
      from facts
    )
    select
      payment_key_count,
      fact_count,
      profile_count,
      unowned_fact_count,
      base_conflict_count,
      recoverable_fact_count,
      recoverable_fact_id,
      recoverable_payment_key,
      (
        payment_key_count = 1
        and fact_count > 0
        and profile_count = 1
        and unowned_fact_count = 0
        and base_conflict_count = 0
        and has_positive_payment
      ) as attached_positive
    from aggregate_state
  `;
}

function paidPathAgrees(path: PaidPathRow, namespace: PaidTelemetryRepairNamespace): boolean {
  const accountEmail = normalizeEmail(path.account_email);
  const checkoutEmail = normalizeEmail(path.paid_email);
  const claimEmail = normalizeEmail(path.claim_email);
  const canonicalPaymentMatches = path.paid_payment_ref === path.claim_payment_ref && (
    path.paid_payment_ref === path.entitlement_payment_intent_id ||
    path.paid_payment_ref === path.entitlement_checkout_session_id
  );
  const strictEntitlementPaymentSnapshot =
    path.paid_product_ref === path.entitlement_product_id &&
    path.paid_price_ref === path.entitlement_price_id &&
    path.paid_amount_minor === path.entitlement_amount_paid;
  const exactLegacyEntitlementPaymentSnapshot =
    path.entitlement_product_id === null &&
    path.entitlement_price_id === null &&
    path.entitlement_amount_paid === "0" &&
    Boolean(path.paid_checkout_session_ref) &&
    Boolean(path.paid_payment_ref) &&
    Boolean(path.paid_product_ref) &&
    Boolean(path.paid_price_ref) &&
    Boolean(path.paid_currency) &&
    isStrictlyPositiveMinorAmount(path.paid_amount_minor);
  const claimEmailMatches = path.claim_email === null
    ? path.claim_account_ref === path.account_id &&
      path.claim_entitlement_ref === path.entitlement_id &&
      path.claim_activation_ref === path.activation_id &&
      Boolean(accountEmail) &&
      accountEmail === checkoutEmail
    : Boolean(accountEmail) && accountEmail === checkoutEmail && accountEmail === claimEmail;
  return path.integrity_state === "intact" &&
    path.paid_environment === namespace &&
    path.checkout_state === "completed" &&
    (path.checkout_account_id === null || path.checkout_account_id === path.account_id) &&
    path.paid_payment_state === "active" &&
    path.paid_claim_state === path.claim_state &&
    ["unclaimed", "claimed"].includes(path.paid_claim_state) &&
    path.paid_completed &&
    isValidTimestamp(path.paid_completed_at) &&
    path.paid_authorization_active &&
    path.claim_active &&
    path.claim_account_ref === path.account_id &&
    path.claim_entitlement_ref === path.entitlement_id &&
    (path.claim_activation_ref === null || path.claim_activation_ref === path.activation_id) &&
    path.entitlement_account_id === path.account_id &&
    path.entitlement_status === "active" &&
    ["sidestream_pro", "sidestream_unlimited"].includes(path.entitlement_plan_key) &&
    path.activation_account_id === path.account_id &&
    path.activation_entitlement_id === path.entitlement_id &&
    path.activation_source === PAID_SOURCE &&
    ["paid", "linked", "restored", "completed"].includes(path.activation_status) &&
    path.activation_completed &&
    path.activation_active &&
    path.paid_checkout_session_ref === path.checkout_session_id &&
    path.paid_checkout_session_ref === path.entitlement_checkout_session_id &&
    path.paid_product_ref === path.checkout_product_id &&
    path.paid_price_ref === path.checkout_price_id &&
    path.paid_quantity === 1 &&
    (strictEntitlementPaymentSnapshot || exactLegacyEntitlementPaymentSnapshot) &&
    path.entitlement_amount_refunded === "0" &&
    path.paid_currency === path.entitlement_currency &&
    canonicalPaymentMatches &&
    claimEmailMatches;
}

function isStrictlyPositiveMinorAmount(value: string | null): boolean {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

function isValidTimestamp(value: Date | string | null): boolean {
  return value !== null && Number.isFinite(new Date(value).getTime());
}

function exactIdentityAgrees(identity: ExactIdentityRow): boolean {
  return UUID.test(identity.review_id) &&
    UUID.test(identity.install_membership_id) &&
    HASH.test(identity.install_id_hash) &&
    HASH.test(identity.receipt_id_hash) &&
    identity.candidate_root_id === identity.activation_profile_id &&
    (identity.review_kind === "install_bridge"
      ? identity.existing_root_id === identity.install_profile_id &&
        identity.candidate_account_count === 1 &&
        (identity.candidate_root_id === identity.existing_root_id
          ? identity.existing_account_count === 1
          : identity.existing_account_count === 0) &&
        new Date(identity.review_created_at).toISOString() ===
          new Date(identity.receipt_created_at).toISOString()
      : identity.review_kind === "account_bridge" &&
        identity.candidate_root_id === identity.install_profile_id &&
        identity.existing_account_count === 1 &&
        (identity.candidate_root_id === identity.existing_root_id
          ? identity.candidate_account_count === 1
          : identity.candidate_account_count === 0));
}

function bindingAgrees(
  binding: BindingRow,
  namespace: PaidTelemetryRepairNamespace,
  path: PaidPathRow,
  identity: ExactIdentityRow,
  bindingKey: string,
): boolean {
  return binding.license_namespace === namespace &&
    binding.claim_id === path.claim_id &&
    binding.checkout_id === path.paid_checkout_id &&
    binding.acquisition_id === path.acquisition_id &&
    binding.account_id === path.account_id &&
    binding.entitlement_id === path.entitlement_id &&
    binding.activation_ref === path.activation_id &&
    binding.profile_id_at_binding === identity.candidate_root_id &&
    binding.install_membership_id === identity.install_membership_id &&
    binding.install_id_hash === identity.install_id_hash &&
    binding.install_identity_link_id === identity.install_identity_link_id &&
    binding.activation_identity_link_id === identity.activation_identity_link_id &&
    binding.account_identity_link_id === identity.account_identity_link_id &&
    binding.installer_receipt_identity_link_id === identity.receipt_identity_link_id &&
    binding.installer_receipt_id_hash === identity.receipt_id_hash &&
    binding.binding_key === bindingKey;
}

async function insertExactStage(
  client: QueryClient,
  input: Readonly<{
    namespace: PaidTelemetryRepairNamespace;
    acquisitionId: string;
    stage: "authentication_completed" | "installation_claimed";
    countingGrain: "authentication" | "installation";
    deduplicationKey: string;
    occurredAt: Date | string;
  }>,
): Promise<void> {
  await client.query(
    `insert into public.sidestream_acquisition_stages (
       acquisition_id, license_namespace, stage, counting_grain,
       deduplication_key, occurred_at
     )
     select $1::uuid, $2, $3, $4, $5, $6::timestamptz
     where not exists (
       select 1 from public.sidestream_acquisition_stages existing
       where existing.license_namespace = $2
         and existing.stage = $3
         and existing.deduplication_key = $5
     )
     on conflict do nothing`,
    [
      input.acquisitionId,
      input.namespace,
      input.stage,
      input.countingGrain,
      input.deduplicationKey,
      input.occurredAt,
    ],
  );
  const exact = await client.query<{ acquisition_id: string }>(
    `select acquisition_id
     from public.sidestream_acquisition_stages
     where license_namespace = $1 and stage = $2 and deduplication_key = $3
     limit 2`,
    [input.namespace, input.stage, input.deduplicationKey],
  );
  if (exact.rows.length !== 1 || exact.rows[0]?.acquisition_id !== input.acquisitionId) {
    throw new PaidTelemetryRepairError(
      "stage_ownership_conflict",
      "An exact repair stage belongs to a different acquisition.",
    );
  }
}

async function mergeExactProfiles(
  client: QueryClient,
  namespace: PaidTelemetryRepairNamespace,
  journey: ExactJourney,
): Promise<string> {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `${MERGE_LOCK_CONTEXT}:${namespace}`,
  ]);
  const profiles = await client.query<{
    id: string;
    merged_into: string | null;
    created_at_key: string;
  }>(
    `select id, merged_into,
       to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
         as created_at_key
     from public.sidestream_customer_profiles
     where license_namespace = $1 and id = any($2::uuid[])
     order by id
     for update`,
    [
      namespace,
      [journey.identity.candidate_root_id, journey.identity.existing_root_id],
    ],
  );
  if (profiles.rows.length !== 2 || profiles.rows.some((row) => row.merged_into !== null)) {
    throw new PaidTelemetryRepairError(
      "profile_roots_changed",
      "The exact profile roots changed while the repair was locked.",
    );
  }
  const ordered = [...profiles.rows].sort((left, right) => {
    const byCreated = left.created_at_key.localeCompare(right.created_at_key);
    return byCreated || left.id.localeCompare(right.id);
  });
  const survivor = ordered[0];
  const tombstone = ordered[1];
  if (!survivor || !tombstone) {
    throw new PaidTelemetryRepairError("profile_roots_changed", "Profile roots are incomplete.");
  }

  await client.query(
    `lock table public.sidestream_customer_identity_links,
       public.sidestream_customer_installs in share row exclusive mode`,
  );
  await client.query(
    `delete from public.sidestream_customer_identity_links source
     using public.sidestream_customer_identity_links target
     where source.license_namespace = $1
       and source.profile_id = $2::uuid
       and target.license_namespace = source.license_namespace
       and target.profile_id = $3::uuid
       and target.link_type = source.link_type
       and target.link_value = source.link_value`,
    [namespace, tombstone.id, survivor.id],
  );
  await client.query(
    `update public.sidestream_customer_identity_links
     set profile_id = $3::uuid
     where license_namespace = $1 and profile_id = $2::uuid`,
    [namespace, tombstone.id, survivor.id],
  );
  await client.query(
    `delete from public.sidestream_customer_installs source
     using public.sidestream_customer_installs target
     where source.license_namespace = $1
       and source.profile_id = $2::uuid
       and target.license_namespace = source.license_namespace
       and target.profile_id = $3::uuid
       and target.install_id_hash = source.install_id_hash`,
    [namespace, tombstone.id, survivor.id],
  );
  await client.query(
    `update public.sidestream_customer_installs
     set profile_id = $3::uuid
     where license_namespace = $1 and profile_id = $2::uuid`,
    [namespace, tombstone.id, survivor.id],
  );
  const mergedAt = await client.query<{ merged_at: Date | string }>(
    "select transaction_timestamp() as merged_at",
  );
  const timestamp = mergedAt.rows[0]?.merged_at;
  if (!timestamp) throw new PaidTelemetryRepairError("merge_timestamp_missing", "Merge time is missing.");
  const update = await client.query(
    `update public.sidestream_customer_profiles
     set merged_into = $3::uuid, merged_at = $4, updated_at = $4
     where license_namespace = $1 and id = $2::uuid and merged_into is null`,
    [namespace, tombstone.id, survivor.id, timestamp],
  );
  if (update.rowCount !== 1) {
    throw new PaidTelemetryRepairError("profile_roots_changed", "Profile merge did not lock one root.");
  }
  const audit = await client.query(
    `insert into public.sidestream_customer_profile_merges (
       license_namespace, source_profile_id, target_profile_id,
       merge_evidence_type, merge_evidence_value_hash, initiated_by, merged_at
     ) values ($1, $2::uuid, $3::uuid, 'installer_receipt_hash', $4, 'support', $5)
     on conflict (license_namespace, source_profile_id) do nothing
     returning id`,
    [namespace, tombstone.id, survivor.id, journey.bindingKey, timestamp],
  );
  if (audit.rows.length !== 1) {
    throw new PaidTelemetryRepairError("merge_audit_conflict", "Exact merge audit already conflicts.");
  }
  return survivor.id;
}

async function repairExactRecoverableCommerce(
  client: QueryClient,
  namespace: PaidTelemetryRepairNamespace,
  journey: ExactJourney,
  survivorId: string,
): Promise<void> {
  const recovery = journey.commerceRecovery;
  const completedAt = journey.path.paid_completed_at;
  if (
    !recovery || !isStrictlyPositiveMinorAmount(journey.path.paid_amount_minor) ||
    !isValidTimestamp(completedAt)
  ) {
    throw new PaidTelemetryRepairError(
      "commerce_recovery_changed",
      "The exact recoverable commerce fact is no longer eligible.",
    );
  }
  const updated = await client.query<{
    id: string;
    profile_id: string;
    gross_paid_minor: string;
    net_paid_minor: string;
  }>(
    `update public.sidestream_customer_commerce_materializations fact
     set profile_id = $3::uuid,
         gross_paid_minor = $5::bigint,
         net_paid_minor = $5::bigint,
         first_paid_at = $6::timestamptz,
         last_paid_at = $6::timestamptz,
         first_upgraded_at = $6::timestamptz,
         last_upgraded_at = $6::timestamptz,
         updated_at = now()
     where fact.id = $1::uuid
       and fact.license_namespace = $2
       and fact.payment_key = $4
       and fact.fact_kind = 'payment'
       and fact.source_confidence = 'verified'
       and fact.source_object_type = 'checkout_session'
       and fact.source_object_id = $7
       and fact.event_type in (
         'checkout.session.completed',
         'checkout.session.async_payment_succeeded'
       )
       and fact.state in ('paid', 'no_payment_required')
       and fact.currency = $8
       and (fact.profile_id is null or fact.profile_id = $3::uuid)
       and fact.gross_paid_minor = 0
       and fact.net_paid_minor = 0
       and fact.refunded_minor = 0
       and fact.disputed_minor = 0
       and fact.inquiry_minor = 0
       and not fact.identity_conflict
       and (
         select count(*)
         from jsonb_array_elements(fact.identity_evidence) evidence
         where evidence->>'linkType' = 'stripe_checkout_session'
           and evidence->>'linkValue' = $7
       ) = 1
       and not exists (
         select 1
         from jsonb_array_elements(fact.identity_evidence) evidence
         where evidence->>'linkType' = 'stripe_checkout_session'
           and evidence->>'linkValue' <> $7
       )
       and (
         $9 = $7
         or (
           (select count(*)
            from jsonb_array_elements(fact.identity_evidence) evidence
            where evidence->>'linkType' = 'stripe_payment_intent'
              and evidence->>'linkValue' = $9) = 1
           and not exists (
             select 1
             from jsonb_array_elements(fact.identity_evidence) evidence
             where evidence->>'linkType' = 'stripe_payment_intent'
               and evidence->>'linkValue' <> $9
           )
         )
       )
     returning id, profile_id, gross_paid_minor::text, net_paid_minor::text`,
    [
      recovery.id,
      namespace,
      survivorId,
      recovery.paymentKey,
      journey.path.paid_amount_minor,
      completedAt,
      journey.path.paid_checkout_session_ref,
      journey.path.paid_currency,
      journey.path.paid_payment_ref,
    ],
  );
  const row = updated.rows[0];
  if (
    updated.rows.length !== 1 || row?.id !== recovery.id ||
    row.profile_id !== survivorId ||
    row.gross_paid_minor !== journey.path.paid_amount_minor ||
    row.net_paid_minor !== journey.path.paid_amount_minor
  ) {
    throw new PaidTelemetryRepairError(
      "commerce_recovery_changed",
      "The exact recoverable commerce fact changed while locked.",
    );
  }

  await client.query(
    "select public.sidestream_customer_commerce_refresh_namespace($1)",
    [namespace],
  );
  const totals = await client.query<{ totals_current: boolean }>(
    `select exists (
       select 1
       from public.sidestream_customer_money_totals total
       where total.license_namespace = $1
         and total.profile_id = $2::uuid
         and total.currency = $3
         and total.gross_paid_minor >= $4::bigint
         and total.net_paid_minor >= $4::bigint
         and total.paid_transaction_count > 0
         and total.first_paid_at is not null
         and total.last_paid_at is not null
         and total.first_upgraded_at is not null
         and total.last_upgraded_at is not null
     ) as totals_current`,
    [namespace, survivorId, journey.path.paid_currency, journey.path.paid_amount_minor],
  );
  if (totals.rows.length !== 1 || totals.rows[0]?.totals_current !== true) {
    throw new PaidTelemetryRepairError(
      "commerce_refresh_failed",
      "The exact commerce totals did not refresh inside the repair transaction.",
    );
  }
}

async function insertExactBinding(
  client: QueryClient,
  namespace: PaidTelemetryRepairNamespace,
  journey: ExactJourney,
  survivorId: string,
): Promise<void> {
  const result = await client.query(
    `insert into public.sidestream_paid_telemetry_profile_bindings (
       license_namespace, claim_id, checkout_id, acquisition_id,
       account_id, entitlement_id, activation_ref, profile_id_at_binding,
       install_membership_id, install_id_hash, install_identity_link_id,
       activation_identity_link_id, account_identity_link_id,
       installer_receipt_identity_link_id, installer_receipt_id_hash,
       binding_key, bound_at
     ) values (
       $1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
       $8::uuid, $9::uuid, $10, $11::uuid, $12::uuid, $13::uuid,
       $14::uuid, $15, $16, transaction_timestamp()
     )
     on conflict do nothing
     returning id`,
    [
      namespace,
      journey.path.claim_id,
      journey.path.paid_checkout_id,
      journey.path.acquisition_id,
      journey.path.account_id,
      journey.path.entitlement_id,
      journey.path.activation_id,
      survivorId,
      journey.identity.install_membership_id,
      journey.identity.install_id_hash,
      journey.identity.install_identity_link_id,
      journey.identity.activation_identity_link_id,
      journey.identity.account_identity_link_id,
      journey.identity.receipt_identity_link_id,
      journey.identity.receipt_id_hash,
      journey.bindingKey,
    ],
  );
  if (result.rows.length !== 1) {
    throw new PaidTelemetryRepairError("binding_conflict", "Exact immutable binding conflicts.");
  }
}

function normalizePath(row: PaidPathRow): PaidPathRow {
  return Object.freeze({
    ...row,
    paid_quantity: row.paid_quantity === null ? null : Number(row.paid_quantity),
    paid_amount_minor: nullableString(row.paid_amount_minor),
    entitlement_amount_paid: String(row.entitlement_amount_paid),
    entitlement_amount_refunded: String(row.entitlement_amount_refunded),
  });
}

function normalizeIdentity(row: ExactIdentityRow): ExactIdentityRow {
  return Object.freeze({
    ...row,
    candidate_account_count: Number(row.candidate_account_count),
    existing_account_count: Number(row.existing_account_count),
  });
}

function normalizeCommerceState(row: CommerceStateRow | undefined): Readonly<{
  factCount: number;
  profileCount: number;
  conflictCount: number;
  recoverableFact: RecoverableCommerceFact | null;
  attachedPositive: boolean;
}> {
  const paymentKeyCount = boundedCount(row?.payment_key_count);
  const factCount = boundedCount(row?.fact_count);
  const profileCount = boundedCount(row?.profile_count);
  const unownedFactCount = boundedCount(row?.unowned_fact_count);
  const baseConflictCount = boundedCount(row?.base_conflict_count);
  const recoverableFactCount = boundedCount(row?.recoverable_fact_count);
  const exactRecoverable = paymentKeyCount === 1 && factCount === 1 &&
    profileCount === 0 && unownedFactCount === 1 && baseConflictCount === 0 &&
    recoverableFactCount === 1 && UUID.test(row?.recoverable_fact_id || "") &&
    Boolean(row?.recoverable_payment_key);
  const attachedPositive = row?.attached_positive === true &&
    paymentKeyCount === 1 && factCount > 0 && profileCount === 1 &&
    unownedFactCount === 0 && baseConflictCount === 0;
  const ready = exactRecoverable || attachedPositive;
  const conflictCount = ready
    ? 0
    : boundedCount(
      baseConflictCount + Math.max(paymentKeyCount - 1, 0) +
      unownedFactCount + 1,
    );
  return Object.freeze({
    factCount,
    profileCount,
    conflictCount,
    recoverableFact: exactRecoverable
      ? Object.freeze({
          id: row?.recoverable_fact_id || "",
          paymentKey: row?.recoverable_payment_key || "",
        })
      : null,
    attachedPositive,
  });
}

function normalizeCounts(row: MutableCounts | undefined): MutableCounts {
  return Object.freeze({
    authenticationStages: boundedCount(row?.authenticationStages),
    installationStages: boundedCount(row?.installationStages),
    bindings: boundedCount(row?.bindings),
    mergeAudits: boundedCount(row?.mergeAudits),
    acquisitionConflicts: boundedCount(row?.acquisitionConflicts),
    lifecycleStops: boundedCount(row?.lifecycleStops),
    commerceFacts: boundedCount(row?.commerceFacts),
    commerceProfiles: boundedCount(row?.commerceProfiles),
    commerceConflicts: boundedCount(row?.commerceConflicts),
  });
}

function boundedCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(Math.trunc(count), 3);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function deriveStageKey(
  namespace: PaidTelemetryRepairNamespace,
  stage: "authentication_completed" | "installation_claimed",
  stableReference: string,
): string {
  return sha256(`${STAGE_CONTEXT}:${namespace}:${stage}:${stableReference}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

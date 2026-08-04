import type { BrowserAcquisitionCookie } from "../_lib/acquisition-cookie.js";
import type { ServerOwnedDeliveryHandoff } from "../_lib/acquisition-handoff.js";
import {
  buildServerOwnedDeliveryHandoffUrl,
  createManyChatEmailDeliveryHandoff,
  verifyServerOwnedDeliveryHandoff,
} from "../_lib/acquisition-handoff.js";
import {
  createCanonicalAcquisitionRoot,
  generateAcquisitionId,
  recordAcquisitionStage,
} from "../_lib/acquisition-integrity.js";

export async function ensureBrowserAcquisition(cookie: BrowserAcquisitionCookie) {
  const attribution = cookie.attribution;
  const hasExternalReferrer = cookie.externalReferrerCategory !== null;
  await createCanonicalAcquisitionRoot({
    acquisitionId: cookie.acquisitionId,
    firstObservedAt: new Date(cookie.issuedAt * 1_000),
    landingDeduplicationReference: `browser-entry:${cookie.acquisitionId}`,
    source: attribution.source === "direct"
      ? hasExternalReferrer ? "external_referrer" : "website_direct_or_unknown"
      : attribution.source,
    medium: attribution.source === "direct" && hasExternalReferrer
      ? cookie.externalReferrerCategory
      : attribution.medium,
    campaign: attribution.campaign,
    contentCreative: attribution.content,
    entryChannel: "website",
    externalReferrerCategory: cookie.externalReferrerCategory,
    experiment: cookie.experiment
      ? { id: cookie.experiment.experimentId.toLowerCase(), cohort: cookie.experiment.cohort }
      : null,
    attributionConfidence: "exact_sidestream_entry",
    integrityState: "intact",
    trustedDeliveryEvidence: ["website_entry"],
  });
}

export async function ensureServerOwnedDeliveryAcquisition(
  handoff: ServerOwnedDeliveryHandoff,
  landingObservedAt?: Date,
) {
  await createCanonicalAcquisitionRoot({
    acquisitionId: handoff.acquisitionId,
    firstObservedAt: new Date(handoff.issuedAt * 1_000),
    landingDeduplicationReference: `delivery-entry:${handoff.entryChannel}:${handoff.acquisitionId}`,
    source: handoff.source,
    medium: "email",
    campaign: handoff.campaign,
    contentCreative: null,
    entryChannel: handoff.canonicalEntryChannel,
    externalReferrerCategory: handoff.externalReferrerCategory,
    attributionConfidence: "exact_trusted_delivery",
    integrityState: "intact",
    trustedDeliveryEvidence: ["signed_email_handoff"],
    recordLandingObserved: false,
  });
  await recordAcquisitionStage({
    acquisitionId: handoff.acquisitionId,
    stage: "email_handoff_created",
    stableServerReference: `delivery-handoff:${handoff.entryChannel}:${handoff.acquisitionId}`,
    occurredAt: new Date(handoff.issuedAt * 1_000),
  });
  if (landingObservedAt) {
    await recordAcquisitionStage({
      acquisitionId: handoff.acquisitionId,
      stage: "landing_observed",
      stableServerReference: `delivery-landing:${handoff.entryChannel}:${handoff.acquisitionId}`,
      occurredAt: landingObservedAt,
    });
  }
}

export async function issueManyChatEmailAcquisitionHandoff(
  input: Readonly<{ intendedIdentity: string }>,
  options: Readonly<{
    secret: string;
    now?: Date;
    randomBytes?: (size: number) => Uint8Array;
  }>,
) {
  const acquisitionId = generateAcquisitionId();
  const now = options.now || new Date();
  const token = createManyChatEmailDeliveryHandoff({
    acquisitionId,
    intendedIdentity: input.intendedIdentity,
  }, {
    secret: options.secret,
    now,
    randomBytes: options.randomBytes,
  });
  const handoff = verifyServerOwnedDeliveryHandoff(token, {
    secret: options.secret,
    now,
  });
  await ensureServerOwnedDeliveryAcquisition(handoff);
  return Object.freeze({
    acquisitionId,
    handoffUrl: buildServerOwnedDeliveryHandoffUrl(token),
  });
}

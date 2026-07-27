import {
  createBlobWaitlistHandler,
  type BlobWaitlistHandlerDependencies,
} from "./resolve-waitlist.js";

const AFTER_EFFECTS_WAITLIST_SOURCE = "after-effects-waitlist";
export const AFTER_EFFECTS_WAITLIST_BLOB_PREFIX =
  "sidestream/after-effects-waitlist/v1";

export function createAfterEffectsWaitlistHandler(
  overrides: Partial<BlobWaitlistHandlerDependencies> = {},
) {
  return createBlobWaitlistHandler({
    source: AFTER_EFFECTS_WAITLIST_SOURCE,
    blobPrefix: AFTER_EFFECTS_WAITLIST_BLOB_PREFIX,
    rateLimitScope: "after-effects-waitlist",
    logEvent: "after_effects_waitlist_capture",
  }, overrides);
}

const handler = createAfterEffectsWaitlistHandler();
export default handler;

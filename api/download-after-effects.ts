import { createDownloadHandler } from "./download.js";
import { readAfterEffectsReleaseManifest } from "./_lib/release-manifest.js";

// Same native artifact validation and short-lived signed delivery as Production.
// This account-disabled cohort must not create Production acquisition claims.
export const createAfterEffectsDownloadHandler = (overrides: Parameters<typeof createDownloadHandler>[0] = {}) =>
  createDownloadHandler({
    ...overrides,
    readManifest: (platform) => platform === "macos" ? readAfterEffectsReleaseManifest() : null,
    trackAcquisition: false,
  });

export default createAfterEffectsDownloadHandler();

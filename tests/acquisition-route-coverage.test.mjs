import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROUTE_POLICY = Object.freeze({
  "api/account/device.ts": "account_state",
  "api/acquisition/entry.ts": "acquisition_entry",
  "api/acquisition/observe.ts": "acquisition_entry",
  "api/activation/claim.ts": "acquisition_continuity",
  "api/activation/paid-claim.ts": "acquisition_continuity",
  "api/activation/start.ts": "acquisition_continuity",
  "api/activation/status.ts": "acquisition_continuity",
  "api/auth/google/callback.ts": "acquisition_stage",
  "api/auth/google/start.ts": "acquisition_continuity",
  "api/auth/logout.ts": "account_state",
  "api/auth/session.ts": "account_state",
  "api/billing/portal.ts": "billing_state",
  "api/billing/receipt.ts": "billing_state",
  "api/billing/subscription/cancel.ts": "billing_state",
  "api/checkout/complete.ts": "acquisition_stage",
  "api/checkout/offer.ts": "product_metadata",
  "api/checkout/start.ts": "acquisition_stage",
  "api/credits/finalize.ts": "credit_state",
  "api/credits/purchase.ts": "billing_state",
  "api/credits/reserve.ts": "credit_state",
  "api/credits/sync.ts": "credit_state",
  "api/download-lead.ts": "legacy_lead_capture",
  "api/download.ts": "product_delivery",
  "api/installation/claim-complete.ts": "acquisition_stage",
  "api/installation/claim-status.ts": "acquisition_continuity",
  "api/installation/claim.ts": "acquisition_continuity",
  "api/internal/customer-summary.ts": "operator_read",
  "api/internal/customer-usage/sync.ts": "operator_job",
  "api/internal/customers/[customerId].ts": "operator_read",
  "api/internal/customers/funnel.ts": "operator_read",
  "api/internal/customers/index.ts": "operator_read",
  "api/internal/customers/lookup.ts": "operator_read",
  "api/internal/download-leads/replay.ts": "operator_job",
  "api/internal/maintenance.ts": "operator_job",
  "api/internal/stripe-events/process.ts": "operator_job",
  "api/internal/support/audit.ts": "operator_job",
  "api/internal/support/process.ts": "operator_job",
  "api/internal/upgrade-pricing-report.ts": "operator_read",
  "api/license/authorize-download.ts": "entitlement_state",
  "api/license/deactivate.ts": "entitlement_state",
  "api/license/refresh.ts": "entitlement_state",
  "api/license/verify.ts": "entitlement_state",
  "api/paid-acquisition/artifact.ts": "product_delivery",
  "api/paid-acquisition/checkout.ts": "acquisition_stage",
  "api/paid-acquisition/claim.ts": "acquisition_continuity",
  "api/paid-acquisition/landing.ts": "acquisition_entry",
  "api/referral-visit.ts": "referral_observation",
  "api/releases/latest.ts": "product_metadata",
  "api/releases/paid-latest.ts": "product_metadata",
  "api/send-download-links.ts": "acquisition_stage",
  "api/stripe/webhook.ts": "acquisition_stage",
  "api/support/webhook.ts": "support_ingestion",
});

test("every public API handler has an explicit acquisition role", async () => {
  const discovered = (await listTypeScriptFiles("api"))
    .filter((filename) => !filename.split("/").includes("_lib"))
    .filter((filename) => path.basename(filename) !== "_lib.ts")
    .sort();
  assert.deepEqual(discovered, Object.keys(ROUTE_POLICY).sort());
});

test("the only installer delivery routes are canonical and receipt-gated", async () => {
  const deliveryRoutes = Object.entries(ROUTE_POLICY)
    .filter(([, role]) => role === "product_delivery")
    .map(([filename]) => filename)
    .sort();
  assert.deepEqual(deliveryRoutes, [
    "api/download.ts",
    "api/paid-acquisition/artifact.ts",
  ]);

  const [freeDownload, paidArtifact] = await Promise.all([
    readFile("api/download.ts", "utf8"),
    readFile("api/paid-acquisition/artifact.ts", "utf8"),
  ]);
  assert.match(freeDownload, /persistCanonicalInstallerRequest/);
  assert.match(paidArtifact, /getPaidAcquisitionReceiptState/);
  assert.match(paidArtifact, /recordPaidAcquisitionInstallerRequest/);
  await assert.rejects(readFile("api/paid-download.ts", "utf8"), /ENOENT/);
});

async function listTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filename = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listTypeScriptFiles(filename));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(filename);
  }
  return files;
}

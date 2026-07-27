import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEVICE_POLICY_ERROR_CODES,
  decideDeviceActivation,
  evaluateDeviceTransferLimit,
} from "../api/_lib/device-policy.ts";

const files = {
  claim: new URL("../api/activation/claim.ts", import.meta.url),
  checkoutStart: new URL("../api/checkout/start.ts", import.meta.url),
  account: new URL("../account.html", import.meta.url),
  thankYou: new URL("../thank-you.html", import.meta.url),
  index: new URL("../index.html", import.meta.url),
  llms: new URL("../public/llms.txt", import.meta.url),
};

test("account activation distinguishes empty, same-device, and transfer decisions", () => {
  const activeDevice = {
    namespace: "production",
    deviceIdHash: "a".repeat(64),
    revokedAt: null,
  };

  assert.deepEqual(decideDeviceActivation({
    namespace: "production",
    requestedDeviceIdHash: "a".repeat(64),
    activeDevice: null,
  }), { decision: "activate", errorCode: null });
  assert.deepEqual(decideDeviceActivation({
    namespace: "production",
    requestedDeviceIdHash: "a".repeat(64),
    activeDevice,
  }), { decision: "same_device", errorCode: null });
  assert.deepEqual(decideDeviceActivation({
    namespace: "production",
    requestedDeviceIdHash: "b".repeat(64),
    activeDevice,
  }), {
    decision: "transfer_required",
    errorCode: DEVICE_POLICY_ERROR_CODES.TRANSFER_REQUIRED,
  });
});

test("rolling device-transfer limit blocks before a fourth default move", () => {
  const nowMs = Date.UTC(2026, 6, 14, 20);
  const allowed = evaluateDeviceTransferLimit({
    transferTimestampsMs: [nowMs - 3, nowMs - 2],
    nowMs,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.remainingTransfers, 1);

  const blocked = evaluateDeviceTransferLimit({
    transferTimestampsMs: [nowMs - 3, nowMs - 2, nowMs - 1],
    nowMs,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.errorCode, DEVICE_POLICY_ERROR_CODES.TRANSFER_LIMIT_REACHED);
  assert.equal(blocked.remainingTransfers, 0);
});

test("Checkout authenticates first and then invokes the locked Stripe worker", async () => {
  const source = await readFile(files.checkoutStart, "utf8");
  const legacyHostGuard = source.indexOf("isLegacyVercelHost(request.headers.host)");
  const canonicalRedirect = source.indexOf("canonicalCheckout", legacyHostGuard);
  const sessionRead = source.indexOf("const session = await getSession(request)");
  const authRedirect = source.indexOf("/api/auth/google/start", sessionRead);
  const activeOwnerRedirect = source.indexOf("/api/activation/claim", sessionRead);
  const rateLimit = source.indexOf("await consumeRateLimit", activeOwnerRedirect);
  const intent = source.indexOf("await createCheckoutIntent", rateLimit);
  const checkout = source.indexOf("await createOrReuseCheckoutSession", intent);

  assert.ok(legacyHostGuard >= 0 && canonicalRedirect > legacyHostGuard);
  assert.ok(sessionRead > canonicalRedirect && authRedirect > sessionRead);
  assert.ok(activeOwnerRedirect > authRedirect && rateLimit > activeOwnerRedirect);
  assert.ok(intent > rateLimit && checkout > intent);
  assert.match(source, /if \(method !== "GET"\)/);
  assert.match(source, /return redirect\(response, result\.url\)/);
  assert.doesNotMatch(source, /text\/html|<form|<button/);
  assert.doesNotMatch(source, /stripe\.checkout\.sessions\.create/);
  assert.doesNotMatch(source, /attachCheckoutSessionToActivation\(/);
});

test("claim GET authenticates first and stays a no-store read-only decision", async () => {
  const source = await readFile(files.claim, "utf8");
  const getStart = source.indexOf('if (method === "GET")');
  const getSession = source.indexOf("const session = await getSession(request)", getStart);
  const authRedirect = source.indexOf("/api/auth/google/start", getStart);
  const decisionRead = source.indexOf("getActivationDecisionContext(", getSession);
  const postStart = source.indexOf("\n  const session = await getSession(request);", decisionRead);
  const getBranch = source.slice(getStart, postStart);

  assert.ok(getStart >= 0 && getSession > getStart);
  assert.ok(authRedirect > getSession && decisionRead > authRedirect);
  assert.doesNotMatch(getBranch, /claimActivationToAccount\(/);
  assert.doesNotMatch(getBranch, /confirmAccountDeviceTransfer\(/);
  assert.doesNotMatch(getBranch, /checkout\.sessions\.create/);
  assert.match(source, /Cache-Control", "no-store"/);
  assert.match(source, /Content-Security-Policy/);
  assert.match(source, /default-src 'none'/);
  assert.match(source, /form-action 'self'/);
  assert.match(source, /noindex,nofollow/);
});

test("a signed-in Free activation continues directly to Checkout", async () => {
  const claim = await readFile(files.claim, "utf8");
  const freeBranch = claim.indexOf("if (!session.license.active)");
  const purchaseEligibility = claim.indexOf("activation.canPurchase", freeBranch);
  const checkoutUrl = claim.indexOf('new URL("/api/checkout/start"', purchaseEligibility);
  const checkoutRedirect = claim.indexOf("return redirect(response, checkoutUrl.toString())", checkoutUrl);

  assert.ok(freeBranch >= 0 && purchaseEligibility > freeBranch);
  assert.ok(checkoutUrl > purchaseEligibility && checkoutRedirect > checkoutUrl);
  assert.doesNotMatch(claim, /\/api\/checkout\/create/);
});

test("transfer POST requires CSRF plus explicit intent and limits before mutation", async () => {
  const source = await readFile(files.claim, "utf8");
  const getDecision = source.indexOf("getActivationDecisionContext(");
  const postStart = source.indexOf("\n  const session = await getSession(request);", getDecision);
  const post = source.slice(postStart, source.indexOf("\nasync function getActivationDecisionContext", postStart));
  const csrf = post.indexOf("validateActivationPost(");
  const decision = post.indexOf("getDeviceDecision(");
  const emptySlotLimit = post.indexOf("getTransferLimitState(", decision);
  const explicitIntent = post.indexOf('intent !== "transfer"');
  const limit = post.indexOf("getTransferLimitState(", explicitIntent);
  const claim = post.indexOf("claimActivationToAccount(");
  const transfer = post.indexOf("confirmAccountDeviceTransfer(");

  assert.ok(postStart >= 0);
  assert.ok(csrf >= 0 && decision > csrf);
  assert.ok(emptySlotLimit > decision && explicitIntent > emptySlotLimit && limit > explicitIntent);
  assert.ok(claim > limit && transfer > claim);
  assert.match(post, /transfer_confirmation/);
  assert.match(post, /deactivate_previous_device/);
  assert.match(post, /TRANSFER_LIMIT_REACHED/);
  assert.match(post, /expectedPriorDeviceId:/);
  assert.match(post, /expectedPriorDeviceIdHash:/);
  assert.match(post, /newDeviceIdHash:/);
  assert.match(post, /initiatedBy: "account"/);
  assert.match(post, /transferReason: "device_change"/);
});

test("decision reads and transfer counts remain account and namespace bound", async () => {
  const source = await readFile(files.claim, "utf8");

  assert.match(source, /canBindActivationAccount\(/);
  assert.match(source, /isActivationClaimReplay\(/);
  assert.match(source, /where account_id = \$2\s+and license_namespace = \$3\s+and revoked_at is null/);
  assert.match(source, /from public\.sidestream_device_transfers\s+where account_id = \$1\s+and license_namespace = \$2/);
  assert.match(source, /resolveRequestLicenseEnvironment\(request\)/);
  assert.match(source, /environment,/);
  assert.match(source, /Moving Sidestream Pro here will deactivate the previous device/);
  assert.match(source, /same_device/);
});

test("public and account copy states one production device with confirmed deactivation", async () => {
  const [account, thankYou, index, llms] = await Promise.all([
    readFile(files.account, "utf8"),
    readFile(files.thankYou, "utf8"),
    readFile(files.index, "utf8"),
    readFile(files.llms, "utf8"),
  ]);

  for (const page of [account, thankYou]) {
    assert.match(page, /noindex, nofollow/);
  }
  assert.match(account, /Active production device/);
  assert.match(account, /No active production device/);
  assert.match(account, /deactivate-device-button[^>]+disabled/);
  assert.match(account, /fetch\("\/api\/account\/device"/);
  assert.match(account, /window\.confirm\("Deactivate the active Sidestream device\?/);
  assert.match(account, /apiPost\("\/api\/license\/deactivate", \{\s*intent: "deactivate_active_device"/);
  assert.match(account, /receipt-button/);
  assert.match(account, /refund-button/);
  assert.match(index, /href="\/api\/auth\/google\/start\?next=\/account\.html">Account<\/a>/);
  assert.match(account, /<main id="account-main" hidden>/);
  assert.match(account, /window\.location\.replace\(signInLink\.href\)/);
  assert.match(account, /window\.location\.assign\("\/"\)/);
  assert.match(account, /background: var\(--bg\)/);
  assert.doesNotMatch(account, /radial-gradient/);
  assert.doesNotMatch(account, /id="signed-out"/);
  assert.match(thankYou, /one active production device at a time/i);
  assert.match(thankYou, /instead of charging you again/);
  assert.match(account, /href="\/api\/checkout\/start">Upgrade<\/a>/);
  assert.match(index, /href="\/api\/checkout\/start">Upgrade to Pro<\/a>/);
  assert.match(index, /One active production device at a time/);
  assert.match(llms, /one active production device at a time/);
});

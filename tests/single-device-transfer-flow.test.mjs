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
  checkoutCreate: new URL("../api/checkout/create.ts", import.meta.url),
  account: new URL("../account.html", import.meta.url),
  thankYou: new URL("../thank-you.html", import.meta.url),
  upgrade: new URL("../upgrade.html", import.meta.url),
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

test("legacy activation-bearing Checkout GET redirects before any Stripe state", async () => {
  const source = await readFile(files.checkoutStart, "utf8");
  const activationGuard = source.indexOf("if (activationKey)");
  const decisionRedirect = source.indexOf("/api/activation/claim", activationGuard);
  const stripeClient = source.indexOf("const stripe = getStripe()");
  const stripeCreate = source.indexOf("stripe.checkout.sessions.create");

  assert.ok(activationGuard >= 0);
  assert.ok(decisionRedirect > activationGuard && decisionRedirect < stripeClient);
  assert.ok(stripeClient > decisionRedirect && stripeCreate > stripeClient);
  assert.match(source, /if \(method !== "GET"\)/);
  assert.match(source, /buildCheckoutCompletionUrl\(baseUrl\)/);
  assert.doesNotMatch(source, /getActivationCheckoutContext\(/);
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

test("free activation purchase is an explicit authenticated POST with the key", async () => {
  const [claim, create] = await Promise.all([
    readFile(files.claim, "utf8"),
    readFile(files.checkoutCreate, "utf8"),
  ]);
  const requireSession = create.indexOf("await requireSession(request, response)");
  const activeOwner = create.indexOf("activationKey && session.license.active");
  const stripeClient = create.indexOf("const stripe = getStripe()");

  assert.match(claim, /form method="post" action="\/api\/checkout\/create"/);
  assert.match(claim, /name="activationKey"/);
  assert.match(claim, /name="intent" value="purchase"/);
  assert.match(create, /application\/x-www-form-urlencoded/);
  assert.match(create, /cleanString\(payload\.intent, 32\) !== "purchase"/);
  assert.ok(requireSession >= 0 && activeOwner > requireSession && stripeClient > activeOwner);
  assert.match(create, /attachCheckoutSessionToActivation/);
  assert.match(create, /getActivationCheckoutIdempotencyKey/);
  assert.match(create, /sendCheckoutDestination\(response, browserForm/);
});

test("transfer POST requires CSRF plus explicit intent and limits before mutation", async () => {
  const source = await readFile(files.claim, "utf8");
  const getDecision = source.indexOf("getActivationDecisionContext(");
  const postStart = source.indexOf("\n  const session = await getSession(request);", getDecision);
  const post = source.slice(postStart, source.indexOf("\nasync function getActivationDecisionContext", postStart));
  const csrf = post.indexOf("validateActivationPost(");
  const decision = post.indexOf("getDeviceDecision(");
  const explicitIntent = post.indexOf('intent !== "transfer"');
  const limit = post.indexOf("getTransferLimitState(");
  const claim = post.indexOf("claimActivationToAccount(");
  const transfer = post.indexOf("confirmAccountDeviceTransfer(");

  assert.ok(postStart >= 0);
  assert.ok(csrf >= 0 && decision > csrf);
  assert.ok(explicitIntent > decision && limit > explicitIntent);
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

test("public and account copy states one production device without faking deactivation", async () => {
  const [account, thankYou, upgrade, index, llms] = await Promise.all([
    readFile(files.account, "utf8"),
    readFile(files.thankYou, "utf8"),
    readFile(files.upgrade, "utf8"),
    readFile(files.index, "utf8"),
    readFile(files.llms, "utf8"),
  ]);

  for (const page of [account, thankYou, upgrade]) {
    assert.match(page, /noindex, nofollow/);
  }
  assert.match(account, /Active production device/);
  assert.match(account, /One active device at a time/);
  assert.match(account, /Deactivate unavailable/);
  assert.match(account, /deactivate-device-button[^>]+disabled/);
  assert.doesNotMatch(account, /fetch\([^)]*deactivate/i);
  assert.match(account, /receipt-button/);
  assert.match(account, /refund-button/);
  assert.match(thankYou, /one active production device at a time/i);
  assert.match(thankYou, /instead of charging you again/);
  assert.match(upgrade, /One active production device at a time/);
  assert.match(upgrade, /activationKey \? "\/api\/activation\/claim" : "\/api\/checkout\/start"/);
  assert.match(index, /One active production device at a time/);
  assert.match(llms, /one active production device at a time/);
});

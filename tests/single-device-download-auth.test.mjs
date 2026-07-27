import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  account: new URL("../api/_lib/account.ts", import.meta.url),
  authorize: new URL("../api/license/authorize-download.ts", import.meta.url),
  deactivate: new URL("../api/license/deactivate.ts", import.meta.url),
  device: new URL("../api/account/device.ts", import.meta.url),
  session: new URL("../api/auth/session.ts", import.meta.url),
  claim: new URL("../api/activation/claim.ts", import.meta.url),
};

async function accountFunction(startMarker, endMarker) {
  const source = await readFile(files.account, "utf8");
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} should precede ${endMarker}`);
  return source.slice(start, end);
}

test("download authorization uses access auth and verifies its refresh family", async () => {
  const source = await accountFunction(
    "export async function authorizeLicenseDownload",
    "export async function getAccountDeviceStatus",
  );

  assert.match(source, /requireMatchingLicenseEnvironment\(options\.environment\)/);
  assert.match(source, /where token_hash = \$1\s+order by created_at desc/i);
  assert.match(source, /where t\.token_hash = \$1\s+and t\.account_id = \$2/i);
  assert.match(source, /getAccountDeviceLockKey\(accountId, environment\.namespace\)/);
  assert.match(source, /for update of t/i);
  assert.match(source, /matchesDeviceHash\(credential\.device_id_hash, deviceIdHash\)/);
  assert.match(source, /claimEmpty: false/);
  assert.match(source, /credentialCreatedAt: credential\.created_at/);
  assert.match(source, /!binding\.bindingMatches/);
  assert.match(source, /!credential\.revoked_at/);
  assert.match(source, /credential\.expires_at/);
  assert.match(source, /Boolean\(credential\.refresh_token_hash\)/);
  assert.match(source, /credential\.refresh_expires_at/);
});

test("download route exposes only stable active, device, license, and retry outcomes", async () => {
  const source = await readFile(files.authorize, "utf8");

  assert.match(source, /if \(method !== "POST"\)/);
  assert.match(source, /cleanString\(payload\.licenseToken, 500\)/);
  assert.match(source, /cleanString\(payload\.deviceId, 240\)/);
  assert.doesNotMatch(source, /payload\.refreshToken/);
  assert.match(source, /resolveRequestLicenseEnvironment\(request\)/);
  assert.match(source, /sendJson\(response, 200, \{ active: true \}\)/);
  assert.match(source, /sendJson\(response, 403,[\s\S]+code: "license_inactive"/);
  assert.match(source, /sendJson\(response, 401,[\s\S]+code: authorization\.code/);
  assert.match(source, /code: "device_deactivated"/);
  assert.match(source, /code: "authorization_unavailable"/);
  assert.match(source, /retryable: true/);
  assert.doesNotMatch(source, /license:\s*authorization/);
  assert.doesNotMatch(source, /account(Id|_id)\s*:/i);
  assert.doesNotMatch(source, /device(Id|_id|Hash)\s*:/i);
});

test("device status is authenticated, namespace-bound, coarse, and read-only", async () => {
  const [route, helper] = await Promise.all([
    readFile(files.device, "utf8"),
    accountFunction(
      "export async function getAccountDeviceStatus",
      "export async function deactivateAccountDevice",
    ),
  ]);

  assert.match(route, /if \(method !== "GET"\)/);
  assert.match(route, /await getSession\(request, \{ reconcileStripeEvents: false \}\)/);
  assert.match(route, /resolveRequestLicenseEnvironment\(request\)/);
  assert.match(route, /getAccountDeviceStatus\(\s*session\.accountId,\s*environment/);
  assert.match(helper, /where account_id = \$1\s+and license_namespace = \$2\s+and revoked_at is null/i);
  assert.match(helper, /select platform, activated_at, last_seen_at/i);
  assert.doesNotMatch(helper, /\b(insert|update|delete)\b/i);
  assert.doesNotMatch(helper, /device_id_hash/i);
});

test("deactivation requires a signed-in explicit same-origin JSON POST", async () => {
  const [route, account] = await Promise.all([
    readFile(files.deactivate, "utf8"),
    readFile(files.account, "utf8"),
  ]);
  const auth = route.indexOf("await getSession(request)");
  const intent = route.indexOf("intent !== DEVICE_DEACTIVATION_INTENT");
  const origin = route.indexOf("validateSameOriginJsonMutation(request)");
  const environment = route.indexOf("resolveRequestLicenseEnvironment(request)");
  const mutation = route.indexOf("deactivateAccountDevice({");

  assert.match(route, /if \(method !== "POST"\)/);
  assert.ok(auth >= 0 && intent > auth && origin > intent);
  assert.ok(environment > origin && mutation > environment);
  assert.match(account, /DEVICE_DEACTIVATION_INTENT = "deactivate_active_device"/);
  assert.match(account, /contentType\.startsWith\("application\/json"\)/);
  assert.match(account, /new URL\(\s*firstHeaderValue\(request\.headers\.origin\)/);
  assert.match(account, /new URL\(getBaseUrl\(request\)\)\.origin/);
  assert.doesNotMatch(route, /Stripe|billingPortal|portal/i);
});

test("deactivation revokes the slot and every live token in one transaction", async () => {
  const source = await accountFunction(
    "export async function deactivateAccountDevice",
    "async function checkActivationDeviceBinding",
  );
  const begin = source.indexOf('client.query("begin")');
  const lock = source.indexOf("pg_advisory_xact_lock");
  const rowLock = source.indexOf("for update");
  const revokeDevice = source.indexOf("revocation_reason = 'deactivated'");
  const revokeTokens = source.indexOf("update public.sidestream_license_tokens");
  const commit = source.indexOf('client.query("commit")', revokeTokens);

  assert.ok(begin >= 0 && lock > begin && rowLock > lock);
  assert.ok(revokeDevice > rowLock && revokeTokens > revokeDevice && commit > revokeTokens);
  assert.match(source, /where account_id = \$1\s+and revoked_at is null/i);
  assert.match(source, /license_namespace = \$3/);
  assert.doesNotMatch(source, /\bdelete\s+from\b/i);
  assert.doesNotMatch(source, /insert into public\.sidestream_device_transfers/i);
});

test("retained device lifecycle rows still count after deactivate then reactivate", async () => {
  const [deactivation, claim] = await Promise.all([
    accountFunction(
      "export async function deactivateAccountDevice",
      "async function checkActivationDeviceBinding",
    ),
    readFile(files.claim, "utf8"),
  ]);

  assert.doesNotMatch(deactivation, /delete from public\.sidestream_account_devices/i);
  assert.match(
    claim,
    /select id, device_id_hash, activated_at\s+from public\.sidestream_account_devices\s+where account_id = \$1\s+and license_namespace = \$2\s+order by activated_at asc/is,
  );
  assert.match(claim, /getConfirmedDeviceMoveTimestamps\(/);
  assert.match(claim, /deviceIdHash: device\.device_id_hash/);
});

test("all account GET surfaces remain free of device mutation calls", async () => {
  const [device, session] = await Promise.all([
    readFile(files.device, "utf8"),
    readFile(files.session, "utf8"),
  ]);

  assert.match(device, /if \(method !== "GET"\)/);
  assert.match(session, /if \(method !== "GET"\)/);
  for (const source of [device, session]) {
    assert.doesNotMatch(source, /deactivateAccountDevice/);
    assert.doesNotMatch(source, /authorizeLicenseDownload/);
  }
});

test("account sessions distinguish a completed one-time purchase from Stripe customer existence", async () => {
  const source = await readFile(files.account, "utf8");

  assert.match(
    source,
    /exists \(\s*select 1\s*from public\.sidestream_licenses purchase[\s\S]+purchase\.stripe_subscription_id is null[\s\S]+purchase\.stripe_payment_intent_id is not null[\s\S]+purchase\.stripe_checkout_session_id is not null[\s\S]+\) as has_one_time_purchase/,
  );
  assert.match(source, /hasOneTimePurchase: row\.has_one_time_purchase/);
  assert.match(source, /hasOneTimePurchase: session\.hasOneTimePurchase/);
});

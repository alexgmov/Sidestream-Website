import type { ServerResponse } from "node:http";
import {
  claimActivationToAccount,
  cleanString,
  confirmAccountDeviceTransfer,
  createActivationClaimCsrf,
  getBaseUrl,
  getSession,
  isPendingShippedPanelUpgrade,
  methodNotAllowed,
  query,
  readRequestBody,
  redirect,
  resolveRequestLicenseEnvironment,
  sendJson,
  validateActivationClaimRequest,
  type AccountRequest,
  type AccountSession,
} from "../_lib/account.js";
import {
  DEVICE_POLICY_ERROR_CODES,
  decideDeviceActivation,
  evaluateDeviceTransferLimit,
  getConfirmedDeviceMoveTimestamps,
  getDeviceTransferLimitOverride,
  type DeviceNamespace,
} from "../_lib/device-policy.js";
import {
  canBindActivationAccount,
  isActivationClaimReplay,
} from "../_lib/entitlement.js";

type ActivationDecisionContext = {
  accountId: string | null;
  status: string;
  deviceIdHash: string;
  appVersion: string;
  buildChannel: string;
  canPurchase: boolean;
  activeDevice: {
    id: string;
    deviceIdHash: string;
    platform: string;
    activatedAt: Date | string;
  } | null;
  latestDeviceIdHash: string;
};

type CustomerIdentityFields = {
  installIdHash?: string;
  supportCode?: string;
  installerReceiptIdHash?: string;
};

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  const method = (request.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return methodNotAllowed(response, "GET, POST");
  }

  const baseUrl = getBaseUrl(request);
  if (method === "GET") {
    const requestUrl = new URL(request.url || "/api/activation/claim", baseUrl);
    const activationKey = cleanString(requestUrl.searchParams.get("activation"), 160);
    if (!activationKey) return sendJson(response, 400, { error: "Missing activation key" });
    const identity = readCustomerIdentityFields({
      installIdHash: requestUrl.searchParams.get("installIdHash"),
      supportCode: requestUrl.searchParams.get("supportCode"),
      installerReceiptIdHash: requestUrl.searchParams.get("installerReceiptIdHash"),
    });
    if (!identity) {
      return sendJson(response, 400, {
        error: "Invalid customer identity",
        code: "invalid_customer_identity",
      });
    }

    const session = await getSession(request);

    // Older v1.0.14 activations lack the edge-rewrite marker now returned by
    // activation/start. Preserve those saved capabilities for signed-out and
    // Free accounts, but keep active owners on the claim path: Checkout sends
    // them here to reconnect, so sending them back would create a redirect loop.
    if (
      !session?.license.active &&
      await isPendingShippedPanelUpgrade(activationKey)
    ) {
      const checkoutUrl = new URL("/api/checkout/start", baseUrl);
      checkoutUrl.searchParams.set("activation", activationKey);
      return redirect(response, checkoutUrl.toString(), 302);
    }

    if (!session) {
      const nextPath = activationClaimPath(activationKey, identity);
      const signIn = new URL("/api/auth/google/start", baseUrl);
      signIn.searchParams.set("next", nextPath);
      return redirect(response, signIn.toString(), 302);
    }

    const environment = resolveRequestLicenseEnvironment(request);
    if (!environment) {
      return sendConfirmationPage(response, 503, environmentUnavailablePage());
    }
    const activation = await getActivationDecisionContext(
      activationKey,
      session.accountId,
      environment.namespace,
    );
    if (!activation) {
      return sendConfirmationPage(response, 409, unavailablePage());
    }

    if (!session.license.active) {
      if (!activation.canPurchase) {
        return sendConfirmationPage(response, 409, unavailablePage());
      }
      const checkoutUrl = new URL("/api/checkout/start", baseUrl);
      checkoutUrl.searchParams.set("activation", activationKey);
      return redirect(response, checkoutUrl.toString(), 303);
    }

    const decision = getDeviceDecision(activation, environment.namespace);
    if (isEmptySlotDeviceMove(activation, decision.decision)) {
      const transferLimit = await getTransferLimitState(session, environment.namespace);
      if (!transferLimit.allowed) {
        return sendConfirmationPage(response, 409, transferLimitPage({
          limit: transferLimit.limit,
          email: session.email,
        }));
      }
    }
    const csrfToken = createActivationClaimCsrf(activationKey, session.accountId);
    if (decision.decision === "transfer_required" && activation.activeDevice) {
      const transferLimit = await getTransferLimitState(
        session,
        environment.namespace,
      );
      if (!transferLimit.allowed) {
        return sendConfirmationPage(response, 409, transferLimitPage({
          limit: transferLimit.limit,
          email: session.email,
        }));
      }
      return sendConfirmationPage(response, 200, transferPage({
        activationKey,
        csrfToken,
        email: session.email,
        appVersion: activation.appVersion,
        activeDevice: activation.activeDevice,
        transferLimit: transferLimit.limit,
        remainingTransfers: transferLimit.remainingTransfers,
        identity,
      }));
    }

    return sendConfirmationPage(response, 200, reconnectPage({
      activationKey,
      csrfToken,
      email: session.email,
      appVersion: activation.appVersion,
      sameDevice: decision.decision === "same_device",
      identity,
    }));
  }

  const session = await getSession(request);
  if (!session) return sendJson(response, 401, { error: "Authentication required" });
  if (!session.license.active) {
    return sendJson(response, 403, { error: "An active Sidestream Pro license is required" });
  }

  const form = new URLSearchParams(await readRequestBody(request));
  const activationKey = cleanString(form.get("activation"), 160);
  const csrfToken = cleanString(form.get("csrf"), 500);
  const intent = cleanString(form.get("intent"), 32);
  if (!activationKey || !csrfToken || !["restore", "transfer"].includes(intent)) {
    return sendJson(response, 400, {
      error: "Invalid restore confirmation",
      code: "invalid_intent",
    });
  }
  const identity = readCustomerIdentityFields({
    installIdHash: form.get("installIdHash"),
    supportCode: form.get("supportCode"),
    installerReceiptIdHash: form.get("installerReceiptIdHash"),
  });
  if (!identity) {
    return sendJson(response, 400, {
      error: "Invalid customer identity",
      code: "invalid_customer_identity",
    });
  }
  if (!validateActivationPost(request, activationKey, session.accountId, csrfToken)) {
    return sendJson(response, 403, {
      error: "Invalid restore confirmation",
      code: "csrf_rejected",
    });
  }

  const environment = resolveRequestLicenseEnvironment(request);
  if (!environment) {
    return sendJson(response, 503, {
      error: "License environment unavailable",
      code: "license_environment_unavailable",
    });
  }
  const activation = await getActivationDecisionContext(
    activationKey,
    session.accountId,
    environment.namespace,
  );
  if (!activation) {
    return sendJson(response, 409, {
      error: "Activation could not be restored",
      code: "unavailable",
    });
  }

  const decision = getDeviceDecision(activation, environment.namespace);
  if (isEmptySlotDeviceMove(activation, decision.decision)) {
    const transferLimit = await getTransferLimitState(session, environment.namespace);
    if (!transferLimit.allowed) {
      return sendJson(response, 409, {
        error: "Device transfer limit reached",
        code: DEVICE_POLICY_ERROR_CODES.TRANSFER_LIMIT_REACHED,
        limit: transferLimit.limit,
        remainingTransfers: transferLimit.remainingTransfers,
      });
    }
  }
  if (decision.decision === "transfer_required") {
    if (
      intent !== "transfer" ||
      form.get("transfer_confirmation") !== "deactivate_previous_device"
    ) {
      return sendJson(response, 400, {
        error: "Confirm that the previous device will be deactivated",
        code: "transfer_intent_required",
      });
    }
    if (!activation.activeDevice) {
      return sendJson(response, 409, {
        error: "Active device changed; review the connection again",
        code: "binding_changed",
      });
    }

    const transferLimit = await getTransferLimitState(session, environment.namespace);
    if (!transferLimit.allowed) {
      return sendJson(response, 409, {
        error: "Device transfer limit reached",
        code: DEVICE_POLICY_ERROR_CODES.TRANSFER_LIMIT_REACHED,
        limit: transferLimit.limit,
        remainingTransfers: transferLimit.remainingTransfers,
      });
    }

    const claimed = await claimActivationToAccount(activationKey, session.accountId, {
      environment,
      identity,
    });
    if (!claimed.claimed) {
      return sendJson(response, 409, {
        error: "Activation could not be restored",
        code: claimed.reason,
      });
    }
    const transferred = await confirmAccountDeviceTransfer({
      accountId: session.accountId,
      environment,
      expectedPriorDeviceId: activation.activeDevice.id,
      expectedPriorDeviceIdHash: activation.activeDevice.deviceIdHash,
      newDeviceIdHash: activation.deviceIdHash,
      platform: "unknown",
      appVersion: activation.appVersion,
      buildChannel: activation.buildChannel,
      initiatedBy: "account",
      transferReason: "device_change",
    });
    if (!transferred.transferred && transferred.reason === "binding_changed") {
      return sendJson(response, 409, {
        error: "Active device changed; review the connection again",
        code: "binding_changed",
      });
    }

    return redirectToSuccess(response, baseUrl, activationKey, "transferred");
  }

  if (intent !== "restore") {
    return sendJson(response, 409, {
      error: "Device state changed; review the connection again",
      code: "binding_changed",
    });
  }
  const claimed = await claimActivationToAccount(activationKey, session.accountId, {
    environment,
    identity,
  });
  if (!claimed.claimed) {
    return sendJson(response, 409, {
      error: "Activation could not be restored",
      code: claimed.reason,
    });
  }
  return redirectToSuccess(response, baseUrl, activationKey, "restored");
}

async function getActivationDecisionContext(
  activationKey: string,
  accountId: string,
  namespace: DeviceNamespace,
): Promise<ActivationDecisionContext | null> {
  const result = await query<{
    activation_account_id: string | null;
    status: string;
    completed_at: Date | string | null;
    expired: boolean;
    device_id_hash: string;
    app_version: string | null;
    build_channel: string | null;
    active_device_id: string | null;
    active_device_id_hash: string | null;
    active_device_platform: string | null;
    active_device_activated_at: Date | string | null;
    latest_device_id_hash: string | null;
  }>(
    `
      select
        a.account_id as activation_account_id,
        a.status,
        a.completed_at,
        a.expires_at <= now() as expired,
        a.device_id_hash,
        a.app_version,
        a.build_channel,
        d.id as active_device_id,
        d.device_id_hash as active_device_id_hash,
        d.platform as active_device_platform,
        d.activated_at as active_device_activated_at,
        h.device_id_hash as latest_device_id_hash
      from public.sidestream_activation_sessions a
      left join lateral (
        select id, device_id_hash, platform, activated_at
        from public.sidestream_account_devices
        where account_id = $2
          and license_namespace = $3
          and revoked_at is null
        order by activated_at desc, id desc
        limit 1
      ) d on true
      left join lateral (
        select device_id_hash
        from public.sidestream_account_devices
        where account_id = $2
          and license_namespace = $3
        order by activated_at desc, id desc
        limit 1
      ) h on true
      where a.activation_key = $1
        and a.device_id_hash is not null
      limit 1
    `,
    [activationKey, accountId, namespace],
  );

  const row = result.rows[0];
  if (!row) return null;
  const freshClaim = !row.expired && !row.completed_at && row.status === "pending" &&
    canBindActivationAccount(row.activation_account_id, accountId);
  const replay = isActivationClaimReplay({
    existingAccountId: row.activation_account_id,
    requestedAccountId: accountId,
    status: row.status,
    expired: row.expired,
  });
  if (!freshClaim && !replay) return null;

  return {
    accountId: row.activation_account_id,
    status: row.status,
    deviceIdHash: row.device_id_hash,
    appVersion: row.app_version || "",
    buildChannel: row.build_channel || "",
    canPurchase: freshClaim && row.activation_account_id === null,
    activeDevice: row.active_device_id &&
        row.active_device_id_hash &&
        row.active_device_activated_at
      ? {
          id: row.active_device_id,
          deviceIdHash: row.active_device_id_hash,
          platform: row.active_device_platform || "unknown",
          activatedAt: row.active_device_activated_at,
        }
      : null,
    latestDeviceIdHash: row.latest_device_id_hash || "",
  };
}

function isEmptySlotDeviceMove(
  activation: ActivationDecisionContext,
  decision: "activate" | "same_device" | "transfer_required",
) {
  return decision === "activate" &&
    Boolean(activation.latestDeviceIdHash) &&
    activation.latestDeviceIdHash !== activation.deviceIdHash;
}

function getDeviceDecision(
  activation: ActivationDecisionContext,
  namespace: DeviceNamespace,
) {
  return decideDeviceActivation({
    namespace,
    requestedDeviceIdHash: activation.deviceIdHash,
    activeDevice: activation.activeDevice
      ? {
          namespace,
          deviceIdHash: activation.activeDevice.deviceIdHash,
          revokedAt: null,
        }
      : null,
  });
}

async function getTransferLimitState(
  session: AccountSession,
  namespace: DeviceNamespace,
) {
  const nowMs = Date.now();
  const [devices, transfers] = await Promise.all([
    query<{
      id: string;
      device_id_hash: string;
      activated_at: Date | string;
    }>(
      `
        select id, device_id_hash, activated_at
        from public.sidestream_account_devices
        where account_id = $1
          and license_namespace = $2
        order by activated_at asc, id asc
      `,
      [session.accountId, namespace],
    ),
    query<{
      from_device_id: string;
      to_device_id: string;
      transferred_at: Date | string;
    }>(
      `
        select from_device_id, to_device_id, transferred_at
        from public.sidestream_device_transfers
        where account_id = $1
          and license_namespace = $2
        order by transferred_at asc, id asc
      `,
      [session.accountId, namespace],
    ),
  ]);
  return evaluateDeviceTransferLimit({
    transferTimestampsMs: getConfirmedDeviceMoveTimestamps({
      devices: devices.rows.map((device) => ({
        id: device.id,
        deviceIdHash: device.device_id_hash,
        activatedAt: device.activated_at,
      })),
      transfers: transfers.rows.map((transfer) => ({
        fromDeviceId: transfer.from_device_id,
        toDeviceId: transfer.to_device_id,
        transferredAt: transfer.transferred_at,
      })),
    }),
    nowMs,
    configuredLimit: getDeviceTransferLimitOverride(
      session.license.features,
      namespace,
      nowMs,
    ),
  });
}

function validateActivationPost(
  request: AccountRequest,
  activationKey: string,
  accountId: string,
  csrfToken: string,
) {
  return validateActivationClaimRequest(request, {
    activationKey,
    accountId,
    csrfToken,
  });
}

function redirectToSuccess(
  response: ServerResponse,
  baseUrl: string,
  activationKey: string,
  connection: "restored" | "transferred",
) {
  const destination = new URL("/thank-you.html", baseUrl);
  destination.searchParams.set("restore", "success");
  destination.searchParams.set("connection", connection);
  destination.searchParams.set("activation", activationKey);
  return redirect(response, destination.toString());
}

function sendConfirmationPage(response: ServerResponse, statusCode: number, html: string) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("X-Frame-Options", "DENY");
  response.end(html);
}

function reconnectPage(options: {
  activationKey: string;
  csrfToken: string;
  email: string;
  appVersion: string;
  sameDevice: boolean;
  identity: CustomerIdentityFields;
}) {
  return decisionPage({
    title: options.sameDevice
      ? "Reconnect Sidestream Pro on this device?"
      : "Connect Sidestream Pro to this device?",
    description: options.sameDevice
      ? "This is already your active production device. Reconnecting is safe and will not use a device transfer."
      : "No active production device is registered for this account. Connect this device to restore Sidestream Pro.",
    email: options.email,
    appVersion: options.appVersion,
    detail: "Only continue if you started Upgrade or Restore Purchase from Sidestream on this computer.",
    action: claimForm({
      activationKey: options.activationKey,
      csrfToken: options.csrfToken,
      intent: "restore",
      label: options.sameDevice ? "Reconnect this device" : "Connect this device",
      identity: options.identity,
    }),
  });
}

function transferPage(options: {
  activationKey: string;
  csrfToken: string;
  email: string;
  appVersion: string;
  activeDevice: NonNullable<ActivationDecisionContext["activeDevice"]>;
  transferLimit: number;
  remainingTransfers: number;
  identity: CustomerIdentityFields;
}) {
  const device = formatActiveDevice(options.activeDevice);
  return decisionPage({
    title: "Move Sidestream Pro to this device?",
    description: "Moving Sidestream Pro here will deactivate the previous device and revoke its Pro access.",
    email: options.email,
    appVersion: options.appVersion,
    detail: `${device}. ${options.remainingTransfers} of ${options.transferLimit} device moves remain in the current rolling 30-day window.`,
    action: `<form method="post" action="/api/activation/claim"><input type="hidden" name="activation" value="${escapeHtml(options.activationKey)}"><input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken)}"><input type="hidden" name="intent" value="transfer">${customerIdentityHiddenInputs(options.identity)}<label class="confirm"><input type="checkbox" name="transfer_confirmation" value="deactivate_previous_device" required><span>I understand the previous device will be deactivated.</span></label><button type="submit">Move Sidestream Pro here</button></form>`,
  });
}

function transferLimitPage(options: { limit: number; email: string }) {
  return decisionPage({
    title: "Device move limit reached",
    description: `This account has used its ${options.limit} device moves for the current rolling 30-day window. No device was changed.`,
    email: options.email,
    detail: "Contact Sidestream support if a lost or repaired computer is blocking access.",
    action: "",
  });
}

function claimForm(options: {
  activationKey: string;
  csrfToken: string;
  intent: "restore";
  label: string;
  identity: CustomerIdentityFields;
}) {
  return `<form method="post" action="/api/activation/claim"><input type="hidden" name="activation" value="${escapeHtml(options.activationKey)}"><input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken)}"><input type="hidden" name="intent" value="${options.intent}">${customerIdentityHiddenInputs(options.identity)}<button type="submit">${escapeHtml(options.label)}</button></form>`;
}

function activationClaimPath(
  activationKey: string,
  identity: CustomerIdentityFields,
) {
  const params = new URLSearchParams({ activation: activationKey });
  for (const [key, value] of Object.entries(identity)) {
    if (value) params.set(key, value);
  }
  return `/api/activation/claim?${params.toString()}`;
}

function customerIdentityHiddenInputs(identity: CustomerIdentityFields) {
  return Object.entries(identity)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([name, value]) =>
      `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`
    )
    .join("");
}

function readCustomerIdentityFields(values: Record<string, unknown>) {
  const installIdHash = readOptionalIdentity(values.installIdHash, /^[0-9a-f]{64}$/);
  const supportCode = readOptionalIdentity(
    values.supportCode,
    /^SIDE-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/,
  );
  const installerReceiptIdHash = readOptionalIdentity(
    values.installerReceiptIdHash,
    /^[0-9a-f]{64}$/,
  );
  if ([installIdHash, supportCode, installerReceiptIdHash].includes(null)) return null;
  return {
    ...(installIdHash ? { installIdHash } : {}),
    ...(supportCode ? { supportCode } : {}),
    ...(installerReceiptIdHash ? { installerReceiptIdHash } : {}),
  };
}

function readOptionalIdentity(value: unknown, pattern: RegExp): string | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function decisionPage(options: {
  title: string;
  description: string;
  email: string;
  appVersion?: string;
  detail: string;
  action: string;
}) {
  const version = options.appVersion
    ? `<p class="muted">Sidestream ${escapeHtml(options.appVersion)}</p>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(options.title)}</title><style>body{margin:0;background:#0b0b0b;color:#e2e8f0;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;min-height:100vh;place-items:center}.card{box-sizing:border-box;max-width:560px;margin:24px;padding:32px;border:1px solid #333;border-radius:24px;background:#151515}h1{margin:0 0 16px;font-size:30px;line-height:1.05}p{line-height:1.55}.muted{color:#aab2bf}.confirm{display:flex;gap:10px;align-items:flex-start;margin-top:18px;color:#d8dee8;line-height:1.4}.confirm input{width:20px;height:20px;flex:0 0 auto}button{min-height:48px;margin-top:18px;border:0;border-radius:999px;background:#fff;color:#111;padding:13px 20px;font:inherit;font-weight:650;cursor:pointer}@media(max-width:520px){.card{padding:24px}button{width:100%}}</style></head><body><main class="card"><h1>${escapeHtml(options.title)}</h1><p>${escapeHtml(options.description)}</p>${version}<p class="muted">Signed in as ${escapeHtml(options.email)}</p><p class="muted">${escapeHtml(options.detail)}</p>${options.action}</main></body></html>`;
}

function formatActiveDevice(device: NonNullable<ActivationDecisionContext["activeDevice"]>) {
  const platform = device.platform === "macos"
    ? "Mac"
    : device.platform === "windows"
      ? "Windows"
      : "Previous";
  const activatedAt = new Date(device.activatedAt);
  const date = Number.isFinite(activatedAt.getTime())
    ? activatedAt.toISOString().slice(0, 10)
    : "an earlier date";
  return `${platform} device active since ${date}`;
}

function unavailablePage() {
  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"robots\" content=\"noindex,nofollow\"><title>Connection unavailable</title></head><body><h1>Connection link unavailable</h1><p>Return to Sidestream and start Upgrade or Restore Purchase again.</p></body></html>";
}

function environmentUnavailablePage() {
  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"robots\" content=\"noindex,nofollow\"><title>Connection unavailable</title></head><body><h1>Sidestream connection is temporarily unavailable</h1><p>No device was changed. Try again in a moment.</p></body></html>";
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] || character);
}

import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { PoolClient } from "pg";
import {
  authorizeAccountIntegrationDevice, cleanString, getAccountLicenseSummary, getBaseUrl,
  getClientIp, getSession, hashPrivateIdentifier, methodNotAllowed, redirect,
  resolveRequestLicenseEnvironment, sendJson, validateSameOriginJsonMutation,
  type AccountRequest, type AccountSession,
} from "./account.js";
import { getTrustedCheckoutCountry, getUpgradePlanPresentation } from "./checkout-offers.js";
import { bindDownloadCreditAccount, finalizeDownloadCredits, reserveDownloadCredits,
  synchronizeDownloadCredits } from "./download-credits.js";
import { isDownloadCreditServiceEnabled } from "./download-credit-pack.js";
import { DownloadReferralError, lockDownloadReferrals, referralPool } from "./download-referrals.js";
import type { ResolvedLicenseEnvironment } from "./license-environment.js";
import { applyRateLimitHeaders, consumeRateLimit, sendRateLimitExceeded } from "./rate-limit.js";
import { McpError, mcpAccessToken, mcpBearer, mcpCsrf, mcpHash, mcpKey, mcpRequestId,
  readMcpBody, validMcpCsrf } from "./mcp-security.js";

type Environment = ResolvedLicenseEnvironment;
type Connection = {
  id: string; connection_key: string; poll_token_hash: string; license_namespace: string;
  device_id_hash: string; client_name: string; platform: string; app_version: string | null;
  account_id: string | null; status: "pending" | "approved" | "denied" | "revoked";
  pairing_expires_at: Date; token_expires_at: Date | null; approved_at: Date | null;
  paid_device_id: string | null; paid_bound_at: Date | null; created_at: Date;
  upgrade_activation_key: string | null;
};
type Action = "start" | "token" | "authorize" | "account" | "reserve" | "finalize" | "revoke" | "connections" | "upgrade";
const social = new Set(["instagram", "tiktok", "twitter", "linkedin"]);
const platforms = new Set(["youtube", ...social, "other"]);

async function transaction<T>(environment: Environment, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await referralPool(environment).connect();
  try {
    await client.query("begin");
    await lockDownloadReferrals(client, environment);
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
}

function signInUrl(request: AccountRequest, next: string) {
  const target = new URL("/api/auth/google/start", getBaseUrl(request));
  target.searchParams.set("next", next);
  return target.toString();
}
function accountUrl(request: AccountRequest) { return `${getBaseUrl(request)}/account.html`; }

function upgradeErrorPage(response: ServerResponse, status: number, code: string, message: string, switchAccountUrl?: string) {
  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
  const title = code === "account_mismatch" ? "Use your connected account" : "Let's reconnect Sidestream";
  response.statusCode = status;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} | Sidestream</title><style>body{margin:0;background:#111;color:#f6f6f6;font:16px/1.6 system-ui,sans-serif;min-height:100vh;display:grid;place-items:center}main{max-width:480px;padding:40px 24px}small{font-weight:700;letter-spacing:.1em}h1{font-size:32px;line-height:1.2}p{color:#b9b9b9}a{display:inline-block;border-radius:8px;background:#fff;color:#111;font-weight:600;padding:12px 18px;text-decoration:none;margin:12px 10px 0 0}a.secondary{background:#262626;color:#fff}a:focus-visible{outline:3px solid #ff6655;outline-offset:4px}</style></head><body><main><small>SIDESTREAM</small><h1>${escape(title)}</h1><p>${escape(message)}</p>${code === "account_mismatch" ? "<p>Choose the Google account you connected to your assistant. Your existing Sidestream plan will stay unchanged.</p>" : "<p>Your existing plan and downloads are safe. Return to the connection page or try this link again shortly.</p>"}<a href="${escape(switchAccountUrl || "/account.html")}">${switchAccountUrl ? "Use another account" : "Open my account"}</a><a class="secondary" href="/mcp.html">Sidestream for AI</a></main></body></html>`);
}

async function browserSession(request: AccountRequest, next: string): Promise<AccountSession> {
  const session = await getSession(request);
  if (!session) throw new McpError("sign_in_required", 401, "Sign in to connect Sidestream.", false, {
    signInUrl: signInUrl(request, next),
  });
  return session;
}

async function connectionByKey(client: PoolClient, environment: Environment, key: string) {
  const row = (await client.query<Connection>(`select * from public.sidestream_mcp_connections
    where license_namespace=$1 and connection_key=$2 for update`, [environment.namespace, key])).rows[0];
  if (!row) throw new McpError("connection_expired", 410, "This connection link is no longer available. Start a new connection from your assistant.");
  return row;
}

async function authenticatedConnection(client: PoolClient, environment: Environment, token: string, settle = false) {
  const row = (await client.query<Connection>(`select * from public.sidestream_mcp_connections
    where license_namespace=$1 and token_hash=$2
      and ((status='approved' and token_expires_at>now()) or ($3 and status in ('approved','revoked'))) for update`,
  [environment.namespace, mcpHash(token), settle])).rows[0];
  if (!row?.account_id) throw new McpError("reconnect_required", 401, "Your Sidestream connection has expired or was disconnected. Reconnect to continue.");
  return row;
}

function requirePairing(row: Connection) {
  if (row.pairing_expires_at.getTime() <= Date.now() || row.status === "revoked") {
    throw new McpError("connection_expired", 410, "This connection link has expired. Start a new connection from your assistant.");
  }
}

async function enforcePaidDevice(client: PoolClient, environment: Environment, row: Connection, request: AccountRequest) {
  const decision = await authorizeAccountIntegrationDevice(client, {
    accountId: row.account_id!, namespace: environment.namespace, deviceIdHash: row.device_id_hash,
    approvedAt: row.approved_at || new Date(), boundAt: row.paid_bound_at,
    expectedDeviceId: row.paid_device_id, platform: row.platform, appVersion: row.app_version,
  });
  if (!decision.allowed) throw new McpError(decision.code, 403,
    decision.code === "transfer_required" ? "Your Sidestream device slots are in use. Manage your devices, then try this download again."
      : "This device was disconnected from Sidestream. Reconnect it before starting another download.", false,
    { accountUrl: accountUrl(request) });
  if (!row.paid_device_id) {
    const updated = await client.query<{ paid_bound_at: Date }>(`update public.sidestream_mcp_connections
      set paid_device_id=$2,paid_bound_at=now() where id=$1 returning paid_bound_at`, [row.id, decision.deviceId]);
    row.paid_device_id = decision.deviceId;
    row.paid_bound_at = updated.rows[0].paid_bound_at;
  }
}

async function accountState(client: PoolClient, environment: Environment, row: Connection, request: AccountRequest) {
  const license = await getAccountLicenseSummary(row.account_id!, client);
  const credits = await synchronizeDownloadCredits({ deviceId: "", trustedAccountId: row.account_id!,
    environment, transactionClient: client });
  return {
    connected: true, plan: license.purchasePlan, unlimitedDownloads: license.active,
    maxVideoHeight: license.maxVideoHeight, socialDownloads: license.socialDownloads,
    remainingDownloads: license.active ? null : Math.floor(credits.balance / credits.costs.video),
    reservedDownloads: Math.floor(credits.reserved / credits.costs.video),
    upgrade: {
      url: license.active ? accountUrl(request) : `${getBaseUrl(request)}/api/mcp/upgrade?connection=${encodeURIComponent(row.connection_key)}`,
      action: license.active ? "manage_plan" : "upgrade",
      ...(license.purchasePlan === "pro_monthly" ? { supportUrl: "mailto:alex@alexg.mov?subject=Switch%20Sidestream%20Pro%20to%20Unlimited" } : {}),
      plans: getUpgradePlanPresentation(getTrustedCheckoutCountry(request.headers)).plans,
    },
  };
}

export async function handleMcpRequest(action: Action, request: AccountRequest, response: ServerResponse) {
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  const method = (request.method || "GET").toUpperCase();
  const permitted = action === "authorize" || action === "connections" ? ["GET", "POST"]
    : action === "upgrade" ? ["GET"] : ["POST"];
  if (!permitted.includes(method)) return methodNotAllowed(response, permitted.join(", "));
  try {
    if (process.env.SIDESTREAM_MCP_ENABLED !== "1") {
      throw new McpError("mcp_unavailable", 503, "Sidestream MCP is not available on this server yet.", true);
    }
    if (!isDownloadCreditServiceEnabled()) throw new McpError("credits_unavailable", 503, "Download authorization is temporarily unavailable.", true);
    const environment = resolveRequestLicenseEnvironment(request);
    if (!environment) throw new McpError("mcp_unavailable", 503, "Sidestream connection is temporarily unavailable.", true);
    const body = method === "POST" ? await readMcpBody(request) : {};
    const limit = await consumeRateLimit({ scope: `mcp:${action}`, windowSeconds: 900,
      dimensions: [{ name: "ip", value: getClientIp(request) || "unknown-client", limit: action === "start" ? 30 : 1200 },
        ...(typeof request.headers.authorization === "string" ? [{ name: "credential", value: mcpHash(request.headers.authorization), limit: 600 }] : [])],
      runner: referralPool(environment) });
    if (!limit.allowed) return sendRateLimitExceeded(response, limit);
    applyRateLimitHeaders(response, limit);

    if (action === "start") {
      const deviceId = cleanString(body.deviceId, 240);
      if (!deviceId || typeof body.deviceId !== "string" || body.deviceId.length > 240 || /[\x00-\x1f]/.test(deviceId)) {
        throw new McpError("invalid_device", 400, "A valid local installation identity is required.");
      }
      const connectionId = randomBytes(32).toString("base64url"), pollToken = randomBytes(32).toString("base64url");
      // Validate deployment secrets before creating a pairing that cannot complete.
      mcpAccessToken(connectionId, mcpHash(pollToken));
      const clientName = cleanString(body.clientName, 80).replace(/[\x00-\x1f\x7f]/g, "") || "AI assistant";
      const platform = body.platform === "macos" || body.platform === "windows" ? body.platform : "unknown";
      const inserted = await referralPool(environment).query<{ pairing_expires_at: Date }>(`
        insert into public.sidestream_mcp_connections
          (connection_key,poll_token_hash,license_namespace,device_id_hash,client_name,platform,app_version)
        values ($1,$2,$3,$4,$5,$6,$7) returning pairing_expires_at`,
      [connectionId, mcpHash(pollToken), environment.namespace, hashPrivateIdentifier(deviceId), clientName, platform, cleanString(body.appVersion, 80) || null]);
      return sendJson(response, 200, { connectionId, pollToken,
        connectUrl: `${getBaseUrl(request)}/mcp.html?connection=${connectionId}`,
        expiresAt: inserted.rows[0].pairing_expires_at.toISOString(), interval: 3 });
    }

    if (action === "token") {
      const key = mcpKey(body.connectionId), pollToken = mcpKey(body.pollToken);
      const result = await transaction(environment, async (client) => {
        const row = await connectionByKey(client, environment, key);
        if (row.poll_token_hash !== mcpHash(pollToken)) throw new McpError("invalid_connection", 401);
        requirePairing(row);
        if (row.status === "denied") throw new McpError("connection_denied", 403, "The Sidestream connection was declined.");
        if (row.status === "pending") return { status: "pending", retryAfterSeconds: 3 };
        return { status: "connected", accessToken: mcpAccessToken(key, row.poll_token_hash),
          expiresAt: row.token_expires_at!.toISOString(), account: await accountState(client, environment, row, request) };
      });
      return sendJson(response, 200, result);
    }

    if (action === "authorize") {
      const key = mcpKey(method === "GET" ? new URL(request.url || "/", getBaseUrl(request)).searchParams.get("connection") : body.connectionId);
      const session = await browserSession(request, `/mcp.html?connection=${key}`);
      if (method === "POST" && (!validateSameOriginJsonMutation(request) || !validMcpCsrf(body.csrfToken, session.accountId, key))) {
        throw new McpError("invalid_confirmation", 403, "Refresh this page and confirm the connection again.");
      }
      const result = await transaction(environment, async (client) => {
        const row = await connectionByKey(client, environment, key);
        requirePairing(row);
        if (row.account_id && row.account_id !== session.accountId) throw new McpError("account_mismatch", 409, "This connection belongs to a different Sidestream account.");
        if (row.status === "denied") return { status: "denied", clientName: row.client_name };
        if (method === "GET") return {
          status: row.status === "approved" ? "connected" : "pending", clientName: row.client_name,
          csrfToken: mcpCsrf(session.accountId, key),
          account: row.account_id ? await accountState(client, environment, row, request)
            : { connected: false, plan: session.license.purchasePlan, maxVideoHeight: session.license.maxVideoHeight,
                socialDownloads: session.license.socialDownloads, email: session.email },
        };
        if (body.decision !== "approve" && body.decision !== "deny") throw new McpError("invalid_decision", 400);
        if (row.status === "approved") return { status: "connected", account: await accountState(client, environment, row, request) };
        if (body.decision === "deny") {
          await client.query("update public.sidestream_mcp_connections set status='denied',account_id=$2 where id=$1", [row.id, session.accountId]);
          return { status: "denied" };
        }
        await bindDownloadCreditAccount(client, { environment, accountId: session.accountId, deviceIdHash: row.device_id_hash });
        row.account_id = session.accountId; row.approved_at = new Date();
        const license = await getAccountLicenseSummary(session.accountId, client);
        if (license.active) await enforcePaidDevice(client, environment, row, request);
        await client.query(`update public.sidestream_mcp_connections set account_id=$2,status='approved',
          token_hash=$3,approved_at=$4,token_expires_at=now()+interval '180 days' where id=$1`,
        [row.id, session.accountId, mcpHash(mcpAccessToken(key, row.poll_token_hash)), row.approved_at]);
        return { status: "connected", account: await accountState(client, environment, row, request) };
      });
      return sendJson(response, 200, result);
    }

    if (action === "connections") {
      const session = await browserSession(request, "/mcp.html");
      if (method === "POST") {
        if (!validateSameOriginJsonMutation(request) || !validMcpCsrf(body.csrfToken, session.accountId, "connections")) {
          throw new McpError("invalid_confirmation", 403);
        }
        const key = mcpKey(body.connectionId);
        await referralPool(environment).query(`update public.sidestream_mcp_connections set status='revoked',revoked_at=coalesce(revoked_at,now())
          where license_namespace=$1 and account_id=$2 and connection_key=$3 and status='approved'`,
        [environment.namespace, session.accountId, key]);
        return sendJson(response, 200, { revoked: true });
      }
      const rows = await referralPool(environment).query<Connection>(`select * from public.sidestream_mcp_connections
        where license_namespace=$1 and account_id=$2 and status='approved' and token_expires_at>now()
        order by created_at desc limit 100`, [environment.namespace, session.accountId]);
      return sendJson(response, 200, { connections: rows.rows.map(row => ({ id: row.connection_key,
        clientName: row.client_name, createdAt: row.created_at.toISOString(), expiresAt: row.token_expires_at!.toISOString() })),
      csrfToken: mcpCsrf(session.accountId, "connections") });
    }

    if (action === "upgrade") {
      const key = mcpKey(new URL(request.url || "/", getBaseUrl(request)).searchParams.get("connection"));
      const next = `/api/mcp/upgrade?connection=${key}`;
      const session = await getSession(request);
      if (!session) return redirect(response, signInUrl(request, next), 303);
      const destination = await transaction(environment, async (client) => {
        const row = await connectionByKey(client, environment, key);
        if (row.account_id !== session.accountId) throw new McpError("account_mismatch", 409,
          "Sign in to the same Sidestream account you connected to your assistant before upgrading.", false,
          { accountUrl: accountUrl(request) });
        if (row.status !== "approved" || !row.token_expires_at || row.token_expires_at.getTime() <= Date.now()) {
          throw new McpError("reconnect_required", 401, "Reconnect Sidestream before upgrading through this link.");
        }
        const license = await getAccountLicenseSummary(session.accountId, client);
        if (license.active) return accountUrl(request);
        let activationKey = row.upgrade_activation_key;
        const reusable = activationKey && (await client.query(`select 1 from public.sidestream_activation_sessions
          where activation_key=$1 and account_id=$2 and device_id_hash=$3 and status='pending'
            and completed_at is null and expires_at>now()`, [activationKey, session.accountId, row.device_id_hash])).rowCount;
        if (!reusable) {
          activationKey = randomBytes(24).toString("base64url");
          await client.query(`insert into public.sidestream_activation_sessions
            (activation_key,account_id,device_id_hash,app_version,build_channel,source,status,expires_at,created_at,updated_at)
            values ($1,$2,$3,$4,'mcp','mcp','pending',now()+interval '24 hours',now(),now())`,
          [activationKey, session.accountId, row.device_id_hash, row.app_version]);
          await client.query("update public.sidestream_mcp_connections set upgrade_activation_key=$2 where id=$1", [row.id, activationKey]);
        }
        return `${getBaseUrl(request)}/upgrade.html?activation=${encodeURIComponent(activationKey!)}`;
      });
      return redirect(response, destination, 303);
    }

    const token = mcpBearer(request);
    const result = await transaction(environment, async (client) => {
      const row = await authenticatedConnection(client, environment, token, action === "finalize");
      const reconnectRequired = row.status === "revoked" || !row.token_expires_at || row.token_expires_at.getTime() <= Date.now();
      if (action === "revoke") {
        await client.query("update public.sidestream_mcp_connections set status='revoked',revoked_at=now() where id=$1", [row.id]);
        return { revoked: true };
      }
      if (action === "account") return accountState(client, environment, row, request);
      const requestId = mcpRequestId(body.requestId);
      // Serialize admission and settlement across all connections for this account.
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`sidestream:mcp-job:${environment.namespace}:${row.account_id}:${requestId}`]);
      const existing = (await client.query(`select j.*,c.device_id_hash as original_device_hash
        from public.sidestream_mcp_downloads j join public.sidestream_mcp_connections c on c.connection_key=j.connection_key
        where j.license_namespace=$1 and j.account_id=$2 and j.request_id=$3 for update of j`,
      [environment.namespace, row.account_id, requestId])).rows[0];
      const reservationKey = `credit-${requestId.replace(/-/g, "")}`;

      if (action === "finalize") {
        if (body.outcome !== "committed" && body.outcome !== "released") throw new McpError("invalid_outcome", 400);
        if (!existing || existing.original_device_hash !== row.device_id_hash ||
          (reconnectRequired && existing.connection_key !== row.connection_key)) {
          throw new McpError("reservation_not_found", 404, "This download reservation is unavailable.");
        }
        let status = existing.status;
        if (status === "reserved") {
          if (existing.credit_cost > 0) {
            const settled = await finalizeDownloadCredits({ deviceId: "", trustedAccountId: row.account_id!, transactionClient: client,
              environment, reservationKey, outcome: body.outcome });
            if (!settled.found) throw new McpError("reservation_not_found", 409);
            status = settled.status;
          } else status = new Date(existing.expires_at).getTime() <= Date.now() ? "expired" : body.outcome;
          await client.query(`update public.sidestream_mcp_downloads set status=$4,finalized_at=now()
            where license_namespace=$1 and account_id=$2 and request_id=$3`, [environment.namespace, row.account_id, requestId, status]);
        }
        return { requestId, status, ...(reconnectRequired ? { reconnectRequired: true }
          : { account: await accountState(client, environment, row, request) }) };
      }

      const fingerprint = body.requestFingerprint;
      if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint) ||
        (body.formatType !== "video" && body.formatType !== "audio")) throw new McpError("invalid_request", 400);
      if (typeof body.sourcePlatform !== "string" || !platforms.has(body.sourcePlatform)) throw new McpError("invalid_source_platform", 400);
      if (body.requestedHeight !== undefined && (typeof body.requestedHeight !== "number" || ![720, 1080, 2160].includes(body.requestedHeight))) throw new McpError("invalid_height", 400);
      const height = body.requestedHeight === undefined ? null : Number(body.requestedHeight);
      if (existing && (existing.request_fingerprint !== fingerprint || existing.format_type !== body.formatType ||
        existing.source_platform !== body.sourcePlatform || existing.requested_height !== height)) {
        throw new McpError("request_conflict", 409, "This request ID was already used for a different download.");
      }
      const state = await accountState(client, environment, row, request);
      const refusal = (code: string, message: string, retryable = false) => ({ allowed: false, requestId, code, message, retryable, account: state });
      if (existing && (existing.status !== "reserved" || new Date(existing.expires_at).getTime() <= Date.now())) {
        return refusal("reservation_finalized", "This download request has already finished. Start a new request to download it again.");
      }
      if (social.has(body.sourcePlatform) && !state.socialDownloads) return refusal("social_upgrade_required",
        state.plan === "pro_monthly"
          ? "Your Pro plan does not include social downloads. Open your Sidestream account or contact support to switch to Unlimited. Plan switching requires support; do not purchase a second plan."
          : "Social downloads require Sidestream Unlimited. Upgrade to continue.");
      if (body.formatType === "video" && height !== null && height > state.maxVideoHeight) return refusal("quality_upgrade_required", "Free downloads support up to 1080p. Choose 1080p or upgrade for 4K.");
      if (state.unlimitedDownloads) await enforcePaidDevice(client, environment, row, request);
      if (existing) return { allowed: true, requestId, policy: { maxVideoHeight: state.maxVideoHeight, socialDownloads: state.socialDownloads }, account: state };
      let cost = 0;
      if (!state.unlimitedDownloads) {
        const reservation = await reserveDownloadCredits({ deviceId: "", trustedAccountId: row.account_id!, transactionClient: client,
          environment, reservationKey, formatType: body.formatType });
        if (!reservation.allowed) {
          if (reservation.status !== "insufficient") return refusal("reservation_finalized", "This download request has already finished. Start a new request to download it again.");
          if (reservation.reserved > 0) return refusal("downloads_in_progress", "Your remaining free downloads are reserved by downloads in progress. Wait for them to finish, then try again.", true);
          return refusal("upgrade_required", "You've used all 10 free Sidestream downloads. Upgrade to Pro or Unlimited to keep downloading.");
        }
        cost = reservation.creditCost;
      }
      await client.query(`insert into public.sidestream_mcp_downloads
        (license_namespace,account_id,request_id,connection_key,request_fingerprint,format_type,source_platform,requested_height,credit_cost)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [environment.namespace, row.account_id, requestId, row.connection_key,
      fingerprint, body.formatType, body.sourcePlatform, height, cost]);
      return { allowed: true, requestId, policy: { maxVideoHeight: state.maxVideoHeight, socialDownloads: state.socialDownloads },
        account: await accountState(client, environment, row, request) };
    });
    return sendJson(response, 200, result);
  } catch (error) {
    if (action === "upgrade") {
      const expected = error instanceof McpError;
      if (!expected) console.error("sidestream_mcp_upgrade_unavailable");
      let switchAccountUrl: string | undefined;
      const connectionKey = new URL(request.url || "/", getBaseUrl(request)).searchParams.get("connection");
      if (expected && error.code === "account_mismatch" && connectionKey && /^[A-Za-z0-9_-]{43}$/.test(connectionKey)) {
        const signIn = new URL(signInUrl(request, `/api/mcp/upgrade?connection=${connectionKey}`));
        signIn.searchParams.set("prompt", "select_account");
        switchAccountUrl = signIn.toString();
      }
      return upgradeErrorPage(response, expected ? error.status : 503,
        expected ? error.code : "authorization_unavailable",
        expected ? error.message : "Sidestream is temporarily unavailable. Please try this upgrade link again shortly.", switchAccountUrl);
    }
    if (error instanceof McpError) return sendJson(response, error.status,
      { code: error.code, message: error.message, retryable: error.retryable, ...error.details });
    if (error instanceof DownloadReferralError) return sendJson(response, error.status,
      { code: error.code, message: error.code === "installation_already_linked"
        ? "This installation is already linked to another Sidestream account. Sign in with that account."
        : error.code === "downloads_in_progress" ? "Finish your current downloads, then connect again."
        : "Sidestream could not connect this download allowance. Contact support.", retryable: error.retryable });
    console.error("sidestream_mcp_request_unavailable", { action });
    return sendJson(response, 503, { code: "authorization_unavailable", message: "Sidestream is temporarily unavailable. Try again shortly.", retryable: true });
  }
}

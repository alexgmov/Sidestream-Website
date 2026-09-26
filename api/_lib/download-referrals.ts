import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { hashPrivateIdentifier } from "./account.js";
import { getPostgresPool } from "./postgres.js";
import type { ResolvedLicenseEnvironment } from "./license-environment.js";

type Environment = ResolvedLicenseEnvironment;
export type ReferralIdentity = { accountId: string; walletId: string; active: boolean; expiresAt: string | null };
export class DownloadReferralError extends Error {
  code: string;
  status: number;
  retryable: boolean;
  constructor(code: string, status = 409, retryable = false) {
    super(code); this.code = code; this.status = status; this.retryable = retryable;
  }
}
export function referralMode() {
  const mode = process.env.SIDESTREAM_DOWNLOAD_REFERRALS_MODE;
  return mode === "active" || mode === "paused" ? mode : "off";
}
export function referralToken(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : "";
}
export function referralHash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function token() { return randomBytes(32).toString("base64url"); }
function requireOpen() {
  if (referralMode() !== "active") throw new DownloadReferralError("referrals_paused", 503, true);
}
export function referralPool(environment: Environment) {
  return getPostgresPool({ ...environment.database, pooled: true });
}
// All referral/credit transactions take this lock before wallet locks. The initial
// controlled rollout uses a short namespace lock to serialize claim/bind/finalize
// races, including two inviters qualifying each other. No provider work runs here.
export async function lockDownloadReferrals(client: PoolClient, environment: Environment) {
  if (referralMode() !== "off") {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`sidestream:download-referrals:${environment.namespace}`]);
  }
}
export async function referralTransaction<T>(environment: Environment, run: (client: PoolClient) => Promise<T>) {
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

export async function readReferralIdentity(client: PoolClient, environment: Environment, deviceId: string, credential?: string): Promise<ReferralIdentity | null> {
  if (!credential) return null;
  if (referralMode() === "off" || !referralToken(credential)) throw new DownloadReferralError("referral_reconnect_required", 401);
  const result = await client.query(`
    select d.account_id, m.wallet_id, m.reward_expires_at,
      coalesce(m.reward_expires_at > now(), false) as active
    from public.sidestream_download_referral_devices d
    join public.sidestream_download_referral_members m using (license_namespace, account_id)
    where d.license_namespace = $1 and d.device_id_hash = $2 and d.token_hash = $3 and d.expires_at > now()
  `, [environment.namespace, hashPrivateIdentifier(deviceId), referralHash(credential)]);
  const row = result.rows[0];
  if (!row) throw new DownloadReferralError("referral_reconnect_required", 401);
  return { accountId: row.account_id, walletId: row.wallet_id, active: row.active, expiresAt: row.reward_expires_at?.toISOString() || null };
}

export async function startReferralConnection(environment: Environment, deviceId: string) {
  if (referralMode() === "off") throw new DownloadReferralError("referrals_disabled", 503);
  const credential = token();
  const browserKey = token();
  const result = await referralPool(environment).query(`
    insert into public.sidestream_download_referral_connections
      (token_hash, browser_key_hash, license_namespace, device_id_hash)
    values ($1, $2, $3, $4) returning expires_at
  `, [referralHash(credential), referralHash(browserKey), environment.namespace, hashPrivateIdentifier(deviceId)]);
  return { connectionToken: credential, browserKey, expiresAt: result.rows[0].expires_at.toISOString() };
}

export async function completeReferralConnection(environment: Environment, browserKey: string, accountId: string) {
  if (referralMode() === "off") throw new DownloadReferralError("referrals_disabled", 503);
  return referralTransaction(environment, async (client) => {
    const connection = (await client.query(`select * from public.sidestream_download_referral_connections
      where browser_key_hash = $1 and license_namespace = $2 and expires_at > now() for update`,
    [referralHash(browserKey), environment.namespace])).rows[0];
    if (!connection) throw new DownloadReferralError("connection_expired", 410);
    if (connection.account_id && connection.account_id !== accountId) throw new DownloadReferralError("connection_already_used");
    const device = (await client.query(`select account_id from public.sidestream_download_referral_devices
      where license_namespace = $1 and device_id_hash = $2`, [environment.namespace, connection.device_id_hash])).rows[0];
    if (device && device.account_id !== accountId) throw new DownloadReferralError("installation_already_linked");
    const member = (await client.query(`select wallet_id from public.sidestream_download_referral_members
      where license_namespace = $1 and account_id = $2`, [environment.namespace, accountId])).rows[0];
    const wallet = (await client.query(`select * from public.sidestream_credit_wallets
      where license_namespace = $1 and device_id_hash = $2 for update`, [environment.namespace, connection.device_id_hash])).rows[0];
    // The ordinary credits sync owns starter creation. Never manufacture a wallet.
    if (!wallet) throw new DownloadReferralError("wallet_sync_required", 409, true);
    if (wallet.account_id && wallet.account_id !== accountId) throw new DownloadReferralError("installation_already_linked");
    if (!member) {
      requireOpen();
      const claim = (await client.query(`select c.*, v.created_at as visited_at from public.sidestream_download_referral_claims c
        join public.sidestream_download_referral_visits v on v.token_hash = c.visit_token_hash
        where c.license_namespace = $1 and c.recipient_account_id = $2`, [environment.namespace, accountId])).rows[0];
      if (claim && (Number(wallet.spent_credits) > 0 || wallet.created_at < claim.visited_at ||
        (await client.query(`select 1 from public.sidestream_credit_reservations where wallet_id = $1 and status = 'committed' limit 1`, [wallet.id])).rowCount)) {
        throw new DownloadReferralError("recipient_not_new");
      }
      // Existing license-device history is a stronger identity edge than an
      // unbound wallet. Do not allow another verified account to recycle it.
      const existingDevice = await client.query(`select 1 from public.sidestream_account_devices
        where license_namespace = $1 and device_id_hash = $2 and account_id <> $3 limit 1`,
      [environment.namespace, connection.device_id_hash, accountId]);
      if (existingDevice.rowCount) throw new DownloadReferralError("installation_already_linked");
      await client.query(`insert into public.sidestream_download_referral_members
        (license_namespace, account_id, wallet_id, invite_code) values ($1, $2, $3, $4)`,
      [environment.namespace, accountId, wallet.id, randomBytes(24).toString("base64url")]);
      await client.query(`update public.sidestream_credit_wallets set account_id = $2, account_bound_at = now()
        where id = $1 and account_id is null`, [wallet.id, accountId]);
    }
    await client.query(`insert into public.sidestream_download_referral_devices
      (license_namespace, device_id_hash, account_id, token_hash) values ($1, $2, $3, $4)
      on conflict (license_namespace, device_id_hash) do update
        set token_hash = excluded.token_hash, expires_at = now() + interval '180 days'`,
    [environment.namespace, connection.device_id_hash, accountId, connection.token_hash]);
    await client.query(`update public.sidestream_download_referral_connections set account_id = $2 where token_hash = $1`,
    [connection.token_hash, accountId]);
    return { state: "connected" };
  });
}

export async function getReferralStatus(environment: Environment, deviceId: string, credential?: string) {
  if (referralMode() === "off") return { enabled: false, state: "disabled", reward: { active: false, expiresAt: null } };
  return referralTransaction(environment, async (client) => {
    if (!credential) return { enabled: true, acceptingInvitations: referralMode() === "active", state: "connection_required", reward: { active: false, expiresAt: null } };
    let identity: ReferralIdentity | null;
    try { identity = await readReferralIdentity(client, environment, deviceId, credential); }
    catch (error) {
      if (!(error instanceof DownloadReferralError)) throw error;
      const pending = (await client.query(`select 1 from public.sidestream_download_referral_connections
        where token_hash = $1 and license_namespace = $2 and device_id_hash = $3 and account_id is null and expires_at > now()`,
      [referralHash(credential), environment.namespace, hashPrivateIdentifier(deviceId)])).rowCount;
      if (pending) return { enabled: true, state: "awaiting_connection", retryAfterSeconds: 3, reward: { active: false, expiresAt: null } };
      throw error;
    }
    const member = (await client.query(`select invite_code from public.sidestream_download_referral_members
      where license_namespace = $1 and account_id = $2`, [environment.namespace, identity!.accountId])).rows[0];
    const claim = (await client.query(`select qualified_at from public.sidestream_download_referral_claims
      where license_namespace = $1 and recipient_account_id = $2`, [environment.namespace, identity!.accountId])).rows[0];
    return {
      enabled: true, state: "connected", acceptingInvitations: referralMode() === "active",
      inviteCode: member.invite_code,
      qualification: claim ? (claim.qualified_at ? "qualified" : "awaiting_first_download") : "not_claimed",
      qualifiedAt: claim?.qualified_at?.toISOString() || null,
      reward: { active: identity!.active, expiresAt: identity!.expiresAt },
    };
  });
}

export async function startReferralVisit(environment: Environment, inviteCode: string, previousVisit = "") {
  requireOpen();
  if (!/^[A-Za-z0-9_-]{32}$/.test(inviteCode)) throw new DownloadReferralError("invitation_invalid", 404);
  if (referralToken(previousVisit)) {
    const existing = await referralPool(environment).query(`select 1 from public.sidestream_download_referral_visits v
      join public.sidestream_download_referral_members m on m.license_namespace = v.license_namespace and m.account_id = v.inviter_account_id
      where v.token_hash = $1 and v.license_namespace = $2 and m.invite_code = $3 and v.expires_at > now()`,
    [referralHash(previousVisit), environment.namespace, inviteCode]);
    if (existing.rowCount) return previousVisit;
  }
  const visit = token();
  const inserted = await referralPool(environment).query(`insert into public.sidestream_download_referral_visits
    (token_hash, license_namespace, inviter_account_id)
    select $1, license_namespace, account_id from public.sidestream_download_referral_members
    where license_namespace = $2 and invite_code = $3 returning token_hash`, [referralHash(visit), environment.namespace, inviteCode]);
  if (!inserted.rowCount) throw new DownloadReferralError("invitation_invalid", 404);
  return visit;
}

export async function claimDownloadReferral(environment: Environment, visitToken: string, accountId: string) {
  requireOpen();
  return referralTransaction(environment, async (client) => {
    const visit = (await client.query(`select * from public.sidestream_download_referral_visits
      where token_hash = $1 and license_namespace = $2 and expires_at > now()`, [referralHash(visitToken), environment.namespace])).rows[0];
    if (!visit) throw new DownloadReferralError("invitation_expired", 410);
    if (visit.inviter_account_id === accountId) throw new DownloadReferralError("self_referral");
    const existing = (await client.query(`select * from public.sidestream_download_referral_claims
      where license_namespace = $1 and (recipient_account_id = $2 or visit_token_hash = $3)`,
    [environment.namespace, accountId, visit.token_hash])).rows[0];
    if (existing) {
      if (existing.qualified_at) throw new DownloadReferralError("already_qualified");
      throw new DownloadReferralError("claim_already_used");
    }
    const account = (await client.query(`select created_at, google_sub from public.sidestream_accounts where id = $1`, [accountId])).rows[0];
    if (!account?.google_sub || account.created_at < visit.created_at) throw new DownloadReferralError("recipient_not_new");
    if ((await client.query(`select 1 from public.sidestream_download_referral_members
      where license_namespace = $1 and account_id = $2`, [environment.namespace, accountId])).rowCount) throw new DownloadReferralError("recipient_not_new");
    await client.query(`insert into public.sidestream_download_referral_claims
      (license_namespace, recipient_account_id, inviter_account_id, visit_token_hash) values ($1, $2, $3, $4)`,
    [environment.namespace, accountId, visit.inviter_account_id, visit.token_hash]);
    return { state: "awaiting_first_download", replayed: false };
  });
}

// Called only inside the canonical reservation commit transaction, after it has
// transitioned from reserved to committed. Failure rolls back both the download
// finalization and both grants; the client retries the same durable reservation.
export async function qualifyDownloadReferral(client: PoolClient, environment: Environment, identity: ReferralIdentity | null, reservationKey: string) {
  if (!identity || referralMode() === "off") return;
  const claim = (await client.query(`select * from public.sidestream_download_referral_claims
    where license_namespace = $1 and recipient_account_id = $2 and qualified_at is null for update`,
  [environment.namespace, identity.accountId])).rows[0];
  if (!claim) return;
  for (const [role, accountId] of [["inviter", claim.inviter_account_id], ["recipient", identity.accountId]]) {
    const reward = (await client.query(`update public.sidestream_download_referral_members
      set reward_expires_at = greatest(now(), coalesce(reward_expires_at, now())) + interval '720 hours'
      where license_namespace = $1 and account_id = $2
      returning reward_expires_at - interval '720 hours' as starts_at, reward_expires_at`,
    [environment.namespace, accountId])).rows[0];
    if (!reward) throw new Error("Referral recipient is not connected");
    await client.query(`insert into public.sidestream_download_referral_grants
      (claim_id, license_namespace, account_id, role, starts_at, expires_at) values ($1, $2, $3, $4, $5, $6)`,
    [claim.id, environment.namespace, accountId, role, reward.starts_at, reward.reward_expires_at]);
  }
  await client.query(`update public.sidestream_download_referral_claims
    set qualified_at = now(), qualification_reservation_key = $2 where id = $1`, [claim.id, reservationKey]);
}

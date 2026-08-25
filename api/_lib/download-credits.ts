import type { PoolClient } from "pg";
import {
  getStripe,
  getStripeRequestOptions,
  hashPrivateIdentifier,
} from "./account.js";
import type { ResolvedLicenseEnvironment } from "./license-environment.js";
import { getPostgresPool } from "./postgres.js";
import {
  getConfiguredDownloadCreditPack,
  serializeDownloadCreditPack,
} from "./download-credit-pack.js";

export const STARTER_DOWNLOAD_CREDITS = 1_000;
export const DOWNLOAD_CREDIT_COSTS = Object.freeze({
  video: 100,
  audio: 100,
});
export const CREDIT_RESERVATION_TTL_DAYS = 7;

export type DownloadCreditFormat = keyof typeof DOWNLOAD_CREDIT_COSTS;
export type DownloadCreditOutcome = "committed" | "released";

type CreditWalletRow = {
  id: string;
  available_credits: number;
  granted_credits: number;
  spent_credits: number;
};

type CreditReservationRow = {
  id: string;
  reservation_key: string;
  format_type: DownloadCreditFormat;
  credit_cost: number;
  status: "reserved" | "committed" | "released" | "expired";
  expires_at: Date | string;
};

export type DownloadCreditSnapshot = Readonly<{
  balance: number;
  reserved: number;
  granted: number;
  spent: number;
  starterGrant: number;
  costs: typeof DOWNLOAD_CREDIT_COSTS;
}>;

export type DownloadCreditReservationResult = DownloadCreditSnapshot & Readonly<{
  allowed: boolean;
  reservationKey: string;
  status: "reserved" | "committed" | "released" | "expired" | "insufficient";
  creditCost: number;
}>;

export type DownloadCreditFinalizationResult = DownloadCreditSnapshot & Readonly<{
  found: boolean;
  reservationKey: string;
  status: "committed" | "released" | "expired" | "not_found";
  creditCost: number;
}>;

export function normalizeDownloadCreditFormat(value: unknown): DownloadCreditFormat | null {
  return value === "video" || value === "audio" ? value : null;
}

export function normalizeCreditReservationKey(value: unknown) {
  if (typeof value !== "string") return "";
  return /^credit-[0-9a-f]{32,64}$/.test(value) ? value : "";
}

export function getDownloadCreditCost(formatType: DownloadCreditFormat) {
  return DOWNLOAD_CREDIT_COSTS[formatType];
}

export async function createDownloadCreditPackCheckout(options: {
  deviceId: string;
  environment: ResolvedLicenseEnvironment;
  packKey: string;
  purchaseRequestKey: string;
  successUrl: string;
  cancelUrl: string;
}) {
  const pack = getConfiguredDownloadCreditPack();
  if (!pack || options.packKey !== pack.key) {
    throw new Error("Download credit purchases are not configured");
  }
  if (!/^credit-purchase-[0-9a-f]{32,64}$/.test(options.purchaseRequestKey)) {
    throw new TypeError("Credit purchase request key is invalid");
  }
  const price = await getStripe().prices.retrieve(
    pack.priceId,
    {},
    getStripeRequestOptions(),
  );
  if (
    price.id !== pack.priceId ||
    price.active !== true ||
    price.recurring ||
    price.livemode !== (options.environment.namespace === "production") ||
    price.currency !== pack.currency ||
    price.unit_amount !== pack.unitAmountMinor
  ) {
    throw new Error("Configured download credit Price is invalid");
  }
  const wallet = await withCreditTransaction(options.environment, async (client) =>
    lockOrCreateWallet(
      client,
      options.environment.namespace,
      options.deviceId,
    )
  );
  const metadata = {
    sidestream_purchase_kind: "download_credit_pack",
    sidestream_credit_wallet_id: wallet.id,
    sidestream_credit_pack_key: pack.key,
    sidestream_credit_amount: String(pack.credits),
    sidestream_license_namespace: options.environment.namespace,
  };
  const checkout = await getStripe().checkout.sessions.create(
    {
      mode: "payment",
      line_items: [{ price: price.id, quantity: 1 }],
      customer_creation: "always",
      success_url: options.successUrl,
      cancel_url: options.cancelUrl,
      client_reference_id: wallet.id,
      metadata,
      payment_intent_data: { metadata },
    },
    {
      ...getStripeRequestOptions(),
      idempotencyKey: [
        "sidestream",
        "credit-pack",
        wallet.id,
        options.purchaseRequestKey,
      ].join(":"),
    },
  );
  if (!checkout.url) throw new Error("Stripe did not return a credit Checkout URL");
  return {
    checkoutUrl: checkout.url,
    pack: serializeDownloadCreditPack(pack),
  };
}

export async function fulfillDownloadCreditPackCheckout(
  sessionPayload: unknown,
  environment: ResolvedLicenseEnvironment,
) {
  const candidate = sessionPayload as {
    id?: unknown;
    metadata?: Record<string, unknown> | null;
  } | null;
  if (candidate?.metadata?.sidestream_purchase_kind !== "download_credit_pack") {
    return { recognized: false as const, fulfilled: false as const, reason: "not_credit_pack" };
  }
  const sessionId = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const pack = getConfiguredDownloadCreditPack();
  if (!pack || !sessionId) {
    return { recognized: true as const, fulfilled: false as const, reason: "pack_unavailable" };
  }
  const session = await getStripe().checkout.sessions.retrieve(
    sessionId,
    { expand: ["line_items.data.price"] },
    getStripeRequestOptions(),
  );
  const walletId = String(session.metadata?.sidestream_credit_wallet_id || "");
  const lineItems = session.line_items?.data || [];
  const lineItem = lineItems[0];
  const priceId = typeof lineItem?.price === "string"
    ? lineItem.price
    : lineItem?.price?.id || "";
  if (
    session.id !== sessionId ||
    session.mode !== "payment" ||
    session.status !== "complete" ||
    session.payment_status !== "paid" ||
    session.livemode !== (environment.namespace === "production") ||
    session.metadata?.sidestream_credit_pack_key !== pack.key ||
    session.metadata?.sidestream_credit_amount !== String(pack.credits) ||
    session.metadata?.sidestream_license_namespace !== environment.namespace ||
    session.client_reference_id !== walletId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(walletId) ||
    lineItems.length !== 1 ||
    lineItem?.quantity !== 1 ||
    priceId !== pack.priceId ||
    !Number.isSafeInteger(session.amount_total) ||
    (session.amount_total || 0) <= 0
  ) {
    return { recognized: true as const, fulfilled: false as const, reason: "purchase_invalid" };
  }
  await grantPurchasedDownloadCreditsForWallet({
    walletId,
    environment,
    credits: pack.credits,
    stripeCheckoutSessionId: session.id,
  });
  return { recognized: true as const, fulfilled: true as const, reason: "purchase_granted" };
}

export async function synchronizeDownloadCredits(options: {
  deviceId: string;
  environment: ResolvedLicenseEnvironment;
  legacyUsedCredits?: number;
}) {
  const legacyUsedCredits = normalizeLegacyUsedCredits(options.legacyUsedCredits);
  return withCreditTransaction(options.environment, async (client) => {
    const wallet = await lockOrCreateWallet(
      client,
      options.environment.namespace,
      options.deviceId,
      legacyUsedCredits,
    );
    await releaseExpiredReservations(client, wallet);
    return getWalletSnapshot(client, wallet.id);
  });
}

export async function reserveDownloadCredits(options: {
  deviceId: string;
  environment: ResolvedLicenseEnvironment;
  reservationKey: string;
  formatType: DownloadCreditFormat;
}): Promise<DownloadCreditReservationResult> {
  const reservationKey = normalizeCreditReservationKey(options.reservationKey);
  if (!reservationKey) throw new TypeError("Credit reservation key is invalid");
  const creditCost = getDownloadCreditCost(options.formatType);

  return withCreditTransaction(options.environment, async (client) => {
    const wallet = await lockOrCreateWallet(
      client,
      options.environment.namespace,
      options.deviceId,
    );
    await releaseExpiredReservations(client, wallet);

    const existingResult = await client.query<CreditReservationRow>(
      `
        select id, reservation_key, format_type, credit_cost, status, expires_at
        from public.sidestream_credit_reservations
        where wallet_id = $1 and reservation_key = $2
        limit 1
        for update
      `,
      [wallet.id, reservationKey],
    );
    const existing = existingResult.rows[0];
    if (existing) {
      const snapshot = await getWalletSnapshot(client, wallet.id);
      return {
        ...snapshot,
        allowed: existing.status === "reserved",
        reservationKey,
        status: existing.status,
        creditCost: existing.credit_cost,
      };
    }

    const latestWallet = await getLockedWallet(client, wallet.id);
    if (latestWallet.available_credits < creditCost) {
      return {
        ...(await getWalletSnapshot(client, wallet.id)),
        allowed: false,
        reservationKey,
        status: "insufficient",
        creditCost,
      };
    }

    const updatedWalletResult = await client.query<CreditWalletRow>(
      `
        update public.sidestream_credit_wallets
        set available_credits = available_credits - $2,
            updated_at = now()
        where id = $1 and available_credits >= $2
        returning id, available_credits, granted_credits, spent_credits
      `,
      [wallet.id, creditCost],
    );
    const updatedWallet = updatedWalletResult.rows[0];
    if (!updatedWallet) throw new Error("Credit wallet changed before reservation");

    const reservationResult = await client.query<{ id: string }>(
      `
        insert into public.sidestream_credit_reservations (
          wallet_id,
          reservation_key,
          format_type,
          credit_cost,
          status,
          reserved_at,
          expires_at,
          created_at,
          updated_at
        ) values (
          $1, $2, $3, $4, 'reserved', now(),
          now() + ($5::integer * interval '1 day'), now(), now()
        )
        returning id
      `,
      [wallet.id, reservationKey, options.formatType, creditCost, CREDIT_RESERVATION_TTL_DAYS],
    );
    const reservationId = reservationResult.rows[0]?.id;
    if (!reservationId) throw new Error("Credit reservation was not created");

    await client.query(
      `
        insert into public.sidestream_credit_ledger (
          wallet_id,
          reservation_id,
          entry_type,
          credit_delta,
          available_balance_after,
          idempotency_key,
          created_at
        ) values ($1, $2, 'download_reserved', $3, $4, $5, now())
      `,
      [
        wallet.id,
        reservationId,
        -creditCost,
        updatedWallet.available_credits,
        `reserve:${reservationKey}`,
      ],
    );

    return {
      ...(await getWalletSnapshot(client, wallet.id)),
      allowed: true,
      reservationKey,
      status: "reserved",
      creditCost,
    };
  });
}

export async function finalizeDownloadCredits(options: {
  deviceId: string;
  environment: ResolvedLicenseEnvironment;
  reservationKey: string;
  outcome: DownloadCreditOutcome;
}): Promise<DownloadCreditFinalizationResult> {
  const reservationKey = normalizeCreditReservationKey(options.reservationKey);
  if (!reservationKey) throw new TypeError("Credit reservation key is invalid");

  return withCreditTransaction(options.environment, async (client) => {
    const wallet = await lockExistingWallet(
      client,
      options.environment.namespace,
      options.deviceId,
    );
    if (!wallet) {
      return emptyFinalizationResult(reservationKey);
    }
    await releaseExpiredReservations(client, wallet);

    const reservationResult = await client.query<CreditReservationRow>(
      `
        select id, reservation_key, format_type, credit_cost, status, expires_at
        from public.sidestream_credit_reservations
        where wallet_id = $1 and reservation_key = $2
        limit 1
        for update
      `,
      [wallet.id, reservationKey],
    );
    const reservation = reservationResult.rows[0];
    if (!reservation) {
      return {
        ...(await getWalletSnapshot(client, wallet.id)),
        found: false,
        reservationKey,
        status: "not_found",
        creditCost: 0,
      };
    }

    if (reservation.status !== "reserved") {
      return {
        ...(await getWalletSnapshot(client, wallet.id)),
        found: true,
        reservationKey,
        status: reservation.status,
        creditCost: reservation.credit_cost,
      };
    }

    if (options.outcome === "committed") {
      const updatedWallet = await client.query<CreditWalletRow>(
        `
          update public.sidestream_credit_wallets
          set spent_credits = spent_credits + $2,
              updated_at = now()
          where id = $1
          returning id, available_credits, granted_credits, spent_credits
        `,
        [wallet.id, reservation.credit_cost],
      );
      await client.query(
        `
          update public.sidestream_credit_reservations
          set status = 'committed', finalized_at = now(), updated_at = now()
          where id = $1 and status = 'reserved'
        `,
        [reservation.id],
      );
      await client.query(
        `
          insert into public.sidestream_credit_ledger (
            wallet_id, reservation_id, entry_type, credit_delta,
            available_balance_after, idempotency_key, created_at
          ) values ($1, $2, 'download_committed', 0, $3, $4, now())
        `,
        [
          wallet.id,
          reservation.id,
          updatedWallet.rows[0].available_credits,
          `commit:${reservationKey}`,
        ],
      );
    } else {
      const updatedWallet = await client.query<CreditWalletRow>(
        `
          update public.sidestream_credit_wallets
          set available_credits = available_credits + $2,
              updated_at = now()
          where id = $1
          returning id, available_credits, granted_credits, spent_credits
        `,
        [wallet.id, reservation.credit_cost],
      );
      await client.query(
        `
          update public.sidestream_credit_reservations
          set status = 'released', finalized_at = now(), updated_at = now()
          where id = $1 and status = 'reserved'
        `,
        [reservation.id],
      );
      await client.query(
        `
          insert into public.sidestream_credit_ledger (
            wallet_id, reservation_id, entry_type, credit_delta,
            available_balance_after, idempotency_key, created_at
          ) values ($1, $2, 'download_released', $3, $4, $5, now())
        `,
        [
          wallet.id,
          reservation.id,
          reservation.credit_cost,
          updatedWallet.rows[0].available_credits,
          `release:${reservationKey}`,
        ],
      );
    }

    return {
      ...(await getWalletSnapshot(client, wallet.id)),
      found: true,
      reservationKey,
      status: options.outcome,
      creditCost: reservation.credit_cost,
    };
  });
}

export async function grantPurchasedDownloadCredits(options: {
  deviceId: string;
  environment: ResolvedLicenseEnvironment;
  credits: number;
  stripeCheckoutSessionId: string;
}) {
  if (!Number.isSafeInteger(options.credits) || options.credits < 1 || options.credits > 1_000_000) {
    throw new TypeError("Purchased credit grant is invalid");
  }
  if (!/^cs_(?:test_|live_)?[A-Za-z0-9]{8,200}$/.test(options.stripeCheckoutSessionId)) {
    throw new TypeError("Stripe Checkout Session is invalid");
  }

  return withCreditTransaction(options.environment, async (client) => {
    const wallet = await lockOrCreateWallet(
      client,
      options.environment.namespace,
      options.deviceId,
    );
    await grantPurchasedCreditsToWallet(client, wallet, options);
    return getWalletSnapshot(client, wallet.id);
  });
}

export async function grantPurchasedDownloadCreditsForWallet(options: {
  walletId: string;
  environment: ResolvedLicenseEnvironment;
  credits: number;
  stripeCheckoutSessionId: string;
}) {
  validatePurchasedCreditGrant(options);
  return withCreditTransaction(options.environment, async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `sidestream:credit-wallet:${options.environment.namespace}:${options.walletId}`,
    ]);
    const walletResult = await client.query<CreditWalletRow>(
      `
        select id, available_credits, granted_credits, spent_credits
        from public.sidestream_credit_wallets
        where id = $1 and license_namespace = $2
        limit 1
        for update
      `,
      [options.walletId, options.environment.namespace],
    );
    const wallet = walletResult.rows[0];
    if (!wallet) throw new Error("Credit wallet is unavailable for purchase fulfillment");
    await grantPurchasedCreditsToWallet(client, wallet, options);
    return getWalletSnapshot(client, wallet.id);
  });
}

function validatePurchasedCreditGrant(options: {
  credits: number;
  stripeCheckoutSessionId: string;
}) {
  if (!Number.isSafeInteger(options.credits) || options.credits < 1 || options.credits > 1_000_000) {
    throw new TypeError("Purchased credit grant is invalid");
  }
  if (!/^cs_(?:test_|live_)?[A-Za-z0-9]{8,200}$/.test(options.stripeCheckoutSessionId)) {
    throw new TypeError("Stripe Checkout Session is invalid");
  }
}

async function grantPurchasedCreditsToWallet(
  client: PoolClient,
  wallet: CreditWalletRow,
  options: { credits: number; stripeCheckoutSessionId: string },
) {
  validatePurchasedCreditGrant(options);
  const existing = await client.query(
    `
      select 1 from public.sidestream_credit_ledger
      where stripe_checkout_session_id = $1
      limit 1
    `,
    [options.stripeCheckoutSessionId],
  );
  if (existing.rowCount === 0) {
    const updated = await client.query<CreditWalletRow>(
      `
        update public.sidestream_credit_wallets
        set available_credits = available_credits + $2,
            granted_credits = granted_credits + $2,
            updated_at = now()
        where id = $1
        returning id, available_credits, granted_credits, spent_credits
      `,
      [wallet.id, options.credits],
    );
    await client.query(
      `
        insert into public.sidestream_credit_ledger (
          wallet_id, entry_type, credit_delta, available_balance_after,
          stripe_checkout_session_id, idempotency_key, created_at
        ) values ($1, 'purchase_grant', $2, $3, $4, $5, now())
      `,
      [
        wallet.id,
        options.credits,
        updated.rows[0].available_credits,
        options.stripeCheckoutSessionId,
        `purchase:${options.stripeCheckoutSessionId}`,
      ],
    );
  }
  return wallet;
}

async function withCreditTransaction<T>(
  environment: ResolvedLicenseEnvironment,
  callback: (client: PoolClient) => Promise<T>,
) {
  const pool = getPostgresPool({
    connectionString: environment.database.connectionString,
    environmentVariable: environment.database.environmentVariable,
    pooled: true,
  });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Preserve the original credit transaction failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function lockOrCreateWallet(
  client: PoolClient,
  namespace: string,
  deviceId: string,
  initialUsedCredits = 0,
) {
  const deviceIdHash = hashPrivateIdentifier(deviceId);
  await lockWalletIdentity(client, namespace, deviceIdHash);
  let wallet = await selectWallet(client, namespace, deviceIdHash);
  if (wallet) return wallet;

  const inserted = await client.query<CreditWalletRow>(
    `
      insert into public.sidestream_credit_wallets (
        license_namespace, device_id_hash, available_credits,
        granted_credits, spent_credits, created_at, updated_at
      ) values ($1, $2, $3 - $4, $3, $4, now(), now())
      returning id, available_credits, granted_credits, spent_credits
    `,
    [namespace, deviceIdHash, STARTER_DOWNLOAD_CREDITS, initialUsedCredits],
  );
  wallet = inserted.rows[0];
  await client.query(
    `
      insert into public.sidestream_credit_ledger (
        wallet_id, entry_type, credit_delta, available_balance_after,
        idempotency_key, created_at
      ) values ($1, 'starter_grant', $2, $2, $3, now())
    `,
    [wallet.id, STARTER_DOWNLOAD_CREDITS, `starter:${wallet.id}`],
  );
  if (initialUsedCredits > 0) {
    await client.query(
      `
        insert into public.sidestream_credit_ledger (
          wallet_id, entry_type, credit_delta, available_balance_after,
          idempotency_key, created_at
        ) values ($1, 'legacy_usage_import', $2, $3, $4, now())
      `,
      [
        wallet.id,
        -initialUsedCredits,
        wallet.available_credits,
        `legacy:${wallet.id}`,
      ],
    );
  }
  return wallet;
}

function normalizeLegacyUsedCredits(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return 0;
  return Math.max(0, Math.min(STARTER_DOWNLOAD_CREDITS, parsed));
}

async function lockExistingWallet(
  client: PoolClient,
  namespace: string,
  deviceId: string,
) {
  const deviceIdHash = hashPrivateIdentifier(deviceId);
  await lockWalletIdentity(client, namespace, deviceIdHash);
  return selectWallet(client, namespace, deviceIdHash);
}

async function lockWalletIdentity(client: PoolClient, namespace: string, deviceIdHash: string) {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `sidestream:credits:${namespace}:${deviceIdHash}`,
  ]);
}

async function selectWallet(client: PoolClient, namespace: string, deviceIdHash: string) {
  const result = await client.query<CreditWalletRow>(
    `
      select id, available_credits, granted_credits, spent_credits
      from public.sidestream_credit_wallets
      where license_namespace = $1 and device_id_hash = $2
      limit 1
      for update
    `,
    [namespace, deviceIdHash],
  );
  return result.rows[0] || null;
}

async function getLockedWallet(client: PoolClient, walletId: string) {
  const result = await client.query<CreditWalletRow>(
    `
      select id, available_credits, granted_credits, spent_credits
      from public.sidestream_credit_wallets
      where id = $1
      for update
    `,
    [walletId],
  );
  const wallet = result.rows[0];
  if (!wallet) throw new Error("Credit wallet disappeared during transaction");
  return wallet;
}

async function releaseExpiredReservations(client: PoolClient, wallet: CreditWalletRow) {
  const expiredResult = await client.query<CreditReservationRow>(
    `
      select id, reservation_key, format_type, credit_cost, status, expires_at
      from public.sidestream_credit_reservations
      where wallet_id = $1 and status = 'reserved' and expires_at <= now()
      order by expires_at, id
      for update
    `,
    [wallet.id],
  );

  for (const reservation of expiredResult.rows) {
    const updatedWallet = await client.query<CreditWalletRow>(
      `
        update public.sidestream_credit_wallets
        set available_credits = available_credits + $2,
            updated_at = now()
        where id = $1
        returning id, available_credits, granted_credits, spent_credits
      `,
      [wallet.id, reservation.credit_cost],
    );
    await client.query(
      `
        update public.sidestream_credit_reservations
        set status = 'expired', finalized_at = now(), updated_at = now()
        where id = $1 and status = 'reserved'
      `,
      [reservation.id],
    );
    await client.query(
      `
        insert into public.sidestream_credit_ledger (
          wallet_id, reservation_id, entry_type, credit_delta,
          available_balance_after, idempotency_key, created_at
        ) values ($1, $2, 'download_expired', $3, $4, $5, now())
      `,
      [
        wallet.id,
        reservation.id,
        reservation.credit_cost,
        updatedWallet.rows[0].available_credits,
        `expire:${reservation.reservation_key}`,
      ],
    );
  }
}

async function getWalletSnapshot(
  client: PoolClient,
  walletId: string,
): Promise<DownloadCreditSnapshot> {
  const result = await client.query<CreditWalletRow & { reserved_credits: number }>(
    `
      select
        wallet.id,
        wallet.available_credits,
        wallet.granted_credits,
        wallet.spent_credits,
        coalesce(sum(reservation.credit_cost) filter (
          where reservation.status = 'reserved'
        ), 0)::integer as reserved_credits
      from public.sidestream_credit_wallets wallet
      left join public.sidestream_credit_reservations reservation
        on reservation.wallet_id = wallet.id
      where wallet.id = $1
      group by wallet.id
    `,
    [walletId],
  );
  const wallet = result.rows[0];
  if (!wallet) throw new Error("Credit wallet snapshot is unavailable");
  return Object.freeze({
    balance: wallet.available_credits,
    reserved: wallet.reserved_credits,
    granted: wallet.granted_credits,
    spent: wallet.spent_credits,
    starterGrant: STARTER_DOWNLOAD_CREDITS,
    costs: DOWNLOAD_CREDIT_COSTS,
  });
}

function emptyFinalizationResult(reservationKey: string): DownloadCreditFinalizationResult {
  return {
    balance: 0,
    reserved: 0,
    granted: 0,
    spent: 0,
    starterGrant: STARTER_DOWNLOAD_CREDITS,
    costs: DOWNLOAD_CREDIT_COSTS,
    found: false,
    reservationKey,
    status: "not_found",
    creditCost: 0,
  };
}

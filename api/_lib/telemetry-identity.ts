/** Transaction-scoped telemetry install identity bridge. */

import type { PoolClient } from "pg";

export const TELEMETRY_INSTALL_ID_HASH_PATTERN = /^[0-9a-f]{64}$/;

export type TelemetryIdentityInput = Readonly<{
  installIdHash?: string;
}>;

export class TelemetryIdentityInputError extends TypeError {
  constructor() {
    super("Invalid telemetry install ID hash");
    this.name = "TelemetryIdentityInputError";
  }
}

export function normalizeTelemetryIdentityInput(
  input: unknown,
): TelemetryIdentityInput {
  const value = isRecord(input) ? input.installIdHash : undefined;
  if (value === undefined || value === null || value === "") {
    return Object.freeze({});
  }
  if (typeof value !== "string" || !TELEMETRY_INSTALL_ID_HASH_PATTERN.test(value)) {
    throw new TelemetryIdentityInputError();
  }
  return Object.freeze({ installIdHash: value });
}

export type LinkTelemetryIdentityResult =
  | Readonly<{ outcome: "skipped" | "created" | "seen" | "linked" }>
  | Readonly<{ outcome: "conflict"; conflict: "device" | "account" }>
  | Readonly<{ outcome: "unavailable"; reason: "schema_absent" | "write_failed" }>;

type LinkTelemetryIdentityOptions = Readonly<{
  licenseNamespace: string;
  installIdHash?: string;
  deviceIdHash: string;
  accountId?: string | null;
}>;

type TelemetryIdentityRow = Readonly<{
  device_id_hash: string;
  account_id: string | null;
  linked_at: Date | string | null;
}>;

const SAVEPOINT = "sidestream_telemetry_identity_link";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * First-binds one telemetry install to a server-HMAC device digest, then may
 * add one server-verified account. Callers own the surrounding transaction.
 * The savepoint keeps this additive bridge fail-open when its schema or write
 * path is unavailable without weakening the caller's product transaction.
 */
export async function linkTelemetryIdentity(
  client: PoolClient,
  options: LinkTelemetryIdentityOptions,
): Promise<LinkTelemetryIdentityResult> {
  if (
    options.licenseNamespace !== "production" &&
    options.licenseNamespace !== "test"
  ) {
    throw new TypeError("Invalid telemetry identity license namespace");
  }
  if (!TELEMETRY_INSTALL_ID_HASH_PATTERN.test(options.deviceIdHash)) {
    throw new TypeError("Invalid telemetry identity device hash");
  }
  if (options.accountId && !UUID_PATTERN.test(options.accountId)) {
    throw new TypeError("Invalid telemetry identity account ID");
  }

  const identity = normalizeTelemetryIdentityInput({
    installIdHash: options.installIdHash,
  });
  if (!identity.installIdHash) return { outcome: "skipped" };

  await client.query(`savepoint ${SAVEPOINT}`);
  try {
    const schema = await client.query<{ bridge: string | null }>(
      "select to_regclass('public.sidestream_telemetry_identity_links')::text as bridge",
    );
    if (!schema.rows[0]?.bridge) {
      await client.query(`release savepoint ${SAVEPOINT}`);
      return { outcome: "unavailable", reason: "schema_absent" };
    }

    const inserted = await client.query<{ account_id: string | null }>(
      `
        insert into public.sidestream_telemetry_identity_links (
          license_namespace,
          install_id_hash,
          device_id_hash,
          account_id,
          first_seen_at,
          last_seen_at,
          linked_at
        ) values ($1, $2, $3, $4::uuid, now(), now(), case when $4::uuid is null then null else now() end)
        on conflict (license_namespace, install_id_hash) do nothing
        returning account_id
      `,
      [
        options.licenseNamespace,
        identity.installIdHash,
        options.deviceIdHash,
        options.accountId || null,
      ],
    );
    if (inserted.rows[0]) {
      await client.query(`release savepoint ${SAVEPOINT}`);
      return { outcome: "created" };
    }

    const selected = await client.query<TelemetryIdentityRow>(
      `
        select device_id_hash, account_id, linked_at
        from public.sidestream_telemetry_identity_links
        where license_namespace = $1 and install_id_hash = $2
        for update
      `,
      [options.licenseNamespace, identity.installIdHash],
    );
    const existing = selected.rows[0];
    if (!existing) throw new Error("Telemetry identity conflict lost its row");

    if (existing.device_id_hash !== options.deviceIdHash) {
      await client.query(`release savepoint ${SAVEPOINT}`);
      logConflict("device");
      return { outcome: "conflict", conflict: "device" };
    }

    const accountId = options.accountId || null;
    if (
      accountId &&
      ((existing.account_id && existing.account_id !== accountId) ||
        (!existing.account_id && existing.linked_at !== null))
    ) {
      await client.query(`release savepoint ${SAVEPOINT}`);
      logConflict("account");
      return { outcome: "conflict", conflict: "account" };
    }

    const shouldLink = Boolean(accountId && !existing.account_id);
    await client.query(
      `
        update public.sidestream_telemetry_identity_links
        set account_id = case
              when account_id is null and linked_at is null then $3::uuid
              else account_id
            end,
            linked_at = case
              when $3::uuid is not null then coalesce(linked_at, now())
              else linked_at
            end,
            last_seen_at = greatest(last_seen_at, now())
        where license_namespace = $1
          and install_id_hash = $2
          and device_id_hash = $4
      `,
      [
        options.licenseNamespace,
        identity.installIdHash,
        accountId,
        options.deviceIdHash,
      ],
    );
    await client.query(`release savepoint ${SAVEPOINT}`);
    return { outcome: shouldLink ? "linked" : "seen" };
  } catch {
    await client.query(`rollback to savepoint ${SAVEPOINT}`);
    await client.query(`release savepoint ${SAVEPOINT}`);
    console.warn("Telemetry identity bridge write unavailable");
    return { outcome: "unavailable", reason: "write_failed" };
  }
}

function logConflict(conflict: "device" | "account") {
  console.warn("Telemetry identity bridge conflict", { conflict });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

export const APPLY_CONFIRMATION = "APPLY-LEGACY-SUBSCRIPTIONS";
export const PRODUCT_ALLOWLIST_ENV = "SIDESTREAM_LEGACY_SUBSCRIPTION_PRODUCT_IDS";
export const PRICE_ALLOWLIST_ENV = "SIDESTREAM_LEGACY_SUBSCRIPTION_PRICE_IDS";
export const POSTGRES_URL_ENV_NAMES = [
  "SIDESTREAM_POSTGRES_URL",
  "SIDESTREAM_POSTGRES_PRISMA_URL",
  "SIDESTREAM_POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
];
export const DIRECT_POSTGRES_URL_ENV_NAMES = [
  "SIDESTREAM_POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL_NON_POOLING",
];

const INVENTORY_QUERY = `
  select id as license_id, stripe_subscription_id
  from public.sidestream_licenses
  where stripe_subscription_id is not null
  order by stripe_subscription_id asc, id asc
`;

class CliError extends Error {}

export function parseArgs(argv) {
  const options = {
    fixture: false,
    readOnly: false,
    apply: false,
    help: false,
    databaseUrlEnv: "",
    confirmation: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--fixture") options.fixture = true;
    else if (argument === "--read-only") options.readOnly = true;
    else if (argument === "--apply") options.apply = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (
      argument === "--database-url-env" ||
      argument.startsWith("--database-url-env=")
    ) {
      [options.databaseUrlEnv, index] = readOption(
        argv,
        index,
        "--database-url-env",
      );
    } else if (argument === "--confirm" || argument.startsWith("--confirm=")) {
      [options.confirmation, index] = readOption(argv, index, "--confirm");
    } else {
      throw new CliError(`Unknown argument: ${argument}`);
    }
  }
  if (options.help) return options;
  if (options.readOnly && options.apply) {
    throw new CliError("Choose exactly one of --read-only or --apply.");
  }
  if (!options.readOnly && !options.apply) options.readOnly = true;
  if (options.fixture && options.apply) {
    throw new CliError("Fixture mode is read-only and cannot apply mutations.");
  }
  if (options.apply) {
    if (!options.databaseUrlEnv) {
      throw new CliError("Apply mode requires --database-url-env with a non-pooling URL.");
    }
    if (options.confirmation !== APPLY_CONFIRMATION) {
      throw new CliError(`Apply mode requires --confirm ${APPLY_CONFIRMATION}.`);
    }
  }
  return options;
}

export function parseAllowlist(value, prefix) {
  const pattern = new RegExp(`^${prefix}_[A-Za-z0-9]+$`);
  return [...new Set(String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => pattern.test(entry)))];
}

export function verifyLegacySubscription(subscription, price, product, allowlist) {
  const items = subscription?.items?.data || [];
  if (items.length !== 1 || subscription?.items?.has_more !== false) {
    return { ok: false, reason: "invalid_subscription_items" };
  }
  if (items[0]?.quantity !== 1) {
    return { ok: false, reason: "invalid_subscription_quantity" };
  }
  const itemPriceId = stripeId(items[0]?.price);
  const priceId = stripeId(price?.id);
  const productId = stripeId(product?.id);
  if (!priceId || itemPriceId !== priceId) {
    return { ok: false, reason: "subscription_price_mismatch" };
  }
  if (!productId || stripeId(price?.product) !== productId) {
    return { ok: false, reason: "subscription_product_mismatch" };
  }
  if (!allowlist.priceIds.includes(priceId)) {
    return { ok: false, reason: "price_not_allowed" };
  }
  if (!allowlist.productIds.includes(productId)) {
    return { ok: false, reason: "product_not_allowed" };
  }
  if (price?.active !== true || product?.active !== true || product?.deleted === true) {
    return { ok: false, reason: "inactive_billing_resource" };
  }
  if (
    price?.type !== "recurring" ||
    price?.recurring?.interval !== "month" ||
    price?.recurring?.interval_count !== 1 ||
    price?.recurring?.usage_type !== "licensed"
  ) {
    return { ok: false, reason: "invalid_recurring_shape" };
  }
  if (
    typeof price?.currency !== "string" ||
    !/^[a-z]{3}$/.test(price.currency) ||
    !Number.isSafeInteger(price?.unit_amount) ||
    price.unit_amount <= 0
  ) {
    return { ok: false, reason: "invalid_price_terms" };
  }
  return { ok: true, priceId, productId };
}

export async function inventoryLegacySubscriptions(rows, stripe, allowlist) {
  const inventory = [];
  for (const row of rows) {
    const subscription = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
    if (subscription.id !== row.stripe_subscription_id) {
      inventory.push(deniedInventoryRow(row, "subscription_identity_mismatch"));
      continue;
    }
    const items = subscription.items?.data || [];
    const priceId = items.length === 1 ? stripeId(items[0]?.price) : "";
    const price = priceId ? await stripe.prices.retrieve(priceId) : {};
    const productId = stripeId(price?.product);
    const product = productId ? await stripe.products.retrieve(productId) : {};
    const verification = verifyLegacySubscription(
      subscription,
      price,
      product,
      allowlist,
    );
    const active = subscription.status === "active" || subscription.status === "trialing";
    inventory.push({
      licenseId: row.license_id,
      subscriptionId: row.stripe_subscription_id,
      subscriptionStatus: String(subscription.status || "unknown"),
      priceId,
      productId,
      action: verification.ok && active ? "backfill" : "quarantine",
      reason: verification.ok ? (active ? "eligible" : "inactive_subscription") : verification.reason,
      eligible: verification.ok && active,
    });
  }
  return inventory;
}

export function buildReport(inventory, mode) {
  const summary = {
    total: inventory.length,
    eligible: inventory.filter((row) => row.eligible).length,
    backfill: inventory.filter((row) => row.action === "backfill").length,
    quarantine: inventory.filter((row) => row.action === "quarantine").length,
  };
  return {
    mode,
    allowlistDefault: "deny",
    summary,
    subscriptions: inventory.map((row) => ({
      subscriptionId: row.subscriptionId,
      status: row.subscriptionStatus,
      priceId: row.priceId,
      productId: row.productId,
      action: row.action,
      reason: row.reason,
    })),
  };
}

async function applyInventory(pool, inventory) {
  for (const row of inventory) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const locked = await client.query(
        `
          select id
          from public.sidestream_licenses
          where id = $1 and stripe_subscription_id = $2
          for update
        `,
        [row.licenseId, row.subscriptionId],
      );
      if (!locked.rows[0]) throw new Error("Legacy subscription row changed during audit.");
      if (row.eligible) {
        await client.query(
          `
            update public.sidestream_licenses
            set stripe_price_id = $2,
                stripe_product_id = $3,
                plan_key = 'sidestream_pro',
                status = $4,
                entitlement_status = 'active',
                status_reason = 'legacy_audit_allowlisted',
                grace_until = null,
                features = features || '{"unlimited_downloads": true, "customer_portal": true}'::jsonb,
                reconciled_at = now(),
                legacy_subscription_eligible = true,
                legacy_subscription_audited_at = now(),
                legacy_subscription_quarantined_at = null,
                updated_at = now()
            where id = $1
          `,
          [row.licenseId, row.priceId, row.productId, row.subscriptionStatus],
        );
      } else {
        await client.query(
          `
            update public.sidestream_licenses
            set stripe_price_id = nullif($2, ''),
                stripe_product_id = nullif($3, ''),
                status = $4,
                entitlement_status = 'revoked',
                status_reason = $5,
                revoked_at = coalesce(revoked_at, now()),
                reconciled_at = now(),
                legacy_subscription_eligible = false,
                legacy_subscription_audited_at = now(),
                legacy_subscription_quarantined_at = coalesce(
                  legacy_subscription_quarantined_at,
                  now()
                ),
                features = features || '{"unlimited_downloads": false}'::jsonb,
                updated_at = now()
            where id = $1
          `,
          [
            row.licenseId,
            row.priceId,
            row.productId,
            row.subscriptionStatus,
            `legacy_audit_${row.reason}`.slice(0, 160),
          ],
        );
        await client.query(
          `
            update public.sidestream_license_tokens
            set revoked_at = coalesce(revoked_at, now()),
                refresh_token_hash = null,
                refresh_expires_at = null,
                previous_refresh_token_hash = null,
                previous_refresh_valid_until = null,
                refresh_rotated_at = null,
                updated_at = now()
            where license_id = $1
          `,
          [row.licenseId],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

function resolveDatabase(environment, options) {
  const selected = options.databaseUrlEnv ||
    POSTGRES_URL_ENV_NAMES.find((name) => configured(environment[name])) || "";
  if (!POSTGRES_URL_ENV_NAMES.includes(selected) || !configured(environment[selected])) {
    throw new CliError("Select a configured Sidestream Postgres URL environment variable.");
  }
  const connectionString = environment[selected].trim();
  if (
    options.apply &&
    (!DIRECT_POSTGRES_URL_ENV_NAMES.includes(selected) || isPooled(connectionString))
  ) {
    throw new CliError("Apply mode requires an explicit non-pooling Postgres URL.");
  }
  return connectionString;
}

function isPooled(connectionString) {
  try {
    const url = new URL(connectionString);
    return url.hostname.includes("pooler") || url.port === "6543" ||
      url.searchParams.has("pgbouncer") || url.searchParams.has("connection_limit");
  } catch {
    return true;
  }
}

function fixtureRuntime() {
  const subscriptions = new Map([
    ["sub_allowed", subscriptionFixture("sub_allowed", "price_allowed", 1, { spoof: "none" })],
    ["sub_spoofed", subscriptionFixture("sub_spoofed", "price_attacker", 1, {
      sidestream_plan: "sidestream_pro",
      allowed_price: "price_allowed",
    })],
    ["sub_multiple", {
      ...subscriptionFixture("sub_multiple", "price_allowed", 1),
      items: {
        data: [
          { quantity: 1, price: "price_allowed" },
          { quantity: 1, price: "price_allowed" },
        ],
        has_more: false,
      },
    }],
    ["sub_quantity", subscriptionFixture("sub_quantity", "price_allowed", 2)],
  ]);
  const prices = new Map([
    ["price_allowed", priceFixture("price_allowed", "prod_allowed")],
    ["price_attacker", priceFixture("price_attacker", "prod_attacker")],
  ]);
  const products = new Map([
    ["prod_allowed", { id: "prod_allowed", active: true }],
    ["prod_attacker", { id: "prod_attacker", active: true }],
  ]);
  return {
    rows: [...subscriptions.keys()].map((subscriptionId, index) => ({
      license_id: `fixture-license-${index + 1}`,
      stripe_subscription_id: subscriptionId,
    })),
    stripe: {
      subscriptions: { retrieve: async (id) => structuredClone(subscriptions.get(id)) },
      prices: { retrieve: async (id) => structuredClone(prices.get(id)) },
      products: { retrieve: async (id) => structuredClone(products.get(id)) },
    },
    allowlist: { priceIds: ["price_allowed"], productIds: ["prod_allowed"] },
  };
}

function subscriptionFixture(id, priceId, quantity, metadata = {}) {
  return {
    id,
    customer: `cus_${id}`,
    status: "active",
    metadata,
    items: { data: [{ quantity, price: priceId }], has_more: false },
  };
}

function priceFixture(id, productId) {
  return {
    id,
    product: productId,
    active: true,
    type: "recurring",
    currency: "usd",
    unit_amount: 499,
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
  };
}

function deniedInventoryRow(row, reason) {
  return {
    licenseId: row.license_id,
    subscriptionId: row.stripe_subscription_id,
    subscriptionStatus: "unknown",
    priceId: "",
    productId: "",
    action: "quarantine",
    reason,
    eligible: false,
  };
}

function stripeId(value) {
  if (typeof value === "string") return value;
  return value && typeof value === "object" && typeof value.id === "string" ? value.id : "";
}

function readOption(argv, index, name) {
  const argument = argv[index];
  if (argument.startsWith(`${name}=`)) return [argument.slice(name.length + 1), index];
  if (!argv[index + 1] || argv[index + 1].startsWith("--")) {
    throw new CliError(`${name} requires a value.`);
  }
  return [argv[index + 1], index + 1];
}

function configured(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function printHelp() {
  console.log(`Usage:
  node scripts/audit-legacy-subscriptions.mjs --fixture --read-only
  node scripts/audit-legacy-subscriptions.mjs --read-only [--database-url-env NAME]
  node scripts/audit-legacy-subscriptions.mjs --apply --database-url-env NAME --confirm ${APPLY_CONFIRMATION}

Allowlist env (both default to empty/default-deny):
  ${PRODUCT_ALLOWLIST_ENV}
  ${PRICE_ALLOWLIST_ENV}`);
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }
  if (options.fixture) {
    const fixture = fixtureRuntime();
    const inventory = await inventoryLegacySubscriptions(
      fixture.rows,
      fixture.stripe,
      fixture.allowlist,
    );
    const report = buildReport(inventory, "fixture-read-only");
    assert.deepEqual(report.summary, {
      total: 4,
      eligible: 1,
      backfill: 1,
      quarantine: 3,
    });
    console.log(JSON.stringify(report, null, 2));
    console.log("PASS: fixture inventory completed without Stripe or database access.");
    return;
  }

  const connectionString = resolveDatabase(environment, options);
  const stripeKey = environment.STRIPE_SECRET_KEY?.trim() || "";
  if (!stripeKey) throw new CliError("Missing STRIPE_SECRET_KEY for canonical readback.");
  const [{ Pool }, { default: Stripe }] = await Promise.all([import("pg"), import("stripe")]);
  const pool = new Pool({ connectionString });
  const stripe = new Stripe(stripeKey);
  try {
    const rows = (await pool.query(INVENTORY_QUERY)).rows;
    const allowlist = {
      productIds: parseAllowlist(environment[PRODUCT_ALLOWLIST_ENV], "prod"),
      priceIds: parseAllowlist(environment[PRICE_ALLOWLIST_ENV], "price"),
    };
    const inventory = await inventoryLegacySubscriptions(rows, stripe, allowlist);
    if (options.apply) await applyInventory(pool, inventory);
    console.log(JSON.stringify(buildReport(
      inventory,
      options.apply ? "apply" : "read-only",
    ), null, 2));
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error instanceof CliError ? error.message : error);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);

export const APPLY_CONFIRMATION = "DELETE-ALEX-GARRETT-UPGRADE-STATE";
export const TARGET_IDENTITY = Object.freeze({
  displayName: "Alex Garrett",
  emails: Object.freeze([
    "alex@alexg.mov",
    "alexg@wispr.ai",
    "alexgarrett2468@gmail.com",
  ]),
});

export const RESET_TARGETS = Object.freeze([
  Object.freeze({
    environment: "production",
    neonProjectId: "dark-butterfly-59697025",
    neonDatabase: "neondb",
    neonRole: "neondb_owner",
    stripeAccountId: "acct_1Tp340DFKjeGlioX",
    stripeKeyEnvironmentVariable:
      "SIDESTREAM_RESET_PRODUCTION_STRIPE_SECRET_KEY",
    requiredIdentityTable: "sidestream_customer_identity_links",
  }),
  Object.freeze({
    environment: "test",
    neonProjectId: "ancient-breeze-53489732",
    neonDatabase: "neondb",
    neonRole: "neondb_owner",
    stripeAccountId: "acct_1TuyMKDNXvmQYu29",
    stripeKeyEnvironmentVariable: "SIDESTREAM_RESET_TEST_STRIPE_SECRET_KEY",
    requiredIdentityTable: "sidestream_telemetry_identity_links",
  }),
]);

const CORE_TABLES = Object.freeze([
  "sidestream_accounts",
  "sidestream_account_sessions",
  "sidestream_licenses",
  "sidestream_license_tokens",
  "sidestream_activation_sessions",
  "sidestream_checkout_intents",
  "sidestream_account_devices",
  "sidestream_device_transfers",
  "sidestream_stripe_events",
]);

const NEON_CLI_PACKAGE = "neonctl@2.37.1";
const RESET_SECRET_ENVIRONMENT_VARIABLES = Object.freeze(
  RESET_TARGETS.map((target) => target.stripeKeyEnvironmentVariable),
);
const MAX_MATCHING_STRIPE_CUSTOMERS = 25;
const SETTLE_PASS_COUNT = 3;
const SETTLE_DELAY_MS = 1_500;
const DATABASE_LOCK = "sidestream:reset-alex-upgrade-state:v1";

export class ResetCliError extends Error {}

export function parseArgs(argv) {
  const options = {
    apply: false,
    confirmation: "",
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--confirm" || argument.startsWith("--confirm=")) {
      [options.confirmation, index] = readOption(
        argv,
        index,
        "--confirm",
      );
    } else {
      throw new ResetCliError(`Unknown argument: ${argument}`);
    }
  }

  if (
    options.apply &&
    options.confirmation !== APPLY_CONFIRMATION
  ) {
    throw new ResetCliError(
      `Apply mode requires --confirm ${APPLY_CONFIRMATION}.`,
    );
  }
  return options;
}

export function matchesTargetIdentity(customer) {
  const email = normalizeIdentityValue(customer?.email);
  const name = normalizeIdentityValue(customer?.name);
  return TARGET_IDENTITY.emails.includes(email) ||
    name === normalizeIdentityValue(TARGET_IDENTITY.displayName);
}

export function extractNeonConnectionString(output) {
  const trimmed = String(output || "").trim();
  if (trimmed.startsWith("postgres://") || trimmed.startsWith("postgresql://")) {
    return trimmed;
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ResetCliError(
      "Authenticated Neon CLI did not return a connection string.",
    );
  }

  if (typeof parsed === "string") return extractNeonConnectionString(parsed);
  if (!parsed || typeof parsed !== "object") {
    throw new ResetCliError(
      "Authenticated Neon CLI did not return a connection string.",
    );
  }
  const candidate = [
    parsed.connection_string,
    parsed.connectionString,
    parsed.url,
    ...Object.values(parsed),
  ].find((value) =>
    typeof value === "string" &&
    (value.startsWith("postgres://") || value.startsWith("postgresql://"))
  );
  if (!candidate) {
    throw new ResetCliError(
      "Authenticated Neon CLI did not return a connection string.",
    );
  }
  return candidate;
}

export function verifyNeonConnectionString(connectionString, target) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new ResetCliError(
      `${target.environment} Neon returned an invalid connection string.`,
    );
  }

  const hostname = url.hostname.toLowerCase();
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(hostname)
  ) {
    throw new ResetCliError(
      `${target.environment} connection is not a direct Neon endpoint.`,
    );
  }
  if (
    hostname.includes("-pooler.") ||
    hostname.includes("-pool.") ||
    url.port === "6543" ||
    url.searchParams.has("pgbouncer") ||
    url.searchParams.has("connection_limit")
  ) {
    throw new ResetCliError(
      `${target.environment} reset refuses pooled/runtime Postgres endpoints.`,
    );
  }
  if (
    decodeURIComponent(url.username) !== target.neonRole ||
    decodeURIComponent(url.pathname.slice(1)) !== target.neonDatabase
  ) {
    throw new ResetCliError(
      `${target.environment} Neon role or database does not match the fixed reset target.`,
    );
  }

  url.searchParams.set("sslmode", "verify-full");
  return Object.freeze({
    connectionString: url.toString(),
    endpointId: hostname.split(".")[0],
  });
}

export function validateStripeKey(key, environment) {
  const expectedPrefix = environment === "production" ? "sk_live_" : "sk_test_";
  if (!configuredValue(key) || !key.trim().startsWith(expectedPrefix)) {
    throw new ResetCliError(
      `${environment} reset requires a ${expectedPrefix} secret key.`,
    );
  }
  return key.trim();
}

export function parseResetEnvironmentFile(contents) {
  if (typeof contents !== "string" || contents.includes("\0")) {
    throw new ResetCliError("Reset environment file is not valid text.");
  }
  if (Buffer.byteLength(contents, "utf8") > 16 * 1024) {
    throw new ResetCliError("Reset environment file exceeds 16 KiB.");
  }

  const parsed = {};
  for (const [lineIndex, line] of contents.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match) {
      throw new ResetCliError(
        `Malformed reset environment entry on line ${lineIndex + 1}.`,
      );
    }
    const [, key, rawValue] = match;
    if (!RESET_SECRET_ENVIRONMENT_VARIABLES.includes(key)) {
      throw new ResetCliError(
        `Reset environment file contains unsupported key ${key}.`,
      );
    }
    if (Object.hasOwn(parsed, key)) {
      throw new ResetCliError(
        `Reset environment file repeats key ${key}.`,
      );
    }
    const value = rawValue.trim().replace(/^(['"])(.*)\1$/, "$2");
    if (!value) {
      throw new ResetCliError(
        `Reset environment file has an empty value for ${key}.`,
      );
    }
    parsed[key] = value;
  }
  return parsed;
}

export function buildNeonCliEnvironment(environment = process.env) {
  const sanitized = { ...environment };
  for (const key of RESET_SECRET_ENVIRONMENT_VARIABLES) delete sanitized[key];
  delete sanitized.SIDESTREAM_RESET_ENV_FILE;
  return sanitized;
}

export async function listMatchingStripeCustomers(stripe) {
  const matches = [];
  let startingAfter;

  do {
    const page = await stripe.customers.list({
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const customer of page.data || []) {
      if (!customer?.deleted && matchesTargetIdentity(customer)) {
        matches.push(customer);
      }
    }
    if (!page.has_more) break;
    const last = page.data?.at(-1);
    if (!last?.id) {
      throw new ResetCliError("Stripe customer pagination did not advance.");
    }
    startingAfter = last.id;
  } while (true);

  if (matches.length > MAX_MATCHING_STRIPE_CUSTOMERS) {
    throw new ResetCliError(
      `Refusing to continue after matching ${matches.length} Stripe customers; ` +
      `the fixed safety limit is ${MAX_MATCHING_STRIPE_CUSTOMERS}.`,
    );
  }
  return matches;
}

export function buildResetReport({
  mode,
  runtimes,
  finalVerification = null,
}) {
  return {
    mode,
    target: {
      displayName: TARGET_IDENTITY.displayName,
      emails: [...TARGET_IDENTITY.emails],
    },
    environments: runtimes.map((runtime) => ({
      environment: runtime.target.environment,
      neonProjectId: runtime.target.neonProjectId,
      neonEndpointId: runtime.database.endpointId,
      stripeAccountId: runtime.target.stripeAccountId,
      stripeCustomers: {
        identityMatches: runtime.stripeIdentityCustomerIds.length,
        databaseLinked: runtime.databaseLinkedCustomerIds.length,
        total: runtime.stripeCustomerIds.length,
        ids: [...runtime.stripeCustomerIds],
        deleted: runtime.deletedStripeCustomerIds?.length || 0,
      },
      database: {
        before: runtime.inventory.counts,
        deleted: runtime.deletedCounts || null,
      },
    })),
    preserved: [
      "Stripe invoices, payments, charges, refunds, disputes, and event history outside the app-owned webhook queue",
      "Customer 360 profiles, installs, commerce projections, merge history, and immutable identity reviews",
      "Download leads and installer/referral analytics",
      "Local CEP/plugin installations, caches, receipts, and application state",
    ],
    finalVerification,
  };
}

export async function inventoryDatabase(
  client,
  target,
  stripeCustomerIds,
  {
    forUpdate = false,
    hints = {},
  } = {},
) {
  await assertExpectedSchema(client, target);
  const lockClause = forUpdate ? " for update" : "";
  const emails = [...TARGET_IDENTITY.emails];
  const displayName = normalizeIdentityValue(TARGET_IDENTITY.displayName);
  const knownAccountIds = uniqueStrings(hints.accountIds);
  const knownLicenseIds = uniqueStrings(hints.licenseIds);
  const knownActivationIds = uniqueStrings(hints.activationIds);
  const knownCheckoutIntentIds = uniqueStrings(hints.checkoutIntentIds);
  const knownTokenIds = uniqueStrings(hints.tokenIds);
  const knownDeviceIds = uniqueStrings(hints.deviceIds);
  const knownTransferIds = uniqueStrings(hints.transferIds);
  const knownIdentityLinkIds = uniqueStrings(hints.identityLinkIds);
  const knownTelemetryIdentityLinkIds = uniqueStrings(
    hints.telemetryIdentityLinkIds,
  );
  const knownEventIds = uniqueStrings(hints.eventIds);

  const accounts = (await client.query(
    `
      select id, email, display_name, stripe_customer_id
      from public.sidestream_accounts
      where id = any($1::uuid[])
        or lower(btrim(email)) = any($2::text[])
        or lower(btrim(coalesce(display_name, ''))) = $3
        or stripe_customer_id = any($4::text[])
      order by id
      ${lockClause}
    `,
    [
      knownAccountIds,
      emails,
      displayName,
      uniqueStrings(stripeCustomerIds),
    ],
  )).rows;
  const accountIds = uniqueStrings([
    ...knownAccountIds,
    ...accounts.map((row) => row.id),
  ]);
  const linkedAccountCustomerIds = uniqueStripeIds(
    accounts.map((row) => row.stripe_customer_id),
  );
  const customerIds = uniqueStripeIds([
    ...stripeCustomerIds,
    ...linkedAccountCustomerIds,
  ]);

  const licenses = (await client.query(
    `
      select
        id,
        account_id,
        stripe_customer_id,
        stripe_subscription_id,
        stripe_checkout_session_id,
        stripe_payment_intent_id,
        stripe_charge_id,
        stripe_state_event_id
      from public.sidestream_licenses
      where id = any($1::uuid[])
        or account_id = any($2::uuid[])
        or stripe_customer_id = any($3::text[])
      order by id
      ${lockClause}
    `,
    [knownLicenseIds, accountIds, customerIds],
  )).rows;
  const licenseIds = uniqueStrings([
    ...knownLicenseIds,
    ...licenses.map((row) => row.id),
  ]);
  const linkedLicenseCustomerIds = uniqueStripeIds(
    licenses.map((row) => row.stripe_customer_id),
  );
  const allCustomerIds = uniqueStripeIds([
    ...customerIds,
    ...linkedLicenseCustomerIds,
  ]);
  const checkoutSessionIds = uniqueStripeIds([
    ...hints.checkoutSessionIds || [],
    ...licenses.map((row) => row.stripe_checkout_session_id),
  ], "cs_");

  let checkoutIntents = (await client.query(
    `
      select
        id,
        account_id,
        activation_session_id,
        stripe_customer_id,
        stripe_checkout_session_id
      from public.sidestream_checkout_intents
      where id = any($1::uuid[])
        or account_id = any($2::uuid[])
        or stripe_customer_id = any($3::text[])
        or stripe_checkout_session_id = any($4::text[])
      order by id
      ${lockClause}
    `,
    [
      knownCheckoutIntentIds,
      accountIds,
      allCustomerIds,
      checkoutSessionIds,
    ],
  )).rows;
  const intentActivationIds = uniqueStrings(
    checkoutIntents.map((row) => row.activation_session_id),
  );
  const expandedCheckoutSessionIds = uniqueStripeIds([
    ...checkoutSessionIds,
    ...checkoutIntents.map((row) => row.stripe_checkout_session_id),
  ], "cs_");

  const activationSessions = (await client.query(
    `
      select id, account_id, license_id, device_id_hash, stripe_checkout_session_id
      from public.sidestream_activation_sessions
      where id = any($1::uuid[])
        or account_id = any($2::uuid[])
        or license_id = any($3::uuid[])
        or stripe_checkout_session_id = any($4::text[])
      order by id
      ${lockClause}
    `,
    [
      uniqueStrings([...knownActivationIds, ...intentActivationIds]),
      accountIds,
      licenseIds,
      expandedCheckoutSessionIds,
    ],
  )).rows;
  const activationIds = uniqueStrings([
    ...knownActivationIds,
    ...intentActivationIds,
    ...activationSessions.map((row) => row.id),
  ]);

  checkoutIntents = (await client.query(
    `
      select
        id,
        account_id,
        activation_session_id,
        stripe_customer_id,
        stripe_checkout_session_id
      from public.sidestream_checkout_intents
      where id = any($1::uuid[])
        or account_id = any($2::uuid[])
        or activation_session_id = any($3::uuid[])
        or stripe_customer_id = any($4::text[])
        or stripe_checkout_session_id = any($5::text[])
      order by id
      ${lockClause}
    `,
    [
      knownCheckoutIntentIds,
      accountIds,
      activationIds,
      allCustomerIds,
      expandedCheckoutSessionIds,
    ],
  )).rows;
  const checkoutIntentIds = uniqueStrings([
    ...knownCheckoutIntentIds,
    ...checkoutIntents.map((row) => row.id),
  ]);

  const licenseTokens = (await client.query(
    `
      select id, account_id, license_id, activation_session_id, device_id_hash
      from public.sidestream_license_tokens
      where id = any($1::uuid[])
        or account_id = any($2::uuid[])
        or license_id = any($3::uuid[])
        or activation_session_id = any($4::uuid[])
      order by id
      ${lockClause}
    `,
    [knownTokenIds, accountIds, licenseIds, activationIds],
  )).rows;
  const tokenIds = uniqueStrings([
    ...knownTokenIds,
    ...licenseTokens.map((row) => row.id),
  ]);

  const devices = (await client.query(
    `
      select id, account_id, device_id_hash
      from public.sidestream_account_devices
      where id = any($1::uuid[]) or account_id = any($2::uuid[])
      order by id
      ${lockClause}
    `,
    [knownDeviceIds, accountIds],
  )).rows;
  const deviceIds = uniqueStrings([
    ...knownDeviceIds,
    ...devices.map((row) => row.id),
  ]);
  const deviceHashes = uniqueStrings([
    ...hints.deviceHashes || [],
    ...devices.map((row) => row.device_id_hash),
    ...activationSessions.map((row) => row.device_id_hash),
    ...licenseTokens.map((row) => row.device_id_hash),
  ]);

  const transfers = (await client.query(
    `
      select id, account_id
      from public.sidestream_device_transfers
      where id = any($1::uuid[])
        or account_id = any($2::uuid[])
        or from_device_id = any($3::uuid[])
        or to_device_id = any($3::uuid[])
      order by id
      ${lockClause}
    `,
    [knownTransferIds, accountIds, deviceIds],
  )).rows;
  const transferIds = uniqueStrings([
    ...knownTransferIds,
    ...transfers.map((row) => row.id),
  ]);

  const accountSessions = (await client.query(
    `
      select id, account_id
      from public.sidestream_account_sessions
      where account_id = any($1::uuid[])
      order by id
      ${lockClause}
    `,
    [accountIds],
  )).rows;

  const checkoutIds = uniqueStripeIds([
    ...expandedCheckoutSessionIds,
    ...checkoutIntents.map((row) => row.stripe_checkout_session_id),
    ...activationSessions.map((row) => row.stripe_checkout_session_id),
  ], "cs_");
  const paymentIntentIds = uniqueStripeIds([
    ...hints.paymentIntentIds || [],
    ...licenses.map((row) => row.stripe_payment_intent_id),
  ], "pi_");
  const chargeIds = uniqueStripeIds([
    ...hints.chargeIds || [],
    ...licenses.map((row) => row.stripe_charge_id),
  ], "ch_");
  const subscriptionIds = uniqueStripeIds([
    ...hints.subscriptionIds || [],
    ...licenses.map((row) => row.stripe_subscription_id),
  ], "sub_");
  const stateEventIds = uniqueStripeIds([
    ...hints.stateEventIds || [],
    ...licenses.map((row) => row.stripe_state_event_id),
  ], "evt_");

  const seeds = uniqueStrings([
    ...hints.seeds || [],
    TARGET_IDENTITY.displayName,
    ...emails,
    ...accountIds,
    ...licenseIds,
    ...activationIds,
    ...allCustomerIds,
    ...checkoutIds,
    ...paymentIntentIds,
    ...chargeIds,
    ...subscriptionIds,
    ...stateEventIds,
  ]);

  let identityLinks = [];
  let telemetryIdentityLinks = [];
  if (target.environment === "production") {
    identityLinks = (await client.query(
      `
        select id
        from public.sidestream_customer_identity_links
        where id = any($1::uuid[]) or link_value = any($2::text[])
        order by id
        ${lockClause}
      `,
      [knownIdentityLinkIds, seeds],
    )).rows;
  } else {
    telemetryIdentityLinks = (await client.query(
      `
        select id
        from public.sidestream_telemetry_identity_links
        where id = any($1::uuid[])
          or account_id = any($2::uuid[])
          or device_id_hash = any($3::text[])
        order by id
        ${lockClause}
      `,
      [knownTelemetryIdentityLinkIds, accountIds, deviceHashes],
    )).rows;
  }
  const identityLinkIds = uniqueStrings([
    ...knownIdentityLinkIds,
    ...identityLinks.map((row) => row.id),
  ]);
  const telemetryIdentityLinkIds = uniqueStrings([
    ...knownTelemetryIdentityLinkIds,
    ...telemetryIdentityLinks.map((row) => row.id),
  ]);

  const stripeEvents = (await client.query(
    `
      select event_id
      from public.sidestream_stripe_events event
      where event_id = any($1::text[])
        or exists (
          select 1
          from unnest($2::text[]) seed
          where strpos(lower(to_jsonb(event)::text), lower(seed)) > 0
        )
      order by event_id
      ${lockClause}
    `,
    [uniqueStrings([...knownEventIds, ...stateEventIds]), seeds],
  )).rows;
  const eventIds = uniqueStrings([
    ...knownEventIds,
    ...stripeEvents.map((row) => row.event_id),
  ]);

  const counts = {
    accounts: accounts.length,
    accountSessions: accountSessions.length,
    licenses: licenses.length,
    licenseTokens: licenseTokens.length,
    activationSessions: activationSessions.length,
    checkoutIntents: checkoutIntents.length,
    accountDevices: devices.length,
    deviceTransfers: transfers.length,
    stripeEvents: stripeEvents.length,
    customerIdentityLinks: identityLinks.length,
    telemetryIdentityLinks: telemetryIdentityLinks.length,
  };

  return {
    counts,
    ids: {
      accountIds,
      licenseIds,
      activationIds,
      checkoutIntentIds,
      tokenIds,
      deviceIds,
      transferIds,
      identityLinkIds,
      telemetryIdentityLinkIds,
      eventIds,
      checkoutSessionIds: checkoutIds,
      paymentIntentIds,
      chargeIds,
      subscriptionIds,
      stateEventIds,
      deviceHashes,
      seeds,
    },
    linkedStripeCustomerIds: uniqueStripeIds([
      ...linkedAccountCustomerIds,
      ...linkedLicenseCustomerIds,
      ...checkoutIntents.map((row) => row.stripe_customer_id),
    ]),
  };
}

export async function applyDatabaseReset(
  pool,
  target,
  stripeCustomerIds,
  hints = {},
) {
  const client = await pool.connect();
  try {
    await client.query(
      "begin transaction isolation level serializable read write",
    );
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      DATABASE_LOCK,
    ]);
    const inventory = await inventoryDatabase(
      client,
      target,
      stripeCustomerIds,
      { forUpdate: true, hints },
    );
    const ids = inventory.ids;
    const deleted = {};

    deleted.deviceTransfers = await deleteUuidRows(
      client,
      "sidestream_device_transfers",
      ids.transferIds,
    );
    deleted.licenseTokens = await deleteUuidRows(
      client,
      "sidestream_license_tokens",
      ids.tokenIds,
    );
    deleted.checkoutIntents = await deleteUuidRows(
      client,
      "sidestream_checkout_intents",
      ids.checkoutIntentIds,
    );
    deleted.accountDevices = await deleteUuidRows(
      client,
      "sidestream_account_devices",
      ids.deviceIds,
    );
    deleted.activationSessions = await deleteUuidRows(
      client,
      "sidestream_activation_sessions",
      ids.activationIds,
    );
    deleted.telemetryIdentityLinks = target.environment === "test"
      ? await deleteUuidRows(
        client,
        "sidestream_telemetry_identity_links",
        ids.telemetryIdentityLinkIds,
      )
      : 0;
    deleted.licenses = await deleteUuidRows(
      client,
      "sidestream_licenses",
      ids.licenseIds,
    );
    deleted.accountSessions = await deleteAccountRows(
      client,
      "sidestream_account_sessions",
      ids.accountIds,
    );
    deleted.accounts = await deleteUuidRows(
      client,
      "sidestream_accounts",
      ids.accountIds,
    );
    deleted.customerIdentityLinks = target.environment === "production"
      ? await deleteUuidRows(
        client,
        "sidestream_customer_identity_links",
        ids.identityLinkIds,
      )
      : 0;
    deleted.stripeEvents = await deleteTextRows(
      client,
      "sidestream_stripe_events",
      "event_id",
      ids.eventIds,
    );

    await client.query("commit");
    return { inventory, deleted };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export function mergeInventoryHints(...inventories) {
  const keys = [
    "accountIds",
    "licenseIds",
    "activationIds",
    "checkoutIntentIds",
    "tokenIds",
    "deviceIds",
    "transferIds",
    "identityLinkIds",
    "telemetryIdentityLinkIds",
    "eventIds",
    "checkoutSessionIds",
    "paymentIntentIds",
    "chargeIds",
    "subscriptionIds",
    "stateEventIds",
    "deviceHashes",
    "seeds",
  ];
  return Object.fromEntries(keys.map((key) => [
    key,
    uniqueStrings(inventories.flatMap((inventory) => inventory?.ids?.[key] || [])),
  ]));
}

export function allCountsZero(counts) {
  return Object.values(counts).every((count) => count === 0);
}

async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }
  loadEnvFile(environment.SIDESTREAM_RESET_ENV_FILE, environment);

  const runtimes = [];
  try {
    for (const target of RESET_TARGETS) {
      runtimes.push(await createRuntime(target, environment));
    }
    if (
      new Set(runtimes.map((runtime) => runtime.database.endpointId)).size !==
        runtimes.length
    ) {
      throw new ResetCliError(
        "Production and Test Neon targets resolved to the same endpoint.",
      );
    }
    for (const runtime of runtimes) {
      await validateRuntime(runtime);
      const matchingCustomers = await listMatchingStripeCustomers(runtime.stripe);
      runtime.stripeIdentityCustomerIds = matchingCustomers.map(
        (customer) => customer.id,
      );
      runtime.inventory = await withReadOnlyTransaction(
        runtime.pool,
        (client) => inventoryDatabase(
          client,
          runtime.target,
          runtime.stripeIdentityCustomerIds,
        ),
      );
      runtime.databaseLinkedCustomerIds =
        runtime.inventory.linkedStripeCustomerIds;
      runtime.stripeCustomerIds = uniqueStripeIds([
        ...runtime.stripeIdentityCustomerIds,
        ...runtime.databaseLinkedCustomerIds,
      ]);
      if (runtime.stripeCustomerIds.length > MAX_MATCHING_STRIPE_CUSTOMERS) {
        throw new ResetCliError(
          `${runtime.target.environment} resolved too many Stripe customers.`,
        );
      }
    }

    if (!options.apply) {
      console.log(JSON.stringify(buildResetReport({
        mode: "dry-run",
        runtimes,
      }), null, 2));
      console.log(
        `Dry-run only. Re-run with --apply --confirm ${APPLY_CONFIRMATION}.`,
      );
      return;
    }

    let verificationFailed = false;
    for (const runtime of runtimes) {
      runtime.deletedStripeCustomerIds = await deleteStripeCustomers(
        runtime.stripe,
        runtime.stripeCustomerIds,
        new Set(runtime.databaseLinkedCustomerIds),
      );
    }

    for (const runtime of runtimes) {
      const inventories = [runtime.inventory];
      const deletedCounts = {};
      for (let pass = 0; pass < SETTLE_PASS_COUNT; pass += 1) {
        if (pass > 0) await delay(SETTLE_DELAY_MS);
        const result = await applyDatabaseReset(
          runtime.pool,
          runtime.target,
          runtime.stripeCustomerIds,
          mergeInventoryHints(...inventories),
        );
        inventories.push(result.inventory);
        addCounts(deletedCounts, result.deleted);
      }
      runtime.deletedCounts = deletedCounts;
      runtime.inventoryHints = mergeInventoryHints(...inventories);
    }

    const finalVerification = {};
    for (const runtime of runtimes) {
      const [remainingCustomers, inventory] = await Promise.all([
        listMatchingStripeCustomers(runtime.stripe),
        withReadOnlyTransaction(
          runtime.pool,
          (client) => inventoryDatabase(
            client,
            runtime.target,
            runtime.stripeCustomerIds,
            { hints: runtime.inventoryHints },
          ),
        ),
      ]);
      const clean = remainingCustomers.length === 0 &&
        allCountsZero(inventory.counts);
      finalVerification[runtime.target.environment] = {
        clean,
        matchingStripeCustomers: remainingCustomers.length,
        database: inventory.counts,
      };
      if (!clean) verificationFailed = true;
    }

    console.log(JSON.stringify(buildResetReport({
      mode: "apply",
      runtimes,
      finalVerification,
    }), null, 2));
    if (verificationFailed) {
      throw new ResetCliError(
        "Post-reset verification found remaining state; inspect the report above.",
      );
    }
  } finally {
    await Promise.allSettled(runtimes.map((runtime) => runtime.pool.end()));
  }
}

async function createRuntime(target, environment) {
  const stripeKey = validateStripeKey(
    environment[target.stripeKeyEnvironmentVariable],
    target.environment,
  );
  const database = await resolveNeonDatabase(target);
  const [{ Pool }, { default: Stripe }] = await Promise.all([
    import("pg"),
    import("stripe"),
  ]);
  return {
    target,
    database,
    pool: new Pool({
      connectionString: database.connectionString,
      max: 1,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 10_000,
      statement_timeout: 30_000,
    }),
    stripe: new Stripe(stripeKey, {
      apiVersion: Stripe.API_VERSION,
      maxNetworkRetries: 2,
      timeout: 20_000,
    }),
    stripeIdentityCustomerIds: [],
    databaseLinkedCustomerIds: [],
    stripeCustomerIds: [],
    inventory: null,
  };
}

async function resolveNeonDatabase(target) {
  let stdout;
  try {
    ({ stdout } = await execFile(
      "npx",
      [
        "--yes",
        NEON_CLI_PACKAGE,
        "connection-string",
        "--project-id",
        target.neonProjectId,
        "--role-name",
        target.neonRole,
        "--database-name",
        target.neonDatabase,
        "--output",
        "json",
        "--no-color",
      ],
      {
        encoding: "utf8",
        env: buildNeonCliEnvironment(),
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      },
    ));
  } catch {
    throw new ResetCliError(
      `Could not resolve authenticated Neon project ${target.neonProjectId}. ` +
      `Run \`npx --yes ${NEON_CLI_PACKAGE} auth\` and retry.`,
    );
  }
  return verifyNeonConnectionString(
    extractNeonConnectionString(stdout),
    target,
  );
}

async function validateRuntime(runtime) {
  const [databaseResult, stripeAccount] = await Promise.all([
    runtime.pool.query(
      "select current_database() as database_name, current_user as role_name",
    ),
    runtime.stripe.accounts.retrieve(),
  ]);
  const databaseIdentity = databaseResult.rows[0];
  if (
    databaseIdentity?.database_name !== runtime.target.neonDatabase ||
    databaseIdentity?.role_name !== runtime.target.neonRole
  ) {
    throw new ResetCliError(
      `${runtime.target.environment} connected database identity mismatch.`,
    );
  }
  if (stripeAccount?.id !== runtime.target.stripeAccountId) {
    throw new ResetCliError(
      `${runtime.target.environment} Stripe account mismatch: expected ` +
      `${runtime.target.stripeAccountId}.`,
    );
  }
  if (
    runtime.target.environment === "production" &&
    stripeAccount?.charges_enabled !== true
  ) {
    throw new ResetCliError(
      "Production Stripe account is not the expected live charges-enabled account.",
    );
  }
}

async function deleteStripeCustomers(stripe, customerIds, databaseLinkedIds) {
  const deleted = [];
  for (const customerId of customerIds) {
    let customer;
    try {
      customer = await stripe.customers.retrieve(customerId);
    } catch (error) {
      if (isMissingStripeResource(error)) continue;
      throw error;
    }
    if (customer?.deleted) continue;
    if (
      !matchesTargetIdentity(customer) &&
      !databaseLinkedIds.has(customerId)
    ) {
      throw new ResetCliError(
        `Stripe customer ${customerId} no longer matches the fixed identity or database link.`,
      );
    }
    const result = await stripe.customers.del(customerId);
    if (result?.id !== customerId || result?.deleted !== true) {
      throw new ResetCliError(
        `Stripe did not confirm deletion of customer ${customerId}.`,
      );
    }
    deleted.push(customerId);
  }
  return deleted;
}

async function assertExpectedSchema(client, target) {
  const expectedTables = [...CORE_TABLES, target.requiredIdentityTable];
  const result = await client.query(
    `
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_name = any($1::text[])
    `,
    [expectedTables],
  );
  const found = new Set(result.rows.map((row) => row.table_name));
  const missing = expectedTables.filter((table) => !found.has(table));
  if (missing.length > 0) {
    throw new ResetCliError(
      `${target.environment} schema is missing required tables: ${missing.join(", ")}.`,
    );
  }
}

async function withReadOnlyTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query(
      "begin transaction isolation level repeatable read read only",
    );
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function deleteUuidRows(client, table, ids) {
  if (ids.length === 0) return 0;
  const result = await client.query(
    `delete from public.${table} where id = any($1::uuid[])`,
    [ids],
  );
  return result.rowCount || 0;
}

async function deleteAccountRows(client, table, accountIds) {
  if (accountIds.length === 0) return 0;
  const result = await client.query(
    `delete from public.${table} where account_id = any($1::uuid[])`,
    [accountIds],
  );
  return result.rowCount || 0;
}

async function deleteTextRows(client, table, column, ids) {
  if (ids.length === 0) return 0;
  const result = await client.query(
    `delete from public.${table} where ${column} = any($1::text[])`,
    [ids],
  );
  return result.rowCount || 0;
}

function uniqueStrings(values = []) {
  return [...new Set(
    values
      .filter((value) => value !== null && value !== undefined)
      .map((value) => String(value).trim())
      .filter(Boolean),
  )];
}

function uniqueStripeIds(values = [], prefix = "") {
  return uniqueStrings(values).filter((value) =>
    (!prefix || value.startsWith(prefix)) &&
    /^[a-z]+_[A-Za-z0-9_]+$/.test(value)
  );
}

function normalizeIdentityValue(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function configuredValue(value) {
  return typeof value === "string" &&
    Boolean(value.trim()) &&
    !value.includes("[YOUR-") &&
    value.trim() !== "changeme";
}

function readOption(argv, index, name) {
  const argument = argv[index];
  if (argument.startsWith(`${name}=`)) {
    const value = argument.slice(name.length + 1).trim();
    if (!value) throw new ResetCliError(`${name} requires a value.`);
    return [value, index];
  }
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new ResetCliError(`${name} requires a value.`);
  }
  return [value, index + 1];
}

function loadEnvFile(filePath, environment) {
  if (!filePath) return;
  const absolutePath = path.resolve(filePath);
  let contents;
  try {
    contents = fs.readFileSync(absolutePath, "utf8");
  } catch {
    throw new ResetCliError(
      `Could not read reset environment file ${absolutePath}.`,
    );
  }
  const parsed = parseResetEnvironmentFile(contents);
  for (const [key, value] of Object.entries(parsed)) {
    if (configuredValue(environment[key])) {
      throw new ResetCliError(
        `${key} is configured both in the process and reset environment file.`,
      );
    }
    environment[key] = value;
  }
}

function isMissingStripeResource(error) {
  return Boolean(
    error &&
    error.type === "StripeInvalidRequestError" &&
    (error.statusCode === 404 || /^No such /.test(error.message || "")),
  );
}

function addCounts(target, source) {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] || 0) + value;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function printHelp() {
  console.log(`Usage:
  npm run account:reset:alex
  npm run account:reset:alex -- --apply --confirm ${APPLY_CONFIRMATION}

Dry-run is the default. The command always targets only:
  Production Neon: dark-butterfly-59697025
  Test Neon:       ancient-breeze-53489732
  Live Stripe:     acct_1Tp340DFKjeGlioX
  Test Stripe:     acct_1TuyMKDNXvmQYu29

Required environment variables:
  SIDESTREAM_RESET_PRODUCTION_STRIPE_SECRET_KEY
  SIDESTREAM_RESET_TEST_STRIPE_SECRET_KEY

Optional:
  SIDESTREAM_RESET_ENV_FILE=<ignored env file containing the two keys>

The pinned authenticated Neon CLI supplies direct verify-full connections for
the two fixed projects. Run \`npx --yes ${NEON_CLI_PACKAGE} auth\` first if
necessary.`);
}

const entryUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error(error instanceof ResetCliError ? error.message : error);
    process.exitCode = 1;
  });
}

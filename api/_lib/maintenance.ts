import type { Pool, PoolClient } from "pg";
import { getPostgresPool } from "./postgres.js";

export const MAINTENANCE_LOCK_KEY = "sidestream:maintenance:v1";

export const MAINTENANCE_DEFAULTS = Object.freeze({
  batchSize: 100,
  licenseWriteThrottleSeconds: 3_600,
  legacyTokenRenewalThresholdDays: 30,
  webSessionGraceDays: 7,
  activationSessionGraceDays: 30,
  credentialAuditGraceDays: 30,
  rateLimitGraceHours: 24,
  checkoutIntentGraceDays: 7,
  stripePayloadRetentionDays: 14,
  stripeDeadLetterPayloadRetentionDays: 90,
});

const MAINTENANCE_BOUNDS = Object.freeze({
  batchSize: [1, 500],
  licenseWriteThrottleSeconds: [60, 86_400],
  legacyTokenRenewalThresholdDays: [1, 180],
  webSessionGraceDays: [1, 90],
  activationSessionGraceDays: [7, 365],
  credentialAuditGraceDays: [7, 365],
  rateLimitGraceHours: [1, 168],
  checkoutIntentGraceDays: [1, 90],
  stripePayloadRetentionDays: [1, 90],
  stripeDeadLetterPayloadRetentionDays: [14, 365],
} as const);

export type LicenseWriteConfiguration = Readonly<{
  licenseWriteThrottleSeconds: number;
  legacyTokenRenewalThresholdDays: number;
}>;

export type MaintenanceConfiguration = LicenseWriteConfiguration & Readonly<{
  batchSize: number;
  webSessionGraceDays: number;
  activationSessionGraceDays: number;
  credentialAuditGraceDays: number;
  rateLimitGraceHours: number;
  checkoutIntentGraceDays: number;
  stripePayloadRetentionDays: number;
  stripeDeadLetterPayloadRetentionDays: number;
}>;

export type MaintenanceCounts = Readonly<{
  credentialRowsDeleted: number;
  activationSessionsDeleted: number;
  webSessionsDeleted: number;
  rateLimitBucketsDeleted: number;
  checkoutIntentsDeleted: number;
  stripePayloadsRedacted: number;
}>;

export type MaintenanceSummary = Readonly<{
  outcome: "completed" | "locked";
  durationMs: number;
  batchSize: number;
  hasMore: boolean;
  counts: MaintenanceCounts;
}>;

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

type MaintenanceOptions = Readonly<{
  config?: MaintenanceConfiguration;
  environment?: RuntimeEnvironment;
  pool?: Pick<Pool, "connect">;
  referenceTime?: Date;
  clock?: () => number;
}>;

/**
 * Request-write defaults: one touch per hour and legacy renewal only in the
 * final 30 days. Environment overrides are bounded before any query executes.
 */
export function loadLicenseWriteConfiguration(
  environment: RuntimeEnvironment = process.env,
): LicenseWriteConfiguration {
  return Object.freeze({
    licenseWriteThrottleSeconds: readBoundedInteger(
      environment,
      "SIDESTREAM_LICENSE_WRITE_THROTTLE_SECONDS",
      MAINTENANCE_DEFAULTS.licenseWriteThrottleSeconds,
      ...MAINTENANCE_BOUNDS.licenseWriteThrottleSeconds,
    ),
    legacyTokenRenewalThresholdDays: readBoundedInteger(
      environment,
      "SIDESTREAM_LEGACY_TOKEN_RENEWAL_THRESHOLD_DAYS",
      MAINTENANCE_DEFAULTS.legacyTokenRenewalThresholdDays,
      ...MAINTENANCE_BOUNDS.legacyTokenRenewalThresholdDays,
    ),
  });
}

/**
 * Retention defaults are intentionally conservative: 7-day web/Checkout
 * grace, 30-day activation/credential audit grace, 24-hour rate-limit grace,
 * 14-day processed Stripe payload retention, and 90-day dead-letter retention.
 */
export function loadMaintenanceConfiguration(
  environment: RuntimeEnvironment = process.env,
): MaintenanceConfiguration {
  const writeConfiguration = loadLicenseWriteConfiguration(environment);
  const configuration = {
    ...writeConfiguration,
    batchSize: readBoundedInteger(
      environment,
      "SIDESTREAM_MAINTENANCE_BATCH_SIZE",
      MAINTENANCE_DEFAULTS.batchSize,
      ...MAINTENANCE_BOUNDS.batchSize,
    ),
    webSessionGraceDays: readBoundedInteger(
      environment,
      "SIDESTREAM_WEB_SESSION_GRACE_DAYS",
      MAINTENANCE_DEFAULTS.webSessionGraceDays,
      ...MAINTENANCE_BOUNDS.webSessionGraceDays,
    ),
    activationSessionGraceDays: readBoundedInteger(
      environment,
      "SIDESTREAM_ACTIVATION_SESSION_GRACE_DAYS",
      MAINTENANCE_DEFAULTS.activationSessionGraceDays,
      ...MAINTENANCE_BOUNDS.activationSessionGraceDays,
    ),
    credentialAuditGraceDays: readBoundedInteger(
      environment,
      "SIDESTREAM_CREDENTIAL_AUDIT_GRACE_DAYS",
      MAINTENANCE_DEFAULTS.credentialAuditGraceDays,
      ...MAINTENANCE_BOUNDS.credentialAuditGraceDays,
    ),
    rateLimitGraceHours: readBoundedInteger(
      environment,
      "SIDESTREAM_RATE_LIMIT_GRACE_HOURS",
      MAINTENANCE_DEFAULTS.rateLimitGraceHours,
      ...MAINTENANCE_BOUNDS.rateLimitGraceHours,
    ),
    checkoutIntentGraceDays: readBoundedInteger(
      environment,
      "SIDESTREAM_CHECKOUT_INTENT_GRACE_DAYS",
      MAINTENANCE_DEFAULTS.checkoutIntentGraceDays,
      ...MAINTENANCE_BOUNDS.checkoutIntentGraceDays,
    ),
    stripePayloadRetentionDays: readBoundedInteger(
      environment,
      "SIDESTREAM_STRIPE_PAYLOAD_RETENTION_DAYS",
      MAINTENANCE_DEFAULTS.stripePayloadRetentionDays,
      ...MAINTENANCE_BOUNDS.stripePayloadRetentionDays,
    ),
    stripeDeadLetterPayloadRetentionDays: readBoundedInteger(
      environment,
      "SIDESTREAM_STRIPE_DEAD_LETTER_PAYLOAD_RETENTION_DAYS",
      MAINTENANCE_DEFAULTS.stripeDeadLetterPayloadRetentionDays,
      ...MAINTENANCE_BOUNDS.stripeDeadLetterPayloadRetentionDays,
    ),
  };
  if (
    configuration.stripeDeadLetterPayloadRetentionDays <
      configuration.stripePayloadRetentionDays
  ) {
    throw new Error(
      "SIDESTREAM_STRIPE_DEAD_LETTER_PAYLOAD_RETENTION_DAYS must be at least SIDESTREAM_STRIPE_PAYLOAD_RETENTION_DAYS",
    );
  }
  return Object.freeze(configuration);
}

export async function runMaintenanceJob(
  options: MaintenanceOptions = {},
): Promise<MaintenanceSummary> {
  const config = options.config || loadMaintenanceConfiguration(options.environment);
  validateMaintenanceConfiguration(config);
  const referenceTime = options.referenceTime || new Date();
  if (!Number.isFinite(referenceTime.getTime())) {
    throw new TypeError("Maintenance reference time must be a valid Date");
  }
  const clock = options.clock || Date.now;
  const startedAt = clock();
  const pool = options.pool || getPostgresPool();
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("begin");
    transactionOpen = true;
    const lock = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_xact_lock(hashtext($1)) as locked",
      [MAINTENANCE_LOCK_KEY],
    );
    if (!lock.rows[0]?.locked) {
      await client.query("commit");
      transactionOpen = false;
      return maintenanceSummary("locked", startedAt, clock, config.batchSize, emptyCounts());
    }

    const referenceIso = referenceTime.toISOString();
    const credentialRowsDeleted = await runBoundedMutation(
      client,
      `
        with candidates as materialized (
          select token.id
          from public.sidestream_license_tokens as token
          where (
            token.revoked_at <= $1::timestamptz - ($2::bigint * interval '1 day')
            or (
              token.revoked_at is null
              and token.expires_at <= $1::timestamptz
              and (
                token.refresh_token_hash is null
                or token.refresh_expires_at <= $1::timestamptz
              )
              and (
                token.previous_refresh_token_hash is null
                or token.previous_refresh_valid_until <= $1::timestamptz
              )
              and greatest(
                token.expires_at,
                coalesce(token.refresh_expires_at, token.expires_at),
                coalesce(token.previous_refresh_valid_until, token.expires_at)
              ) <= $1::timestamptz - ($2::bigint * interval '1 day')
            )
          )
          order by
            coalesce(
              token.revoked_at,
              greatest(
                token.expires_at,
                coalesce(token.refresh_expires_at, token.expires_at),
                coalesce(token.previous_refresh_valid_until, token.expires_at)
              )
            ),
            token.id
          limit $3
          for update skip locked
        )
        delete from public.sidestream_license_tokens as token
        using candidates
        where token.id = candidates.id
        returning token.id
      `,
      [referenceIso, config.credentialAuditGraceDays, config.batchSize],
    );

    const activationSessionsDeleted = await runBoundedMutation(
      client,
      `
        with candidates as materialized (
          select activation.id
          from public.sidestream_activation_sessions as activation
          where activation.expires_at <=
              $1::timestamptz - ($2::bigint * interval '1 day')
            and (
              activation.status in ('expired', 'linked', 'restored', 'paid')
              or activation.completed_at is not null
              or activation.expires_at <= $1::timestamptz
            )
            and not exists (
              select 1
              from public.sidestream_license_tokens as token
              where token.activation_session_id = activation.id
            )
            and not exists (
              select 1
              from public.sidestream_checkout_intents as intent
              where intent.activation_session_id = activation.id
            )
          order by activation.expires_at, activation.id
          limit $3
          for update skip locked
        )
        delete from public.sidestream_activation_sessions as activation
        using candidates
        where activation.id = candidates.id
        returning activation.id
      `,
      [referenceIso, config.activationSessionGraceDays, config.batchSize],
    );

    const webSessionsDeleted = await runBoundedMutation(
      client,
      `
        with candidates as materialized (
          select session.id
          from public.sidestream_account_sessions as session
          where greatest(
              session.expires_at,
              coalesce(session.revoked_at, session.expires_at)
            ) <= $1::timestamptz - ($2::bigint * interval '1 day')
          order by session.expires_at, session.id
          limit $3
          for update skip locked
        )
        delete from public.sidestream_account_sessions as session
        using candidates
        where session.id = candidates.id
        returning session.id
      `,
      [referenceIso, config.webSessionGraceDays, config.batchSize],
    );

    const rateLimitBucketsDeleted = await runBoundedMutation(
      client,
      `
        with candidates as materialized (
          select rate.scope, rate.dimension_hash,
            rate.window_started_at, rate.window_seconds
          from public.sidestream_api_rate_limits as rate
          where rate.expires_at <=
            $1::timestamptz - ($2::bigint * interval '1 hour')
          order by rate.expires_at, rate.scope, rate.dimension_hash,
            rate.window_started_at, rate.window_seconds
          limit $3
          for update skip locked
        )
        delete from public.sidestream_api_rate_limits as rate
        using candidates
        where rate.scope = candidates.scope
          and rate.dimension_hash = candidates.dimension_hash
          and rate.window_started_at = candidates.window_started_at
          and rate.window_seconds = candidates.window_seconds
        returning rate.scope
      `,
      [referenceIso, config.rateLimitGraceHours, config.batchSize],
    );

    const checkoutIntentsDeleted = await runBoundedMutation(
      client,
      `
        with candidates as materialized (
          select intent.id
          from public.sidestream_checkout_intents as intent
          where intent.expires_at <=
            $1::timestamptz - ($2::bigint * interval '1 day')
            and intent.upgrade_pricing_snapshot_version is null
          order by intent.expires_at, intent.id
          limit $3
          for update skip locked
        )
        delete from public.sidestream_checkout_intents as intent
        using candidates
        where intent.id = candidates.id
        returning intent.id
      `,
      [referenceIso, config.checkoutIntentGraceDays, config.batchSize],
    );

    const stripePayloadsRedacted = await runBoundedMutation(
      client,
      `
        with candidates as materialized (
          select event.event_id
          from public.sidestream_stripe_events as event
          where event.payload_redacted_at is null
            and (
              (
                event.processing_status in ('processed', 'ignored')
                and event.terminal_at <=
                  $1::timestamptz - ($2::bigint * interval '1 day')
              )
              or (
                event.processing_status = 'dead_letter'
                and event.terminal_at <=
                  $1::timestamptz - ($3::bigint * interval '1 day')
              )
            )
          order by event.terminal_at, event.event_id
          limit $4
          for update skip locked
        )
        update public.sidestream_stripe_events as event
        set raw_payload = null,
            payload = jsonb_strip_nulls(jsonb_build_object(
              'redacted', true,
              'id', event.event_id,
              'object', 'event',
              'type', event.event_type,
              'created', extract(epoch from event.stripe_created_at)::bigint,
              'livemode', event.payload -> 'livemode',
              'data', jsonb_build_object(
                'object', jsonb_strip_nulls(jsonb_build_object(
                  'id', event.payload #> '{data,object,id}',
                  'object', event.payload #> '{data,object,object}',
                  'customer', case
                    when jsonb_typeof(event.payload #> '{data,object,customer}') = 'string'
                      then event.payload #> '{data,object,customer}'
                    else event.payload #> '{data,object,customer,id}'
                  end,
                  'payment_intent', case
                    when jsonb_typeof(event.payload #> '{data,object,payment_intent}') = 'string'
                      then event.payload #> '{data,object,payment_intent}'
                    else event.payload #> '{data,object,payment_intent,id}'
                  end,
                  'charge', case
                    when jsonb_typeof(event.payload #> '{data,object,charge}') = 'string'
                      then event.payload #> '{data,object,charge}'
                    else event.payload #> '{data,object,charge,id}'
                  end,
                  'subscription', case
                    when jsonb_typeof(event.payload #> '{data,object,subscription}') = 'string'
                      then event.payload #> '{data,object,subscription}'
                    else event.payload #> '{data,object,subscription,id}'
                  end,
                  'invoice', case
                    when jsonb_typeof(event.payload #> '{data,object,invoice}') = 'string'
                      then event.payload #> '{data,object,invoice}'
                    else event.payload #> '{data,object,invoice,id}'
                  end,
                  'amount', event.payload #> '{data,object,amount}',
                  'amount_paid', event.payload #> '{data,object,amount_paid}',
                  'amount_refunded', event.payload #> '{data,object,amount_refunded}',
                  'currency', event.payload #> '{data,object,currency}',
                  'payment_status', event.payload #> '{data,object,payment_status}',
                  'status', event.payload #> '{data,object,status}',
                  'disputed', event.payload #> '{data,object,disputed}'
                ))
              )
            )),
            payload_redacted_at = $1::timestamptz,
            updated_at = $1::timestamptz
        from candidates
        where event.event_id = candidates.event_id
        returning event.event_id
      `,
      [
        referenceIso,
        config.stripePayloadRetentionDays,
        config.stripeDeadLetterPayloadRetentionDays,
        config.batchSize,
      ],
    );

    const counts = Object.freeze({
      credentialRowsDeleted,
      activationSessionsDeleted,
      webSessionsDeleted,
      rateLimitBucketsDeleted,
      checkoutIntentsDeleted,
      stripePayloadsRedacted,
    });
    await client.query("commit");
    transactionOpen = false;
    return maintenanceSummary("completed", startedAt, clock, config.batchSize, counts);
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("rollback");
      } catch {
        // Preserve the maintenance failure rather than a rollback error.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

function validateMaintenanceConfiguration(config: MaintenanceConfiguration) {
  const expected = loadMaintenanceConfiguration(configurationToEnvironment(config));
  for (const [name, value] of Object.entries(expected)) {
    if (config[name as keyof MaintenanceConfiguration] !== value) {
      throw new TypeError(`Invalid maintenance configuration field: ${name}`);
    }
  }
}

function configurationToEnvironment(config: MaintenanceConfiguration) {
  return {
    SIDESTREAM_MAINTENANCE_BATCH_SIZE: String(config.batchSize),
    SIDESTREAM_LICENSE_WRITE_THROTTLE_SECONDS: String(
      config.licenseWriteThrottleSeconds,
    ),
    SIDESTREAM_LEGACY_TOKEN_RENEWAL_THRESHOLD_DAYS: String(
      config.legacyTokenRenewalThresholdDays,
    ),
    SIDESTREAM_WEB_SESSION_GRACE_DAYS: String(config.webSessionGraceDays),
    SIDESTREAM_ACTIVATION_SESSION_GRACE_DAYS: String(
      config.activationSessionGraceDays,
    ),
    SIDESTREAM_CREDENTIAL_AUDIT_GRACE_DAYS: String(
      config.credentialAuditGraceDays,
    ),
    SIDESTREAM_RATE_LIMIT_GRACE_HOURS: String(config.rateLimitGraceHours),
    SIDESTREAM_CHECKOUT_INTENT_GRACE_DAYS: String(config.checkoutIntentGraceDays),
    SIDESTREAM_STRIPE_PAYLOAD_RETENTION_DAYS: String(
      config.stripePayloadRetentionDays,
    ),
    SIDESTREAM_STRIPE_DEAD_LETTER_PAYLOAD_RETENTION_DAYS: String(
      config.stripeDeadLetterPayloadRetentionDays,
    ),
  };
}

async function runBoundedMutation(
  client: Pick<PoolClient, "query">,
  text: string,
  parameters: readonly unknown[],
) {
  const result = await client.query(text, [...parameters]);
  return result.rows.length;
}

function maintenanceSummary(
  outcome: MaintenanceSummary["outcome"],
  startedAt: number,
  clock: () => number,
  batchSize: number,
  counts: MaintenanceCounts,
): MaintenanceSummary {
  return Object.freeze({
    outcome,
    durationMs: Math.max(0, Math.round(clock() - startedAt)),
    batchSize,
    hasMore: Object.values(counts).some((count) => count === batchSize),
    counts,
  });
}

function emptyCounts(): MaintenanceCounts {
  return Object.freeze({
    credentialRowsDeleted: 0,
    activationSessionsDeleted: 0,
    webSessionsDeleted: 0,
    rateLimitBucketsDeleted: 0,
    checkoutIntentsDeleted: 0,
    stripePayloadsRedacted: 0,
  });
}

function readBoundedInteger(
  environment: RuntimeEnvironment,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
) {
  const rawValue = environment[name]?.trim();
  if (!rawValue) return defaultValue;
  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

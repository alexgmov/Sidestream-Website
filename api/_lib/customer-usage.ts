/** Server-only, low-egress Customer 360 usage aggregate sync. */
import { Pool, type PoolClient, type QueryResult } from "pg";
import {
  getPostgresPool,
  RUNTIME_POSTGRES_URL_ENV_NAMES,
} from "./postgres.js";

export const CUSTOMER_USAGE_SOURCE_TABLE = "sidestream_telemetry_events";
export const CUSTOMER_USAGE_SCHEMA_VERSIONS = Object.freeze(["0.2.0"]);
export const CUSTOMER_USAGE_OVERLAP_MS = 48 * 60 * 60 * 1_000;
export const CUSTOMER_USAGE_BATCH_SIZE = 250;

// Only these schema-versioned scalar paths may leave the telemetry query. The
// query below projects them into explicit aggregate columns and never returns
// either JSON object itself.
export const CUSTOMER_USAGE_JSON_PATH_ALLOWLIST = Object.freeze({
  "0.2.0": Object.freeze([
    "payload.download_id",
    "payload.speculative_download_id",
    "payload.download_trigger",
    "payload.interaction_trigger",
    "payload.file_delivered",
    "payload.user_outcome",
    "payload.failure_stage",
    "payload.failure_phase",
    "payload.import_result",
    "payload.gmail_campaign_hash",
    "data_points.details.downloadId",
    "data_points.details.download_id",
    "data_points.details.speculativeDownloadId",
    "data_points.details.speculative_download_id",
    "data_points.details.downloadTrigger",
    "data_points.details.download_trigger",
    "data_points.details.interactionTrigger",
    "data_points.details.interaction_trigger",
    "data_points.details.fileDelivered",
    "data_points.details.file_delivered",
    "data_points.details.userOutcome",
    "data_points.details.user_outcome",
    "data_points.details.failureStage",
    "data_points.details.failure_stage",
    "data_points.details.failurePhase",
    "data_points.details.failure_phase",
    "data_points.details.importResult",
    "data_points.details.import_result",
    "data_points.runtime.osPlatform",
    "data_points.runtime.os_platform",
  ]),
});

type LicenseNamespace = "production" | "test";
type Environment = Readonly<Record<string, string | undefined>>;
type QueryRow = Record<string, unknown>;
type QueryRunner = Readonly<{
  query: (
    text: string,
    params?: readonly unknown[],
  ) => Promise<QueryResult<QueryRow>>;
}>;
type ConnectableQueryRunner = QueryRunner & Readonly<{
  connect: () => Promise<PoolClient>;
}>;

export type CustomerUsageHighWater = Readonly<{
  receivedAt: Date;
  telemetryEventId: string;
}>;

export type CustomerUsageDailyAggregate = Readonly<{
  installIdHash: string;
  activityDay: string;
  firstAppUseAt: Date | null;
  lastAppUseAt: Date | null;
  firstDownloadAttemptAt: Date | null;
  lastDownloadAttemptAt: Date | null;
  firstDownloadSuccessAt: Date | null;
  lastDownloadSuccessAt: Date | null;
  activeEventCount: number;
  downloadAttemptCount: number;
  downloadOutcomeCount: number;
  downloadSuccessCount: number;
  downloadFailureCount: number;
  downloadCancelledCount: number;
  downloadPendingCount: number;
  downloadUnknownCount: number;
  platform: "macos" | "windows" | "unknown" | null;
  appVersion: string | null;
  gmailCampaignHashes: readonly string[];
}>;

export type CustomerUsageSyncSummary = Readonly<{
  outcome: "completed" | "skipped" | "locked";
  licenseNamespace: LicenseNamespace;
  batches: number;
  sourceRowsScanned: number;
  dailyBucketsWritten: number;
  profilesRefreshed: number;
  sourceFreshnessAt: string | null;
}>;

export type CustomerUsageSyncConfiguration = Readonly<{
  telemetryConnectionString: string;
  licenseNamespace: LicenseNamespace;
  overlapMs: number;
  batchSize: number;
}>;

export type CustomerUsageSyncOptions = Readonly<{
  targetPool?: ConnectableQueryRunner;
  telemetryPool?: QueryRunner;
  targetSchema?: string;
  telemetrySchema?: string;
  licenseNamespace?: LicenseNamespace;
  overlapMs?: number;
  batchSize?: number;
  now?: Date;
  environment?: Environment;
  afterBatchCommitted?: (details: Readonly<{
    batch: number;
    checkpoint: CustomerUsageHighWater;
  }>) => void | Promise<void>;
}>;

let telemetryPool: Pool | null = null;
let telemetryPoolIdentity = "";

export function loadCustomerUsageSyncConfiguration(
  environment: Environment = process.env,
): CustomerUsageSyncConfiguration {
  const telemetryConnectionString = configuredValue(
    environment.SIDESTREAM_TELEMETRY_POSTGRES_URL,
  );
  if (!telemetryConnectionString) {
    throw new Error("SIDESTREAM_TELEMETRY_POSTGRES_URL is not configured");
  }
  const telemetryIdentity = databaseIdentity(
    telemetryConnectionString,
    "SIDESTREAM_TELEMETRY_POSTGRES_URL",
  );
  for (const name of RUNTIME_POSTGRES_URL_ENV_NAMES) {
    const runtimeValue = configuredValue(environment[name]);
    if (!runtimeValue) continue;
    if (databaseIdentity(runtimeValue, name) === telemetryIdentity) {
      throw new Error(`Telemetry database must be separate from runtime database ${name}`);
    }
  }

  return {
    telemetryConnectionString,
    licenseNamespace: resolveUsageNamespace(environment),
    overlapMs: readBoundedInteger(
      environment.SIDESTREAM_CUSTOMER_USAGE_OVERLAP_HOURS,
      CUSTOMER_USAGE_OVERLAP_MS / 3_600_000,
      24,
      168,
    ) * 3_600_000,
    batchSize: readBoundedInteger(
      environment.SIDESTREAM_CUSTOMER_USAGE_BATCH_SIZE,
      CUSTOMER_USAGE_BATCH_SIZE,
      25,
      1_000,
    ),
  };
}

export function buildTelemetryPoolOptions(connectionString: string) {
  const url = parsePostgresUrl(connectionString, "SIDESTREAM_TELEMETRY_POSTGRES_URL");
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
  const sslDisabled = /sslmode=(?:disable|false)/i.test(connectionString);
  if (/^(prefer|require)$/i.test(url.searchParams.get("sslmode") || "")) {
    url.searchParams.delete("sslmode");
  }
  return {
    connectionString: url.toString(),
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
    options: "-c default_transaction_read_only=on",
    ssl: local || sslDisabled ? false : { rejectUnauthorized: false },
  };
}

export function getCustomerUsageTelemetryPool(connectionString: string) {
  const normalized = parsePostgresUrl(
    connectionString,
    "SIDESTREAM_TELEMETRY_POSTGRES_URL",
  ).toString();
  if (telemetryPool) {
    if (telemetryPoolIdentity !== normalized) {
      throw new Error("Telemetry pool is already attached to a different database target");
    }
    return telemetryPool;
  }
  telemetryPool = new Pool(buildTelemetryPoolOptions(connectionString));
  telemetryPoolIdentity = normalized;
  telemetryPool.on("error", (error) => {
    console.error("Sidestream telemetry read pool error", safePostgresErrorCode(error));
  });
  return telemetryPool;
}

export function compareCustomerUsageHighWater(
  left: CustomerUsageHighWater,
  right: CustomerUsageHighWater,
) {
  const timestampDifference = left.receivedAt.getTime() - right.receivedAt.getTime();
  if (timestampDifference !== 0) return timestampDifference < 0 ? -1 : 1;
  return left.telemetryEventId.localeCompare(right.telemetryEventId);
}

export function utcUsageWindow(referenceTime: Date) {
  const today = referenceTime.toISOString().slice(0, 10);
  return Object.freeze({
    today,
    sevenDayStart: addUtcDays(today, -6),
    thirtyDayStart: addUtcDays(today, -29),
  });
}

export function resolveDownloadOutcome(input: Readonly<{
  hasFinalization?: boolean;
  fileDelivered?: boolean | null;
  userOutcome?: string | null;
  failureStage?: string | null;
  importResult?: string | null;
  legacyCompleted?: boolean;
  legacyFailed?: boolean;
  legacyCancelled?: boolean;
  legacyImportFailed?: boolean;
}>): "success" | "failure" | "cancelled" | "pending" | null {
  const userOutcome = normalizedToken(input.userOutcome);
  const failureStage = normalizedToken(input.failureStage);
  const importResult = normalizedToken(input.importResult);
  if (input.hasFinalization) {
    if (userOutcome === "cancelled") return "cancelled";
    if (
      input.fileDelivered === true &&
      (importResult === "failed" || failureStage === "import" ||
        failureStage === "premiere_import" || userOutcome === "got_file_import_failed")
    ) {
      return "failure";
    }
    if (input.fileDelivered === true) return "success";
    if (
      input.fileDelivered === false ||
      Boolean(failureStage) ||
      ["failed", "download_failed", "got_file_download_failed"].includes(userOutcome)
    ) {
      return "failure";
    }
    return null;
  }
  if (input.legacyImportFailed) return "failure";
  if (input.legacyCompleted) return "success";
  if (input.legacyCancelled) return "cancelled";
  if (input.legacyFailed) return "failure";
  return "pending";
}

export function normalizeCustomerUsageAggregateRow(
  row: QueryRow,
): CustomerUsageDailyAggregate {
  const installIdHash = requiredString(row.install_id_hash, "install_id_hash", 64);
  if (!/^[0-9a-f]{64}$/.test(installIdHash)) {
    throw new Error("Telemetry aggregate install hash is invalid");
  }
  const activityDay = requiredString(row.activity_day, "activity_day", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(activityDay)) {
    throw new Error("Telemetry aggregate activity day is invalid");
  }
  const platform = optionalString(row.platform, 16);
  if (platform !== null && !["macos", "windows", "unknown"].includes(platform)) {
    throw new Error("Telemetry aggregate platform is invalid");
  }
  const gmailCampaignHashes = Array.isArray(row.gmail_campaign_hashes)
    ? row.gmail_campaign_hashes.map((value) => requiredString(value, "gmail campaign hash", 64))
    : [];
  if (gmailCampaignHashes.some((value) => !/^[0-9a-f]{64}$/.test(value))) {
    throw new Error("Telemetry aggregate Gmail campaign hash is invalid");
  }

  const result: CustomerUsageDailyAggregate = {
    installIdHash,
    activityDay,
    firstAppUseAt: optionalDate(row.first_app_use_at),
    lastAppUseAt: optionalDate(row.last_app_use_at),
    firstDownloadAttemptAt: optionalDate(row.first_download_attempt_at),
    lastDownloadAttemptAt: optionalDate(row.last_download_attempt_at),
    firstDownloadSuccessAt: optionalDate(row.first_download_success_at),
    lastDownloadSuccessAt: optionalDate(row.last_download_success_at),
    activeEventCount: nonnegativeInteger(row.active_event_count, "active_event_count"),
    downloadAttemptCount: nonnegativeInteger(
      row.download_attempt_count,
      "download_attempt_count",
    ),
    downloadOutcomeCount: nonnegativeInteger(
      row.download_outcome_count,
      "download_outcome_count",
    ),
    downloadSuccessCount: nonnegativeInteger(
      row.download_success_count,
      "download_success_count",
    ),
    downloadFailureCount: nonnegativeInteger(
      row.download_failure_count,
      "download_failure_count",
    ),
    downloadCancelledCount: nonnegativeInteger(
      row.download_cancelled_count,
      "download_cancelled_count",
    ),
    downloadPendingCount: nonnegativeInteger(
      row.download_pending_count,
      "download_pending_count",
    ),
    downloadUnknownCount: nonnegativeInteger(
      row.download_unknown_count,
      "download_unknown_count",
    ),
    platform: platform as CustomerUsageDailyAggregate["platform"],
    appVersion: optionalString(row.app_version, 64),
    gmailCampaignHashes: Object.freeze([...new Set(gmailCampaignHashes)].sort()),
  };
  if (
    result.downloadOutcomeCount !== result.downloadSuccessCount +
      result.downloadFailureCount + result.downloadCancelledCount ||
    result.downloadAttemptCount !== result.downloadOutcomeCount +
      result.downloadPendingCount + result.downloadUnknownCount
  ) {
    throw new Error("Telemetry aggregate outcome counts do not reconcile");
  }
  return Object.freeze(result);
}

export async function runCustomerUsageSync(
  options: CustomerUsageSyncOptions = {},
): Promise<CustomerUsageSyncSummary> {
  const environment = options.environment || process.env;
  const configuration = options.targetPool && options.telemetryPool && options.licenseNamespace
    ? {
        licenseNamespace: options.licenseNamespace,
        overlapMs: options.overlapMs ?? CUSTOMER_USAGE_OVERLAP_MS,
        batchSize: options.batchSize ?? CUSTOMER_USAGE_BATCH_SIZE,
      }
    : loadCustomerUsageSyncConfiguration(environment);
  const targetPool = options.targetPool || getPostgresPool();
  const sourcePool = options.telemetryPool || getCustomerUsageTelemetryPool(
    (configuration as CustomerUsageSyncConfiguration).telemetryConnectionString,
  );
  const targetSchema = validatedIdentifier(options.targetSchema || "public", "target schema");
  const sourceSchema = validatedIdentifier(
    options.telemetrySchema || "public",
    "telemetry schema",
  );
  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError("Sync time is invalid");
  const overlapMs = boundedNumber(configuration.overlapMs, 3_600_000, 7 * 86_400_000);
  const batchSize = Math.trunc(boundedNumber(configuration.batchSize, 1, 1_000));
  const licenseNamespace = configuration.licenseNamespace;
  const targetClient = await targetPool.connect();
  let locked = false;

  try {
    const lock = await targetClient.query(
      "select pg_try_advisory_lock(hashtext($1)) as locked",
      [`sidestream_customer_usage_sync:${licenseNamespace}`],
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked) return emptySummary("locked", licenseNamespace);

    const start = await beginCustomerUsageRun(
      targetClient,
      targetSchema,
      licenseNamespace,
      now,
    );
    if (start.skipped) {
      return {
        ...emptySummary("skipped", licenseNamespace),
        sourceFreshnessAt: start.sourceFreshnessAt,
      };
    }

    const checkpoint = start.checkpoint;
    const lowerReceivedAt = new Date(
      (checkpoint?.receivedAt.getTime() ?? now.getTime()) - overlapMs,
    );
    const upper = await readSourceUpperHighWater(
      sourcePool,
      sourceSchema,
      licenseNamespace,
      lowerReceivedAt,
    );
    let cursor: CustomerUsageHighWater = {
      receivedAt: lowerReceivedAt,
      telemetryEventId: "",
    };
    let batches = 0;
    let sourceRowsScanned = 0;
    let dailyBucketsWritten = 0;

    if (upper) {
      while (compareCustomerUsageHighWater(cursor, upper) < 0) {
        const sourceBatch = await readSourceBatch(
          sourcePool,
          sourceSchema,
          licenseNamespace,
          cursor,
          upper,
          batchSize,
        );
        if (sourceBatch.length === 0) break;
        const batchCheckpoint = sourceBatch[sourceBatch.length - 1].highWater;
        const touched = uniqueTouchedDays(sourceBatch);
        const aggregates = await readSourceDailyAggregates(
          sourcePool,
          sourceSchema,
          licenseNamespace,
          touched,
          upper,
        );
        let written = 0;
        await runClientTransaction(targetClient, async () => {
          for (const aggregate of aggregates) {
            written += await upsertDailyAggregate(
              targetClient,
              targetSchema,
              licenseNamespace,
              aggregate,
              batchCheckpoint,
              now,
            );
          }
          await commitCustomerUsageCheckpoint(
            targetClient,
            targetSchema,
            licenseNamespace,
            batchCheckpoint,
            upper.receivedAt,
            now,
          );
        });
        batches += 1;
        sourceRowsScanned += sourceBatch.length;
        dailyBucketsWritten += written;
        cursor = batchCheckpoint;
        await options.afterBatchCommitted?.({ batch: batches, checkpoint: batchCheckpoint });
      }
    }

    let profilesRefreshed = 0;
    await runClientTransaction(targetClient, async () => {
      profilesRefreshed = await materializeCustomerUsageProfiles({
        query: targetClient.query.bind(targetClient),
        targetSchema,
        licenseNamespace,
        now,
        sourceFreshnessAt: upper?.receivedAt || start.sourceFreshnessDate,
      });
      await completeCustomerUsageRun(
        targetClient,
        targetSchema,
        licenseNamespace,
        upper,
        now,
      );
    });

    return {
      outcome: "completed",
      licenseNamespace,
      batches,
      sourceRowsScanned,
      dailyBucketsWritten,
      profilesRefreshed,
      sourceFreshnessAt: (upper?.receivedAt || start.sourceFreshnessDate)?.toISOString() || null,
    };
  } finally {
    if (locked) {
      await targetClient.query("select pg_advisory_unlock(hashtext($1))", [
        `sidestream_customer_usage_sync:${configuration.licenseNamespace}`,
      ]).catch(() => {});
    }
    targetClient.release();
  }
}

export async function materializeCustomerUsageProfiles(options: Readonly<{
  query: QueryRunner["query"];
  targetSchema?: string;
  licenseNamespace: LicenseNamespace;
  now: Date;
  sourceFreshnessAt?: Date | null;
}>) {
  const schema = validatedIdentifier(options.targetSchema || "public", "target schema");
  const window = utcUsageWindow(options.now);
  const result = await options.query(
    `with install_counts as (
       select profile_id, count(*)::bigint as install_count
       from ${schema}.sidestream_customer_installs
       where license_namespace = $1
       group by profile_id
     ), profile_days as (
       select
         install.profile_id,
         day.activity_day,
         min(day.first_app_use_at) as first_app_use_at,
         max(day.last_app_use_at) as last_app_use_at,
         min(day.first_download_attempt_at) as first_download_attempt_at,
         max(day.last_download_attempt_at) as last_download_attempt_at,
         min(day.first_download_success_at) as first_download_success_at,
         max(day.last_download_success_at) as last_download_success_at,
         sum(day.active_event_count)::bigint as active_event_count,
         sum(day.download_attempt_count)::bigint as download_attempt_count,
         sum(day.download_outcome_count)::bigint as download_outcome_count,
         sum(day.download_success_count)::bigint as download_success_count,
         sum(day.download_failure_count)::bigint as download_failure_count,
         sum(day.download_cancelled_count)::bigint as download_cancelled_count,
         sum(day.download_pending_count)::bigint as download_pending_count,
         sum(day.download_unknown_count)::bigint as download_unknown_count
       from ${schema}.sidestream_customer_installs install
       join ${schema}.sidestream_customer_usage_daily day
         on day.license_namespace = install.license_namespace
        and day.install_id_hash = install.install_id_hash
       where install.license_namespace = $1
       group by install.profile_id, day.activity_day
     ), usage as (
       select
         profile_id,
         min(day.first_app_use_at) as first_app_use_at,
         max(day.last_app_use_at) as last_app_use_at,
         min(day.first_download_attempt_at) as first_download_attempt_at,
         max(day.last_download_attempt_at) as last_download_attempt_at,
         min(day.first_download_success_at) as first_download_success_at,
         max(day.last_download_success_at) as last_download_success_at,
         sum(day.download_attempt_count)::bigint as download_attempt_count,
         sum(day.download_outcome_count)::bigint as download_outcome_count,
         sum(day.download_success_count)::bigint as download_success_count,
         sum(day.download_failure_count)::bigint as download_failure_count,
         sum(day.download_cancelled_count)::bigint as download_cancelled_count,
         sum(day.download_pending_count)::bigint as download_pending_count,
         sum(day.download_unknown_count)::bigint as download_unknown_count,
         count(*) filter (where day.active_event_count > 0)::bigint as active_days_count,
         count(*) filter (
           where day.active_event_count > 0 and day.activity_day between $2::date and $3::date
         )::bigint as active_days_7,
         count(*) filter (
           where day.active_event_count > 0 and day.activity_day between $4::date and $3::date
         )::bigint as active_days_30,
         sum(day.download_attempt_count) filter (
           where day.activity_day between $4::date and $3::date
         )::bigint as download_attempts_30
       from profile_days day
       group by profile_id
     ), latest as (
       select distinct on (install.profile_id)
         install.profile_id,
         day.platform,
         day.app_version
       from ${schema}.sidestream_customer_installs install
       join ${schema}.sidestream_customer_usage_daily day
         on day.license_namespace = install.license_namespace
        and day.install_id_hash = install.install_id_hash
       where install.license_namespace = $1
         and day.last_app_use_at is not null
       order by install.profile_id, day.last_app_use_at desc, day.activity_day desc,
         day.install_id_hash
     ), materialized as (
       select
         profile.id,
         coalesce(installs.install_count, 0) as install_count,
         usage.*,
         latest.platform,
         latest.app_version
       from ${schema}.sidestream_customer_profiles profile
       left join install_counts installs on installs.profile_id = profile.id
       left join usage on usage.profile_id = profile.id
       left join latest on latest.profile_id = profile.id
       where profile.license_namespace = $1 and profile.merged_into is null
     )
     update ${schema}.sidestream_customer_profiles profile
     set first_app_use_at = value.first_app_use_at,
         last_app_use_at = value.last_app_use_at,
         first_seen_at = value.first_app_use_at,
         last_activity_at = value.last_app_use_at,
         first_download_attempt_at = value.first_download_attempt_at,
         last_download_attempt_at = value.last_download_attempt_at,
         first_download_success_at = value.first_download_success_at,
         last_download_success_at = value.last_download_success_at,
         download_attempt_count = value.download_attempt_count,
         download_outcome_count = value.download_outcome_count,
         download_success_count = value.download_success_count,
         download_failure_count = value.download_failure_count,
         download_cancelled_count = value.download_cancelled_count,
         download_pending_count = value.download_pending_count,
         download_unknown_count = value.download_unknown_count,
         usage_active_days_count = value.active_days_count,
         usage_active_days_7 = value.active_days_7,
         usage_active_days_30 = value.active_days_30,
         download_frequency_30d = case
           when value.active_days_30 > 0
             then round(value.download_attempts_30::numeric / value.active_days_30, 6)
           else null
         end,
         usage_install_count = value.install_count,
         platform_summary = value.platform,
         app_version_summary = value.app_version,
         usage_synced_at = $5,
         usage_source_freshness_at = $6,
         updated_at = $5
     from materialized value
     where profile.id = value.id and profile.license_namespace = $1`,
    [
      options.licenseNamespace,
      window.sevenDayStart,
      window.today,
      window.thirtyDayStart,
      options.now,
      options.sourceFreshnessAt || null,
    ],
  );
  return result.rowCount || 0;
}

async function beginCustomerUsageRun(
  client: PoolClient,
  schema: string,
  licenseNamespace: LicenseNamespace,
  now: Date,
) {
  return runClientTransaction(client, async () => {
    await client.query(
      `insert into ${schema}.sidestream_customer_usage_sync_state (license_namespace)
       values ($1) on conflict (license_namespace) do nothing`,
      [licenseNamespace],
    );
    const state = await client.query(
      `select checkpoint_received_at, checkpoint_telemetry_event_id,
         last_sync_completed_at, source_freshness_at
       from ${schema}.sidestream_customer_usage_sync_state
       where license_namespace = $1 for update`,
      [licenseNamespace],
    );
    const row = state.rows[0] || {};
    const completedAt = optionalDate(row.last_sync_completed_at);
    const sourceFreshnessDate = optionalDate(row.source_freshness_at);
    if (completedAt && completedAt.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) {
      return {
        skipped: true as const,
        checkpoint: null,
        sourceFreshnessDate,
        sourceFreshnessAt: sourceFreshnessDate?.toISOString() || null,
      };
    }
    await client.query(
      `update ${schema}.sidestream_customer_usage_sync_state
       set last_sync_started_at = $2, last_sync_completed_at = null
       where license_namespace = $1`,
      [licenseNamespace, now],
    );
    const checkpointReceivedAt = optionalDate(row.checkpoint_received_at);
    const checkpointId = optionalString(row.checkpoint_telemetry_event_id, 200);
    return {
      skipped: false as const,
      checkpoint: checkpointReceivedAt && checkpointId
        ? { receivedAt: checkpointReceivedAt, telemetryEventId: checkpointId }
        : null,
      sourceFreshnessDate,
      sourceFreshnessAt: sourceFreshnessDate?.toISOString() || null,
    };
  });
}

async function readSourceUpperHighWater(
  source: QueryRunner,
  schema: string,
  licenseNamespace: LicenseNamespace,
  lowerReceivedAt: Date,
) {
  const result = await source.query(
    `select received_at, telemetry_event_id
     from ${schema}.${CUSTOMER_USAGE_SOURCE_TABLE}
     where received_at >= $1
       and schema_version = any($2::text[])
       and coalesce(nullif(build_channel, ''), 'production') = any($3::text[])
     order by received_at desc, telemetry_event_id desc
     limit 1`,
    [
      lowerReceivedAt,
      [...CUSTOMER_USAGE_SCHEMA_VERSIONS],
      sourceChannels(licenseNamespace),
    ],
  );
  return result.rows[0] ? highWaterFromRow(result.rows[0]) : null;
}

type SourceBatchRow = Readonly<{
  highWater: CustomerUsageHighWater;
  installIdHash: string;
  activityDay: string;
}>;

async function readSourceBatch(
  source: QueryRunner,
  schema: string,
  licenseNamespace: LicenseNamespace,
  cursor: CustomerUsageHighWater,
  upper: CustomerUsageHighWater,
  limit: number,
): Promise<readonly SourceBatchRow[]> {
  const result = await source.query(
    `select telemetry_event_id, received_at, install_id_hash,
       (occurred_at at time zone 'UTC')::date::text as activity_day
     from ${schema}.${CUSTOMER_USAGE_SOURCE_TABLE}
     where (received_at, telemetry_event_id) > ($1::timestamptz, $2::text)
       and (received_at, telemetry_event_id) <= ($3::timestamptz, $4::text)
       and schema_version = any($5::text[])
       and coalesce(nullif(build_channel, ''), 'production') = any($6::text[])
       and install_id_hash ~ '^[0-9a-f]{64}$'
       and occurred_at is not null
     order by received_at, telemetry_event_id
     limit $7`,
    [
      cursor.receivedAt,
      cursor.telemetryEventId,
      upper.receivedAt,
      upper.telemetryEventId,
      [...CUSTOMER_USAGE_SCHEMA_VERSIONS],
      sourceChannels(licenseNamespace),
      limit,
    ],
  );
  return result.rows.map((row) => ({
    highWater: highWaterFromRow(row),
    installIdHash: requiredString(row.install_id_hash, "install_id_hash", 64),
    activityDay: requiredString(row.activity_day, "activity_day", 10),
  }));
}

async function readSourceDailyAggregates(
  source: QueryRunner,
  schema: string,
  licenseNamespace: LicenseNamespace,
  touched: readonly Readonly<{ installIdHash: string; activityDay: string }>[],
  upper: CustomerUsageHighWater,
) {
  if (touched.length === 0) return [];
  const result = await source.query(
    buildSourceAggregateSql(schema),
    [
      JSON.stringify(touched.map((row) => ({
        install_id_hash: row.installIdHash,
        activity_day: row.activityDay,
      }))),
      sourceChannels(licenseNamespace),
      [...CUSTOMER_USAGE_SCHEMA_VERSIONS],
      upper.receivedAt,
      upper.telemetryEventId,
    ],
  );
  return result.rows.map(normalizeCustomerUsageAggregateRow);
}

function buildSourceAggregateSql(schema: string) {
  return `with touched as (
    select install_id_hash, activity_day
    from jsonb_to_recordset($1::jsonb) as row(install_id_hash text, activity_day date)
  ), source_events as (
    select
      event.telemetry_event_id,
      event.install_id_hash,
      event.session_id,
      event.event_name,
      event.event_category,
      event.event_scope,
      event.occurred_at,
      nullif(btrim(event.app_version), '') as app_version,
      case event.schema_version
        when '0.2.0' then coalesce(
          nullif(event.payload ->> 'download_id', ''),
          nullif(event.data_points #>> '{details,downloadId}', ''),
          nullif(event.data_points #>> '{details,download_id}', '')
        )
      end as download_id,
      case event.schema_version
        when '0.2.0' then coalesce(
          nullif(event.payload ->> 'speculative_download_id', ''),
          nullif(event.data_points #>> '{details,speculativeDownloadId}', ''),
          nullif(event.data_points #>> '{details,speculative_download_id}', '')
        )
      end as speculative_download_id,
      case event.schema_version
        when '0.2.0' then coalesce(
          nullif(event.payload ->> 'download_trigger', ''),
          nullif(event.payload ->> 'interaction_trigger', ''),
          nullif(event.data_points #>> '{details,downloadTrigger}', ''),
          nullif(event.data_points #>> '{details,download_trigger}', ''),
          nullif(event.data_points #>> '{details,interactionTrigger}', ''),
          nullif(event.data_points #>> '{details,interaction_trigger}', '')
        )
      end as download_trigger,
      case event.schema_version
        when '0.2.0' then case
          when event.payload ->> 'file_delivered' in ('true', 'false')
            then (event.payload ->> 'file_delivered')::boolean
          when event.data_points #>> '{details,fileDelivered}' in ('true', 'false')
            then (event.data_points #>> '{details,fileDelivered}')::boolean
          when event.data_points #>> '{details,file_delivered}' in ('true', 'false')
            then (event.data_points #>> '{details,file_delivered}')::boolean
          else null
        end
      end as file_delivered,
      case event.schema_version
        when '0.2.0' then coalesce(
          nullif(event.payload ->> 'user_outcome', ''),
          nullif(event.data_points #>> '{details,userOutcome}', ''),
          nullif(event.data_points #>> '{details,user_outcome}', '')
        )
      end as user_outcome,
      case event.schema_version
        when '0.2.0' then coalesce(
          nullif(event.payload ->> 'failure_stage', ''),
          nullif(event.data_points #>> '{details,failureStage}', ''),
          nullif(event.data_points #>> '{details,failure_stage}', '')
        )
      end as failure_stage,
      case event.schema_version
        when '0.2.0' then coalesce(
          nullif(event.payload ->> 'failure_phase', ''),
          nullif(event.data_points #>> '{details,failurePhase}', ''),
          nullif(event.data_points #>> '{details,failure_phase}', '')
        )
      end as failure_phase,
      case event.schema_version
        when '0.2.0' then coalesce(
          nullif(event.payload ->> 'import_result', ''),
          nullif(event.data_points #>> '{details,importResult}', ''),
          nullif(event.data_points #>> '{details,import_result}', '')
        )
      end as import_result,
      case event.schema_version
        when '0.2.0' then coalesce(
          nullif(event.data_points #>> '{runtime,osPlatform}', ''),
          nullif(event.data_points #>> '{runtime,os_platform}', '')
        )
      end as os_platform,
      case event.schema_version
        when '0.2.0' then nullif(event.payload ->> 'gmail_campaign_hash', '')
      end as gmail_campaign_hash
    from ${schema}.${CUSTOMER_USAGE_SOURCE_TABLE} event
    where event.schema_version = any($3::text[])
      and coalesce(nullif(event.build_channel, ''), 'production') = any($2::text[])
      and (event.received_at, event.telemetry_event_id) <= ($4::timestamptz, $5::text)
      and event.install_id_hash ~ '^[0-9a-f]{64}$'
      and event.occurred_at is not null
      and exists (
        select 1 from touched
        where touched.install_id_hash = event.install_id_hash
          and (event.occurred_at at time zone 'UTC')::date
            between touched.activity_day - 2 and touched.activity_day + 2
      )
  ), projected as (
    select source_events.*,
      (occurred_at at time zone 'UTC')::date as activity_day,
      case
        when download_id is null then null
        else concat_ws(':', install_id_hash, coalesce(session_id, ''), download_id)
      end as download_key,
      case
        when speculative_download_id is null then null
        else concat_ws(':', install_id_hash, coalesce(session_id, ''), speculative_download_id)
      end as speculative_download_key
    from source_events
  ), accepted_requests as (
    select distinct on (install_id_hash, attempt_key)
      install_id_hash,
      activity_day,
      occurred_at as requested_at,
      download_key,
      telemetry_event_id,
      app_version
    from (
      select projected.*,
        coalesce(download_key, 'event:' || telemetry_event_id) as attempt_key
      from projected
      where event_name = 'download_requested'
        and not (
          coalesce(download_id, '') like 'speculative-%'
          or lower(coalesce(download_trigger, '')) like 'speculative%'
        )
    ) request
    order by install_id_hash, attempt_key, occurred_at, telemetry_event_id
  ), terminal_facts as (
    select
      download_key,
      bool_or(event_name = 'download_attempt_finalized') as has_finalization,
      bool_or(event_name = 'download_attempt_finalized' and file_delivered is true)
        as finalized_delivered,
      bool_or(
        event_name = 'download_attempt_finalized'
        and lower(coalesce(user_outcome, '')) = 'cancelled'
      ) as finalized_cancelled,
      bool_or(
        event_name = 'download_attempt_finalized'
        and file_delivered is true
        and (
          lower(coalesce(import_result, '')) = 'failed'
          or lower(coalesce(failure_stage, '')) in ('import', 'premiere_import')
          or lower(coalesce(user_outcome, '')) = 'got_file_import_failed'
        )
      ) as finalized_import_failed,
      bool_or(
        event_name = 'download_attempt_finalized'
        and (
          file_delivered is false
          or nullif(btrim(failure_stage), '') is not null
          or lower(coalesce(user_outcome, '')) in (
            'failed', 'download_failed', 'got_file_download_failed'
          )
        )
      ) as finalized_failed,
      bool_or(event_name = 'download_completed') as legacy_completed,
      bool_or(
        event_name = 'download_failed'
        and coalesce(event_scope, 'download') = 'download'
      ) as legacy_failed,
      bool_or(event_name = 'download_cancelled') as legacy_cancelled,
      max(occurred_at) filter (where event_name = 'premiere_import_failed')
        as legacy_import_failed_at,
      max(occurred_at) filter (where event_name = 'premiere_import_completed')
        as legacy_import_completed_at,
      bool_or(event_name in (
        'download_completed', 'download_failed', 'download_cancelled',
        'download_attempt_finalized', 'premiere_import_failed',
        'premiere_import_completed'
      )) as has_terminal
    from projected
    where download_key is not null
      and event_name in (
        'download_completed', 'download_failed', 'download_cancelled',
        'download_attempt_finalized', 'premiere_import_failed',
        'premiere_import_completed'
      )
    group by download_key
  ), terminals as (
    select download_key, has_terminal,
      case
        when has_finalization then case
          when finalized_cancelled then 'cancelled'
          when finalized_import_failed then 'failure'
          when finalized_delivered then 'success'
          when finalized_failed then 'failure'
          else null
        end
        when legacy_import_failed_at is not null and (
          legacy_import_completed_at is null
          or legacy_import_failed_at > legacy_import_completed_at
        ) then 'failure'
        when legacy_completed then 'success'
        when legacy_cancelled then 'cancelled'
        when legacy_failed then 'failure'
        else null
      end as outcome
    from terminal_facts
  ), adoption_links as (
    select distinct download_key as user_download_key, speculative_download_key
    from projected
    where download_key is not null
      and speculative_download_key is not null
      and download_id not like 'speculative-%'
      and speculative_download_id like 'speculative-%'
  ), request_outcomes as (
    select request.install_id_hash, request.activity_day, request.requested_at,
      request.app_version,
      case
        when bool_or(coalesce(direct.outcome = 'success', false)
          or coalesce(adopted.outcome = 'success', false)) then 'success'
        when bool_or(coalesce(direct.outcome = 'cancelled', false)
          or coalesce(adopted.outcome = 'cancelled', false)) then 'cancelled'
        when bool_or(coalesce(direct.outcome = 'failure', false)
          or coalesce(adopted.outcome = 'failure', false)) then 'failure'
        when bool_or(coalesce(direct.has_terminal, false)
          or coalesce(adopted.has_terminal, false)) then null
        else 'pending'
      end as outcome
    from accepted_requests request
    left join terminals direct on direct.download_key = request.download_key
    left join adoption_links adoption on adoption.user_download_key = request.download_key
    left join terminals adopted on adopted.download_key = adoption.speculative_download_key
    group by request.install_id_hash, request.activity_day, request.requested_at,
      request.telemetry_event_id, request.app_version
  ), daily_activity as (
    select install_id_hash, activity_day,
      min(occurred_at) filter (
        where coalesce(event_category, '') <> 'installer'
          and event_name not like 'installer_%'
      ) as first_app_use_at,
      max(occurred_at) filter (
        where coalesce(event_category, '') <> 'installer'
          and event_name not like 'installer_%'
      ) as last_app_use_at,
      count(*) filter (
        where coalesce(event_category, '') <> 'installer'
          and event_name not like 'installer_%'
      )::bigint as active_event_count,
      (array_agg(
        case lower(os_platform)
          when 'darwin' then 'macos'
          when 'macos' then 'macos'
          when 'win32' then 'windows'
          when 'windows' then 'windows'
          when '' then null
          else 'unknown'
        end
        order by occurred_at desc, telemetry_event_id desc
      ) filter (where os_platform is not null))[1] as platform,
      (array_agg(app_version order by occurred_at desc, telemetry_event_id desc)
        filter (where app_version is not null))[1] as app_version,
      coalesce(array_agg(distinct lower(gmail_campaign_hash)) filter (
        where gmail_campaign_hash ~ '^[0-9A-Fa-f]{64}$'
      ), '{}') as gmail_campaign_hashes
    from projected
    group by install_id_hash, activity_day
  ), daily_downloads as (
    select install_id_hash, activity_day,
      min(requested_at) as first_download_attempt_at,
      max(requested_at) as last_download_attempt_at,
      min(requested_at) filter (where outcome = 'success') as first_download_success_at,
      max(requested_at) filter (where outcome = 'success') as last_download_success_at,
      count(*)::bigint as download_attempt_count,
      count(*) filter (where outcome in ('success', 'failure', 'cancelled'))::bigint
        as download_outcome_count,
      count(*) filter (where outcome = 'success')::bigint as download_success_count,
      count(*) filter (where outcome = 'failure')::bigint as download_failure_count,
      count(*) filter (where outcome = 'cancelled')::bigint as download_cancelled_count,
      count(*) filter (where outcome = 'pending')::bigint as download_pending_count,
      count(*) filter (where outcome is null)::bigint as download_unknown_count
    from request_outcomes
    group by install_id_hash, activity_day
  ), days as (
    select install_id_hash, activity_day from daily_activity
    union
    select install_id_hash, activity_day from daily_downloads
  )
  select days.install_id_hash, days.activity_day::text,
    activity.first_app_use_at, activity.last_app_use_at,
    downloads.first_download_attempt_at, downloads.last_download_attempt_at,
    downloads.first_download_success_at, downloads.last_download_success_at,
    coalesce(activity.active_event_count, 0)::bigint as active_event_count,
    coalesce(downloads.download_attempt_count, 0)::bigint as download_attempt_count,
    coalesce(downloads.download_outcome_count, 0)::bigint as download_outcome_count,
    coalesce(downloads.download_success_count, 0)::bigint as download_success_count,
    coalesce(downloads.download_failure_count, 0)::bigint as download_failure_count,
    coalesce(downloads.download_cancelled_count, 0)::bigint as download_cancelled_count,
    coalesce(downloads.download_pending_count, 0)::bigint as download_pending_count,
    coalesce(downloads.download_unknown_count, 0)::bigint as download_unknown_count,
    activity.platform, activity.app_version,
    coalesce(activity.gmail_campaign_hashes, '{}') as gmail_campaign_hashes
  from days
  left join daily_activity activity using (install_id_hash, activity_day)
  left join daily_downloads downloads using (install_id_hash, activity_day)
  order by days.install_id_hash, days.activity_day`;
}

async function upsertDailyAggregate(
  client: PoolClient,
  schema: string,
  licenseNamespace: LicenseNamespace,
  row: CustomerUsageDailyAggregate,
  checkpoint: CustomerUsageHighWater,
  now: Date,
) {
  const result = await client.query(
    `insert into ${schema}.sidestream_customer_usage_daily (
       license_namespace, install_id_hash, activity_day,
       first_app_use_at, last_app_use_at,
       first_download_attempt_at, last_download_attempt_at,
       first_download_success_at, last_download_success_at,
       active_event_count, download_attempt_count, download_outcome_count,
       download_success_count, download_failure_count, download_cancelled_count,
       download_pending_count, download_unknown_count, platform, app_version,
       gmail_campaign_hashes, source_watermark_received_at,
       source_watermark_telemetry_event_id, refreshed_at
     )
     select $1, $2, $3::date, $4, $5, $6, $7, $8, $9,
       $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::text[], $21, $22, $23
     where exists (
       select 1 from ${schema}.sidestream_customer_installs
       where license_namespace = $1 and install_id_hash = $2
     )
     on conflict (license_namespace, install_id_hash, activity_day) do update set
       first_app_use_at = excluded.first_app_use_at,
       last_app_use_at = excluded.last_app_use_at,
       first_download_attempt_at = excluded.first_download_attempt_at,
       last_download_attempt_at = excluded.last_download_attempt_at,
       first_download_success_at = excluded.first_download_success_at,
       last_download_success_at = excluded.last_download_success_at,
       active_event_count = excluded.active_event_count,
       download_attempt_count = excluded.download_attempt_count,
       download_outcome_count = excluded.download_outcome_count,
       download_success_count = excluded.download_success_count,
       download_failure_count = excluded.download_failure_count,
       download_cancelled_count = excluded.download_cancelled_count,
       download_pending_count = excluded.download_pending_count,
       download_unknown_count = excluded.download_unknown_count,
       platform = excluded.platform,
       app_version = excluded.app_version,
       gmail_campaign_hashes = excluded.gmail_campaign_hashes,
       source_watermark_received_at = excluded.source_watermark_received_at,
       source_watermark_telemetry_event_id = excluded.source_watermark_telemetry_event_id,
       refreshed_at = excluded.refreshed_at`,
    [
      licenseNamespace,
      row.installIdHash,
      row.activityDay,
      row.firstAppUseAt,
      row.lastAppUseAt,
      row.firstDownloadAttemptAt,
      row.lastDownloadAttemptAt,
      row.firstDownloadSuccessAt,
      row.lastDownloadSuccessAt,
      row.activeEventCount,
      row.downloadAttemptCount,
      row.downloadOutcomeCount,
      row.downloadSuccessCount,
      row.downloadFailureCount,
      row.downloadCancelledCount,
      row.downloadPendingCount,
      row.downloadUnknownCount,
      row.platform,
      row.appVersion,
      [...row.gmailCampaignHashes],
      checkpoint.receivedAt,
      checkpoint.telemetryEventId,
      now,
    ],
  );
  return result.rowCount || 0;
}

async function commitCustomerUsageCheckpoint(
  client: PoolClient,
  schema: string,
  licenseNamespace: LicenseNamespace,
  checkpoint: CustomerUsageHighWater,
  sourceFreshnessAt: Date,
  now: Date,
) {
  await client.query(
    `update ${schema}.sidestream_customer_usage_sync_state
     set checkpoint_received_at = case
           when checkpoint_received_at is null
             or (checkpoint_received_at, checkpoint_telemetry_event_id)
               < ($2::timestamptz, $3::text)
             then $2 else checkpoint_received_at end,
         checkpoint_telemetry_event_id = case
           when checkpoint_received_at is null
             or (checkpoint_received_at, checkpoint_telemetry_event_id)
               < ($2::timestamptz, $3::text)
             then $3 else checkpoint_telemetry_event_id end,
         last_batch_committed_at = $4,
         source_freshness_at = greatest(source_freshness_at, $5),
         committed_batch_count = committed_batch_count + 1
     where license_namespace = $1`,
    [licenseNamespace, checkpoint.receivedAt, checkpoint.telemetryEventId, now, sourceFreshnessAt],
  );
}

async function completeCustomerUsageRun(
  client: PoolClient,
  schema: string,
  licenseNamespace: LicenseNamespace,
  upper: CustomerUsageHighWater | null,
  now: Date,
) {
  await client.query(
    `update ${schema}.sidestream_customer_usage_sync_state
     set checkpoint_received_at = case
           when $2::timestamptz is null then checkpoint_received_at
           when checkpoint_received_at is null
             or (checkpoint_received_at, checkpoint_telemetry_event_id)
               < ($2::timestamptz, $3::text)
             then $2 else checkpoint_received_at end,
         checkpoint_telemetry_event_id = case
           when $2::timestamptz is null then checkpoint_telemetry_event_id
           when checkpoint_received_at is null
             or (checkpoint_received_at, checkpoint_telemetry_event_id)
               < ($2::timestamptz, $3::text)
             then $3 else checkpoint_telemetry_event_id end,
         source_freshness_at = case
           when $2::timestamptz is null then source_freshness_at
           else greatest(source_freshness_at, $2) end,
         last_sync_completed_at = $4
     where license_namespace = $1`,
    [licenseNamespace, upper?.receivedAt || null, upper?.telemetryEventId || null, now],
  );
}

async function runClientTransaction<T>(client: PoolClient, callback: () => Promise<T>) {
  await client.query("begin");
  try {
    const result = await callback();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

function uniqueTouchedDays(rows: readonly SourceBatchRow[]) {
  const values = new Map<string, { installIdHash: string; activityDay: string }>();
  for (const row of rows) {
    const key = `${row.installIdHash}:${row.activityDay}`;
    values.set(key, { installIdHash: row.installIdHash, activityDay: row.activityDay });
  }
  return [...values.values()];
}

function highWaterFromRow(row: QueryRow): CustomerUsageHighWater {
  return Object.freeze({
    receivedAt: requiredDate(row.received_at, "received_at"),
    telemetryEventId: requiredString(row.telemetry_event_id, "telemetry_event_id", 200),
  });
}

function sourceChannels(namespace: LicenseNamespace) {
  return namespace === "test" ? ["test"] : ["production", "prod"];
}

function resolveUsageNamespace(environment: Environment): LicenseNamespace {
  const explicit = configuredValue(environment.SIDESTREAM_LICENSE_NAMESPACE)?.toLowerCase();
  if (explicit) {
    if (explicit === "production" || explicit === "test") return explicit;
    throw new Error("SIDESTREAM_LICENSE_NAMESPACE must be production or test");
  }
  if (configuredValue(environment.VERCEL_ENV)?.toLowerCase() === "production") {
    return "production";
  }
  throw new Error("Customer usage sync requires a trusted deployment namespace");
}

function databaseIdentity(connectionString: string, environmentName: string) {
  const url = parsePostgresUrl(connectionString, environmentName);
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  return `${url.hostname.toLowerCase()}:${url.port || "5432"}/${database}`;
}

function parsePostgresUrl(connectionString: string, environmentName: string) {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`${environmentName} must be a valid Postgres URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
    throw new Error(`${environmentName} must identify a Postgres database`);
  }
  return url;
}

function readBoundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (!configuredValue(raw)) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Customer usage configuration must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function boundedNumber(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`Customer usage value must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function validatedIdentifier(value: string, label: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new TypeError(`Unsafe ${label}`);
  return value;
}

function configuredValue(value: string | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredString(value: unknown, label: string, maximumLength: number) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maximumLength) {
    throw new Error(`Telemetry aggregate ${label} is invalid`);
  }
  return normalized;
}

function optionalString(value: unknown, maximumLength: number) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new Error("Telemetry aggregate string is invalid");
  }
  return value;
}

function requiredDate(value: unknown, label: string) {
  const date = value instanceof Date ? new Date(value) : new Date(String(value || ""));
  if (!Number.isFinite(date.getTime())) throw new Error(`Telemetry aggregate ${label} is invalid`);
  return date;
}

function optionalDate(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  return requiredDate(value, "timestamp");
}

function nonnegativeInteger(value: unknown, label: string) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Telemetry aggregate ${label} is invalid`);
  }
  return parsed;
}

function normalizedToken(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function addUtcDays(day: string, offset: number) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function emptySummary(
  outcome: "skipped" | "locked",
  licenseNamespace: LicenseNamespace,
): CustomerUsageSyncSummary {
  return {
    outcome,
    licenseNamespace,
    batches: 0,
    sourceRowsScanned: 0,
    dailyBucketsWritten: 0,
    profilesRefreshed: 0,
    sourceFreshnessAt: null,
  };
}

function safePostgresErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return "unknown";
  return String(error.code || "unknown").slice(0, 64);
}

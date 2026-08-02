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
const INSTALL_COMPLETION_BOUNDS = Symbol("installCompletionBounds");

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
  [INSTALL_COMPLETION_BOUNDS]: Readonly<{
    first: Date | null;
    last: Date | null;
  }>;
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

export type CustomerUsageSessionRescanSummary = Readonly<{
  outcome: "completed" | "partial" | "locked";
  licenseNamespace: LicenseNamespace;
  batches: number;
  sourceEventsScanned: number;
  dailyBucketsWritten: number;
  profilesRefreshed: number;
  sourceFreshnessAt: string | null;
  checkpoint: Readonly<{
    receivedAt: string;
    telemetryEventId: string;
  }> | null;
  complete: boolean;
}>;

export type CustomerUsageSessionRescanOptions = Readonly<{
  targetPool: ConnectableQueryRunner;
  telemetryPool: QueryRunner;
  targetSchema?: string;
  telemetrySchema?: string;
  licenseNamespace: LicenseNamespace;
  checkpoint?: CustomerUsageHighWater | null;
  batchSize?: number;
  maxBatches?: number;
  now?: Date;
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
  if (!local && sslDisabled) {
    throw new Error("Remote telemetry Postgres requires authenticated TLS");
  }
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
    ssl: local ? false : { rejectUnauthorized: true },
  };
}

export function sanitizedPostgresTargetFingerprint(connectionString: string) {
  const url = parsePostgresUrl(connectionString, "Postgres target");
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  return `${url.hostname.toLowerCase()}:${url.port || "5432"}/${database}`;
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
    [INSTALL_COMPLETION_BOUNDS]: {
      first: optionalDate(row.first_install_completed_at),
      last: optionalDate(row.last_install_completed_at),
    },
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
        const sourceBatch = await readSourceAggregateBatch(
          sourcePool,
          sourceSchema,
          licenseNamespace,
          cursor,
          upper,
          batchSize,
        );
        if (!sourceBatch) break;
        const batchCheckpoint = sourceBatch.checkpoint;
        let written = 0;
        await runClientTransaction(targetClient, async () => {
          for (const aggregate of sourceBatch.aggregates) {
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
        sourceRowsScanned += sourceBatch.aggregates.length;
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

/**
 * Rebuilds complete daily usage aggregates from all valid historical telemetry.
 * The source is always read-only, the target mutation is limited to replaceable
 * usage aggregates, and the caller owns the durable checkpoint used for resume.
 */
export async function runCustomerUsageSessionRescan(
  options: CustomerUsageSessionRescanOptions,
): Promise<CustomerUsageSessionRescanSummary> {
  const targetSchema = validatedIdentifier(options.targetSchema || "public", "target schema");
  const sourceSchema = validatedIdentifier(
    options.telemetrySchema || "public",
    "telemetry schema",
  );
  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError("Rescan time is invalid");
  const batchSize = Math.trunc(boundedNumber(
    options.batchSize ?? CUSTOMER_USAGE_BATCH_SIZE,
    25,
    1_000,
  ));
  const maxBatches = Math.trunc(boundedNumber(options.maxBatches ?? 100, 1, 10_000));
  const checkpoint = options.checkpoint
    ? {
        receivedAt: requiredDate(options.checkpoint.receivedAt, "rescan checkpoint"),
        telemetryEventId: requiredString(
          options.checkpoint.telemetryEventId,
          "rescan checkpoint telemetry_event_id",
          200,
        ),
      }
    : null;
  const client = await options.targetPool.connect();
  const lockName = `sidestream_customer_usage_historical_rescan:${options.licenseNamespace}`;
  let locked = false;

  try {
    const lock = await client.query(
      "select pg_try_advisory_lock(hashtext($1)) as locked",
      [lockName],
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked) {
      return {
        outcome: "locked",
        licenseNamespace: options.licenseNamespace,
        batches: 0,
        sourceEventsScanned: 0,
        dailyBucketsWritten: 0,
        profilesRefreshed: 0,
        sourceFreshnessAt: null,
        checkpoint: checkpoint ? serializeHighWater(checkpoint) : null,
        complete: false,
      };
    }

    const upper = await readSourceUpperHighWater(
      options.telemetryPool,
      sourceSchema,
      options.licenseNamespace,
      new Date(0),
    );
    let cursor = checkpoint || {
      receivedAt: new Date(0),
      telemetryEventId: "",
    };
    if (upper && compareCustomerUsageHighWater(cursor, upper) > 0) {
      throw new Error("Rescan checkpoint is ahead of source freshness");
    }

    let batches = 0;
    let sourceEventsScanned = 0;
    let dailyBucketsWritten = 0;
    while (
      upper &&
      batches < maxBatches &&
      compareCustomerUsageHighWater(cursor, upper) < 0
    ) {
      const batch = await readSourceAggregateBatch(
        options.telemetryPool,
        sourceSchema,
        options.licenseNamespace,
        cursor,
        upper,
        batchSize,
      );
      if (!batch) break;
      let written = 0;
      await runClientTransaction(client, async () => {
        for (const aggregate of batch.aggregates) {
          written += await upsertDailyAggregate(
            client,
            targetSchema,
            options.licenseNamespace,
            aggregate,
            batch.checkpoint,
            now,
            { requireExistingInstall: true },
          );
        }
      });
      batches += 1;
      sourceEventsScanned += batch.sourceEventCount;
      dailyBucketsWritten += written;
      cursor = batch.checkpoint;
      await options.afterBatchCommitted?.({ batch: batches, checkpoint: cursor });
    }

    const complete = !upper || compareCustomerUsageHighWater(cursor, upper) >= 0;
    let profilesRefreshed = 0;
    if (upper) {
      await runClientTransaction(client, async () => {
        profilesRefreshed = await materializeCustomerUsageProfiles({
          query: client.query.bind(client),
          targetSchema,
          licenseNamespace: options.licenseNamespace,
          now,
          sourceFreshnessAt: cursor.receivedAt,
        });
      });
    }
    return {
      outcome: complete ? "completed" : "partial",
      licenseNamespace: options.licenseNamespace,
      batches,
      sourceEventsScanned,
      dailyBucketsWritten,
      profilesRefreshed,
      sourceFreshnessAt: upper ? cursor.receivedAt.toISOString() : null,
      checkpoint: upper || checkpoint ? serializeHighWater(cursor) : null,
      complete,
    };
  } finally {
    if (locked) {
      await client.query("select pg_advisory_unlock(hashtext($1))", [lockName]).catch(() => {});
    }
    client.release();
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
         first_seen_at = case
           when value.first_app_use_at is null then profile.first_seen_at
           when profile.first_seen_at is null then value.first_app_use_at
           else least(profile.first_seen_at, value.first_app_use_at)
         end,
         last_activity_at = case
           when value.last_app_use_at is null then profile.last_activity_at
           when profile.last_activity_at is null then value.last_app_use_at
           else greatest(profile.last_activity_at, value.last_app_use_at)
         end,
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
         platform_summary = coalesce(value.platform, profile.platform_summary),
         app_version_summary = coalesce(value.app_version, profile.app_version_summary),
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
       and install_id_hash ~ '^[0-9a-f]{64}$'
       and occurred_at is not null
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

async function readSourceAggregateBatch(
  source: QueryRunner,
  schema: string,
  licenseNamespace: LicenseNamespace,
  cursor: CustomerUsageHighWater,
  upper: CustomerUsageHighWater,
  limit: number,
): Promise<Readonly<{
  checkpoint: CustomerUsageHighWater;
  sourceEventCount: number;
  aggregates: readonly CustomerUsageDailyAggregate[];
}> | null> {
  const result = await source.query(
    buildSourceAggregateSql(schema),
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
  if (result.rows.length === 0) return null;
  const checkpoint = highWaterFromRow({
    received_at: result.rows[0].checkpoint_received_at,
    telemetry_event_id: result.rows[0].checkpoint_telemetry_event_id,
  });
  for (const row of result.rows.slice(1)) {
    const rowCheckpoint = highWaterFromRow({
      received_at: row.checkpoint_received_at,
      telemetry_event_id: row.checkpoint_telemetry_event_id,
    });
    if (compareCustomerUsageHighWater(checkpoint, rowCheckpoint) !== 0) {
      throw new Error("Telemetry aggregate batch returned inconsistent checkpoints");
    }
  }
  return {
    checkpoint,
    sourceEventCount: nonnegativeInteger(
      result.rows[0].source_event_count,
      "source_event_count",
    ),
    aggregates: result.rows.map(normalizeCustomerUsageAggregateRow),
  };
}

async function readSessionStartedUpperHighWater(
  source: QueryRunner,
  schema: string,
  licenseNamespace: LicenseNamespace,
) {
  const result = await source.query(
    `select received_at, telemetry_event_id
     from ${schema}.${CUSTOMER_USAGE_SOURCE_TABLE}
     where event_name = 'session_started'
       and schema_version = any($1::text[])
       and coalesce(nullif(build_channel, ''), 'production') = any($2::text[])
       and install_id_hash ~ '^[0-9a-f]{64}$'
       and occurred_at is not null
     order by received_at desc, telemetry_event_id desc
     limit 1`,
    [[...CUSTOMER_USAGE_SCHEMA_VERSIONS], sourceChannels(licenseNamespace)],
  );
  return result.rows[0] ? highWaterFromRow(result.rows[0]) : null;
}

async function readSessionStartedAggregateBatch(
  source: QueryRunner,
  schema: string,
  licenseNamespace: LicenseNamespace,
  cursor: CustomerUsageHighWater,
  upper: CustomerUsageHighWater,
  limit: number,
) {
  const result = await source.query(
    `with batch_events as (
       select telemetry_event_id, received_at, install_id_hash,
         (occurred_at at time zone 'UTC')::date as activity_day
       from ${schema}.${CUSTOMER_USAGE_SOURCE_TABLE}
       where event_name = 'session_started'
         and (received_at, telemetry_event_id) > ($1::timestamptz, $2::text)
         and (received_at, telemetry_event_id) <= ($3::timestamptz, $4::text)
         and schema_version = any($5::text[])
         and coalesce(nullif(build_channel, ''), 'production') = any($6::text[])
         and install_id_hash ~ '^[0-9a-f]{64}$'
         and occurred_at is not null
       order by received_at, telemetry_event_id
       limit $7
     ), batch_checkpoint as (
       select received_at, telemetry_event_id
       from batch_events
       order by received_at desc, telemetry_event_id desc
       limit 1
     ), affected_days as (
       select distinct install_id_hash, activity_day from batch_events
     ), projected as (
       select event.telemetry_event_id, event.install_id_hash,
         (event.occurred_at at time zone 'UTC')::date as activity_day,
         event.occurred_at, event.app_version,
         case event.schema_version
           when '0.2.0' then coalesce(
             nullif(event.data_points #>> '{runtime,osPlatform}', ''),
             nullif(event.data_points #>> '{runtime,os_platform}', '')
           )
           else null
         end as os_platform
       from ${schema}.${CUSTOMER_USAGE_SOURCE_TABLE} event
       join affected_days day
         on day.install_id_hash = event.install_id_hash
        and day.activity_day = (event.occurred_at at time zone 'UTC')::date
       where event.event_name = 'session_started'
         and (event.received_at, event.telemetry_event_id)
           <= ($3::timestamptz, $4::text)
         and event.schema_version = any($5::text[])
         and coalesce(nullif(event.build_channel, ''), 'production') = any($6::text[])
         and event.install_id_hash ~ '^[0-9a-f]{64}$'
         and event.occurred_at is not null
     )
     select projected.install_id_hash, projected.activity_day::text,
       null::timestamptz as first_install_completed_at,
       null::timestamptz as last_install_completed_at,
       min(projected.occurred_at) as first_app_use_at,
       max(projected.occurred_at) as last_app_use_at,
       null::timestamptz as first_download_attempt_at,
       null::timestamptz as last_download_attempt_at,
       null::timestamptz as first_download_success_at,
       null::timestamptz as last_download_success_at,
       count(*)::bigint as active_event_count,
       0::bigint as download_attempt_count,
       0::bigint as download_outcome_count,
       0::bigint as download_success_count,
       0::bigint as download_failure_count,
       0::bigint as download_cancelled_count,
       0::bigint as download_pending_count,
       0::bigint as download_unknown_count,
       (array_agg(
         case lower(projected.os_platform)
           when 'darwin' then 'macos'
           when 'macos' then 'macos'
           when 'win32' then 'windows'
           when 'windows' then 'windows'
           when '' then null
           else 'unknown'
         end
         order by projected.occurred_at desc, projected.telemetry_event_id desc
       ) filter (where projected.os_platform is not null))[1] as platform,
       (array_agg(
         projected.app_version
         order by projected.occurred_at desc, projected.telemetry_event_id desc
       ) filter (where projected.app_version is not null))[1] as app_version,
       checkpoint.received_at as checkpoint_received_at,
       checkpoint.telemetry_event_id as checkpoint_telemetry_event_id,
       (select count(*)::bigint from batch_events) as source_event_count
     from projected
     cross join batch_checkpoint checkpoint
     group by projected.install_id_hash, projected.activity_day,
       checkpoint.received_at, checkpoint.telemetry_event_id
     order by projected.install_id_hash, projected.activity_day`,
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
  if (result.rows.length === 0) return null;
  const checkpoint = highWaterFromRow({
    received_at: result.rows[0].checkpoint_received_at,
    telemetry_event_id: result.rows[0].checkpoint_telemetry_event_id,
  });
  return {
    checkpoint,
    sourceEventCount: nonnegativeInteger(
      result.rows[0].source_event_count,
      "source_event_count",
    ),
    aggregates: result.rows.map(normalizeCustomerUsageAggregateRow),
  };
}

function buildSourceAggregateSql(schema: string) {
  return `with batch_events as (
    select telemetry_event_id, received_at, install_id_hash,
      (occurred_at at time zone 'UTC')::date as activity_day
    from ${schema}.${CUSTOMER_USAGE_SOURCE_TABLE}
    where (received_at, telemetry_event_id) > ($1::timestamptz, $2::text)
      and (received_at, telemetry_event_id) <= ($3::timestamptz, $4::text)
      and schema_version = any($5::text[])
      and coalesce(nullif(build_channel, ''), 'production') = any($6::text[])
      and install_id_hash ~ '^[0-9a-f]{64}$'
      and occurred_at is not null
    order by received_at, telemetry_event_id
    limit $7
  ), batch_checkpoint as (
    select received_at, telemetry_event_id
    from batch_events
    order by received_at desc, telemetry_event_id desc
    limit 1
  ), touched as (
    select distinct install_id_hash, activity_day
    from batch_events
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
      end as os_platform
    from ${schema}.${CUSTOMER_USAGE_SOURCE_TABLE} event
    where event.schema_version = any($5::text[])
      and coalesce(nullif(event.build_channel, ''), 'production') = any($6::text[])
      and (event.received_at, event.telemetry_event_id) <= ($3::timestamptz, $4::text)
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
  ), adoption_links as (
    select distinct download_key as user_download_key, speculative_download_key
    from projected
    where download_key is not null
      and speculative_download_key is not null
      and download_id not like 'speculative-%'
      and speculative_download_id like 'speculative-%'
  ), request_terminal_facts as (
    select request.install_id_hash, request.activity_day, request.requested_at,
      request.telemetry_event_id, request.app_version,
      bool_or(coalesce(fact.has_finalization, false)) as has_finalization,
      bool_or(coalesce(fact.finalized_delivered, false)) as finalized_delivered,
      bool_or(coalesce(fact.finalized_cancelled, false)) as finalized_cancelled,
      bool_or(coalesce(fact.finalized_import_failed, false)) as finalized_import_failed,
      bool_or(coalesce(fact.finalized_failed, false)) as finalized_failed,
      bool_or(coalesce(fact.legacy_completed, false)) as legacy_completed,
      bool_or(coalesce(fact.legacy_failed, false)) as legacy_failed,
      bool_or(coalesce(fact.legacy_cancelled, false)) as legacy_cancelled,
      max(fact.legacy_import_failed_at) as legacy_import_failed_at,
      max(fact.legacy_import_completed_at) as legacy_import_completed_at,
      bool_or(coalesce(fact.has_terminal, false)) as has_terminal
    from accepted_requests request
    left join adoption_links adoption on adoption.user_download_key = request.download_key
    left join terminal_facts fact
      on fact.download_key = request.download_key
      or fact.download_key = adoption.speculative_download_key
    group by request.install_id_hash, request.activity_day, request.requested_at,
      request.telemetry_event_id, request.app_version
  ), request_outcomes as (
    select install_id_hash, activity_day, requested_at, app_version,
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
        when has_terminal then null
        else 'pending'
      end as outcome
    from request_terminal_facts
  ), daily_activity as (
    select install_id_hash, activity_day,
      min(occurred_at) filter (
        where event_name = 'installer_install_completed'
      ) as first_install_completed_at,
      max(occurred_at) filter (
        where event_name = 'installer_install_completed'
      ) as last_install_completed_at,
      min(occurred_at) filter (
        where event_name = 'session_started'
      ) as first_app_use_at,
      max(occurred_at) filter (
        where event_name = 'session_started'
      ) as last_app_use_at,
      count(*) filter (
        where event_name = 'session_started'
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
      ) filter (
        where event_name = 'session_started' and os_platform is not null
      ))[1] as platform,
      (array_agg(app_version order by occurred_at desc, telemetry_event_id desc)
        filter (
          where event_name = 'session_started' and app_version is not null
        ))[1] as app_version
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
    activity.first_install_completed_at, activity.last_install_completed_at,
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
    checkpoint.received_at as checkpoint_received_at,
    checkpoint.telemetry_event_id as checkpoint_telemetry_event_id,
    (select count(*)::bigint from batch_events) as source_event_count
  from days
  left join daily_activity activity using (install_id_hash, activity_day)
  left join daily_downloads downloads using (install_id_hash, activity_day)
  cross join batch_checkpoint checkpoint
  order by days.install_id_hash, days.activity_day`;
}

async function ensureAnonymousCustomerInstall(
  client: PoolClient,
  schema: string,
  licenseNamespace: LicenseNamespace,
  row: CustomerUsageDailyAggregate,
  now: Date,
) {
  const lifecycle = aggregateLifecycleBounds(row);
  const updateExisting = () => client.query(
    `update ${schema}.sidestream_customer_installs
     set first_seen_at = case
           when $3::timestamptz is null then first_seen_at
           else least(first_seen_at, $3)
         end,
         last_seen_at = case
           when $4::timestamptz is null then last_seen_at
           else greatest(last_seen_at, $4)
         end,
         platform = coalesce($5, platform),
         app_version = coalesce($6, app_version)
     where license_namespace = $1 and install_id_hash = $2
     returning profile_id`,
    [
      licenseNamespace,
      row.installIdHash,
      lifecycle.firstSeenAt,
      lifecycle.lastSeenAt,
      row.platform,
      row.appVersion,
    ],
  );
  const existing = await updateExisting();
  if (existing.rowCount) {
    const profileId = requiredString(
      existing.rows[0]?.profile_id,
      "existing install profile id",
      36,
    );
    await ensureInstallIdentityLink(
      client,
      schema,
      licenseNamespace,
      row.installIdHash,
      profileId,
      now,
    );
    return;
  }

  // This is the same namespace lock used by profile merges. Rechecking after
  // acquiring it makes first telemetry sighting converge on one live profile;
  // a conflicting install insert aborts this transaction before its checkpoint.
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `sidestream_customer_profile_merge:${licenseNamespace}`,
  ]);
  const lockedExisting = await updateExisting();
  if (lockedExisting.rowCount) {
    const profileId = requiredString(
      lockedExisting.rows[0]?.profile_id,
      "existing install profile id",
      36,
    );
    await ensureInstallIdentityLink(
      client,
      schema,
      licenseNamespace,
      row.installIdHash,
      profileId,
      now,
    );
    return;
  }

  const bucketStart = new Date(`${row.activityDay}T00:00:00.000Z`);
  const firstSeenAt = lifecycle.firstSeenAt || bucketStart;
  const lastSeenAt = lifecycle.lastSeenAt || bucketStart;
  const profile = await client.query(
    `insert into ${schema}.sidestream_customer_profiles (
       license_namespace, platform_summary, app_version_summary,
       first_seen_at, last_activity_at, created_at, updated_at
     ) values ($1, $2, $3, $4, $5, $6, $6)
     returning id`,
    [
      licenseNamespace,
      row.platform,
      row.appVersion,
      firstSeenAt,
      lastSeenAt,
      now,
    ],
  );
  const profileId = requiredString(profile.rows[0]?.id, "anonymous profile id", 36);
  await client.query(
    `insert into ${schema}.sidestream_customer_installs (
       profile_id, license_namespace, install_id_hash, platform, app_version,
       first_seen_at, last_seen_at
     ) values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      profileId,
      licenseNamespace,
      row.installIdHash,
      row.platform,
      row.appVersion,
      firstSeenAt,
      lastSeenAt,
    ],
  );
  await ensureInstallIdentityLink(
    client,
    schema,
    licenseNamespace,
    row.installIdHash,
    profileId,
    now,
  );
}

async function ensureInstallIdentityLink(
  client: PoolClient,
  schema: string,
  licenseNamespace: LicenseNamespace,
  installIdHash: string,
  profileId: string,
  now: Date,
) {
  const inserted = await client.query(
    `insert into ${schema}.sidestream_customer_identity_links (
       profile_id, license_namespace, link_type, link_value, created_at
     ) values ($1, $2, 'install_identity_hash', $3, $4)
     on conflict (license_namespace, link_type, link_value) do nothing
     returning profile_id`,
    [profileId, licenseNamespace, installIdHash, now],
  );
  if (inserted.rowCount) return;

  const existing = await client.query(
    `select profile_id
     from ${schema}.sidestream_customer_identity_links
     where license_namespace = $1
       and link_type = 'install_identity_hash'
       and link_value = $2`,
    [licenseNamespace, installIdHash],
  );
  if (existing.rows[0]?.profile_id !== profileId) {
    throw new Error("Telemetry install identity conflicts with its customer profile");
  }
}

function aggregateLifecycleBounds(row: CustomerUsageDailyAggregate) {
  const timestamps = [
    row[INSTALL_COMPLETION_BOUNDS].first,
    row[INSTALL_COMPLETION_BOUNDS].last,
    row.firstAppUseAt,
    row.lastAppUseAt,
    row.firstDownloadAttemptAt,
    row.lastDownloadAttemptAt,
    row.firstDownloadSuccessAt,
    row.lastDownloadSuccessAt,
  ].filter((value): value is Date => value !== null);
  // Heartbeat-only buckets still advance the source checkpoint, but they must
  // not fabricate an install sighting or an app open.
  if (timestamps.length === 0) {
    return { firstSeenAt: null, lastSeenAt: null };
  }
  const milliseconds = timestamps.map((value) => value.getTime());
  return {
    firstSeenAt: new Date(Math.min(...milliseconds)),
    lastSeenAt: new Date(Math.max(...milliseconds)),
  };
}

async function upsertDailyAggregate(
  client: PoolClient,
  schema: string,
  licenseNamespace: LicenseNamespace,
  row: CustomerUsageDailyAggregate,
  checkpoint: CustomerUsageHighWater,
  now: Date,
  options: Readonly<{ requireExistingInstall?: boolean }> = {},
) {
  const requireExistingInstall = options.requireExistingInstall === true;
  if (!requireExistingInstall) {
    await ensureAnonymousCustomerInstall(
      client,
      schema,
      licenseNamespace,
      row,
      now,
    );
  }
  const result = await client.query(
    `insert into ${schema}.sidestream_customer_usage_daily (
       license_namespace, install_id_hash, activity_day,
       first_app_use_at, last_app_use_at,
       first_download_attempt_at, last_download_attempt_at,
       first_download_success_at, last_download_success_at,
       active_event_count, download_attempt_count, download_outcome_count,
       download_success_count, download_failure_count, download_cancelled_count,
       download_pending_count, download_unknown_count, platform, app_version,
       source_watermark_received_at,
       source_watermark_telemetry_event_id, refreshed_at
     )
     select $1, $2, $3::date, $4, $5, $6, $7, $8, $9,
       $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
     where $23::boolean is false or exists (
       select 1 from ${schema}.sidestream_customer_installs install
       where install.license_namespace = $1 and install.install_id_hash = $2
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
      checkpoint.receivedAt,
      checkpoint.telemetryEventId,
      now,
      requireExistingInstall,
    ],
  );
  return result.rowCount || 0;
}

async function upsertSessionStartedAggregate(
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
       source_watermark_received_at,
       source_watermark_telemetry_event_id, refreshed_at
     )
     select $1, $2, $3::date, $4, $5,
       null, null, null, null,
       $6, 0, 0, 0, 0, 0, 0, 0, $7, $8, $9, $10, $11
     from ${schema}.sidestream_customer_installs install
     where install.license_namespace = $1
       and install.install_id_hash = $2
     on conflict (license_namespace, install_id_hash, activity_day) do update set
       first_app_use_at = excluded.first_app_use_at,
       last_app_use_at = excluded.last_app_use_at,
       active_event_count = excluded.active_event_count,
       platform = coalesce(excluded.platform, sidestream_customer_usage_daily.platform),
       app_version = coalesce(
         excluded.app_version,
         sidestream_customer_usage_daily.app_version
       ),
       source_watermark_received_at = greatest(
         sidestream_customer_usage_daily.source_watermark_received_at,
         excluded.source_watermark_received_at
       ),
       source_watermark_telemetry_event_id = case
         when excluded.source_watermark_received_at
           > sidestream_customer_usage_daily.source_watermark_received_at
           then excluded.source_watermark_telemetry_event_id
         when excluded.source_watermark_received_at
           = sidestream_customer_usage_daily.source_watermark_received_at
           then greatest(
             sidestream_customer_usage_daily.source_watermark_telemetry_event_id,
             excluded.source_watermark_telemetry_event_id
           )
         else sidestream_customer_usage_daily.source_watermark_telemetry_event_id
       end,
       refreshed_at = excluded.refreshed_at`,
    [
      licenseNamespace,
      row.installIdHash,
      row.activityDay,
      row.firstAppUseAt,
      row.lastAppUseAt,
      row.activeEventCount,
      row.platform,
      row.appVersion,
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

function highWaterFromRow(row: QueryRow): CustomerUsageHighWater {
  return Object.freeze({
    receivedAt: requiredDate(row.received_at, "received_at"),
    telemetryEventId: requiredString(row.telemetry_event_id, "telemetry_event_id", 200),
  });
}

function serializeHighWater(value: CustomerUsageHighWater) {
  return Object.freeze({
    receivedAt: value.receivedAt.toISOString(),
    telemetryEventId: value.telemetryEventId,
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

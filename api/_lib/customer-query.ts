import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";
import { withPostgresTransaction } from "./postgres.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 2_048;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITLEMENT_PATTERN = /^[a-z0-9][a-z0-9_:-]{0,63}$/;
const BILLING_MODELS = new Set(["one_time", "subscription", "comped", "mixed"]);
const DATA_QUALITY_FLAGS = new Set([
  "usage_not_synced",
  "missing_install_membership",
  "usage_install_count_mismatch",
  "pending_download_outcomes",
  "unknown_download_outcomes",
  "outcome_counts_inconsistent",
  "attempt_counts_inconsistent",
  "pending_identity_review",
  "commerce_identity_conflict",
]);

type LicenseNamespace = "production" | "test";

type CustomerListFilters = Readonly<{
  billingModel: string | null;
  entitlementStatus: string | null;
  hasEmail: boolean | null;
  activeSince: string | null;
  dataQualityFlag: string | null;
}>;

type CustomerCursor = Readonly<{
  v: 1;
  filterHash: string;
  sortActivityAt: string;
  profileCreatedAt: string;
  customerId: string;
}>;

type CustomerListInput = Readonly<{
  licenseNamespace: LicenseNamespace;
  limit: number;
  filters: CustomerListFilters;
  cursor: CustomerCursor | null;
  filterHash: string;
}>;

type CustomerQueryClient = Readonly<{
  query<Row extends QueryResultRow = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}>;

type CustomerQueryDependencies = Readonly<{
  transaction: <T>(callback: (client: CustomerQueryClient) => Promise<T>) => Promise<T>;
}>;

type CustomerProfileRow = QueryResultRow & Readonly<{
  customer_id: string;
  license_namespace: LicenseNamespace;
  display_name: string | null;
  contact_email: string | null;
  profile_created_at: Date | string;
  profile_updated_at: Date | string;
  first_seen_at: Date | string | null;
  last_activity_at: Date | string | null;
  install_count: string | number | bigint;
  first_install_seen_at: Date | string | null;
  last_install_seen_at: Date | string | null;
  platform_summary: string | null;
  app_version_summary: string | null;
  entitlement_status: string | null;
  billing_model: string | null;
  first_paid_at: Date | string | null;
  last_paid_at: Date | string | null;
  first_upgraded_at: Date | string | null;
  last_upgraded_at: Date | string | null;
  commerce_synced_at: Date | string | null;
  first_download_attempt_at: Date | string | null;
  first_download_succeeded_at: Date | string | null;
  download_outcome_numerator: string | number | bigint | null;
  download_outcome_denominator: string | number | bigint | null;
  last_use_at: Date | string | null;
  active_days_7: string | number | bigint | null;
  active_days_30: string | number | bigint | null;
  download_frequency_30d: string | number | null;
  usage_synced_at: Date | string | null;
  usage_source_freshness_at: Date | string | null;
  data_quality_flags: string[];
  sort_activity_at: Date | string;
}>;

type CustomerMoneyRow = QueryResultRow & Readonly<{
  customer_id: string;
  currency: string;
  gross_paid_minor: string | number | bigint;
  off_stripe_paid_minor: string | number | bigint;
  refunded_minor: string | number | bigint;
  disputed_minor: string | number | bigint;
  net_paid_minor: string | number | bigint;
  paid_transaction_count: string | number | bigint;
  first_paid_at: Date | string | null;
  last_paid_at: Date | string | null;
  materialized_at: Date | string;
}>;

export type CustomerQueryResult = Readonly<{
  customerId: string;
  licenseNamespace: LicenseNamespace;
  name: string | null;
  email: string | null;
  profileLifecycle: Readonly<{
    createdAt: string;
    updatedAt: string;
    firstSeenAt: string | null;
    lastActivityAt: string | null;
  }>;
  installLifecycle: Readonly<{
    installCount: string;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    platform: string | null;
    appVersion: string | null;
  }>;
  billingModel: string | null;
  entitlementStatus: string | null;
  firstPaidAt: string | null;
  lastPaidAt: string | null;
  firstUpgradedAt: string | null;
  lastUpgradedAt: string | null;
  commerceSyncedAt: string | null;
  money: readonly Readonly<{
    currency: string;
    grossPaidMinor: string;
    offStripePaidMinor: string;
    refundedMinor: string;
    disputedMinor: string;
    netPaidMinor: string;
    paidTransactionCount: string;
    firstPaidAt: string | null;
    lastPaidAt: string | null;
    materializedAt: string;
  }>[];
  usage: Readonly<{
    firstDownloadAttemptAt: string | null;
    firstDownloadSucceededAt: string | null;
    downloadOutcomeNumerator: string | null;
    downloadOutcomeDenominator: string | null;
    lastUseAt: string | null;
    activeDays7: string | null;
    activeDays30: string | null;
    downloadFrequency30d: string | null;
    syncedAt: string | null;
    sourceFreshnessAt: string | null;
  }>;
  dataQualityFlags: readonly string[];
}>;

export class CustomerQueryValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CustomerQueryValidationError";
    this.code = code;
  }
}

const defaultDependencies: CustomerQueryDependencies = {
  transaction: (callback) => withPostgresTransaction(callback, {
    isolationLevel: "repeatable read",
    readOnly: true,
  }),
};

const PROFILE_COLUMNS = `
  customer_id,
  license_namespace,
  display_name,
  contact_email,
  profile_created_at,
  profile_updated_at,
  first_seen_at,
  last_activity_at,
  install_count,
  first_install_seen_at,
  last_install_seen_at,
  platform_summary,
  app_version_summary,
  entitlement_status,
  billing_model,
  first_paid_at,
  last_paid_at,
  first_upgraded_at,
  last_upgraded_at,
  commerce_synced_at,
  first_download_attempt_at,
  first_download_succeeded_at,
  download_outcome_numerator,
  download_outcome_denominator,
  last_use_at,
  active_days_7,
  active_days_30,
  download_frequency_30d,
  usage_synced_at,
  usage_source_freshness_at,
  data_quality_flags,
  sort_activity_at`;

const MONEY_COLUMNS = `
  customer_id,
  currency,
  gross_paid_minor,
  off_stripe_paid_minor,
  refunded_minor,
  disputed_minor,
  net_paid_minor,
  paid_transaction_count,
  first_paid_at,
  last_paid_at,
  materialized_at`;

export async function queryCustomerList(
  request: unknown,
  cursorSecret: string,
  overrides: Partial<CustomerQueryDependencies> = {},
) {
  const input = parseCustomerListInput(request, cursorSecret);
  const dependencies = { ...defaultDependencies, ...overrides };

  return dependencies.transaction(async (client) => {
    const profileResult = await client.query<CustomerProfileRow>(`
      select ${PROFILE_COLUMNS}
      from public.sidestream_customer_360_profile_read_model()
      where license_namespace = $1
        and ($2::text is null or billing_model = $2)
        and ($3::text is null or entitlement_status = $3)
        and (
          $4::boolean is null
          or ($4 and contact_email is not null)
          or (not $4 and contact_email is null)
        )
        and ($5::timestamptz is null or last_activity_at >= $5)
        and ($6::text is null or $6 = any(data_quality_flags))
        and (
          $7::timestamptz is null
          or (sort_activity_at, profile_created_at, customer_id) <
            ($7::timestamptz, $8::timestamptz, $9::uuid)
        )
      order by sort_activity_at desc, profile_created_at desc, customer_id desc
      limit $10
    `, [
      input.licenseNamespace,
      input.filters.billingModel,
      input.filters.entitlementStatus,
      input.filters.hasEmail,
      input.filters.activeSince,
      input.filters.dataQualityFlag,
      input.cursor?.sortActivityAt || null,
      input.cursor?.profileCreatedAt || null,
      input.cursor?.customerId || null,
      input.limit + 1,
    ]);

    const hasMore = profileResult.rows.length > input.limit;
    const rows = profileResult.rows.slice(0, input.limit);
    const moneyByCustomer = await loadMoney(client, rows.map((row) => row.customer_id));
    const customers = rows.map((row) => formatCustomer(
      row,
      moneyByCustomer.get(row.customer_id) || [],
    ));
    const last = hasMore ? rows.at(-1) : null;
    return {
      customers,
      nextCursor: last ? encodeCustomerCursor({
        v: CURSOR_VERSION,
        filterHash: input.filterHash,
        sortActivityAt: toIsoString(last.sort_activity_at),
        profileCreatedAt: toIsoString(last.profile_created_at),
        customerId: last.customer_id,
      }, cursorSecret) : null,
    };
  });
}

export async function queryCustomerDetail(
  customerId: string,
  request: unknown,
  overrides: Partial<CustomerQueryDependencies> = {},
) {
  const normalizedCustomerId = normalizeCustomerId(customerId);
  const licenseNamespace = parseDetailInput(request);
  const dependencies = { ...defaultDependencies, ...overrides };

  return dependencies.transaction(async (client) => {
    const profileResult = await client.query<CustomerProfileRow>(`
      select ${PROFILE_COLUMNS}
      from public.sidestream_customer_360_profile_read_model()
      where license_namespace = $1 and customer_id = $2::uuid
      limit 1
    `, [licenseNamespace, normalizedCustomerId]);
    const row = profileResult.rows[0];
    if (!row) return null;
    const moneyByCustomer = await loadMoney(client, [row.customer_id]);
    return formatCustomer(row, moneyByCustomer.get(row.customer_id) || []);
  });
}

function parseCustomerListInput(
  request: unknown,
  cursorSecret: string,
): CustomerListInput {
  const body = requireRecord(request, "request body");
  rejectUnknownKeys(body, ["licenseNamespace", "limit", "cursor", "filters"]);
  const licenseNamespace = parseLicenseNamespace(body.licenseNamespace);
  const limit = parseLimit(body.limit);
  const filters = parseFilters(body.filters);
  const filterHash = createHash("sha256").update(JSON.stringify({
    licenseNamespace,
    limit,
    filters,
  })).digest("hex");
  const cursor = body.cursor === undefined || body.cursor === null
    ? null
    : decodeCustomerCursor(body.cursor, cursorSecret, filterHash);
  return { licenseNamespace, limit, filters, cursor, filterHash };
}

function parseDetailInput(request: unknown) {
  const body = requireRecord(request, "request body");
  rejectUnknownKeys(body, ["licenseNamespace"]);
  return parseLicenseNamespace(body.licenseNamespace);
}

function parseLicenseNamespace(value: unknown): LicenseNamespace {
  if (value !== "production" && value !== "test") {
    throw new CustomerQueryValidationError(
      "invalid_namespace",
      "licenseNamespace must be production or test",
    );
  }
  return value;
}

function parseLimit(value: unknown) {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > MAX_LIMIT) {
    throw new CustomerQueryValidationError(
      "invalid_limit",
      `limit must be an integer between 1 and ${MAX_LIMIT}`,
    );
  }
  return Number(value);
}

function parseFilters(value: unknown): CustomerListFilters {
  if (value === undefined) {
    return {
      billingModel: null,
      entitlementStatus: null,
      hasEmail: null,
      activeSince: null,
      dataQualityFlag: null,
    };
  }
  const filters = requireRecord(value, "filters");
  rejectUnknownKeys(filters, [
    "billingModel",
    "entitlementStatus",
    "hasEmail",
    "activeSince",
    "dataQualityFlag",
  ]);

  const billingModel = filters.billingModel === undefined ? null : filters.billingModel;
  if (billingModel !== null && (
    typeof billingModel !== "string" || !BILLING_MODELS.has(billingModel)
  )) {
    throw new CustomerQueryValidationError("invalid_filter", "billingModel is invalid");
  }
  const entitlementStatus = filters.entitlementStatus === undefined
    ? null
    : filters.entitlementStatus;
  if (entitlementStatus !== null && (
    typeof entitlementStatus !== "string" || !ENTITLEMENT_PATTERN.test(entitlementStatus)
  )) {
    throw new CustomerQueryValidationError("invalid_filter", "entitlementStatus is invalid");
  }
  const hasEmail = filters.hasEmail === undefined ? null : filters.hasEmail;
  if (hasEmail !== null && typeof hasEmail !== "boolean") {
    throw new CustomerQueryValidationError("invalid_filter", "hasEmail must be boolean");
  }
  const activeSince = filters.activeSince === undefined
    ? null
    : normalizeTimestamp(filters.activeSince, "activeSince");
  const dataQualityFlag = filters.dataQualityFlag === undefined
    ? null
    : filters.dataQualityFlag;
  if (dataQualityFlag !== null && (
    typeof dataQualityFlag !== "string" || !DATA_QUALITY_FLAGS.has(dataQualityFlag)
  )) {
    throw new CustomerQueryValidationError("invalid_filter", "dataQualityFlag is invalid");
  }
  return {
    billingModel,
    entitlementStatus,
    hasEmail,
    activeSince,
    dataQualityFlag,
  };
}

function normalizeCustomerId(value: unknown) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new CustomerQueryValidationError("invalid_customer_id", "customerId must be a UUID");
  }
  return value.toLowerCase();
}

function normalizeTimestamp(value: unknown, name: string) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    throw new CustomerQueryValidationError("invalid_filter", `${name} must be an ISO timestamp`);
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new CustomerQueryValidationError("invalid_filter", `${name} must be an ISO timestamp`);
  }
  return timestamp.toISOString();
}

function decodeCustomerCursor(
  value: unknown,
  secret: string,
  expectedFilterHash: string,
): CustomerCursor {
  try {
    if (
      typeof value !== "string" ||
      value.length < 3 ||
      value.length > MAX_CURSOR_LENGTH
    ) throw new Error("invalid cursor envelope");
    const segments = value.split(".");
    if (
      segments.length !== 2 ||
      !segments.every((segment) => /^[A-Za-z0-9_-]+$/.test(segment))
    ) throw new Error("invalid cursor envelope");
    const [payloadSegment, signatureSegment] = segments;
    const suppliedSignature = Buffer.from(signatureSegment, "base64url");
    const expectedSignature = createHmac("sha256", secret).update(payloadSegment).digest();
    if (
      suppliedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(suppliedSignature, expectedSignature)
    ) throw new Error("invalid cursor signature");
    const parsed = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid cursor payload");
    }
    const cursor = parsed as Partial<CustomerCursor>;
    if (
      cursor.v !== CURSOR_VERSION ||
      cursor.filterHash !== expectedFilterHash ||
      typeof cursor.sortActivityAt !== "string" ||
      typeof cursor.profileCreatedAt !== "string" ||
      typeof cursor.customerId !== "string"
    ) throw new Error("cursor filters do not match");
    return {
      v: CURSOR_VERSION,
      filterHash: expectedFilterHash,
      sortActivityAt: normalizeTimestamp(cursor.sortActivityAt, "cursor sortActivityAt"),
      profileCreatedAt: normalizeTimestamp(cursor.profileCreatedAt, "cursor profileCreatedAt"),
      customerId: normalizeCustomerId(cursor.customerId),
    };
  } catch {
    throw new CustomerQueryValidationError("invalid_cursor", "Cursor is invalid");
  }
}

function encodeCustomerCursor(cursor: CustomerCursor, secret: string) {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

async function loadMoney(
  client: CustomerQueryClient,
  customerIds: readonly string[],
) {
  const moneyByCustomer = new Map<string, CustomerMoneyRow[]>();
  if (customerIds.length === 0) return moneyByCustomer;
  const result = await client.query<CustomerMoneyRow>(`
    select ${MONEY_COLUMNS}
    from public.sidestream_customer_360_money_read_model()
    where customer_id = any($1::uuid[])
    order by customer_id, currency
  `, [customerIds]);
  for (const row of result.rows) {
    const rows = moneyByCustomer.get(row.customer_id) || [];
    rows.push(row);
    moneyByCustomer.set(row.customer_id, rows);
  }
  return moneyByCustomer;
}

function formatCustomer(
  row: CustomerProfileRow,
  moneyRows: readonly CustomerMoneyRow[],
): CustomerQueryResult {
  return {
    customerId: row.customer_id,
    licenseNamespace: row.license_namespace,
    name: row.display_name,
    email: row.contact_email,
    profileLifecycle: {
      createdAt: toIsoString(row.profile_created_at),
      updatedAt: toIsoString(row.profile_updated_at),
      firstSeenAt: toNullableIsoString(row.first_seen_at),
      lastActivityAt: toNullableIsoString(row.last_activity_at),
    },
    installLifecycle: {
      installCount: toDecimalString(row.install_count) || "0",
      firstSeenAt: toNullableIsoString(row.first_install_seen_at),
      lastSeenAt: toNullableIsoString(row.last_install_seen_at),
      platform: row.platform_summary,
      appVersion: row.app_version_summary,
    },
    billingModel: row.billing_model,
    entitlementStatus: row.entitlement_status,
    firstPaidAt: toNullableIsoString(row.first_paid_at),
    lastPaidAt: toNullableIsoString(row.last_paid_at),
    firstUpgradedAt: toNullableIsoString(row.first_upgraded_at),
    lastUpgradedAt: toNullableIsoString(row.last_upgraded_at),
    commerceSyncedAt: toNullableIsoString(row.commerce_synced_at),
    money: moneyRows.map((money) => ({
      currency: money.currency,
      grossPaidMinor: toDecimalString(money.gross_paid_minor) || "0",
      offStripePaidMinor: toDecimalString(money.off_stripe_paid_minor) || "0",
      refundedMinor: toDecimalString(money.refunded_minor) || "0",
      disputedMinor: toDecimalString(money.disputed_minor) || "0",
      netPaidMinor: toDecimalString(money.net_paid_minor) || "0",
      paidTransactionCount: toDecimalString(money.paid_transaction_count) || "0",
      firstPaidAt: toNullableIsoString(money.first_paid_at),
      lastPaidAt: toNullableIsoString(money.last_paid_at),
      materializedAt: toIsoString(money.materialized_at),
    })),
    usage: {
      firstDownloadAttemptAt: toNullableIsoString(row.first_download_attempt_at),
      firstDownloadSucceededAt: toNullableIsoString(row.first_download_succeeded_at),
      downloadOutcomeNumerator: toDecimalString(row.download_outcome_numerator),
      downloadOutcomeDenominator: toDecimalString(row.download_outcome_denominator),
      lastUseAt: toNullableIsoString(row.last_use_at),
      activeDays7: toDecimalString(row.active_days_7),
      activeDays30: toDecimalString(row.active_days_30),
      downloadFrequency30d: toDecimalString(row.download_frequency_30d),
      syncedAt: toNullableIsoString(row.usage_synced_at),
      sourceFreshnessAt: toNullableIsoString(row.usage_source_freshness_at),
    },
    dataQualityFlags: [...row.data_quality_flags],
  };
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CustomerQueryValidationError("invalid_request", `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new CustomerQueryValidationError("invalid_request", `Unknown field: ${unknown[0]}`);
  }
}

function toIsoString(value: Date | string) {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error("Customer read model returned an invalid date");
  return timestamp.toISOString();
}

function toNullableIsoString(value: Date | string | null) {
  return value === null ? null : toIsoString(value);
}

function toDecimalString(value: string | number | bigint | null) {
  return value === null ? null : String(value);
}

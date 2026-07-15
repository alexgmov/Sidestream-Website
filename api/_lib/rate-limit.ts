import { createHmac } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import { getPostgresPool } from "./postgres.js";

const RATE_LIMIT_TABLE = "public.sidestream_api_rate_limits";
const RATE_LIMIT_SECRET_ENV = "SIDESTREAM_RATE_LIMIT_HASH_SECRET";
const DEVELOPMENT_RATE_LIMIT_SECRET =
  "sidestream-rate-limit-development-only-secret";

export type RateLimitDimension = Readonly<{
  name: string;
  value: string;
  limit: number;
}>;

export type ConsumeRateLimitOptions = Readonly<{
  scope: string;
  dimensions: readonly RateLimitDimension[];
  windowSeconds: number;
  now?: Date;
  secret?: string;
  runner?: Pick<Pool | PoolClient, "query">;
}>;

export type RateLimitResult = Readonly<{
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAt: string;
}>;

type PreparedRateLimit = Readonly<{
  scope: string;
  entries: readonly Readonly<{
    dimensionHash: string;
    maxRequests: number;
  }>[];
  windowSeconds: number;
  windowStartedAt: string;
  windowExpiresAt: string;
  nowMs: number;
}>;

export function prepareRateLimitRequest(
  options: Omit<ConsumeRateLimitOptions, "runner">,
): PreparedRateLimit {
  const scope = normalizeScope(options.scope);
  const windowSeconds = requireBoundedInteger(
    options.windowSeconds,
    "Rate-limit window",
    1,
    86_400,
  );
  if (options.dimensions.length < 1 || options.dimensions.length > 8) {
    throw new TypeError("Rate limits require 1-8 dimensions");
  }

  const now = options.now || new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("Rate-limit time is invalid");
  const windowMs = windowSeconds * 1_000;
  const windowStartedAtMs = Math.floor(nowMs / windowMs) * windowMs;
  const windowExpiresAtMs = windowStartedAtMs + windowMs;
  const secret = options.secret || getRateLimitSecret();
  if (secret.length < 32) {
    throw new Error("Rate-limit HMAC secret must contain at least 32 characters");
  }

  const seenNames = new Set<string>();
  const entries = options.dimensions.map((dimension) => {
    const name = normalizeDimensionName(dimension.name);
    if (seenNames.has(name)) throw new TypeError("Rate-limit dimension names must be unique");
    seenNames.add(name);
    const value = normalizeDimensionValue(dimension.value);
    const maxRequests = requireBoundedInteger(
      dimension.limit,
      "Rate-limit request count",
      1,
      100_000,
    );
    const dimensionHash = createHmac("sha256", secret)
      .update("sidestream-rate-limit-v1\0")
      .update(scope)
      .update("\0")
      .update(name)
      .update("\0")
      .update(value)
      .digest("hex");
    return Object.freeze({ dimensionHash, maxRequests });
  });

  return Object.freeze({
    scope,
    entries: Object.freeze(entries),
    windowSeconds,
    windowStartedAt: new Date(windowStartedAtMs).toISOString(),
    windowExpiresAt: new Date(windowExpiresAtMs).toISOString(),
    nowMs,
  });
}

export async function consumeRateLimit(
  options: ConsumeRateLimitOptions,
): Promise<RateLimitResult> {
  const prepared = prepareRateLimitRequest(options);
  const runner = options.runner || getPostgresPool();
  const result = await runner.query<{
    dimension_hash: string;
    max_requests: number;
    request_count: number;
  }>(
    `
      with requested as (
        select dimension_hash, max_requests
        from jsonb_to_recordset($1::jsonb)
          as request(dimension_hash text, max_requests integer)
      ), consumed as (
        insert into ${RATE_LIMIT_TABLE} as rate_limit (
          scope,
          dimension_hash,
          window_started_at,
          window_seconds,
          request_count,
          expires_at,
          created_at,
          updated_at
        )
        select $2, dimension_hash, $3::timestamptz, $4, 1, $5::timestamptz, $6::timestamptz, $6::timestamptz
        from requested
        on conflict (scope, dimension_hash, window_started_at, window_seconds)
        do update set
          request_count = rate_limit.request_count + 1,
          updated_at = excluded.updated_at
        returning dimension_hash, request_count
      )
      select requested.dimension_hash, requested.max_requests, consumed.request_count
      from requested
      join consumed using (dimension_hash)
      order by requested.dimension_hash
    `,
    [
      JSON.stringify(prepared.entries.map((entry) => ({
        dimension_hash: entry.dimensionHash,
        max_requests: entry.maxRequests,
      }))),
      prepared.scope,
      prepared.windowStartedAt,
      prepared.windowSeconds,
      prepared.windowExpiresAt,
      new Date(prepared.nowMs).toISOString(),
    ],
  );

  if (result.rows.length !== prepared.entries.length) {
    throw new Error("Rate-limit update did not consume every dimension");
  }
  const allowed = result.rows.every((row) => row.request_count <= row.max_requests);
  const limit = Math.min(...result.rows.map((row) => row.max_requests));
  const remaining = Math.max(
    0,
    Math.min(...result.rows.map((row) => row.max_requests - row.request_count)),
  );
  const retryAfterSeconds = allowed
    ? 0
    : Math.max(
        1,
        Math.ceil((new Date(prepared.windowExpiresAt).getTime() - prepared.nowMs) / 1_000),
      );

  return Object.freeze({
    allowed,
    limit,
    remaining,
    retryAfterSeconds,
    resetAt: prepared.windowExpiresAt,
  });
}

export function applyRateLimitHeaders(
  response: Pick<ServerResponse, "setHeader">,
  result: RateLimitResult,
) {
  response.setHeader("RateLimit-Limit", String(result.limit));
  response.setHeader("RateLimit-Remaining", String(result.remaining));
  response.setHeader("RateLimit-Reset", result.resetAt);
  if (!result.allowed) {
    response.setHeader("Retry-After", String(result.retryAfterSeconds));
  }
}

export function sendRateLimitExceeded(
  response: ServerResponse,
  result: RateLimitResult,
) {
  applyRateLimitHeaders(response, result);
  response.statusCode = 429;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify({
    error: "Too many requests",
    code: "rate_limited",
    retryAfterSeconds: result.retryAfterSeconds,
  }));
}

function getRateLimitSecret() {
  const secret = process.env[RATE_LIMIT_SECRET_ENV]?.trim() || "";
  if (secret.length >= 32) return secret;
  if (process.env.VERCEL_ENV === "development" || process.env.NODE_ENV === "test") {
    return DEVELOPMENT_RATE_LIMIT_SECRET;
  }
  throw new Error(`Missing or weak ${RATE_LIMIT_SECRET_ENV}; expected at least 32 characters`);
}

function normalizeScope(value: string) {
  const scope = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9:_-]{0,63}$/.test(scope)) {
    throw new TypeError("Rate-limit scope is invalid");
  }
  return scope;
}

function normalizeDimensionName(value: string) {
  const name = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
    throw new TypeError("Rate-limit dimension name is invalid");
  }
  return name;
}

function normalizeDimensionValue(value: string) {
  if (typeof value !== "string") throw new TypeError("Rate-limit dimension value is invalid");
  const normalized = value.trim().normalize("NFKC");
  if (!normalized || normalized.length > 2_048) {
    throw new TypeError("Rate-limit dimension value is invalid");
  }
  return normalized;
}

function requireBoundedInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

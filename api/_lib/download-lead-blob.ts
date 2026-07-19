import {
  BlobError,
  BlobPreconditionFailedError,
  get,
  put,
} from "@vercel/blob";
import {
  MAX_REPLAY_BLOB_BYTES,
  mergeFallbackLeads,
  parseReplayBlob,
  serializeFallbackLead,
  type CanonicalDownloadLead,
} from "./download-leads.js";
import {
  prepareRateLimitRequest,
  type ConsumeRateLimitOptions,
  type RateLimitResult,
} from "./rate-limit.js";

const MAX_RATE_LIMIT_BLOB_BYTES = 2 * 1024;
const RATE_LIMIT_BLOB_PREFIX = "sidestream/rate-limits/v1";
const MAX_BLOB_WRITE_ATTEMPTS = 5;

type RateLimitBlobRecord = Readonly<{
  version: 1;
  windowStartedAt: string;
  windowSeconds: number;
  requestCount: number;
  expiresAt: string;
}>;

export async function consumeBlobRateLimit(
  options: Omit<ConsumeRateLimitOptions, "runner">,
): Promise<RateLimitResult> {
  const prepared = prepareRateLimitRequest(options);
  const counts: number[] = [];

  for (const entry of prepared.entries) {
    const pathname = [
      RATE_LIMIT_BLOB_PREFIX,
      prepared.scope,
      String(new Date(prepared.windowStartedAt).getTime()),
      `${entry.dimensionHash}.json`,
    ].join("/");
    counts.push(await incrementRateLimitBlob(pathname, {
      version: 1,
      windowStartedAt: prepared.windowStartedAt,
      windowSeconds: prepared.windowSeconds,
      requestCount: 1,
      expiresAt: prepared.windowExpiresAt,
    }));
  }

  const allowed = counts.every(
    (count, index) => count <= prepared.entries[index].maxRequests,
  );
  const limit = Math.min(...prepared.entries.map((entry) => entry.maxRequests));
  const remaining = Math.max(
    0,
    Math.min(
      ...prepared.entries.map((entry, index) => entry.maxRequests - counts[index]),
    ),
  );
  const retryAfterSeconds = allowed
    ? 0
    : Math.max(
        1,
        Math.ceil(
          (new Date(prepared.windowExpiresAt).getTime() - prepared.nowMs) / 1_000,
        ),
      );

  return Object.freeze({
    allowed,
    limit,
    remaining,
    retryAfterSeconds,
    resetAt: prepared.windowExpiresAt,
  });
}

export async function writeDeterministicDownloadLeadFallback(
  pathname: string,
  incoming: CanonicalDownloadLead,
) {
  for (let attempt = 0; attempt < MAX_BLOB_WRITE_ATTEMPTS; attempt += 1) {
    const current = await get(pathname, { access: "private", useCache: false });
    if (!current) {
      try {
        await put(pathname, serializeFallbackLead(incoming), {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: false,
          contentType: "application/json; charset=utf-8",
          cacheControlMaxAge: 60,
        });
        return;
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) continue;
        throw error;
      }
    }
    if (current.statusCode !== 200 || !current.stream) {
      throw new BlobError("Fallback Blob could not be read consistently");
    }
    if (current.blob.size > MAX_REPLAY_BLOB_BYTES) {
      throw new BlobError("Fallback Blob exceeds the bounded replay size");
    }
    const existing = parseReplayBlob(await new Response(current.stream).text(), {
      uploadedAt: current.blob.uploadedAt,
    });
    const merged = mergeFallbackLeads(existing, incoming);
    if (merged === existing) return;
    try {
      await put(pathname, serializeFallbackLead(merged), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        ifMatch: current.blob.etag,
        contentType: "application/json; charset=utf-8",
        cacheControlMaxAge: 60,
      });
      return;
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) continue;
      throw error;
    }
  }
  throw new BlobError("Fallback Blob could not be updated consistently");
}

async function incrementRateLimitBlob(
  pathname: string,
  initial: RateLimitBlobRecord,
) {
  for (let attempt = 0; attempt < MAX_BLOB_WRITE_ATTEMPTS; attempt += 1) {
    const current = await get(pathname, { access: "private", useCache: false });
    if (!current) {
      try {
        await put(pathname, JSON.stringify(initial), {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: false,
          contentType: "application/json; charset=utf-8",
          cacheControlMaxAge: 60,
        });
        return 1;
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) continue;
        throw error;
      }
    }
    if (
      current.statusCode !== 200 ||
      !current.stream ||
      current.blob.size > MAX_RATE_LIMIT_BLOB_BYTES
    ) {
      throw new BlobError("Rate-limit Blob could not be read consistently");
    }
    const existing = parseRateLimitBlob(
      await new Response(current.stream).text(),
      initial,
    );
    const next = Object.freeze({
      ...existing,
      requestCount: existing.requestCount + 1,
    });
    try {
      await put(pathname, JSON.stringify(next), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        ifMatch: current.blob.etag,
        contentType: "application/json; charset=utf-8",
        cacheControlMaxAge: 60,
      });
      return next.requestCount;
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) continue;
      throw error;
    }
  }
  throw new BlobError("Rate-limit Blob could not be updated consistently");
}

function parseRateLimitBlob(body: string, expected: RateLimitBlobRecord) {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new BlobError("Rate-limit Blob contains invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BlobError("Rate-limit Blob contains an invalid record");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    record.windowStartedAt !== expected.windowStartedAt ||
    record.windowSeconds !== expected.windowSeconds ||
    record.expiresAt !== expected.expiresAt ||
    !Number.isSafeInteger(record.requestCount) ||
    Number(record.requestCount) < 1 ||
    Number(record.requestCount) >= 1_000_000
  ) {
    throw new BlobError("Rate-limit Blob contains an invalid record");
  }
  return Object.freeze({
    version: 1 as const,
    windowStartedAt: String(record.windowStartedAt),
    windowSeconds: Number(record.windowSeconds),
    requestCount: Number(record.requestCount),
    expiresAt: String(record.expiresAt),
  });
}

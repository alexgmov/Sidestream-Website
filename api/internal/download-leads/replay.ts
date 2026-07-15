import { del, get, list, type ListBlobResultBlob } from "@vercel/blob";
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PoolClient } from "pg";
import {
  classifyLeadBlobPathname,
  createReplayReceiptHash,
  DownloadLeadConfigurationError,
  DownloadLeadValidationError,
  getDownloadLeadBlobPrefix,
  getDownloadLeadHashSecret,
  getDeterministicLeadBlobPathname,
  MAX_REPLAY_BLOB_BYTES,
  parseReplayBlob,
  upsertCanonicalDownloadLead,
  type CanonicalDownloadLead,
  type DownloadLeadUpsertResult,
} from "../../_lib/download-leads.js";
import {
  withPostgresTransaction,
} from "../../_lib/postgres.js";

const REPLAY_SECRET_ENV = "SIDESTREAM_DOWNLOAD_LEADS_REPLAY_SECRET";
const MAX_REPLAY_REQUEST_BYTES = 4 * 1024;
const DEFAULT_REPLAY_BATCH_SIZE = 25;
const MAX_REPLAY_BATCH_SIZE = 100;

type ReplayRequest = IncomingMessage & { method?: string };
type TransactionRunner = <T>(
  callback: (client: PoolClient) => Promise<T>,
) => Promise<T>;

type ReplayPage = Readonly<{
  blobs: readonly ListBlobResultBlob[];
  cursor?: string;
  hasMore: boolean;
}>;

type ReplaySummary = {
  listed: number;
  mapped: number;
  replayed: number;
  idempotent: number;
  malformed: number;
  unmapped: number;
  readFailed: number;
  databaseFailed: number;
  deleted: number;
  deleteFailed: number;
};

type ReplayDependencies = Readonly<{
  getReplaySecret: () => string;
  listPage: (input: {
    prefix: string;
    cursor?: string;
    limit: number;
  }) => Promise<ReplayPage>;
  readBlob: (blob: ListBlobResultBlob) => Promise<string>;
  transaction: TransactionRunner;
  upsertLead: (
    client: PoolClient,
    lead: CanonicalDownloadLead,
    options: { replayReceiptHash: string; migratedBlobPathname: string },
  ) => Promise<DownloadLeadUpsertResult>;
  deleteBlob: (blob: ListBlobResultBlob) => Promise<void>;
  log: (entry: Record<string, string | number>) => void;
}>;

const defaultDependencies: ReplayDependencies = {
  getReplaySecret,
  listPage: async ({ prefix, cursor, limit }) => list({ prefix, cursor, limit }),
  readBlob: async (blob) => {
    if (blob.size > MAX_REPLAY_BLOB_BYTES) {
      throw new DownloadLeadValidationError("blob_too_large", "Replay Blob is too large");
    }
    const result = await get(blob.pathname, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) {
      throw new Error("Replay Blob could not be read");
    }
    if (result.blob.size > MAX_REPLAY_BLOB_BYTES) {
      throw new DownloadLeadValidationError("blob_too_large", "Replay Blob is too large");
    }
    return new Response(result.stream).text();
  },
  transaction: (callback) => withPostgresTransaction(callback),
  upsertLead: (client, lead, options) =>
    upsertCanonicalDownloadLead(client, lead, options),
  deleteBlob: async (blob) => {
    await del(blob.pathname, { ifMatch: blob.etag });
  },
  log: (entry) => console.info(JSON.stringify(entry)),
};

export function createDownloadLeadReplayHandler(
  overrides: Partial<ReplayDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };

  return async function replayDownloadLeads(
    request: ReplayRequest,
    response: ServerResponse,
  ) {
    if ((request.method || "GET").toUpperCase() !== "POST") {
      response.setHeader("Allow", "POST");
      return sendJson(response, 405, { error: "Method not allowed" });
    }

    let replaySecret: string;
    try {
      replaySecret = dependencies.getReplaySecret();
    } catch (error) {
      dependencies.log({
        event: "download_lead_replay",
        outcome: "configuration_error",
        count: 1,
      });
      return sendJson(response, 503, {
        error: "Replay is not configured",
        code: "replay_unavailable",
      });
    }
    if (!isAuthorized(request, replaySecret)) {
      return sendJson(response, 401, {
        error: "Unauthorized",
        code: "unauthorized",
      });
    }

    if (!isJsonContentType(firstHeaderValue(request.headers["content-type"]))) {
      return sendJson(response, 415, {
        error: "Content-Type must be application/json",
        code: "unsupported_media_type",
      });
    }

    let input: { cursor?: string; limit: number; disposition: "preserve" | "delete" };
    try {
      input = parseReplayInput(
        JSON.parse(await readRequestBody(request, MAX_REPLAY_REQUEST_BYTES)),
      );
    } catch (error) {
      return sendJson(response, 400, {
        error: "Invalid replay request",
        code: error instanceof DownloadLeadValidationError
          ? error.code
          : "invalid_json",
      });
    }

    let prefix: string;
    let leadSecret: string;
    try {
      prefix = getDownloadLeadBlobPrefix();
      leadSecret = getDownloadLeadHashSecret();
    } catch (error) {
      if (!(error instanceof DownloadLeadConfigurationError)) throw error;
      dependencies.log({
        event: "download_lead_replay",
        outcome: "configuration_error",
        count: 1,
      });
      return sendJson(response, 503, {
        error: "Replay is not configured",
        code: "replay_unavailable",
      });
    }

    let page: ReplayPage;
    try {
      page = await dependencies.listPage({
        prefix: `${prefix}/`,
        cursor: input.cursor,
        limit: input.limit,
      });
    } catch (error) {
      dependencies.log({
        event: "download_lead_replay",
        outcome: "list_failed",
        count: 1,
        blobCode: safeOperationalErrorCode(error),
      });
      return sendJson(response, 503, {
        error: "Replay storage is temporarily unavailable",
        code: "blob_unavailable",
      });
    }
    if (page.blobs.length > input.limit) {
      dependencies.log({
        event: "download_lead_replay",
        outcome: "invalid_list_page",
        count: 1,
      });
      return sendJson(response, 503, {
        error: "Replay storage returned an invalid page",
        code: "invalid_blob_page",
      });
    }

    const summary: ReplaySummary = {
      listed: page.blobs.length,
      mapped: 0,
      replayed: 0,
      idempotent: 0,
      malformed: 0,
      unmapped: 0,
      readFailed: 0,
      databaseFailed: 0,
      deleted: 0,
      deleteFailed: 0,
    };

    for (const blob of page.blobs) {
      const pathKind = classifyLeadBlobPathname(blob.pathname, prefix);
      if (pathKind === "unmapped") {
        summary.unmapped += 1;
        continue;
      }
      summary.mapped += 1;

      let lead: CanonicalDownloadLead;
      try {
        const text = await dependencies.readBlob(blob);
        lead = parseReplayBlob(text, { uploadedAt: blob.uploadedAt, secret: leadSecret });
        if (
          pathKind === "canonical-v2" &&
          blob.pathname !== getDeterministicLeadBlobPathname(lead.leadKey, prefix)
        ) {
          throw new DownloadLeadValidationError(
            "blob_identity_mismatch",
            "Replay Blob identity does not match its pathname",
          );
        }
      } catch (error) {
        if (error instanceof DownloadLeadValidationError) summary.malformed += 1;
        else summary.readFailed += 1;
        continue;
      }

      let committed = false;
      try {
        const replayReceiptHash = createReplayReceiptHash(blob.pathname, leadSecret);
        const result = await dependencies.transaction((client) =>
          dependencies.upsertLead(client, lead, {
            replayReceiptHash,
            migratedBlobPathname: blob.pathname,
          })
        );
        committed = true;
        if (result.outcome === "idempotent") summary.idempotent += 1;
        else summary.replayed += 1;
      } catch {
        summary.databaseFailed += 1;
      }

      if (!committed || input.disposition !== "delete") continue;
      try {
        await dependencies.deleteBlob(blob);
        summary.deleted += 1;
      } catch {
        summary.deleteFailed += 1;
      }
    }

    dependencies.log({
      event: "download_lead_replay",
      outcome: "batch_complete",
      ...summary,
    });
    const nextCursor = page.hasMore && page.cursor ? page.cursor : null;
    return sendJson(response, 200, {
      ok: true,
      summary,
      nextCursor,
      hasMore: Boolean(nextCursor),
    });
  };
}

const handler = createDownloadLeadReplayHandler();
export default handler;

export function parseReplayInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DownloadLeadValidationError("invalid_request", "Replay input is invalid");
  }
  const record = value as Record<string, unknown>;
  const cursor = record.cursor;
  if (
    cursor !== undefined &&
    (typeof cursor !== "string" ||
      cursor.length < 1 ||
      cursor.length > 1_024 ||
      !/^[A-Za-z0-9._~+/=-]+$/.test(cursor))
  ) {
    throw new DownloadLeadValidationError("invalid_cursor", "Replay cursor is invalid");
  }
  const limit = record.limit === undefined ? DEFAULT_REPLAY_BATCH_SIZE : record.limit;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > MAX_REPLAY_BATCH_SIZE) {
    throw new DownloadLeadValidationError("invalid_limit", "Replay limit is invalid");
  }
  const disposition = record.disposition === undefined ? "preserve" : record.disposition;
  if (disposition !== "preserve" && disposition !== "delete") {
    throw new DownloadLeadValidationError(
      "invalid_disposition",
      "Replay disposition is invalid",
    );
  }
  return {
    cursor: cursor as string | undefined,
    limit: Number(limit),
    disposition: disposition as "preserve" | "delete",
  };
}

function getReplaySecret() {
  const secret = process.env[REPLAY_SECRET_ENV]?.trim() || "";
  if (secret.length < 32 || secret.length > 512) {
    throw new DownloadLeadConfigurationError(
      `Missing or weak ${REPLAY_SECRET_ENV}; expected at least 32 characters`,
    );
  }
  return secret;
}

function isAuthorized(request: IncomingMessage, expectedSecret: string) {
  const authorization = firstHeaderValue(request.headers.authorization);
  const match = authorization.match(/^Bearer ([\x21-\x7e]{1,512})$/);
  if (!match) return false;
  const expected = createHash("sha256").update(expectedSecret).digest();
  const supplied = createHash("sha256").update(match[1]).digest();
  return timingSafeEqual(expected, supplied);
}

function isJsonContentType(value: string) {
  return value.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function readRequestBody(request: IncomingMessage, maxBytes: number) {
  const contentLength = firstHeaderValue(request.headers["content-length"]);
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    throw new DownloadLeadValidationError("invalid_body_size", "Replay body is invalid");
  }
  return new Promise<string>((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let settled = false;
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        settled = true;
        reject(new DownloadLeadValidationError("invalid_body_size", "Replay body is invalid"));
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(body);
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function safeOperationalErrorCode(error: unknown) {
  const name = error instanceof Error ? error.name : "operation_error";
  return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? name : "operation_error";
}

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(payload));
}

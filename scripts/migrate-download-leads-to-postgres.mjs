import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_PAGES = 100;
const MAX_PAGES = 10_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const REPLAY_ROUTE = "/api/internal/download-leads/replay";
const REPLAY_SECRET_ENV = "SIDESTREAM_DOWNLOAD_LEADS_REPLAY_SECRET";

class ReplayCliError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReplayCliError";
    this.code = code;
  }
}

export function parseArguments(argv) {
  const options = {
    selfTest: false,
    batchSize: DEFAULT_BATCH_SIZE,
    maxPages: DEFAULT_MAX_PAGES,
    disposition: "preserve",
    endpoint: "",
    legacyApplySchemaRequested: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--self-test") {
      options.selfTest = true;
    } else if (argument === "--delete-after-commit") {
      options.disposition = "delete";
    } else if (argument === "--preserve") {
      options.disposition = "preserve";
    } else if (argument === "--apply-schema") {
      options.legacyApplySchemaRequested = true;
    } else if (argument === "--batch-size") {
      options.batchSize = parseBoundedInteger(
        argv[++index],
        "invalid_batch_size",
        1,
        MAX_BATCH_SIZE,
      );
    } else if (argument.startsWith("--batch-size=")) {
      options.batchSize = parseBoundedInteger(
        argument.slice("--batch-size=".length),
        "invalid_batch_size",
        1,
        MAX_BATCH_SIZE,
      );
    } else if (argument === "--max-pages") {
      options.maxPages = parseBoundedInteger(
        argv[++index],
        "invalid_max_pages",
        1,
        MAX_PAGES,
      );
    } else if (argument.startsWith("--max-pages=")) {
      options.maxPages = parseBoundedInteger(
        argument.slice("--max-pages=".length),
        "invalid_max_pages",
        1,
        MAX_PAGES,
      );
    } else if (argument === "--endpoint") {
      options.endpoint = requireOptionValue(argv[++index], "missing_endpoint");
    } else if (argument.startsWith("--endpoint=")) {
      options.endpoint = requireOptionValue(
        argument.slice("--endpoint=".length),
        "missing_endpoint",
      );
    } else {
      throw new ReplayCliError("unknown_option");
    }
  }

  return options;
}

export async function runReplay(options, dependencies = {}) {
  const environment = dependencies.environment || process.env;
  const fetchImpl = dependencies.fetchImpl || fetch;
  const timeoutMs = dependencies.timeoutMs || DEFAULT_TIMEOUT_MS;
  const endpoint = resolveReplayEndpoint(options.endpoint, environment);
  const secret = String(environment[REPLAY_SECRET_ENV] || "").trim();
  if (secret.length < 32) throw new ReplayCliError("missing_replay_secret");
  if (options.legacyApplySchemaRequested) {
    throw new ReplayCliError("apply_schema_removed_use_db_migrate");
  }

  const totals = emptyTotals();
  let cursor;
  let hasMore = true;

  while (hasMore && totals.pages < options.maxPages) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          cursor,
          limit: options.batchSize,
          disposition: options.disposition,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ReplayCliError(error?.name === "AbortError" ? "request_timeout" : "request_failed");
    } finally {
      clearTimeout(timeout);
    }

    if (!response || !response.ok) {
      const status = Number(response?.status || 0);
      throw new ReplayCliError(
        status >= 400 && status <= 599 ? `replay_http_${status}` : "invalid_response",
      );
    }

    let body;
    try {
      body = await response.json();
    } catch {
      throw new ReplayCliError("invalid_response_json");
    }
    const page = validateReplayResponse(body);
    totals.pages += 1;
    for (const key of Object.keys(page.summary)) totals[key] += page.summary[key];

    hasMore = page.hasMore;
    if (hasMore) {
      if (!page.nextCursor || page.nextCursor === cursor) {
        throw new ReplayCliError("invalid_replay_cursor");
      }
      cursor = page.nextCursor;
    }
  }

  totals.truncated = hasMore;
  totals.partialFailures =
    totals.malformed +
      totals.unmapped +
      totals.readFailed +
      totals.databaseFailed +
      totals.deleteFailed >
    0;
  return totals;
}

export function resolveReplayEndpoint(explicitEndpoint, environment = process.env) {
  const configured = String(
    explicitEndpoint ||
      environment.SIDESTREAM_DOWNLOAD_LEADS_REPLAY_URL ||
      environment.SIDESTREAM_BASE_URL ||
      "",
  ).trim();
  if (!configured) throw new ReplayCliError("missing_endpoint");

  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new ReplayCliError("invalid_endpoint");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ReplayCliError("invalid_endpoint");
  }
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    throw new ReplayCliError("insecure_endpoint");
  }
  if (url.pathname === "/" || url.pathname === "") url.pathname = REPLAY_ROUTE;
  if (url.pathname !== REPLAY_ROUTE) throw new ReplayCliError("invalid_endpoint_path");
  return url.toString();
}

function validateReplayResponse(value) {
  if (!value || typeof value !== "object" || value.ok !== true) {
    throw new ReplayCliError("invalid_response_shape");
  }
  const hasMore = value.hasMore;
  const nextCursor = value.nextCursor;
  if (typeof hasMore !== "boolean") throw new ReplayCliError("invalid_response_shape");
  if (
    nextCursor !== null &&
    (typeof nextCursor !== "string" || nextCursor.length < 1 || nextCursor.length > 1_024)
  ) {
    throw new ReplayCliError("invalid_response_shape");
  }
  if (hasMore !== Boolean(nextCursor)) throw new ReplayCliError("invalid_response_shape");

  const expectedKeys = [
    "listed",
    "mapped",
    "replayed",
    "idempotent",
    "malformed",
    "unmapped",
    "readFailed",
    "databaseFailed",
    "deleted",
    "deleteFailed",
  ];
  if (!value.summary || typeof value.summary !== "object") {
    throw new ReplayCliError("invalid_response_shape");
  }
  const summary = {};
  for (const key of expectedKeys) {
    const count = value.summary[key];
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new ReplayCliError("invalid_response_shape");
    }
    summary[key] = count;
  }
  return { hasMore, nextCursor, summary };
}

function emptyTotals() {
  return {
    pages: 0,
    listed: 0,
    mapped: 0,
    replayed: 0,
    idempotent: 0,
    malformed: 0,
    unmapped: 0,
    readFailed: 0,
    databaseFailed: 0,
    deleted: 0,
    deleteFailed: 0,
    truncated: false,
    partialFailures: false,
  };
}

function parseBoundedInteger(value, code, minimum, maximum) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new ReplayCliError(code);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new ReplayCliError(code);
  }
  return number;
}

function requireOptionValue(value, code) {
  if (typeof value !== "string" || !value.trim()) throw new ReplayCliError(code);
  return value.trim();
}

async function selfTest() {
  const secret = "replay-self-test-secret-that-is-long-enough";
  const requests = [];
  const summaries = [
    {
      listed: 3,
      mapped: 2,
      replayed: 1,
      idempotent: 1,
      malformed: 0,
      unmapped: 1,
      readFailed: 0,
      databaseFailed: 0,
      deleted: 0,
      deleteFailed: 0,
    },
    {
      listed: 1,
      mapped: 1,
      replayed: 1,
      idempotent: 0,
      malformed: 0,
      unmapped: 0,
      readFailed: 0,
      databaseFailed: 0,
      deleted: 1,
      deleteFailed: 0,
    },
  ];
  const fetchImpl = async (_url, request) => {
    requests.push(JSON.parse(request.body));
    const index = requests.length - 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        summary: summaries[index],
        nextCursor: index === 0 ? "cursor-2" : null,
        hasMore: index === 0,
      }),
    };
  };
  const options = parseArguments([
    "--batch-size=10",
    "--max-pages",
    "3",
    "--delete-after-commit",
  ]);
  const result = await runReplay(options, {
    fetchImpl,
    environment: {
      SIDESTREAM_BASE_URL: "https://sidestream.example",
      [REPLAY_SECRET_ENV]: secret,
    },
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], {
    limit: 10,
    disposition: "delete",
  });
  assert.deepEqual(requests[1], {
    cursor: "cursor-2",
    limit: 10,
    disposition: "delete",
  });
  assert.equal(result.pages, 2);
  assert.equal(result.listed, 4);
  assert.equal(result.replayed, 2);
  assert.equal(result.idempotent, 1);
  assert.equal(result.unmapped, 1);
  assert.equal(result.deleted, 1);
  assert.equal(result.partialFailures, true);
  assert.throws(() => parseArguments(["--batch-size=101"]), /invalid_batch_size/);
  assert.throws(
    () => resolveReplayEndpoint("http://sidestream.example"),
    /insecure_endpoint/,
  );
  await assert.rejects(
    runReplay(parseArguments([]), {
      environment: {
        SIDESTREAM_BASE_URL: "https://sidestream.example",
        [REPLAY_SECRET_ENV]: secret,
      },
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        json: async () => ({ sensitiveBody: "must-not-be-read" }),
      }),
    }),
    /replay_http_500/,
  );
  return { assertions: 14, pages: result.pages };
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    if (options.selfTest) {
      const result = await selfTest();
      console.log(JSON.stringify({
        event: "download_lead_replay_self_test",
        outcome: "passed",
        ...result,
      }));
      return;
    }
    const result = await runReplay(options);
    console.log(JSON.stringify({
      event: "download_lead_replay_cli",
      outcome: result.truncated || result.partialFailures ? "incomplete" : "complete",
      ...result,
    }));
    if (result.truncated || result.partialFailures) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({
      event: "download_lead_replay_cli",
      outcome: "failed",
      code: error instanceof ReplayCliError ? error.code : "unexpected_error",
    }));
    process.exitCode = 1;
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryUrl) await main();

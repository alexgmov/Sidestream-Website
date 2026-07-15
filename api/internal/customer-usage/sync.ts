import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  runCustomerUsageSync,
  type CustomerUsageSyncSummary,
} from "../../_lib/customer-usage.js";

type CustomerUsageRouteDependencies = Readonly<{
  getCronSecret: () => string;
  runSync: () => Promise<CustomerUsageSyncSummary>;
  log: (entry: Readonly<{
    outcome: CustomerUsageSyncSummary["outcome"] | "failed";
    batches?: number;
    sourceRowsScanned?: number;
    dailyBucketsWritten?: number;
    profilesRefreshed?: number;
  }>) => void;
}>;

const defaultDependencies: CustomerUsageRouteDependencies = {
  getCronSecret: () => {
    const secret = process.env.CRON_SECRET?.trim() || "";
    if (secret.length < 16 || secret.length > 512) {
      throw new Error("CRON_SECRET is not configured");
    }
    return secret;
  },
  runSync: () => runCustomerUsageSync(),
  log: (entry) => {
    console.info("sidestream_customer_usage_sync", JSON.stringify(entry));
  },
};

export function createCustomerUsageSyncHandler(
  overrides: Partial<CustomerUsageRouteDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };

  return async function customerUsageSyncHandler(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    if ((request.method || "GET").toUpperCase() !== "GET") {
      response.setHeader("Allow", "GET");
      return sendJson(response, 405, { error: "Method not allowed" });
    }

    let secret: string;
    try {
      secret = dependencies.getCronSecret();
    } catch {
      return sendJson(response, 503, {
        error: "Customer usage sync is not configured",
        code: "customer_usage_sync_unavailable",
      });
    }
    if (!hasValidBearerSecret(request.headers.authorization, secret)) {
      return sendJson(response, 401, { error: "Unauthorized", code: "unauthorized" });
    }

    try {
      const summary = await dependencies.runSync();
      dependencies.log({
        outcome: summary.outcome,
        batches: summary.batches,
        sourceRowsScanned: summary.sourceRowsScanned,
        dailyBucketsWritten: summary.dailyBucketsWritten,
        profilesRefreshed: summary.profilesRefreshed,
      });
      return sendJson(response, 200, { ok: true, ...summary });
    } catch {
      dependencies.log({ outcome: "failed" });
      return sendJson(response, 500, {
        error: "Customer usage sync failed",
        code: "customer_usage_sync_failed",
      });
    }
  };
}

function hasValidBearerSecret(
  authorization: string | string[] | undefined,
  secret: string,
) {
  if (!authorization || Array.isArray(authorization)) return false;
  const actualDigest = createHash("sha256").update(authorization).digest();
  const expectedDigest = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

export default createCustomerUsageSyncHandler();

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  loadMaintenanceConfiguration,
  runMaintenanceJob,
  type MaintenanceConfiguration,
  type MaintenanceSummary,
} from "../_lib/maintenance.js";

type MaintenanceRouteDependencies = Readonly<{
  getCronSecret: () => string;
  getConfiguration: () => MaintenanceConfiguration;
  runJob: (configuration: MaintenanceConfiguration) => Promise<MaintenanceSummary>;
  log: (entry: MaintenanceLogEntry) => void;
  clock: () => number;
}>;

type MaintenanceLogEntry = Readonly<{
  outcome: "completed" | "locked" | "failed";
  durationMs: number;
  counts?: MaintenanceSummary["counts"];
}>;

const defaultDependencies: MaintenanceRouteDependencies = {
  getCronSecret: () => {
    const secret = process.env.CRON_SECRET?.trim() || "";
    if (secret.length < 16 || secret.length > 512) {
      throw new Error("CRON_SECRET is not configured");
    }
    return secret;
  },
  getConfiguration: () => loadMaintenanceConfiguration(),
  runJob: (configuration) => runMaintenanceJob({ config: configuration }),
  log: (entry) => {
    console.info("sidestream_maintenance", JSON.stringify(entry));
  },
  clock: Date.now,
};

export function createMaintenanceHandler(
  overrides: Partial<MaintenanceRouteDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };

  return async function maintenanceHandler(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    if ((request.method || "GET").toUpperCase() !== "GET") {
      response.setHeader("Allow", "GET");
      return sendJson(response, 405, { error: "Method not allowed" });
    }

    let cronSecret: string;
    try {
      cronSecret = dependencies.getCronSecret();
    } catch {
      return sendJson(response, 503, {
        error: "Maintenance is not configured",
        code: "maintenance_unavailable",
      });
    }
    if (!hasValidBearerSecret(request.headers.authorization, cronSecret)) {
      return sendJson(response, 401, {
        error: "Unauthorized",
        code: "unauthorized",
      });
    }

    let configuration: MaintenanceConfiguration;
    try {
      configuration = dependencies.getConfiguration();
    } catch {
      return sendJson(response, 503, {
        error: "Maintenance is not configured",
        code: "maintenance_unavailable",
      });
    }

    const startedAt = dependencies.clock();
    try {
      const summary = await dependencies.runJob(configuration);
      dependencies.log({
        outcome: summary.outcome,
        durationMs: summary.durationMs,
        counts: summary.counts,
      });
      return sendJson(response, 200, { ok: true, ...summary });
    } catch {
      dependencies.log({
        outcome: "failed",
        durationMs: Math.max(0, Math.round(dependencies.clock() - startedAt)),
      });
      return sendJson(response, 500, {
        error: "Maintenance failed",
        code: "maintenance_failed",
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

export default createMaintenanceHandler();

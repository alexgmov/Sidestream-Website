import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  runAnnualRenewalReminders,
  type AnnualRenewalReminderSummary,
} from "../_lib/annual-renewal-reminder.js";

type AnnualRenewalReminderRouteDependencies = Readonly<{
  getCronSecret: () => string;
  isEnabled: () => boolean;
  runJob: () => Promise<AnnualRenewalReminderSummary>;
  log: (entry: Readonly<
    AnnualRenewalReminderSummary | { outcome: "disabled" | "failed" }
  >) => void;
}>;

const defaultDependencies: AnnualRenewalReminderRouteDependencies = {
  getCronSecret: () => {
    const secret = process.env.CRON_SECRET?.trim() || "";
    if (secret.length < 16 || secret.length > 512 || !/^[!-~]+$/.test(secret)) {
      throw new Error("CRON_SECRET is not configured");
    }
    return secret;
  },
  isEnabled: () =>
    process.env.SIDESTREAM_ANNUAL_RENEWAL_REMINDERS_ENABLED?.trim() === "true",
  runJob: () => runAnnualRenewalReminders(),
  log: (entry) => {
    console.info("sidestream_annual_renewal_reminders", JSON.stringify(entry));
  },
};

export function createAnnualRenewalReminderHandler(
  overrides: Partial<AnnualRenewalReminderRouteDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };
  return async function annualRenewalReminderHandler(
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
        error: "Annual renewal reminders are not configured",
        code: "annual_renewal_reminders_unavailable",
      });
    }
    if (!hasValidBearerSecret(request.headers.authorization, secret)) {
      return sendJson(response, 401, { error: "Unauthorized", code: "unauthorized" });
    }
    if (!dependencies.isEnabled()) {
      const summary = { outcome: "disabled" } as const;
      dependencies.log(summary);
      return sendJson(response, 200, { ok: true, ...summary });
    }
    try {
      const summary = await dependencies.runJob();
      dependencies.log(summary);
      return sendJson(response, 200, { ok: true, ...summary });
    } catch {
      dependencies.log({ outcome: "failed" });
      return sendJson(response, 500, {
        error: "Annual renewal reminders failed",
        code: "annual_renewal_reminders_failed",
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

export default createAnnualRenewalReminderHandler();

import { createHash } from "node:crypto";
import type { SupportRuntimeConfig } from "./support-config.js";

const RESEND_SEND_ENDPOINT = "https://api.resend.com/emails";

type SupportFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export async function sendSupportSafetyAlert(options: {
  config: SupportRuntimeConfig;
  gate: "triage" | "safety_audit";
  referenceId: string;
  riskCodes: readonly string[];
  outcome: "flag" | "error";
  fetchImpl?: SupportFetch;
}) {
  const safeReference = /^[0-9a-f-]{36}$/i.test(options.referenceId)
    ? options.referenceId
    : "redacted";
  const safeRiskCodes = options.riskCodes
    .filter((code) => /^[a-z0-9_:-]{1,100}$/i.test(code))
    .slice(0, 20);
  const subject = `[Sidestream support] ${options.gate} ${options.outcome}`;
  const text = [
    "Sidestream support automation stopped safely.",
    "",
    `Gate: ${options.gate}`,
    `Outcome: ${options.outcome}`,
    `Reference: ${safeReference}`,
    `Risk codes: ${safeRiskCodes.join(", ") || "unspecified"}`,
    "",
    "No code, database transaction, merge, deployment, or customer reply was executed.",
  ].join("\n");
  const idempotencyHash = createHash("sha256")
    .update(`${options.gate}:${options.referenceId}:${options.outcome}:${safeRiskCodes.join(",")}`)
    .digest("hex");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  let response: Response;
  try {
    response = await (options.fetchImpl || fetch)(RESEND_SEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.config.resendApiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `support-safety/${idempotencyHash}`,
      },
      body: JSON.stringify({
        from: options.config.emailFrom,
        to: [options.config.alertAddress],
        subject,
        text,
        reply_to: options.config.inboundAddress,
        tags: [
          { name: "email_type", value: "support_safety_alert" },
          { name: "safety_gate", value: options.gate },
        ],
      }),
      signal: controller.signal,
    });
  } catch {
    throw new Error("Support safety alert delivery failed");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`Support safety alert was rejected (${response.status})`);
}

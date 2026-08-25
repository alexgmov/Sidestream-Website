import type { SupportRuntimeConfig } from "./support-config.js";
import {
  loadSupportMessageForTriage,
  recordSupportTriageError,
  recordSupportTriageOutcome,
} from "./support-ledger.js";
import { sendSupportSafetyAlert } from "./support-notifications.js";
import { runSupportTriage } from "./support-safety.js";

export async function triageSupportMessage(options: {
  messageId: string;
  config: SupportRuntimeConfig;
}) {
  const message = await loadSupportMessageForTriage(
    options.messageId,
    options.config.dataSecret,
  );
  let outcome: Awaited<ReturnType<typeof runSupportTriage>>;
  try {
    outcome = await runSupportTriage({
      subject: message.subject,
      body: message.body,
      attachmentCount: message.attachmentCount,
      htmlOnly: message.htmlOnly,
      safetyIdentifier: message.requesterEmailHash,
      environment: {
        OPENAI_API_KEY: options.config.openAiApiKey,
        SIDESTREAM_SUPPORT_TRIAGE_MODEL: options.config.triageModel,
      },
    });
  } catch {
    const recorded = await recordSupportTriageError({
      messageId: message.messageId,
      threadId: message.threadId,
      errorCode: "triage_gate_error",
    });
    if (recorded.inserted) {
      await sendSupportSafetyAlert({
        config: options.config,
        gate: "triage",
        referenceId: recorded.actionId,
        riskCodes: ["triage_gate_error"],
        outcome: "error",
      });
    }
    return recorded;
  }

  const recorded = await recordSupportTriageOutcome({
    messageId: message.messageId,
    threadId: message.threadId,
    outcome,
  });
  if (outcome.result.verdict === "flag" && recorded.inserted) {
    await sendSupportSafetyAlert({
      config: options.config,
      gate: "triage",
      referenceId: recorded.actionId,
      riskCodes: outcome.riskCodes,
      outcome: "flag",
    });
  }
  return recorded;
}

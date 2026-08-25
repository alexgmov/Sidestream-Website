import type { SupportRuntimeConfig } from "./support-config.js";
import {
  loadSupportMessageForTriage,
  recordSupportTriageError,
  recordSupportTriageOutcome,
} from "./support-ledger.js";
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
    return recorded;
  }

  const recorded = await recordSupportTriageOutcome({
    messageId: message.messageId,
    threadId: message.threadId,
    outcome,
  });
  return recorded;
}

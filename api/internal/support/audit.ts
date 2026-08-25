import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authorizeCustomerAdminRequest,
  CustomerAdminRequestError,
  readCustomerAdminJson,
  sendCustomerAdminJson,
} from "../../_lib/customer-admin.js";
import {
  loadSupportRuntimeConfig,
  type SupportRuntimeConfig,
} from "../../_lib/support-config.js";
import {
  loadSupportActionForAudit,
  markSupportAuditPending,
  recordSupportAuditError,
  recordSupportAuditOutcome,
} from "../../_lib/support-ledger.js";
import { sendSupportSafetyAlert } from "../../_lib/support-notifications.js";
import {
  runSupportSafetyAudit,
  validateSupportAuditArtifact,
} from "../../_lib/support-safety.js";

type SupportAuditDependencies = Readonly<{
  loadConfig: () => SupportRuntimeConfig;
  loadAction: typeof loadSupportActionForAudit;
  markPending: typeof markSupportAuditPending;
  runAudit: typeof runSupportSafetyAudit;
  recordOutcome: typeof recordSupportAuditOutcome;
  recordError: typeof recordSupportAuditError;
  notify: typeof sendSupportSafetyAlert;
}>;

const defaultDependencies: SupportAuditDependencies = {
  loadConfig: loadSupportRuntimeConfig,
  loadAction: loadSupportActionForAudit,
  markPending: markSupportAuditPending,
  runAudit: runSupportSafetyAudit,
  recordOutcome: recordSupportAuditOutcome,
  recordError: recordSupportAuditError,
  notify: sendSupportSafetyAlert,
};

export function createSupportAuditHandler(
  overrides: Partial<SupportAuditDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };
  return async function supportAuditHandler(
    request: IncomingMessage & { body?: unknown; rawHeaders?: string[] },
    response: ServerResponse,
  ) {
    const authorized = authorizeCustomerAdminRequest(
      request,
      response,
      () => dependencies.loadConfig().adminSecret,
    );
    if (!authorized) return;
    const config = dependencies.loadConfig();

    let action: Awaited<ReturnType<typeof loadSupportActionForAudit>> | null = null;
    let artifact: ReturnType<typeof validateSupportAuditArtifact> | null = null;
    let rawArtifact: unknown = null;
    try {
      const body = await readCustomerAdminJson(request);
      const keys = Object.keys(body).sort();
      if (keys.length !== 2 || keys[0] !== "actionId" || keys[1] !== "artifact") {
        throw new TypeError("Audit request contains unsupported fields");
      }
      if (typeof body.actionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(body.actionId)) {
        throw new TypeError("Support action ID is invalid");
      }
      action = await dependencies.loadAction(body.actionId);
      rawArtifact = body.artifact;
      try {
        artifact = validateSupportAuditArtifact(rawArtifact);
      } catch (error) {
        const outcome = invalidArtifactOutcome();
        await dependencies.markPending(action.actionId);
        const recorded = await dependencies.recordOutcome({
          actionId: action.actionId,
          threadId: action.threadId,
          artifact: rawArtifact,
          outcome,
        });
        if (recorded.inserted) {
          await dependencies.notify({
            config,
            gate: "safety_audit",
            referenceId: action.actionId,
            riskCodes: outcome.riskCodes,
            outcome: "flag",
          });
        }
        return sendCustomerAdminJson(response, 400, {
          error: error instanceof Error ? error.message : "Invalid support audit artifact",
          code: "invalid_support_audit_artifact",
          flagged: true,
          executed: false,
        });
      }
      await dependencies.markPending(action.actionId);
      const outcome = await dependencies.runAudit({
        artifact,
        expectedActionType: action.actionType,
        safetyIdentifier: action.requesterEmailHash,
        environment: {
          OPENAI_API_KEY: config.openAiApiKey,
          SIDESTREAM_SUPPORT_AUDIT_MODEL: config.auditModel,
        },
      });
      const recorded = await dependencies.recordOutcome({
        actionId: action.actionId,
        threadId: action.threadId,
        artifact,
        outcome,
      });
      if (outcome.result.verdict === "flag" && recorded.inserted) {
        await dependencies.notify({
          config,
          gate: "safety_audit",
          referenceId: action.actionId,
          riskCodes: outcome.riskCodes,
          outcome: "flag",
        });
      }
      return sendCustomerAdminJson(response, 200, {
        actionId: action.actionId,
        verdict: outcome.result.verdict,
        humanApprovalRequired: outcome.result.humanApprovalRequired,
        executed: false,
      });
    } catch (error) {
      if (error instanceof CustomerAdminRequestError) {
        return sendCustomerAdminJson(response, error.statusCode, {
          error: error.message,
          code: error.code,
        });
      }
      if (error instanceof TypeError) {
        return sendCustomerAdminJson(response, 400, {
          error: error.message,
          code: "invalid_support_audit_request",
        });
      }
      if (action && rawArtifact !== null) {
        try {
          const recorded = await dependencies.recordError({
            actionId: action.actionId,
            threadId: action.threadId,
            artifact: rawArtifact,
            errorCode: "safety_audit_error",
          });
          if (recorded.inserted) {
            await dependencies.notify({
              config,
              gate: "safety_audit",
              referenceId: action.actionId,
              riskCodes: ["safety_audit_error"],
              outcome: "error",
            });
          }
        } catch {
          // The request still fails closed even if persistence or notification is unavailable.
        }
      }
      return sendCustomerAdminJson(response, 503, {
        error: "Support safety audit unavailable",
        code: "support_safety_audit_unavailable",
      });
    }
  };
}

function invalidArtifactOutcome() {
  return Object.freeze({
    model: "deterministic-auditor",
    riskCodes: Object.freeze(["invalid_artifact_schema"]),
    result: Object.freeze({
      verdict: "flag" as const,
      coreImpact: false,
      humanApprovalRequired: true,
      riskCodes: Object.freeze(["invalid_artifact_schema"]),
      findings: Object.freeze(["The submitted artifact did not match the bounded audit schema."]),
      recommendation: "Stop automation and request human review.",
    }),
  });
}

export default createSupportAuditHandler();

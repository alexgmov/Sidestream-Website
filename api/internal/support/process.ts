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
  processSupportQueues,
  recoverSupportNotificationDeadLetter,
  recoverSupportProcessingDeadLetter,
} from "../../_lib/support-queue.js";

type SupportProcessorDependencies = Readonly<{
  loadConfig: () => SupportRuntimeConfig;
  processQueues: typeof processSupportQueues;
  recoverJob: typeof recoverSupportProcessingDeadLetter;
  recoverNotification: typeof recoverSupportNotificationDeadLetter;
}>;

const defaultDependencies: SupportProcessorDependencies = {
  loadConfig: loadSupportRuntimeConfig,
  processQueues: processSupportQueues,
  recoverJob: recoverSupportProcessingDeadLetter,
  recoverNotification: recoverSupportNotificationDeadLetter,
};

export function createSupportProcessorHandler(
  overrides: Partial<SupportProcessorDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };
  return async function supportProcessorHandler(
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

    try {
      const body = await readCustomerAdminJson(request);
      const options = validateProcessorRequest(body);
      let recovery: Readonly<Record<string, unknown>> | null = null;
      if (options.recoverJobId) {
        recovery = await dependencies.recoverJob(options.recoverJobId);
      } else if (options.recoverNotificationId) {
        recovery = await dependencies.recoverNotification(options.recoverNotificationId);
      }
      if (recovery && recovery.recovered !== true) {
        return sendCustomerAdminJson(response, 409, {
          error: "Support dead letter is not recoverable",
          code: "support_dead_letter_not_recoverable",
          executed: false,
        });
      }
      const summary = await dependencies.processQueues({
        config,
        jobLimit: options.jobLimit,
        notificationLimit: options.notificationLimit,
      });
      return sendCustomerAdminJson(response, 200, {
        ...summary,
        ...(recovery ? { recovery } : {}),
      });
    } catch (error) {
      if (error instanceof CustomerAdminRequestError) {
        return sendCustomerAdminJson(response, error.statusCode, {
          error: error.message,
          code: error.code,
          executed: false,
        });
      }
      if (error instanceof TypeError) {
        return sendCustomerAdminJson(response, 400, {
          error: error.message,
          code: "invalid_support_processor_request",
          executed: false,
        });
      }
      return sendCustomerAdminJson(response, 503, {
        error: "Support processor unavailable",
        code: "support_processor_unavailable",
        executed: false,
      });
    }
  };
}

function validateProcessorRequest(body: Record<string, unknown>) {
  const supportedKeys = new Set([
    "jobLimit",
    "notificationLimit",
    "recoverJobId",
    "recoverNotificationId",
  ]);
  if (Object.keys(body).some((key) => !supportedKeys.has(key))) {
    throw new TypeError("Support processor request contains unsupported fields");
  }
  const jobLimit = optionalLimit(body.jobLimit, "jobLimit");
  const notificationLimit = optionalLimit(body.notificationLimit, "notificationLimit");
  const recoverJobId = optionalUuid(body.recoverJobId, "recoverJobId");
  const recoverNotificationId = optionalUuid(
    body.recoverNotificationId,
    "recoverNotificationId",
  );
  if (recoverJobId && recoverNotificationId) {
    throw new TypeError("Only one support dead letter can be recovered per request");
  }
  return Object.freeze({
    jobLimit,
    notificationLimit,
    recoverJobId,
    recoverNotificationId,
  });
}

function optionalLimit(value: unknown, name: string) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 25) {
    throw new TypeError(`${name} must be an integer from 1 to 25`);
  }
  return Number(value);
}

function optionalUuid(value: unknown, name: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

export default createSupportProcessorHandler();

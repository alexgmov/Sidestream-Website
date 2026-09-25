import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authorizeCustomerAdminRequest,
  CustomerAdminRequestError,
  loadCustomerAdminSecret,
  readCustomerAdminJson,
  sendCustomerAdminJson,
} from "../_lib/customer-admin.js";
import {
  ChannelReportValidationError,
  queryChannelReport,
} from "../_lib/channel-report.js";

type Dependencies = Readonly<{
  getAdminSecret: () => string;
  queryReport: (body: unknown) => Promise<unknown>;
}>;

const defaults: Dependencies = {
  getAdminSecret: loadCustomerAdminSecret,
  queryReport: queryChannelReport,
};

export function createChannelReportHandler(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  return async function channelReportHandler(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    if (!authorizeCustomerAdminRequest(request, response, dependencies.getAdminSecret)) return;
    try {
      const body = await readCustomerAdminJson(request);
      const report = await dependencies.queryReport(body);
      return sendCustomerAdminJson(response, 200, report as Record<string, unknown>);
    } catch (error) {
      if (error instanceof CustomerAdminRequestError) {
        return sendCustomerAdminJson(response, error.statusCode, {
          error: error.message,
          code: error.code,
        });
      }
      if (error instanceof ChannelReportValidationError) {
        return sendCustomerAdminJson(response, 400, {
          error: error.message,
          code: error.message,
        });
      }
      return sendCustomerAdminJson(response, 500, {
        error: "Channel report failed",
        code: "channel_report_failed",
      });
    }
  };
}

export default createChannelReportHandler();

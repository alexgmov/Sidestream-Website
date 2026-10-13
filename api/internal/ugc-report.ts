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
} from "../_lib/channel-report.js";
import { queryUgcReport } from "../_lib/ugc-report.js";

type Dependencies = Readonly<{
  getAdminSecret: () => string;
  queryReport: (body: unknown) => Promise<unknown>;
}>;

const defaults: Dependencies = {
  getAdminSecret: loadCustomerAdminSecret,
  queryReport: queryUgcReport,
};

export function createUgcReportHandler(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  return async function ugcReportHandler(
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
        error: "UGC report failed",
        code: "ugc_report_failed",
      });
    }
  };
}

export default createUgcReportHandler();

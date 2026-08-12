import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authorizeCustomerAdminRequest,
  CustomerAdminRequestError,
  loadCustomerAdminSecret,
  readCustomerAdminJson,
  sendCustomerAdminJson,
} from "../_lib/customer-admin.js";
import {
  queryUpgradePricingReport,
  UpgradePricingReportValidationError,
} from "../_lib/upgrade-pricing-report.js";

type Dependencies = Readonly<{
  getAdminSecret: () => string;
  queryReport: (body: unknown, secret: string) => Promise<unknown>;
}>;

const defaults: Dependencies = {
  getAdminSecret: loadCustomerAdminSecret,
  queryReport: queryUpgradePricingReport,
};

export function createUpgradePricingReportHandler(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  return async function upgradePricingReportHandler(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const secret = authorizeCustomerAdminRequest(
      request,
      response,
      dependencies.getAdminSecret,
    );
    if (!secret) return;

    try {
      const body = await readCustomerAdminJson(request);
      const report = await dependencies.queryReport(body, secret);
      return sendCustomerAdminJson(response, 200, report as Record<string, unknown>);
    } catch (error) {
      if (error instanceof CustomerAdminRequestError) {
        return sendCustomerAdminJson(response, error.statusCode, {
          error: error.message,
          code: error.code,
        });
      }
      if (error instanceof UpgradePricingReportValidationError) {
        return sendCustomerAdminJson(response, 400, {
          error: error.message,
          code: error.code,
        });
      }
      return sendCustomerAdminJson(response, 500, {
        error: "Upgrade pricing report failed",
        code: "upgrade_pricing_report_failed",
      });
    }
  };
}

export default createUpgradePricingReportHandler();

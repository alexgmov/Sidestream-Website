import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authorizeCustomerAdminRequest,
  CustomerAdminRequestError,
  loadCustomerAdminSecret,
  readCustomerAdminJson,
  sendCustomerAdminJson,
} from "../../_lib/customer-admin.js";
import {
  CustomerSummaryValidationError,
  queryCustomerSummary,
} from "../../_lib/customer-summary.js";

type CustomerSummaryRouteDependencies = Readonly<{
  getAdminSecret: () => string;
  querySummary: (request: unknown) => Promise<unknown>;
}>;

const defaultDependencies: CustomerSummaryRouteDependencies = {
  getAdminSecret: loadCustomerAdminSecret,
  querySummary: queryCustomerSummary,
};

export function createCustomerSummaryHandler(
  overrides: Partial<CustomerSummaryRouteDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };

  return async function customerSummaryHandler(
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
      const result = await dependencies.querySummary(body);
      return sendCustomerAdminJson(response, 200, result as Record<string, unknown>);
    } catch (error) {
      if (error instanceof CustomerAdminRequestError) {
        return sendCustomerAdminJson(response, error.statusCode, {
          error: error.message,
          code: error.code,
        });
      }
      if (error instanceof CustomerSummaryValidationError) {
        return sendCustomerAdminJson(response, 400, {
          error: error.message,
          code: error.code,
        });
      }
      return sendCustomerAdminJson(response, 500, {
        error: "Customer summary failed",
        code: "customer_summary_failed",
      });
    }
  };
}

export default createCustomerSummaryHandler();

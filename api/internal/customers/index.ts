import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authorizeCustomerAdminRequest,
  CustomerAdminRequestError,
  loadCustomerAdminSecret,
  readCustomerAdminJson,
  sendCustomerAdminJson,
} from "../../_lib/customer-admin.js";
import {
  CustomerQueryValidationError,
  queryCustomerList,
} from "../../_lib/customer-query.js";

type CustomerListRouteDependencies = Readonly<{
  getAdminSecret: () => string;
  listCustomers: (request: unknown, cursorSecret: string) => Promise<unknown>;
}>;

const defaultDependencies: CustomerListRouteDependencies = {
  getAdminSecret: loadCustomerAdminSecret,
  listCustomers: queryCustomerList,
};

export function createCustomerListHandler(
  overrides: Partial<CustomerListRouteDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };

  return async function customerListHandler(
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
      const result = await dependencies.listCustomers(body, secret);
      return sendCustomerAdminJson(response, 200, result as Record<string, unknown>);
    } catch (error) {
      if (error instanceof CustomerAdminRequestError) {
        return sendCustomerAdminJson(response, error.statusCode, {
          error: error.message,
          code: error.code,
        });
      }
      if (error instanceof CustomerQueryValidationError) {
        return sendCustomerAdminJson(response, 400, {
          error: error.message,
          code: error.code,
        });
      }
      return sendCustomerAdminJson(response, 500, {
        error: "Customer query failed",
        code: "customer_query_failed",
      });
    }
  };
}

export default createCustomerListHandler();

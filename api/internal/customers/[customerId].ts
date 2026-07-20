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
  queryCustomerDetail,
} from "../../_lib/customer-query.js";

type CustomerDetailRouteDependencies = Readonly<{
  getAdminSecret: () => string;
  getCustomer: (customerId: string, request: unknown) => Promise<unknown | null>;
}>;

const defaultDependencies: CustomerDetailRouteDependencies = {
  getAdminSecret: loadCustomerAdminSecret,
  getCustomer: queryCustomerDetail,
};

export function createCustomerDetailHandler(
  overrides: Partial<CustomerDetailRouteDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };

  return async function customerDetailHandler(
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
      const customerId = customerIdFromRequest(request);
      const body = await readCustomerAdminJson(request);
      const customer = await dependencies.getCustomer(customerId, body);
      if (!customer) {
        return sendCustomerAdminJson(response, 404, {
          error: "Customer not found",
          code: "customer_not_found",
        });
      }
      return sendCustomerAdminJson(response, 200, {
        customer,
      });
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

function customerIdFromRequest(request: IncomingMessage) {
  const pathname = new URL(request.url || "/", "http://internal.invalid").pathname;
  const segments = pathname.split("/").filter(Boolean);
  const segment = segments[segments.length - 1] || "";
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new CustomerQueryValidationError("invalid_customer_id", "customerId must be a UUID");
  }
}

export default createCustomerDetailHandler();

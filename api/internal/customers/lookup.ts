import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authorizeCustomerAdminRequest,
  CustomerAdminRequestError,
  loadCustomerAdminSecret,
  readCustomerAdminJson,
  sendCustomerAdminJson,
} from "../../_lib/customer-admin.js";
import {
  CustomerLookupIntegrityError,
  CustomerQueryValidationError,
  queryCustomerLookup,
} from "../../_lib/customer-query.js";

type CustomerLookupRouteDependencies = Readonly<{
  getAdminSecret: () => string;
  lookupCustomer: (request: unknown) => Promise<unknown>;
}>;

const defaultDependencies: CustomerLookupRouteDependencies = {
  getAdminSecret: loadCustomerAdminSecret,
  lookupCustomer: queryCustomerLookup,
};

export function createCustomerLookupHandler(
  overrides: Partial<CustomerLookupRouteDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };

  return async function customerLookupHandler(
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
      const customer = await dependencies.lookupCustomer(body);
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
      if (error instanceof CustomerLookupIntegrityError) {
        return sendCustomerAdminJson(response, 409, {
          error: error.message,
          code: error.code,
        });
      }
      return sendCustomerAdminJson(response, 500, {
        error: "Customer lookup failed",
        code: "customer_lookup_failed",
      });
    }
  };
}

export default createCustomerLookupHandler();

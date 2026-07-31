import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authorizeCustomerAdminRequest,
  CustomerAdminRequestError,
  loadCustomerAdminSecret,
  readCustomerAdminJson,
  sendCustomerAdminJson,
} from "../../_lib/customer-admin.js";
import {
  AcquisitionFunnelValidationError,
  queryAcquisitionFunnel,
} from "../../_lib/acquisition-funnel.js";

type AcquisitionFunnelRouteDependencies = Readonly<{
  getAdminSecret: () => string;
  queryFunnel: (request: unknown) => Promise<unknown>;
}>;

const defaultDependencies: AcquisitionFunnelRouteDependencies = {
  getAdminSecret: loadCustomerAdminSecret,
  queryFunnel: queryAcquisitionFunnel,
};

export function createAcquisitionFunnelHandler(
  overrides: Partial<AcquisitionFunnelRouteDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };

  return async function acquisitionFunnelHandler(
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
      const result = await dependencies.queryFunnel(body);
      return sendCustomerAdminJson(response, 200, result as Record<string, unknown>);
    } catch (error) {
      if (error instanceof CustomerAdminRequestError) {
        return sendCustomerAdminJson(response, error.statusCode, {
          error: error.message,
          code: error.code,
        });
      }
      if (error instanceof AcquisitionFunnelValidationError) {
        return sendCustomerAdminJson(response, 400, {
          error: error.message,
          code: error.code,
        });
      }
      return sendCustomerAdminJson(response, 500, {
        error: "Acquisition funnel query failed",
        code: "acquisition_funnel_query_failed",
      });
    }
  };
}

export default createAcquisitionFunnelHandler();

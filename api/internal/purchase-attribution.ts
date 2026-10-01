import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeCustomerAdminRequest, CustomerAdminRequestError, loadCustomerAdminSecret, readCustomerAdminJson, sendCustomerAdminJson } from "../_lib/customer-admin.js";
import { PurchaseAttributionValidationError, queryPurchaseAttribution } from "../_lib/purchase-attribution.js";

export function createPurchaseAttributionHandler({ getAdminSecret = loadCustomerAdminSecret, queryReport = queryPurchaseAttribution } = {}) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (!authorizeCustomerAdminRequest(request, response, getAdminSecret)) return;
    try { return sendCustomerAdminJson(response, 200, await queryReport(await readCustomerAdminJson(request))); }
    catch (error) {
      if (error instanceof CustomerAdminRequestError) return sendCustomerAdminJson(response, error.statusCode, { error: error.code });
      if (error instanceof PurchaseAttributionValidationError) return sendCustomerAdminJson(response, 400, { error: error.message });
      return sendCustomerAdminJson(response, 500, { error: "purchase_attribution_failed" });
    }
  };
}
export default createPurchaseAttributionHandler();

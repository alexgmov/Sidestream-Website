import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ACQUISITION_SECRET_NAME,
  readBrowserAcquisitionCookie,
  resolveBrowserAcquisitionCookie,
  serializeBrowserAcquisitionCookie,
} from "../_lib/acquisition-cookie.js";
import type { BrowserAcquisitionCookie } from "../_lib/acquisition-cookie.js";
import { ensureBrowserAcquisition } from "./_lib.js";

type ObservationDependencies = Readonly<{
  getSecret: () => string;
  now: () => Date;
  observe: (cookie: BrowserAcquisitionCookie) => Promise<void>;
}>;

export function createAcquisitionObservationHandler(
  overrides: Partial<ObservationDependencies> = {},
) {
  const dependencies: ObservationDependencies = {
    getSecret: () => process.env[ACQUISITION_SECRET_NAME]?.trim() || "",
    now: () => new Date(),
    observe: ensureBrowserAcquisition,
    ...overrides,
  };
  return async function acquisitionObservationHandler(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    setHeaders(response);
    if ((request.method || "GET").toUpperCase() !== "POST") {
      response.setHeader("Allow", "POST");
      response.statusCode = 405;
      response.end();
      return;
    }
    const requestUrl = new URL(request.url || "/api/acquisition/observe", "https://sidestream.tv");
    const contentLength = request.headers["content-length"];
    if (
      requestUrl.searchParams.size !== 0 ||
      (contentLength !== undefined && contentLength !== "0") ||
      request.headers["transfer-encoding"] !== undefined
    ) {
      response.statusCode = 400;
      response.end();
      return;
    }
    try {
      const value = readBrowserAcquisitionCookie(request.headers.cookie);
      const resolved = resolveBrowserAcquisitionCookie(value, {
        secret: dependencies.getSecret(),
        now: dependencies.now(),
      });
      await dependencies.observe(resolved.cookie);
      if (resolved.promoted) {
        response.setHeader("Set-Cookie", serializeBrowserAcquisitionCookie(resolved.cookie));
      }
    } catch {
      // Observation is intentionally nonblocking and emits no identity-bearing log.
    }
    response.statusCode = 204;
    response.end();
  };
}

function setHeaders(response: ServerResponse) {
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

export default createAcquisitionObservationHandler();

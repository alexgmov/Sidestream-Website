import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ACQUISITION_SECRET_NAME,
  createBrowserAcquisitionCookie,
  serializeBrowserAcquisitionCookie,
} from "../_lib/acquisition-cookie.js";
import {
  verifyServerOwnedDeliveryHandoff,
} from "../_lib/acquisition-handoff.js";
import type { ServerOwnedDeliveryHandoff } from "../_lib/acquisition-handoff.js";
import { ensureServerOwnedDeliveryAcquisition } from "./_lib.js";

type EntryDependencies = Readonly<{
  getSecret: () => string;
  now: () => Date;
  ensure: (handoff: ServerOwnedDeliveryHandoff, landingObservedAt: Date) => Promise<void>;
}>;

export function createServerOwnedDeliveryEntryHandler(
  overrides: Partial<EntryDependencies> = {},
) {
  const dependencies: EntryDependencies = {
    getSecret: () => process.env[ACQUISITION_SECRET_NAME]?.trim() || "",
    now: () => new Date(),
    ensure: ensureServerOwnedDeliveryAcquisition,
    ...overrides,
  };
  return async function serverOwnedDeliveryEntryHandler(
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    if ((request.method || "GET").toUpperCase() !== "GET") {
      response.setHeader("Allow", "GET");
      return sendNotFound(response);
    }
    try {
      const requestUrl = new URL(request.url || "/api/acquisition/entry", "https://sidestream.tv");
      const values = requestUrl.searchParams.getAll("handoff");
      if (values.length !== 1 || requestUrl.searchParams.size !== 1) return sendNotFound(response);
      const secret = dependencies.getSecret();
      const now = dependencies.now();
      const handoff = verifyServerOwnedDeliveryHandoff(values[0], { secret, now });
      await dependencies.ensure(handoff, now);
      const cookie = createBrowserAcquisitionCookie({
        acquisitionId: handoff.acquisitionId,
        attribution: {
          source: handoff.source,
          medium: "email",
          campaign: handoff.campaign,
          content: null,
        },
        externalReferrerCategory: handoff.externalReferrerCategory,
      }, { secret, now });
      response.statusCode = 302;
      response.setHeader("Location", "/");
      response.setHeader("Set-Cookie", serializeBrowserAcquisitionCookie(cookie));
      response.setHeader("Cache-Control", "private, no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.end();
    } catch {
      return sendNotFound(response);
    }
  };
}

function sendNotFound(response: ServerResponse) {
  response.statusCode = 404;
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end();
}

export default createServerOwnedDeliveryEntryHandler();

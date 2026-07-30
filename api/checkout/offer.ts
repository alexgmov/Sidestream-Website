import type { IncomingMessage, ServerResponse } from "node:http";
import {
  getCheckoutOfferPresentation,
  getTrustedCheckoutCountry,
} from "../_lib/checkout-offers.js";

export default function handler(
  request: IncomingMessage,
  response: ServerResponse,
) {
  const method = (request.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return sendJson(response, 405, { error: "Method not allowed" }, method);
  }

  const presentation = getCheckoutOfferPresentation(
    getTrustedCheckoutCountry(request.headers),
  );
  return sendJson(response, 200, presentation, method);
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  method: string,
) {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.setHeader("Cache-Control", "private, no-store, max-age=0");
  response.setHeader("Vary", "x-vercel-ip-country");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  response.end(method === "HEAD" ? undefined : body);
}

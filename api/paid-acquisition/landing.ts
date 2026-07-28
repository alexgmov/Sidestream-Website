import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ServerResponse } from "node:http";
import {
  methodNotAllowed,
  resolveRequestLicenseEnvironment,
  type AccountRequest,
} from "../_lib/account.js";
import {
  PaidAcquisitionError,
  createPaidAcquisitionEntryContext,
  persistPaidAcquisitionEntry,
  validatePaidAcquisitionLandingProof,
} from "../_lib/paid-acquisition.js";

const ASSIGNMENT_HEADER = "x-sidestream-paid-acquisition-assignment";
const PROOF_HEADER = "x-sidestream-paid-acquisition-proof";
const ENTRY_PLACEHOLDER = "__SIDESTREAM_PAID_ENTRY_TOKEN__";
const LANDING_PATH = path.join(
  process.cwd(),
  "runtime",
  "mobile-paid-prototype.html",
);

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  response.setHeader("Cache-Control", "private, no-store");
  const method = (request.method || "GET").toUpperCase();
  if (method !== "GET") return methodNotAllowed(response, "GET");

  const environment = resolveRequestLicenseEnvironment(request);
  const secret =
    process.env.SIDESTREAM_PAID_ACQUISITION_ASSIGNMENT_SECRET?.trim() || "";
  if (!environment || Buffer.byteLength(secret, "utf8") < 32) {
    return sendLandingError(response, 503);
  }

  const assignmentCookieValue = firstHeader(
    request.headers[ASSIGNMENT_HEADER],
  );
  const proof = firstHeader(request.headers[PROOF_HEADER]);
  const requestUrl = new URL(
    request.url || "/api/paid-acquisition/landing",
    "https://sidestream.tv",
  );
  const attribution = readNormalizedAttribution(requestUrl.searchParams);
  if (!assignmentCookieValue || !proof || !attribution) {
    return sendLandingError(response, 403);
  }

  try {
    validatePaidAcquisitionLandingProof({
      assignmentCookieValue,
      attributionQuery: requestUrl.searchParams.toString(),
      proof,
      secret,
    });
    const entry = createPaidAcquisitionEntryContext({
      assignmentCookieValue,
      assignmentSecret: secret,
      environment: environment.namespace,
      attribution,
    });
    await persistPaidAcquisitionEntry(entry.context);
    const html = await readFile(LANDING_PATH, "utf8");
    const firstPlaceholder = html.indexOf(ENTRY_PLACEHOLDER);
    if (
      firstPlaceholder === -1 ||
      html.indexOf(
        ENTRY_PLACEHOLDER,
        firstPlaceholder + ENTRY_PLACEHOLDER.length,
      ) !== -1
    ) {
      throw new Error("Paid landing token placeholder is invalid");
    }
    const rendered = html.replace(ENTRY_PLACEHOLDER, entry.entryToken);
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Content-Length", String(Buffer.byteLength(rendered)));
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data: https:; media-src 'self' https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.end(rendered);
  } catch (error) {
    const status =
      error instanceof PaidAcquisitionError &&
      error.code === "ineligible_entry"
        ? 403
        : 503;
    return sendLandingError(response, status);
  }
}

function readNormalizedAttribution(searchParams: URLSearchParams) {
  const allowed = new Set([
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_id",
  ]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key) || searchParams.getAll(key).length !== 1) return null;
  }
  if (
    searchParams.getAll("utm_source").length !== 1 ||
    searchParams.get("utm_source") !== "manychat"
  ) {
    return null;
  }
  const medium = searchParams.get("utm_medium");
  if (medium !== null && medium !== "dm" && medium !== "social") return null;
  const values: Record<string, string | null> = {
    utmCampaign: searchParams.get("utm_campaign"),
    utmContent: searchParams.get("utm_content"),
    utmId: searchParams.get("utm_id"),
  };
  for (const value of Object.values(values)) {
    if (value !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
      return null;
    }
  }
  return {
    ...(medium ? { utmMedium: medium } : {}),
    ...(values.utmCampaign ? { utmCampaign: values.utmCampaign } : {}),
    ...(values.utmContent ? { utmContent: values.utmContent } : {}),
    ...(values.utmId ? { utmId: values.utmId } : {}),
  };
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function sendLandingError(response: ServerResponse, statusCode: number) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Sidestream</title></head><body><main><h1>Sidestream is temporarily unavailable</h1><p>Please return to the original link and try again.</p></main></body></html>`;
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Content-Length", String(Buffer.byteLength(body)));
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(body);
}

#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

const OPERATOR_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const MAX_PAGES = 100;

export class UpgradePricingOperatorError extends Error {}

export function parseUpgradePricingReportArguments(argv) {
  const options = {
    operator: "",
    namespace: "",
    from: "",
    through: "",
    asOf: "",
    pageSize: 50,
    port: 3000,
    help: false,
    ltvMonths: "",
    monthlyChurnRate: "",
    feeRate: "",
    refundRate: "",
    fixedFees: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--operator" || argument.startsWith("--operator=")) {
      [options.operator, index] = readOption(argv, index, "--operator");
    } else if (argument === "--namespace" || argument.startsWith("--namespace=")) {
      [options.namespace, index] = readOption(argv, index, "--namespace");
    } else if (argument === "--from" || argument.startsWith("--from=")) {
      [options.from, index] = readOption(argv, index, "--from");
    } else if (argument === "--through" || argument.startsWith("--through=")) {
      [options.through, index] = readOption(argv, index, "--through");
    } else if (argument === "--as-of" || argument.startsWith("--as-of=")) {
      [options.asOf, index] = readOption(argv, index, "--as-of");
    } else if (argument === "--page-size" || argument.startsWith("--page-size=")) {
      let value;
      [value, index] = readOption(argv, index, "--page-size");
      options.pageSize = Number(value);
    } else if (argument === "--port" || argument.startsWith("--port=")) {
      let value;
      [value, index] = readOption(argv, index, "--port");
      options.port = Number(value);
    } else if (argument === "--ltv-months" || argument.startsWith("--ltv-months=")) {
      [options.ltvMonths, index] = readOption(argv, index, "--ltv-months");
    } else if (
      argument === "--monthly-churn-rate" || argument.startsWith("--monthly-churn-rate=")
    ) {
      [options.monthlyChurnRate, index] = readOption(argv, index, "--monthly-churn-rate");
    } else if (argument === "--fee-rate" || argument.startsWith("--fee-rate=")) {
      [options.feeRate, index] = readOption(argv, index, "--fee-rate");
    } else if (argument === "--refund-rate" || argument.startsWith("--refund-rate=")) {
      [options.refundRate, index] = readOption(argv, index, "--refund-rate");
    } else if (argument === "--fixed-fee" || argument.startsWith("--fixed-fee=")) {
      let value;
      [value, index] = readOption(argv, index, "--fixed-fee");
      options.fixedFees.push(value);
    } else {
      throw new UpgradePricingOperatorError("Unknown argument. Use --help for supported options.");
    }
  }

  if (options.help) return options;
  if (!OPERATOR_PATTERN.test(options.operator) || options.operator.includes("@")) {
    throw new UpgradePricingOperatorError(
      "Set --operator to a privacy-safe 3-64 character lowercase operator ID, not an email address.",
    );
  }
  if (!new Set(["production", "test"]).has(options.namespace)) {
    throw new UpgradePricingOperatorError("Set --namespace to production or test.");
  }
  if (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100) {
    throw new UpgradePricingOperatorError("--page-size must be an integer from 1 to 100.");
  }
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new UpgradePricingOperatorError("--port must be an integer from 1 to 65535.");
  }
  for (const [name, value] of [["--from", options.from], ["--through", options.through], ["--as-of", options.asOf]]) {
    if (value && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(new Date(value).getTime()))) {
      throw new UpgradePricingOperatorError(`${name} must be an ISO timestamp.`);
    }
  }
  options.modeledLtv = parseModeledLtvFlags(options);
  return options;
}

export function buildLocalReportUrl(port) {
  const url = new URL(`http://127.0.0.1:${port}/api/internal/upgrade-pricing-report`);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
      url.pathname !== "/api/internal/upgrade-pricing-report") {
    throw new UpgradePricingOperatorError("The report operator is restricted to the local 127.0.0.1 API.");
  }
  return url.toString();
}

export async function fetchCompleteUpgradePricingReport(options, dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const secret = String(dependencies.secret ?? process.env.SIDESTREAM_CRM_ADMIN_SECRET ?? "");
  if (secret.length < 16 || secret.length > 512 || !/^[\x21-\x7e]+$/.test(secret)) {
    throw new UpgradePricingOperatorError("SIDESTREAM_CRM_ADMIN_SECRET is not configured.");
  }
  const url = buildLocalReportUrl(options.port);
  const body = {
    namespace: options.namespace,
    ...(options.from ? { from: options.from } : {}),
    ...(options.through ? { through: options.through } : {}),
    ...(options.asOf ? { asOf: options.asOf } : {}),
    pageSize: options.pageSize,
    ...(options.modeledLtv ? { modeledLtv: options.modeledLtv } : {}),
  };
  const segments = [];
  let firstPage = null;
  let cursor = null;
  let pages = 0;
  do {
    pages += 1;
    if (pages > MAX_PAGES) {
      throw new UpgradePricingOperatorError("Report pagination exceeded the bounded page limit.");
    }
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...body, ...(cursor ? { cursor } : {}) }),
      redirect: "error",
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw new UpgradePricingOperatorError(
        `Report API failed (${response.status}): ${payload?.code || "unknown_error"}`,
      );
    }
    if (!firstPage) {
      firstPage = payload;
      if (!payload.observationWindow?.from || !payload.observationWindow?.throughExclusive ||
          !payload.observationWindow?.asOf) {
        throw new UpgradePricingOperatorError("Report API omitted its bound observation window.");
      }
      body.from = payload.observationWindow.from;
      body.through = payload.observationWindow.throughExclusive;
      body.asOf = payload.observationWindow.asOf;
    }
    if (!Array.isArray(payload.segments) || !payload.pagination) {
      throw new UpgradePricingOperatorError("Report API returned an invalid page.");
    }
    segments.push(...payload.segments);
    cursor = payload.pagination.nextCursor || null;
  } while (cursor);

  const report = {
    ...firstPage,
    requestedByOperator: options.operator,
    segments,
    pagination: {
      complete: true,
      pages,
      returned: segments.length,
      totalSegments: firstPage.pagination.totalSegments,
    },
  };
  assertSafeOperatorOutput(report);
  return report;
}

function parseModeledLtvFlags(options) {
  const fields = [
    options.ltvMonths,
    options.monthlyChurnRate,
    options.feeRate,
    options.refundRate,
  ];
  const requested = fields.some(Boolean) || options.fixedFees.length > 0;
  if (!requested) return null;
  if (fields.some((value) => value === "") || options.fixedFees.length === 0) {
    throw new UpgradePricingOperatorError(
      "Modeled LTV requires --ltv-months, --monthly-churn-rate, --fee-rate, --refund-rate, and at least one --fixed-fee currency:minor assumption.",
    );
  }
  const fixedFeeMinorByCurrency = {};
  for (const entry of options.fixedFees) {
    const match = entry.match(/^([a-z]{3}):(\d{1,6})$/);
    if (!match) throw new UpgradePricingOperatorError("--fixed-fee must use currency:minor, for example usd:30.");
    fixedFeeMinorByCurrency[match[1]] = Number(match[2]);
  }
  return {
    horizonMonths: Number(options.ltvMonths),
    monthlyChurnRate: Number(options.monthlyChurnRate),
    feeRate: Number(options.feeRate),
    refundRate: Number(options.refundRate),
    fixedFeeMinorByCurrency,
  };
}

function readOption(argv, index, name) {
  const argument = argv[index];
  if (argument.startsWith(`${name}=`)) {
    const value = argument.slice(name.length + 1).trim();
    if (!value) throw new UpgradePricingOperatorError(`${name} requires a value.`);
    return [value, index];
  }
  const value = String(argv[index + 1] || "").trim();
  if (!value || value.startsWith("--")) {
    throw new UpgradePricingOperatorError(`${name} requires a value.`);
  }
  return [value, index + 1];
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    throw new UpgradePricingOperatorError("Report API did not return JSON.");
  }
}

function assertSafeOperatorOutput(value) {
  const text = JSON.stringify(value);
  if (/(?:\bcs_(?:test|live)_|\bsub_|\bin_|\bpi_|\bch_|\bre_|@|activationKey|deviceIdHash|installIdHash|receiptIdHash|raw_payload)/i.test(text)) {
    throw new UpgradePricingOperatorError("Report API returned forbidden identity or provider data.");
  }
}

function usage() {
  return `Usage:
  npm run report:upgrade-pricing -- --operator <safe-id> --namespace <production|test> [options]

The operator calls only http://127.0.0.1:<port>/api/internal/upgrade-pricing-report,
uses SIDESTREAM_CRM_ADMIN_SECRET, follows all signed pages, and never accepts an
email, database URL, remote hostname, Stripe identifier, or customer identity.

Options:
  --from <ISO> --through <ISO> --as-of <ISO> --page-size <1-100> --port <port>
  --ltv-months <n> --monthly-churn-rate <0-1> --fee-rate <0-1>
  --refund-rate <0-1> --fixed-fee <currency:minor> (repeat per currency)
`;
}

async function main() {
  const options = parseUpgradePricingReportArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const report = await fetchCompleteUpgradePricingReport(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

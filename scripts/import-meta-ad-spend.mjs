import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  Customer360OperatorGuardError,
  authenticatedOperatorPoolOptions,
  connectAndFingerprintOperatorDatabase,
  exactTargetSelector,
  loadOperatorPackage,
  requireProductionConfirmations,
  resolveOperatorDatabase,
  safeOperatorCliError,
} from "./customer-360-operator-guards.mjs";

const OPERATION = "meta_ad_spend_import";
const PRODUCTION_CONFIRMATION = "IMPORT-META-AD-SPEND";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 10_000;
const REQUIRED_HEADERS = Object.freeze([
  "spend_day",
  "campaign",
  "creative_key",
  "ad_id",
  "currency",
  "spend_minor",
  "impressions",
  "clicks",
]);
const SAFE_DIMENSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function parseMetaSpendCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("Meta spend CSV must include a header and at least one row.");
  const header = rows[0].map((value) => value.trim());
  if (header.length !== REQUIRED_HEADERS.length ||
      header.some((value, index) => value !== REQUIRED_HEADERS[index])) {
    throw new Error(`Meta spend CSV headers must be exactly: ${REQUIRED_HEADERS.join(",")}`);
  }
  if (rows.length - 1 > MAX_ROWS) throw new Error(`Meta spend CSV cannot exceed ${MAX_ROWS} rows.`);

  const seen = new Set();
  const parsedRows = rows.slice(1).filter((row) => row.some((value) => value !== "")).map((row, index) => {
    if (row.length !== REQUIRED_HEADERS.length) {
      throw new Error(`Meta spend CSV row ${index + 2} has the wrong column count.`);
    }
    const value = Object.fromEntries(REQUIRED_HEADERS.map((key, column) => [key, row[column].trim()]));
    if (!validUtcDay(value.spend_day)) throw new Error(`Meta spend CSV row ${index + 2} has an invalid spend_day.`);
    if (!SAFE_DIMENSION.test(value.campaign)) throw new Error(`Meta spend CSV row ${index + 2} has an invalid campaign.`);
    if (!SAFE_DIMENSION.test(value.creative_key)) throw new Error(`Meta spend CSV row ${index + 2} has an invalid creative_key.`);
    if (!/^[0-9]{1,32}$/.test(value.ad_id)) throw new Error(`Meta spend CSV row ${index + 2} has an invalid ad_id.`);
    if (!/^[a-z]{3}$/.test(value.currency)) throw new Error(`Meta spend CSV row ${index + 2} has an invalid currency.`);
    const parsed = {
      spendDay: value.spend_day,
      campaign: value.campaign,
      creativeKey: value.creative_key,
      adId: value.ad_id,
      currency: value.currency,
      spendMinor: unsignedInteger(value.spend_minor, index, "spend_minor"),
      impressions: unsignedInteger(value.impressions, index, "impressions"),
      clicks: unsignedInteger(value.clicks, index, "clicks"),
    };
    const key = [parsed.spendDay, parsed.campaign, parsed.creativeKey, parsed.adId, parsed.currency].join("\u0000");
    if (seen.has(key)) throw new Error(`Meta spend CSV row ${index + 2} duplicates an earlier daily creative row.`);
    seen.add(key);
    return Object.freeze(parsed);
  });
  if (parsedRows.length === 0) throw new Error("Meta spend CSV must include at least one data row.");
  return parsedRows;
}

export function summarizeMetaSpendRows(rows) {
  const campaigns = new Set();
  const creatives = new Set();
  const currencies = new Set();
  let firstDay = null;
  let lastDay = null;
  for (const row of rows) {
    campaigns.add(row.campaign);
    creatives.add(`${row.campaign}\u0000${row.creativeKey}`);
    currencies.add(row.currency);
    if (!firstDay || row.spendDay < firstDay) firstDay = row.spendDay;
    if (!lastDay || row.spendDay > lastDay) lastDay = row.spendDay;
  }
  return Object.freeze({
    rows: rows.length,
    campaigns: campaigns.size,
    creatives: creatives.size,
    currencies: [...currencies].sort(),
    firstDay,
    lastDay,
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const filename = path.resolve(options.file);
  const fileInfo = await stat(filename);
  if (!fileInfo.isFile() || fileInfo.size <= 0 || fileInfo.size > MAX_FILE_BYTES) {
    throw new Error("Meta spend CSV must be a non-empty regular file no larger than 10 MiB.");
  }
  const text = await readFile(filename, "utf8");
  let rows;
  try {
    rows = parseMetaSpendCsv(text);
  } catch (error) {
    throw new Customer360OperatorGuardError(error instanceof Error
      ? error.message
      : "Meta spend CSV is invalid.");
  }
  const importBatchHash = createHash("sha256").update(text).digest("hex");
  const summary = summarizeMetaSpendRows(rows);

  if (!options.apply) {
    console.log(JSON.stringify({
      operation: OPERATION,
      mode: "dry_run",
      namespace: options.namespace,
      importBatchHash,
      summary,
      executed: false,
    }, null, 2));
    return;
  }

  const selector = exactTargetSelector(options.namespace);
  const descriptor = resolveOperatorDatabase({
    environment: process.env,
    namespace: options.namespace,
    selector,
  });
  const { Pool } = await loadOperatorPackage("pg");
  const pool = new Pool(authenticatedOperatorPoolOptions(descriptor.connectionString));
  let connection;
  try {
    connection = await connectAndFingerprintOperatorDatabase({
      pool,
      descriptor,
      namespace: options.namespace,
      operation: OPERATION,
    });
    if (options.namespace === "production") {
      console.log(JSON.stringify({ operation: OPERATION, targetFingerprint: connection.fingerprint, executed: false }));
    }
    requireProductionConfirmations({
      namespace: options.namespace,
      operation: OPERATION,
      expectedConfirmation: PRODUCTION_CONFIRMATION,
      fingerprint: connection.fingerprint,
      confirmOperation: options.confirmOperation,
      confirmTarget: options.confirmTarget,
    });
    await connection.client.query("begin");
    const schema = await connection.client.query(
      "select to_regclass('public.sidestream_meta_ad_spend_daily') is not null as available",
    );
    if (schema.rows?.[0]?.available !== true) throw new Error("Meta spend migration is not applied.");
    for (const chunk of chunks(rows, 250)) {
      await upsertChunk(connection.client, options.namespace, importBatchHash, chunk);
    }
    await connection.client.query("commit");
    console.log(JSON.stringify({
      operation: OPERATION,
      mode: "apply",
      namespace: options.namespace,
      targetFingerprint: connection.fingerprint,
      importBatchHash,
      summary,
      executed: true,
    }, null, 2));
  } catch (error) {
    try { await connection?.client?.query("rollback"); } catch { /* preserve original error */ }
    throw error;
  } finally {
    connection?.client?.release();
    await pool.end();
  }
}

async function upsertChunk(client, namespace, importBatchHash, rows) {
  const values = [];
  const tuples = rows.map((row, index) => {
    const offset = index * 10;
    values.push(
      namespace,
      row.spendDay,
      row.campaign,
      row.creativeKey,
      row.adId,
      row.currency,
      row.spendMinor,
      row.impressions,
      row.clicks,
      importBatchHash,
    );
    return `(${Array.from({ length: 10 }, (_, column) => `$${offset + column + 1}`).join(",")})`;
  });
  await client.query(`
    insert into public.sidestream_meta_ad_spend_daily (
      license_namespace, spend_day, campaign, creative_key, ad_id, currency,
      spend_minor, impressions, clicks, import_batch_hash
    ) values ${tuples.join(",")}
    on conflict (
      license_namespace, spend_day, campaign, creative_key, ad_id, currency
    ) do update set
      spend_minor = excluded.spend_minor,
      impressions = excluded.impressions,
      clicks = excluded.clicks,
      import_batch_hash = excluded.import_batch_hash,
      imported_at = now()
  `, values);
}

function parseArguments(args) {
  const known = new Set(["--file", "--namespace", "--apply", "--confirm-operation", "--confirm-target"]);
  for (const value of args.filter((item) => item.startsWith("--"))) {
    if (!known.has(value)) throw new Error(`Unknown option: ${value}`);
  }
  const file = option(args, "--file");
  const namespace = option(args, "--namespace");
  if (!file) throw new Error("--file is required.");
  if (namespace !== "test" && namespace !== "production") {
    throw new Error("--namespace must be test or production.");
  }
  return {
    file,
    namespace,
    apply: args.includes("--apply"),
    confirmOperation: option(args, "--confirm-operation"),
    confirmTarget: option(args, "--confirm-target"),
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? "" : String(args[index + 1] || "").trim();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field === "") {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("Meta spend CSV has an unterminated quoted field.");
  if (field !== "" || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function validUtcDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function unsignedInteger(value, index, field) {
  if (!/^\d+$/.test(value)) throw new Error(`Meta spend CSV row ${index + 2} has an invalid ${field}.`);
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n) {
    throw new Error(`Meta spend CSV row ${index + 2} exceeds bigint range for ${field}.`);
  }
  return parsed.toString();
}

function* chunks(values, size) {
  for (let index = 0; index < values.length; index += size) {
    yield values.slice(index, index + size);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(safeOperatorCliError(error, "Meta spend import failed."));
    process.exitCode = 1;
  });
}

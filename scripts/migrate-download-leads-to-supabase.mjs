import { get, list } from "@vercel/blob";
import crypto from "node:crypto";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

const DEFAULT_PREFIX = "sidestream/download-leads";
const MIGRATION_PATH = path.resolve("supabase/migrations/20260626120000_add_sidestream_download_leads.sql");

loadEnvFile(process.env.SIDESTREAM_ENV_FILE);
loadEnvFile(process.env.SIDESTREAM_DB_ENV_FILE);
preferBlobReadWriteTokenForLocalMigration();

const prefix = (process.env.SIDESTREAM_DOWNLOAD_LEADS_BLOB_PREFIX || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, "");
const dryRun = process.argv.includes("--dry-run");
const applySchema = process.argv.includes("--apply-schema");
const dumpRows = process.argv.includes("--dump");

if (!process.env.POSTGRES_URL) {
  fail("Missing POSTGRES_URL. Load the Supabase pooler URL before running this script.");
}

const pool = createPool();

try {
  if (applySchema) {
    const sql = await readFile(MIGRATION_PATH, "utf8");
    if (dryRun) {
      console.log(`[dry-run] would apply schema from ${MIGRATION_PATH}`);
    } else {
      await pool.query(sql);
      console.log(`Applied schema from ${MIGRATION_PATH}`);
    }
  }

  const blobs = await listLeadBlobs(prefix);
  console.log(`Found ${blobs.length} lead blob(s) under ${prefix}`);

  let migrated = 0;
  let skipped = 0;
  for (const blob of blobs) {
    const lead = await readLeadBlob(blob.pathname);
    if (!lead?.email) {
      skipped += 1;
      console.warn(`Skipped ${blob.pathname}: missing email`);
      continue;
    }

    if (dryRun) {
      migrated += 1;
      console.log(`[dry-run] would migrate ${lead.email} from ${blob.pathname}`);
      continue;
    }

    await upsertLead({
      leadKey: lead.leadKey || leadKeyFromPathname(blob.pathname),
      email: normalizeEmail(lead.email),
      capturedAt: normalizeIso(lead.capturedAt) || blob.uploadedAt.toISOString(),
      page: cleanString(lead.page, 240),
      source: cleanString(lead.source, 300),
      referrer: cleanString(lead.referrer, 500),
      userAgent: cleanString(lead.userAgent, 500),
      blobPathname: blob.pathname,
      context: {
        source: "download_email_gate",
        migratedFrom: "vercel_blob",
        blobUploadedAt: blob.uploadedAt.toISOString(),
      },
    });
    migrated += 1;
  }

  console.log(`Migrated ${migrated} lead(s); skipped ${skipped}.`);

  if (dumpRows) {
    const rows = await fetchRows();
    console.log(JSON.stringify(rows, null, 2));
  }
} finally {
  await pool.end();
}

async function listLeadBlobs(blobPrefix) {
  const blobs = [];
  let cursor;

  do {
    const page = await list({ prefix: blobPrefix, cursor, limit: 1000 });
    blobs.push(...page.blobs.filter((blob) => blob.pathname.endsWith(".json")));
    cursor = page.cursor;
  } while (cursor);

  return blobs.sort((a, b) => a.pathname.localeCompare(b.pathname));
}

async function readLeadBlob(pathname) {
  const result = await get(pathname, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) return null;

  const text = await new Response(result.stream).text();
  return JSON.parse(text);
}

async function upsertLead(lead) {
  await pool.query(
    `
      insert into public.sidestream_download_leads (
        lead_key,
        email,
        email_hash,
        captured_at,
        source_page,
        cta_source,
        referrer,
        user_agent,
        storage_targets,
        migrated_from_blob_pathname,
        context,
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9::text[], $10, $11::jsonb, now(), now())
      on conflict (lead_key) do update set
        email = excluded.email,
        email_hash = excluded.email_hash,
        captured_at = excluded.captured_at,
        source_page = excluded.source_page,
        cta_source = excluded.cta_source,
        referrer = excluded.referrer,
        user_agent = excluded.user_agent,
        storage_targets = excluded.storage_targets,
        migrated_from_blob_pathname = excluded.migrated_from_blob_pathname,
        context = public.sidestream_download_leads.context || excluded.context,
        updated_at = now()
    `,
    [
      lead.leadKey,
      lead.email,
      hashEmail(lead.email),
      lead.capturedAt,
      lead.page || null,
      lead.source || null,
      lead.referrer || null,
      lead.userAgent || null,
      ["supabase", "migrated_from_vercel_blob"],
      lead.blobPathname,
      JSON.stringify(lead.context),
    ],
  );
}

async function fetchRows() {
  const result = await pool.query(`
    select
      email,
      captured_at,
      source_page,
      cta_source,
      referrer,
      storage_targets,
      migrated_from_blob_pathname
    from public.sidestream_download_leads
    order by captured_at asc, created_at asc
  `);
  return result.rows;
}

function createPool() {
  const connectionString = normalizeConnectionString(process.env.POSTGRES_URL);
  return new Pool({
    connectionString,
    max: Number(process.env.POSTGRES_POOL_MAX || 1),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : false,
  });
}

function normalizeConnectionString(connectionString) {
  try {
    const url = new URL(connectionString);
    if (/^(prefer|require)$/i.test(url.searchParams.get("sslmode") || "")) {
      url.searchParams.delete("sslmode");
    }
    return url.toString();
  } catch {
    return connectionString;
  }
}

function shouldUseSsl(connectionString) {
  if (process.env.POSTGRES_SSL === "0") return false;
  if (/sslmode=(disable|false)/i.test(connectionString)) return false;
  return !/localhost|127\.0\.0\.1|::1/.test(connectionString);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeIso(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function cleanString(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength).replace(/[\u0000-\u001f\u007f]/g, "");
}

function hashEmail(email) {
  const secret = process.env.SIDESTREAM_LEAD_HASH_SECRET || process.env.POSTGRES_URL || "sidestream-download-leads-dev-salt";
  return crypto.createHmac("sha256", secret).update(email).digest("hex");
}

function leadKeyFromPathname(pathname) {
  return `vercel_blob:${pathname}`;
}

function preferBlobReadWriteTokenForLocalMigration() {
  if (process.env.SIDESTREAM_USE_BLOB_OIDC === "1") return;
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;

  delete process.env.VERCEL_OIDC_TOKEN;
}

function loadEnvFile(filePath) {
  if (!filePath) return;

  const absolutePath = path.resolve(filePath);
  let text = "";
  try {
    text = fs.readFileSync(absolutePath, "utf8");
  } catch (error) {
    fail(`Could not read env file ${absolutePath}: ${error.message}`);
  }

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.trim().replace(/^['"]|['"]$/g, "");
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

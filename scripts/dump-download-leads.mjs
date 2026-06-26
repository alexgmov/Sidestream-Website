import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

loadEnvFile(process.env.SIDESTREAM_ENV_FILE);
loadEnvFile(process.env.SIDESTREAM_DB_ENV_FILE);

if (!process.env.POSTGRES_URL) {
  fail("Missing POSTGRES_URL. Load the Supabase pooler URL before running this script.");
}

const pool = createPool();

try {
  const result = await pool.query(`
    select
      email,
      captured_at,
      ip_address::text,
      source_page,
      cta_source,
      referrer
    from public.sidestream_download_leads
    order by captured_at asc, created_at asc
  `);

  console.log(JSON.stringify(result.rows, null, 2));
} finally {
  await pool.end();
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

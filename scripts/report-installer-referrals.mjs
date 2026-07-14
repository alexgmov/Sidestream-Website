import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

loadEnvFile(process.env.SIDESTREAM_ENV_FILE);
loadEnvFile(process.env.SIDESTREAM_DB_ENV_FILE);

const POSTGRES_URL_ENV_NAMES = [
  "SIDESTREAM_POSTGRES_URL",
  "SIDESTREAM_POSTGRES_PRISMA_URL",
  "SIDESTREAM_POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
];
const campaign = readOption("--campaign") || "windows_beta_1_0_13";

if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(campaign)) {
  fail("Campaign must use lowercase letters, numbers, dots, underscores, or hyphens");
}

if (!getPostgresConnectionString()) {
  fail(`Missing Postgres connection string. Set one of: ${POSTGRES_URL_ENV_NAMES.join(", ")}`);
}

const pool = createPool();

try {
  const result = await pool.query(
    `
      select
        utm_campaign as campaign,
        coalesce(utm_content, 'unbatched') as batch,
        count(*)::integer as requests,
        count(*) filter (where likely_scanner)::integer as likely_scanner_requests,
        count(*) filter (where not likely_scanner)::integer as likely_human_requests,
        count(distinct request_hash) filter (where not likely_scanner)::integer
          as unique_daily_likely_human_requests,
        min(requested_at) as first_request_at,
        max(requested_at) as latest_request_at
      from public.sidestream_installer_requests
      where utm_source = 'gmail'
        and utm_medium = 'email'
        and utm_campaign = $1
        and platform = 'win32-x64'
      group by utm_campaign, coalesce(utm_content, 'unbatched')
      order by batch
    `,
    [campaign],
  );

  console.log(JSON.stringify({ campaign, batches: result.rows }, null, 2));
} finally {
  await pool.end();
}

function createPool() {
  const connectionString = normalizeConnectionString(getPostgresConnectionString());
  return new Pool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : false,
  });
}

function getPostgresConnectionString() {
  for (const name of POSTGRES_URL_ENV_NAMES) {
    const value = process.env[name]?.trim();
    if (value && !value.includes("[YOUR-") && value !== "changeme") {
      return value;
    }
  }

  return "";
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return String(process.argv[index + 1] || "").trim();
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

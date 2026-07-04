import fs from "node:fs";
import { readdir, readFile } from "node:fs/promises";
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

if (!getPostgresConnectionString()) {
  fail(`Missing Postgres connection string. Set one of: ${POSTGRES_URL_ENV_NAMES.join(", ")}`);
}

const migrationsDir = path.resolve("db/migrations");
const dryRun = process.argv.includes("--dry-run");
const pool = createPool();

try {
  const migrationNames = (await readdir(migrationsDir))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();

  for (const migrationName of migrationNames) {
    const migrationPath = path.join(migrationsDir, migrationName);
    const sql = await readFile(migrationPath, "utf8");
    if (dryRun) {
      console.log(`[dry-run] would apply ${migrationName}`);
      continue;
    }

    await pool.query(sql);
    console.log(`Applied ${migrationName}`);
  }
} finally {
  await pool.end();
}

function createPool() {
  const connectionString = normalizeConnectionString(getPostgresConnectionString());
  return new Pool({
    connectionString,
    max: Number(process.env.POSTGRES_POOL_MAX || 1),
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

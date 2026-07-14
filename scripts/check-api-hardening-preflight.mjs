import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

const REQUIRED_NPM_COMMANDS = [
  "test:entitlement",
  "test:single-device",
  "test:single-device-postgres",
  "typecheck",
];

const REQUIRED_LOCAL_FILES = [
  "tests/api-baseline.test.mjs",
  "scripts/assert-no-runtime-ddl.mjs",
  "scripts/check-api-hardening-preflight.mjs",
];

const ACCEPTANCE_COMMANDS = [
  "npm run test:entitlement",
  "node --experimental-strip-types --test tests/api-baseline.test.mjs",
  "node scripts/assert-no-runtime-ddl.mjs",
  "node scripts/check-api-hardening-preflight.mjs --offline",
  "npm run typecheck",
  "git diff --check",
];

export async function runOfflinePreflight(repoRoot = REPO_ROOT) {
  const packageJson = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
  const scripts = packageJson.scripts || {};
  const missingCommands = REQUIRED_NPM_COMMANDS.filter((name) =>
    typeof scripts[name] !== "string" || !scripts[name].trim()
  );
  const missingFiles = [];
  for (const file of REQUIRED_LOCAL_FILES) {
    try {
      await access(resolve(repoRoot, file));
    } catch {
      missingFiles.push(file);
    }
  }

  if (missingCommands.length || missingFiles.length) {
    const problems = [
      missingCommands.length
        ? `Missing npm command names: ${missingCommands.join(", ")}`
        : "",
      missingFiles.length
        ? `Missing local contract files: ${missingFiles.join(", ")}`
        : "",
    ].filter(Boolean);
    throw new Error(problems.join("\n"));
  }

  return {
    npmCommands: [...REQUIRED_NPM_COMMANDS],
    acceptanceCommands: [...ACCEPTANCE_COMMANDS],
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== "--offline") {
    console.error("Usage: node scripts/check-api-hardening-preflight.mjs --offline");
    console.error("Only the side-effect-free offline preflight is available in this step.");
    process.exitCode = 2;
    return;
  }

  try {
    const result = await runOfflinePreflight();
    console.log("PASS: API hardening offline preflight");
    console.log(`Validated npm command names: ${result.npmCommands.join(", ")}`);
    console.log("Required acceptance commands:");
    for (const command of result.acceptanceCommands) console.log(`  - ${command}`);
    console.log("");
    console.log("Disposable PostgreSQL requirement (not exercised by --offline):");
    console.log("  SIDESTREAM_TEST_POSTGRES_URL must point to an isolated disposable database.");
    console.log("  It must not match production, Preview, Development, or any deployed Test database.");
    console.log("  Database-backed suites may create random schemas, apply migrations, race transactions, and drop those schemas during cleanup.");
    console.log("");
    console.log("Offline safety: no .env files or production secrets were read; no subprocess, network, database, Stripe, Vercel, or other external mutation was attempted.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

await main();

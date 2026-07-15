#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TESTS_DIRECTORY = path.resolve("tests");
const POSTGRES_ONLY_TESTS = new Set([
  "postgres-integration.test.mjs",
  "single-device-postgres.test.mjs",
]);

export async function listApiTestFiles(directory = TESTS_DIRECTORY) {
  const filenames = (await readdir(directory))
    .filter((filename) => filename.endsWith(".test.mjs"))
    .sort();
  const unknownPostgresTests = filenames.filter((filename) =>
    filename.includes("postgres") &&
    !POSTGRES_ONLY_TESTS.has(filename) &&
    filename !== "postgres-config.test.mjs"
  );
  if (unknownPostgresTests.length > 0) {
    throw new Error(
      `Classify new Postgres tests explicitly: ${unknownPostgresTests.join(", ")}`,
    );
  }
  const selected = filenames.filter((filename) => !POSTGRES_ONLY_TESTS.has(filename));
  if (selected.length === 0) throw new Error("No API test suites were discovered");
  return selected.map((filename) => path.join(directory, filename));
}

async function main() {
  const files = await listApiTestFiles();
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    "--test",
    "--test-concurrency=1",
    ...files,
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`API tests terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  process.exitCode = exitCode;
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

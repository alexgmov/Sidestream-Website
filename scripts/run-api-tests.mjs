#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TESTS_DIRECTORY = path.resolve("tests");
const POSTGRES_ONLY_TESTS = new Set([
  "activation-security.test.mjs",
  "maintenance.test.mjs",
  "postgres-integration.test.mjs",
  "single-device-postgres.test.mjs",
  "stripe-events.test.mjs",
]);
const API_SAFE_POSTGRES_TESTS = new Set([
  "checkout-abuse.test.mjs",
  "postgres-config.test.mjs",
]);

export async function listApiTestFiles(directory = TESTS_DIRECTORY) {
  const files = await listTestFiles(directory);
  const relativeFiles = files.map((filename) => normalizeRelativePath(
    path.relative(directory, filename),
  ));
  const sources = await Promise.all(files.map((filename) => readFile(filename, "utf8")));
  const unclassifiedPostgresDependencies = relativeFiles.filter((filename, index) =>
    /\bfrom\s+["']pg["']/.test(sources[index]) &&
    !POSTGRES_ONLY_TESTS.has(filename) &&
    !API_SAFE_POSTGRES_TESTS.has(filename)
  );
  if (unclassifiedPostgresDependencies.length > 0) {
    throw new Error(
      `Classify new Postgres-dependent tests explicitly: ${unclassifiedPostgresDependencies.join(", ")}`,
    );
  }

  const unknownPostgresTests = relativeFiles.filter((filename) =>
    path.basename(filename).includes("postgres") &&
    !POSTGRES_ONLY_TESTS.has(filename) &&
    !API_SAFE_POSTGRES_TESTS.has(filename)
  );
  if (unknownPostgresTests.length > 0) {
    throw new Error(
      `Classify new Postgres tests explicitly: ${unknownPostgresTests.join(", ")}`,
    );
  }

  const selected = files.filter((filename, index) => {
    const relative = relativeFiles[index];
    return !POSTGRES_ONLY_TESTS.has(relative);
  });
  if (selected.length === 0) throw new Error("No API test suites were discovered");
  return selected;
}

async function listTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listTestFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".test.mjs")) files.push(target);
  }
  return files;
}

function normalizeRelativePath(filename) {
  return filename.split(path.sep).join("/");
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
    env: { ...process.env, TZ: "America/Los_Angeles" },
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

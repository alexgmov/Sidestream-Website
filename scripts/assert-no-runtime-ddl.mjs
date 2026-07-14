import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const API_ROOT = resolve(REPO_ROOT, "api");

const DDL_RULES = [
  {
    name: "schema-object DDL",
    pattern: /\b(?:create(?:\s+or\s+replace)?|alter|drop|truncate)\s+(?:unique\s+)?(?:table|index|schema|type|domain|extension|function|procedure|trigger|policy|view|materialized\s+view|sequence)\b/giu,
  },
  {
    name: "default-privilege DDL",
    pattern: /\balter\s+default\s+privileges\b/giu,
  },
  {
    name: "runtime privilege DDL",
    pattern: /\b(?:grant|revoke)\s+(?:all(?:\s+privileges)?|select|insert|update|delete|usage|execute|references|trigger|truncate|connect|temporary|create)(?:\s*,\s*(?:select|insert|update|delete|usage|execute|references|trigger|truncate|connect|temporary|create))*\s+on\b/giu,
  },
  {
    name: "schema comments",
    pattern: /\bcomment\s+on\s+(?:table|column|schema|type|domain|extension|function|procedure|trigger|policy|view|sequence)\b/giu,
  },
];

export async function listApiTypeScriptFiles(apiRoot = API_ROOT) {
  const files = [];
  await walk(apiRoot, files);
  return files.filter((file) => file.endsWith(".ts")).sort();
}

export function findRuntimeDdl(source, file = "<source>") {
  const violations = [];
  for (const rule of DDL_RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of source.matchAll(rule.pattern)) {
      const line = source.slice(0, match.index).split("\n").length;
      const excerpt = source.split("\n")[line - 1]?.trim() || match[0];
      violations.push({ file, line, rule: rule.name, match: match[0], excerpt });
    }
  }
  return violations.sort((left, right) => left.line - right.line);
}

export async function assertNoRuntimeDdl(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const apiRoot = options.apiRoot || resolve(repoRoot, "api");
  const files = await listApiTypeScriptFiles(apiRoot);
  if (files.length === 0) {
    throw new Error(`No api/**/*.ts files found beneath ${apiRoot}`);
  }

  const violations = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    violations.push(...findRuntimeDdl(source, relative(repoRoot, file)));
  }
  if (violations.length > 0) {
    const detail = violations.map((violation) =>
      `${violation.file}:${violation.line} [${violation.rule}] ${violation.excerpt}`
    ).join("\n");
    throw new Error(`Runtime schema DDL is forbidden in api/**/*.ts:\n${detail}`);
  }
  return { checkedFiles: files.length };
}

async function walk(directory, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) await walk(entryPath, files);
    else if (entry.isFile()) files.push(entryPath);
  }
}

async function main() {
  try {
    const result = await assertNoRuntimeDdl();
    console.log(`PASS: no runtime schema DDL in ${result.checkedFiles} api/**/*.ts files.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

const entryUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === entryUrl) await main();

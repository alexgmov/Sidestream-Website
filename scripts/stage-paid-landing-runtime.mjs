#!/usr/bin/env node

import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const compiledLandingPath = path.join(
  repositoryRoot,
  "dist",
  "generated",
  "mobile-paid-prototype.html",
);
const runtimeLandingPath = path.join(
  repositoryRoot,
  "runtime",
  "mobile-paid-prototype.html",
);

await mkdir(path.dirname(runtimeLandingPath), { recursive: true });
await copyFile(compiledLandingPath, runtimeLandingPath);
console.log(
  `Staged ${path.relative(repositoryRoot, runtimeLandingPath)} from compiled Vite output.`,
);

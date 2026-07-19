#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { hasFatalProviderDiagnostic, verifyVercelBuild } from "./verify-vercel-build.mjs";

const outputRoot = path.resolve(".vercel/output");
const child = spawn("npx", ["vercel", "build"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});
let output = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    (stream === child.stdout ? process.stdout : process.stderr).write(text);
  });
}
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
await mkdir(outputRoot, { recursive: true });
await writeFile(path.join(outputRoot, "sidestream-vercel-build.log"), output, {
  mode: 0o600,
});
if (exitCode !== 0 || hasFatalProviderDiagnostic(output)) {
  throw new Error("Vercel build failed or emitted fatal provider diagnostics.");
}
await verifyVercelBuild(outputRoot);
console.log("PASS: Vercel build output and provider diagnostics verified.");

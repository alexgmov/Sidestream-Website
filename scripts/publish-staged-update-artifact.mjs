#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { artifactPath, openEnvelope, parseRelease, parseScope, sha256 } from "../api/_lib/staged-updates.ts";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (key === "--apply") args.apply = true;
  else if (["--release", "--keys", "--artifact", "--confirm"].includes(key) && process.argv[i + 1] && !args[key]) args[key] = process.argv[++i];
  else throw new Error("invalid_argument");
}
try {
  const keys = JSON.parse(fs.readFileSync(args["--keys"], "utf8"));
  const value = openEnvelope(JSON.parse(fs.readFileSync(args["--release"], "utf8")), "release", keys);
  const scope = parseScope(value.scope), release = parseRelease(value, scope);
  if (scope.channel !== "test") throw new Error("production_not_enabled");
  const file = path.resolve(args["--artifact"]), info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== release.artifact.sizeBytes || path.basename(file) !== release.artifact.filename) throw new Error("artifact_identity");
  // The bounded, verified buffer is exactly what gets uploaded. A later source
  // file mutation cannot change the already verified publication bytes.
  const bytes = fs.readFileSync(file);
  if (bytes.length !== release.artifact.sizeBytes || sha256(bytes) !== release.artifact.sha256) throw new Error("artifact_hash");
  const pathname = artifactPath(release);
  if (args.apply) {
    if (args["--confirm"] !== release.releaseId + ":" + release.artifact.sha256) throw new Error("exact_artifact_confirmation_required");
    const { put } = await import("@vercel/blob");
    await put(pathname, bytes, { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "application/zip" });
  }
  console.log(JSON.stringify({ published: Boolean(args.apply), pathname, sha256: release.artifact.sha256, bytes: bytes.length, activationChanged: false, publicInstallerPointersChanged: false }, null, 2));
} catch (error) { console.error("Artifact publication refused:", error.message); process.exitCode = 1; }

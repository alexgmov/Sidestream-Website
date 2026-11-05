#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// This is a local operator, not an HTTP renewal endpoint. Never print bearer URLs.
export async function issueUpdaterBetaDownloads({ beta, delivery, artifactRoot, signingSecret, nowMs, rootOwned = true }) {
  if (!beta) throw new Error("Updater beta installers are disabled");
  const root = path.resolve(artifactRoot);
  if (fs.realpathSync(root) !== root) throw new Error("Artifact root must be canonical");
  for (const artifact of beta.artifacts) {
    await delivery.headInstallerArtifact(artifact.pathname, { provider: "hetzner", artifactRoot: root });
    const file = path.join(root, artifact.pathname);
    if (fs.realpathSync(file) !== file) throw new Error("Artifact links are forbidden");
    let directory = path.dirname(file);
    while (directory.startsWith(root + path.sep) || directory === root) {
      const parent = fs.lstatSync(directory);
      if (!parent.isDirectory() || (parent.mode & 0o022) || (rootOwned && parent.uid !== 0)) throw new Error("Unsafe artifact directory");
      if (directory === root) break;
      directory = path.dirname(directory);
    }
    const before = fs.lstatSync(file);
    if (!before.isFile() || (before.mode & 0o022) || (rootOwned && before.uid !== 0) || before.size !== artifact.sizeBytes) {
      throw new Error("Artifact is not immutable");
    }
    const hash = crypto.createHash("sha256");
    for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
    const after = fs.lstatSync(file);
    if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(key => before[key] !== after[key]) ||
        hash.digest("hex") !== artifact.sha256) throw new Error("Artifact verification failed");
  }
  // Start the five-minute admission window only after verifying both full files.
  const issuedAt = nowMs ?? Date.now();
  const artifacts = beta.artifacts.map(artifact => ({ ...artifact,
    url: delivery.createHetznerSignedDownloadUrl(artifact.pathname, { nowMs: issuedAt, signingSecret }) }));
  return { schema: "sidestream.updater-beta-downloads.v1", candidate: beta.id, version: beta.version,
    sourceSha: beta.sourceSha, seedSha256: beta.seedSha256, issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date((Math.floor(issuedAt / 1000) + 300) * 1000).toISOString(), artifacts };
}

export function writePrivateBetaDownloads(file, result) {
  if (!path.isAbsolute(file)) throw new Error("Output must be absolute");
  const parent = path.dirname(file), stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || fs.realpathSync(parent) !== parent || (stat.mode & 0o077) || stat.uid !== process.getuid()) {
    throw new Error("Output requires an existing private owner directory");
  }
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(result, null, 2) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

async function main(args) {
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage on the deployed Website host: sudo node scripts/issue-updater-beta-downloads.mjs --out /private/operator-directory/new-links.json");
    return;
  }
  if (args.length !== 2 || args[0] !== "--out" || process.getuid() !== 0) throw new Error("Invalid operator invocation");
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const delivery = await import(pathToFileURL(path.join(repo, ".server-dist/api/_lib/installer-delivery.js")));
  const { readUpdaterBetaInstallers } = await import(pathToFileURL(path.join(repo, ".server-dist/api/_lib/updater-beta-installers.js")));
  const beta = readUpdaterBetaInstallers();
  if (!beta) throw new Error("Updater beta installers are disabled");
  const runtimeFile = "/etc/sidestream/website-runtime.json", stat = fs.lstatSync(runtimeFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077)) throw new Error("Unsafe runtime file");
  const runtime = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
  if (delivery.resolveInstallerProvider(runtime.SIDESTREAM_INSTALLER_PROVIDER) !== "hetzner") throw new Error("Hetzner provider required");
  const result = await issueUpdaterBetaDownloads({ beta, delivery,
    artifactRoot: runtime.SIDESTREAM_ARTIFACT_ROOT || "/srv/sidestream/artifacts",
    signingSecret: runtime.SIDESTREAM_DOWNLOAD_SIGNING_SECRET ?? "" });
  writePrivateBetaDownloads(args[1], result);
  console.log(`Verified Install and Restore links written privately; admission expires ${result.expiresAt}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    // Parser/provider/filesystem errors may contain runtime values. Do not echo them.
    console.error("Beta links were not issued. Verify the deployed enabled manifest, immutable artifacts, private output directory and protected runtime configuration.");
    process.exitCode = 1;
  });
}

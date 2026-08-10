#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);

export const LOCAL_RESET_OPERATION = "fresh-meta-paid-production-local";
export const LOCAL_APPLY_CONFIRMATION = "RESET-PRODUCTION-CEP-STATE";

export class LocalResetError extends Error {}

export function parseLocalResetArgs(argv) {
  const options = {
    operation: LOCAL_RESET_OPERATION,
    apply: false,
    confirmation: "",
    help: false,
    preservePaths: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--operation" || argument.startsWith("--operation=")) {
      [options.operation, index] = readOption(argv, index, "--operation");
    } else if (argument === "--confirm" || argument.startsWith("--confirm=")) {
      [options.confirmation, index] = readOption(argv, index, "--confirm");
    } else if (
      argument === "--preserve-path" || argument.startsWith("--preserve-path=")
    ) {
      let value;
      [value, index] = readOption(argv, index, "--preserve-path");
      options.preservePaths.push(path.resolve(value));
    } else {
      throw new LocalResetError(`Unknown argument: ${argument}`);
    }
  }
  if (options.help) return options;
  if (options.operation !== LOCAL_RESET_OPERATION) {
    throw new LocalResetError("The local reset operation is not allowlisted.");
  }
  if (options.apply && options.confirmation !== LOCAL_APPLY_CONFIRMATION) {
    throw new LocalResetError(
      `Apply requires --confirm ${LOCAL_APPLY_CONFIRMATION}.`,
    );
  }
  return options;
}

export function resolveLocalResetPaths({
  homeDir = os.homedir(),
  systemRoot = "/Library",
} = {}) {
  const userApplicationSupport = path.join(homeDir, "Library", "Application Support");
  const systemApplicationSupport = path.join(systemRoot, "Application Support");
  const stateDir = path.join(userApplicationSupport, "Sidestream");
  const systemCepRoot = path.join(systemApplicationSupport, "Adobe", "CEP", "extensions");
  const userCepRoot = path.join(userApplicationSupport, "Adobe", "CEP", "extensions");
  const adobeCepCache = path.join(homeDir, "Library", "Caches", "Adobe", "CEP");

  const targets = [
    target("system-production-extension", path.join(systemCepRoot, "Sidestream")),
    target("user-production-extension", path.join(userCepRoot, "Sidestream")),
    target("legacy-user-production-extension", path.join(userCepRoot, "com.sidestream.downloader")),
    target("production-cep-cache", path.join(adobeCepCache, "com.sidestream.downloader.panel")),
    target("production-cep-html-cache", path.join(adobeCepCache, "CEPHtmlEngine", "com.sidestream.downloader.panel")),
    target("production-named-cep-cache", path.join(adobeCepCache, "Sidestream")),
    target("production-license-device", path.join(stateDir, "license-device-id.production.v1.json")),
    target("production-license-state", path.join(stateDir, "license-state.production.v1.json")),
    target("production-paid-onboarding-state", path.join(stateDir, "paid-onboarding-state.production.v1.json")),
    target("production-telemetry-state", path.join(stateDir, "telemetry-state.json")),
    target("production-telemetry-queue", path.join(stateDir, "telemetry-queue.json")),
    target("system-production-installer-receipt", path.join(systemApplicationSupport, "Sidestream", "installer-receipt.json")),
  ];
  const preserved = [
    target("system-test-extension", path.join(systemCepRoot, "Sidestream Test")),
    target("user-test-extension", path.join(userCepRoot, "Sidestream Test")),
    target("test-license-device", path.join(stateDir, "license-device-id.test.v1.json")),
    target("downloaded-media", path.join(homeDir, "Downloads")),
    target("premiere-projects", path.join(homeDir, "Documents", "Adobe")),
  ];
  return {
    stateDir,
    backupRoot: path.join(stateDir, "cep-backups"),
    cepRoots: [systemCepRoot, userCepRoot],
    targets,
    preserved,
  };
}

export function inventoryLocalPaths(paths, fileSystem = fs) {
  return paths.map((entry) => {
    let stat = null;
    try {
      stat = fileSystem.lstatSync(entry.path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return {
      label: entry.label,
      pathFingerprint: fingerprint(entry.path),
      exists: Boolean(stat),
      type: stat ? (stat.isDirectory() ? "directory" : "file") : "missing",
    };
  });
}

export function findBlockingProductionProcesses(psOutput) {
  const blockers = [];
  for (const line of String(psOutput || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const command = match[2];
    const lower = command.toLowerCase();
    const premiere = lower.includes("adobe premiere pro");
    const productionCep = lower.includes("cephtmlengine") &&
      (lower.includes("com.sidestream.downloader.panel") ||
        /(?:^|[\\/])sidestream(?:[\\/]|$)/i.test(command)) &&
      !lower.includes("sidestream test") &&
      !lower.includes("com.sidestream.downloader.test");
    if (premiere || productionCep) {
      blockers.push({ pid: Number(match[1]), kind: premiere ? "premiere" : "production-cep" });
    }
  }
  return blockers;
}

export function buildLocalResetReport({ mode, inventory, backupFingerprint = null, preserved = null }) {
  return {
    operation: LOCAL_RESET_OPERATION,
    mode,
    counts: {
      present: inventory.filter((entry) => entry.exists).length,
      missing: inventory.filter((entry) => !entry.exists).length,
    },
    inventory,
    backupFingerprint,
    preserved,
  };
}

export async function runLocalProductionReset(options, {
  roots = resolveLocalResetPaths(),
  fileSystem = fs,
  now = () => new Date(),
  readProcesses = defaultReadProcesses,
  requestPremiereQuit = defaultRequestPremiereQuit,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const extraPreserved = options.preservePaths.map((value, index) =>
    target(`operator-preserved-${index + 1}`, value)
  );
  const inventory = inventoryLocalPaths(roots.targets, fileSystem);
  const preservedPaths = [...roots.preserved, ...extraPreserved];
  const beforePreserved = snapshotPreservedState(
    preservedPaths,
    roots.cepRoots,
    fileSystem,
  );
  if (!options.apply) {
    return buildLocalResetReport({
      mode: "dry-run",
      inventory,
      preserved: beforePreserved.report,
    });
  }

  const initialBlockers = findBlockingProductionProcesses(await readProcesses());
  if (initialBlockers.length) await requestPremiereQuit(initialBlockers);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const blockers = findBlockingProductionProcesses(await readProcesses());
    if (!blockers.length) break;
    if (attempt === 19) {
      throw new LocalResetError(
        "Premiere or a Production CEP process is still running; nothing was moved.",
      );
    }
    await wait(250);
  }

  const slug = utcTimestampSlug(now());
  const backupPath = path.join(
    roots.backupRoot,
    `fresh-meta-paid-production-${slug}`,
  );
  if (fileSystem.existsSync(backupPath)) {
    throw new LocalResetError("The timestamped backup destination already exists.");
  }
  fileSystem.mkdirSync(backupPath, { recursive: true, mode: 0o700 });
  fileSystem.chmodSync(backupPath, 0o700);
  const moved = [];
  try {
    for (const entry of roots.targets) {
      if (!fileSystem.existsSync(entry.path)) continue;
      const destination = path.join(backupPath, entry.label);
      fileSystem.renameSync(entry.path, destination);
      moved.push({ ...entry, destination });
    }
    const remaining = inventoryLocalPaths(roots.targets, fileSystem);
    if (remaining.some((entry) => entry.exists)) {
      throw new LocalResetError("A Production reset target remained in place.");
    }
    const afterPreserved = snapshotPreservedState(
      preservedPaths,
      roots.cepRoots,
      fileSystem,
    );
    if (beforePreserved.fingerprint !== afterPreserved.fingerprint) {
      throw new LocalResetError("A Test, project, media, or unrelated CEP invariant changed.");
    }
    const mode = fileSystem.statSync(backupPath).mode & 0o777;
    if (mode !== 0o700) {
      throw new LocalResetError("The recovery backup is not mode 0700.");
    }
    return buildLocalResetReport({
      mode: "apply",
      inventory: remaining,
      backupFingerprint: fingerprint(backupPath),
      preserved: afterPreserved.report,
    });
  } catch (error) {
    for (const entry of moved.reverse()) {
      if (fileSystem.existsSync(entry.destination) && !fileSystem.existsSync(entry.path)) {
        fileSystem.mkdirSync(path.dirname(entry.path), { recursive: true });
        fileSystem.renameSync(entry.destination, entry.path);
      }
    }
    throw error;
  }
}

function snapshotPreservedState(paths, cepRoots, fileSystem) {
  const items = inventoryLocalPaths(paths, fileSystem);
  const unrelatedCep = [];
  for (const root of cepRoots) {
    let names = [];
    try {
      names = fileSystem.readdirSync(root);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (const name of names) {
      if (["Sidestream", "com.sidestream.downloader"].includes(name)) continue;
      unrelatedCep.push(fingerprint(path.join(root, name)));
    }
  }
  unrelatedCep.sort();
  const canonical = JSON.stringify({ items, unrelatedCep });
  return {
    fingerprint: fingerprint(canonical),
    report: {
      paths: items,
      unrelatedCepCount: unrelatedCep.length,
      unrelatedCepFingerprint: fingerprint(unrelatedCep.join("\0")),
    },
  };
}

async function defaultReadProcesses() {
  const { stdout } = await execFile("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 5_000,
  });
  return stdout;
}

async function defaultRequestPremiereQuit(blockers) {
  if (!blockers.some((process) => process.kind === "premiere")) return;
  try {
    await execFile("osascript", [
      "-e",
      'tell application "Adobe Premiere Pro" to quit',
    ], { encoding: "utf8", timeout: 10_000 });
  } catch {
    throw new LocalResetError(
      "Could not ask Premiere to quit normally; no local state was moved.",
    );
  }
}

function target(label, value) {
  return Object.freeze({ label, path: path.resolve(value) });
}

function fingerprint(value) {
  return createHash("sha256")
    .update(`sidestream-local-reset-v1\0${String(value)}`)
    .digest("hex");
}

function utcTimestampSlug(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new LocalResetError("Invalid backup timestamp.");
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function readOption(argv, index, name) {
  const argument = argv[index];
  if (argument.startsWith(`${name}=`)) {
    const value = argument.slice(name.length + 1).trim();
    if (!value) throw new LocalResetError(`${name} requires a value.`);
    return [value, index];
  }
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new LocalResetError(`${name} requires a value.`);
  }
  return [value, index + 1];
}

function printHelp() {
  console.log(`Usage:
  npm run fresh-paid:reset-local
  npm run fresh-paid:reset-local -- --apply --confirm ${LOCAL_APPLY_CONFIRMATION}

Dry-run is the default. Apply asks Premiere to quit normally, refuses while a
Production CEP process remains, and moves only explicit Production paths into
a mode-0700 timestamped recovery backup.`);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseLocalResetArgs(argv);
  if (options.help) return printHelp();
  console.log(JSON.stringify(await runLocalProductionReset(options), null, 2));
}

const entryUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error(
      error instanceof LocalResetError
        ? error.message
        : "Local Production reset failed closed before any safe report was available.",
    );
    process.exitCode = 1;
  });
}

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LOCAL_APPLY_CONFIRMATION,
  findBlockingProductionProcesses,
  parseLocalResetArgs,
  resolveLocalResetPaths,
  runLocalProductionReset,
} from "../scripts/reset-local-production-for-paid-test.mjs";

test("local reset is Production-only, dry-run by default, and strongly confirms apply", () => {
  assert.deepEqual(parseLocalResetArgs([]), {
    operation: "fresh-meta-paid-production-local",
    apply: false,
    confirmation: "",
    help: false,
    preservePaths: [],
  });
  assert.throws(() => parseLocalResetArgs(["--apply"]), /Apply requires/);
  assert.equal(parseLocalResetArgs([
    "--apply", "--confirm", LOCAL_APPLY_CONFIRMATION,
  ]).apply, true);
});

test("process check distinguishes Production CEP from Test", () => {
  const blockers = findBlockingProductionProcesses(`
101 /Applications/Adobe Premiere Pro 2025/Adobe Premiere Pro.app/Contents/MacOS/Adobe Premiere Pro
102 CEPHtmlEngine --extension com.sidestream.downloader.panel /Library/Application Support/Adobe/CEP/extensions/Sidestream
103 CEPHtmlEngine --extension com.sidestream.downloader.test.panel /Library/Application Support/Adobe/CEP/extensions/Sidestream Test
104 CEPHtmlEngine --extension com.example.keep.panel
`);
  assert.deepEqual(blockers, [
    { pid: 101, kind: "premiere" },
    { pid: 102, kind: "production-cep" },
  ]);
});

test("dry-run inventories system receipt and Production state without mutation", async (t) => {
  const fixture = makeFixture(t);
  let quitCalls = 0;
  const before = snapshotTree(fixture.root);
  const report = await runLocalProductionReset(parseLocalResetArgs([]), {
    roots: fixture.paths,
    requestPremiereQuit: async () => { quitCalls += 1; },
    readProcesses: async () => "101 Adobe Premiere Pro",
  });
  assert.equal(report.mode, "dry-run");
  assert.equal(quitCalls, 0);
  assert.deepEqual(snapshotTree(fixture.root), before);
  assert.equal(
    report.inventory.find((entry) => entry.label === "system-production-installer-receipt").exists,
    true,
  );
  assert.equal(JSON.stringify(report).includes(fixture.root), false);
});

test("apply quits normally, moves every Production target to a 0700 backup, and preserves Test/media/projects/unrelated CEP", async (t) => {
  const fixture = makeFixture(t);
  let processReads = 0;
  let quitCalls = 0;
  const report = await runLocalProductionReset(parseLocalResetArgs([
    "--apply", "--confirm", LOCAL_APPLY_CONFIRMATION,
  ]), {
    roots: fixture.paths,
    now: () => new Date("2026-08-10T12:34:56.000Z"),
    readProcesses: async () => {
      processReads += 1;
      return processReads === 1
        ? "101 Adobe Premiere Pro\n102 CEPHtmlEngine com.sidestream.downloader.panel"
        : "103 CEPHtmlEngine com.sidestream.downloader.test.panel";
    },
    requestPremiereQuit: async () => { quitCalls += 1; },
    wait: async () => {},
  });
  assert.equal(report.mode, "apply");
  assert.equal(quitCalls, 1);
  assert.equal(report.inventory.every((entry) => !entry.exists), true);
  const backup = path.join(
    fixture.paths.backupRoot,
    "fresh-meta-paid-production-20260810T123456Z",
  );
  assert.equal(fs.statSync(backup).mode & 0o777, 0o700);
  for (const target of fixture.presentTargets) {
    assert.equal(fs.existsSync(target.path), false, target.label);
    assert.equal(fs.existsSync(path.join(backup, target.label)), true, target.label);
  }
  for (const preserved of fixture.presentPreserved) {
    assert.equal(fs.existsSync(preserved.path), true, preserved.label);
  }
  assert.equal(fs.existsSync(fixture.unrelatedExtension), true);
  assert.equal(JSON.stringify(report).includes(fixture.root), false);
});

test("apply refuses while Production CEP remains and does not create a backup", async (t) => {
  const fixture = makeFixture(t);
  const before = snapshotTree(fixture.root);
  await assert.rejects(() => runLocalProductionReset(parseLocalResetArgs([
    "--apply", "--confirm", LOCAL_APPLY_CONFIRMATION,
  ]), {
    roots: fixture.paths,
    readProcesses: async () => "102 CEPHtmlEngine com.sidestream.downloader.panel",
    requestPremiereQuit: async () => {},
    wait: async () => {},
  }), /still running/);
  assert.deepEqual(snapshotTree(fixture.root), before);
});

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidestream-local-reset-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home");
  const systemRoot = path.join(root, "Library");
  const paths = resolveLocalResetPaths({ homeDir, systemRoot });
  const presentTargets = paths.targets.filter((entry) => [
    "system-production-extension",
    "production-cep-cache",
    "production-license-device",
    "production-telemetry-state",
    "production-telemetry-queue",
    "system-production-installer-receipt",
  ].includes(entry.label));
  const presentPreserved = paths.preserved.filter((entry) => [
    "system-test-extension",
    "test-license-device",
    "downloaded-media",
    "premiere-projects",
  ].includes(entry.label));
  for (const entry of [...presentTargets, ...presentPreserved]) {
    const isFile = /device|state|queue|receipt/.test(entry.label);
    if (isFile) {
      fs.mkdirSync(path.dirname(entry.path), { recursive: true });
      fs.writeFileSync(entry.path, `${entry.label}\n`);
    } else {
      fs.mkdirSync(entry.path, { recursive: true });
      fs.writeFileSync(path.join(entry.path, "keep.txt"), `${entry.label}\n`);
    }
  }
  const unrelatedExtension = path.join(paths.cepRoots[0], "com.example.keep");
  fs.mkdirSync(unrelatedExtension, { recursive: true });
  fs.writeFileSync(path.join(unrelatedExtension, "manifest.xml"), "keep\n");
  return { root, paths, presentTargets, presentPreserved, unrelatedExtension };
}

function snapshotTree(root) {
  const entries = [];
  function walk(current) {
    if (!fs.existsSync(current)) return;
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      entries.push(path.relative(root, full));
      if (fs.statSync(full).isDirectory()) walk(full);
    }
  }
  walk(root);
  return entries;
}

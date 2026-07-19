import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  createTypeScriptSourceResolveHook,
} from "./helpers/typescript-source-resolution-hook.mjs";

async function createFixture(t) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "sidestream-ts-resolution-"));
  t.after(() => rm(temporaryRoot, { force: true, recursive: true }));
  const repositoryRoot = path.join(temporaryRoot, "repository");
  const sourceRoot = path.join(repositoryRoot, "api", "_lib");
  await mkdir(sourceRoot, { recursive: true });
  const parentPath = path.join(sourceRoot, "parent.ts");
  await writeFile(parentPath, "export {};\n");
  return {
    parentURL: pathToFileURL(parentPath).href,
    repositoryRoot,
    resolve: createTypeScriptSourceResolveHook(repositoryRoot),
    sourceRoot,
    temporaryRoot,
  };
}

function moduleNotFound(specifier) {
  const error = new Error(`Cannot find module ${specifier}`);
  error.code = "ERR_MODULE_NOT_FOUND";
  return error;
}

function rejectingResolver(error, calls) {
  return async (specifier) => {
    calls.push(specifier);
    throw error;
  };
}

test("normal JavaScript resolution wins before the TypeScript fallback", async (t) => {
  const fixture = await createFixture(t);
  const expected = { url: "file:///normally-resolved.js" };
  const calls = [];
  const result = await fixture.resolve("./target.js", { parentURL: fixture.parentURL },
    async (specifier) => {
      calls.push(specifier);
      return expected;
    });

  assert.equal(result, expected);
  assert.deepEqual(calls, ["./target.js"]);
});

test("a missing relative JavaScript source maps to the existing same-repository TypeScript file",
  async (t) => {
    const fixture = await createFixture(t);
    const targetPath = path.join(fixture.sourceRoot, "target.ts");
    await writeFile(targetPath, "export const target = true;\n");
    const calls = [];
    const originalError = moduleNotFound("./target.js");

    const result = await fixture.resolve("./target.js", { parentURL: fixture.parentURL },
      async (specifier) => {
        calls.push(specifier);
        if (calls.length === 1) throw originalError;
        return { url: specifier };
      });

    const canonicalTargetUrl = pathToFileURL(await realpath(targetPath)).href;
    assert.deepEqual(calls, ["./target.js", canonicalTargetUrl]);
    assert.deepEqual(result, { url: canonicalTargetUrl });
  });

test("the fallback rejects a TypeScript target outside the repository", async (t) => {
  const fixture = await createFixture(t);
  const outsidePath = path.join(fixture.temporaryRoot, "outside", "target.ts");
  await mkdir(path.dirname(outsidePath), { recursive: true });
  await writeFile(outsidePath, "export {};\n");
  const error = moduleNotFound("../../../outside/target.js");
  const calls = [];

  await assert.rejects(
    fixture.resolve("../../../outside/target.js", { parentURL: fixture.parentURL },
      rejectingResolver(error, calls)),
    (caught) => caught === error,
  );
  assert.deepEqual(calls, ["../../../outside/target.js"]);
});

test("the fallback rejects parents and targets in node_modules", async (t) => {
  const fixture = await createFixture(t);
  const moduleRoot = path.join(fixture.repositoryRoot, "node_modules", "fixture");
  await mkdir(moduleRoot, { recursive: true });
  const moduleParent = path.join(moduleRoot, "parent.ts");
  const moduleTarget = path.join(moduleRoot, "target.ts");
  await writeFile(moduleParent, "export {};\n");
  await writeFile(moduleTarget, "export {};\n");

  for (const { specifier, parentURL } of [
    { specifier: "../../node_modules/fixture/target.js", parentURL: fixture.parentURL },
    { specifier: "./target.js", parentURL: pathToFileURL(moduleParent).href },
  ]) {
    const error = moduleNotFound(specifier);
    const calls = [];
    await assert.rejects(
      fixture.resolve(specifier, { parentURL }, rejectingResolver(error, calls)),
      (caught) => caught === error,
    );
    assert.deepEqual(calls, [specifier]);
  }
});

test("the fallback rejects a missing same-repository TypeScript target", async (t) => {
  const fixture = await createFixture(t);
  const error = moduleNotFound("./missing.js");
  const calls = [];

  await assert.rejects(
    fixture.resolve("./missing.js", { parentURL: fixture.parentURL },
      rejectingResolver(error, calls)),
    (caught) => caught === error,
  );
  assert.deepEqual(calls, ["./missing.js"]);
});

test("the fallback rejects non-relative JavaScript requests", async (t) => {
  const fixture = await createFixture(t);
  const error = moduleNotFound("package.js");
  const calls = [];

  await assert.rejects(
    fixture.resolve("package.js", { parentURL: fixture.parentURL },
      rejectingResolver(error, calls)),
    (caught) => caught === error,
  );
  assert.deepEqual(calls, ["package.js"]);
});

test("the fallback rejects relative requests without a JavaScript extension", async (t) => {
  const fixture = await createFixture(t);
  const error = moduleNotFound("./target.mjs");
  const calls = [];

  await assert.rejects(
    fixture.resolve("./target.mjs", { parentURL: fixture.parentURL },
      rejectingResolver(error, calls)),
    (caught) => caught === error,
  );
  assert.deepEqual(calls, ["./target.mjs"]);
});

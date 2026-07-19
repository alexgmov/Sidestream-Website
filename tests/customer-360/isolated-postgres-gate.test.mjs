import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGGREGATE_SCRIPT_NAMES,
  DATABASE_SELECTOR_ENV_NAMES,
  DEPLOYED_TARGET_ENV_NAMES,
  FORBIDDEN_OVERRIDE_ENV_NAMES,
  assertLoopbackServerArguments,
  assertRepositoryLockedInstall,
  assertSafeClusterRoot,
  assertSafeGeneratedConnectionString,
  buildGateCommands,
  buildLocalTypeScriptResolutionHookSource,
  buildProviderBlockingBootstrapSource,
  buildStrictChildEnvironment,
  resolveSafeTempRoot,
  validateGateInvocation,
} from "../../scripts/run-customer-360-isolated-postgres-gate.mjs";

const fixture = Object.freeze({
  binaries: {
    initdb: "/installed/postgres/bin/initdb",
    postgres: "/installed/postgres/bin/postgres",
    pgCtl: "/installed/postgres/bin/pg_ctl",
    npm: "/installed/node/bin/npm",
  },
  dataDirectory: "/safe/tmp/sidestream-c360-postgres-gate-fixture/data",
  passwordFile: "/safe/tmp/sidestream-c360-postgres-gate-fixture/postgres-password",
  port: 45_432,
  databaseName: "sidestream_gate_0123456789abcdef",
  databaseUser: "sidestream_gate",
});

test("gate commands are authenticated, loopback-only, and run every required aggregate", () => {
  const commands = buildGateCommands(fixture);
  assert.deepEqual(
    commands.initdb.arguments.slice(commands.initdb.arguments.indexOf("--auth-local"), -4),
    ["--auth-local", "reject", "--auth-host", "scram-sha-256"],
  );
  assertLoopbackServerArguments(commands.server.arguments);
  assert.ok(commands.server.arguments.includes("listen_addresses=127.0.0.1"));
  assert.ok(commands.server.arguments.includes("unix_socket_directories="));
  assert.equal(
    commands.createDatabase.input,
    `CREATE DATABASE "${fixture.databaseName}" ENCODING 'UTF8' TEMPLATE template0;\n`,
  );
  assert.deepEqual(
    commands.aggregates.map(({ arguments: arguments_ }) => arguments_),
    AGGREGATE_SCRIPT_NAMES.map((name) => ["run", name]),
  );
  assert.doesNotMatch(JSON.stringify(commands), /postgresql:\/\//);
  assert.doesNotMatch(JSON.stringify(commands), /0\.0\.0\.0|::1|localhost/);
});

test("package command and closed Customer 360 registry classify the infrastructure self-test", async () => {
  const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["test:customer-360-isolated-postgres-gate"],
    "node scripts/run-customer-360-isolated-postgres-gate.mjs",
  );
  assert.equal(
    packageJson.scripts["test:customer-360-postgres"],
    "node scripts/run-customer-360-tests.mjs --postgres",
  );
  const registry = await readFile(path.resolve("scripts/run-customer-360-tests.mjs"), "utf8");
  assert.match(registry, /"customer-360\/isolated-postgres-gate\.test\.mjs"/);
});

test("gate refuses root, arguments, ambient selectors, Node hooks, and deployed targets", () => {
  assert.throws(() => validateGateInvocation({ uid: 0, environment: {} }), /root execution/);
  assert.throws(() => validateGateInvocation({
    uid: 501,
    argv: ["--port", "45432"],
    environment: {},
  }), /accepts no arguments/);
  for (const name of DATABASE_SELECTOR_ENV_NAMES) {
    assert.throws(() => validateGateInvocation({
      uid: 501,
      environment: { [name]: "postgresql://remote.invalid/database" },
    }), new RegExp(name));
  }
  for (const name of FORBIDDEN_OVERRIDE_ENV_NAMES) {
    assert.throws(() => validateGateInvocation({
      uid: 501,
      environment: { [name]: "ambient-override" },
    }), new RegExp(name));
  }
  for (const name of DEPLOYED_TARGET_ENV_NAMES) {
    assert.throws(() => validateGateInvocation({
      uid: 501,
      environment: { [name]: "production" },
    }), new RegExp(name));
  }
  assert.doesNotThrow(() => validateGateInvocation({
    uid: 501,
    environment: { PATH: "/installed/bin", HOME: "/safe/home" },
  }));
});

test("strict children receive only the generated database URL and gate-owned controls", () => {
  const connectionString =
    "postgresql://sidestream_gate:generated-secret@127.0.0.1:45432/sidestream_gate_fixture?sslmode=disable";
  const environment = buildStrictChildEnvironment({
    executablePath: "/installed/node/bin/node",
    npmPath: fixture.binaries.npm,
    postgresBinaryPaths: [fixture.binaries.initdb, fixture.binaries.postgres, fixture.binaries.pgCtl],
    clusterRoot: "/safe/tmp/sidestream-c360-postgres-gate-fixture",
    connectionString,
    bootstrapUrl: "file:///safe/tmp/sidestream-c360-postgres-gate-fixture/gate-bootstrap.mjs",
  });
  assert.equal(environment.SIDESTREAM_TEST_POSTGRES_URL, connectionString);
  assert.equal(environment.NODE_OPTIONS,
    "--import=file:///safe/tmp/sidestream-c360-postgres-gate-fixture/gate-bootstrap.mjs");
  assert.deepEqual(Object.keys(environment).sort(), [
    "HOME",
    "LANG",
    "LC_ALL",
    "NODE_OPTIONS",
    "NO_COLOR",
    "PATH",
    "SIDESTREAM_TEST_POSTGRES_URL",
    "TMPDIR",
    "TZ",
    "npm_config_audit",
    "npm_config_cache",
    "npm_config_fund",
    "npm_config_offline",
    "npm_config_update_notifier",
  ]);
  for (const name of DATABASE_SELECTOR_ENV_NAMES) {
    assert.equal(Object.hasOwn(environment, name), name === "SIDESTREAM_TEST_POSTGRES_URL", name);
  }
});

test("the current checkout owns a lock-matching install", async () => {
  const install = await assertRepositoryLockedInstall();
  assert.equal(install.repositoryRoot, await resolveSafeRealpath(process.cwd()));
  assert.equal(install.nodeModules, path.join(install.repositoryRoot, "node_modules"));
});

test("TypeScript resolution stays in source and never falls back to another node_modules", () => {
  const source = buildLocalTypeScriptResolutionHookSource(process.cwd());
  assert.match(source, /await nextResolve\(specifier, context\)/);
  assert.match(source, /specifier\.replace\(\/\\\.js\$\/, "\.ts"\)/);
  assert.match(source, /isInside\(candidatePath, repositoryRoot\)/);
  assert.match(source, /isInside\(candidatePath, nodeModulesRoot\)/);
  assert.doesNotMatch(source, /installedPackageParent|gitdir|worktreesMarker|parentURL:\s*installed/);
});

test("provider bootstrap registers the local resolver and blocks every non-Postgres client", () => {
  const source = buildProviderBlockingBootstrapSource({ port: fixture.port });
  assert.match(source, /register\(new URL\("\.\/typescript-resolution-hook\.mjs"/);
  assert.match(source, /target\.host !== allowedHost \|\| !Number\.isInteger\(target\.port\)/);
  assert.match(source, /target\.port < 1 \|\| target\.port > 65535/);
  assert.match(source, /tls\.connect =/);
  assert.match(source, /globalThis\.fetch/);
  assert.match(source, /providers: "blocked"/);
});

test("generated target validation rejects remote, unauthenticated, and override-bearing URLs", () => {
  assert.doesNotThrow(() => assertSafeGeneratedConnectionString(
    "postgresql://sidestream_gate:secret@127.0.0.1:45432/sidestream_gate_fixture?sslmode=disable",
  ));
  for (const value of [
    "postgresql://sidestream_gate:secret@database.example.invalid:45432/sidestream_gate_fixture?sslmode=disable",
    "postgresql://sidestream_gate@127.0.0.1:45432/sidestream_gate_fixture?sslmode=disable",
    "postgresql://sidestream_gate:secret@127.0.0.1:45432/sidestream_gate_fixture?host=remote.invalid&sslmode=disable",
    "postgresql://sidestream_gate:secret@127.0.0.1:45432/deployed_test?sslmode=disable",
  ]) {
    assert.throws(() => assertSafeGeneratedConnectionString(value), /loopback-only/);
  }
});

test("server validation rejects non-loopback binds and missing socket isolation", () => {
  const safe = buildGateCommands(fixture).server.arguments;
  const remoteHost = [...safe];
  remoteHost[remoteHost.indexOf("-h") + 1] = "0.0.0.0";
  assert.throws(() => assertLoopbackServerArguments(remoteHost), /127\.0\.0\.1/);
  assert.throws(
    () => assertLoopbackServerArguments(safe.filter((value) => value !== "unix_socket_directories=")),
    /Unix sockets must be disabled/,
  );
});

test("temporary-root and cleanup guards reject symlinks and unsafe paths", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "sidestream-gate-self-test-"));
  try {
    const safeTempRoot = path.join(parent, "temp-root");
    const symlinkedTempRoot = path.join(parent, "temp-root-link");
    await mkdir(safeTempRoot, { mode: 0o700 });
    await symlink(safeTempRoot, symlinkedTempRoot);
    const canonicalTempRoot = await resolveSafeTempRoot(safeTempRoot);
    assert.equal(canonicalTempRoot, await resolveSafeRealpath(safeTempRoot));
    await assert.rejects(() => resolveSafeTempRoot(symlinkedTempRoot), /symbolic link/);
    await assert.rejects(() => resolveSafeTempRoot(path.parse(parent).root), /filesystem root/);

    const clusterRoot = await mkdtemp(path.join(
      canonicalTempRoot,
      "sidestream-c360-postgres-gate-",
    ));
    assert.equal(await assertSafeClusterRoot(clusterRoot, canonicalTempRoot), clusterRoot);
    await assert.rejects(
      () => assertSafeClusterRoot(canonicalTempRoot, canonicalTempRoot),
      /unsafe/,
    );
    await assert.rejects(() => assertSafeClusterRoot(parent, canonicalTempRoot), /unsafe/);
    const clusterLink = path.join(
      canonicalTempRoot,
      "sidestream-c360-postgres-gate-link",
    );
    await symlink(clusterRoot, clusterLink);
    await assert.rejects(
      () => assertSafeClusterRoot(clusterLink, canonicalTempRoot),
      /real directory/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

async function resolveSafeRealpath(filename) {
  const { realpath } = await import("node:fs/promises");
  return realpath(filename);
}

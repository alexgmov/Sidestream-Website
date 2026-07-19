#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TEST_DATABASE_ENV = "SIDESTREAM_TEST_POSTGRES_URL";
export const AGGREGATE_SCRIPT_NAMES = Object.freeze([
  "test:customer-360-postgres",
  "test:postgres-integration",
  "test:single-device",
]);

export const DATABASE_SELECTOR_ENV_NAMES = Object.freeze([
  TEST_DATABASE_ENV,
  "SIDESTREAM_PRODUCTION_POSTGRES_URL",
  "SIDESTREAM_PRODUCTION_POSTGRES_PRISMA_URL",
  "SIDESTREAM_POSTGRES_URL",
  "SIDESTREAM_POSTGRES_PRISMA_URL",
  "SIDESTREAM_POSTGRES_URL_NON_POOLING",
  "SIDESTREAM_PREVIEW_POSTGRES_URL",
  "SIDESTREAM_PREVIEW_POSTGRES_PRISMA_URL",
  "SIDESTREAM_DEPLOYED_TEST_POSTGRES_URL",
  "SIDESTREAM_TEST_RUNTIME_POSTGRES_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
  "SIDESTREAM_TELEMETRY_POSTGRES_URL",
  "TELEMETRY_POSTGRES_URL",
  "DATABASE_URL",
  "PREVIEW_DATABASE_URL",
  "TEST_DATABASE_URL",
]);

export const FORBIDDEN_OVERRIDE_ENV_NAMES = Object.freeze([
  "NODE_OPTIONS",
  "NODE_PATH",
  "PGAPPNAME",
  "PGCHANNELBINDING",
  "PGCLIENTENCODING",
  "PGCONNECT_TIMEOUT",
  "PGDATABASE",
  "PGDATA",
  "PGHOST",
  "PGHOSTADDR",
  "PGOPTIONS",
  "PGPASSFILE",
  "PGPASSWORD",
  "PGPORT",
  "PGREQUIRESSL",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGSSLMODE",
  "PGSSLROOTCERT",
  "PGSYSCONFDIR",
  "PGTARGETSESSIONATTRS",
  "PGUSER",
  "POSTGRES_BIND",
  "POSTGRES_HOST",
  "POSTGRES_PORT",
  "SIDESTREAM_ISOLATED_POSTGRES_BIND",
  "SIDESTREAM_ISOLATED_POSTGRES_HOST",
  "SIDESTREAM_ISOLATED_POSTGRES_PORT",
  "SIDESTREAM_ISOLATED_POSTGRES_URL",
]);

export const DEPLOYED_TARGET_ENV_NAMES = Object.freeze([
  "VERCEL_ENV",
  "VERCEL_TARGET_ENV",
  "VERCEL_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
]);

const LOOPBACK_HOST = "127.0.0.1";
const CLUSTER_PREFIX = "sidestream-c360-postgres-gate-";
const DATABASE_PREFIX = "sidestream_gate_";
const POSTGRES_START_TIMEOUT_MS = 30_000;
const POSTGRES_STOP_TIMEOUT_MS = 20_000;
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function validateGateInvocation({
  argv = [],
  environment = process.env,
  uid = typeof process.getuid === "function" ? process.getuid() : undefined,
} = {}) {
  if (uid === 0) {
    throw new Error("The isolated Postgres gate refuses root execution");
  }
  if (argv.length !== 0) {
    throw new Error("The isolated Postgres gate accepts no arguments or target overrides");
  }
  for (const name of DATABASE_SELECTOR_ENV_NAMES) {
    if (Object.hasOwn(environment, name)) {
      throw new Error(`Refusing ambient runtime database selector ${name}`);
    }
  }
  for (const name of FORBIDDEN_OVERRIDE_ENV_NAMES) {
    if (Object.hasOwn(environment, name)) {
      throw new Error(`Refusing ambient Postgres or Node override ${name}`);
    }
  }
  for (const name of DEPLOYED_TARGET_ENV_NAMES) {
    if (Object.hasOwn(environment, name)) {
      throw new Error(`Refusing deployed target marker ${name}`);
    }
  }
}

export async function assertRepositoryLockedInstall(root = repositoryRoot) {
  const canonicalRoot = await realpath(path.resolve(root));
  const canonicalCwd = await realpath(process.cwd());
  if (canonicalCwd !== canonicalRoot) {
    throw new Error("Run the isolated Postgres gate from its repository root");
  }

  const nodeModules = path.join(canonicalRoot, "node_modules");
  const nodeModulesMetadata = await lstat(nodeModules).catch(() => null);
  if (!nodeModulesMetadata?.isDirectory() || nodeModulesMetadata.isSymbolicLink()) {
    throw new Error("The repository needs its own non-symlinked node_modules from npm ci");
  }
  if (await realpath(nodeModules) !== nodeModules) {
    throw new Error("The repository node_modules must belong to this checkout");
  }

  const packageLockPath = path.join(canonicalRoot, "package-lock.json");
  const installedLockPath = path.join(nodeModules, ".package-lock.json");
  await assertRegularFile(packageLockPath, "package-lock.json");
  await assertRegularFile(installedLockPath, "node_modules/.package-lock.json");
  const packageLock = JSON.parse(await readFile(packageLockPath, "utf8"));
  const installedLock = JSON.parse(await readFile(installedLockPath, "utf8"));
  if (packageLock.lockfileVersion !== 3 || installedLock.lockfileVersion !== 3) {
    throw new Error("The repository requires an npm lockfileVersion 3 install");
  }

  for (const packageName of ["pg", "typescript"]) {
    const packageDirectory = path.join(nodeModules, packageName);
    const metadata = await lstat(packageDirectory).catch(() => null);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`The local ${packageName} install is missing or symlinked`);
    }
    const canonicalPackage = await realpath(packageDirectory);
    if (!isPathInside(canonicalPackage, nodeModules)) {
      throw new Error(`The local ${packageName} install escapes this checkout`);
    }
    const packageJsonPath = path.join(packageDirectory, "package.json");
    await assertRegularFile(packageJsonPath, `${packageName}/package.json`);
    const installedPackage = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const lockKey = `node_modules/${packageName}`;
    const expectedVersion = packageLock.packages?.[lockKey]?.version;
    const installedLockVersion = installedLock.packages?.[lockKey]?.version;
    if (
      typeof expectedVersion !== "string" ||
      installedPackage.version !== expectedVersion ||
      installedLockVersion !== expectedVersion
    ) {
      throw new Error(`The local ${packageName} install does not match package-lock.json`);
    }
  }
  return Object.freeze({ repositoryRoot: canonicalRoot, nodeModules });
}

export async function resolveSafeTempRoot(candidate = tmpdir()) {
  if (typeof candidate !== "string" || !candidate || !path.isAbsolute(candidate)) {
    throw new Error("The temporary root must be a non-empty absolute path");
  }
  const resolved = path.resolve(candidate);
  if (resolved === path.parse(resolved).root) {
    throw new Error("The filesystem root is not a safe temporary root");
  }
  const metadata = await lstat(resolved);
  if (metadata.isSymbolicLink()) {
    throw new Error("The temporary root must not be a symbolic link");
  }
  if (!metadata.isDirectory()) {
    throw new Error("The temporary root must be a directory");
  }
  const writableByOthers = (metadata.mode & 0o022) !== 0;
  const sticky = (metadata.mode & 0o1000) !== 0;
  if (writableByOthers && !sticky) {
    throw new Error("The temporary root has unsafe write permissions");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
  if (metadata.uid !== uid && metadata.uid !== 0) {
    throw new Error("The temporary root has an unexpected owner");
  }

  const canonical = await realpath(resolved);
  if (canonical === path.parse(canonical).root) {
    throw new Error("The canonical filesystem root is not a safe temporary root");
  }
  const canonicalMetadata = await lstat(canonical);
  if (canonicalMetadata.isSymbolicLink() || !canonicalMetadata.isDirectory()) {
    throw new Error("The canonical temporary root must be a real directory");
  }
  return canonical;
}

export async function assertSafeClusterRoot(clusterRoot, tempRoot) {
  const resolvedRoot = path.resolve(clusterRoot);
  const canonicalTempRoot = await realpath(path.resolve(tempRoot));
  const basename = path.basename(resolvedRoot);
  if (
    path.dirname(resolvedRoot) !== canonicalTempRoot ||
    !new RegExp(`^${CLUSTER_PREFIX}[A-Za-z0-9_-]+$`).test(basename)
  ) {
    throw new Error("Refusing unsafe disposable Postgres cluster path");
  }
  const metadata = await lstat(resolvedRoot);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("The disposable Postgres cluster root must be a real directory");
  }
  if (await realpath(resolvedRoot) !== resolvedRoot) {
    throw new Error("The disposable Postgres cluster root contains a symbolic-link path");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("The disposable Postgres cluster root must be private");
  }
  return resolvedRoot;
}

export function buildGateCommands({
  binaries,
  dataDirectory,
  passwordFile,
  port,
  databaseName,
  databaseUser,
}) {
  assertSafePort(port);
  assertSafeIdentifier(databaseName, "database name");
  assertSafeIdentifier(databaseUser, "database user");
  const serverArguments = [
    "-D", dataDirectory,
    "-F",
    "-h", LOOPBACK_HOST,
    "-p", String(port),
    "-c", "listen_addresses=127.0.0.1",
    "-c", "unix_socket_directories=",
    "-c", "fsync=off",
    "-c", "synchronous_commit=off",
    "-c", "full_page_writes=off",
  ];
  assertLoopbackServerArguments(serverArguments);
  return Object.freeze({
    initdb: command(binaries.initdb, [
      "--pgdata", dataDirectory,
      "--username", databaseUser,
      "--pwfile", passwordFile,
      "--auth-local", "reject",
      "--auth-host", "scram-sha-256",
      "--encoding", "UTF8",
      "--no-locale",
      "--no-sync",
    ]),
    createDatabase: Object.freeze({
      ...command(binaries.postgres, ["--single", "-D", dataDirectory, "postgres"]),
      input: `CREATE DATABASE "${databaseName}" ENCODING 'UTF8' TEMPLATE template0;\n`,
    }),
    server: command(binaries.postgres, serverArguments),
    stop: command(binaries.pgCtl, [
      "--pgdata", dataDirectory,
      "--wait",
      "--timeout", String(Math.ceil(POSTGRES_STOP_TIMEOUT_MS / 1_000)),
      "--mode", "immediate",
      "stop",
    ]),
    aggregates: Object.freeze(AGGREGATE_SCRIPT_NAMES.map((name) =>
      command(binaries.npm, ["run", name])
    )),
  });
}

export function assertLoopbackServerArguments(arguments_) {
  const hostIndex = arguments_.indexOf("-h");
  const portIndex = arguments_.indexOf("-p");
  if (hostIndex < 0 || arguments_[hostIndex + 1] !== LOOPBACK_HOST) {
    throw new Error("Disposable Postgres must bind only to 127.0.0.1");
  }
  if (portIndex < 0) throw new Error("Disposable Postgres requires an explicit port");
  assertSafePort(Number(arguments_[portIndex + 1]));
  const settings = arguments_
    .map((value, index) => arguments_[index - 1] === "-c" ? value : "")
    .filter(Boolean);
  if (!settings.includes("listen_addresses=127.0.0.1")) {
    throw new Error("Disposable Postgres listen_addresses must be loopback-only");
  }
  if (!settings.includes("unix_socket_directories=")) {
    throw new Error("Disposable Postgres Unix sockets must be disabled");
  }
}

export function assertSafeGeneratedConnectionString(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("Generated Postgres URL is invalid");
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== LOOPBACK_HOST ||
    !url.port ||
    !url.username ||
    !url.password ||
    !databaseName.startsWith(DATABASE_PREFIX) ||
    url.searchParams.size !== 1 ||
    url.searchParams.get("sslmode") !== "disable" ||
    url.hash
  ) {
    throw new Error("Generated Postgres URL must be authenticated and loopback-only");
  }
  assertSafePort(Number(url.port));
}

export function buildStrictChildEnvironment({
  executablePath,
  npmPath,
  postgresBinaryPaths,
  clusterRoot,
  connectionString,
  bootstrapUrl,
}) {
  assertSafeGeneratedConnectionString(connectionString);
  if (typeof bootstrapUrl !== "string" || !bootstrapUrl.startsWith("file:")) {
    throw new Error("The gate bootstrap must be a local file URL");
  }
  const executableDirectories = [
    path.dirname(executablePath),
    path.dirname(npmPath),
    ...postgresBinaryPaths.map((binaryPath) => path.dirname(binaryPath)),
    "/usr/bin",
    "/bin",
  ];
  return Object.freeze({
    PATH: [...new Set(executableDirectories)].join(path.delimiter),
    HOME: clusterRoot,
    TMPDIR: clusterRoot,
    LANG: "C",
    LC_ALL: "C",
    TZ: "America/Los_Angeles",
    NO_COLOR: "1",
    NODE_OPTIONS: `--import=${bootstrapUrl}`,
    npm_config_audit: "false",
    npm_config_cache: path.join(clusterRoot, "npm-cache"),
    npm_config_fund: "false",
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
    [TEST_DATABASE_ENV]: connectionString,
  });
}

export function buildLocalTypeScriptResolutionHookSource(root) {
  const canonicalRoot = path.resolve(root);
  return `
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = ${JSON.stringify(canonicalRoot)};
const nodeModulesRoot = path.join(repositoryRoot, "node_modules");

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".") ||
      !specifier.endsWith(".js") || !context.parentURL?.startsWith("file:")) {
      throw error;
    }
    const parentPath = fileURLToPath(context.parentURL);
    const candidateUrl = new URL(specifier.replace(/\\.js$/, ".ts"), context.parentURL);
    const candidatePath = fileURLToPath(candidateUrl);
    if (!isInside(parentPath, repositoryRoot) || isInside(parentPath, nodeModulesRoot) ||
      !isInside(candidatePath, repositoryRoot) || isInside(candidatePath, nodeModulesRoot) ||
      !existsSync(candidatePath)) {
      throw error;
    }
    return nextResolve(candidateUrl.href, context);
  }
}
`.trimStart();
}

export function buildProviderBlockingBootstrapSource({ port }) {
  assertSafePort(port);
  return `
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { register } from "node:module";

register(new URL("./typescript-resolution-hook.mjs", import.meta.url));
const allowedHost = ${JSON.stringify(LOOPBACK_HOST)};
const allowedPort = ${port};
const originalSocketConnect = net.Socket.prototype.connect;
const originalTlsConnect = tls.connect;

function blocked(kind, target) {
  throw new Error(kind + " is forbidden in the isolated Postgres gate: " + String(target));
}

function connectTarget(arguments_) {
  const first = arguments_[0];
  if (typeof first === "number") {
    return { port: first, host: String(arguments_[1] || "localhost").toLowerCase() };
  }
  if (typeof first === "string") return { path: first };
  if (first && typeof first === "object") {
    if (first.path) return { path: first.path };
    return {
      port: Number(first.port),
      host: String(first.host || first.hostname || "localhost").toLowerCase(),
    };
  }
  return {};
}

net.Socket.prototype.connect = function guardedConnect(...arguments_) {
  const target = connectTarget(arguments_);
  if (target.path || target.host !== allowedHost || !Number.isInteger(target.port) ||
    target.port < 1 || target.port > 65535) {
    blocked("External TCP access", target.path || target.host + ":" + target.port);
  }
  return originalSocketConnect.apply(this, arguments_);
};
tls.connect = (...arguments_) => blocked("TLS access", connectTarget(arguments_).host || "unknown");
for (const [module, protocol] of [[http, "HTTP"], [https, "HTTPS"]]) {
  module.request = (...arguments_) => blocked(protocol + " request", arguments_[0]);
  module.get = (...arguments_) => blocked(protocol + " GET", arguments_[0]);
}
globalThis.fetch = async (input) => blocked("fetch", input);
globalThis.WebSocket = class BlockedWebSocket {
  constructor(url) {
    blocked("WebSocket", url);
  }
};
globalThis.__SIDESTREAM_ISOLATED_POSTGRES_GATE__ = Object.freeze({
  host: allowedHost,
  port: allowedPort,
  providers: "blocked",
  originalTlsConnect: typeof originalTlsConnect,
});
`.trimStart();
}

export async function runCustomer360IsolatedPostgresGate({ signal } = {}) {
  validateGateInvocation({ argv: [] });
  const install = await assertRepositoryLockedInstall();
  const tempRoot = await resolveSafeTempRoot();
  const binaries = await resolveBinaries();
  const clusterRoot = await mkdtemp(path.join(tempRoot, CLUSTER_PREFIX));
  const dataDirectory = path.join(clusterRoot, "data");
  const logPath = path.join(clusterRoot, "postgres.log");
  const passwordFile = path.join(clusterRoot, "postgres-password");
  const databaseUser = "sidestream_gate";
  const databaseName = `${DATABASE_PREFIX}${randomBytes(8).toString("hex")}`;
  const password = randomBytes(32).toString("base64url");
  let serverProcess;
  let stopCommand;
  let toolEnvironment;

  try {
    await assertSafeClusterRoot(clusterRoot, tempRoot);
    const port = await reserveLoopbackPort();
    const commands = buildGateCommands({
      binaries,
      dataDirectory,
      passwordFile,
      port,
      databaseName,
      databaseUser,
    });
    stopCommand = commands.stop;
    toolEnvironment = buildToolEnvironment(binaries, clusterRoot);
    const passwordHandle = await open(passwordFile, "wx", 0o600);
    try {
      await passwordHandle.writeFile(`${password}\n`, "utf8");
    } finally {
      await passwordHandle.close();
    }
    await runCommand(commands.initdb, {
      environment: toolEnvironment,
      signal,
      label: "initdb",
    });
    await rm(passwordFile, { force: true });
    await runCommand(commands.createDatabase, {
      environment: toolEnvironment,
      input: commands.createDatabase.input,
      signal,
      label: "temporary database creation",
    });

    const logHandle = await open(logPath, "wx", 0o600);
    try {
      serverProcess = spawn(commands.server.executable, commands.server.arguments, {
        cwd: install.repositoryRoot,
        env: toolEnvironment,
        stdio: ["ignore", logHandle.fd, logHandle.fd],
      });
      await waitForLoopbackServer({
        child: serverProcess,
        port,
        signal,
        timeoutMs: POSTGRES_START_TIMEOUT_MS,
      });
    } finally {
      await logHandle.close();
    }

    const connectionString = new URL("postgresql://127.0.0.1");
    connectionString.username = databaseUser;
    connectionString.password = password;
    connectionString.port = String(port);
    connectionString.pathname = `/${databaseName}`;
    connectionString.searchParams.set("sslmode", "disable");
    const bootstrapUrl = await writeGateBootstrap({
      clusterRoot,
      repositoryRoot: install.repositoryRoot,
      port,
    });
    const aggregateEnvironment = buildStrictChildEnvironment({
      executablePath: process.execPath,
      npmPath: binaries.npm,
      postgresBinaryPaths: [binaries.initdb, binaries.postgres, binaries.pgCtl],
      clusterRoot,
      connectionString: connectionString.toString(),
      bootstrapUrl,
    });

    const failures = [];
    for (let index = 0; index < commands.aggregates.length; index += 1) {
      const scriptName = AGGREGATE_SCRIPT_NAMES[index];
      console.log(`Running ${scriptName} against disposable loopback Postgres`);
      try {
        await runCommand(commands.aggregates[index], {
          environment: aggregateEnvironment,
          inheritStdio: true,
          terminateProcessGroup: true,
          signal,
          label: scriptName,
          cwd: install.repositoryRoot,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        failures.push(scriptName);
        console.error(`${scriptName} failed; continuing the remaining isolated aggregates`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Isolated Postgres aggregate failures: ${failures.join(", ")}`);
    }
    console.log("All isolated Postgres aggregates passed");
  } finally {
    if (stopCommand && toolEnvironment) {
      await stopServer({
        serverProcess,
        stopCommand,
        environment: toolEnvironment,
      });
    }
    await removeClusterRoot(clusterRoot, tempRoot);
  }
}

async function writeGateBootstrap({ clusterRoot, repositoryRoot: root, port }) {
  const hookPath = path.join(clusterRoot, "typescript-resolution-hook.mjs");
  const bootstrapPath = path.join(clusterRoot, "gate-bootstrap.mjs");
  await writeFile(hookPath, buildLocalTypeScriptResolutionHookSource(root), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(bootstrapPath, buildProviderBlockingBootstrapSource({ port }), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return pathToFileURL(bootstrapPath).href;
}

async function resolveBinaries() {
  const [initdb, postgres, pgCtl, npm] = await Promise.all([
    findExecutable("initdb"),
    findExecutable("postgres"),
    findExecutable("pg_ctl"),
    findExecutable("npm"),
  ]);
  return Object.freeze({ initdb, postgres, pgCtl, npm });
}

async function findExecutable(name) {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through PATH without invoking a shell.
    }
  }
  throw new Error(`${name} is required for the isolated Postgres gate`);
}

function buildToolEnvironment(binaries, clusterRoot) {
  return {
    PATH: [...new Set([
      path.dirname(process.execPath),
      path.dirname(binaries.initdb),
      path.dirname(binaries.postgres),
      path.dirname(binaries.pgCtl),
      "/usr/bin",
      "/bin",
    ])].join(path.delimiter),
    HOME: clusterRoot,
    TMPDIR: clusterRoot,
    LANG: "C",
    LC_ALL: "C",
  };
}

async function runCommand(command_, {
  environment,
  inheritStdio = false,
  input,
  terminateProcessGroup = false,
  signal,
  label,
  cwd = repositoryRoot,
}) {
  throwIfAborted(signal);
  const child = spawn(command_.executable, command_.arguments, {
    cwd,
    detached: terminateProcessGroup && process.platform !== "win32",
    env: environment,
    stdio: [
      input === undefined ? (inheritStdio ? "inherit" : "ignore") : "pipe",
      inheritStdio ? "inherit" : "ignore",
      inheritStdio ? "inherit" : "ignore",
    ],
  });
  if (input !== undefined) child.stdin.end(input);

  const abort = () => {
    if (terminateProcessGroup && process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // The child process group may already have exited.
      }
    } else {
      child.kill("SIGTERM");
    }
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const result = await waitForChild(child);
    if (signal?.aborted) throw signal.reason;
    if (result.signal) throw new Error(`${label} was terminated by ${result.signal}`);
    if (result.code !== 0) throw new Error(`${label} failed with exit code ${result.code ?? 1}`);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

async function waitForLoopbackServer({ child, port, signal, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Disposable Postgres exited before accepting loopback connections");
    }
    if (await canConnectToLoopback(port)) return;
    await delay(100, undefined, { signal });
  }
  throw new Error("Timed out waiting for disposable Postgres on loopback");
}

function canConnectToLoopback(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: LOOPBACK_HOST, port });
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => {
    if (error) reject(error);
    else resolve();
  }));
  assertSafePort(port);
  return port;
}

async function stopServer({ serverProcess, stopCommand, environment }) {
  if (!serverProcess || serverProcess.exitCode !== null || serverProcess.signalCode !== null) return;
  try {
    await runCommand(stopCommand, {
      environment,
      label: "pg_ctl stop",
    });
  } catch {
    serverProcess.kill("SIGTERM");
  }
  const exited = await Promise.race([
    waitForChild(serverProcess).then(() => true),
    delay(POSTGRES_STOP_TIMEOUT_MS).then(() => false),
  ]);
  if (!exited) {
    serverProcess.kill("SIGKILL");
    await waitForChild(serverProcess);
  }
}

async function removeClusterRoot(clusterRoot, tempRoot) {
  await assertSafeClusterRoot(clusterRoot, tempRoot);
  await rm(clusterRoot, { recursive: true, force: true });
}

function waitForChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function assertRegularFile(filename, label) {
  const metadata = await lstat(filename).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlinked file`);
  }
}

function isPathInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function command(executable, arguments_) {
  return Object.freeze({
    executable,
    arguments: Object.freeze([...arguments_]),
  });
}

function assertSafePort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("Disposable Postgres port must be an unprivileged TCP port");
  }
}

function assertSafeIdentifier(value, label) {
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(value)) {
    throw new Error(`Unsafe temporary Postgres ${label}`);
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason;
}

function installSignalHandlers() {
  const controller = new AbortController();
  let receivedSignal = "";
  const handlers = new Map();
  for (const signalName of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (receivedSignal) return;
      receivedSignal = signalName;
      controller.abort(new Error(`Isolated Postgres gate interrupted by ${signalName}`));
    };
    handlers.set(signalName, handler);
    process.on(signalName, handler);
  }
  return {
    signal: controller.signal,
    receivedSignal: () => receivedSignal,
    dispose() {
      for (const [signalName, handler] of handlers) process.off(signalName, handler);
    },
  };
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryUrl) {
  const signals = installSignalHandlers();
  try {
    validateGateInvocation({ argv: process.argv.slice(2) });
    await runCustomer360IsolatedPostgresGate({ signal: signals.signal });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Isolated Postgres gate failed");
    const receivedSignal = signals.receivedSignal();
    process.exitCode = receivedSignal === "SIGINT" ? 130
      : receivedSignal === "SIGTERM" ? 143
        : 1;
  } finally {
    signals.dispose();
  }
}

import assert from "node:assert/strict";
import {
  existsSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyCatalog,
  parsePulledEnvironment,
  rejectInheritedPostgresSelectors,
  resolveVercelProject,
  runOperator,
  selectProductionConnection,
} from "../scripts/apply-production-device-schema.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationRelativePath =
  "db/migrations/20260714190000_add_single_active_account_devices.sql";
const projectLink = {
  projectId: "prj_x9sRcnoAAfF6VPxseJYLBgxhhPyh",
  orgId: "team_ZcKImJwvlcCrE15nTEOWT2NC",
  projectName: "sidestream",
};
const linkedNeonStore = {
  id: "store_y3hmEgLPHG5Fgb7D",
  name: "neon-purple-island",
  type: "integration",
  status: "available",
  externalResourceId: "dark-butterfly-59697025",
  product: { slug: "neon" },
  projectsMetadata: [{
    projectId: projectLink.projectId,
    name: projectLink.projectName,
    environments: ["production", "preview"],
  }],
};
const unpooledUrl =
  "postgresql://sidestream_owner:very-secret@ep-steady-field.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
const pooledUrl =
  "postgresql://sidestream_owner:very-secret@ep-steady-field-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

const absentCatalog = {
  accountsExists: true,
  tablesPresent: [],
  failedChecks: ["devices_columns", "transfers_columns"],
};
const presentCatalog = {
  accountsExists: true,
  tablesPresent: [
    "sidestream_account_devices",
    "sidestream_device_transfers",
  ],
  failedChecks: [],
};

async function createFixtureRepository() {
  const root = await mkdtemp(path.join(tmpdir(), "sidestream-device-operator-test-"));
  await mkdir(path.join(root, ".vercel"), { recursive: true });
  await mkdir(path.join(root, path.dirname(migrationRelativePath)), {
    recursive: true,
  });
  await writeFile(
    path.join(root, ".vercel", "project.json"),
    `${JSON.stringify(projectLink)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(root, migrationRelativePath),
    await readFile(path.join(repoRoot, migrationRelativePath)),
    { mode: 0o600 },
  );
  return root;
}

function serializeEnvironment({
  devicePolicyMode = "observe",
  includePooled = true,
  selectedUrl = unpooledUrl,
} = {}) {
  return [
    '# Created by Vercel CLI',
    `STORAGE_POSTGRES_URL_NON_POOLING="${selectedUrl}"`,
    includePooled ? `SIDESTREAM_POSTGRES_URL="${pooledUrl}"` : "",
    `SIDESTREAM_DEVICE_POLICY_MODE="${devicePolicyMode}"`,
    'UNRELATED_SECRET="must-not-be-parsed"',
    "",
  ].join("\n");
}

function createSynchronousChildStub({
  catalogs = [presentCatalog],
  environmentContents = serializeEnvironment(),
  linkedConnectionUrl = unpooledUrl,
  linkedStores = [linkedNeonStore],
} = {}) {
  const calls = [];
  let catalogIndex = 0;
  let pulledEnvironmentPath;
  return {
    calls,
    get pulledEnvironmentPath() {
      return pulledEnvironmentPath;
    },
    spawnSyncImpl(command, args, options) {
      calls.push({
        command,
        args: [...args],
        options: {
          ...options,
          env: options.env ? { ...options.env } : undefined,
        },
      });
      if (args[0] === "env" && args[1] === "pull") {
        pulledEnvironmentPath = args[2];
        writeFileSync(pulledEnvironmentPath, environmentContents, { mode: 0o644 });
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "api" && args[1] === "/v1/storage/stores") {
        return {
          status: 0,
          stdout: JSON.stringify({ stores: linkedStores }),
          stderr: "",
        };
      }
      if (args.includes("neonctl@2.35.2") && args.includes("connection-string")) {
        return { status: 0, stdout: `${linkedConnectionUrl}\n`, stderr: "" };
      }
      if (args.includes("--file=-")) {
        const catalog = catalogs[Math.min(catalogIndex, catalogs.length - 1)];
        catalogIndex += 1;
        return {
          status: 0,
          stdout: `${JSON.stringify(catalog)}\n`,
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  };
}

function runWithFixture(root, stub, args, output = []) {
  return runOperator(args, {
    environment: {
      HOME: "/tmp/operator-home",
      PATH: process.env.PATH,
      TOP_SECRET: "ambient-secret-must-not-reach-psql",
    },
    psqlPath: process.execPath,
    repoRoot: root,
    spawnSyncImpl: stub.spawnSyncImpl,
    stdout: { write: (value) => output.push(value) },
    temporaryRoot: root,
    vercelPath: process.execPath,
    npxPath: process.execPath,
  });
}

test("pulled env parsing reads only allowlisted literal values", () => {
  const parsed = parsePulledEnvironment([
    'UNRELATED="$(touch /tmp/should-never-run)"',
    `STORAGE_POSTGRES_URL_NON_POOLING="${unpooledUrl}"`,
    'SIDESTREAM_DEVICE_POLICY_MODE="observe"',
    'ANOTHER_SECRET="ignored"',
  ].join("\n"));

  assert.deepEqual(parsed, {
    STORAGE_POSTGRES_URL_NON_POOLING: unpooledUrl,
    SIDESTREAM_DEVICE_POLICY_MODE: "observe",
  });
  assert.throws(
    () => parsePulledEnvironment("SIDESTREAM_DEVICE_POLICY_MODE=off\nSIDESTREAM_DEVICE_POLICY_MODE=enforce\n"),
    /duplicate pulled SIDESTREAM_DEVICE_POLICY_MODE/u,
  );
});

test("connection selection prefers unpooled Neon and rejects unsafe targets", () => {
  const selected = selectProductionConnection({
    STORAGE_POSTGRES_URL_NON_POOLING: unpooledUrl,
    SIDESTREAM_POSTGRES_URL: pooledUrl,
  });
  assert.equal(selected.selector, "STORAGE_POSTGRES_URL_NON_POOLING");
  assert.equal(selected.hostname, "ep-steady-field.us-east-2.aws.neon.tech");

  assert.throws(
    () => selectProductionConnection({
      STORAGE_POSTGRES_URL_NON_POOLING:
        "https://owner:secret@ep-steady-field.us-east-2.aws.neon.tech/neondb",
    }),
    /not a Postgres URL/u,
  );
  assert.throws(
    () => selectProductionConnection({
      STORAGE_POSTGRES_URL_NON_POOLING:
        "postgresql://owner:secret@database.example.com/neondb",
    }),
    /does not target Neon/u,
  );
  assert.throws(
    () => selectProductionConnection({
      STORAGE_POSTGRES_URL_NON_POOLING:
        "postgresql://sidestream_test_owner:secret@ep-steady-field.us-east-2.aws.neon.tech/neondb",
    }),
    /non-Production database/u,
  );
});

test("ambient Postgres selectors are rejected before any provider command", () => {
  assert.throws(
    () => rejectInheritedPostgresSelectors({
      PATH: process.env.PATH,
      SIDESTREAM_POSTGRES_URL: pooledUrl,
    }),
    /inherited Postgres selectors are forbidden/u,
  );
  assert.doesNotThrow(() => rejectInheritedPostgresSelectors({
    PATH: process.env.PATH,
    TOP_SECRET: "not-a-selector",
  }));
});

test("worktrees resolve the pinned project from the existing common Git root link", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "sidestream-vercel-link-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const commonRoot = path.join(root, "common");
  const worktreeRoot = path.join(root, "worker");
  const worktreeGitDir = path.join(commonRoot, ".git", "worktrees", "worker");
  await mkdir(path.join(commonRoot, ".vercel"), { recursive: true });
  await mkdir(worktreeGitDir, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(
    path.join(commonRoot, ".vercel", "project.json"),
    JSON.stringify(projectLink),
    { mode: 0o600 },
  );
  await writeFile(path.join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir}\n`);
  await writeFile(path.join(worktreeGitDir, "commondir"), "../..\n");

  const resolved = resolveVercelProject(worktreeRoot);
  assert.equal(resolved.root, await realpath(commonRoot));
  assert.deepEqual(resolved.link, projectLink);
});

test("catalog classification rejects missing parent, partial tables, and conflicts", () => {
  assert.equal(classifyCatalog(absentCatalog), "absent");
  assert.equal(classifyCatalog(presentCatalog), "present");
  assert.throws(
    () => classifyCatalog({ ...absentCatalog, accountsExists: false }),
    /sidestream_accounts is missing/u,
  );
  assert.throws(
    () => classifyCatalog({
      ...presentCatalog,
      tablesPresent: ["sidestream_account_devices"],
    }),
    /partially present/u,
  );
  assert.throws(
    () => classifyCatalog({ ...presentCatalog, failedChecks: ["devices_rls"] }),
    /conflict.*devices_rls/u,
  );
});

test("verify is read-only, secret-free, scrubbed, and removes the mode-0600 env file", async (context) => {
  const root = await createFixtureRepository();
  context.after(() => rm(root, { recursive: true, force: true }));
  const stub = createSynchronousChildStub();
  const output = [];

  const result = runWithFixture(root, stub, ["--verify"], output);
  assert.equal(result.before, "present");
  assert.match(output.join(""), /^PASS mode=verify .* schema=present\n$/u);
  assert.doesNotMatch(output.join(""), /very-secret|sidestream_owner/u);
  assert.equal(existsSync(stub.pulledEnvironmentPath), false);
  assert.equal(existsSync(path.dirname(stub.pulledEnvironmentPath)), false);

  const vercelCall = stub.calls[0];
  assert.deepEqual(vercelCall.args.slice(0, 3), [
    "env",
    "pull",
    stub.pulledEnvironmentPath,
  ]);
  assert.ok(vercelCall.args.includes("--environment=production"));
  assert.equal(vercelCall.options.env.TOP_SECRET, undefined);
  assert.equal(vercelCall.options.env.SIDESTREAM_POSTGRES_URL, undefined);

  const catalogCall = stub.calls[1];
  assert.ok(catalogCall.args.includes("--single-transaction"));
  assert.ok(catalogCall.args.includes("--set=ON_ERROR_STOP=1"));
  assert.ok(catalogCall.args.includes("--file=-"));
  assert.match(catalogCall.options.input, /SET TRANSACTION READ ONLY/u);
  assert.match(catalogCall.options.input, /pg_catalog\.gen_random_uuid\(\)/u);
  assert.match(catalogCall.options.input, /sidestream_account_devices_one_active_production/u);
  assert.match(catalogCall.options.input, /sidestream_device_transfers_limit_window_idx/u);
  assert.doesNotMatch(catalogCall.options.input, /FROM public\.sidestream_accounts/u);
  assert.equal(catalogCall.options.env.PGSSLMODE, "verify-full");
  assert.equal(catalogCall.options.env.PGSSLROOTCERT, "system");
  assert.equal(catalogCall.options.env.PGPASSWORD, "very-secret");
  assert.equal(catalogCall.options.env.TOP_SECRET, undefined);
  assert.equal(catalogCall.options.env.HOME, undefined);
  assert.doesNotMatch(
    `${catalogCall.command} ${catalogCall.args.join(" ")}`,
    /very-secret|sidestream_owner/u,
  );
});

test("empty sensitive selectors use only the pinned linked Neon resource", async (context) => {
  const root = await createFixtureRepository();
  context.after(() => rm(root, { recursive: true, force: true }));
  const stub = createSynchronousChildStub({
    environmentContents: 'SIDESTREAM_DEVICE_POLICY_MODE="observe"\n',
  });
  const output = [];

  const result = runWithFixture(root, stub, ["--verify"], output);
  assert.equal(result.before, "present");
  assert.match(output.join(""), /source=linked-neon-resource/u);
  assert.doesNotMatch(output.join(""), /very-secret|sidestream_owner/u);
  assert.equal(existsSync(path.dirname(stub.pulledEnvironmentPath)), false);

  const inventoryCall = stub.calls[1];
  assert.deepEqual(inventoryCall.args.slice(0, 2), [
    "api",
    "/v1/storage/stores",
  ]);
  assert.equal(inventoryCall.options.env.TOP_SECRET, undefined);

  const neonCall = stub.calls[2];
  assert.ok(neonCall.args.includes("--offline"));
  assert.ok(neonCall.args.includes("neonctl@2.35.2"));
  assert.ok(neonCall.args.includes("--project-id=dark-butterfly-59697025"));
  assert.ok(neonCall.args.includes("--pooled=false"));
  assert.equal(neonCall.options.env.NPM_CONFIG_OFFLINE, "true");
  assert.equal(neonCall.options.env.TOP_SECRET, undefined);
  assert.doesNotMatch(
    `${neonCall.command} ${neonCall.args.join(" ")}`,
    /very-secret|sidestream_owner/u,
  );

  const catalogCall = stub.calls[3];
  assert.match(catalogCall.options.input, /SET TRANSACTION READ ONLY/u);
  assert.equal(catalogCall.options.env.PGPASSWORD, "very-secret");
});

test("linked Neon fallback rejects a mismatched Vercel resource before lookup or psql", async (context) => {
  const root = await createFixtureRepository();
  context.after(() => rm(root, { recursive: true, force: true }));
  const stub = createSynchronousChildStub({
    environmentContents: "",
    linkedStores: [{
      ...linkedNeonStore,
      externalResourceId: "ancient-breeze-53489732",
    }],
  });

  assert.throws(
    () => runWithFixture(root, stub, ["--verify"]),
    /pinned Production Neon resource binding is unavailable/u,
  );
  assert.equal(stub.calls.length, 2);
  assert.equal(existsSync(path.dirname(stub.pulledEnvironmentPath)), false);
});

test("apply requires the exact confirmation before pulling provider state", async (context) => {
  const root = await createFixtureRepository();
  context.after(() => rm(root, { recursive: true, force: true }));
  const stub = createSynchronousChildStub();
  assert.throws(
    () => runWithFixture(root, stub, ["--apply"]),
    /requires the literal --confirm-production-device-schema/u,
  );
  assert.equal(stub.calls.length, 0);
});

test("apply executes the pinned migration once between absent and exact-present checks", async (context) => {
  const root = await createFixtureRepository();
  context.after(() => rm(root, { recursive: true, force: true }));
  const stub = createSynchronousChildStub({
    catalogs: [absentCatalog, presentCatalog],
  });
  const output = [];

  const result = runWithFixture(
    root,
    stub,
    ["--apply", "--confirm-production-device-schema"],
    output,
  );
  assert.equal(result.migration, "applied");
  assert.match(output.join(""), /before=absent migration=applied after=present/u);

  const psqlCalls = stub.calls.slice(1);
  assert.equal(psqlCalls.length, 3);
  const migrationCalls = psqlCalls.filter((call) =>
    call.args.some((arg) => arg.endsWith(migrationRelativePath)),
  );
  assert.equal(migrationCalls.length, 1);
  const migrationCall = migrationCalls[0];
  assert.ok(migrationCall.args.includes("--single-transaction"));
  assert.ok(migrationCall.args.includes("--set=ON_ERROR_STOP=1"));
  assert.equal(migrationCall.options.env.PGSSLMODE, "verify-full");
  assert.equal(migrationCall.options.env.PGSSLROOTCERT, "system");
  assert.doesNotMatch(
    `${migrationCall.command} ${migrationCall.args.join(" ")} ${output.join("")}`,
    /very-secret|sidestream_owner/u,
  );
});

test("enforce mode and partial schema abort before the migration and clean temp data", async (context) => {
  const root = await createFixtureRepository();
  context.after(() => rm(root, { recursive: true, force: true }));
  const enforceStub = createSynchronousChildStub({
    environmentContents: serializeEnvironment({ devicePolicyMode: "enforce" }),
  });
  assert.throws(
    () => runWithFixture(
      root,
      enforceStub,
      ["--apply", "--confirm-production-device-schema"],
    ),
    /DEVICE_POLICY_MODE=enforce/u,
  );
  assert.equal(enforceStub.calls.length, 1);
  assert.equal(existsSync(path.dirname(enforceStub.pulledEnvironmentPath)), false);

  const partialStub = createSynchronousChildStub({
    catalogs: [{
      ...presentCatalog,
      tablesPresent: ["sidestream_account_devices"],
    }],
  });
  assert.throws(
    () => runWithFixture(
      root,
      partialStub,
      ["--apply", "--confirm-production-device-schema"],
    ),
    /partially present/u,
  );
  assert.equal(partialStub.calls.length, 2);
});

test("verify fails when both target tables are absent and never mutates", async (context) => {
  const root = await createFixtureRepository();
  context.after(() => rm(root, { recursive: true, force: true }));
  const stub = createSynchronousChildStub({ catalogs: [absentCatalog] });
  assert.throws(
    () => runWithFixture(root, stub, ["--verify"]),
    /Production device schema is absent/u,
  );
  assert.equal(stub.calls.length, 2);
  assert.equal(
    stub.calls.some((call) => call.args.some((arg) => arg.endsWith(migrationRelativePath))),
    false,
  );
});

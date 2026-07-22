import assert from "node:assert/strict";
import {
  existsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CATALOG_SQL,
  classifyCatalog,
  runOperator,
} from "../scripts/apply-production-checkout-schema.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationRelativePath =
  "db/migrations/20260713203000_add_checkout_intents.sql";
const confirmation = "--confirm-production-checkout-intents-schema";
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
const pulledUnpooledUrl =
  "postgresql://sidestream_owner:pulled-secret@ep-steady-field.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
const pulledPooledUrl =
  "postgresql://sidestream_owner:pulled-secret@ep-steady-field-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
const linkedUnpooledUrl =
  "postgresql://sidestream_owner:linked-secret@ep-steady-field.us-east-2.aws.neon.tech/neondb?sslmode=verify-full&channel_binding=require";

const absentCatalog = {
  accountsExists: true,
  activationSessionsExists: true,
  tablePresent: false,
  failedChecks: ["checkout_columns", "checkout_constraints"],
};
const presentCatalog = {
  accountsExists: true,
  activationSessionsExists: true,
  tablePresent: true,
  failedChecks: [],
};

async function createFixtureRepository() {
  const root = await mkdtemp(path.join(tmpdir(), "sidestream-checkout-operator-test-"));
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

function serializeEnvironment({ selectedUrl = pulledUnpooledUrl } = {}) {
  return [
    "# Created by Vercel CLI",
    `STORAGE_POSTGRES_URL_NON_POOLING="${selectedUrl}"`,
    `SIDESTREAM_POSTGRES_URL="${pulledPooledUrl}"`,
    'UNRELATED_SECRET="must-not-be-parsed"',
    "",
  ].join("\n");
}

function createSynchronousChildStub({
  catalogs = [presentCatalog],
  environmentContents = serializeEnvironment(),
  linkedConnectionUrl = linkedUnpooledUrl,
  linkedStores = [linkedNeonStore],
} = {}) {
  const calls = [];
  let catalogIndex = 0;
  let pulledEnvironmentMode;
  let pulledEnvironmentPath;
  return {
    calls,
    get pulledEnvironmentMode() {
      return pulledEnvironmentMode;
    },
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
        writeFileSync(pulledEnvironmentPath, environmentContents);
        pulledEnvironmentMode = statSync(pulledEnvironmentPath).mode & 0o777;
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

function runWithFixture(root, stub, args, output = [], environment = {}) {
  return runOperator(args, {
    environment: {
      HOME: "/tmp/operator-home",
      PATH: process.env.PATH,
      TOP_SECRET: "ambient-secret-must-not-reach-children",
      ...environment,
    },
    npxPath: process.execPath,
    psqlPath: process.execPath,
    repoRoot: root,
    spawnSyncImpl: stub.spawnSyncImpl,
    stdout: { write: (value) => output.push(value) },
    temporaryRoot: root,
    vercelPath: process.execPath,
  });
}

test("catalog verification is exact, read-only, and reads no customer rows", () => {
  assert.match(CATALOG_SQL, /SET TRANSACTION READ ONLY/u);
  assert.match(CATALOG_SQL, /sidestream_accounts/u);
  assert.match(CATALOG_SQL, /sidestream_activation_sessions/u);
  assert.match(CATALOG_SQL, /sidestream_checkout_intents_stripe_session_fields_together/u);
  assert.match(CATALOG_SQL, /sidestream_checkout_intents_browser_token_unique/u);
  assert.match(CATALOG_SQL, /checkout_direct_role_revocations/u);
  assert.match(CATALOG_SQL, /aclexplode/u);
  assert.match(CATALOG_SQL, /pg_policy/u);
  assert.doesNotMatch(CATALOG_SQL, /FROM\s+public\.sidestream_/iu);
});

test("catalog requires exact migration indexes while allowing the later maintenance index", async () => {
  const maintenanceMigration = await readFile(
    path.join(
      repoRoot,
      "db/migrations/20260713206000_add_maintenance_indexes.sql",
    ),
    "utf8",
  );
  assert.match(
    maintenanceMigration,
    /create index if not exists sidestream_checkout_intents_retention_idx\s+on public\.sidestream_checkout_intents \(expires_at, id\);/u,
  );

  const indexCheck = CATALOG_SQL.match(
    /SELECT 'checkout_indexes'[\s\S]*?UNION ALL/u,
  )?.[0];
  assert.ok(indexCheck);
  assert.match(indexCheck, /index_class\.relname/u);
  assert.match(indexCheck, /ix\.indisunique/u);
  assert.match(indexCheck, /ix\.indisprimary/u);
  assert.match(indexCheck, /pg_get_indexdef/u);
  assert.match(indexCheck, /ix\.indoption/u);
  assert.match(indexCheck, /pg_get_expr\(ix\.indpred/u);
  assert.match(indexCheck, /\) @> \$json\$\[/u);
  assert.doesNotMatch(indexCheck, /\) = \$json\$\[/u);
  assert.doesNotMatch(indexCheck, /sidestream_checkout_intents_retention_idx/u);
});

test("catalog classification requires both parents and rejects a conflicting shape", () => {
  assert.equal(classifyCatalog(absentCatalog), "absent");
  assert.equal(classifyCatalog(presentCatalog), "present");
  assert.throws(
    () => classifyCatalog({ ...absentCatalog, accountsExists: false }),
    /sidestream_accounts is missing/u,
  );
  assert.throws(
    () => classifyCatalog({ ...absentCatalog, activationSessionsExists: false }),
    /sidestream_activation_sessions is missing/u,
  );
  assert.throws(
    () => classifyCatalog({
      ...presentCatalog,
      failedChecks: ["checkout_constraints"],
    }),
    /conflicts.*checkout_constraints/u,
  );
});

test("verify pins provider targets, scrubs secrets, and removes the mode-0600 env file", async (context) => {
  const root = await createFixtureRepository();
  context.after(() => rm(root, { recursive: true, force: true }));
  const stub = createSynchronousChildStub();
  const output = [];

  const result = runWithFixture(root, stub, ["--verify"], output);
  assert.equal(result.before, "present");
  assert.match(
    output.join(""),
    /^PASS mode=verify project=sidestream .* resource=neon-purple-island .* schema=present\n$/u,
  );
  assert.doesNotMatch(
    output.join(""),
    /pulled-secret|linked-secret|sidestream_owner/u,
  );
  assert.equal(stub.pulledEnvironmentMode, 0o600);
  assert.equal(existsSync(stub.pulledEnvironmentPath), false);
  assert.equal(existsSync(path.dirname(stub.pulledEnvironmentPath)), false);

  const pullCall = stub.calls[0];
  assert.deepEqual(pullCall.args.slice(0, 3), [
    "env",
    "pull",
    stub.pulledEnvironmentPath,
  ]);
  assert.ok(pullCall.args.includes("--environment=production"));
  assert.equal(pullCall.options.env.TOP_SECRET, undefined);

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
  assert.ok(neonCall.args.includes("--ssl=verify-full"));
  assert.equal(neonCall.options.env.TOP_SECRET, undefined);

  const catalogCall = stub.calls[3];
  assert.ok(catalogCall.args.includes("--single-transaction"));
  assert.ok(catalogCall.args.includes("--set=ON_ERROR_STOP=1"));
  assert.ok(catalogCall.args.includes("--file=-"));
  assert.equal(catalogCall.options.input, CATALOG_SQL);
  assert.equal(catalogCall.options.env.PGAPPNAME, "sidestream-production-checkout-schema");
  assert.equal(catalogCall.options.env.PGSSLMODE, "verify-full");
  assert.equal(catalogCall.options.env.PGSSLROOTCERT, "system");
  assert.equal(catalogCall.options.env.PGCHANNELBINDING, "require");
  assert.equal(catalogCall.options.env.PGPASSWORD, "linked-secret");
  assert.equal(catalogCall.options.env.TOP_SECRET, undefined);
  assert.equal(catalogCall.options.env.HOME, undefined);

  for (const call of stub.calls) {
    assert.doesNotMatch(
      `${call.command} ${call.args.join(" ")}`,
      /pulled-secret|linked-secret|sidestream_owner/u,
    );
  }
});

test("apply requires its unique literal confirmation before provider access", async (context) => {
  const root = await createFixtureRepository();
  context.after(() => rm(root, { recursive: true, force: true }));
  const stub = createSynchronousChildStub();
  assert.throws(
    () => runWithFixture(root, stub, ["--apply"]),
    /requires the literal --confirm-production-checkout-intents-schema/u,
  );
  assert.throws(
    () => runWithFixture(
      root,
      stub,
      ["--apply", "--confirm-production-device-schema"],
    ),
    /unknown argument: --confirm-production-device-schema/u,
  );
  assert.equal(stub.calls.length, 0);
});

test("apply executes only the pinned migration between absent and exact-present checks", async (context) => {
  const root = await createFixtureRepository();
  context.after(() => rm(root, { recursive: true, force: true }));
  const stub = createSynchronousChildStub({
    catalogs: [absentCatalog, presentCatalog],
  });
  const output = [];

  const result = runWithFixture(
    root,
    stub,
    ["--apply", confirmation],
    output,
  );
  assert.equal(result.migration, "applied");
  assert.match(output.join(""), /before=absent migration=applied after=present/u);

  const psqlCalls = stub.calls.slice(3);
  assert.equal(psqlCalls.length, 3);
  const migrationCalls = psqlCalls.filter((call) =>
    call.args.some((arg) => arg.startsWith("--file=") && arg !== "--file=-"),
  );
  assert.equal(migrationCalls.length, 1);
  const migrationCall = migrationCalls[0];
  assert.deepEqual(
    migrationCall.args.filter((arg) => arg.startsWith("--file=")),
    [`--file=${path.join(root, migrationRelativePath)}`],
  );
  assert.ok(migrationCall.args.includes("--single-transaction"));
  assert.ok(migrationCall.args.includes("--set=ON_ERROR_STOP=1"));
  assert.equal(migrationCall.options.env.PGSSLMODE, "verify-full");
  assert.equal(migrationCall.options.env.PGSSLROOTCERT, "system");
  assert.doesNotMatch(
    `${migrationCall.command} ${migrationCall.args.join(" ")} ${output.join("")}`,
    /pulled-secret|linked-secret|sidestream_owner/u,
  );
});

test("verify never mutates an absent schema", async (context) => {
  const root = await createFixtureRepository();
  context.after(() => rm(root, { recursive: true, force: true }));
  const stub = createSynchronousChildStub({ catalogs: [absentCatalog] });
  assert.throws(
    () => runWithFixture(root, stub, ["--verify"]),
    /Production Checkout-intent schema is absent/u,
  );
  assert.equal(
    stub.calls.some((call) =>
      call.args.some((arg) => arg.endsWith(migrationRelativePath)),
    ),
    false,
  );
});

test("non-Production, inherited, mismatched, and tampered targets fail closed", async (context) => {
  const root = await createFixtureRepository();
  context.after(() => rm(root, { recursive: true, force: true }));

  const inheritedStub = createSynchronousChildStub();
  assert.throws(
    () => runWithFixture(
      root,
      inheritedStub,
      ["--verify"],
      [],
      { SIDESTREAM_POSTGRES_URL: pulledPooledUrl },
    ),
    /inherited Postgres selectors are forbidden/u,
  );
  assert.equal(inheritedStub.calls.length, 0);

  const testStub = createSynchronousChildStub({
    environmentContents: serializeEnvironment({
      selectedUrl:
        "postgresql://sidestream_test_owner:secret@ep-steady-field.us-east-2.aws.neon.tech/neondb",
    }),
  });
  assert.throws(
    () => runWithFixture(root, testStub, ["--verify"]),
    /non-Production database/u,
  );
  assert.equal(testStub.calls.length, 1);

  const mismatchStub = createSynchronousChildStub({
    linkedConnectionUrl:
      "postgresql://sidestream_owner:secret@ep-other-field.us-east-2.aws.neon.tech/neondb?sslmode=verify-full",
  });
  assert.throws(
    () => runWithFixture(root, mismatchStub, ["--verify"]),
    /does not match the pinned linked Neon resource/u,
  );
  assert.equal(mismatchStub.calls.length, 3);

  await writeFile(path.join(root, migrationRelativePath), "select 1;\n");
  const tamperedStub = createSynchronousChildStub();
  assert.throws(
    () => runWithFixture(root, tamperedStub, ["--verify"]),
    /does not match the pinned digest/u,
  );
  assert.equal(tamperedStub.calls.length, 0);
});

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";
import {
  createTestPoolOptions,
  requireSafeTestDatabaseUrl,
} from "../../scripts/run-postgres-integration.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migrationPath = join(
  repositoryRoot,
  "db/migrations/20260715120000_add_customer_360_core.sql",
);
const customerProfilesPath = join(repositoryRoot, "api/_lib/customer-profiles.ts");
const postgresModulePath = join(repositoryRoot, "api/_lib/postgres.ts");
const controlledEnvironmentNames = [
  "SIDESTREAM_LICENSE_NAMESPACE",
  "SIDESTREAM_PRODUCTION_API_HOSTS",
  "SIDESTREAM_TEST_API_HOSTS",
  "SIDESTREAM_POSTGRES_URL",
  "SIDESTREAM_POSTGRES_PRISMA_URL",
  "SIDESTREAM_POSTGRES_URL_NON_POOLING",
  "SIDESTREAM_TEST_POSTGRES_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
  "POSTGRES_POOL_MAX",
  "VERCEL_ENV",
  "NODE_ENV",
];

test("Customer 360 merges are transactional, isolated, and database-enforced", {
  timeout: 120_000,
}, async (t) => {
  const testDatabaseUrl = requireSafeTestDatabaseUrl(process.env);
  const schema = `sidestream_c360_${randomBytes(10).toString("hex")}`;
  const quotedSchema = quoteIdentifier(schema);
  const environmentSnapshot = snapshotEnvironment(controlledEnvironmentNames);
  const directPool = new Pool(createTestPoolOptions(testDatabaseUrl));
  const temporaryDirectory = await mkdtemp(
    join(dirname(fileURLToPath(import.meta.url)), ".core-postgres-"),
  );
  let schemaCreated = false;
  let runtimePoolAttached = false;

  try {
    await directPool.query(`create schema ${quotedSchema}`);
    schemaCreated = true;
    const migration = await readFile(migrationPath, "utf8");
    await directPool.query(rewritePublicSchema(migration, schema));

    configureRuntimeEnvironment(testDatabaseUrl);
    const customerProfiles = await loadCustomerProfilesForSchema(
      schema,
      temporaryDirectory,
    );

    await t.test("all core tables use RLS and unknown lifetime counts stay null", async () => {
      const expectedTables = [
        "sidestream_customer_identity_links",
        "sidestream_customer_installs",
        "sidestream_customer_profile_merges",
        "sidestream_customer_profiles",
      ];
      const rls = await directPool.query(
        `
          select relname, relrowsecurity
          from pg_class
          join pg_namespace on pg_namespace.oid = pg_class.relnamespace
          where nspname = $1 and relkind = 'r'
          order by relname
        `,
        [schema],
      );
      assert.deepEqual(rls.rows.map((row) => row.relname), expectedTables);
      assert.equal(rls.rows.every((row) => row.relrowsecurity), true);

      const columns = await directPool.query(
        `
          select column_name, is_nullable, column_default
          from information_schema.columns
          where table_schema = $1
            and table_name = 'sidestream_customer_profiles'
            and column_name in ('download_success_count', 'download_failure_count')
          order by column_name
        `,
        [schema],
      );
      assert.deepEqual(columns.rows, [
        {
          column_name: "download_failure_count",
          is_nullable: "YES",
          column_default: null,
        },
        {
          column_name: "download_success_count",
          is_nullable: "YES",
          column_default: null,
        },
      ]);
      const sparse = await seedProfile(directPool, quotedSchema, {
        namespace: "test",
        createdAt: "2026-07-01T00:00:00.000Z",
      });
      assert.equal(sparse.download_success_count, null);
      assert.equal(sparse.download_failure_count, null);

      for (const linkType of ["install_identity_hash", "installer_receipt_hash"]) {
        await assert.rejects(
          directPool.query(
            `
              insert into ${quotedSchema}.sidestream_customer_identity_links (
                profile_id, license_namespace, link_type, link_value
              ) values ($1, 'test', $2, 'raw-device-or-receipt-id')
            `,
            [sparse.id, linkType],
          ),
          postgresError("23514"),
        );
      }
      await directPool.query(
        `
          insert into ${quotedSchema}.sidestream_customer_identity_links (
            profile_id, license_namespace, link_type, link_value
          ) values ($1, 'test', 'installer_receipt_hash', $2)
        `,
        [sparse.id, "a".repeat(64)],
      );
    });

    const older = await seedProfile(directPool, quotedSchema, {
      namespace: "test",
      createdAt: "2026-07-10T00:00:00.000Z",
    });
    const newer = await seedProfile(directPool, quotedSchema, {
      namespace: "test",
      createdAt: "2026-07-11T00:00:00.000Z",
    });
    await seedIdentityAndInstall(directPool, quotedSchema, older.id, {
      linkType: "account_identity",
      linkValue: "account:older",
      installHash: "b".repeat(64),
    });
    await seedIdentityAndInstall(directPool, quotedSchema, newer.id, {
      linkType: "stripe_customer",
      linkValue: "cus_newer",
      installHash: "c".repeat(64),
    });
    await directPool.query(
      `
        insert into ${quotedSchema}.sidestream_customer_identity_links (
          profile_id, license_namespace, link_type, link_value
        ) values ($1, 'test', 'installer_receipt_hash', $2)
      `,
      [newer.id, "d".repeat(64)],
    );

    await t.test("concurrent retries converge, re-point evidence, and append one audit", async () => {
      runtimePoolAttached = true;
      const mergeInput = {
        leftProfileId: newer.id,
        rightProfileId: older.id,
        evidenceType: "account_identity",
        evidenceValueHash: "e".repeat(64),
        initiatedBy: "system",
        // Deliberately ignored: request-shaped input cannot select Production.
        licenseNamespace: "production",
      };
      const results = await Promise.all([
        customerProfiles.mergeCustomerProfiles(mergeInput),
        customerProfiles.mergeCustomerProfiles(mergeInput),
      ]);
      assert.deepEqual(results.map((result) => result.merged).sort(), [false, true]);
      assert.ok(results.every((result) => result.licenseNamespace === "test"));
      assert.ok(results.every((result) => result.survivorId === older.id));

      const profiles = await directPool.query(
        `
          select id, merged_into
          from ${quotedSchema}.sidestream_customer_profiles
          where id = any($1::uuid[])
          order by id
        `,
        [[older.id, newer.id]],
      );
      assert.equal(profiles.rows.find((row) => row.id === older.id).merged_into, null);
      assert.equal(profiles.rows.find((row) => row.id === newer.id).merged_into, older.id);

      const links = await directPool.query(
        `
          select profile_id
          from ${quotedSchema}.sidestream_customer_identity_links
          where profile_id = any($1::uuid[])
        `,
        [[older.id, newer.id]],
      );
      assert.ok(links.rows.length >= 3);
      assert.ok(links.rows.every((row) => row.profile_id === older.id));
      const installs = await directPool.query(
        `
          select profile_id
          from ${quotedSchema}.sidestream_customer_installs
          where install_id_hash in ($1, $2)
        `,
        ["b".repeat(64), "c".repeat(64)],
      );
      assert.deepEqual(installs.rows.map((row) => row.profile_id), [older.id, older.id]);

      const audit = await directPool.query(
        `
          select id, source_profile_id, target_profile_id,
            merge_evidence_value_hash, initiated_by
          from ${quotedSchema}.sidestream_customer_profile_merges
          where source_profile_id = $1
        `,
        [newer.id],
      );
      assert.equal(audit.rows.length, 1);
      assert.equal(audit.rows[0].target_profile_id, older.id);
      assert.equal(audit.rows[0].merge_evidence_value_hash, "e".repeat(64));
      assert.equal(audit.rows[0].initiated_by, "system");

      await assert.rejects(
        directPool.query(
          `
            insert into ${quotedSchema}.sidestream_customer_identity_links (
              profile_id, license_namespace, link_type, link_value
            ) values ($1, 'test', 'support_code', 'stale-tombstone-link')
          `,
          [newer.id],
        ),
        (error) => {
          assert.equal(error.code, "23514");
          assert.match(error.message, /live profile root/);
          return true;
        },
      );
    });

    await t.test("reverse retries are no-ops and A-to-B-to-A cycles fail at the database", async () => {
      const reverse = await customerProfiles.mergeCustomerProfiles({
        leftProfileId: older.id,
        rightProfileId: newer.id,
        evidenceType: "account_identity",
        evidenceValueHash: "e".repeat(64),
        initiatedBy: "system",
      });
      assert.equal(reverse.merged, false);
      assert.equal(reverse.survivorId, older.id);

      await assert.rejects(
        directPool.query(
          `
            update ${quotedSchema}.sidestream_customer_profiles
            set merged_into = $2, merged_at = now()
            where id = $1
          `,
          [older.id, newer.id],
        ),
        (error) => {
          assert.equal(error.code, "23514");
          assert.match(error.message, /acyclic|cycle/i);
          return true;
        },
      );

      const first = await seedProfile(directPool, quotedSchema, {
        namespace: "test",
        createdAt: "2026-08-01T00:00:00.000Z",
      });
      const second = await seedProfile(directPool, quotedSchema, {
        namespace: "test",
        createdAt: "2026-08-02T00:00:00.000Z",
      });
      const contenders = await Promise.allSettled([
        directAuditedMerge(directPool, quotedSchema, first.id, second.id, "1".repeat(64)),
        directAuditedMerge(directPool, quotedSchema, second.id, first.id, "2".repeat(64)),
      ]);
      assert.equal(contenders.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = contenders.find((result) => result.status === "rejected");
      assert.equal(rejected.reason.code, "23514");
      const pair = await directPool.query(
        `select id, merged_into from ${quotedSchema}.sidestream_customer_profiles where id = any($1::uuid[])`,
        [[first.id, second.id]],
      );
      assert.equal(pair.rows.find((row) => row.id === first.id).merged_into, null);
      assert.equal(pair.rows.find((row) => row.id === second.id).merged_into, first.id);
    });

    await t.test("a later older root safely absorbs the complete evidence chain", async () => {
      const oldest = await seedProfile(directPool, quotedSchema, {
        namespace: "test",
        createdAt: "2026-06-01T00:00:00.000Z",
      });
      await seedIdentityAndInstall(directPool, quotedSchema, oldest.id, {
        linkType: "stripe_payment_intent",
        linkValue: "pi_oldest",
        installHash: "f".repeat(64),
      });
      const merged = await customerProfiles.mergeCustomerProfiles({
        leftProfileId: older.id,
        rightProfileId: oldest.id,
        evidenceType: "stripe_payment_intent",
        evidenceValueHash: "9".repeat(64),
        initiatedBy: "backfill",
      });
      assert.equal(merged.merged, true);
      assert.equal(merged.survivorId, oldest.id);
      assert.equal(merged.tombstoneId, older.id);

      const evidence = await directPool.query(
        `
          select profile_id
          from ${quotedSchema}.sidestream_customer_identity_links
          where link_value in ('account:older', 'cus_newer', 'pi_oldest')
          order by link_value
        `,
      );
      assert.deepEqual(evidence.rows.map((row) => row.profile_id), [
        oldest.id,
        oldest.id,
        oldest.id,
      ]);
      const installs = await directPool.query(
        `
          select profile_id
          from ${quotedSchema}.sidestream_customer_installs
          where install_id_hash = any($1::text[])
          order by install_id_hash
        `,
        [["b".repeat(64), "c".repeat(64), "f".repeat(64)]],
      );
      assert.deepEqual(installs.rows.map((row) => row.profile_id), [
        oldest.id,
        oldest.id,
        oldest.id,
      ]);

      const reverse = await customerProfiles.mergeCustomerProfiles({
        leftProfileId: newer.id,
        rightProfileId: oldest.id,
        evidenceType: "stripe_customer",
        evidenceValueHash: "8".repeat(64),
        initiatedBy: "system",
      });
      assert.equal(reverse.merged, false);
      assert.equal(reverse.survivorId, oldest.id);
      await assert.rejects(
        directPool.query(
          `
            update ${quotedSchema}.sidestream_customer_profiles
            set merged_into = $2, merged_at = now()
            where id = $1
          `,
          [oldest.id, newer.id],
        ),
        postgresError("23514"),
      );
    });

    await t.test("namespace boundaries and mandatory audit persistence fail closed", async () => {
      const isolatedTest = await seedProfile(directPool, quotedSchema, {
        namespace: "test",
        createdAt: "2026-09-02T00:00:00.000Z",
      });
      const isolatedProduction = await seedProfile(directPool, quotedSchema, {
        namespace: "production",
        createdAt: "2026-09-01T00:00:00.000Z",
      });
      await assert.rejects(
        directPool.query(
          `
            update ${quotedSchema}.sidestream_customer_profiles
            set merged_into = $2, merged_at = now()
            where id = $1
          `,
          [isolatedTest.id, isolatedProduction.id],
        ),
        postgresError("23503"),
      );
      await assert.rejects(
        customerProfiles.mergeCustomerProfiles({
          leftProfileId: isolatedTest.id,
          rightProfileId: isolatedProduction.id,
          evidenceType: "account_identity",
          evidenceValueHash: "7".repeat(64),
          initiatedBy: "system",
        }),
        /trusted license namespace/,
      );

      const unauditedTarget = await seedProfile(directPool, quotedSchema, {
        namespace: "test",
        createdAt: "2026-05-01T00:00:00.000Z",
      });
      const unauditedSource = await seedProfile(directPool, quotedSchema, {
        namespace: "test",
        createdAt: "2026-05-02T00:00:00.000Z",
      });
      await assert.rejects(
        directPool.query(
          `
            update ${quotedSchema}.sidestream_customer_profiles
            set merged_into = $2, merged_at = now()
            where id = $1
          `,
          [unauditedSource.id, unauditedTarget.id],
        ),
        (error) => {
          assert.equal(error.code, "23514");
          assert.match(error.message, /requires an immutable merge audit/);
          return true;
        },
      );
    });

    await t.test("merge audits reject owner UPDATE and DELETE", async () => {
      const audit = await directPool.query(
        `select id from ${quotedSchema}.sidestream_customer_profile_merges where source_profile_id = $1`,
        [newer.id],
      );
      assert.equal(audit.rows.length, 1);
      await assert.rejects(
        directPool.query(
          `update ${quotedSchema}.sidestream_customer_profile_merges set initiated_by = 'support' where id = $1`,
          [audit.rows[0].id],
        ),
        postgresError("55000"),
      );
      await assert.rejects(
        directPool.query(
          `delete from ${quotedSchema}.sidestream_customer_profile_merges where id = $1`,
          [audit.rows[0].id],
        ),
        postgresError("55000"),
      );
      const remains = await directPool.query(
        `select count(*)::int as count from ${quotedSchema}.sidestream_customer_profile_merges where id = $1`,
        [audit.rows[0].id],
      );
      assert.equal(remains.rows[0].count, 1);
    });
  } finally {
    if (runtimePoolAttached) {
      const postgres = await import(pathToFileURL(postgresModulePath).href);
      await postgres.getPostgresPool({
        connectionString: testDatabaseUrl,
        environmentVariable: "SIDESTREAM_TEST_POSTGRES_URL",
        pooled: true,
      }).end();
    }
    if (schemaCreated) {
      await directPool.query(`drop schema if exists ${quotedSchema} cascade`);
    }
    await directPool.end();
    await rm(temporaryDirectory, { recursive: true, force: true });
    restoreEnvironment(environmentSnapshot);
  }
});

async function loadCustomerProfilesForSchema(schema, temporaryDirectory) {
  let source = rewritePublicSchema(await readFile(customerProfilesPath, "utf8"), schema);
  const imports = {
    "./license-environment.js": pathToFileURL(
      join(repositoryRoot, "api/_lib/license-environment.ts"),
    ).href,
    "./postgres.js": pathToFileURL(postgresModulePath).href,
  };
  for (const [original, replacement] of Object.entries(imports)) {
    assert.ok(source.includes(JSON.stringify(original)), `missing import ${original}`);
    source = source.replaceAll(JSON.stringify(original), JSON.stringify(replacement));
  }
  const modulePath = join(temporaryDirectory, "customer-profiles-under-test.ts");
  await writeFile(modulePath, source, { mode: 0o600 });
  return import(`${pathToFileURL(modulePath).href}?schema=${schema}`);
}

async function seedProfile(pool, quotedSchema, options) {
  const result = await pool.query(
    `
      insert into ${quotedSchema}.sidestream_customer_profiles (
        license_namespace, created_at, updated_at
      ) values ($1, $2, $2)
      returning id, download_success_count, download_failure_count
    `,
    [options.namespace, options.createdAt],
  );
  return result.rows[0];
}

async function seedIdentityAndInstall(pool, quotedSchema, profileId, options) {
  await pool.query(
    `
      insert into ${quotedSchema}.sidestream_customer_identity_links (
        profile_id, license_namespace, link_type, link_value
      ) values ($1, 'test', $2, $3)
    `,
    [profileId, options.linkType, options.linkValue],
  );
  await pool.query(
    `
      insert into ${quotedSchema}.sidestream_customer_installs (
        profile_id, license_namespace, install_id_hash, platform, app_version
      ) values ($1, 'test', $2, 'macos', '1.0.14')
    `,
    [profileId, options.installHash],
  );
}

async function directAuditedMerge(pool, quotedSchema, sourceId, targetId, evidenceHash) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `
        update ${quotedSchema}.sidestream_customer_profiles
        set merged_into = $2, merged_at = now(), updated_at = now()
        where id = $1
      `,
      [sourceId, targetId],
    );
    await client.query(
      `
        insert into ${quotedSchema}.sidestream_customer_profile_merges (
          license_namespace, source_profile_id, target_profile_id,
          merge_evidence_type, merge_evidence_value_hash, initiated_by
        ) values ('test', $1, $2, 'account_identity', $3, 'system')
      `,
      [sourceId, targetId, evidenceHash],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function configureRuntimeEnvironment(testDatabaseUrl) {
  for (const name of controlledEnvironmentNames) delete process.env[name];
  process.env.SIDESTREAM_LICENSE_NAMESPACE = "test";
  process.env.SIDESTREAM_TEST_API_HOSTS = "customer-360.test";
  process.env.SIDESTREAM_TEST_POSTGRES_URL = testDatabaseUrl;
  process.env.POSTGRES_POOL_MAX = "4";
  process.env.VERCEL_ENV = "test";
  process.env.NODE_ENV = "test";
}

function rewritePublicSchema(source, schema) {
  return source.replace(/\bpublic\./g, `${quoteIdentifier(schema)}.`);
}

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new TypeError("Unsafe schema");
  return `"${identifier}"`;
}

function postgresError(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

function snapshotEnvironment(names) {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(snapshot) {
  for (const [name, value] of snapshot) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

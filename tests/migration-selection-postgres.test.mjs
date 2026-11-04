import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { loadMigrationFiles, validateMigrationFiles } from "../scripts/apply-postgres-migrations.mjs";

const ONLY = "20261103120000_add_selected_upgrade_plans.sql";
const PREREQUISITE = "20260825140000_add_annual_upgrade_pricing_experiment.sql";
const UNRELATED = [
  "20260925120000_add_download_friend_rewards.sql",
  "20261022003000_add_paid_initial_authorizations.sql",
];
const runner = new URL("../scripts/apply-postgres-migrations.mjs", import.meta.url);

test("bounded CLI validates the full ledger and applies only the requested migration atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "sidestream-migration-selection-"));
  const data = join(root, "data");
  let started = false;
  let pool;
  try {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    execFileSync("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "--encoding=UTF8", "--no-locale", "--no-sync"], { stdio: "pipe" });
    execFileSync("pg_ctl", ["-D", data, "-l", join(root, "postgres.log"), "-o", `-F -p ${port} -h 127.0.0.1 -k /tmp`, "-w", "-t", "20", "start"], { stdio: "pipe" });
    started = true;
    // A fresh loopback cluster is owned by this test; no inherited database URL is used.
    const connectionString = `postgresql://postgres:disposable@127.0.0.1:${port}/postgres?sslmode=disable`;
    pool = new Pool({ connectionString, max: 1 });
    const migrations = validateMigrationFiles(await loadMigrationFiles());
    const applied = migrations.filter(({ filename }) => ![ONLY, ...UNRELATED].includes(filename));
    for (const migration of applied) await pool.query(migration.sql);
    for (const migration of applied) {
      await pool.query(`insert into public.sidestream_schema_migrations
        (filename, checksum_sha256, duration_ms) values ($1, $2, 0)`, [migration.filename, migration.checksum]);
    }
    const env = {
      PATH: process.env.PATH,
      SIDESTREAM_TEST_POSTGRES_URL: connectionString,
    };
    function cli(...args) {
      return spawnSync(process.execPath, [runner.pathname, "--target", "test", ...args], {
        cwd: process.cwd(), env, encoding: "utf8", timeout: 30_000,
      });
    }
    const ledger = async () => (await pool.query(
      "select * from public.sidestream_schema_migrations order by filename",
    )).rows;
    const constraint = async () => (await pool.query(`select pg_get_constraintdef(oid) as definition
      from pg_constraint where conname = 'sidestream_checkout_intents_upgrade_pricing_snapshot_valid'`)).rows[0].definition;
    const before = await ledger();
    const originalConstraint = await constraint();
    const status = cli("--status");
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, new RegExp(`pending: ${ONLY}`));
    for (const filename of UNRELATED) assert.match(status.stdout, new RegExp(`pending: ${filename}`));

    // A pending prerequisite must fail without modifying even the selected constraint.
    await pool.query("delete from public.sidestream_schema_migrations where filename = $1", [PREREQUISITE]);
    const withoutPrerequisite = await ledger();
    assert.equal(cli("--only", ONLY).status, 1);
    assert.deepEqual(await ledger(), withoutPrerequisite);
    assert.equal(await constraint(), originalConstraint);
    const prerequisite = before.find(({ filename }) => filename === PREREQUISITE);
    await pool.query(`insert into public.sidestream_schema_migrations
      (filename, checksum_sha256, applied_at, duration_ms) values ($1, $2, $3, $4)`,
    [prerequisite.filename, prerequisite.checksum_sha256, prerequisite.applied_at, prerequisite.duration_ms]);

    // Unrelated applied checksum drift remains fatal to the narrowed command.
    await pool.query("update public.sidestream_schema_migrations set checksum_sha256 = $2 where filename = $1",
      [before[0].filename, "0".repeat(64)]);
    const corrupted = await ledger();
    assert.equal(cli("--only", ONLY).status, 1);
    assert.deepEqual(await ledger(), corrupted);
    assert.equal(await constraint(), originalConstraint);
    await pool.query("update public.sidestream_schema_migrations set checksum_sha256 = $2 where filename = $1",
      [before[0].filename, before[0].checksum_sha256]);

    // Failure after DDL but before the ledger insert must roll back both together.
    await pool.query(`create function public.reject_selected_migration_test() returns trigger
      language plpgsql as $$ begin raise exception 'fixture ledger failure'; end $$;
      create trigger reject_selected_migration_test before insert on public.sidestream_schema_migrations
      for each row execute function public.reject_selected_migration_test()`);
    assert.equal(cli("--only", ONLY).status, 1);
    assert.deepEqual(await ledger(), before);
    assert.equal(await constraint(), originalConstraint);
    await pool.query(`drop trigger reject_selected_migration_test on public.sidestream_schema_migrations;
      drop function public.reject_selected_migration_test()`);

    const apply = cli("--only", ONLY);
    assert.equal(apply.status, 0, apply.stderr);
    assert.match(apply.stdout, new RegExp(`Applied ${ONLY}`));
    const after = await ledger();
    assert.deepEqual(after.filter(({ filename }) => filename !== ONLY), before);
    assert.equal(after.find(({ filename }) => filename === ONLY).checksum_sha256,
      migrations.find(({ filename }) => filename === ONLY).checksum);
    assert.match(await constraint(), /upgrade-plans-v1/);
    for (const table of ["sidestream_download_referral_members", "sidestream_paid_initial_authorizations"]) {
      assert.equal((await pool.query("select to_regclass($1) as relation", [`public.${table}`])).rows[0].relation, null);
    }
    const replay = cli("--only", ONLY);
    assert.equal(replay.status, 0, replay.stderr);
    assert.match(replay.stdout, /Selected migration is already applied/);
    assert.deepEqual(await ledger(), after);
    const finalStatus = cli("--status");
    assert.equal(finalStatus.status, 0, finalStatus.stderr);
    for (const filename of UNRELATED) assert.match(finalStatus.stdout, new RegExp(`pending: ${filename}`));
  } finally {
    await pool?.end();
    if (started) execFileSync("pg_ctl", ["-D", data, "-w", "-t", "20", "-m", "immediate", "stop"], { stdio: "pipe" });
    await rm(root, { recursive: true, force: true });
  }
});

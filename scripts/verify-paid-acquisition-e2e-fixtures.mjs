import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const testPath = path.join(
  repoRoot,
  "tests",
  "paid-acquisition-e2e-fixtures.test.mjs",
);
const packageJson = JSON.parse(
  await readFile(path.join(repoRoot, "package.json"), "utf8"),
);
const source = await readFile(testPath, "utf8");

assert.equal(
  packageJson.scripts?.["test:paid-acquisition-e2e"],
  "node --experimental-strip-types --test tests/paid-acquisition-e2e-fixtures.test.mjs",
  "test:paid-acquisition-e2e must run only the deterministic fixture harness",
);

for (const marker of [
  "sticky mobile assignment",
  "desktop",
  "bot",
  "scanner",
  "prefetch",
  "invalidCookie",
  "provider unavailable",
  "database unavailable",
  "payment_pending",
  "email_mismatch",
  "already_claimed",
  "refunded",
  "disputed",
  "activation_expired",
  "macos-universal",
  "windows-x64",
  "verifiedOriginalAmountMinor: 1999",
  'redirect.source === "/m"',
]) {
  assert.ok(source.includes(marker), `missing fixture coverage marker: ${marker}`);
}

for (const forbidden of [
  "api.stripe.com",
  "api.resend.com",
  "@vercel/blob",
  "@neondatabase",
  "vercel deploy",
]) {
  assert.equal(
    source.includes(forbidden),
    false,
    `fixture harness must not reference live provider surface: ${forbidden}`,
  );
}

const childEnvironment = { ...process.env };
for (const name of Object.keys(childEnvironment)) {
  if (
    /(STRIPE|RESEND|BLOB|POSTGRES|NEON|VERCEL|GOOGLE|OAUTH)/i.test(name)
  ) {
    delete childEnvironment[name];
  }
}
childEnvironment.SIDESTREAM_PAID_ACQUISITION_E2E_FIXTURE_ONLY = "1";

const result = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--test",
    "tests/paid-acquisition-e2e-fixtures.test.mjs",
  ],
  {
    cwd: repoRoot,
    env: childEnvironment,
    encoding: "utf8",
  },
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
assert.equal(
  result.status,
  0,
  `paid-acquisition fixture harness exited ${result.status}`,
);

console.log("paid-acquisition E2E fixtures verified without live provider state");

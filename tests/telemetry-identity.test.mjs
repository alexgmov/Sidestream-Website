import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  linkTelemetryIdentity,
  normalizeTelemetryIdentityInput,
  TelemetryIdentityInputError,
} from "../api/_lib/telemetry-identity.ts";

const INSTALL_A = "a".repeat(64);
const INSTALL_B = "b".repeat(64);
const DEVICE_A = "c".repeat(64);
const DEVICE_B = "d".repeat(64);
const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("only the optional install hash survives compatibility payload normalization", () => {
  assert.deepEqual(normalizeTelemetryIdentityInput({
    installIdHash: INSTALL_A,
    supportCode: { deliberately: "invalid legacy value" },
    installerReceiptIdHash: "not-a-hash",
  }), { installIdHash: INSTALL_A });
  assert.deepEqual(normalizeTelemetryIdentityInput({
    supportCode: "SIDE-ABCD-EFGH-IJKL",
    installerReceiptIdHash: INSTALL_B,
  }), {});
  assert.throws(
    () => normalizeTelemetryIdentityInput({ installIdHash: "not-a-hash" }),
    TelemetryIdentityInputError,
  );
});

test("first bind and a reset install on the same device create independent rows", async () => {
  const client = new MemoryBridgeClient();

  assert.deepEqual(await link(client, { installIdHash: INSTALL_A }), {
    outcome: "created",
  });
  assert.deepEqual(await link(client, { installIdHash: INSTALL_B }), {
    outcome: "created",
  });
  assert.deepEqual(client.get(INSTALL_A), {
    deviceIdHash: DEVICE_A,
    accountId: null,
    linkedAt: null,
    lastSeen: 1,
  });
  assert.deepEqual(client.get(INSTALL_B), {
    deviceIdHash: DEVICE_A,
    accountId: null,
    linkedAt: null,
    lastSeen: 2,
  });
});

test("verified account linking is idempotent and advances last seen", async () => {
  const client = new MemoryBridgeClient();
  await link(client, { installIdHash: INSTALL_A });

  assert.deepEqual(await link(client, {
    installIdHash: INSTALL_A,
    accountId: ACCOUNT_A,
  }), { outcome: "linked" });
  const linked = client.get(INSTALL_A);
  assert.equal(linked.accountId, ACCOUNT_A);
  assert.equal(typeof linked.linkedAt, "number");

  assert.deepEqual(await link(client, {
    installIdHash: INSTALL_A,
    accountId: ACCOUNT_A,
  }), { outcome: "seen" });
  const repeated = client.get(INSTALL_A);
  assert.equal(repeated.accountId, ACCOUNT_A);
  assert.equal(repeated.linkedAt, linked.linkedAt);
  assert.ok(repeated.lastSeen > linked.lastSeen);
});

test("device and account conflicts never overwrite the first binding", async () => {
  const client = new MemoryBridgeClient();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await link(client, { installIdHash: INSTALL_A, accountId: ACCOUNT_A });
    const first = client.get(INSTALL_A);

    assert.deepEqual(await link(client, {
      installIdHash: INSTALL_A,
      deviceIdHash: DEVICE_B,
      accountId: ACCOUNT_A,
    }), { outcome: "conflict", conflict: "device" });
    assert.deepEqual(client.get(INSTALL_A), first);

    assert.deepEqual(await link(client, {
      installIdHash: INSTALL_A,
      accountId: ACCOUNT_B,
    }), { outcome: "conflict", conflict: "account" });
    assert.deepEqual(client.get(INSTALL_A), first);
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, [
    ["Telemetry identity bridge conflict", { conflict: "device" }],
    ["Telemetry identity bridge conflict", { conflict: "account" }],
  ]);
  assert.doesNotMatch(JSON.stringify(warnings), new RegExp(INSTALL_A));
  assert.doesNotMatch(JSON.stringify(warnings), new RegExp(ACCOUNT_A));
});

test("a deleted linked account remains reserved instead of accepting a replacement", async () => {
  const client = new MemoryBridgeClient();
  await link(client, { installIdHash: INSTALL_A, accountId: ACCOUNT_A });
  client.simulateAccountDeletion(INSTALL_A);

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await link(client, {
      installIdHash: INSTALL_A,
      accountId: ACCOUNT_B,
    }), { outcome: "conflict", conflict: "account" });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(client.get(INSTALL_A).accountId, null);
});

test("an absent bridge schema is a transaction-safe no-op", async () => {
  const client = new MemoryBridgeClient({ schemaPresent: false });
  assert.deepEqual(await link(client, { installIdHash: INSTALL_A }), {
    outcome: "unavailable",
    reason: "schema_absent",
  });
  assert.equal(client.size, 0);
  assert.deepEqual(client.transactionControls, [
    "savepoint sidestream_telemetry_identity_link",
    "release savepoint sidestream_telemetry_identity_link",
  ]);
});

test("claim URLs/forms contain no telemetry or retired Customer 360 identity fields", async () => {
  const claim = await readFile(new URL("../api/activation/claim.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    claim,
    /installIdHash|supportCode|installerReceiptIdHash|customerIdentity|customer identity/i,
  );
  assert.match(claim, /new URLSearchParams\(\{ activation: activationKey \}\)/);

  for (const route of [
    "../api/activation/start.ts",
    "../api/activation/status.ts",
    "../api/license/verify.ts",
    "../api/license/refresh.ts",
  ]) {
    const source = await readFile(new URL(route, import.meta.url), "utf8");
    assert.match(source, /installIdHash/);
    assert.doesNotMatch(source, /supportCode|installerReceiptIdHash|invalid_customer_identity/);
  }

  await assert.rejects(
    access(new URL("../api/_lib/customer-identity.ts", import.meta.url)),
    (error) => error?.code === "ENOENT",
  );
});

test("retired Customer 360 runtime and browser surfaces stay absent", async () => {
  const retiredRuntimePaths = [
    "api/_lib/customer-360-contract.ts",
    "api/_lib/customer-admin.ts",
    "api/_lib/customer-commerce.ts",
    "api/_lib/customer-identity.ts",
    "api/_lib/customer-profiles.ts",
    "api/_lib/customer-query.ts",
    "api/_lib/customer-usage.ts",
    "api/internal/customer-usage/sync.ts",
    "api/internal/customers/index.ts",
    "api/internal/customers/[customerId].ts",
    "scripts/backfill-customer-360.mjs",
    "scripts/run-customer-360-tests.mjs",
    "scripts/verify-customer-360-backfill.mjs",
  ];
  for (const path of retiredRuntimePaths) {
    await assert.rejects(
      access(join(REPOSITORY_ROOT, path)),
      (error) => error?.code === "ENOENT",
      path,
    );
  }

  const runtimeFiles = [
    ...(await listFiles("api")).filter((path) => path.endsWith(".ts")),
    ...(await listFiles("scripts")).filter((path) => path.endsWith(".mjs")),
    "package.json",
    "vercel.json",
  ];
  const runtimeSources = await Promise.all(runtimeFiles.map(async (path) => ({
    path,
    source: await readFile(join(REPOSITORY_ROOT, path), "utf8"),
  })));
  const retiredRuntimeReference = new RegExp([
    "customer-(?:360-contract|admin|commerce|identity|profiles|query|usage)",
    "internal/(?:customer-usage|customers)",
    "sidestream_customer_(?:profiles|identity_(?:links|reviews)|installs|profile_merges|commerce|money|usage)",
  ].join("|"), "i");
  for (const { path, source } of runtimeSources) {
    assert.doesNotMatch(source, retiredRuntimeReference, path);
  }

  assert.deepEqual(
    runtimeSources
      .filter(({ source }) => source.includes("installIdHash"))
      .map(({ path }) => path)
      .sort(),
    [
      "api/_lib/account.ts",
      "api/_lib/telemetry-identity.ts",
      "api/activation/start.ts",
      "api/activation/status.ts",
      "api/license/refresh.ts",
      "api/license/verify.ts",
    ],
  );
  assert.deepEqual(
    runtimeSources
      .filter(({ path }) => /identity/i.test(path))
      .map(({ path }) => path),
    ["api/_lib/telemetry-identity.ts"],
  );

  const browserFiles = [
    "index.html",
    "account.html",
    "thank-you.html",
    "upgrade.html",
    "Sidestream front end 2/Sidestream.html",
    ...(await listFiles("components")).filter((path) => /\.(?:js|jsx|ts|tsx)$/.test(path)),
    ...(await listFiles("src")).filter((path) => /\.(?:js|jsx|ts|tsx)$/.test(path)),
  ];
  for (const path of browserFiles) {
    const source = await readFile(join(REPOSITORY_ROOT, path), "utf8");
    assert.doesNotMatch(
      source,
      /installIdHash|supportCode|installerReceiptIdHash|customerIdentity/i,
      path,
    );
  }
});

async function listFiles(relativeDirectory) {
  const entries = await readdir(join(REPOSITORY_ROOT, relativeDirectory), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function link(client, options) {
  return linkTelemetryIdentity(client, {
    licenseNamespace: "production",
    installIdHash: options.installIdHash,
    deviceIdHash: options.deviceIdHash || DEVICE_A,
    accountId: options.accountId || null,
  });
}

class MemoryBridgeClient {
  constructor({ schemaPresent = true } = {}) {
    this.schemaPresent = schemaPresent;
    this.rows = new Map();
    this.clock = 0;
    this.transactionControls = [];
  }

  get size() {
    return this.rows.size;
  }

  get(installIdHash) {
    const row = this.rows.get(`production:${installIdHash}`);
    return row && {
      deviceIdHash: row.device_id_hash,
      accountId: row.account_id,
      linkedAt: row.linked_at,
      lastSeen: row.last_seen_at,
    };
  }

  simulateAccountDeletion(installIdHash) {
    this.rows.get(`production:${installIdHash}`).account_id = null;
  }

  async query(text, params = []) {
    const sql = String(text).replace(/\s+/g, " ").trim();
    if (/^(savepoint|release savepoint|rollback to savepoint) /.test(sql)) {
      this.transactionControls.push(sql);
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("to_regclass('public.sidestream_telemetry_identity_links')")) {
      return {
        rows: [{
          bridge: this.schemaPresent
            ? "sidestream_telemetry_identity_links"
            : null,
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("insert into public.sidestream_telemetry_identity_links")) {
      const [namespace, installIdHash, deviceIdHash, accountId] = params;
      const key = `${namespace}:${installIdHash}`;
      if (this.rows.has(key)) return { rows: [], rowCount: 0 };
      const now = ++this.clock;
      this.rows.set(key, {
        device_id_hash: deviceIdHash,
        account_id: accountId,
        linked_at: accountId ? now : null,
        last_seen_at: now,
      });
      return { rows: [{ account_id: accountId }], rowCount: 1 };
    }
    if (sql.startsWith("select device_id_hash, account_id, linked_at")) {
      const row = this.rows.get(`${params[0]}:${params[1]}`);
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("update public.sidestream_telemetry_identity_links")) {
      const [namespace, installIdHash, accountId, deviceIdHash] = params;
      const row = this.rows.get(`${namespace}:${installIdHash}`);
      if (!row || row.device_id_hash !== deviceIdHash) {
        return { rows: [], rowCount: 0 };
      }
      const now = ++this.clock;
      if (accountId && row.account_id === null && row.linked_at === null) {
        row.account_id = accountId;
        row.linked_at = now;
      }
      row.last_seen_at = now;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected test query: ${sql}`);
  }
}

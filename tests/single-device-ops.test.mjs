import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AUDIT_READ_QUERIES,
  PRODUCTION_CONFIRMATION as AUDIT_PRODUCTION_CONFIRMATION,
  buildSafeAuditReport,
  classifyAuditAccounts,
  parseAuditArgs,
  resolveDatabaseSelection as resolveAuditDatabase,
  withTransaction as withAuditTransaction,
} from "../scripts/audit-license-devices.mjs";
import {
  DEFAULT_TRANSFER_LIMIT,
  MAX_OVERRIDE_DURATION_MS,
  PRODUCTION_CONFIRMATION as MANAGE_PRODUCTION_CONFIRMATION,
  SUPPORT_READ_QUERIES,
  TRANSFER_WINDOW_MS,
  buildSafeDeviceState,
  buildSupportFeatureUpdate,
  countConfirmedMoves,
  evaluateTransferState,
  parseManageArgs,
  readTransferLimitOverride,
  resolveDatabaseSelection as resolveManageDatabase,
  withTransaction as withManageTransaction,
} from "../scripts/manage-license-device.mjs";

const accountA = "00000000-0000-4000-8000-000000000001";
const accountB = "00000000-0000-4000-8000-000000000002";
const accountC = "00000000-0000-4000-8000-000000000003";
const accountD = "00000000-0000-4000-8000-000000000004";
const deviceA = "a".repeat(64);
const deviceB = "b".repeat(64);
const deviceC = "c".repeat(64);

test("audit classifies zero, one, and multiple candidates without selecting in read-only mode", () => {
  const fixtures = [
    { accountId: accountA, candidates: [] },
    {
      accountId: accountB,
      candidates: [{
        deviceIdHash: deviceA,
        activatedAt: "2026-07-01T00:00:00.000Z",
        lastSeenAt: "2026-07-02T00:00:00.000Z",
      }],
    },
    {
      accountId: accountC,
      candidates: [
        {
          deviceIdHash: deviceA,
          activatedAt: "2026-07-01T00:00:00.000Z",
          lastSeenAt: "2026-07-02T00:00:00.000Z",
        },
        {
          deviceIdHash: deviceB,
          activatedAt: "2026-07-03T00:00:00.000Z",
          lastSeenAt: "2026-07-04T00:00:00.000Z",
        },
        {
          deviceIdHash: deviceB,
          activatedAt: "2026-07-03T00:00:00.000Z",
          lastSeenAt: "2026-07-04T00:00:00.000Z",
        },
      ],
    },
    {
      accountId: accountD,
      activeBinding: { bindingId: "binding-d", deviceIdHash: deviceC },
      candidates: [{
        deviceIdHash: deviceA,
        activatedAt: "2026-07-01T00:00:00.000Z",
        lastSeenAt: "2026-07-05T00:00:00.000Z",
      }],
    },
  ];

  const observed = classifyAuditAccounts(fixtures);
  assert.deepEqual(observed.map((entry) => entry.category), ["zero", "one", "multiple", "one"]);
  assert.equal(observed[2].candidateCount, 2);
  assert.ok(observed.every((entry) => entry.selectedCandidate === null));
  assert.equal(observed[3].mayBackfill, false);

  const report = buildSafeAuditReport(observed, { target: "production" });
  assert.deepEqual(report.summary, {
    accounts: 4,
    zero: 1,
    one: 2,
    multiple: 1,
    activeBindings: 1,
    eligibleForBackfill: 2,
    inserted: 0,
  });
  assert.equal("selectedDeviceRef" in report.accounts[2], false);
});

test("apply-only winner selection is newest-first with a deterministic opaque tie-break", () => {
  const tieTimestamp = "2026-07-04T00:00:00.000Z";
  const classified = classifyAuditAccounts([{
    accountId: accountA,
    candidates: [
      { deviceIdHash: deviceC, activatedAt: tieTimestamp, lastSeenAt: tieTimestamp },
      { deviceIdHash: deviceB, activatedAt: tieTimestamp, lastSeenAt: tieTimestamp },
      {
        deviceIdHash: deviceA,
        activatedAt: "2026-07-01T00:00:00.000Z",
        lastSeenAt: "2026-07-03T23:59:59.000Z",
      },
    ],
  }], { apply: true });
  assert.equal(classified[0].selectedCandidate.deviceIdHash, deviceB);

  classified[0].applyStatus = "inserted";
  const json = JSON.stringify(buildSafeAuditReport(classified, {
    apply: true,
    target: "production",
  }));
  for (const forbidden of [accountA, deviceA, deviceB, deviceC, "person@example.com", "postgres://secret"]) {
    assert.equal(json.includes(forbidden), false);
  }
  assert.match(json, /selectedDeviceRef/);
});

test("audit apply requires a direct URL and literal production confirmation", () => {
  assert.throws(
    () => parseAuditArgs([
      "--target", "production",
      "--apply",
      "--database-url-env", "POSTGRES_URL_NON_POOLING",
    ]),
    /Production apply requires/,
  );
  const options = parseAuditArgs([
    "--target", "production",
    "--apply",
    "--database-url-env", "POSTGRES_URL_NON_POOLING",
    "--confirm-production", AUDIT_PRODUCTION_CONFIRMATION,
  ]);
  assert.equal(options.apply, true);
  assert.throws(
    () => resolveAuditDatabase(
      { POSTGRES_URL_NON_POOLING: "postgres://user:secret@pooler.example:6543/app" },
      options,
    ),
    /pooled\/runtime endpoint/,
  );
  assert.throws(
    () => resolveAuditDatabase(
      { POSTGRES_URL: "postgres://user:secret@db.example:5432/app" },
      { ...options, databaseUrlEnv: "POSTGRES_URL" },
    ),
    /refuses pooled\/runtime URLs/,
  );
  assert.equal(
    resolveAuditDatabase(
      { POSTGRES_URL_NON_POOLING: "postgres://user:secret@db.example:5432/app" },
      options,
    ).name,
    "POSTGRES_URL_NON_POOLING",
  );
});

test("support mutations require selector, apply, safe audit fields, and bounded override", () => {
  const common = [
    "--account-id", accountA,
    "--namespace", "production",
    "--target", "production",
    "--database-url-env", "POSTGRES_URL_NON_POOLING",
    "--reason", "support_recovery",
    "--operator-id", "support.agent",
    "--confirm-production", MANAGE_PRODUCTION_CONFIRMATION,
  ];
  assert.throws(() => parseManageArgs(["clear", ...common]), /requires --apply/);
  assert.throws(
    () => parseManageArgs(["clear", "--apply", ...common.slice(2)]),
    /explicit UUID --account-id/,
  );
  assert.throws(
    () => parseManageArgs(["clear", "--apply", ...common, "--reason", "customer@example.com"]),
    /Set --reason to one of/,
  );

  const nowMs = Date.UTC(2026, 6, 14, 20);
  const expiresAt = new Date(nowMs + MAX_OVERRIDE_DURATION_MS).toISOString();
  const override = parseManageArgs([
    "override",
    "--apply",
    ...common,
    "--max-moves", "5",
    "--expires-at", expiresAt,
  ], nowMs);
  assert.equal(override.maxMoves, 5);
  assert.equal(override.expiresAt, expiresAt);
  assert.throws(
    () => parseManageArgs([
      "override",
      "--apply",
      ...common,
      "--max-moves", "5",
      "--expires-at", new Date(nowMs + MAX_OVERRIDE_DURATION_MS + 1).toISOString(),
    ], nowMs),
    /at most 30 days/,
  );
  assert.throws(
    () => resolveManageDatabase(
      { POSTGRES_URL_NON_POOLING: "postgres://user:secret@pooler.example:6543/app" },
      override,
    ),
    /pooled\/runtime endpoint/,
  );
});

test("first activation and same-device reconnects do not count, but a post-deactivation change does", () => {
  const nowMs = Date.UTC(2026, 6, 14, 20);
  const days = (count) => count * 24 * 60 * 60 * 1000;
  const devices = [
    {
      id: "a-first",
      deviceIdHash: deviceA,
      activatedAt: nowMs - days(40),
      revokedAt: nowMs - days(20),
    },
    {
      id: "a-reconnect",
      deviceIdHash: deviceA,
      activatedAt: nowMs - days(20),
      revokedAt: nowMs - days(10),
    },
    {
      id: "b-after-clear",
      deviceIdHash: deviceB,
      activatedAt: nowMs - days(10),
      revokedAt: nowMs - days(5),
    },
    {
      id: "b-reconnect",
      deviceIdHash: deviceB,
      activatedAt: nowMs - days(5),
      revokedAt: nowMs - days(1),
    },
    {
      id: "a-return",
      deviceIdHash: deviceA,
      activatedAt: nowMs,
      revokedAt: null,
    },
  ];
  const transfers = [{
    fromDeviceId: "a-reconnect",
    toDeviceId: "b-after-clear",
    transferredAt: nowMs - days(10),
  }];
  assert.deepEqual(countConfirmedMoves({ devices, transfers, nowMs }), {
    confirmedMoveCount: 2,
    windowStartedAtMs: nowMs - TRANSFER_WINDOW_MS,
  });
  assert.equal(countConfirmedMoves({ devices: [devices[0]], nowMs }).confirmedMoveCount, 0);

  const boundaryDevices = [
    { id: "before", deviceIdHash: deviceA, activatedAt: nowMs - TRANSFER_WINDOW_MS - 1 },
    { id: "boundary", deviceIdHash: deviceB, activatedAt: nowMs - TRANSFER_WINDOW_MS },
  ];
  assert.equal(countConfirmedMoves({ devices: boundaryDevices, nowMs }).confirmedMoveCount, 1);
});

test("default policy permits at most three confirmed moves in the rolling window", () => {
  const nowMs = Date.UTC(2026, 6, 14, 20);
  const devices = [
    { id: "a1", deviceIdHash: deviceA, activatedAt: nowMs - 4_000 },
    { id: "b1", deviceIdHash: deviceB, activatedAt: nowMs - 3_000 },
    { id: "c1", deviceIdHash: deviceC, activatedAt: nowMs - 2_000 },
    { id: "a2", deviceIdHash: deviceA, activatedAt: nowMs - 1_000 },
  ];
  const state = evaluateTransferState({
    devices,
    transfers: [],
    features: {},
    namespace: "production",
    nowMs,
  });
  assert.equal(state.limit, DEFAULT_TRANSFER_LIMIT);
  assert.equal(state.confirmedMoveCount, 3);
  assert.equal(state.remainingMoves, 0);
  assert.equal(state.allowed, false);
});

test("support overrides are namespace-scoped, expiring, audited, and idempotent", () => {
  const nowMs = Date.UTC(2026, 6, 14, 20);
  const nowIso = new Date(nowMs).toISOString();
  const productionMutation = {
    action: "override",
    accountId: accountA,
    namespace: "production",
    reason: "support_recovery",
    operatorId: "support.agent",
    limit: 5,
    expiresAt: new Date(nowMs + 60_000).toISOString(),
  };
  const first = buildSupportFeatureUpdate({}, productionMutation, nowIso);
  assert.equal(first.changed, true);
  assert.equal(first.features.singleDevicePolicy.supportAudit.length, 1);
  assert.equal(readTransferLimitOverride(first.features, nowMs, "production").limit, 5);
  assert.equal(readTransferLimitOverride(first.features, nowMs, "test"), null);
  assert.equal(readTransferLimitOverride(first.features, nowMs + 60_000, "production"), null);

  const replay = buildSupportFeatureUpdate(
    first.features,
    productionMutation,
    new Date(nowMs + 1).toISOString(),
  );
  assert.equal(replay.changed, false);
  assert.deepEqual(replay.features, first.features);

  const testMutation = {
    ...productionMutation,
    namespace: "test",
    limit: 4,
  };
  const second = buildSupportFeatureUpdate(first.features, testMutation, nowIso);
  assert.equal(readTransferLimitOverride(second.features, nowMs, "production").limit, 5);
  assert.equal(readTransferLimitOverride(second.features, nowMs, "test").limit, 4);
  assert.equal(second.features.singleDevicePolicy.supportAudit.length, 2);
});

test("clear support audit entries and safe views never expose account or device identifiers", () => {
  const nowMs = Date.UTC(2026, 6, 14, 20);
  const mutation = {
    action: "clear",
    accountId: accountA,
    namespace: "production",
    bindingId: "11111111-1111-4111-8111-111111111111",
    reason: "customer_request",
    operatorId: "support.agent",
  };
  const first = buildSupportFeatureUpdate({}, mutation, new Date(nowMs).toISOString());
  const replay = buildSupportFeatureUpdate(first.features, mutation, new Date(nowMs + 1).toISOString());
  assert.equal(first.changed, true);
  assert.equal(replay.changed, false);
  assert.equal(first.features.singleDevicePolicy.supportAudit[0].reason, "customer_request");

  const output = buildSafeDeviceState({
    accountId: accountA,
    namespace: "production",
    devices: [{
      id: mutation.bindingId,
      deviceIdHash: deviceA,
      platform: "macos",
      appVersion: "1.0.14",
      activatedAt: nowMs - 1_000,
      lastSeenAt: nowMs,
      revokedAt: null,
    }],
    transfers: [],
    license: { features: first.features },
  }, { nowMs });
  const json = JSON.stringify(output);
  for (const forbidden of [accountA, deviceA, mutation.bindingId, "person@example.com", "postgres://secret"]) {
    assert.equal(json.includes(forbidden), false);
  }
  assert.match(output.accountRef, /^acct_[0-9a-f]{12}$/);
  assert.match(output.activeDevice.deviceRef, /^dev_[0-9a-f]{12}$/);
});

test("database operations use read-only or serializable transactions and roll back failures", async () => {
  for (const withTransaction of [withAuditTransaction, withManageTransaction]) {
    const successCalls = [];
    const successClient = {
      async query(sql) {
        successCalls.push(sql);
        return { rows: [] };
      },
    };
    await withTransaction(successClient, { readOnly: true }, async () => "ok");
    assert.match(successCalls[0], /repeatable read read only/);
    assert.equal(successCalls.at(-1), "commit");

    const failureCalls = [];
    const failureClient = {
      async query(sql) {
        failureCalls.push(sql);
        return { rows: [] };
      },
    };
    await assert.rejects(
      withTransaction(failureClient, { readOnly: false }, async () => {
        throw new Error("fixture failure");
      }),
      /fixture failure/,
    );
    assert.match(failureCalls[0], /serializable read write/);
    assert.equal(failureCalls.at(-1), "rollback");
  }
});

test("queries avoid sensitive identity and token columns, and package exposes the operator commands", async () => {
  const auditSql = Object.values(AUDIT_READ_QUERIES).join("\n");
  const supportSql = Object.values(SUPPORT_READ_QUERIES).join("\n");
  for (const sql of [auditSql, supportSql]) {
    assert.doesNotMatch(sql, /\bemail\b/i);
    assert.doesNotMatch(sql, /\b(token_hash|refresh_token_hash|activation_key)\b/i);
    assert.doesNotMatch(sql, /\b(ip_address|user_agent)\b/i);
  }
  assert.match(auditSql, /t\.revoked_at is null/i);
  assert.match(auditSql, /group by t\.account_id, t\.device_id_hash/i);

  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["devices:audit"], "node scripts/audit-license-devices.mjs");
  assert.equal(packageJson.scripts["devices:manage"], "node scripts/manage-license-device.mjs");
  assert.equal(
    packageJson.scripts["test:single-device-ops"],
    "node --experimental-strip-types --test tests/single-device-ops.test.mjs",
  );
});

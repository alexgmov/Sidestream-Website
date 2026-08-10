import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PAID_ACQUISITION_PAID_COHORT,
  associatePaidAcquisitionActivationWithOutcome,
  createPaidAcquisitionLandingProof,
  createPaidAcquisitionReceipt,
  createPaidAcquisitionReceiptCookie,
  validatePaidAcquisitionAssignmentCookie,
  validatePaidAcquisitionLandingProof,
  validatePaidAcquisitionReceiptCookie,
} from "../api/_lib/paid-acquisition.ts";
import {
  readNormalizedPaidLandingAttribution,
} from "../api/_lib/paid-landing-attribution.ts";
import { sanitizeAccountNextPath } from "../api/_lib/entitlement.ts";

const SECRET = "0123456789abcdef0123456789abcdef";
const NOW_MS = Date.UTC(2026, 6, 27, 7, 0, 0);
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";

const middlewareSource = await readFile(
  new URL("../middleware.ts", import.meta.url),
  "utf8",
);
const helperSource = `
  export function next() {
    return new Response(null, { headers: { "x-test-next": "1" } });
  }
  export function rewrite(url, init = {}) {
    const response = new Response(null, { headers: { "x-test-rewrite": String(url) } });
    for (const [name, value] of init.request?.headers || []) {
      response.headers.set("x-rewrite-" + name, value);
    }
    return response;
  }
`;
const helperUrl =
  `data:text/javascript;base64,${Buffer.from(helperSource).toString("base64")}`;
const middleware = await import(
  `data:text/javascript;base64,${Buffer.from(
    middlewareSource.replace(
      'from "@vercel/functions"',
      `from "${helperUrl}"`,
    ),
  ).toString("base64")}`
);

test("the paid landing accepts only the server-owned ManyChat and Meta sources", () => {
  assert.deepEqual(
    readNormalizedPaidLandingAttribution(new URLSearchParams(
      "utm_source=meta&utm_medium=social&utm_campaign=sidestream_direct_offer_test&utm_content=paid",
    )),
    {
      utmMedium: "social",
      utmCampaign: "sidestream_direct_offer_test",
      utmContent: "paid",
    },
  );
  assert.deepEqual(
    readNormalizedPaidLandingAttribution(new URLSearchParams(
      "utm_source=manychat&utm_medium=dm&utm_campaign=Launch_1",
    )),
    { utmMedium: "dm", utmCampaign: "Launch_1" },
  );
  assert.equal(
    readNormalizedPaidLandingAttribution(new URLSearchParams(
      "utm_source=instagram&utm_medium=social",
    )),
    null,
  );
});

test("the router cookie is consumable by the audited server helper", async () => {
  const nonce = paidNonce();
  const response = await middleware.routePaidExperimentForTest(
    new Request(
      "https://sidestream.tv/mc?utm_source=manychat&utm_medium=dm&utm_campaign=Launch_1",
      {
        headers: {
          "user-agent": IPHONE_UA,
          "sec-fetch-dest": "document",
        },
      },
    ),
    {
      secret: SECRET,
      nowMs: NOW_MS,
      nonceBytes: nonce,
    },
  );
  const cookieValue = response.headers
    .get("set-cookie")
    .split(";", 1)[0]
    .split("=")
    .slice(1)
    .join("=");
  const assignment = validatePaidAcquisitionAssignmentCookie(cookieValue, {
    secret: SECRET,
    now: Math.floor(NOW_MS / 1000),
  });

  assert.equal(assignment.cohort, PAID_ACQUISITION_PAID_COHORT);
  assert.match(cookieValue, /^1\.[A-Za-z0-9_-]{22}\.mc-paid-v1\./);
  assert.equal(
    response.headers.get("x-test-rewrite"),
    "https://sidestream.tv/mobile-paid-prototype.html",
  );
  assert.match(
    response.headers.get(
      "x-rewrite-x-sidestream-paid-acquisition-assignment",
    ),
    /^1\./,
  );
  assert.equal(
    response.headers.get(
      "x-rewrite-x-sidestream-paid-acquisition-attribution",
    ),
    "utm_source=manychat&utm_medium=dm&utm_campaign=Launch_1",
  );
});

test("the internal landing proof binds assignment and normalized attribution", () => {
  const assignment = "1.assignment.mc-paid-v1.1785139200.signature";
  const attribution =
    "utm_source=manychat&utm_medium=dm&utm_campaign=Launch_1";
  const proof = createPaidAcquisitionLandingProof({
    assignmentCookieValue: assignment,
    attributionQuery: attribution,
    secret: SECRET,
  });
  assert.equal(
    validatePaidAcquisitionLandingProof({
      assignmentCookieValue: assignment,
      attributionQuery: attribution,
      proof,
      secret: SECRET,
    }),
    true,
  );
  assert.throws(() =>
    validatePaidAcquisitionLandingProof({
      assignmentCookieValue: assignment,
      attributionQuery: `${attribution}&email=private@example.com`,
      proof,
      secret: SECRET,
    })
  );
});

test("receipt derivation and claim-cookie signing remain environment bound", () => {
  const receipt = createPaidAcquisitionReceipt({
    environment: "test",
    verifiedCheckoutSessionRef: "cs_test_paid_1",
    secret: SECRET,
  });
  assert.match(receipt, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(
    receipt,
    createPaidAcquisitionReceipt({
      environment: "production",
      verifiedCheckoutSessionRef: "cs_test_paid_1",
      secret: SECRET,
    }),
  );
  const cookie = createPaidAcquisitionReceiptCookie({
    receipt,
    environment: "test",
    secret: SECRET,
  });
  assert.equal(
    validatePaidAcquisitionReceiptCookie({
      cookieValue: cookie,
      environment: "test",
      secret: SECRET,
    }),
    receipt,
  );
  assert.throws(() =>
    validatePaidAcquisitionReceiptCookie({
      cookieValue: cookie,
      environment: "production",
      secret: SECRET,
    })
  );
});

test("paid activation binds only one exact account/install/receipt lineage", async (t) => {
  for (const [name, database, expected] of [
    ["missing activation", createPaidBindingDatabase({ activationRows: [] }), "receipt_activation_no_match"],
    ["wrong activation source", createPaidBindingDatabase({
      activationRows: [matchingActivation({ activation_source_matches: false })],
    }), "activation_source_mismatch"],
    ["different account", createPaidBindingDatabase({
      activationRows: [matchingActivation({
        activation_account_ref: "70000000-0000-4000-8000-000000000007",
      })],
    }), "claim_binding_conflict"],
    ["expired authorization", createPaidBindingDatabase({
      claimRows: [matchingClaim({ authorization_expired: true })],
    }), "receipt_activation_no_match"],
    ["refunded payment", createPaidBindingDatabase({
      claimRows: [matchingClaim({ payment_state: "refunded" })],
    }), "receipt_activation_no_match"],
    ["disputed payment", createPaidBindingDatabase({
      claimRows: [matchingClaim({ payment_state: "disputed" })],
    }), "receipt_activation_no_match"],
    ["missing exact identity", createPaidBindingDatabase({ identityRows: [] }), "installation_identity_missing"],
    ["contradictory install owner", createPaidBindingDatabase({
      identityRows: [exactIdentity({
        installOwnerAccountId: "70000000-0000-4000-8000-000000000007",
      })],
    }), "installation_identity_conflict"],
    ["wrong exact install", createPaidBindingDatabase({
      identityRows: [exactIdentity({ installIdHash: "f".repeat(64) })],
    }), "installation_identity_conflict"],
  ]) {
    await t.test(name, async () => {
      const result = await runPaidActivationLinkage(database);
      assert.equal(result.outcome, expected);
      assert.equal(database.bindings.length, 0);
      assert.equal(database.mergeAudits, 0);
    });
  }

  await t.test("ledger ownership conflict cannot merge or bind", async () => {
    const database = createPaidBindingDatabase({ ownerConflict: true });
    const result = await runPaidActivationLinkage(database);
    assert.equal(result.outcome, "acquisition_ownership_conflict");
    assert.equal(database.bindings.length, 0);
    assert.equal(database.mergeAudits, 0);
  });

  await t.test("valid replay converges on one binding, merge, and stage", async () => {
    const database = createPaidBindingDatabase();
    const first = await runPaidActivationLinkage(database);
    const replay = await runPaidActivationLinkage(database);
    assert.equal(first.outcome, "installation_claimed_recorded");
    assert.equal(replay.outcome, "installation_claimed_recorded");
    assert.equal(database.bindings.length, 1);
    assert.equal(database.mergeAudits, 1);
    assert.equal(database.stageValues.size, 1);
    assert.deepEqual(database.identityLookups[0], [
      INSTALL_ID_HASH,
      INSTALLER_RECEIPT_ID_HASH,
      ACCOUNT_ID,
    ]);
  });

  await t.test("malformed current identity fails before database access", async () => {
    const database = createPaidBindingDatabase();
    await assert.rejects(
      associatePaidAcquisitionActivationWithOutcome({
        environment: "production",
        activationKey: "activation-test-key",
        expectedAccountId: ACCOUNT_ID,
        receipt: BROWSER_RECEIPT,
        installIdHash: "NOT-A-HASH",
        installerReceiptIdHash: INSTALLER_RECEIPT_ID_HASH,
      }, {
        transaction: async (callback) => callback(database.client),
      }),
      (error) => error?.code === "invalid_request",
    );
    assert.equal(database.queries.length, 0);
  });
});

test("Google OAuth return sanitization admits only the exact paid claim shape", () => {
  assert.equal(
    sanitizeAccountNextPath(
      "/api/paid-acquisition/claim?activation=opaque-key",
    ),
    "/api/paid-acquisition/claim?activation=opaque-key",
  );
  for (const invalid of [
    "/api/paid-acquisition/claim",
    "/api/paid-acquisition/claim?activation=a&receipt=attacker",
    "https://attacker.example/api/paid-acquisition/claim?activation=a",
  ]) {
    assert.equal(sanitizeAccountNextPath(invalid), "/account.html");
  }
});

test("the namespaced migration is private, additive, and hash-only", async () => {
  const sql = await readFile(
    new URL(
      "../db/migrations/20260727010000_add_paid_acquisition_experiment.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const table of [
    "sidestream_paid_acquisition_entries",
    "sidestream_paid_acquisition_checkouts",
    "sidestream_paid_acquisition_email_outbox",
    "sidestream_paid_acquisition_claims",
    "sidestream_paid_acquisition_events",
  ]) {
    assert.match(sql, new RegExp(`create table public\\.${table}`));
    assert.match(
      sql,
      new RegExp(`alter table public\\.${table} enable row level security`),
    );
  }
  assert.match(sql, /entry_token_hash text not null/);
  assert.match(sql, /installer_receipt_hash text/);
  assert.doesNotMatch(sql, /\b(entry_token|installer_receipt)\s+text\b/);
  assert.doesNotMatch(
    sql,
    /alter table public\.(?!sidestream_paid_acquisition_)/,
  );
});

test("the paid acquisition price migration preserves provider bounds at USD 2499", async () => {
  const sql = await readFile(
    new URL(
      "../db/migrations/20260728090000_update_paid_acquisition_price.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    sql,
    /drop constraint sidestream_paid_acquisition_checkouts_provider_bounds/,
  );
  assert.match(sql, /verified_amount_minor = 2499/);
  assert.match(sql, /verified_quantity = 1/);
  assert.match(sql, /verified_currency = 'usd'/);
});

test("the paid acquisition provider bounds permit future server-verified prices", async () => {
  const sql = await readFile(
    new URL(
      "../db/migrations/20260728093000_make_paid_price_constraint_amount_agnostic.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    sql,
    /drop constraint sidestream_paid_acquisition_checkouts_provider_bounds/,
  );
  assert.match(sql, /verified_amount_minor >= 0/);
  assert.doesNotMatch(sql, /verified_amount_minor = 2499/);
  assert.match(sql, /verified_quantity = 1/);
  assert.match(sql, /verified_currency = 'usd'/);
});

test("the regional offer migration permits bounded server-verified currencies", async () => {
  const sql = await readFile(
    new URL(
      "../db/migrations/20260729120000_add_regional_checkout_offer_snapshots.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    sql,
    /drop constraint if exists sidestream_paid_acquisition_checkouts_provider_bounds/,
  );
  assert.match(sql, /verified_amount_minor >= 0/);
  assert.match(sql, /verified_currency ~ '\^\[a-z\]\{3\}\$'/);
  assert.doesNotMatch(sql, /verified_currency = 'usd'/);
});

test("public paid routes accept no browser-selected commerce truth", async () => {
  const [checkout, artifact, claim, landing] = await Promise.all([
    readFile(
      new URL("../api/paid-acquisition/checkout.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../api/paid-acquisition/artifact.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../api/paid-acquisition/claim.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../api/paid-acquisition/landing.ts", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(checkout, /keys\.join\(","\) === "entryToken,idempotencyKey,schemaVersion"/);
  assert.doesNotMatch(checkout, /payload\.(?:email|amount|currency|price|product|quantity|environment|cohort)/);
  assert.match(artifact, /fulfillCheckoutSession/);
  assert.match(claim, /normalizePaidAcquisitionVerifiedEmail/);
  assert.match(claim, /claimActivationToAccount/);
  assert.match(landing, /persistPaidAcquisitionEntry/);
  assert.match(landing, /ENTRY_PLACEHOLDER/);
});

function paidNonce() {
  for (let value = 0; value < 10_000; value += 1) {
    const nonce = new Uint8Array(16);
    new DataView(nonce.buffer).setUint32(12, value);
    const encoded = Buffer.from(nonce).toString("base64url");
    const digest = createHmac("sha256", SECRET)
      .update(`mc-mobile-paid-v1:${encoded}`)
      .digest();
    if (Number(digest.readBigUInt64BE(0) % 10_000n) >= 5_000) {
      return nonce;
    }
  }
  throw new Error("Unable to find paid nonce");
}

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const ENTITLEMENT_ID = "20000000-0000-4000-8000-000000000002";
const ACTIVATION_REF = "30000000-0000-4000-8000-000000000003";
const CLAIM_ID = "40000000-0000-4000-8000-000000000004";
const CHECKOUT_ID = "50000000-0000-4000-8000-000000000005";
const ACQUISITION_ID = "60000000-0000-4000-8000-000000000006";
const PAID_PROFILE_ID = "70000000-0000-4000-8000-000000000007";
const INSTALL_PROFILE_ID = "80000000-0000-4000-8000-000000000008";
const INSTALL_ID_HASH = "a".repeat(64);
const INSTALLER_RECEIPT_ID_HASH = "b".repeat(64);
const BROWSER_RECEIPT = Buffer.alloc(32, 9).toString("base64url");

async function runPaidActivationLinkage(database) {
  return associatePaidAcquisitionActivationWithOutcome({
    environment: "production",
    activationKey: "activation-test-key",
    expectedAccountId: ACCOUNT_ID,
    receipt: BROWSER_RECEIPT,
    installIdHash: INSTALL_ID_HASH,
    installerReceiptIdHash: INSTALLER_RECEIPT_ID_HASH,
    occurredAt: new Date("2026-08-09T12:00:00.000Z"),
  }, {
    transaction: async (callback) => callback(database.client),
    recordStage: async (input, options) => {
      database.stageValues.add(JSON.stringify([
        input.acquisitionId,
        input.stage,
        input.stableServerReference,
      ]));
      database.integrityCalls.push(["stage", input, options]);
      return { ownerConflict: database.ownerConflict };
    },
    addEvidence: async (input, options) => {
      database.integrityCalls.push(["evidence", input, options]);
    },
    mergeProfiles: database.mergeProfiles,
  });
}

function matchingActivation(overrides = {}) {
  return {
    activation_ref: ACTIVATION_REF,
    activation_source_matches: true,
    activation_expired: false,
    activation_account_ref: ACCOUNT_ID,
    activation_entitlement_ref: ENTITLEMENT_ID,
    ...overrides,
  };
}

function matchingClaim(overrides = {}) {
  return {
    claim_id: CLAIM_ID,
    checkout_id: CHECKOUT_ID,
    claim_activation_ref: null,
    claim_account_ref: ACCOUNT_ID,
    claim_entitlement_ref: ENTITLEMENT_ID,
    claim_state: "claimed",
    claim_expired: false,
    payment_state: "active",
    payment_verified: true,
    authorization_expired: false,
    checkout_account_ref: ACCOUNT_ID,
    entitlement_account_ref: ACCOUNT_ID,
    entitlement_status: "active",
    acquisition_id: ACQUISITION_ID,
    acquisition_integrity_state: "intact",
    ...overrides,
  };
}

function exactIdentity({
  installIdHash = INSTALL_ID_HASH,
  installerReceiptIdHash = INSTALLER_RECEIPT_ID_HASH,
  paidProfileId = PAID_PROFILE_ID,
  installProfileId = INSTALL_PROFILE_ID,
  installOwnerAccountId = null,
} = {}) {
  return {
    paid_profile_id: paidProfileId,
    install_profile_id: installProfileId,
    install_membership_id: "90000000-0000-4000-8000-000000000009",
    install_id_hash: installIdHash,
    install_identity_link_id: "a0000000-0000-4000-8000-000000000010",
    activation_identity_link_id: "b0000000-0000-4000-8000-000000000011",
    account_identity_link_id: "c0000000-0000-4000-8000-000000000012",
    installer_receipt_identity_link_id: "d0000000-0000-4000-8000-000000000013",
    installer_receipt_id_hash: installerReceiptIdHash,
    install_owner_account_id: installOwnerAccountId,
  };
}

function createPaidBindingDatabase({
  activationRows = [matchingActivation()],
  claimRows = [matchingClaim()],
  identityRows = [exactIdentity()],
  ownerConflict = false,
} = {}) {
  const database = {
    activationRows: structuredClone(activationRows),
    claimRows: structuredClone(claimRows),
    identityRows: structuredClone(identityRows),
    ownerConflict,
    bindings: [],
    mergeAudits: 0,
    queries: [],
    identityLookups: [],
    integrityCalls: [],
    stageValues: new Set(),
  };
  database.mergeProfiles = async (_client, environment, input) => {
    assert.equal(environment, "production");
    assert.equal(input.leftProfileId, database.identityRows[0].paid_profile_id);
    assert.equal(input.rightProfileId, database.identityRows[0].install_profile_id);
    const survivorId = database.identityRows[0].install_profile_id;
    if (input.leftProfileId !== input.rightProfileId) database.mergeAudits += 1;
    for (const row of database.identityRows) {
      row.paid_profile_id = survivorId;
      row.install_profile_id = survivorId;
      row.install_owner_account_id = ACCOUNT_ID;
    }
    return {
      merged: input.leftProfileId !== input.rightProfileId,
      survivorId,
      tombstoneId: input.leftProfileId === input.rightProfileId
        ? null
        : input.leftProfileId,
    };
  };
  database.client = {
    async query(sql, params = []) {
      database.queries.push({ sql, params });
      if (sql.includes("paid-telemetry-binding:select-activation")) {
        return { rows: structuredClone(database.activationRows) };
      }
      if (sql.includes("paid-telemetry-binding:select-claim")) {
        return { rows: structuredClone(database.claimRows) };
      }
      if (sql.includes("paid-telemetry-binding:select-exact-identities")) {
        database.identityLookups.push([params[2], params[3], params[4]]);
        return { rows: structuredClone(database.identityRows) };
      }
      if (sql.includes("paid-telemetry-binding:select-binding")) {
        return { rows: structuredClone(database.bindings.filter((row) =>
          row.claim_id === params[0] ||
          (row.license_namespace === params[1] &&
            (row.activation_ref === params[2] || row.binding_key === params[3]))
        ).slice(0, 2)) };
      }
      if (sql.includes("paid-telemetry-binding:bind-claim")) {
        const claim = database.claimRows.find((row) => row.claim_id === params[0]);
        if (!claim || (claim.claim_activation_ref && claim.claim_activation_ref !== params[1])) {
          return { rows: [] };
        }
        claim.claim_activation_ref = params[1];
        return { rows: [{ id: claim.claim_id }] };
      }
      if (sql.includes("paid-telemetry-binding:insert-binding")) {
        if (database.bindings.length === 0) {
          database.bindings.push({
            license_namespace: params[0],
            claim_id: params[1],
            checkout_id: params[2],
            acquisition_id: params[3],
            account_id: params[4],
            entitlement_id: params[5],
            activation_ref: params[6],
            profile_id_at_binding: params[7],
            install_membership_id: params[8],
            install_id_hash: params[9],
            install_identity_link_id: params[10],
            activation_identity_link_id: params[11],
            account_identity_link_id: params[12],
            installer_receipt_identity_link_id: params[13],
            installer_receipt_id_hash: params[14],
            binding_key: params[15],
          });
        }
        return { rows: [] };
      }
      throw new Error(`Unexpected paid binding query: ${sql}`);
    },
  };
  return database;
}

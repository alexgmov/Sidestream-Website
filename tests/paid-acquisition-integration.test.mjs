import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PAID_ACQUISITION_PAID_COHORT,
  createPaidAcquisitionLandingProof,
  createPaidAcquisitionReceipt,
  createPaidAcquisitionReceiptCookie,
  validatePaidAcquisitionAssignmentCookie,
  validatePaidAcquisitionLandingProof,
  validatePaidAcquisitionReceiptCookie,
} from "../api/_lib/paid-acquisition.ts";
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
    "https://sidestream.tv/mobile-paid-prototype.html?utm_source=manychat&utm_medium=dm&utm_campaign=Launch_1",
  );
  assert.match(
    response.headers.get(
      "x-rewrite-x-sidestream-paid-acquisition-assignment",
    ),
    /^1\./,
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

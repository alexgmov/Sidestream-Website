import assert from "node:assert/strict";
import test from "node:test";

import {
  PAID_INSTALLER_EMAIL_MAX_LEASE_MS,
  PAID_INSTALLER_EMAIL_STATES,
  PAID_INSTALLER_EMAIL_TYPE,
  PaidInstallerEmailConfigurationError,
  PaidInstallerEmailDeliveryError,
  createPaidInstallerEmailJob,
  createPaidInstallerEmailOutboxKey,
  createPaidInstallerProviderIdempotencyKey,
  sendPaidInstallerEmail,
} from "../api/_lib/paid-installer-email.ts";

const RECEIPT = "a".repeat(43);

function checkout(overrides = {}) {
  return {
    environment: "test",
    verifiedCheckoutSessionId: "cs_test_paid_123",
    verifiedCheckoutEmail: "buyer@example.com",
    paymentStatus: "paid",
    ...overrides,
  };
}

test("builds paid-only Mac and Windows onboarding email with recovery copy", () => {
  const job = createPaidInstallerEmailJob({
    checkout: checkout(),
    onboardingReceipt: RECEIPT,
  });

  assert.deepEqual(job.outboxKey, {
    environment: "test",
    verifiedCheckoutSessionId: "cs_test_paid_123",
    emailType: PAID_INSTALLER_EMAIL_TYPE,
  });
  assert.deepEqual(PAID_INSTALLER_EMAIL_STATES, [
    "pending",
    "sending",
    "accepted",
    "retryable",
    "dead_letter",
  ]);
  assert.equal(PAID_INSTALLER_EMAIL_MAX_LEASE_MS, 300_000);
  assert.equal(job.message.from, "Sidestream <downloads@alexg.mov>");
  assert.equal(job.message.reply_to, "alex@alexg.mov");
  assert.deepEqual(job.message.to, ["buyer@example.com"]);
  assert.match(job.message.html, /Set up on Mac/);
  assert.match(job.message.html, /Set up on Windows/);
  assert.match(job.message.html, /same Google email used at Checkout/i);
  assert.match(job.message.html, /reply to this message for support recovery/i);
  assert.match(job.message.html, /installer does not grant Unlimited access/i);
  assert.match(job.message.html, /refund or dispute may remove paid access/i);
  assert.match(job.message.text, /platform=macos-universal/);
  assert.match(job.message.text, /platform=windows-x64/);
  assert.equal((job.message.html.match(/border-radius:999px/g) || []).length, 2);
  assert.equal((job.message.html.match(/class="platform-link"/g) || []).length, 2);
  assert.doesNotMatch(job.message.html, /STREAM20|free installer/i);
  assert.doesNotMatch(job.message.text, /STREAM20|free installer/i);
  assert.doesNotMatch(job.message.html, /cs_test_paid_123/);
});

test("escapes recipient and public artifact URLs in HTML", () => {
  const recipient = "buyer&ops@example.com";
  const job = createPaidInstallerEmailJob({
    checkout: checkout({ verifiedCheckoutEmail: recipient }),
    onboardingReceipt: RECEIPT,
    publicOrigin: "https://paid.sidestream.tv",
  });

  assert.match(job.message.html, /buyer&amp;ops@example\.com/);
  assert.doesNotMatch(job.message.html, /buyer&ops@example\.com/);
  assert.match(
    job.message.html,
    /artifact\?receipt=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&amp;platform=macos-universal/,
  );
  assert.match(job.message.text, /buyer&ops@example\.com/);
});

test("requires an explicitly verified paid Checkout input", () => {
  assert.throws(
    () =>
      createPaidInstallerEmailJob({
        checkout: checkout({ paymentStatus: "unpaid" }),
        onboardingReceipt: RECEIPT,
      }),
    (error) =>
      error instanceof PaidInstallerEmailConfigurationError &&
      error.message === "Verified paid Checkout is required",
  );
});

test("duplicate callbacks converge on the environment, Session, and email type", () => {
  const firstKey = createPaidInstallerEmailOutboxKey(checkout());
  const duplicateKey = createPaidInstallerEmailOutboxKey(
    checkout({ verifiedCheckoutEmail: "changed@example.com" }),
  );
  const otherEnvironmentKey = createPaidInstallerEmailOutboxKey(
    checkout({ environment: "production" }),
  );
  const otherSessionKey = createPaidInstallerEmailOutboxKey(
    checkout({ verifiedCheckoutSessionId: "cs_test_paid_456" }),
  );

  const firstProviderKey =
    createPaidInstallerProviderIdempotencyKey(firstKey);
  assert.equal(
    firstProviderKey,
    createPaidInstallerProviderIdempotencyKey(duplicateKey),
  );
  assert.notEqual(
    firstProviderKey,
    createPaidInstallerProviderIdempotencyKey(otherEnvironmentKey),
  );
  assert.notEqual(
    firstProviderKey,
    createPaidInstallerProviderIdempotencyKey(otherSessionKey),
  );
  assert.match(
    firstProviderKey,
    /^paid-installer-v1\/[0-9a-f]{64}$/,
  );
  assert.doesNotMatch(firstProviderKey, /cs_test_paid_123|buyer@example\.com/);
});

test("sends through Resend with only the hashed stable duplicate key", async () => {
  const job = createPaidInstallerEmailJob({
    checkout: checkout(),
    onboardingReceipt: RECEIPT,
  });
  let request;
  const result = await sendPaidInstallerEmail({
    job,
    environment: { RESEND_API_KEY: "resend-test-key" },
    fetchImpl: async (input, init) => {
      request = { input: String(input), init };
      return new Response(JSON.stringify({ id: "email-test-id" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.deepEqual(result, { emailId: "email-test-id" });
  assert.equal(request.input, "https://api.resend.com/emails");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers.Authorization, "Bearer resend-test-key");
  assert.equal(
    request.init.headers["Idempotency-Key"],
    job.providerIdempotencyKey,
  );
  assert.doesNotMatch(
    request.init.headers["Idempotency-Key"],
    /cs_test_paid_123|buyer@example\.com/,
  );
  const message = JSON.parse(request.init.body);
  assert.deepEqual(message.to, ["buyer@example.com"]);
  assert.equal(message.tags[0].value, PAID_INSTALLER_EMAIL_TYPE);
});

test("provider failures are bounded, classified, and redact the recipient", async () => {
  const recipient = "private-buyer@example.com";
  const job = createPaidInstallerEmailJob({
    checkout: checkout({ verifiedCheckoutEmail: recipient }),
    onboardingReceipt: RECEIPT,
  });

  await assert.rejects(
    sendPaidInstallerEmail({
      job,
      environment: { RESEND_API_KEY: "resend-test-key" },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: `provider leaked ${recipient}`,
            session: "cs_test_paid_123",
          }),
          { status: 429 },
        ),
    }),
    (error) => {
      assert.ok(error instanceof PaidInstallerEmailDeliveryError);
      assert.equal(error.providerStatus, 429);
      assert.equal(error.retryable, true);
      const operationalOutput = JSON.stringify({
        name: error.name,
        message: error.message,
        providerStatus: error.providerStatus,
        retryable: error.retryable,
      });
      assert.doesNotMatch(operationalOutput, new RegExp(recipient));
      assert.doesNotMatch(operationalOutput, /cs_test_paid_123/);
      assert.ok(Buffer.byteLength(error.message, "utf8") <= 160);
      return true;
    },
  );

  await assert.rejects(
    sendPaidInstallerEmail({
      job,
      environment: { RESEND_API_KEY: "resend-test-key" },
      fetchImpl: async () => {
        throw new Error(`network error for ${recipient}`);
      },
    }),
    (error) => {
      assert.ok(error instanceof PaidInstallerEmailDeliveryError);
      assert.equal(error.providerStatus, null);
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, new RegExp(recipient));
      return true;
    },
  );
});

test("non-retryable provider rejection is exposed without provider payload", async () => {
  const job = createPaidInstallerEmailJob({
    checkout: checkout(),
    onboardingReceipt: RECEIPT,
  });

  await assert.rejects(
    sendPaidInstallerEmail({
      job,
      environment: { RESEND_API_KEY: "resend-test-key" },
      fetchImpl: async () =>
        new Response("do not retain this provider detail", { status: 422 }),
    }),
    (error) => {
      assert.ok(error instanceof PaidInstallerEmailDeliveryError);
      assert.equal(error.providerStatus, 422);
      assert.equal(error.retryable, false);
      assert.doesNotMatch(error.message, /provider detail/);
      return true;
    },
  );
});

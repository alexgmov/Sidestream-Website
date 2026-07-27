import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";

const RESEND_SEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "Sidestream <downloads@alexg.mov>";
const DEFAULT_REPLY_TO = "alex@alexg.mov";
const EMAIL_SUBJECT = "Set up your Sidestream Pro purchase";
const REQUEST_TIMEOUT_MS = 8_000;
const RECEIPT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_]{1,255}$/;

export const PAID_INSTALLER_EMAIL_TYPE = "paid-installer-v1" as const;
export const PAID_INSTALLER_EMAIL_MAX_LEASE_MS = 5 * 60 * 1_000;
export const PAID_INSTALLER_EMAIL_STATES = Object.freeze([
  "pending",
  "sending",
  "accepted",
  "retryable",
  "dead_letter",
] as const);

export type PaidInstallerEnvironment = "test" | "production";
export type PaidInstallerEmailState =
  (typeof PAID_INSTALLER_EMAIL_STATES)[number];
export type RuntimeEnvironment = Readonly<
  Record<string, string | undefined>
>;

type ResendFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type VerifiedPaidCheckout = Readonly<{
  environment: PaidInstallerEnvironment;
  verifiedCheckoutSessionId: string;
  verifiedCheckoutEmail: string;
  paymentStatus: "paid";
}>;

export type PaidInstallerEmailOutboxKey = Readonly<{
  environment: PaidInstallerEnvironment;
  verifiedCheckoutSessionId: string;
  emailType: typeof PAID_INSTALLER_EMAIL_TYPE;
}>;

export type PaidInstallerEmailMessage = Readonly<{
  from: string;
  to: readonly string[];
  subject: string;
  html: string;
  text: string;
  reply_to: string;
  tags: readonly Readonly<{ name: string; value: string }>[];
}>;

export type PaidInstallerEmailJob = Readonly<{
  outboxKey: PaidInstallerEmailOutboxKey;
  providerIdempotencyKey: string;
  message: PaidInstallerEmailMessage;
}>;

export class PaidInstallerEmailConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaidInstallerEmailConfigurationError";
  }
}

export class PaidInstallerEmailDeliveryError extends Error {
  readonly providerStatus: number | null;
  readonly retryable: boolean;

  constructor(options: {
    message: string;
    providerStatus?: number | null;
    retryable: boolean;
  }) {
    super(options.message);
    this.name = "PaidInstallerEmailDeliveryError";
    this.providerStatus = options.providerStatus ?? null;
    this.retryable = options.retryable;
  }
}

export function createPaidInstallerEmailOutboxKey(
  checkout: VerifiedPaidCheckout,
): PaidInstallerEmailOutboxKey {
  assertVerifiedPaidCheckout(checkout);
  return Object.freeze({
    environment: checkout.environment,
    verifiedCheckoutSessionId: checkout.verifiedCheckoutSessionId,
    emailType: PAID_INSTALLER_EMAIL_TYPE,
  });
}

export function createPaidInstallerProviderIdempotencyKey(
  outboxKey: PaidInstallerEmailOutboxKey,
): string {
  assertEnvironment(outboxKey.environment);
  assertCheckoutSessionId(outboxKey.verifiedCheckoutSessionId);
  if (outboxKey.emailType !== PAID_INSTALLER_EMAIL_TYPE) {
    throw new PaidInstallerEmailConfigurationError(
      "Paid installer email type is invalid",
    );
  }
  const digest = createHash("sha256")
    .update(outboxKey.environment)
    .update("\0")
    .update(outboxKey.verifiedCheckoutSessionId)
    .update("\0")
    .update(outboxKey.emailType)
    .digest("hex");
  return `${PAID_INSTALLER_EMAIL_TYPE}/${digest}`;
}

export function createPaidInstallerEmailJob(options: {
  checkout: VerifiedPaidCheckout;
  onboardingReceipt: string;
  publicOrigin?: string;
  environment?: RuntimeEnvironment;
}): PaidInstallerEmailJob {
  const outboxKey = createPaidInstallerEmailOutboxKey(options.checkout);
  const recipient = readRecipient(options.checkout.verifiedCheckoutEmail);
  const receipt = readReceipt(options.onboardingReceipt);
  const publicOrigin = readPublicOrigin(
    options.publicOrigin || "https://sidestream.tv",
  );
  const environment = options.environment || process.env;
  const from = readMailbox(
    environment.SIDESTREAM_PAID_INSTALLER_EMAIL_FROM || DEFAULT_FROM,
    "SIDESTREAM_PAID_INSTALLER_EMAIL_FROM",
  );
  const replyTo = readMailbox(
    environment.SIDESTREAM_PAID_INSTALLER_EMAIL_REPLY_TO || DEFAULT_REPLY_TO,
    "SIDESTREAM_PAID_INSTALLER_EMAIL_REPLY_TO",
  );
  const macUrl = buildArtifactUrl(publicOrigin, receipt, "macos-universal");
  const windowsUrl = buildArtifactUrl(publicOrigin, receipt, "windows-x64");

  return Object.freeze({
    outboxKey,
    providerIdempotencyKey:
      createPaidInstallerProviderIdempotencyKey(outboxKey),
    message: Object.freeze({
      from,
      to: Object.freeze([recipient]),
      subject: EMAIL_SUBJECT,
      html: buildHtmlBody({ recipient, macUrl, windowsUrl }),
      text: buildTextBody({ recipient, macUrl, windowsUrl }),
      reply_to: replyTo,
      tags: Object.freeze([
        Object.freeze({
          name: "email_type",
          value: PAID_INSTALLER_EMAIL_TYPE,
        }),
      ]),
    }),
  });
}

export async function sendPaidInstallerEmail(options: {
  job: PaidInstallerEmailJob;
  environment?: RuntimeEnvironment;
  fetchImpl?: ResendFetch;
}): Promise<{ emailId: string }> {
  const environment = options.environment || process.env;
  const apiKey = environment.RESEND_API_KEY?.trim() || "";
  if (!apiKey) {
    throw new PaidInstallerEmailConfigurationError("Missing RESEND_API_KEY");
  }
  const expectedIdempotencyKey = createPaidInstallerProviderIdempotencyKey(
    options.job.outboxKey,
  );
  if (options.job.providerIdempotencyKey !== expectedIdempotencyKey) {
    throw new PaidInstallerEmailConfigurationError(
      "Paid installer email idempotency key is invalid",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (options.fetchImpl || fetch)(RESEND_SEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": options.job.providerIdempotencyKey,
      },
      body: JSON.stringify(options.job.message),
      signal: controller.signal,
    });
  } catch {
    throw new PaidInstallerEmailDeliveryError({
      message: "Email provider request failed",
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new PaidInstallerEmailDeliveryError({
      message: "Email provider rejected the request",
      providerStatus: response.status,
      retryable: isRetryableProviderStatus(response.status),
    });
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new PaidInstallerEmailDeliveryError({
      message: "Email provider returned an invalid response",
      providerStatus: response.status,
      retryable: true,
    });
  }
  const emailId = readEmailId(result);
  if (!emailId) {
    throw new PaidInstallerEmailDeliveryError({
      message: "Email provider response did not include an email ID",
      providerStatus: response.status,
      retryable: true,
    });
  }
  return { emailId };
}

function buildArtifactUrl(
  publicOrigin: string,
  receipt: string,
  platform: "macos-universal" | "windows-x64",
) {
  const url = new URL("/api/paid-acquisition/artifact", publicOrigin);
  url.searchParams.set("receipt", receipt);
  url.searchParams.set("platform", platform);
  return url.toString();
}

function buildHtmlBody(options: {
  recipient: string;
  macUrl: string;
  windowsUrl: string;
}) {
  const recipient = escapeHtml(options.recipient);
  const macUrl = escapeHtml(options.macUrl);
  const windowsUrl = escapeHtml(options.windowsUrl);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      .platform-link:hover { background:#ff2a2a !important; border-color:#ff2a2a !important; color:#ffffff !important; }
      @media screen and (max-width:520px) {
        .email-card { padding:24px !important; }
        .platform-panel { padding:16px !important; }
        .platform-cell { display:block !important; width:100% !important; padding-right:0 !important; padding-left:0 !important; }
        .platform-cell + .platform-cell { padding-top:12px !important; }
      }
    </style>
  </head>
  <body style="margin:0;background:#f4f4f5;color:#111827;font-family:Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Choose Mac or Windows, then sign in with your Checkout email.</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f5;padding:32px 16px;">
      <tr>
        <td align="center">
          <table class="email-card" role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e4e4e7;border-radius:18px;padding:36px;">
            <tr><td style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#71717a;">Sidestream</td></tr>
            <tr><td style="padding-top:14px;font-size:28px;font-weight:700;line-height:1.15;">Set up Sidestream</td></tr>
            <tr><td style="padding-top:12px;font-size:16px;line-height:1.55;color:#52525b;">Thanks for your purchase. Choose the paid-onboarding installer for the computer where you want to use Sidestream.</td></tr>
            <tr>
              <td style="padding-top:26px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#171717" style="background:#171717;border-radius:20px;">
                  <tr>
                    <td class="platform-panel" style="padding:20px;">
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                        <tr>
                          <td class="platform-cell" width="50%" style="padding-right:6px;">
                            <a class="platform-link" href="${macUrl}" aria-label="Set up Sidestream on Mac" style="display:block;padding:15px 16px;border:1px solid #ffffff;border-radius:999px;background:#ffffff;color:#000000;text-align:center;text-decoration:none;font-size:15px;font-weight:700;line-height:1.35;white-space:nowrap;">Set up on Mac</a>
                          </td>
                          <td class="platform-cell" width="50%" style="padding-left:6px;">
                            <a class="platform-link" href="${windowsUrl}" aria-label="Set up Sidestream on Windows" style="display:block;padding:15px 16px;border:1px solid #ffffff;border-radius:999px;background:#ffffff;color:#000000;text-align:center;text-decoration:none;font-size:15px;font-weight:700;line-height:1.35;white-space:nowrap;">Set up on Windows</a>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr><td style="padding-top:24px;font-size:16px;font-weight:700;line-height:1.45;color:#27272a;">Sign in with the same Google email used at Checkout</td></tr>
            <tr><td style="padding-top:8px;font-size:15px;line-height:1.55;color:#52525b;">After installation, open Sidestream and choose Sign in with Google. Use <strong>${recipient}</strong>, the email used for this Checkout.</td></tr>
            <tr><td style="padding-top:12px;font-size:15px;line-height:1.55;color:#52525b;">If Google opens a different account, sign out and retry with the Checkout email. If you cannot access that address or the emails still do not match, reply to this message for support recovery. Do not purchase again.</td></tr>
            <tr><td style="padding-top:16px;font-size:13px;line-height:1.55;color:#71717a;">The installer does not grant Pro access. Sidestream enables Pro only after the server verifies the payment and the matching Google sign-in. A later refund or dispute may remove paid access.</td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildTextBody(options: {
  recipient: string;
  macUrl: string;
  windowsUrl: string;
}) {
  return `Set up your Sidestream purchase

Thanks for your purchase. Choose the paid-onboarding installer for the computer where you want to use Sidestream.

Set up on Mac:
${options.macUrl}

Set up on Windows:
${options.windowsUrl}

SIGN IN WITH THE SAME GOOGLE EMAIL USED AT CHECKOUT

After installation, open Sidestream and choose Sign in with Google. Use ${options.recipient}, the email used for this Checkout.

If Google opens a different account, sign out and retry with the Checkout email. If you cannot access that address or the emails still do not match, reply to this message for support recovery. Do not purchase again.

The installer does not grant Pro access. Sidestream enables Pro only after the server verifies the payment and the matching Google sign-in. A later refund or dispute may remove paid access.`;
}

function assertVerifiedPaidCheckout(checkout: VerifiedPaidCheckout) {
  if (!checkout || checkout.paymentStatus !== "paid") {
    throw new PaidInstallerEmailConfigurationError(
      "Verified paid Checkout is required",
    );
  }
  assertEnvironment(checkout.environment);
  assertCheckoutSessionId(checkout.verifiedCheckoutSessionId);
  readRecipient(checkout.verifiedCheckoutEmail);
}

function assertEnvironment(
  environment: string,
): asserts environment is PaidInstallerEnvironment {
  if (environment !== "test" && environment !== "production") {
    throw new PaidInstallerEmailConfigurationError(
      "Paid installer environment is invalid",
    );
  }
}

function assertCheckoutSessionId(sessionId: string) {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new PaidInstallerEmailConfigurationError(
      "Verified Checkout Session ID is invalid",
    );
  }
}

function readRecipient(value: string) {
  const candidate = value
    .replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "")
    .normalize("NFC");
  const separator = candidate.lastIndexOf("@");
  if (
    separator <= 0 ||
    separator !== candidate.indexOf("@") ||
    separator === candidate.length - 1
  ) {
    throw new PaidInstallerEmailConfigurationError(
      "Verified Checkout email is invalid",
    );
  }
  const localPart = candidate.slice(0, separator).toLowerCase();
  const domain = domainToASCII(candidate.slice(separator + 1)).toLowerCase();
  const recipient = `${localPart}@${domain}`;
  if (
    !domain ||
    Buffer.byteLength(recipient, "utf8") > 254 ||
    /[\u0000-\u001f\u007f\s<>]/u.test(recipient) ||
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..") ||
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    domain.includes("..") ||
    !domain.includes(".")
  ) {
    throw new PaidInstallerEmailConfigurationError(
      "Verified Checkout email is invalid",
    );
  }
  return recipient;
}

function readReceipt(value: string) {
  if (!RECEIPT_PATTERN.test(value)) {
    throw new PaidInstallerEmailConfigurationError(
      "Paid onboarding receipt is invalid",
    );
  }
  return value;
}

function readPublicOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PaidInstallerEmailConfigurationError(
      "Paid onboarding public origin is invalid",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new PaidInstallerEmailConfigurationError(
      "Paid onboarding public origin is invalid",
    );
  }
  return url.origin;
}

function readMailbox(value: string, label: string) {
  const mailbox = value.trim();
  if (!mailbox || mailbox.length > 400 || /[\r\n]/.test(mailbox)) {
    throw new PaidInstallerEmailConfigurationError(`${label} is invalid`);
  }
  return mailbox;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isRetryableProviderStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function readEmailId(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 && id.length <= 200 ? id : "";
}

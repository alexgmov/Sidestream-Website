import type { SupportRuntimeConfig } from "./support-config.js";

const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const MAX_SUBJECT_CHARACTERS = 500;
const MAX_BODY_CHARACTERS = 50_000;

type SupportFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type ReceivedSupportEmail = Readonly<{
  providerMessageId: string;
  requesterEmail: string;
  recipients: readonly string[];
  subject: string;
  body: string;
  attachmentCount: number;
  htmlOnly: boolean;
}>;

export async function retrieveReceivedSupportEmail(options: {
  emailId: string;
  config: SupportRuntimeConfig;
  fetchImpl?: SupportFetch;
}): Promise<ReceivedSupportEmail> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(options.emailId)) {
    throw new TypeError("Received email ID is invalid");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  let response: Response;
  try {
    response = await (options.fetchImpl || fetch)(
      `https://api.resend.com/emails/receiving/${encodeURIComponent(options.emailId)}`,
      {
        headers: { Authorization: `Bearer ${options.config.resendApiKey}` },
        signal: controller.signal,
      },
    );
  } catch {
    throw new Error("Received support email retrieval failed");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`Received support email retrieval was rejected (${response.status})`);
  const raw = await response.text();
  if (Buffer.byteLength(raw) > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error("Received support email metadata is too large");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("Received support email response is invalid");
  }
  return normalizeReceivedSupportEmail(payload);
}

export function normalizeReceivedSupportEmail(input: unknown): ReceivedSupportEmail {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Received support email is invalid");
  }
  const object = input as Record<string, unknown>;
  const providerMessageId = boundedString(object.id, "received email ID", 1, 200);
  const requesterEmail = extractMailbox(boundedString(object.from, "sender", 3, 500));
  if (!Array.isArray(object.to) || object.to.length < 1 || object.to.length > 50) {
    throw new TypeError("Received email recipients are invalid");
  }
  const recipients = Object.freeze(object.to.map((recipient) =>
    extractMailbox(boundedString(recipient, "recipient", 3, 500)).toLowerCase()
  ));
  const subject = typeof object.subject === "string"
    ? object.subject.trim().slice(0, MAX_SUBJECT_CHARACTERS)
    : "(no subject)";
  const text = typeof object.text === "string" ? object.text.trim() : "";
  const htmlOnly = !text && typeof object.html === "string" && object.html.trim().length > 0;
  const body = text
    ? text.slice(0, MAX_BODY_CHARACTERS)
    : htmlOnly
      ? "[HTML-only support message withheld from automation]"
      : "[Empty support message]";
  const attachmentCount = Array.isArray(object.attachments)
    ? Math.min(object.attachments.length, 100)
    : 0;
  return Object.freeze({
    providerMessageId,
    requesterEmail,
    recipients,
    subject: subject || "(no subject)",
    body,
    attachmentCount,
    htmlOnly,
  });
}

function extractMailbox(value: string) {
  const bracketed = value.match(/<([^<>]+)>\s*$/);
  const mailbox = (bracketed?.[1] || value).trim();
  if (
    mailbox.length > 320 ||
    !/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,63}$/i.test(mailbox)
  ) {
    throw new TypeError("Email mailbox is invalid");
  }
  return mailbox.toLowerCase();
}

function boundedString(value: unknown, name: string, minimum: number, maximum: number) {
  if (typeof value !== "string") throw new TypeError(`${name} is invalid`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

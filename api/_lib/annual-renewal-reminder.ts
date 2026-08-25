import { createHash } from "node:crypto";
import {
  queryPostgres,
  withPostgresTransaction,
} from "./postgres.js";

const RESEND_SEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "Sidestream <downloads@alexg.mov>";
const DEFAULT_REPLY_TO = "alex@alexg.mov";
const DEFAULT_PUBLIC_ORIGIN = "https://sidestream.tv";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_BATCH_SIZE = 25;
const MAX_ATTEMPTS = 5;
const EMAIL_TYPE = "annual-renewal-reminder-v1";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
type ResendFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type ReminderRow = Readonly<{
  id: string;
  email: string;
  stripe_subscription_id: string;
  renewal_at: Date | string;
  attempt_count: number;
}>;

export type AnnualRenewalReminderSummary = Readonly<{
  outcome: "completed";
  staged: number;
  canceled: number;
  accepted: number;
  retryable: number;
  deadLetter: number;
}>;

export class AnnualRenewalReminderDeliveryError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "AnnualRenewalReminderDeliveryError";
    this.retryable = retryable;
  }
}

export function createAnnualRenewalReminderIdempotencyKey(options: {
  stripeSubscriptionId: string;
  renewalAt: string | Date;
}) {
  const subscriptionId = cleanRequired(options.stripeSubscriptionId, 255);
  const renewalAt = new Date(options.renewalAt);
  if (!Number.isFinite(renewalAt.getTime())) {
    throw new TypeError("Annual renewal reminder requires a renewal time");
  }
  const digest = createHash("sha256")
    .update(subscriptionId)
    .update("\0")
    .update(renewalAt.toISOString())
    .update("\0")
    .update(EMAIL_TYPE)
    .digest("hex");
  return `${EMAIL_TYPE}/${digest}`;
}

export function createAnnualRenewalReminderMessage(options: {
  email: string;
  renewalAt: string | Date;
  publicOrigin?: string;
  environment?: RuntimeEnvironment;
}) {
  const environment = options.environment || process.env;
  const email = cleanRequired(options.email, 320).toLowerCase();
  if (!email.includes("@") || /[\r\n]/.test(email)) {
    throw new TypeError("Annual renewal reminder recipient is invalid");
  }
  const renewalAt = new Date(options.renewalAt);
  if (!Number.isFinite(renewalAt.getTime())) {
    throw new TypeError("Annual renewal reminder requires a renewal time");
  }
  const origin = new URL(options.publicOrigin || DEFAULT_PUBLIC_ORIGIN);
  if (origin.protocol !== "https:") {
    throw new TypeError("Annual renewal reminder origin must use HTTPS");
  }
  const accountUrl = new URL("/account.html", origin).toString();
  const renewalDate = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(renewalAt);
  const from = cleanMailbox(
    environment.SIDESTREAM_ANNUAL_RENEWAL_EMAIL_FROM || DEFAULT_FROM,
  );
  const replyTo = cleanMailbox(
    environment.SIDESTREAM_ANNUAL_RENEWAL_EMAIL_REPLY_TO || DEFAULT_REPLY_TO,
  );
  const text = [
    "Your Sidestream Unlimited annual plan renews soon",
    "",
    `This is the advance reminder we promised: your Sidestream Unlimited annual plan will renew for $19.99 on ${renewalDate}.`,
    "",
    "You can cancel anytime from your Sidestream account. If you cancel before the renewal date, you will not be charged again, and your access will continue through your already-paid year.",
    "",
    `Manage or cancel your plan: ${accountUrl}`,
    "",
    "Questions? Reply to this email.",
  ].join("\n");
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f5f5f2;color:#181816;font-family:Arial,sans-serif;">
    <div style="max-width:600px;margin:0 auto;padding:32px 18px;">
      <div style="background:#ffffff;border:1px solid #deded8;border-radius:16px;padding:28px;">
        <p style="margin:0 0 10px;color:#ff2a2a;font-weight:700;">SIDESTREAM</p>
        <h1 style="margin:0 0 18px;font-size:26px;line-height:1.2;">Your annual plan renews soon</h1>
        <p style="margin:0 0 16px;line-height:1.6;">This is the advance reminder we promised: your Sidestream Unlimited annual plan will renew for <strong>$19.99 on ${escapeHtml(renewalDate)}</strong>.</p>
        <p style="margin:0 0 22px;line-height:1.6;">You can cancel anytime. If you cancel before the renewal date, you will not be charged again, and your access will continue through your already-paid year.</p>
        <a href="${escapeHtml(accountUrl)}" style="display:inline-block;background:#181816;color:#ffffff;text-decoration:none;font-weight:700;padding:13px 18px;border-radius:10px;">Manage or cancel your plan</a>
        <p style="margin:22px 0 0;color:#66665f;font-size:14px;line-height:1.5;">Questions? Reply to this email.</p>
      </div>
    </div>
  </body>
</html>`;
  return Object.freeze({
    from,
    to: Object.freeze([email]),
    subject: `Reminder: Sidestream will renew for $19.99 on ${renewalDate}`,
    html,
    text,
    reply_to: replyTo,
    tags: Object.freeze([
      Object.freeze({ name: "email_type", value: EMAIL_TYPE }),
    ]),
  });
}

export async function sendAnnualRenewalReminder(options: {
  row: ReminderRow;
  environment?: RuntimeEnvironment;
  fetchImpl?: ResendFetch;
  publicOrigin?: string;
}) {
  const environment = options.environment || process.env;
  const apiKey = environment.RESEND_API_KEY?.trim() || "";
  if (!apiKey) {
    throw new AnnualRenewalReminderDeliveryError("Missing RESEND_API_KEY", false);
  }
  const message = createAnnualRenewalReminderMessage({
    email: options.row.email,
    renewalAt: options.row.renewal_at,
    publicOrigin: options.publicOrigin,
    environment,
  });
  const idempotencyKey = createAnnualRenewalReminderIdempotencyKey({
    stripeSubscriptionId: options.row.stripe_subscription_id,
    renewalAt: options.row.renewal_at,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (options.fetchImpl || fetch)(RESEND_SEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(message),
      signal: controller.signal,
    });
  } catch {
    throw new AnnualRenewalReminderDeliveryError(
      "Annual renewal reminder provider request failed",
      true,
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new AnnualRenewalReminderDeliveryError(
      "Annual renewal reminder provider rejected the request",
      response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
    );
  }
  const payload = await response.json().catch(() => null) as { id?: unknown } | null;
  const emailId = typeof payload?.id === "string" ? payload.id.trim() : "";
  if (!emailId || emailId.length > 200) {
    throw new AnnualRenewalReminderDeliveryError(
      "Annual renewal reminder provider response was invalid",
      true,
    );
  }
  return { emailId };
}

export async function runAnnualRenewalReminders(options: {
  batchSize?: number;
  environment?: RuntimeEnvironment;
  fetchImpl?: ResendFetch;
  publicOrigin?: string;
} = {}): Promise<AnnualRenewalReminderSummary> {
  const batchSize = Number.isSafeInteger(options.batchSize)
    ? Math.min(MAX_BATCH_SIZE, Math.max(1, options.batchSize!))
    : MAX_BATCH_SIZE;
  const stagedResult = await queryPostgres(
    `
      insert into public.sidestream_annual_renewal_reminders (
        account_id, license_id, checkout_intent_id,
        stripe_subscription_id, renewal_at
      )
      select account.id, license.id, intent.id,
        license.stripe_subscription_id, license.current_period_end
      from public.sidestream_licenses license
      join public.sidestream_accounts account on account.id = license.account_id
      join public.sidestream_checkout_intents intent
        on intent.stripe_checkout_session_id = license.stripe_checkout_session_id
      where intent.upgrade_pricing_snapshot_version = 2
        and intent.upgrade_pricing_experiment_id = 'upgrade-pricing-v2'
        and intent.upgrade_pricing_variant = 'annual_same_price'
        and intent.upgrade_pricing_billing_model = 'subscription'
        and license.stripe_subscription_id is not null
        and license.entitlement_status = 'active'
        and license.status in ('active', 'trialing')
        and license.cancel_at_period_end is false
        and license.current_period_end > now() + interval '7 days'
        and license.current_period_end <= now() + interval '30 days'
      on conflict (stripe_subscription_id, renewal_at) do nothing
    `,
  );
  const canceledResult = await queryPostgres(
    `
      update public.sidestream_annual_renewal_reminders reminder
      set email_job_state = 'canceled',
          lease_expires_at = null,
          last_error_code = 'renewal_canceled',
          updated_at = now()
      from public.sidestream_licenses license
      where license.id = reminder.license_id
        and reminder.email_job_state in ('pending', 'retryable')
        and (
          license.cancel_at_period_end is true
          or license.entitlement_status <> 'active'
          or license.status not in ('active', 'trialing')
          or license.current_period_end is distinct from reminder.renewal_at
        )
    `,
  );
  await queryPostgres(
    `
      update public.sidestream_annual_renewal_reminders
      set email_job_state = 'retryable',
          lease_expires_at = null,
          next_attempt_at = now(),
          last_error_code = 'lease_expired',
          updated_at = now()
      where email_job_state = 'sending'
        and lease_expires_at <= now()
    `,
  );

  let accepted = 0;
  let retryable = 0;
  let deadLetter = 0;
  for (let index = 0; index < batchSize; index += 1) {
    const row = await claimAnnualRenewalReminder();
    if (!row) break;
    try {
      const sent = await sendAnnualRenewalReminder({
        row,
        environment: options.environment,
        fetchImpl: options.fetchImpl,
        publicOrigin: options.publicOrigin,
      });
      await queryPostgres(
        `
          update public.sidestream_annual_renewal_reminders
          set email_job_state = 'accepted',
              provider_message_ref = $2,
              accepted_at = now(),
              lease_expires_at = null,
              last_error_code = null,
              updated_at = now()
          where id = $1::uuid and email_job_state = 'sending'
        `,
        [row.id, sent.emailId],
      );
      accepted += 1;
    } catch (error) {
      const canRetry = error instanceof AnnualRenewalReminderDeliveryError &&
        error.retryable && row.attempt_count < MAX_ATTEMPTS;
      await queryPostgres(
        `
          update public.sidestream_annual_renewal_reminders
          set email_job_state = case when $2 then 'retryable' else 'dead_letter' end,
              lease_expires_at = null,
              next_attempt_at = case
                when $2 then now() + interval '15 minutes'
                else next_attempt_at
              end,
              last_error_code = case
                when $2 then 'provider_retryable'
                else 'provider_rejected'
              end,
              updated_at = now()
          where id = $1::uuid and email_job_state = 'sending'
        `,
        [row.id, canRetry],
      );
      if (canRetry) retryable += 1;
      else deadLetter += 1;
    }
  }

  return Object.freeze({
    outcome: "completed",
    staged: stagedResult.rowCount || 0,
    canceled: canceledResult.rowCount || 0,
    accepted,
    retryable,
    deadLetter,
  });
}

async function claimAnnualRenewalReminder(): Promise<ReminderRow | null> {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<ReminderRow>(
      `
        with candidate as (
          select reminder.id
          from public.sidestream_annual_renewal_reminders reminder
          join public.sidestream_licenses license on license.id = reminder.license_id
          where reminder.email_job_state in ('pending', 'retryable')
            and reminder.next_attempt_at <= now()
            and (reminder.lease_expires_at is null or reminder.lease_expires_at <= now())
            and license.entitlement_status = 'active'
            and license.status in ('active', 'trialing')
            and license.cancel_at_period_end is false
            and license.current_period_end = reminder.renewal_at
          order by reminder.renewal_at asc, reminder.created_at asc
          limit 1
          for update of reminder skip locked
        )
        update public.sidestream_annual_renewal_reminders reminder
        set email_job_state = 'sending',
            attempt_count = attempt_count + 1,
            lease_expires_at = now() + interval '5 minutes',
            updated_at = now()
        from candidate, public.sidestream_accounts account
        where reminder.id = candidate.id
          and account.id = reminder.account_id
        returning reminder.id, account.email,
          reminder.stripe_subscription_id, reminder.renewal_at,
          reminder.attempt_count
      `,
    );
    return result.rows[0] || null;
  });
}

function cleanRequired(value: unknown, maxLength: number) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength || /[\r\n]/.test(normalized)) {
    throw new TypeError("Annual renewal reminder value is invalid");
  }
  return normalized;
}

function cleanMailbox(value: unknown) {
  const mailbox = cleanRequired(value, 320);
  if (!mailbox.includes("@")) {
    throw new TypeError("Annual renewal reminder mailbox is invalid");
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

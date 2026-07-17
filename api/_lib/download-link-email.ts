const RESEND_SEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "Sidestream <downloads@alexg.mov>";
const DEFAULT_REPLY_TO = "alex@alexg.mov";
const EMAIL_SUBJECT = "Your Sidestream download links";
const WINDOWS_DOWNLOAD_MARK_CID = "sidestream-windows-mark";
const WINDOWS_DOWNLOAD_MARK_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAMKADAAQAAAABAAAAMAAAAADbN2wMAAABk0lEQVRoBe1ZbUoEMQxdRVBcVBBFWfzh519B9AqeQO+y6B09gycRTcZ5bLqkQ7AN7WIGQpJO5vXlZVjK7GwWVygQCmy0Alsdsz8jbnfC3jWurRs4JVK3gqQkfLBGWOW6s1bkkR5nCDLZo9IN1a7+ALpNz1yQ3Qh7G3G+R1/qVK7qYmanXVq/JOORS6IcX5HxfXkB27WBqVdoSWwkWVaYle7qgkoaqVLlgF2KA27AQz747hRN2BmSaMAgkmtJTMBVXgN4TMAgkmtJTMBVXgN4TMAgkmvJ1GHuqdLOtXAq0ekMRj3hjRwfC7l+VMIBDeAhH/xUA6XHYGCX4oAw8JAPPn6FEjkaJDGBBqInW8YEEjkaJDGBBqInW8YEEjkaJBs/ganj9DMJKr+N4oPuvIHQ2S3VA1K2+vfGOTk0A49GT8SzwHY9zIn9qoSHhPJA9irQPin+IuNGSkxArkKotFrxifi/g2sy+RcSYv5sb+Gh1qiLPj1kUffoDr+CaEj6hXiqB66Cji3cp7J7shdbeVSFAv9PgR8iECaXQfGmRwAAAABJRU5ErkJggg==";

export const MAC_DOWNLOAD_URL =
  "https://sidestream.tv/api/download?utm_source=mobile_handoff&utm_medium=email&utm_campaign=mobile_download_link&utm_content=mac";
export const WINDOWS_DOWNLOAD_URL =
  "https://sidestream.tv/api/download?platform=win32-x64&utm_source=mobile_handoff&utm_medium=email&utm_campaign=mobile_download_link&utm_content=windows";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

type ResendFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type DownloadLinkEmailMessage = Readonly<{
  from: string;
  to: readonly string[];
  subject: string;
  html: string;
  text: string;
  reply_to: string;
  attachments: readonly Readonly<{
    content: string;
    filename: string;
    content_id: string;
    content_type: string;
  }>[];
  tags: readonly Readonly<{ name: string; value: string }>[];
}>;

export class DownloadLinkEmailConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadLinkEmailConfigurationError";
  }
}

export class DownloadLinkEmailDeliveryError extends Error {
  readonly providerStatus: number | null;

  constructor(message: string, providerStatus: number | null = null) {
    super(message);
    this.name = "DownloadLinkEmailDeliveryError";
    this.providerStatus = providerStatus;
  }
}

export function buildDownloadLinkEmail(
  recipient: string,
  environment: RuntimeEnvironment = process.env,
): DownloadLinkEmailMessage {
  const from = readMailbox(
    environment.SIDESTREAM_DOWNLOAD_EMAIL_FROM || DEFAULT_FROM,
    "SIDESTREAM_DOWNLOAD_EMAIL_FROM",
  );
  const replyTo = readMailbox(
    environment.SIDESTREAM_DOWNLOAD_EMAIL_REPLY_TO || DEFAULT_REPLY_TO,
    "SIDESTREAM_DOWNLOAD_EMAIL_REPLY_TO",
  );

  return Object.freeze({
    from,
    to: Object.freeze([recipient]),
    subject: EMAIL_SUBJECT,
    html: buildHtmlBody(),
    text: buildTextBody(),
    reply_to: replyTo,
    attachments: Object.freeze([
      Object.freeze({
        content: WINDOWS_DOWNLOAD_MARK_PNG,
        filename: "sidestream-windows-mark.png",
        content_id: WINDOWS_DOWNLOAD_MARK_CID,
        content_type: "image/png",
      }),
    ]),
    tags: Object.freeze([
      Object.freeze({ name: "email_type", value: "mobile_download_handoff" }),
    ]),
  });
}

export async function sendDownloadLinkEmail(options: {
  recipient: string;
  idempotencyKeyHash: string;
  environment?: RuntimeEnvironment;
  fetchImpl?: ResendFetch;
}): Promise<{ emailId: string }> {
  const environment = options.environment || process.env;
  const apiKey = environment.RESEND_API_KEY?.trim() || "";
  if (!apiKey) {
    throw new DownloadLinkEmailConfigurationError("Missing RESEND_API_KEY");
  }
  if (!/^[0-9a-f]{64}$/.test(options.idempotencyKeyHash)) {
    throw new DownloadLinkEmailConfigurationError("Email idempotency hash is invalid");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  let response: Response;
  try {
    response = await (options.fetchImpl || fetch)(RESEND_SEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `mobile-download-links/${options.idempotencyKeyHash}`,
      },
      body: JSON.stringify(buildDownloadLinkEmail(options.recipient, environment)),
      signal: controller.signal,
    });
  } catch {
    throw new DownloadLinkEmailDeliveryError("Resend request failed");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new DownloadLinkEmailDeliveryError(
      "Resend rejected the email",
      response.status,
    );
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new DownloadLinkEmailDeliveryError(
      "Resend returned an invalid response",
      response.status,
    );
  }
  const emailId = readEmailId(result);
  if (!emailId) {
    throw new DownloadLinkEmailDeliveryError(
      "Resend response did not include an email ID",
      response.status,
    );
  }
  return { emailId };
}

function buildHtmlBody() {
  const macUrl = MAC_DOWNLOAD_URL.replaceAll("&", "&amp;");
  const windowsUrl = WINDOWS_DOWNLOAD_URL.replaceAll("&", "&amp;");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      .download-link:hover { background:#ff2a2a !important; border-color:#ff2a2a !important; color:#ffffff !important; }
      .download-link:hover .windows-mark { filter:invert(1); }
      @media screen and (max-width:520px) {
        .email-card { padding:24px !important; }
        .download-panel { padding:16px !important; }
        .download-cell { display:block !important; width:100% !important; padding-right:0 !important; padding-left:0 !important; }
        .download-cell + .download-cell { padding-top:12px !important; }
        .download-link { font-size:14px !important; }
      }
    </style>
  </head>
  <body style="margin:0;background:#f4f4f5;color:#111827;font-family:Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Download Sidestream for Mac or Windows.</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f5;padding:32px 16px;">
      <tr>
        <td align="center">
          <table class="email-card" role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e4e4e7;border-radius:18px;padding:36px;">
            <tr><td style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#71717a;">Sidestream</td></tr>
            <tr><td style="padding-top:14px;font-size:28px;font-weight:700;line-height:1.15;">Your download links</td></tr>
            <tr><td style="padding-top:12px;font-size:16px;line-height:1.55;color:#52525b;">You asked us to send Sidestream to your computer. Choose the installer you need.</td></tr>
            <tr>
              <td style="padding-top:26px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#171717" style="background:#171717;border-radius:20px;">
                  <tr>
                    <td class="download-panel" style="padding:20px;">
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                        <tr>
                          <td class="download-cell" width="50%" style="padding-right:6px;">
                            <a class="download-link" href="${macUrl}" aria-label="Download Sidestream for Mac" style="display:block;padding:15px 16px;border:1px solid #ffffff;border-radius:999px;background:#ffffff;color:#000000;text-align:center;text-decoration:none;font-size:15px;font-weight:700;line-height:1.35;white-space:nowrap;"><span aria-hidden="true" style="display:inline-block;margin-right:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI Symbol',sans-serif;font-size:17px;line-height:1;vertical-align:-1px;">&#63743;</span>Download for Mac</a>
                          </td>
                          <td class="download-cell" width="50%" style="padding-left:6px;">
                            <a class="download-link" href="${windowsUrl}" aria-label="Download Sidestream for Windows" style="display:block;padding:15px 16px;border:1px solid #ffffff;border-radius:999px;background:#ffffff;color:#000000;text-align:center;text-decoration:none;font-size:15px;font-weight:700;line-height:1.35;white-space:nowrap;"><img class="windows-mark" src="cid:${WINDOWS_DOWNLOAD_MARK_CID}" width="15" height="15" alt="" style="display:inline-block;width:15px;height:15px;margin-right:8px;vertical-align:-2px;border:0;">Download for Windows</a>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr><td style="padding-top:26px;font-size:13px;line-height:1.5;color:#71717a;">You received this one-time email because someone entered this address on sidestream.tv.</td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildTextBody() {
  return `Your Sidestream download links

You asked us to send Sidestream to your computer. Choose the installer you need.

Download for Mac:
${MAC_DOWNLOAD_URL}

Download for Windows:
${WINDOWS_DOWNLOAD_URL}

You received this one-time email because someone entered this address on sidestream.tv.`;
}

function readMailbox(value: string, label: string) {
  const mailbox = value.trim();
  if (!mailbox || mailbox.length > 400 || /[\r\n]/.test(mailbox)) {
    throw new DownloadLinkEmailConfigurationError(`${label} is invalid`);
  }
  return mailbox;
}

function readEmailId(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 && id.length <= 200 ? id : "";
}

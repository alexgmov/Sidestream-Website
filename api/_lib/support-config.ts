type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type SupportRuntimeConfig = Readonly<{
  enabled: true;
  inboundAddress: string;
  alertAddress: string;
  emailFrom: string;
  resendApiKey: string;
  resendWebhookSecret: string;
  openAiApiKey: string;
  triageModel: string;
  auditModel: string;
  dataSecret: string;
  adminSecret: string;
}>;

export class SupportConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupportConfigurationError";
  }
}

export function isSupportAutomationEnabled(
  environment: RuntimeEnvironment = process.env,
) {
  return environment.SIDESTREAM_SUPPORT_ENABLED?.trim() === "1";
}

export function loadSupportRuntimeConfig(
  environment: RuntimeEnvironment = process.env,
): SupportRuntimeConfig {
  if (!isSupportAutomationEnabled(environment)) {
    throw new SupportConfigurationError("Support automation is disabled");
  }

  const inboundAddress = readMailbox(
    environment.SIDESTREAM_SUPPORT_INBOUND_ADDRESS || "support@sidestream.tv",
    "SIDESTREAM_SUPPORT_INBOUND_ADDRESS",
  ).toLowerCase();
  const alertAddress = readMailbox(
    required(environment, "SIDESTREAM_SUPPORT_ALERT_EMAIL", 3, 320),
    "SIDESTREAM_SUPPORT_ALERT_EMAIL",
  ).toLowerCase();
  const emailFrom = readMailboxWithOptionalName(
    environment.SIDESTREAM_SUPPORT_EMAIL_FROM ||
      "Sidestream Support Safety <support@sidestream.tv>",
    "SIDESTREAM_SUPPORT_EMAIL_FROM",
  );

  return Object.freeze({
    enabled: true,
    inboundAddress,
    alertAddress,
    emailFrom,
    resendApiKey: required(environment, "RESEND_API_KEY", 16, 512),
    resendWebhookSecret: required(
      environment,
      "SIDESTREAM_SUPPORT_RESEND_WEBHOOK_SECRET",
      16,
      512,
    ),
    openAiApiKey: required(environment, "OPENAI_API_KEY", 16, 512),
    triageModel: boundedModel(
      environment.SIDESTREAM_SUPPORT_TRIAGE_MODEL || "gpt-5-mini",
      "SIDESTREAM_SUPPORT_TRIAGE_MODEL",
    ),
    auditModel: boundedModel(
      environment.SIDESTREAM_SUPPORT_AUDIT_MODEL || "gpt-5-mini",
      "SIDESTREAM_SUPPORT_AUDIT_MODEL",
    ),
    dataSecret: required(environment, "SIDESTREAM_SUPPORT_DATA_SECRET", 32, 512),
    adminSecret: required(environment, "SIDESTREAM_SUPPORT_ADMIN_SECRET", 32, 512),
  });
}

function required(
  environment: RuntimeEnvironment,
  name: string,
  minimumLength: number,
  maximumLength: number,
) {
  const value = environment[name]?.trim() || "";
  if (
    value.length < minimumLength ||
    value.length > maximumLength ||
    !/^[\x20-\x7e]+$/.test(value)
  ) {
    throw new SupportConfigurationError(`${name} is not configured`);
  }
  return value;
}

function readMailbox(value: string, name: string) {
  const normalized = value.trim();
  if (
    normalized.length > 320 ||
    !/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,63}$/i.test(normalized)
  ) {
    throw new SupportConfigurationError(`${name} is invalid`);
  }
  return normalized;
}

function readMailboxWithOptionalName(value: string, name: string) {
  const normalized = value.trim();
  const bracketed = normalized.match(/^.{1,120}\s<([^<>]+)>$/);
  readMailbox(bracketed?.[1] || normalized, name);
  return normalized;
}

function boundedModel(value: string, name: string) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(normalized)) {
    throw new SupportConfigurationError(`${name} is invalid`);
  }
  return normalized;
}

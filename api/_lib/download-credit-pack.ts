export const DOWNLOAD_CREDIT_PACK_KEY = "standard";

export type DownloadCreditPack = Readonly<{
  key: typeof DOWNLOAD_CREDIT_PACK_KEY;
  credits: number;
  label: string;
  priceId: string;
}>;

export function isDownloadCreditServiceEnabled(
  environment: Readonly<Record<string, unknown>> = process.env,
) {
  return environment.SIDESTREAM_DOWNLOAD_CREDITS_ENABLED === "1";
}

export function getConfiguredDownloadCreditPack(
  environment: Readonly<Record<string, unknown>> = process.env,
): DownloadCreditPack | null {
  const priceId = typeof environment.SIDESTREAM_CREDIT_PACK_PRICE_ID === "string"
    ? environment.SIDESTREAM_CREDIT_PACK_PRICE_ID.trim()
    : "";
  const credits = Number(environment.SIDESTREAM_CREDIT_PACK_CREDITS);
  const configuredLabel = typeof environment.SIDESTREAM_CREDIT_PACK_LABEL === "string"
    ? environment.SIDESTREAM_CREDIT_PACK_LABEL.trim().slice(0, 80)
    : "";
  if (!/^price_[A-Za-z0-9]{8,200}$/.test(priceId)) return null;
  if (!Number.isSafeInteger(credits) || credits < 100 || credits > 1_000_000) return null;
  return Object.freeze({
    key: DOWNLOAD_CREDIT_PACK_KEY,
    credits,
    label: configuredLabel || `${credits.toLocaleString("en-US")} credits`,
    priceId,
  });
}

export function serializeDownloadCreditPack(pack: DownloadCreditPack | null) {
  return pack
    ? { key: pack.key, credits: pack.credits, label: pack.label }
    : null;
}

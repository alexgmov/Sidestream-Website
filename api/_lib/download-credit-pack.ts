export const DOWNLOAD_CREDIT_PACK_KEY = "standard";
export const DOWNLOAD_CREDIT_PACK_CREDITS = 1_000;
export const DOWNLOAD_CREDIT_PACK_LABEL = "1,000 more credits";
export const DOWNLOAD_CREDIT_PACK_CURRENCY = "usd";
export const DOWNLOAD_CREDIT_PACK_UNIT_AMOUNT_MINOR = 499;
export const DOWNLOAD_CREDIT_PACK_PRICE_LABEL = "$4.99 one-time";

export type DownloadCreditPack = Readonly<{
  key: typeof DOWNLOAD_CREDIT_PACK_KEY;
  credits: typeof DOWNLOAD_CREDIT_PACK_CREDITS;
  label: typeof DOWNLOAD_CREDIT_PACK_LABEL;
  currency: typeof DOWNLOAD_CREDIT_PACK_CURRENCY;
  unitAmountMinor: typeof DOWNLOAD_CREDIT_PACK_UNIT_AMOUNT_MINOR;
  priceLabel: typeof DOWNLOAD_CREDIT_PACK_PRICE_LABEL;
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
  if (!/^price_[A-Za-z0-9]{8,200}$/.test(priceId)) return null;
  if (credits !== DOWNLOAD_CREDIT_PACK_CREDITS) return null;
  return Object.freeze({
    key: DOWNLOAD_CREDIT_PACK_KEY,
    credits: DOWNLOAD_CREDIT_PACK_CREDITS,
    label: DOWNLOAD_CREDIT_PACK_LABEL,
    currency: DOWNLOAD_CREDIT_PACK_CURRENCY,
    unitAmountMinor: DOWNLOAD_CREDIT_PACK_UNIT_AMOUNT_MINOR,
    priceLabel: DOWNLOAD_CREDIT_PACK_PRICE_LABEL,
    priceId,
  });
}

export function serializeDownloadCreditPack(pack: DownloadCreditPack | null) {
  return pack
    ? {
        key: pack.key,
        credits: pack.credits,
        label: pack.label,
        priceLabel: pack.priceLabel,
      }
    : null;
}

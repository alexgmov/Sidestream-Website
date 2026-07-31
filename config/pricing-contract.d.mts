export type PricingOffer = Readonly<{
  offerId: string;
  countryCodes: readonly string[];
  currency: string;
  amountMinor: number;
  displayLocale: string;
  lookupKey: string | null;
  priceSource:
    | Readonly<{ kind: "default" }>
    | Readonly<{ kind: "environment"; variable: string }>;
}>;

export const SIDESTREAM_PRICING_CONTRACT: Readonly<{
  free: Readonly<{
    offerId: string;
    currency: string;
    amountMinor: number;
    displayLocale: string;
  }>;
  global: PricingOffer;
  india: PricingOffer;
  checkoutCatalog: readonly PricingOffer[];
}>;

export function formatOfferPrice(offer: Readonly<{
  currency: string;
  amountMinor: number;
  displayLocale: string;
}>): string;

export function formatOfferDecimal(offer: Readonly<{
  currency: string;
  amountMinor: number;
  displayLocale: string;
}>): string;

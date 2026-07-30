import type { IncomingHttpHeaders } from "node:http";

export const UNKNOWN_CHECKOUT_COUNTRY = "ZZ";

export type CheckoutOfferCatalogEntry = Readonly<{
  offerId: string;
  countryCodes: readonly string[];
  currency: string;
  amountMinor: number;
  displayLocale: string;
  priceSource:
    | Readonly<{ kind: "default" }>
    | Readonly<{ kind: "environment"; variable: string }>;
}>;

export type CheckoutOfferSelection = Readonly<{
  country: string;
  entry: CheckoutOfferCatalogEntry;
  configuredPriceId: string;
}>;

const INDIA_OFFER: CheckoutOfferCatalogEntry = Object.freeze({
  offerId: "sidestream-unlimited-india",
  countryCodes: Object.freeze(["IN"]),
  currency: "inr",
  amountMinor: 99900,
  displayLocale: "en-IN",
  priceSource: Object.freeze({
    kind: "environment",
    variable: "SIDESTREAM_PRO_INDIA_PRICE_ID",
  }),
});

export const SIDESTREAM_GLOBAL_CHECKOUT_OFFER: CheckoutOfferCatalogEntry =
  Object.freeze({
    offerId: "sidestream-unlimited-global",
    countryCodes: Object.freeze(["*"]),
    currency: "usd",
    amountMinor: 2499,
    displayLocale: "en-US",
    priceSource: Object.freeze({ kind: "default" }),
  });

/**
 * Server-owned regional offer allowlist. Country-specific entries must appear
 * before the global fallback. Adding a future country requires another entry
 * with an approved amount and an immutable Stripe Price ID supplied through
 * server configuration.
 */
export const SIDESTREAM_CHECKOUT_OFFER_CATALOG =
  Object.freeze<readonly CheckoutOfferCatalogEntry[]>([
    INDIA_OFFER,
    SIDESTREAM_GLOBAL_CHECKOUT_OFFER,
  ]);

export function getTrustedCheckoutCountry(headers: IncomingHttpHeaders) {
  const raw = headers["x-vercel-ip-country"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return normalizeCheckoutCountry(value);
}

export function normalizeCheckoutCountry(value: unknown) {
  const country = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(country) ? country : UNKNOWN_CHECKOUT_COUNTRY;
}

export function selectCheckoutOffer(
  countryValue: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): CheckoutOfferSelection {
  const country = normalizeCheckoutCountry(countryValue);
  const regionalEntry = SIDESTREAM_CHECKOUT_OFFER_CATALOG.find(
    (entry) =>
      entry.priceSource.kind === "environment" &&
      entry.countryCodes.includes(country) &&
      cleanEnvironmentValue(environment[entry.priceSource.variable]),
  );
  const entry = regionalEntry || SIDESTREAM_GLOBAL_CHECKOUT_OFFER;
  const configuredPriceId = entry.priceSource.kind === "environment"
    ? cleanEnvironmentValue(environment[entry.priceSource.variable])
    : "";
  return { country, entry, configuredPriceId };
}

export function getCheckoutOfferPresentation(
  countryValue: unknown,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const { entry } = selectCheckoutOffer(countryValue, environment);
  const currency = entry.currency.toUpperCase();
  const currencyOptions = new Intl.NumberFormat(entry.displayLocale, {
    style: "currency",
    currency,
  }).resolvedOptions();
  const fractionDigits = currencyOptions.maximumFractionDigits ?? 2;
  const minorUnitDivisor = 10 ** fractionDigits;
  const hasFraction = entry.amountMinor % minorUnitDivisor !== 0;
  const formattedPrice = new Intl.NumberFormat(entry.displayLocale, {
    style: "currency",
    currency,
    minimumFractionDigits: hasFraction ? fractionDigits : 0,
    maximumFractionDigits: fractionDigits,
  }).format(entry.amountMinor / minorUnitDivisor);
  return Object.freeze({ formattedPrice, currency });
}

function cleanEnvironmentValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

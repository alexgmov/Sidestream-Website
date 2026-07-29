import type { IncomingHttpHeaders } from "node:http";

export const UNKNOWN_CHECKOUT_COUNTRY = "ZZ";

export type CheckoutOfferCatalogEntry = Readonly<{
  offerId: string;
  countryCodes: readonly string[];
  currency: string;
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
  priceSource: Object.freeze({
    kind: "environment",
    variable: "SIDESTREAM_PRO_INDIA_PRICE_ID",
  }),
});

const GLOBAL_OFFER: CheckoutOfferCatalogEntry = Object.freeze({
  offerId: "sidestream-unlimited-global",
  countryCodes: Object.freeze(["*"]),
  currency: "usd",
  priceSource: Object.freeze({ kind: "default" }),
});

/**
 * Server-owned regional offer allowlist. Country-specific entries must appear
 * before the global fallback. Adding a future country requires another entry
 * with an immutable Stripe Price ID supplied through server configuration.
 */
export const SIDESTREAM_CHECKOUT_OFFER_CATALOG =
  Object.freeze<readonly CheckoutOfferCatalogEntry[]>([
    INDIA_OFFER,
    GLOBAL_OFFER,
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
  const entry = regionalEntry || GLOBAL_OFFER;
  const configuredPriceId = entry.priceSource.kind === "environment"
    ? cleanEnvironmentValue(environment[entry.priceSource.variable])
    : "";
  return { country, entry, configuredPriceId };
}

function cleanEnvironmentValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

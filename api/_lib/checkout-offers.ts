import type { IncomingHttpHeaders } from "node:http";
import {
  formatOfferPrice,
  SIDESTREAM_PRICING_CONTRACT,
  type PricingOffer,
} from "../../config/pricing-contract.mjs";

export const UNKNOWN_CHECKOUT_COUNTRY = "ZZ";

export type CheckoutOfferCatalogEntry = PricingOffer;

export type CheckoutOfferSelection = Readonly<{
  country: string;
  entry: CheckoutOfferCatalogEntry;
  configuredPriceId: string;
}>;

export type MonthlyCheckoutPriceSelection = Readonly<{
  kind: "lookup" | "environment";
  configuredPriceId: string;
}>;

export type AnnualCheckoutPriceSelection = Readonly<{
  kind: "lookup" | "environment";
  configuredPriceId: string;
}>;

export const SIDESTREAM_GLOBAL_CHECKOUT_OFFER: CheckoutOfferCatalogEntry =
  SIDESTREAM_PRICING_CONTRACT.global;

/**
 * Server-owned regional offer allowlist. Country-specific entries must appear
 * before the global fallback. Adding a future country requires another entry
 * with an approved amount and an immutable Stripe Price ID supplied through
 * server configuration.
 */
export const SIDESTREAM_CHECKOUT_OFFER_CATALOG =
  SIDESTREAM_PRICING_CONTRACT.checkoutCatalog;

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
  const formattedPrice = formatOfferPrice(entry);
  const billingCadence = entry.annualPriceSource ? "year" : "one_time";
  return Object.freeze({ formattedPrice, currency, billingCadence });
}

/**
 * Monthly Price configuration stays server-owned and follows the already
 * selected one-time offer. Regional offers fail closed without their exact
 * configured recurring Price; only the global USD offer may discover/create.
 */
export function selectMonthlyCheckoutPrice(
  entry: CheckoutOfferCatalogEntry,
  environment: NodeJS.ProcessEnv = process.env,
): MonthlyCheckoutPriceSelection {
  const source = entry.monthlyPriceSource;
  return Object.freeze({
    kind: source.kind,
    configuredPriceId: cleanEnvironmentValue(
      environment[
        source.kind === "lookup"
          ? source.configuredVariable
          : source.variable
      ],
    ),
  });
}

/**
 * The new annual experiment is deliberately USD-only. A catalog entry without
 * an explicit annual contract is outside the cohort and falls back to its
 * unchanged one-time offer.
 */
export function selectAnnualCheckoutPrice(
  entry: CheckoutOfferCatalogEntry,
  environment: NodeJS.ProcessEnv = process.env,
): AnnualCheckoutPriceSelection | null {
  const source = entry.annualPriceSource;
  if (!source) return null;
  return Object.freeze({
    kind: source.kind,
    configuredPriceId: cleanEnvironmentValue(
      environment[
        source.kind === "lookup"
          ? source.configuredVariable
          : source.variable
      ],
    ),
  });
}

function cleanEnvironmentValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

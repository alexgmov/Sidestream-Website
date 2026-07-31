const globalOffer = Object.freeze({
  offerId: "sidestream-unlimited-global",
  countryCodes: Object.freeze(["*"]),
  currency: "usd",
  amountMinor: 1999,
  displayLocale: "en-US",
  lookupKey: "sidestream_pro_once_1999",
  priceSource: Object.freeze({ kind: "default" }),
});

const indiaOffer = Object.freeze({
  offerId: "sidestream-unlimited-india",
  countryCodes: Object.freeze(["IN"]),
  currency: "inr",
  amountMinor: 49900,
  displayLocale: "en-IN",
  lookupKey: null,
  priceSource: Object.freeze({
    kind: "environment",
    variable: "SIDESTREAM_PRO_INDIA_PRICE_ID",
  }),
});

const brazilOffer = Object.freeze({
  offerId: "sidestream-unlimited-brazil",
  countryCodes: Object.freeze(["BR"]),
  currency: "brl",
  amountMinor: 2500,
  displayLocale: "pt-BR",
  lookupKey: null,
  priceSource: Object.freeze({
    kind: "environment",
    variable: "SIDESTREAM_PRO_BRAZIL_PRICE_ID",
  }),
});

export const SIDESTREAM_PRICING_CONTRACT = Object.freeze({
  free: Object.freeze({
    offerId: "sidestream-free",
    currency: "usd",
    amountMinor: 0,
    displayLocale: "en-US",
  }),
  global: globalOffer,
  india: indiaOffer,
  brazil: brazilOffer,
  checkoutCatalog: Object.freeze([indiaOffer, brazilOffer, globalOffer]),
});

export function formatOfferPrice(offer) {
  const currency = offer.currency.toUpperCase();
  const currencyOptions = new Intl.NumberFormat(offer.displayLocale, {
    style: "currency",
    currency,
  }).resolvedOptions();
  const fractionDigits = currencyOptions.maximumFractionDigits ?? 2;
  const minorUnitDivisor = 10 ** fractionDigits;
  const hasFraction = offer.amountMinor % minorUnitDivisor !== 0;
  return new Intl.NumberFormat(offer.displayLocale, {
    style: "currency",
    currency,
    minimumFractionDigits: hasFraction ? fractionDigits : 0,
    maximumFractionDigits: fractionDigits,
  }).format(offer.amountMinor / minorUnitDivisor);
}

export function formatOfferDecimal(offer) {
  const fractionDigits = new Intl.NumberFormat(offer.displayLocale, {
    style: "currency",
    currency: offer.currency,
  }).resolvedOptions().maximumFractionDigits ?? 2;
  return (offer.amountMinor / (10 ** fractionDigits)).toFixed(fractionDigits);
}

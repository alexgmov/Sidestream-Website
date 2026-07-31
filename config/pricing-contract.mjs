const globalOffer = Object.freeze({
  offerId: "sidestream-unlimited-global",
  countryCodes: Object.freeze(["*"]),
  currency: "usd",
  amountMinor: 2499,
  displayLocale: "en-US",
  lookupKey: "sidestream_pro_once_2499",
  priceSource: Object.freeze({ kind: "default" }),
});

const indiaOffer = Object.freeze({
  offerId: "sidestream-unlimited-india",
  countryCodes: Object.freeze(["IN"]),
  currency: "inr",
  amountMinor: 79900,
  displayLocale: "en-IN",
  lookupKey: null,
  priceSource: Object.freeze({
    kind: "environment",
    variable: "SIDESTREAM_PRO_INDIA_PRICE_ID",
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
  checkoutCatalog: Object.freeze([indiaOffer, globalOffer]),
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

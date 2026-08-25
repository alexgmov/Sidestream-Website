const globalOffer = Object.freeze({
  offerId: "sidestream-unlimited-global",
  countryCodes: Object.freeze(["*"]),
  currency: "usd",
  amountMinor: 1999,
  monthlyAmountMinor: 499,
  annualAmountMinor: 1999,
  displayLocale: "en-US",
  lookupKey: "sidestream_pro_once_1999",
  priceSource: Object.freeze({ kind: "default" }),
  monthlyPriceSource: Object.freeze({
    kind: "lookup",
    configuredVariable: "SIDESTREAM_PRO_MONTHLY_PRICE_ID",
  }),
  annualPriceSource: Object.freeze({
    kind: "lookup",
    configuredVariable: "SIDESTREAM_PRO_ANNUAL_PRICE_ID",
  }),
});

const indiaOffer = Object.freeze({
  offerId: "sidestream-unlimited-india",
  countryCodes: Object.freeze(["IN"]),
  currency: "inr",
  amountMinor: 49900,
  monthlyAmountMinor: 29900,
  annualAmountMinor: null,
  displayLocale: "en-IN",
  lookupKey: null,
  priceSource: Object.freeze({
    kind: "environment",
    variable: "SIDESTREAM_PRO_INDIA_PRICE_ID",
  }),
  monthlyPriceSource: Object.freeze({
    kind: "environment",
    variable: "SIDESTREAM_PRO_INDIA_MONTHLY_PRICE_ID",
  }),
  annualPriceSource: null,
});

const brazilOffer = Object.freeze({
  offerId: "sidestream-unlimited-brazil",
  countryCodes: Object.freeze(["BR"]),
  currency: "brl",
  amountMinor: 2500,
  monthlyAmountMinor: 1299,
  annualAmountMinor: null,
  displayLocale: "pt-BR",
  lookupKey: null,
  priceSource: Object.freeze({
    kind: "environment",
    variable: "SIDESTREAM_PRO_BRAZIL_PRICE_ID",
  }),
  monthlyPriceSource: Object.freeze({
    kind: "environment",
    variable: "SIDESTREAM_PRO_BRAZIL_MONTHLY_PRICE_ID",
  }),
  annualPriceSource: null,
});

const southKoreaOffer = Object.freeze({
  offerId: "sidestream-unlimited-south-korea",
  countryCodes: Object.freeze(["KR"]),
  currency: "krw",
  amountMinor: 24900,
  monthlyAmountMinor: 12900,
  annualAmountMinor: null,
  displayLocale: "ko-KR",
  lookupKey: null,
  priceSource: Object.freeze({
    kind: "environment",
    variable: "SIDESTREAM_PRO_SOUTH_KOREA_PRICE_ID",
  }),
  monthlyPriceSource: Object.freeze({
    kind: "environment",
    variable: "SIDESTREAM_PRO_SOUTH_KOREA_MONTHLY_PRICE_ID",
  }),
  annualPriceSource: null,
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
  southKorea: southKoreaOffer,
  checkoutCatalog: Object.freeze([
    indiaOffer,
    brazilOffer,
    southKoreaOffer,
    globalOffer,
  ]),
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

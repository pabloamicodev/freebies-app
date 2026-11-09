import { formatStoredAmount, fromStoredAmount, isZeroDecimalCurrency, overrideUnit, toStoredAmount } from "./money.js";

/** What the merchant types for a market's custom threshold, as the stored override in that market's unit (null when empty). */
export function marketThresholdToStored(input: string, shopCurrency: string, marketCurrency: string): number | null {
  return input ? toStoredAmount(parseFloat(input), overrideUnit(shopCurrency, marketCurrency)) : null;
}

export function marketThresholdToInput(stored: number | null, shopCurrency: string, marketCurrency: string): string {
  return stored === null ? "" : String(fromStoredAmount(stored, overrideUnit(shopCurrency, marketCurrency)));
}

export function marketThresholdStep(shopCurrency: string, marketCurrency: string): number | undefined {
  return isZeroDecimalCurrency(overrideUnit(shopCurrency, marketCurrency)) ? 1 : undefined;
}

/** The base threshold (in the shop currency's unit) as the widget page prints it: "$50.00 USD", "5000 JPY". */
export function baseThresholdLabel(baseThresholdCents: number, shopCurrency: string, baseCurrencyCode: string): string {
  return `${isZeroDecimalCurrency(shopCurrency) ? "" : "$"}${formatStoredAmount(baseThresholdCents, shopCurrency)} ${baseCurrencyCode}`;
}

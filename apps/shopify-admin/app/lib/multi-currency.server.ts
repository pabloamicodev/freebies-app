/**
 * Multi-currency utilities for the admin backend.
 * Handles currency conversion, formatting, and per-currency discount capping.
 */

import { getCurrencyDecimals, ZERO_DECIMAL_CURRENCIES } from "@promo/shared-types";

/** Convert a base-currency amount to a target currency using an exchange rate. */
export function convertCurrency(
  amountCents: number,
  fromCurrency: string,
  toCurrency: string,
  exchangeRate: number,
): number {
  if (fromCurrency.toUpperCase() === toCurrency.toUpperCase()) return amountCents;
  const converted = amountCents * exchangeRate;
  // Round to correct decimal places
  const decimals = getCurrencyDecimals(toCurrency);
  const factor = Math.pow(10, decimals);
  return Math.ceil(converted / factor) * factor;
}

/** Format money for display. */
export function formatMoney(
  amountCents: number,
  currencyCode: string,
  locale = "en",
): string {
  const decimals = getCurrencyDecimals(currencyCode);
  const amount = amountCents / Math.pow(10, decimals);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currencyCode,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount);
}

/** Cap a discount amount so it never exceeds the item price (in same currency). */
export function capDiscountToPriceCents(discountCents: number, priceCents: number): number {
  return Math.min(discountCents, priceCents);
}

/** Round a discount amount to the correct decimal places for the currency. */
export function roundForCurrency(cents: number, currencyCode: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currencyCode.toUpperCase())) {
    return Math.round(cents); // Already integer
  }
  return Math.round(cents); // Cents are already integers
}

/** Get the threshold for a given currency, either from override or auto-convert. */
export function resolveThreshold(
  baseThresholdCents: number,
  baseCurrencyCode: string,
  activeCurrencyCode: string,
  currencyOverrides?: Record<string, number>,
  exchangeRate?: number,
): number {
  const activeCurrency = activeCurrencyCode.toUpperCase();
  const baseCurrency = baseCurrencyCode.toUpperCase();

  // Use explicit override if available
  if (currencyOverrides?.[activeCurrency] !== undefined) {
    return currencyOverrides[activeCurrency]!;
  }

  // Same currency — use base directly
  if (activeCurrency === baseCurrency) return baseThresholdCents;

  // Auto-convert using exchange rate
  if (exchangeRate && exchangeRate > 0) {
    return convertCurrency(baseThresholdCents, baseCurrency, activeCurrency, exchangeRate);
  }

  // No exchange rate — fallback to base threshold
  return baseThresholdCents;
}

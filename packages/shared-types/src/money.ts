import { z } from "zod";

/** Money amount stored as integer cents to avoid floating-point errors. */
export const MoneySchema = z.object({
  /** Amount in the smallest currency unit (cents, pence, etc.) */
  amount: z.number().int().nonnegative(),
  currencyCode: z.string().length(3).toUpperCase(),
});
export type Money = z.infer<typeof MoneySchema>;

export const CurrencyContextSchema = z.object({
  activeCurrencyCode: z.string().length(3),
  shopCurrencyCode: z.string().length(3),
  exchangeRate: z.number().positive().optional(),
});
export type CurrencyContext = z.infer<typeof CurrencyContextSchema>;

/** Convert a decimal amount (e.g. 49.99) to integer cents (4999). */
export function toCents(amount: number, decimals = 2): number {
  return Math.round(amount * Math.pow(10, decimals));
}

/** Convert integer cents back to decimal for display. */
export function fromCents(cents: number, decimals = 2): number {
  return cents / Math.pow(10, decimals);
}

/** Cap a discount so it never exceeds the item price. Returns capped discount in cents. */
export function capDiscount(discountCents: number, priceCents: number): number {
  return Math.min(discountCents, priceCents);
}

/** Currency decimal places (zero-decimal currencies like JPY = 0). */
export const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "GNF", "ISK", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF",
  "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

export function getCurrencyDecimals(currencyCode: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currencyCode.toUpperCase()) ? 0 : 2;
}

/**
 * Currency codes supported in the promo engine UI for per-currency threshold overrides.
 * Single source of truth — import from @promo/shared-types instead of duplicating.
 */
export const SUPPORTED_CURRENCIES = [
  "AFN","AUD","AWG","BBD","BZD","CAD","CNY","DJF","EUR","FKP",
  "GBP","HKD","JPY","MXN","USD",
] as const;
export type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];

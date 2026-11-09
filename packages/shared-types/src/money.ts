import { z } from "zod";

export const CurrencyContextSchema = z.object({
  activeCurrencyCode: z.string().length(3),
  shopCurrencyCode: z.string().length(3),
  exchangeRate: z.number().positive().optional(),
});
export type CurrencyContext = z.infer<typeof CurrencyContextSchema>;

/**
 * Currency codes supported in the promo engine UI for per-currency threshold overrides.
 * Single source of truth — import from @promo/shared-types instead of duplicating.
 */
export const SUPPORTED_CURRENCIES = [
  "AFN","AUD","AWG","BBD","BZD","CAD","CNY","DJF","EUR","FKP",
  "GBP","HKD","JPY","MXN","USD",
] as const;
export type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];

/** Keep identical to `is_zero_decimal` in the Rust Functions. */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "JPY", "KRW", "VND", "BIF", "CLP", "GNF", "ISK", "KMF", "MGA", "DJF", "PYG", "RWF", "UGX", "VUV", "XAF", "XOF", "XPF",
]);

export function isZeroDecimalCurrency(currency: string | null | undefined): boolean {
  return ZERO_DECIMAL_CURRENCIES.has((currency ?? "").toUpperCase());
}

/**
 * Stored thresholds are in the currency's own minor unit (whole yen for JPY), as the Functions read them. The storefront
 * cart (/cart.js) is assumed to report every currency in x100 subunits, JPY included (unverified: no JPY store to confirm),
 * so the rule engine lifts a zero-decimal threshold by 100 before comparing. This is the only place that assumption lives.
 */
export function toCartUnits(stored: number, currency: string | null | undefined): number {
  return isZeroDecimalCurrency(currency) ? stored * 100 : stored;
}

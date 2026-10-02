/**
 * Fixed reward amounts are stored in minor units (x100) except for zero-decimal currencies, where the
 * compiler (functionDiscountValue in sync/compile-config.ts) reads them as whole units. Keep this list
 * identical to that one.
 */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "JPY", "KRW", "VND", "BIF", "CLP", "GNF", "ISK", "KMF", "MGA", "DJF", "PYG", "RWF", "UGX", "VUV", "XAF", "XOF", "XPF",
]);

export function isZeroDecimalCurrency(currency: string | null | undefined): boolean {
  return ZERO_DECIMAL_CURRENCIES.has((currency ?? "").toUpperCase());
}

export function toStoredAmount(value: number, currency: string | null | undefined): number {
  return isZeroDecimalCurrency(currency) ? Math.round(value) : Math.round(value * 100);
}

export function fromStoredAmount(stored: number, currency: string | null | undefined): number {
  return isZeroDecimalCurrency(currency) ? stored : stored / 100;
}

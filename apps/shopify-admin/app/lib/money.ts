/**
 * Fixed reward amounts are stored in minor units (x100) except for zero-decimal currencies, where the
 * compiler (functionDiscountValue in sync/compile-config.ts) reads them as whole units. Keep this list
 * identical to that one.
 */
import { isZeroDecimalCurrency } from "@promo/shared-types";

export { ZERO_DECIMAL_CURRENCIES, isZeroDecimalCurrency } from "@promo/shared-types";

export function toStoredAmount(value: number, currency: string | null | undefined): number {
  return isZeroDecimalCurrency(currency) ? Math.round(value) : Math.round(value * 100);
}

export function fromStoredAmount(stored: number, currency: string | null | undefined): number {
  return isZeroDecimalCurrency(currency) ? stored : stored / 100;
}

/** A stored amount as plain text for labels: two decimals, none for zero-decimal currencies. */
export function formatStoredAmount(stored: number, currency: string | null | undefined): string {
  return fromStoredAmount(stored, currency).toFixed(isZeroDecimalCurrency(currency) ? 0 : 2);
}

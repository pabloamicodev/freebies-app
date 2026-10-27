import type { NormalizedCart, EligibilityReason, CurrencyContext } from "@promo/shared-types";
import { ok, err, type Result } from "@promo/shared-types";
import { extractQualifyingLines, sumQualifyingValueNet } from "../cart-parser.js";

export interface CartValueConditionValue {
  thresholdCents: number;
  /** Optional inclusive upper bound used by mutually exclusive gift tiers. */
  maxCents?: number;
  currencyCode: string;
  /** Per-currency custom thresholds — overrides thresholdCents for that currency. */
  currencyOverrides?: Record<string, number>;
  /** Per-currency custom inclusive upper bounds. */
  maxCurrencyOverrides?: Record<string, number>;
  includeGiftValues: boolean;
  /** Product/variant/collection/vendor/type filter applied to qualifying lines. */
  scopeFilter?: {
    productIds?: string[];
    variantIds?: string[];
    collectionIds?: string[];
    vendors?: string[];
    productTypes?: string[];
    excludeProductIds?: string[];
    excludeCollectionIds?: string[];
  };
}

/**
 * Evaluate a cart_value condition.
 * Returns Ok(reason) if the condition passes, Err(reason) if it fails.
 */
export function evaluateCartValue(
  cart: NormalizedCart,
  condition: CartValueConditionValue,
  currency: CurrencyContext,
): Result<EligibilityReason, EligibilityReason> {
  const qualifyingLines = extractQualifyingLines(cart, {
    includeGiftValues: condition.includeGiftValues,
  }).filter((line) => {
    const f = condition.scopeFilter;
    if (!f) return true;

    if (f.excludeProductIds?.includes(line.productId)) return false;
    if (f.excludeCollectionIds?.some((cid) => line.collections.includes(cid))) return false;
    if (f.productIds && !f.productIds.includes(line.productId)) return false;
    if (f.variantIds && !f.variantIds.includes(line.variantId)) return false;
    if (f.vendors && !f.vendors.includes(line.vendor)) return false;
    if (f.productTypes && !f.productTypes.includes(line.productType)) return false;
    return true;
  });

  const cartValueCents = sumQualifyingValueNet(qualifyingLines);

  // Resolve threshold — prefer currency override, fallback to auto-conversion
  let thresholdCents = condition.thresholdCents;
  let maxCents = condition.maxCents;
  const activeCurrency = currency.activeCurrencyCode.toUpperCase();
  // Saved conditions may lack currencyCode; their thresholds are in the shop currency.
  const conditionCurrency = (condition.currencyCode ?? currency.shopCurrencyCode).toUpperCase();
  if (condition.currencyOverrides?.[activeCurrency] !== undefined) {
    thresholdCents = condition.currencyOverrides[activeCurrency]!;
  } else if (
    activeCurrency !== conditionCurrency &&
    currency.exchangeRate
  ) {
    thresholdCents = Math.ceil(condition.thresholdCents * currency.exchangeRate);
  }
  if (condition.maxCurrencyOverrides?.[activeCurrency] !== undefined) {
    maxCents = condition.maxCurrencyOverrides[activeCurrency]!;
  } else if (
    maxCents !== undefined &&
    activeCurrency !== conditionCurrency &&
    currency.exchangeRate
  ) {
    maxCents = Math.ceil(maxCents * currency.exchangeRate);
  }

  // Editors save an empty maximum as 0; the Function compiles 0 as "no maximum" too.
  if (maxCents !== undefined && maxCents <= 0) maxCents = undefined;

  const meetsMinimum = cartValueCents >= thresholdCents;
  const meetsMaximum = maxCents === undefined || cartValueCents <= maxCents;
  const passed = meetsMinimum && meetsMaximum;

  const reason: EligibilityReason = {
    conditionType: "cart_value",
    passed,
    message: passed
      ? `Cart value ${cartValueCents} cents is within ${thresholdCents}–${maxCents ?? "unbounded"} cents`
      : !meetsMinimum
        ? `Cart value ${cartValueCents} cents < threshold ${thresholdCents} cents`
        : `Cart value ${cartValueCents} cents > maximum ${maxCents} cents`,
    actual: cartValueCents,
    required: thresholdCents,
  };

  return passed ? ok(reason) : err(reason);
}

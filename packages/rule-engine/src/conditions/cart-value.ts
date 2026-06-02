import type { NormalizedCart, EligibilityReason, CurrencyContext } from "@promo/shared-types";
import { ok, err, type Result } from "@promo/shared-types";
import { extractQualifyingLines, sumQualifyingValue } from "../cart-parser.js";

export interface CartValueConditionValue {
  thresholdCents: number;
  currencyCode: string;
  /** Per-currency custom thresholds — overrides thresholdCents for that currency. */
  currencyOverrides?: Record<string, number>;
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

  const cartValueCents = sumQualifyingValue(qualifyingLines);

  // Resolve threshold — prefer currency override, fallback to auto-conversion
  let thresholdCents = condition.thresholdCents;
  const activeCurrency = currency.activeCurrencyCode.toUpperCase();
  if (condition.currencyOverrides?.[activeCurrency] !== undefined) {
    thresholdCents = condition.currencyOverrides[activeCurrency]!;
  } else if (
    activeCurrency !== condition.currencyCode.toUpperCase() &&
    currency.exchangeRate
  ) {
    thresholdCents = Math.ceil(condition.thresholdCents * currency.exchangeRate);
  }

  const passed = cartValueCents >= thresholdCents;

  const reason: EligibilityReason = {
    conditionType: "cart_value",
    passed,
    message: passed
      ? `Cart value ${cartValueCents} cents ≥ threshold ${thresholdCents} cents`
      : `Cart value ${cartValueCents} cents < threshold ${thresholdCents} cents`,
    actual: cartValueCents,
    required: thresholdCents,
  };

  return passed ? ok(reason) : err(reason);
}

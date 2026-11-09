import type { NormalizedCart, EligibilityReason, CurrencyContext } from "@promo/shared-types";
import { ok, err, overrideToCartUnits, toCartUnits, type Result } from "@promo/shared-types";
import { extractQualifyingLines } from "../cart-parser.js";

export interface CartValueMultiplierConditionValue {
  thresholdCents: number;
  currencyCode: string;
  currencyOverrides?: Record<string, number>;
  maxMultiplier?: number;
  includeGiftValues: boolean;
  scopeFilter?: {
    productIds?: string[];
    variantIds?: string[];
    collectionIds?: string[];
    excludeProductIds?: string[];
  };
}

export interface MultiplierResult {
  multiplier: number;
  eligibleValueCents: number;
  thresholdCents: number;
}

/**
 * Cart value multiplier: floor(eligibleCartValue / threshold).
 * Returns how many times the cart value exceeds the threshold.
 * Used to calculate how many gifts/rewards the customer earns.
 */
export function evaluateCartValueMultiplier(
  cart: NormalizedCart,
  condition: CartValueMultiplierConditionValue,
  currency: CurrencyContext,
): Result<EligibilityReason & { multiplier: number }, EligibilityReason> {
  const qualifyingLines = extractQualifyingLines(cart, {
    includeGiftValues: condition.includeGiftValues,
  }).filter((line) => {
    const f = condition.scopeFilter;
    if (!f) return true;
    if (f.excludeProductIds?.includes(line.productId)) return false;
    if (f.productIds && !f.productIds.includes(line.productId)) return false;
    if (f.variantIds && !f.variantIds.includes(line.variantId)) return false;
    return true;
  });

  const cartValueCents = qualifyingLines.reduce(
    (acc, line) => acc + line.priceCents * line.quantity,
    0,
  );

  // Resolve threshold for active currency
  const activeCurrency = currency.activeCurrencyCode.toUpperCase();
  const conditionCurrency = (condition.currencyCode ?? currency.shopCurrencyCode).toUpperCase();
  let thresholdCents = toCartUnits(condition.thresholdCents, conditionCurrency);
  if (condition.currencyOverrides?.[activeCurrency] !== undefined) {
    thresholdCents = overrideToCartUnits(condition.currencyOverrides[activeCurrency]!, activeCurrency, conditionCurrency);
  } else if (
    // Saved conditions may lack currencyCode; their thresholds are in the shop currency.
    activeCurrency !== conditionCurrency &&
    currency.exchangeRate
  ) {
    thresholdCents = Math.ceil(toCartUnits(condition.thresholdCents, conditionCurrency) * currency.exchangeRate);
  }

  if (thresholdCents <= 0) {
    return err({
      conditionType: "cart_value_multiplier",
      passed: false,
      message: "Threshold must be greater than 0",
    });
  }

  const rawMultiplier = Math.floor(cartValueCents / thresholdCents);
  const multiplier = condition.maxMultiplier
    ? Math.min(rawMultiplier, condition.maxMultiplier)
    : rawMultiplier;

  const passed = multiplier >= 1;

  const reason = {
    conditionType: "cart_value_multiplier",
    passed,
    message: passed
      ? `Cart value ${cartValueCents}¢ / threshold ${thresholdCents}¢ = ${multiplier} gift(s)`
      : `Cart value ${cartValueCents}¢ < threshold ${thresholdCents}¢ (0 gifts)`,
    actual: cartValueCents,
    required: thresholdCents,
    multiplier,
  };

  return passed ? ok(reason) : err(reason);
}

import type { NormalizedCart, EligibilityReason } from "@promo/shared-types";
import { ok, err, type Result } from "@promo/shared-types";
import { extractQualifyingLines, isZeroCostLine, sumQualifyingQuantity } from "../cart-parser.js";

export interface CartQuantityConditionValue {
  minQuantity: number;
  maxQuantity?: number;
  includeGiftValues: boolean;
  scopeFilter?: {
    productIds?: string[];
    collectionIds?: string[];
    excludeProductIds?: string[];
  };
}

/** Units the condition counts. A $0 line (another app's free gift) is not a paid unit unless gifts are counted. */
export function cartQuantityCount(cart: NormalizedCart, condition: CartQuantityConditionValue): number {
  const qualifyingLines = extractQualifyingLines(cart, {
    includeGiftValues: condition.includeGiftValues,
  }).filter((line) => {
    if (!condition.includeGiftValues && isZeroCostLine(line)) return false;
    const f = condition.scopeFilter;
    if (!f) return true;
    if (f.excludeProductIds?.includes(line.productId)) return false;
    if (f.productIds && !f.productIds.includes(line.productId)) return false;
    return true;
  });

  return sumQualifyingQuantity(qualifyingLines);
}

export function evaluateCartQuantity(
  cart: NormalizedCart,
  condition: CartQuantityConditionValue,
): Result<EligibilityReason, EligibilityReason> {
  const totalQty = cartQuantityCount(cart, condition);
  const passedMin = totalQty >= condition.minQuantity;
  const passedMax = condition.maxQuantity === undefined || totalQty <= condition.maxQuantity;
  const passed = passedMin && passedMax;

  const reason: EligibilityReason = {
    conditionType: "cart_quantity",
    passed,
    message: passed
      ? `Cart quantity ${totalQty} is within [${condition.minQuantity}, ${condition.maxQuantity ?? "∞"}]`
      : `Cart quantity ${totalQty} is outside [${condition.minQuantity}, ${condition.maxQuantity ?? "∞"}]`,
    actual: totalQty,
    required: { min: condition.minQuantity, max: condition.maxQuantity },
  };

  return passed ? ok(reason) : err(reason);
}

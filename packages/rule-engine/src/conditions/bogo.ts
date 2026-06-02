/**
 * BOGO (Buy One Get One) and Buy X Get Y evaluators.
 *
 * BOGO self-gift: the purchased product IS the gift
 *   - Buy 1 shirt → get 1 shirt free
 *
 * BXGY: buy X of product A → get Y of product B free
 *   - Buy 2 hats → get 1 scarf free
 */

import type { NormalizedCart, EligibilityReason } from "@promo/shared-types";
import { ok, err, type Result } from "@promo/shared-types";
import { extractQualifyingLines } from "../cart-parser.js";

export interface BogoConditionValue {
  mode: "bogo_self" | "bxgy";
  /** Required product/variant to purchase. */
  triggerProductId?: string;
  triggerVariantId?: string;
  triggerTrackMode: "product" | "variant";
  /** Minimum quantity of trigger product required. */
  triggerMinQuantity: number;
  /** For BXGY: gift product/variant. For BOGO: same as trigger. */
  giftProductId?: string;
  giftVariantId?: string;
  /** Gift quantity earned per qualifying trigger group. */
  giftQuantity: number;
}

export interface BogoResult {
  qualifiedGroups: number;
  triggerQuantityInCart: number;
}

export function evaluateBogo(
  cart: NormalizedCart,
  condition: BogoConditionValue,
): Result<EligibilityReason & BogoResult, EligibilityReason> {
  const qualifyingLines = extractQualifyingLines(cart, { includeGiftValues: false });

  const triggerLines = qualifyingLines.filter((line) => {
    if (condition.triggerTrackMode === "variant") {
      return line.variantId === condition.triggerVariantId;
    }
    return line.productId === condition.triggerProductId;
  });

  const triggerQty = triggerLines.reduce((acc, l) => acc + l.quantity, 0);

  if (triggerQty < condition.triggerMinQuantity) {
    return err({
      conditionType: "bogo",
      passed: false,
      message: `BOGO trigger: need ${condition.triggerMinQuantity} of trigger product, have ${triggerQty}`,
      actual: triggerQty,
      required: condition.triggerMinQuantity,
    });
  }

  const qualifiedGroups = Math.floor(triggerQty / condition.triggerMinQuantity);

  return ok({
    conditionType: "bogo",
    passed: true,
    message: `BOGO qualifies: ${qualifiedGroups} group(s), trigger qty ${triggerQty}`,
    actual: triggerQty,
    required: condition.triggerMinQuantity,
    qualifiedGroups,
    triggerQuantityInCart: triggerQty,
  });
}

import type { NormalizedCart, EligibilityReason } from "@promo/shared-types";
import { ok, err, type Result } from "@promo/shared-types";
import { extractQualifyingLines } from "../cart-parser.js";

export interface ProductQuantityLimit {
  trackMode: "product" | "variant" | "collection" | "vendor" | "type";
  targetId: string;
  minQuantity?: number;
  maxQuantity?: number;
  /** "at_most_0" means exclude this product from qualifying. */
  isExclude?: boolean;
}

export interface ProductQuantityLimitsConditionValue {
  limits: ProductQuantityLimit[];
  /** "AND" = all limits must pass; "OR" = at least one must pass. */
  operator: "AND" | "OR";
  /** Gift lines from other offers are excluded from counting by default. */
  excludeGiftLines: boolean;
}

export function evaluateProductQuantityLimits(
  cart: NormalizedCart,
  condition: ProductQuantityLimitsConditionValue,
): Result<EligibilityReason, EligibilityReason> {
  const qualifyingLines = extractQualifyingLines(cart, {
    includeGiftValues: !condition.excludeGiftLines,
  });

  const results = condition.limits.map((limit) => checkLimit(limit, qualifyingLines));

  const passed =
    condition.operator === "AND" ? results.every((r) => r.passed) : results.some((r) => r.passed);

  const failedMessages = results.filter((r) => !r.passed).map((r) => r.message);

  const reason: EligibilityReason = {
    conditionType: "product_quantity_limits",
    passed,
    message: passed
      ? `Product quantity limits (${condition.operator}) satisfied`
      : `Failed limits (${condition.operator}): ${failedMessages.join("; ")}`,
    actual: results.filter((r) => r.passed).length,
    required: condition.operator === "AND" ? condition.limits.length : 1,
  };

  return passed ? ok(reason) : err(reason);
}

function checkLimit(
  limit: ProductQuantityLimit,
  lines: ReturnType<typeof extractQualifyingLines>,
): { passed: boolean; message: string } {
  const matchingLines = lines.filter((line) => {
    switch (limit.trackMode) {
      case "product":
        return line.productId === limit.targetId;
      case "variant":
        return line.variantId === limit.targetId;
      case "collection":
        return line.collections.includes(limit.targetId);
      case "vendor":
        return line.vendor === limit.targetId;
      case "type":
        return line.productType === limit.targetId;
      default:
        return false;
    }
  });

  const totalQty = matchingLines.reduce((acc, l) => acc + l.quantity, 0);

  if (limit.isExclude || limit.maxQuantity === 0) {
    const passed = totalQty === 0;
    return {
      passed,
      message: passed ? `${limit.targetId}: excluded (0 in cart)` : `${limit.targetId}: excluded but ${totalQty} in cart`,
    };
  }

  const passedMin = limit.minQuantity === undefined || totalQty >= limit.minQuantity;
  const passedMax = limit.maxQuantity === undefined || totalQty <= limit.maxQuantity;
  const passed = passedMin && passedMax;

  return {
    passed,
    message: passed
      ? `${limit.targetId}: qty ${totalQty} in [${limit.minQuantity ?? 0}, ${limit.maxQuantity ?? "∞"}]`
      : `${limit.targetId}: qty ${totalQty} outside [${limit.minQuantity ?? 0}, ${limit.maxQuantity ?? "∞"}]`,
  };
}

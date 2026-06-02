import type { NormalizedCart, EligibilityReason } from "@promo/shared-types";
import { ok, err, type Result } from "@promo/shared-types";
import { extractQualifyingLines } from "../cart-parser.js";

export interface SpecificProductConditionValue {
  /**
   * Each entry specifies a product+variant requirement.
   * "trackMode: product" = any variant of the product counts.
   * "trackMode: variant" = only this exact variant counts.
   */
  requirements: Array<{
    productId: string;
    variantId?: string;
    trackMode: "product" | "variant";
    minQuantity: number;
    maxQuantity?: number;
  }>;
  /** When true: multiply reward quantity by number of qualifying groups. */
  multiplyByGroups: boolean;
}

export interface SpecificProductResult {
  passed: boolean;
  qualifiedGroups: number;
}

export function evaluateSpecificProduct(
  cart: NormalizedCart,
  condition: SpecificProductConditionValue,
): Result<EligibilityReason & { qualifiedGroups: number }, EligibilityReason> {
  const qualifyingLines = extractQualifyingLines(cart, { includeGiftValues: false });

  let allPassed = true;
  let minGroups = Infinity;
  const details: string[] = [];

  for (const req of condition.requirements) {
    const matchingLines = qualifyingLines.filter((line) => {
      if (req.trackMode === "product") return line.productId === req.productId;
      return line.variantId === (req.variantId ?? "");
    });

    const totalQty = matchingLines.reduce((acc, l) => acc + l.quantity, 0);
    const passedMin = totalQty >= req.minQuantity;
    const passedMax = req.maxQuantity === undefined || totalQty <= req.maxQuantity;

    if (!passedMin || !passedMax) {
      allPassed = false;
      details.push(
        `Product ${req.productId}: qty ${totalQty} required [${req.minQuantity}, ${req.maxQuantity ?? "∞"}]`,
      );
    } else {
      const groups = Math.floor(totalQty / req.minQuantity);
      minGroups = Math.min(minGroups, groups);
    }
  }

  const qualifiedGroups = allPassed ? (isFinite(minGroups) ? minGroups : 1) : 0;

  const reason = {
    conditionType: "specific_product",
    passed: allPassed,
    message: allPassed
      ? `All product requirements met (${qualifiedGroups} group(s))`
      : `Product requirements not met: ${details.join("; ")}`,
    actual: qualifiedGroups,
    required: condition.requirements.length,
    qualifiedGroups,
  };

  return allPassed ? ok(reason) : err(reason);
}

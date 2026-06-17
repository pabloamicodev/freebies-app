import type { NormalizedCart, EligibilityReason } from "@promo/shared-types";
import { ok, err, type Result } from "@promo/shared-types";
import { extractQualifyingLines } from "../cart-parser.js";

export interface PackRequirement {
  /** "product" = any variant of the product counts; "variant" = exact variant only. */
  trackMode: "product" | "variant";
  productId?: string;
  variantId?: string;
  /** How many of this item are required per pack. */
  quantityPerPack: number;
}

export interface PackConditionValue {
  requirements: PackRequirement[];
  /** Multiply rewards by number of complete packs. */
  multiplyByPacks: boolean;
  /** Maximum number of packs to award. */
  maxPacks?: number;
}

/**
 * Pack of products condition:
 * ALL required products must be present in the cart.
 * Pack count = floor(scarcestQuantity / required quantity per pack).
 * Partial packs do not qualify.
 */
export function evaluatePack(
  cart: NormalizedCart,
  condition: PackConditionValue,
): Result<EligibilityReason & { packCount: number }, EligibilityReason> {
  const qualifyingLines = extractQualifyingLines(cart, { includeGiftValues: false });
  const legacyVariantIds = (condition as unknown as { variantIds?: string[] }).variantIds;
  const requirements = condition.requirements ?? (
    Array.isArray(legacyVariantIds)
      ? legacyVariantIds.map((variantId) => ({
          variantId,
          trackMode: "variant" as const,
          quantityPerPack: 1,
        }))
      : []
  );

  let minPacks = Infinity;
  const failedRequirements: string[] = [];

  for (const req of requirements) {
    const matchingLines = qualifyingLines.filter((line) => {
      if (req.trackMode === "product") return line.productId === req.productId;
      return line.variantId === req.variantId;
    });

    const totalQty = matchingLines.reduce((acc, l) => acc + l.quantity, 0);

    if (req.quantityPerPack <= 0) continue;

    const packsFromThisItem = Math.floor(totalQty / req.quantityPerPack);

    if (packsFromThisItem === 0) {
      failedRequirements.push(
        `${req.productId ?? req.variantId}: have ${totalQty}, need ${req.quantityPerPack}`,
      );
    }

    minPacks = Math.min(minPacks, packsFromThisItem);
  }

  if (!isFinite(minPacks) || minPacks === 0) {
    return err({
      conditionType: "pack_of_products",
      passed: false,
      message: `Pack condition not met: ${failedRequirements.join("; ")}`,
      actual: 0,
      required: requirements.length,
    });
  }

  const packCount = condition.maxPacks ? Math.min(minPacks, condition.maxPacks) : minPacks;

  return ok({
    conditionType: "pack_of_products",
    passed: true,
    message: `${packCount} complete pack(s) found`,
    actual: packCount,
    required: 1,
    packCount,
  });
}

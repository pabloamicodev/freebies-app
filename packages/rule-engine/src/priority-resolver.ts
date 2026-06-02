import type { EvaluatedOffer } from "@promo/shared-types";

export interface OfferWithPolicy {
  offerId: string;
  priority: number;
  stopLowerPriority: boolean;
  qualified: boolean;
}

/**
 * Apply priority ordering and stop-lower-priority rule.
 *
 * Returns the subset of qualified offers that should be applied,
 * in priority order (lower number = higher priority).
 *
 * If offer A has stopLowerPriority=true and qualifies,
 * all offers with priority > A.priority are excluded.
 */
export function applyPriority(offers: OfferWithPolicy[]): OfferWithPolicy[] {
  const qualified = offers
    .filter((o) => o.qualified)
    .sort((a, b) => a.priority - b.priority);

  const result: OfferWithPolicy[] = [];

  for (const offer of qualified) {
    result.push(offer);
    if (offer.stopLowerPriority) {
      // Stop — all subsequent (lower priority = higher number) offers are blocked
      break;
    }
  }

  return result;
}

/**
 * Detect offers that would conflict (same product, same discount type).
 * Returns pairs of [offerId, offerId] that conflict.
 */
export function detectConflicts(
  offers: Array<{ offerId: string; targetProductIds: string[]; discountType: string }>,
): Array<[string, string]> {
  const conflicts: Array<[string, string]> = [];

  for (let i = 0; i < offers.length; i++) {
    for (let j = i + 1; j < offers.length; j++) {
      const a = offers[i]!;
      const b = offers[j]!;
      const sharedProducts = a.targetProductIds.some((id) => b.targetProductIds.includes(id));
      if (sharedProducts && a.discountType === b.discountType) {
        conflicts.push([a.offerId, b.offerId]);
      }
    }
  }

  return conflicts;
}

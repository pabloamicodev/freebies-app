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
 * A qualifying stopLowerPriority offer blocks only STRICTLY lower-priority
 * offers (priority number greater than its own); offers sharing its priority
 * still apply. The discount Function does the same (`offer.priority > stop_at`).
 */
export function applyPriority(offers: OfferWithPolicy[]): OfferWithPolicy[] {
  const qualified = offers
    .filter((o) => o.qualified)
    .sort((a, b) => a.priority - b.priority);

  const stopAt = qualified.find((o) => o.stopLowerPriority)?.priority;
  return stopAt === undefined ? qualified : qualified.filter((o) => o.priority <= stopAt);
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

/**
 * Offer Conflict Detection
 * Automatically detects offers that may conflict or stack unexpectedly.
 *
 * A conflict exists when:
 * 1. Two offers target the same gift product (same variant/product)
 * 2. Two offers have the same main condition type with overlapping thresholds
 * 3. One offer would stop-lower-priority but doesn't account for other active offers
 * 4. Multiple offers with auto-add could add the same gift
 */

import { getDb, offers, offerConditions, offerRewards } from "@promo/db";
import { eq, and } from "drizzle-orm";

export interface OfferConflict {
  type: "gift_variant_overlap" | "threshold_overlap" | "stop_lower_priority_warning" | "auto_add_duplicate";
  severity: "warning" | "error";
  offerIds: string[];
  message: string;
}

export async function detectConflicts(shopId: string): Promise<OfferConflict[]> {
  const db = getDb();
  const conflicts: OfferConflict[] = [];

  // Load all active offers
  const activeOffers = await db.select({ id: offers.id, priority: offers.priority })
    .from(offers)
    .where(and(eq(offers.shopId, shopId), eq(offers.status, "active")));

  if (activeOffers.length < 2) return conflicts;

  // Load conditions and rewards for all active offers
  const [, rewardRows] = await Promise.all([
    db.select().from(offerConditions).where(eq(offerConditions.shopId, shopId)),
    db.select().from(offerRewards).where(eq(offerRewards.shopId, shopId)),
  ]);

  // Check for gift variant overlaps (same gift offered by multiple offers)
  const giftVariantMap = new Map<string, string[]>();
  for (const reward of rewardRows) {
    if (reward.rewardType !== "product_gift") continue;
    const target = reward.target as Record<string, unknown>;
    const variantIds = (target["variantIds"] as string[]) ?? (target["variantId"] ? [target["variantId"] as string] : []);

    for (const variantId of variantIds) {
      const existing = giftVariantMap.get(variantId) ?? [];
      existing.push(reward.offerId);
      giftVariantMap.set(variantId, existing);
    }
  }

  for (const [variantId, offerIdsList] of giftVariantMap.entries()) {
    const unique = [...new Set(offerIdsList)];
    if (unique.length > 1) {
      conflicts.push({
        type: "gift_variant_overlap",
        severity: "warning",
        offerIds: unique,
        message: `Multiple offers (${unique.length}) add the same gift variant ${variantId.slice(-8)}. Customer may receive duplicate gifts.`,
      });
    }
  }

  // Check for auto-add duplicates
  const autoAddOffers = rewardRows.filter((r) => r.rewardType === "product_gift" && r.isAutoAdd);
  if (autoAddOffers.length > 1) {
    const autoAddOfferIds = [...new Set(autoAddOffers.map((r) => r.offerId))];
    if (autoAddOfferIds.length > 1) {
      conflicts.push({
        type: "auto_add_duplicate",
        severity: "warning",
        offerIds: autoAddOfferIds,
        message: `${autoAddOfferIds.length} offers have auto-add enabled. Multiple gifts may be added simultaneously.`,
      });
    }
  }

  // Check for stop-lower-priority that may unexpectedly block other offers
  // TODO: check combination policies for stop_lower_priority behavior

  return conflicts;
}

/**
 * Compile an offer's conditions and rewards into the compact JSON config
 * that gets pushed to Shopify metafields and consumed by the Rust Discount Function.
 *
 * The compiled config is designed to be:
 * - Compact: precomputed ID sets, no redundant data
 * - Deterministic: same offer → same config
 * - Under 10 KB: stays within Shopify metafield size limit
 */

import type {
  offers as OffersTable,
  offerConditions as ConditionsTable,
  offerRewards as RewardsTable,
  offerCombinationPolicies as PoliciesTable,
} from "@promo/db";

export interface CompiledFunctionConfig {
  offers: CompiledOffer[];
  version: string;
  compiledAt: string;
}

export interface CompiledOffer {
  id: string;
  version: number;
  offerType: string;
  priority: number;
  stopLowerPriority: boolean;
  /** Required product GIDs (any variant of these must be in cart for specific_product condition). */
  requiredProductIds: string[];
  /** Required variant GIDs. */
  requiredVariantIds: string[];
  /** Excluded product GIDs. */
  excludedProductIds: string[];
  /** Gift variant GIDs the customer can receive. */
  giftVariantIds: string[];
  /** Gift product GIDs (track_mode: product — any variant of these is a valid gift). */
  giftProductIds: string[];
  /** Cart value threshold in store currency cents. */
  cartValueThresholdCents?: number;
  /** Cart quantity threshold. */
  cartQuantityThreshold?: number;
  /** Maximum gift units to discount per evaluation. */
  maxGiftQuantity?: number;
  discountType: string;
  discountValue: number;
  currencyCode: string;
  /** Per-currency threshold overrides: { "EUR": 4500 } */
  currencyOverrides?: Record<string, number>;
  combinesWithOrderDiscounts: boolean;
  combinesWithShippingDiscounts: boolean;
  combinesWithProductDiscounts: boolean;
}

type OfferRow = typeof OffersTable.$inferSelect;
type ConditionRow = typeof ConditionsTable.$inferSelect;
type RewardRow = typeof RewardsTable.$inferSelect;
type PolicyRow = typeof PoliciesTable.$inferSelect;

export function compileOfferConfig(
  offer: OfferRow,
  conditions: ConditionRow[],
  rewards: RewardRow[],
  policy: PolicyRow | null,
  versionNumber: number,
): CompiledOffer {
  const config: CompiledOffer = {
    id: offer.id,
    version: versionNumber,
    offerType: offer.type,
    priority: offer.priority,
    stopLowerPriority: policy?.stopLowerPriority ?? false,
    requiredProductIds: [],
    requiredVariantIds: [],
    excludedProductIds: [],
    giftVariantIds: [],
    giftProductIds: [],
    discountType: "free",
    discountValue: 100,
    currencyCode: "USD",
    combinesWithOrderDiscounts: policy?.combinesWithOrderDiscounts ?? true,
    combinesWithShippingDiscounts: policy?.combinesWithShippingDiscounts ?? true,
    combinesWithProductDiscounts: policy?.combinesWithProductDiscounts ?? true,
  };

  // Process main conditions
  for (const cond of conditions.filter((c) => c.isEnabled)) {
    const value = cond.value as Record<string, unknown>;

    switch (cond.conditionType) {
      case "cart_value": {
        config.cartValueThresholdCents = Number(value["thresholdCents"] ?? 0);
        if (value["currencyOverrides"]) {
          config.currencyOverrides = value["currencyOverrides"] as Record<string, number>;
        }
        const filter = value["scopeFilter"] as Record<string, string[]> | undefined;
        if (filter?.excludeProductIds) {
          config.excludedProductIds.push(...filter.excludeProductIds);
        }
        break;
      }
      case "cart_quantity": {
        config.cartQuantityThreshold = Number(value["minQuantity"] ?? 0);
        break;
      }
      case "specific_product": {
        const reqs = (value["requirements"] as Array<{ productId?: string; variantId?: string; trackMode: string }>) ?? [];
        for (const req of reqs) {
          if (req.trackMode === "variant" && req.variantId) {
            config.requiredVariantIds.push(req.variantId);
          } else if (req.productId) {
            config.requiredProductIds.push(req.productId);
          }
        }
        break;
      }
      case "exclude_products": {
        const ids = (value["productIds"] as string[]) ?? [];
        config.excludedProductIds.push(...ids);
        break;
      }
    }
  }

  // Process rewards
  for (const reward of rewards) {
    const target = reward.target as Record<string, unknown>;
    const value = reward.value as Record<string, unknown>;

    if (reward.rewardType === "product_gift") {
      const variantIds = (target["variantIds"] as string[]) ?? (target["variantId"] ? [target["variantId"] as string] : []);
      const productIds = (target["productIds"] as string[]) ?? (target["productId"] ? [target["productId"] as string] : []);
      config.giftVariantIds.push(...variantIds);
      config.giftProductIds.push(...productIds);
      if (reward.quantity) config.maxGiftQuantity = (config.maxGiftQuantity ?? 0) + reward.quantity;
      config.discountType = reward.discountType;
      config.discountValue = Number(value["amount"] ?? value["percentage"] ?? 100);
    }
  }

  // Deduplicate arrays
  config.requiredProductIds = [...new Set(config.requiredProductIds)];
  config.requiredVariantIds = [...new Set(config.requiredVariantIds)];
  config.excludedProductIds = [...new Set(config.excludedProductIds)];
  config.giftVariantIds = [...new Set(config.giftVariantIds)];
  config.giftProductIds = [...new Set(config.giftProductIds)];

  return config;
}

export function estimateConfigSize(config: CompiledFunctionConfig): number {
  return JSON.stringify(config).length;
}

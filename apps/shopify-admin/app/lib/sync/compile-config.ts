/**
 * Compile an offer's conditions and rewards into the compact JSON config
 * pushed to Shopify metafields and consumed by the Rust Discount Function.
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
  requiredProductIds: string[];
  requiredVariantIds: string[];
  excludedProductIds: string[];
  giftVariantIds: string[];
  giftProductIds: string[];
  cartValueThresholdCents?: number;
  cartQuantityThreshold?: number;
  maxGiftQuantity?: number;
  discountType: string;
  discountValue: number;
  currencyCode: string;
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

  for (const cond of conditions.filter((c) => c.isEnabled)) {
    const value = cond.value as Record<string, unknown>;
    switch (cond.conditionType) {
      case "cart_value": {
        config.cartValueThresholdCents = Number(value["thresholdCents"] ?? 0);
        if (value["currencyOverrides"]) config.currencyOverrides = value["currencyOverrides"] as Record<string, number>;
        const filter = value["scopeFilter"] as Record<string, string[]> | undefined;
        if (filter?.excludeProductIds) config.excludedProductIds.push(...filter.excludeProductIds);
        break;
      }
      case "cart_quantity":
        config.cartQuantityThreshold = Number(value["minQuantity"] ?? 0);
        break;
      case "specific_product": {
        const reqs = (value["requirements"] as Array<{ productId?: string; variantId?: string; trackMode: string }>) ?? [];
        for (const req of reqs) {
          if (req.trackMode === "variant" && req.variantId) config.requiredVariantIds.push(req.variantId);
          else if (req.productId) config.requiredProductIds.push(req.productId);
        }
        break;
      }
      case "exclude_products":
        config.excludedProductIds.push(...((value["productIds"] as string[]) ?? []));
        break;
    }
  }

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

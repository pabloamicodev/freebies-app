import type { SkioShippingTier, SkioShippingTiersConfig } from "./skio-shipping-tiers.js";

export interface SkioSubscriptionSnapshot {
  id: string;
  subscriptionDurationMonths: number;
  subtotal: number;
  cyclesCompleted: number;
  productVariantIds: string[];
}

export interface ShippingOverrideDecision {
  subscriptionId: string;
  matchedTierId: string | null;
  targetCycle: number;
  overrideAmount: number | null;
}

function tierMatches(tier: SkioShippingTier, subscription: SkioSubscriptionSnapshot): boolean {
  if (tier.subscriptionDurationMonths !== subscription.subscriptionDurationMonths) return false;
  if (subscription.subtotal < tier.minSubtotal) return false;
  if (tier.maxSubtotal !== null && subscription.subtotal >= tier.maxSubtotal) return false;
  if (tier.productVariantIds !== null && !subscription.productVariantIds.some((id) => tier.productVariantIds?.includes(id))) {
    return false;
  }
  return true;
}

export function resolveShippingOverride(
  config: SkioShippingTiersConfig,
  subscription: SkioSubscriptionSnapshot,
): ShippingOverrideDecision {
  const targetCycle = subscription.cyclesCompleted + 1;
  const tier = config.tiers.find((candidate) => tierMatches(candidate, subscription));
  if (!tier) {
    return { subscriptionId: subscription.id, matchedTierId: null, targetCycle, overrideAmount: null };
  }

  const cycleOverride = tier.cycleOverrides.find((entry) => entry.cycle === targetCycle);
  return {
    subscriptionId: subscription.id,
    matchedTierId: tier.id,
    targetCycle,
    overrideAmount: (cycleOverride?.override ?? tier.defaultOverride).amount,
  };
}

export function resolveShippingOverrides(
  config: SkioShippingTiersConfig,
  subscriptions: SkioSubscriptionSnapshot[],
): ShippingOverrideDecision[] {
  return subscriptions.map((subscription) => resolveShippingOverride(config, subscription));
}

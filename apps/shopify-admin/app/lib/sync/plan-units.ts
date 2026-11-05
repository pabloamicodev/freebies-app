import type { offerCombinationPolicies, offerConditions } from "@promo/db";
import type { CompiledOffer } from "./compile-config.js";
import { unitBytes, type PlanUnit } from "./shard-planner.js";

type ConditionRow = Pick<typeof offerConditions.$inferSelect, "offerId" | "conditionType" | "value" | "isEnabled">;
type PolicyRow = Pick<typeof offerCombinationPolicies.$inferSelect, "offerId" | "stopLowerPriority">;

export interface CompiledEntry {
  offerId: string;
  offer: CompiledOffer;
}

export function cartAttributeKeysOf(conditions: readonly ConditionRow[]): string[] {
  const keys = conditions.flatMap((condition) => {
    if (condition.conditionType !== "cart_attribute" || condition.isEnabled === false) return [];
    const key = condition.value && typeof condition.value === "object" ? (condition.value as Record<string, unknown>)["key"] : null;
    return typeof key === "string" && key.trim() ? [key.trim()] : [];
  });
  return [...new Set(keys)].sort((a, b) => a.localeCompare(b));
}

function targetProductIdsOf(offer: CompiledOffer): string[] | null {
  const rewards = [...offer.productRewards, ...offer.giftRewards];
  if (rewards.length === 0 || rewards.some((reward) => reward.targetProductIds.length === 0)) return null;
  return [...new Set(rewards.flatMap((reward) => reward.targetProductIds))].sort();
}

/** One planner unit per compiled cart offer; the publisher and the preflight both build units here so they cannot diverge. */
export function buildPlanUnits(
  compiled: readonly CompiledEntry[],
  conditions: readonly ConditionRow[],
  policies: readonly PolicyRow[],
): PlanUnit[] {
  return compiled.map(({ offerId, offer }) => ({
    key: offerId,
    bytes: unitBytes(offer),
    cartAttributeKeys: cartAttributeKeysOf(conditions.filter((condition) => condition.offerId === offerId)),
    customerTags: [...new Set([...(offer.requiredCustomerTags ?? []), ...(offer.excludedCustomerTags ?? [])])].sort(),
    priority: offer.priority,
    hasOrderRewards: offer.orderRewards.length > 0,
    stopLowerPriority: policies.find((policy) => policy.offerId === offerId)?.stopLowerPriority ?? offer.stopLowerPriority,
    targetProductIds: targetProductIdsOf(offer),
    multiLineFixed: offer.productRewards.some((reward) => reward.scopeMode === "quiz_bundle"),
  }));
}

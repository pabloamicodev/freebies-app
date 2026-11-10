import type { offerCombinationPolicies, offerConditions } from "@promo/db";
import type { CompiledOffer } from "./compile-config.js";
import { mergeOfferParts, splitOffer, type SplitOptions, type SplitPart, type SplitRefusal } from "./offer-split.js";
import { envelopeBytes, SLOT_LIMITS, unitBytes, type PlanUnit } from "./shard-planner.js";

type ConditionRow = Pick<typeof offerConditions.$inferSelect, "offerId" | "conditionType" | "value" | "isEnabled">;
type PolicyRow = Pick<typeof offerCombinationPolicies.$inferSelect, "offerId" | "stopLowerPriority">;

export interface CompiledEntry {
  offerId: string;
  offer: CompiledOffer;
}

/** Offer id of a planner unit key (split parts are keyed `offerId#k`). */
export const baseOfferId = (unitKey: string): string => unitKey.split("#")[0]!;

export function cartAttributeKeysOf(conditions: readonly ConditionRow[]): string[] {
  const keys = conditions.flatMap((condition) => {
    if (condition.conditionType !== "cart_attribute" || condition.isEnabled === false) return [];
    const key = condition.value && typeof condition.value === "object" ? (condition.value as Record<string, unknown>)["key"] : null;
    return typeof key === "string" && key.trim() ? [key.trim()] : [];
  });
  return [...new Set(keys)].sort((a, b) => a.localeCompare(b));
}

// Variant-only rewards (no product ids) count as sitewide until product ids are resolved at compile time.
function targetProductIdsOf(offer: CompiledOffer): string[] | null {
  const rewards = [...offer.productRewards, ...offer.giftRewards];
  if (rewards.length === 0 || rewards.some((reward) => reward.targetProductIds.length === 0)) return null;
  return [...new Set(rewards.flatMap((reward) => reward.targetProductIds))].sort();
}

/** Where a split offer's parts came from: enough to merge the parts that share a slot back into one offer. */
export interface OfferSplit {
  paths: string[];
  rewardArray?: "giftRewards";
  parts: SplitPart[];
}

export interface PlanUnitSet {
  units: PlanUnit[];
  /** Offers too big for one slot that were split, by offer id. */
  splits: Map<string, OfferSplit>;
}

/**
 * One planner unit per compiled cart offer; the publisher and the preflight both build units here so they cannot
 * diverge. An offer bigger than a slot gets `splittable` parts when its shape allows it (offer-split.ts).
 */
export function buildPlanUnitSet(
  compiled: readonly CompiledEntry[],
  conditions: readonly ConditionRow[],
  policies: readonly PolicyRow[],
  options: SplitOptions = {},
): PlanUnitSet {
  const splits = new Map<string, OfferSplit>();
  const units = compiled.map(({ offerId, offer }): PlanUnit => {
    const cartAttributeKeys = cartAttributeKeysOf(conditions.filter((condition) => condition.offerId === offerId));
    const customerTags = [...new Set([...(offer.requiredCustomerTags ?? []), ...(offer.excludedCustomerTags ?? [])])].sort();
    const unit: PlanUnit = {
      key: offerId,
      bytes: unitBytes(offer),
      cartAttributeKeys,
      customerTags,
      priority: offer.priority,
      hasOrderRewards: offer.orderRewards.length > 0,
      stopLowerPriority: policies.find((policy) => policy.offerId === offerId)?.stopLowerPriority ?? offer.stopLowerPriority,
      targetProductIds: targetProductIdsOf(offer),
      multiLineFixed: offer.productRewards.some((reward) => reward.scopeMode === "quiz_bundle"),
    };
    const envelope = envelopeBytes(cartAttributeKeys, customerTags);
    if (unit.bytes + envelope - 1 <= SLOT_LIMITS.slotBytes) return unit;

    // Parts leave room to share a slot (target fill) when they can; otherwise they may fill one.
    const budgets = [Math.floor(SLOT_LIMITS.slotBytes * SLOT_LIMITS.targetFill), SLOT_LIMITS.slotBytes].map((cap) => cap - envelope + 1);
    let refusal: SplitRefusal | undefined;
    for (const budget of budgets) {
      const result = splitOffer(offer, budget, options);
      if (!result.ok) {
        refusal = result.reason;
        if (result.reason !== "STILL_TOO_LARGE") break;
        continue;
      }
      splits.set(offerId, { paths: result.paths, ...(result.rewardArray ? { rewardArray: result.rewardArray } : {}), parts: result.parts });
      return {
        ...unit,
        splittable: result.parts.map((part) => ({
          ...unit,
          key: `${offerId}#${part.index}`,
          bytes: unitBytes(part.offer),
          targetProductIds: targetProductIdsOf(part.offer),
        })),
      };
    }
    return { ...unit, ...(refusal ? { splitRefusal: refusal } : {}) };
  });
  return { units, splits };
}

export function buildPlanUnits(
  compiled: readonly CompiledEntry[],
  conditions: readonly ConditionRow[],
  policies: readonly PolicyRow[],
  options: SplitOptions = {},
): PlanUnit[] {
  return buildPlanUnitSet(compiled, conditions, policies, options).units;
}

/**
 * The offers a slot publishes, in `offers` order: a whole offer as is, and the parts of a split offer that landed
 * in this slot merged back into one offer.
 */
export function slotOffers(offers: readonly CompiledOffer[], unitKeys: readonly string[], splits: ReadonlyMap<string, OfferSplit>): CompiledOffer[] {
  const keys = new Set(unitKeys);
  return offers.flatMap((offer) => {
    if (keys.has(offer.id)) return [offer];
    const split = splits.get(offer.id);
    if (!split) return [];
    const parts = split.parts.filter((part) => keys.has(`${offer.id}#${part.index}`));
    return parts.length > 0 ? [mergeOfferParts(offer, parts, split.paths, split.rewardArray)] : [];
  });
}

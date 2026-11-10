import { OPEN_POLICY, policyKey, type PlanUnit, type ShardPlan } from "./shard-planner.js";
import { baseOfferId } from "./plan-units.js";

export type ForcedReason = "order_reward" | "stop_lower_priority" | "linked_offer";

export interface CombinationGroupsSummary {
  /** Offers that do not combine with product, order or shipping discounts. */
  nonCombining: number;
  /** Offers that combine with everything. */
  combining: number;
  /** Shopify discounts holding non-combining offers. */
  nonCombiningNodes: number;
  nodes: number;
  /** Combining offers running in a node that does not combine, and why. */
  forced: { offerId: string; reason: ForcedReason }[];
}

const combines = (unit: PlanUnit) => policyKey(unit.domain ?? OPEN_POLICY) === policyKey(OPEN_POLICY);

/** What the planner did with the combination groups of a plan, for Diagnostics (W2). Null when one node holds everything. */
export function summarizeCombinationGroups(units: readonly PlanUnit[], plan: ShardPlan): CombinationGroupsSummary | null {
  if (plan.slots.length < 2) return null;
  const byKey = new Map(units.map((unit) => [unit.key, unit]));
  const minStop = Math.min(...units.filter((unit) => unit.stopLowerPriority).map((unit) => unit.priority));
  const offers = new Map<string, { combines: boolean; slot: number; reason: ForcedReason }>();
  for (const slot of plan.slots) {
    for (const key of slot.unitKeys) {
      const unit = byKey.get(key);
      if (!unit) continue;
      const reason: ForcedReason = unit.hasOrderRewards
        ? "order_reward"
        : unit.stopLowerPriority || unit.priority > minStop
          ? "stop_lower_priority"
          : "linked_offer";
      offers.set(baseOfferId(key), { combines: combines(unit), slot: slot.index, reason });
    }
  }
  const slotPolicy = new Map(plan.slots.map((slot) => [slot.index, slot.policy]));
  const restrictive = (slot: number) => policyKey(slotPolicy.get(slot) ?? OPEN_POLICY) !== policyKey(OPEN_POLICY);
  const rows = [...offers.entries()];
  return {
    nonCombining: rows.filter(([, offer]) => !offer.combines).length,
    combining: rows.filter(([, offer]) => offer.combines).length,
    nonCombiningNodes: plan.slots.filter((slot) => restrictive(slot.index)).length,
    nodes: plan.slots.length,
    forced: rows
      .filter(([, offer]) => offer.combines && restrictive(offer.slot))
      .map(([offerId, offer]) => ({ offerId, reason: offer.reason }))
      .sort((a, b) => (a.offerId < b.offerId ? -1 : 1)),
  };
}

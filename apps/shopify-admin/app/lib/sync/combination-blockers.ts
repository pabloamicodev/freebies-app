import type { CompiledOffer } from "./compile-config.js";

export interface CombinationBlocker {
  offerId: string;
  name: string;
}

/** Offers whose combination flags force single-shard mode (the planner's C4), given whether order-reward units exist. */
export function combinationBlockers(
  entries: ReadonlyArray<{ offerId: string; name: string; offer: CompiledOffer }>,
  hasOrderRewards: boolean,
): CombinationBlocker[] {
  return entries
    .filter(({ offer }) => !offer.combinesWithProductDiscounts || (hasOrderRewards && !offer.combinesWithOrderDiscounts))
    .map(({ offerId, name }) => ({ offerId, name }));
}

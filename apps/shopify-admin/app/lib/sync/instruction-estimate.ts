import type { CompiledOffer } from "./compile-config.js";

/**
 * Wasm instructions one Shopify Function run costs, estimated per offer, so the shard planner can keep every node of a
 * shop under Shopify's 11M limit on a 200-line cart. Pure: the numbers come from `scripts/calibrate-instruction-estimate.mjs`,
 * which measures the built discount Function with Shopify's function-runner and rewrites the CALIBRATED block below.
 *
 * Model (worst case: every line of the cart is relevant to every offer):
 *   node   = NODE_INSTRUCTION_FLOOR + sum(estimateUnitInstructions(offer))
 *   floor  = the empty-config run at 200 lines (the provider scanning `cart.lines`) plus SHARED, the one-time cost of
 *            reading every line's facts, which the first line-reading offer pays and later offers reuse
 *   offer  = (a + b * 200) of its shape minus SHARED, i.e. its stand-alone cost less what it shares with the node
 * Every constant is an upper envelope of the measured samples, so the estimate never undershoots a measured node.
 */
export const INSTRUCTION_LINES = 200;
/** Shopify's limit is 11M; the planner aims lower so a 25% jump in the hot path still fits. */
export const NODE_INSTRUCTION_BUDGET = 7_000_000;

export type OfferShape = "discount" | "tiers" | "gift" | "landing" | "order" | "quiz";

interface Line {
  a: number;
  b: number;
}

// BEGIN calibrated
export const CALIBRATED = {
  floor: { a: 128733, b: 10484 } as Line,
  shared: 1941382,
  shapes: {
    discount: { a: 1363202, b: 36126 },
    tiers: { a: 178285, b: 28181 },
    gift: { a: 202622, b: 22471 },
    landing: { a: 127020, b: 10514 },
    order: { a: 160789, b: 15186 },
    quiz: { a: 113730, b: 15315 },
  } as Record<OfferShape, Line>,
};
// END calibrated

const at = (line: Line) => Math.ceil(line.a + line.b * INSTRUCTION_LINES);

/** Instructions of a node with no offers on a 200-line cart, plus the shared line reads. */
export const NODE_INSTRUCTION_FLOOR = at(CALIBRATED.floor) + CALIBRATED.shared;
/** What the offers of one node may add up to. */
export const NODE_UNIT_INSTRUCTION_BUDGET = NODE_INSTRUCTION_BUDGET - NODE_INSTRUCTION_FLOOR;

type Shapeable = Partial<Pick<CompiledOffer, "offerType" | "giftRewards" | "orderRewards">> & {
  productRewards?: Array<{ scopeMode?: string; quantityTiers?: unknown[]; priceTiers?: unknown[] }>;
};

/** The cost class of an offer. Accepts the compact serialized form too (empty arrays omitted). */
export function offerShape(offer: Shapeable): OfferShape {
  const rewards = offer.productRewards ?? [];
  if (rewards.some((reward) => reward.scopeMode === "quiz_bundle")) return "quiz";
  if (rewards.some((reward) => reward.scopeMode === "landing" || reward.scopeMode === "tagged_offer")) return "landing";
  if ((offer.giftRewards?.length ?? 0) > 0 || offer.offerType === "gift") return "gift";
  if ((offer.orderRewards?.length ?? 0) > 0 && rewards.length === 0) return "order";
  if (rewards.some((reward) => (reward.quantityTiers?.length ?? 0) > 0 || (reward.priceTiers?.length ?? 0) > 0)) return "tiers";
  return "discount";
}

/** What the offer adds to a node's run on a 200-line cart, beyond the node floor. */
export function estimateUnitInstructions(offer: Shapeable): number {
  return Math.max(0, at(CALIBRATED.shapes[offerShape(offer)]) - CALIBRATED.shared);
}

export function estimateNodeInstructions(offers: readonly Shapeable[]): number {
  return NODE_INSTRUCTION_FLOOR + offers.reduce((total, offer) => total + estimateUnitInstructions(offer), 0);
}

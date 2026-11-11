import type { CompiledOffer } from "./compile-config.js";

/**
 * Wasm instructions one Shopify Function run costs, estimated per offer, so the shard planner can keep every node of a
 * shop under Shopify's 11M limit on a 200-line cart. Pure: the numbers come from `scripts/calibrate-instruction-estimate.mjs`,
 * which measures the built discount Function with Shopify's function-runner and rewrites the CALIBRATED block below.
 *
 * Model (worst case: every line of the cart is relevant to every offer):
 *   node = floor + [node has an offer] * (base + qty * [an offer has a quantity floor/cap] + value * [an offer has a cart
 *          value floor/cap]) + sum(own(shape(offer)))
 * The first offer of a node reads every line's facts and later offers reuse them, so base, qty and value are paid once per
 * node. They are the cheapest measured reader costs, so a smaller fact cost can only move cost into `own`: the estimate
 * never undershoots a measured live node (a vitest asserts it).
 */
export const INSTRUCTION_LINES = 200;
/** Shopify's limit is 11M; the planner aims lower so a 35% jump in the hot path still fits. */
export const NODE_INSTRUCTION_BUDGET = 8_000_000;

export type OfferShape = "discount" | "tiers" | "gift" | "landing" | "order" | "quiz";

interface Line {
  a: number;
  b: number;
}

// BEGIN calibrated
export const CALIBRATED = {
  floor: { a: 128733, b: 10484 } as Line,
  base: 2155904,
  qty: 441020,
  value: 1973287,
  shapes: {
  "discount": 6432300,
  "discount+value": 1822908,
  "tiers": 3176211,
  "tiers+value": 3176211,
  "gift": 374857,
  "gift+value": 583868,
  "landing": 159575,
  "landing+value": 159575,
  "order": 783219,
  "order+value": 783219,
  "quiz": 995903,
  "quiz+value": 995903,
  "idle": 174006,
  } as Record<string, number>,
};
// END calibrated

/** Bit flags of the shared line facts an offer needs beyond the base reads. */
export const FACT_QTY = 1;
export const FACT_VALUE = 2;

const at = (line: Line) => Math.ceil(line.a + line.b * INSTRUCTION_LINES);

/** Instructions of a node with no offers on a 200-line cart. */
export const NODE_EMPTY_INSTRUCTIONS = at(CALIBRATED.floor);
/** What any node holding an offer pays before its offers' own costs. */
export const NODE_INSTRUCTION_FLOOR = NODE_EMPTY_INSTRUCTIONS + CALIBRATED.base;
/** What the offers of one node may add up to (their own costs plus the facts they share). */
export const NODE_UNIT_INSTRUCTION_BUDGET = NODE_INSTRUCTION_BUDGET - NODE_INSTRUCTION_FLOOR;
/** Cost of each shared fact, paid once per node by the first offer that needs it. */
export const NODE_FACT_COSTS = { qty: CALIBRATED.qty, value: CALIBRATED.value };

type Shapeable = Partial<
  Pick<CompiledOffer, "offerType" | "giftRewards" | "orderRewards" | "cartQuantityThreshold" | "cartQuantityMax" | "cartValueThresholdCents" | "cartValueMaxCents">
> & {
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

/** Which shared facts (quantities, cart value) the offer makes the node read. */
export function offerFacts(offer: Shapeable): number {
  return (
    (offer.cartQuantityThreshold !== undefined || offer.cartQuantityMax !== undefined ? FACT_QTY : 0) |
    (offer.cartValueThresholdCents !== undefined || offer.cartValueMaxCents !== undefined ? FACT_VALUE : 0)
  );
}

/** The cost class of an offer: its shape, split by whether it makes the node read the cart value (that read grows with the cart's products). */
export function ownKey(offer: Shapeable): string {
  // A cart of 200 lines holds at least 200 units, so an offer capped below that never fires on it: it only pays for its checks.
  if (offer.cartQuantityMax !== undefined && offer.cartQuantityMax < INSTRUCTION_LINES) return "idle";
  return `${offerShape(offer)}${offerFacts(offer) & FACT_VALUE ? "+value" : ""}`;
}

/** What the offer costs beyond the facts it shares with the node's other offers, on a 200-line cart. */
export function estimateUnitInstructions(offer: Shapeable): number {
  return CALIBRATED.shapes[ownKey(offer)] ?? 0;
}

/** The planner limits that carry the model: the per-node budget for offers (own costs plus shared facts) and the fact costs. */
export const INSTRUCTION_PLANNER_LIMITS = { maxInstructions: NODE_UNIT_INSTRUCTION_BUDGET, instructionFacts: NODE_FACT_COSTS } as const;

/** Cost of the union of shared facts `flags` (see FACT_*), paid once per node. */
export const factInstructions = (flags: number) =>
  (flags & FACT_QTY ? NODE_FACT_COSTS.qty : 0) + (flags & FACT_VALUE ? NODE_FACT_COSTS.value : 0);

export function estimateNodeInstructions(offers: readonly Shapeable[]): number {
  if (offers.length === 0) return NODE_EMPTY_INSTRUCTIONS;
  const flags = offers.reduce((all, offer) => all | offerFacts(offer), 0);
  return NODE_INSTRUCTION_FLOOR + factInstructions(flags) + offers.reduce((total, offer) => total + estimateUnitInstructions(offer), 0);
}

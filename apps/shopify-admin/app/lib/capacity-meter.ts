import { SHOPIFY_AUTOMATIC_LIMIT, type CombinationForcedReason } from "./capacity-copy.js";

export const METER_WARN_AT = 0.8;

export type LimitsLevel = "unknown" | "ok" | "warning" | "critical";

export interface CombinationGroupsView {
  /** Offers that do not combine with product, order or shipping discounts. */
  nonCombining: { id: string; name: string }[];
  /** Combining offers sharing a node with offers that do not combine, with why. */
  forced: { id: string; name: string; reason: CombinationForcedReason }[];
  /** Offers that combine with everything. */
  combining: number;
  /** Shopify discounts holding offers for the cart, and how many of them do not combine. */
  nodes: number;
  nonCombiningNodes: number;
}

export interface CombinationOfferRow {
  id: string;
  name: string;
  priority: number;
  combinesWithProduct: boolean;
  combinesWithOrder: boolean;
  combinesWithShipping: boolean;
  stopLowerPriority: boolean;
  hasOrderReward: boolean;
}

/**
 * What Diagnostics says about combination groups, from the offers and the slot each one was last published in.
 * Null when no active offer opts out of combining. `slots` maps offer id to its published node.
 */
export function deriveCombinationGroups(
  offers: readonly CombinationOfferRow[],
  slots: ReadonlyMap<string, number>,
): CombinationGroupsView | null {
  const opensAll = (offer: CombinationOfferRow) => offer.combinesWithProduct && offer.combinesWithOrder && offer.combinesWithShipping;
  const closed = offers.filter((offer) => !opensAll(offer));
  if (closed.length === 0) return null;
  const nodes = new Set([...slots.values()]).size;
  const closedSlots = new Set(closed.flatMap((offer) => (slots.has(offer.id) ? [slots.get(offer.id)!] : [])));
  const minStop = Math.min(...offers.filter((offer) => offer.stopLowerPriority).map((offer) => offer.priority));
  const reasonOf = (offer: CombinationOfferRow): CombinationForcedReason =>
    offer.hasOrderReward ? "order_reward" : offer.stopLowerPriority || offer.priority > minStop ? "stop_lower_priority" : "linked_offer";
  return {
    nonCombining: closed.map(({ id, name }) => ({ id, name })),
    forced:
      nodes > 1
        ? offers
            .filter((offer) => opensAll(offer) && closedSlots.has(slots.get(offer.id) ?? -1))
            .map((offer) => ({ id: offer.id, name: offer.name, reason: reasonOf(offer) }))
        : [],
    combining: offers.length - closed.length,
    nodes: Math.max(1, nodes),
    nonCombiningNodes: Math.max(1, closedSlots.size),
  };
}

export interface LimitsMeter {
  limit: number;
  /** Active automatic discounts in the store, all apps; null when Shopify couldn't say. */
  storeActive: number | null;
  /** Of those, Promo Engine's own. */
  ours: number;
  others: number | null;
  /** Cart slots (Shopify discounts) Promo Engine's offers occupy / may occupy. */
  slotsInUse: number;
  maxCartSlots: number;
  shardsEnabled: boolean;
  /** Combination-groups setting (nodes split by combination group); off falls back to one node for offers that don't combine. */
  domainsEnabled?: boolean;
  combinationGroups?: CombinationGroupsView | null;
  level: LimitsLevel;
  discountsUrl?: string;
}

export function limitsLevel(storeActive: number | null): LimitsLevel {
  if (storeActive === null) return "unknown";
  if (storeActive >= SHOPIFY_AUTOMATIC_LIMIT) return "critical";
  return storeActive >= SHOPIFY_AUTOMATIC_LIMIT * METER_WARN_AT ? "warning" : "ok";
}

export function limitsBanner(meter: Pick<LimitsMeter, "level" | "storeActive" | "limit">): { title: string; body: string } | null {
  if (meter.level === "warning") {
    return {
      title: "Your store is close to Shopify's automatic discount limit",
      body: `Shopify allows ${meter.limit} active automatic discounts per store, including discounts from other apps. You're using ${meter.storeActive}. Promo Engine may need more as you add offers.`,
    };
  }
  if (meter.level === "critical") {
    return {
      title: "Shopify's automatic discount limit is reached",
      body: `Shopify allows ${meter.limit} active automatic discounts per store, including discounts from other apps. You're using ${meter.storeActive}. Deactivate an automatic discount you no longer use before adding more offers.`,
    };
  }
  return null;
}

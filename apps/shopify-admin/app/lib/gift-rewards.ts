import type { offerRewards } from "@promo/db";

type DiscountType = typeof offerRewards.$inferInsert.discountType;

export type GiftRewardRow = {
  id: string;
  target: unknown;
  sortOrder: number;
  isAutoAdd: boolean;
};

export type GiftRewardValues = {
  discountType: DiscountType;
  value: Record<string, unknown>;
  target: Record<string, unknown>;
  quantity: number;
  isAutoAdd: boolean;
  isCustomerSelectable: boolean;
  trackMode: "product" | "variant";
  sortOrder: number;
};

export type GiftRewardPlan = {
  update: Array<{ id: string; values: GiftRewardValues }>;
  insert: GiftRewardValues[];
  deleteIds: string[];
};

export const rewardVariantIds = (target: unknown): string[] =>
  (target as { variantIds?: string[] } | null)?.variantIds ?? [];

export const rewardFallbackIds = (target: unknown): string[] =>
  (target as { fallbackVariantIds?: string[] } | null)?.fallbackVariantIds ?? [];

/** Parses a posted {giftVariantId: fallbackVariantIds[]} map; null when malformed. Unknown gifts are dropped, lists capped at 5. */
export function parseFallbackByGift(raw: string, giftVariantIds: string[]): Record<string, string[]> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out: Record<string, string[]> = {};
  for (const [gift, list] of Object.entries(parsed)) {
    if (!Array.isArray(list) || list.some((id) => typeof id !== "string")) return null;
    if (!giftVariantIds.includes(gift)) continue;
    // A fallback that is also a primary gift would never act as a replacement.
    out[gift] = [...new Set(list as string[])].filter((id) => !giftVariantIds.includes(id)).slice(0, 5);
  }
  return out;
}

/** One list from several gifts' lists (a single reward covering them), in gift order, max 5. */
export const mergeFallbacks = (byVariant: Record<string, string[]>, giftVariantIds: string[]): string[] =>
  [...new Set(giftVariantIds.flatMap((id) => byVariant[id] ?? []))].slice(0, 5);

/**
 * The editor's single "Gifts" block is the union of every product_gift reward of the offer.
 * Several rewards (or one auto-add reward) mean "automatically add all gifts"; one non-auto
 * reward means "customer selects".
 */
export function deriveGiftBlock(rewards: Array<{ target: unknown; isAutoAdd: boolean }>) {
  const variantIds = [...new Set(rewards.flatMap((r) => rewardVariantIds(r.target)))];
  const fallbackVariantIds = [...new Set(rewards.flatMap((r) => rewardFallbackIds(r.target)))].filter(
    (id) => !variantIds.includes(id),
  );
  // Per gift: each variant shows its reward's fallbacks. A list saved once for the whole offer
  // lands on every gift row, so older offers keep working.
  const fallbackByVariant: Record<string, string[]> = {};
  for (const reward of rewards) {
    const own = rewardFallbackIds(reward.target).filter((id) => !variantIds.includes(id));
    for (const variantId of rewardVariantIds(reward.target)) fallbackByVariant[variantId] = own;
  }
  return {
    variantIds,
    fallbackVariantIds,
    fallbackByVariant,
    receivesAll: rewards.length > 1 || (rewards[0]?.isAutoAdd ?? true),
  };
}

/**
 * Plans the product_gift rewards for one gift block.
 * - autoAddAll: one reward per gift product, quantity 1, with its own fallbacks when
 *   `fallbackByVariant` is given (a product's picked variants share one list). A product with one picked variant is
 *   auto-added; a product with 2+ picked variants opens the picker for that product only.
 * - otherwise: one reward with every variant, quantity = how many the customer picks.
 * Existing reward ids are kept for gifts that stay (reward ids live in cart line properties and
 * gift usage keys); unmatched existing rewards are deleted.
 */
export function planGiftRewards(input: {
  existing: GiftRewardRow[];
  variantIds: string[];
  productOf: ReadonlyMap<string, string>;
  fallbackVariantIds: string[];
  /** Per-gift fallbacks (gift variant id -> fallback variant ids). "Add all" uses these instead of the shared list. */
  fallbackByVariant?: Record<string, string[]>;
  autoAddAll: boolean;
  quantity: number;
  discountType: DiscountType;
  value: Record<string, unknown>;
  preferredId?: string;
  baseSortOrder?: number;
}): GiftRewardPlan {
  const variantIds = [...new Set(input.variantIds)];
  const fallbackFor = (own: string[], shared: string[] = input.fallbackVariantIds) => {
    const fallback = [...new Set(shared)].filter((id) => !variantIds.includes(id) && !own.includes(id)).slice(0, 5);
    return fallback.length > 0 ? { fallbackVariantIds: fallback } : {};
  };
  const base = input.baseSortOrder ?? 0;
  const common = { discountType: input.discountType, value: input.value };

  let specs: GiftRewardValues[];
  if (!input.autoAddAll) {
    specs = [
      {
        ...common,
        target: { scope: "cart", variantIds, ...fallbackFor(variantIds) },
        quantity: input.quantity,
        isAutoAdd: false,
        isCustomerSelectable: true,
        trackMode: variantIds.length === 1 ? "variant" : "product",
        sortOrder: base,
      },
    ];
  } else {
    const groups = new Map<string, string[]>();
    for (const variantId of variantIds) {
      // An uncached variant can't be grouped: it stands alone (auto-added).
      const key = input.productOf.get(variantId) ?? variantId;
      groups.set(key, [...(groups.get(key) ?? []), variantId]);
    }
    specs = [...groups.values()].map((own, index) => {
      const single = own.length === 1;
      return {
        ...common,
        target: {
          scope: "cart",
          variantIds: own,
          ...fallbackFor(own, input.fallbackByVariant ? own.flatMap((id) => input.fallbackByVariant?.[id] ?? []) : undefined),
        },
        quantity: 1,
        isAutoAdd: single,
        isCustomerSelectable: !single,
        trackMode: single ? "variant" : "product",
        sortOrder: base + index,
      };
    });
  }

  const unclaimed = [...input.existing].sort(
    (a, b) => (a.id === input.preferredId ? -1 : b.id === input.preferredId ? 1 : a.sortOrder - b.sortOrder),
  );
  const plan: GiftRewardPlan = { update: [], insert: [], deleteIds: [] };
  const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));
  for (const spec of specs) {
    const own = rewardVariantIds(spec.target);
    let at = unclaimed.findIndex((row) => sameSet(rewardVariantIds(row.target), own));
    if (at < 0) at = unclaimed.findIndex((row) => rewardVariantIds(row.target).some((id) => own.includes(id)));
    // Select mode merges everything into one reward: the preferred (or first) one survives.
    if (at < 0 && !input.autoAddAll) at = 0;
    if (at < 0) {
      plan.insert.push(spec);
      continue;
    }
    const [row] = unclaimed.splice(at, 1);
    plan.update.push({ id: row!.id, values: spec });
  }
  plan.deleteIds = unclaimed.map((row) => row.id);
  return plan;
}

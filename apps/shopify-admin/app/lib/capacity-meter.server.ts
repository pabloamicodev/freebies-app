import { discountShards, offerCombinationPolicies, offerRewards, offers, shops, type Db } from "@promo/db";
import { and, count, eq } from "drizzle-orm";
import { SHOPIFY_AUTOMATIC_LIMIT } from "./capacity-copy.js";
import { deriveCombinationGroups, limitsLevel, type CombinationGroupsView, type LimitsMeter } from "./capacity-meter.js";
import { loadAutomaticBudget } from "./capacity-preflight.server.js";
import { isFunctionShardsEnabled, isShardDomainsEnabled } from "./function-shards-flag.server.js";
import { baseOfferId } from "./sync/plan-units.js";

/** Active automatic offers that opt out of combining, and the node each one was last published in. Never throws. */
export async function loadCombinationGroups(db: Db, shopId: string): Promise<CombinationGroupsView | null> {
  try {
    const [rows, orderRewards, shardRows] = await Promise.all([
      db
        .select({
          id: offers.id,
          name: offers.internalName,
          priority: offers.priority,
          product: offerCombinationPolicies.combinesWithProductDiscounts,
          order: offerCombinationPolicies.combinesWithOrderDiscounts,
          shipping: offerCombinationPolicies.combinesWithShippingDiscounts,
          stop: offerCombinationPolicies.stopLowerPriority,
        })
        .from(offers)
        .leftJoin(offerCombinationPolicies, eq(offerCombinationPolicies.offerId, offers.id))
        .where(and(eq(offers.shopId, shopId), eq(offers.status, "active"), eq(offers.codeRedemption, "automatic"))),
      db
        .select({ offerId: offerRewards.offerId })
        .from(offerRewards)
        .where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.rewardType, "order_discount"))),
      db
        .select({ slot: discountShards.slot, unitKeys: discountShards.unitKeys })
        .from(discountShards)
        .where(and(eq(discountShards.shopId, shopId), eq(discountShards.kind, "cart"))),
    ]);
    const withOrderReward = new Set(orderRewards.map((row) => row.offerId));
    const slots = new Map<string, number>();
    for (const row of shardRows) for (const key of row.unitKeys) slots.set(baseOfferId(key), row.slot);
    return deriveCombinationGroups(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        priority: row.priority,
        combinesWithProduct: row.product ?? true,
        combinesWithOrder: row.order ?? true,
        combinesWithShipping: row.shipping ?? true,
        stopLowerPriority: row.stop ?? false,
        hasOrderReward: withOrderReward.has(row.id),
      })),
      slots,
    );
  } catch {
    return null;
  }
}

/** Shop-level "Shopify limits" numbers for Diagnostics and the offers-list banner. Never throws. */
export async function loadLimitsMeter(db: Db, shopId: string): Promise<LimitsMeter | null> {
  try {
    const [budget, shardsEnabled, domainsEnabled, combinationGroups, [slots], [shop]] = await Promise.all([
      loadAutomaticBudget(db, shopId),
      isFunctionShardsEnabled(db, shopId),
      isShardDomainsEnabled(db, shopId),
      loadCombinationGroups(db, shopId),
      db.select({ n: count() }).from(discountShards).where(and(eq(discountShards.shopId, shopId), eq(discountShards.kind, "cart"))),
      db.select({ domain: shops.myshopifyDomain }).from(shops).where(eq(shops.id, shopId)).limit(1),
    ]);
    if (!budget) return null;
    const storeActive = budget.storeActive ?? (budget.others !== null ? budget.others + budget.ours : null);
    return {
      limit: SHOPIFY_AUTOMATIC_LIMIT,
      storeActive,
      ours: budget.ours,
      others: budget.others,
      slotsInUse: Math.max(1, slots?.n ?? 0),
      maxCartSlots: budget.maxCartSlots,
      shardsEnabled,
      domainsEnabled,
      combinationGroups,
      level: limitsLevel(storeActive),
      ...(shop ? { discountsUrl: `https://${shop.domain}/admin/discounts` } : {}),
    };
  } catch {
    return null;
  }
}

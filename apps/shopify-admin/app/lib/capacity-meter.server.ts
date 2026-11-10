import { discountShards, shops, type Db } from "@promo/db";
import { and, count, eq } from "drizzle-orm";
import { SHOPIFY_AUTOMATIC_LIMIT } from "./capacity-copy.js";
import { limitsLevel, type LimitsMeter } from "./capacity-meter.js";
import { loadAutomaticBudget } from "./capacity-preflight.server.js";
import { isFunctionShardsEnabled } from "./function-shards-flag.server.js";

/** Shop-level "Shopify limits" numbers for Diagnostics and the offers-list banner. Never throws. */
export async function loadLimitsMeter(db: Db, shopId: string): Promise<LimitsMeter | null> {
  try {
    const [budget, shardsEnabled, [slots], [shop]] = await Promise.all([
      loadAutomaticBudget(db, shopId),
      isFunctionShardsEnabled(db, shopId),
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
      level: limitsLevel(storeActive),
      ...(shop ? { discountsUrl: `https://${shop.domain}/admin/discounts` } : {}),
    };
  } catch {
    return null;
  }
}

import { offerRewards, variantCache } from "@promo/db";
import { and, count, eq, inArray } from "drizzle-orm";
import type { GiftRewardPlan } from "./gift-rewards.js";
import type { getShopContext } from "./shop-context.server.js";

type ShopDb = Awaited<ReturnType<typeof getShopContext>>["db"];

export async function loadProductOf(db: ShopDb, shopId: string, variantGids: string[]): Promise<Map<string, string>> {
  if (variantGids.length === 0) return new Map();
  const rows = await db
    .select({ variantGid: variantCache.variantGid, productGid: variantCache.productGid })
    .from(variantCache)
    .where(and(eq(variantCache.shopId, shopId), inArray(variantCache.variantGid, variantGids)));
  return new Map(rows.map((row) => [row.variantGid, row.productGid]));
}

/** Product id -> how many variants it has, for the products of these variants. */
export async function loadVariantCountOf(db: ShopDb, shopId: string, productOf: ReadonlyMap<string, string>): Promise<Map<string, number>> {
  const products = [...new Set(productOf.values())];
  if (products.length === 0) return new Map();
  const rows = await db
    .select({ productGid: variantCache.productGid, n: count() })
    .from(variantCache)
    .where(and(eq(variantCache.shopId, shopId), inArray(variantCache.productGid, products)))
    .groupBy(variantCache.productGid);
  return new Map(rows.map((row) => [row.productGid, row.n]));
}

type Tx = Parameters<Parameters<ShopDb["transaction"]>[0]>[0];

export async function applyGiftRewardPlan(tx: Tx, shopId: string, offerId: string, plan: GiftRewardPlan) {
  const scope = (id: string) =>
    and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId), eq(offerRewards.id, id));
  if (plan.deleteIds.length > 0) {
    await tx
      .delete(offerRewards)
      .where(
        and(
          eq(offerRewards.shopId, shopId),
          eq(offerRewards.offerId, offerId),
          inArray(offerRewards.id, plan.deleteIds),
        ),
      );
  }
  for (const { id, values } of plan.update) await tx.update(offerRewards).set(values).where(scope(id));
  if (plan.insert.length > 0) {
    await tx.insert(offerRewards).values(
      plan.insert.map((values) => ({ shopId, offerId, rewardType: "product_gift" as const, ...values })),
    );
  }
}

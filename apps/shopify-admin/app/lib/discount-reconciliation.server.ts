import { getDb, offers, shops } from "@promo/db";
import { and, eq, isNull } from "drizzle-orm";
import { publishOffersForShop } from "./sync/offer-publisher.server.js";

export interface DiscountReconciliationTarget {
  shopId: string;
  shopDomain: string;
}

export interface DiscountReconciliationResult {
  attempted: number;
  succeeded: number;
  failures: Array<{ shopId: string; error: string }>;
}

export async function executeDiscountNodeReconciliation(
  targets: DiscountReconciliationTarget[],
  publishShop: (shopId: string, shopDomain: string) => Promise<void>,
): Promise<DiscountReconciliationResult> {
  const uniqueTargets = [...new Map(targets.map((target) => [target.shopId, target])).values()];
  const failures: DiscountReconciliationResult["failures"] = [];
  let succeeded = 0;

  // Sequential publication avoids a burst of Admin API mutations and keeps
  // each store's two discount nodes synchronized before moving to the next.
  for (const target of uniqueTargets) {
    try {
      await publishShop(target.shopId, target.shopDomain);
      succeeded += 1;
    } catch (error) {
      failures.push({
        shopId: target.shopId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { attempted: uniqueTargets.length, succeeded, failures };
}

export async function reconcileActiveShopDiscountNodes(): Promise<DiscountReconciliationResult> {
  const targets = await getDb()
    .select({ shopId: shops.id, shopDomain: shops.myshopifyDomain })
    .from(shops)
    .innerJoin(offers, and(eq(offers.shopId, shops.id), eq(offers.status, "active")))
    .where(and(eq(shops.isActive, true), isNull(shops.deliveryDiscountId)));

  return executeDiscountNodeReconciliation(targets, publishOffersForShop);
}

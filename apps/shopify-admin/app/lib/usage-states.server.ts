import { offerCustomerUsages, type Db } from "@promo/db";
import { and, count, eq, inArray } from "drizzle-orm";

/** Paid orders per offer for this customer, from the durable table the orders/paid webhook writes. */
export async function getUsageStates(
  shopId: string,
  db: Db,
  customerGid: string | null,
  offerIds: string[],
): Promise<Array<{ offerId: string; usedCount: number }>> {
  if (!customerGid || offerIds.length === 0) return [];
  return db
    .select({ offerId: offerCustomerUsages.offerId, usedCount: count() })
    .from(offerCustomerUsages)
    .where(and(
      eq(offerCustomerUsages.shopId, shopId),
      eq(offerCustomerUsages.customerGid, customerGid),
      inArray(offerCustomerUsages.offerId, offerIds),
    ))
    .groupBy(offerCustomerUsages.offerId);
}
